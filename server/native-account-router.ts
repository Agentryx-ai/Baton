export type NativeRouteFailureKind =
  | 'model_quota'
  | 'account_quota'
  | 'authentication'
  | 'upstream_5xx'
  | 'transient'
  | 'fatal'

export interface NativeRouteAccount {
  id: string
  priority: number
  enabled: boolean
}

export interface NativeRouteFailure {
  kind: NativeRouteFailureKind
  retryable: boolean
  cooldownUntil?: number
}

export interface NativeRouteAttempt<T> {
  value: T
  failure?: NativeRouteFailure
}

export interface NativeRouteAttemptRecord {
  accountId: string
  failure?: NativeRouteFailure
}

export interface NativeRouteResult<T> {
  value: T
  accountId: string
  attempts: NativeRouteAttemptRecord[]
  exhausted: boolean
}

export interface RouteNativeRequestOptions<T> {
  accounts: readonly NativeRouteAccount[]
  model: string
  supportsModel: (account: NativeRouteAccount, model: string) => boolean
  attempt: (account: NativeRouteAccount, signal: AbortSignal) => Promise<NativeRouteAttempt<T>>
  cooldowns?: NativeAccountCooldowns
  now?: () => number
  deadlineMs?: number
  maxAttempts?: number
  signal?: AbortSignal
  disposeValue?: (value: T) => void | Promise<void>
}

interface CooldownEntry {
  accountId: string
  model?: string
  until: number
}

const FAILURE_SPECIFICITY: Record<NativeRouteFailureKind, number> = {
  model_quota: 6,
  account_quota: 5,
  authentication: 4,
  upstream_5xx: 3,
  transient: 2,
  fatal: 1,
}

export class NativeRouteUnavailableError extends Error {
  readonly code: 'no_accounts' | 'model_unsupported' | 'deadline_exceeded' | 'cancelled'

  constructor(code: NativeRouteUnavailableError['code'], message: string) {
    super(message)
    this.name = 'NativeRouteUnavailableError'
    this.code = code
  }
}

export class NativeAccountCooldowns {
  private readonly entries = new Map<string, CooldownEntry>()

  mark(accountId: string, until: number, model?: string): void {
    if (!Number.isFinite(until)) return
    const key = this.key(accountId, model)
    const current = this.entries.get(key)
    if (!current || current.until < until) this.entries.set(key, { accountId, model, until })
  }

  isCooling(accountId: string, model: string, now: number): boolean {
    this.prune(now)
    return this.entries.has(this.key(accountId)) || this.entries.has(this.key(accountId, model))
  }

  clear(accountId: string, model?: string): void {
    this.entries.delete(this.key(accountId, model))
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.until <= now) this.entries.delete(key)
    }
  }

  private key(accountId: string, model?: string): string {
    return `${accountId}\u0000${model ?? '*'}`
  }
}

function compareAccounts(left: NativeRouteAccount, right: NativeRouteAccount): number {
  return left.priority - right.priority || left.id.localeCompare(right.id)
}

function linkedAbortSignal(signal: AbortSignal | undefined, deadlineMs: number): {
  signal: AbortSignal
  dispose: () => void
  deadline: AbortSignal
} {
  const deadline = AbortSignal.timeout(deadlineMs)
  if (!signal) return { signal: deadline, deadline, dispose: () => undefined }
  const linked = new AbortController()
  const abortFromCaller = () => linked.abort(signal.reason)
  const abortFromDeadline = () => linked.abort(deadline.reason)
  if (signal.aborted) abortFromCaller()
  else signal.addEventListener('abort', abortFromCaller, { once: true })
  deadline.addEventListener('abort', abortFromDeadline, { once: true })
  return {
    signal: linked.signal,
    deadline,
    dispose: () => {
      signal.removeEventListener('abort', abortFromCaller)
      deadline.removeEventListener('abort', abortFromDeadline)
    },
  }
}

export async function routeNativeRequest<T>(
  options: RouteNativeRequestOptions<T>,
): Promise<NativeRouteResult<T>> {
  const now = options.now ?? Date.now
  const deadlineMs = options.deadlineMs ?? 30_000
  const maxAttempts = options.maxAttempts ?? options.accounts.length
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new NativeRouteUnavailableError('deadline_exceeded', 'Native request retry budget이 올바르지 않습니다.')
  }
  const enabled = options.accounts.filter((account) => account.enabled).sort(compareAccounts)
  if (enabled.length === 0) {
    throw new NativeRouteUnavailableError('no_accounts', '활성화된 native account가 없습니다.')
  }
  const supporting = enabled.filter((account) => options.supportsModel(account, options.model))
  if (supporting.length === 0) {
    throw new NativeRouteUnavailableError(
      'model_unsupported',
      `요청 모델 ${options.model}을 지원하는 native account가 없습니다.`,
    )
  }
  const candidates = supporting.filter((account) => (
    !options.cooldowns?.isCooling(account.id, options.model, now())
  ))
  if (candidates.length === 0) {
    throw new NativeRouteUnavailableError(
      'no_accounts',
      `요청 모델 ${options.model}의 모든 native account가 cooldown 상태입니다.`,
    )
  }

  const linked = linkedAbortSignal(options.signal, deadlineMs)
  const attempts: NativeRouteAttemptRecord[] = []
  let selected: { attempt: NativeRouteAttempt<T>; account: NativeRouteAccount } | undefined
  const dispose = async (value: T): Promise<void> => {
    try {
      await options.disposeValue?.(value)
    } catch {
      // Discard cleanup must never replace the request's authoritative result.
    }
  }
  try {
    for (const account of candidates.slice(0, maxAttempts)) {
      if (linked.signal.aborted) break
      const attempt = await options.attempt(account, linked.signal)
      attempts.push({ accountId: account.id, ...(attempt.failure ? { failure: attempt.failure } : {}) })
      if (!attempt.failure) {
        if (selected) await dispose(selected.attempt.value)
        return { value: attempt.value, accountId: account.id, attempts, exhausted: false }
      }
      if (!attempt.failure.retryable) {
        if (selected) await dispose(selected.attempt.value)
        return { value: attempt.value, accountId: account.id, attempts, exhausted: true }
      }
      if (
        !selected
        || FAILURE_SPECIFICITY[attempt.failure.kind] > FAILURE_SPECIFICITY[selected.attempt.failure!.kind]
      ) {
        if (selected) await dispose(selected.attempt.value)
        selected = { attempt, account }
      } else {
        await dispose(attempt.value)
      }
      if (attempt.failure.cooldownUntil !== undefined) {
        options.cooldowns?.mark(
          account.id,
          attempt.failure.cooldownUntil,
          attempt.failure.kind === 'model_quota' ? options.model : undefined,
        )
      }
    }
  } catch (error) {
    if (!linked.signal.aborted) {
      if (selected) await dispose(selected.attempt.value)
      throw error
    }
  } finally {
    linked.dispose()
  }

  if (linked.signal.aborted) {
    if (selected) await dispose(selected.attempt.value)
    if (options.signal?.aborted) {
      throw new NativeRouteUnavailableError('cancelled', 'Native request가 취소되었습니다.')
    }
    throw new NativeRouteUnavailableError('deadline_exceeded', 'Native request 전체 deadline을 초과했습니다.')
  }
  if (!selected) {
    throw new NativeRouteUnavailableError('no_accounts', '시도할 수 있는 native account가 없습니다.')
  }
  return {
    value: selected.attempt.value,
    accountId: selected.account.id,
    attempts,
    exhausted: true,
  }
}
