/**
 * Smart-rotation policy engine — `reset-imminent-first`.
 *
 * Runs as a 60s-tick daemon inside the BFF. It does NOT proxy traffic; it steers
 * which CLIProxy accounts are active by calling the gateway's pause / resume APIs
 * each tick (there is no "default" routing lever — CLIProxy round-robins all
 * non-paused credentials). See docs/DESIGN.md §5 (algorithm §5.2, edge cases §5.3).
 *
 * Core idea (§5.1): a soon-to-reset account's remaining quota is a perishable
 * resource — burn it first, preserve everyone else. After it resets its next
 * reset is furthest away, so the target naturally cascades to the next-imminent
 * account.
 */

import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'

import {
  getAccounts,
  getQuota,
  pauseAccount,
  resumeAccount,
} from './gateway-client.ts'
import type { GatewayAccount, AccountQuota } from './gateway-client.ts'

import type { PolicyState, PolicyProviderState, SteerLogEntry, PolicyId } from './policy-types.ts'
import { POLICY_ID } from './policy-types.ts'

// ---- constants -------------------------------------------------------------

/** Providers the engine steers, in evaluation order (§5.2 runs per provider). */
const PROVIDERS = ['claude', 'codex'] as const

const TICK_SECONDS = 60
const TICK_MS = TICK_SECONDS * 1000

/** usedPercent at/above which a blocking window (5h or weekly) counts as EXHAUSTED (§5.2, §10-Q1). */
const EXHAUSTED_AT = 95

/** Ring buffer capacity for the steering log (§5.4). */
const LOG_CAP = 50

/** Path to the persisted ledger, next to this module. */
const STATE_PATH = fileURLToPath(new URL('./.baton-state.json', import.meta.url))

// ---- classification --------------------------------------------------------

type Klass = 'ACTIVE' | 'FRESH' | 'EXHAUSTED' | 'BLIND'

interface Classified {
  account: GatewayAccount
  klass: Klass
  /** ms-epoch of the soonest live-window reset (Infinity when unknown) — ACTIVE sort key. */
  resetMs: number
  /** true when the quota fetch itself failed this tick (drives the flap debounce, §5.3). */
  fetchFailed: boolean
}

/**
 * Is this window a PRIMARY (blocking) limit?
 *
 * Providers expose different shapes:
 *  - Claude: `rateLimitType` = 'five_hour' | 'seven_day' (both primary, no `category`).
 *  - Codex:  `category` = 'usage' (primary 5h/weekly) | 'additional' (a feature
 *            sub-quota like "Codex-Spark" that does NOT block general use).
 * Rule: a window blocks unless it is explicitly an 'additional' sub-quota. This is
 * provider-agnostic — a maxed 5h OR weekly limit excludes the account either way.
 */
function isBlockingWindow(w: { category?: string }): boolean {
  return w.category !== 'additional'
}

/**
 * Classify one account by ALL of its primary (blocking) usage windows.
 *
 * - BLIND — the quota CALL failed (fetch threw or `success:false`).
 * - FRESH — successful fetch but no primary window anchor yet (an unused account:
 *   the window starts on first request, so it has no data — not "no plan").
 * - EXHAUSTED — ANY primary window (5h OR weekly, either provider) is at/above the
 *   threshold. A weekly-maxed account is blocked even if its 5h window looks free.
 * - ACTIVE — otherwise; ranked by the SOONEST reset among its primary windows
 *   (the perishable-quota signal behind "reset-imminent-first").
 */
function classify(q: AccountQuota, account: GatewayAccount): Classified {
  if (!q.success) {
    return { account, klass: 'BLIND', resetMs: Infinity, fetchFailed: true }
  }
  const blocking = q.windows.filter(isBlockingWindow)
  if (blocking.length === 0) {
    // No primary anchor on a successful fetch = FRESH (unused account; §5.2).
    return { account, klass: 'FRESH', resetMs: Infinity, fetchFailed: false }
  }
  if (blocking.some((w) => w.usedPercent >= EXHAUSTED_AT)) {
    return { account, klass: 'EXHAUSTED', resetMs: Infinity, fetchFailed: false }
  }
  const resets = blocking
    .map((w) => (w.resetAt ? Date.parse(w.resetAt) : NaN))
    .filter((n) => !Number.isNaN(n))
  const resetMs = resets.length ? Math.min(...resets) : Infinity
  return { account, klass: 'ACTIVE', resetMs, fetchFailed: false }
}

function label(a: GatewayAccount): string {
  return a.nickname || a.email || a.id
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Cardinality rule kept pure so the no-account/single-account cases stay explicit. */
export function selectTargetAndReserve(ranked: GatewayAccount[]): {
  target: GatewayAccount | null
  reserve: GatewayAccount | null
} {
  return { target: ranked[0] ?? null, reserve: ranked[1] ?? null }
}

// ---- persisted shape -------------------------------------------------------

interface PersistedState {
  enabled: boolean
  /** engine-pause ledger: provider -> account ids the ENGINE paused (§5.3). */
  enginePaused: Record<string, string[]>
}

// ---- engine ----------------------------------------------------------------

class PolicyEngine {
  private enabled = false
  private readonly policy: PolicyId = POLICY_ID
  private lastTickAt: number | null = null

  /** Ledger of accounts the engine paused, per provider. Never touch user pauses. */
  private readonly ledger = new Map<string, Set<string>>()

  /** Last computed plan key per provider — used for the 2-tick flap debounce. */
  private readonly lastPlanKey = new Map<string, string>()

  /** Last logged target id per provider — logs a 'target' entry only on change. */
  private readonly lastTarget = new Map<string, string>()

  /** Current steering decision surfaced to the SPA. */
  private readonly providerStates: PolicyProviderState[] = PROVIDERS.map((p) => ({
    provider: p,
    target: null,
    reserve: null,
    enginePaused: [],
  }))

  private readonly logBuffer: SteerLogEntry[] = []

  private timer: ReturnType<typeof setInterval> | null = null
  /** Guards against overlapping ticks if a tick outlives the interval. */
  private ticking = false

  constructor() {
    for (const p of PROVIDERS) this.ledger.set(p, new Set())
    this.restore()
    // Publish the restored engine-pause ledger immediately so the UI can label
    // engine-paused accounts correctly before the first (possibly failing) tick.
    for (const st of this.providerStates) {
      st.enginePaused = [...(this.ledger.get(st.provider) ?? [])]
    }
  }

  // -- public API -----------------------------------------------------------

  getState(): PolicyState {
    return {
      enabled: this.enabled,
      policy: this.policy,
      tickSeconds: TICK_SECONDS,
      providers: this.providerStates.map((p) => ({ ...p })),
      log: this.logBuffer.slice(),
      lastTickAt: this.lastTickAt,
    }
  }

  async setEnabled(b: boolean): Promise<PolicyState> {
    if (b === this.enabled) return this.getState()
    this.enabled = b
    this.persist()
    if (b) {
      this.pushLog('claude', 'info', '엔진 ON — 즉시 틱 수행')
      this.startTimer()
      await this.runTickSafe()
    } else {
      // Fail-safe restore: resume everything the engine paused, then stop (§5.3).
      this.pushLog('claude', 'info', '엔진 OFF — 엔진이 pause한 계정 전부 resume 후 정지')
      await this.releaseAll()
      this.stop()
    }
    return this.getState()
  }

  async setPolicy(id: PolicyId): Promise<PolicyState> {
    // v1 has a single policy; accept only the known id. Structure kept so a v2
    // ordering function can slot in (§5.5).
    if (id !== POLICY_ID) {
      this.pushLog('claude', 'error', `알 수 없는 정책 '${id}' 무시 — '${POLICY_ID}' 유지`)
      return this.getState()
    }
    if (this.enabled) await this.runTickSafe()
    return this.getState()
  }

  startIfEnabled(): void {
    // Called at BFF boot. Restore already loaded enabled + ledger; if enabled,
    // start ticking and tick once immediately (§5.3 BFF-restart case).
    if (this.enabled && !this.timer) {
      this.startTimer()
      void this.runTickSafe()
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // -- ticking --------------------------------------------------------------

  private startTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.runTickSafe(), TICK_MS)
  }

  /** Wraps a full tick: never throws, records lastTickAt, guards re-entry. */
  private async runTickSafe(): Promise<void> {
    if (!this.enabled || this.ticking) return
    this.ticking = true
    try {
      for (const provider of PROVIDERS) {
        try {
          await this.tickProvider(provider)
        } catch (err) {
          // Gateway/CLIProxy down or unexpected error: log, change nothing, retry
          // next tick (§5.3 gateway-down case).
          this.pushLog(provider, 'error', `틱 실패 — 조향 변경 없음: ${errMsg(err)}`)
        }
      }
      this.lastTickAt = Date.now()
    } finally {
      this.ticking = false
    }
  }

  private async tickProvider(provider: string): Promise<void> {
    // 1. accounts (a failure here bubbles to runTickSafe → whole-provider skip).
    const accounts = await getAccounts(provider)

    const led = this.ledger.get(provider) ?? new Set<string>()
    // Prune ledger ids for accounts that no longer exist (deleted between ticks),
    // so we don't loop forever trying to resume a ghost id (§5.3 robustness).
    const liveIds = new Set(accounts.map((a) => a.id))
    for (const id of [...led]) if (!liveIds.has(id)) led.delete(id)

    // 2. quotas in parallel; a per-account fetch failure → BLIND this tick.
    const classified = await Promise.all(
      accounts.map(async (account): Promise<Classified> => {
        try {
          const quota = await getQuota(provider, account.id)
          return classify(quota, account)
        } catch {
          return { account, klass: 'BLIND', resetMs: Infinity, fetchFailed: true }
        }
      }),
    )

    // 3. rank: ACTIVE by resetAt asc (soonest first) → FRESH → BLIND; drop EXHAUSTED.
    //    Exclude USER-paused accounts — a manually-paused account must never be
    //    picked as target/reserve (it wouldn't serve; that would be a false status
    //    and could leave a single active with no reserve). Engine-paused accounts
    //    (in the ledger) stay rankable so the reset-cascade can resume them.
    const rankable = classified.filter((c) => !c.account.paused || led.has(c.account.id))
    const active = rankable
      .filter((c) => c.klass === 'ACTIVE')
      .sort((a, b) => a.resetMs - b.resetMs)
    const fresh = rankable.filter((c) => c.klass === 'FRESH')
    const blind = rankable.filter((c) => c.klass === 'BLIND')
    const rank = [...active, ...fresh, ...blind]

    const transientFailure = classified.some((c) => c.fetchFailed)

    // Edge: no usable account → release steering. A single usable account is
    // still a valid target: keeping exhausted siblings active only creates
    // avoidable 429s and is not a real reserve.
    const selection = selectTargetAndReserve(rank.map((item) => item.account))
    if (!selection.target) {
      await this.releaseProvider(
        provider,
        accounts,
        '순위 가능 계정 0개 — 조향 해제',
      )
      // Publish whatever the engine still has paused (releaseProvider drops ids it
      // successfully resumed; ids it failed to resume remain engine-paused).
      this.setProviderState(provider, null, null, [...led])
      this.lastPlanKey.set(provider, 'RELEASE')
      this.lastTarget.delete(provider)
      return
    }

    // 4. target = rank[0], optional reserve = rank[1], everyone else → pause.
    const target = selection.target
    const reserve = selection.reserve
    const keep = new Set<string>([target.id, ...(reserve ? [reserve.id] : [])])
    const pausedIds = accounts
      .filter((a) => !keep.has(a.id))
      .map((a) => a.id)
      .sort()
    const planKey = JSON.stringify({ t: target.id, r: reserve?.id ?? null, p: pausedIds })

    // Edge: flap debounce. When any quota fetch failed this tick, only apply a
    // steering CHANGE if the exact same plan held last tick (2 consecutive
    // identical decisions). With clean data we apply immediately (§5.3).
    if (transientFailure && this.lastPlanKey.get(provider) !== planKey) {
      this.lastPlanKey.set(provider, planKey)
      this.pushLog(
        provider,
        'info',
        `일시적 쿼터 조회 실패 감지 — 플래핑 방지로 조향 변경 보류(다음 틱 동일 판단 시 적용). 잠정 타깃 ${label(target)}`,
      )
      return
    }
    this.lastPlanKey.set(provider, planKey)

    // 5. apply idempotently: only call APIs where current ≠ desired.
    const klassOf = new Map(classified.map((c) => [c.account.id, c.klass]))
    await this.applyPlan(provider, accounts, target, reserve, keep, klassOf)
    this.setProviderState(provider, target.id, reserve?.id ?? null, [...led])
    this.persist()
  }

  private async applyPlan(
    provider: string,
    accounts: GatewayAccount[],
    target: GatewayAccount,
    reserve: GatewayAccount | null,
    keep: Set<string>,
    klassOf: Map<string, Klass>,
  ): Promise<void> {
    const led = this.ledger.get(provider) ?? new Set<string>()

    // Mark the target for observability. Steering is enacted purely by pausing
    // the others (below) — CLIProxy has no per-request "default" routing lever,
    // so we do NOT call the CCS default API (it would be a no-op for routing).
    // Log only on change to avoid spamming the ring buffer every tick.
    if (this.lastTarget.get(provider) !== target.id) {
      this.lastTarget.set(provider, target.id)
      const reserveNote = reserve ? '' : ' · 예비 없음'
      this.pushLog(provider, 'target', `타깃: ${label(target)} — 리셋 임박 우선 소진${reserveNote}`, target.id)
    }

    // target & reserve must stay active. Resume ONLY if the ENGINE paused it;
    // never override a user's manual pause (§5.3).
    for (const acc of [target, ...(reserve ? [reserve] : [])]) {
      if (!acc.paused) continue
      if (led.has(acc.id)) {
        await resumeAccount(provider, acc.id)
        led.delete(acc.id)
        const role = acc.id === target.id ? '타깃' : '예비'
        this.pushLog(provider, 'resume', `${role} 활성 복구: ${label(acc)}`, acc.id)
      } else {
        this.pushLog(
          provider,
          'info',
          `${label(acc)}는 사용자가 수동 pause함 — 엔진이 되돌리지 않음(사용자 의사 존중)`,
          acc.id,
        )
      }
    }

    // everyone else → pause (idempotent; record in ledger).
    for (const a of accounts) {
      if (keep.has(a.id)) continue
      if (a.paused) continue
      await pauseAccount(provider, a.id)
      led.add(a.id)
      const why =
        klassOf.get(a.id) === 'EXHAUSTED'
          ? '소진(≥95%)'
          : klassOf.get(a.id) === 'BLIND'
            ? '판단 불가(최후순위)'
            : '여유분 보존(타깃/예비 외)'
      this.pushLog(provider, 'pause', `일시정지: ${label(a)} — ${why}`, a.id)
    }
  }

  // -- release paths --------------------------------------------------------

  /** Resume every engine-paused account for one provider; clear that ledger. */
  private async releaseProvider(
    provider: string,
    accounts: GatewayAccount[],
    reason: string,
  ): Promise<void> {
    const led = this.ledger.get(provider)
    if (!led || led.size === 0) return
    this.pushLog(provider, 'info', reason)
    const byId = new Map(accounts.map((a) => [a.id, a]))
    for (const id of [...led]) {
      try {
        // Only bother resuming if it is still paused; either way drop from ledger.
        const acc = byId.get(id)
        if (!acc || acc.paused) await resumeAccount(provider, id)
        led.delete(id)
        this.pushLog(provider, 'resume', `조향 해제 — 엔진 pause 복구: ${acc ? label(acc) : id}`, id)
      } catch (err) {
        this.pushLog(provider, 'error', `resume 실패(${id}): ${errMsg(err)} — 다음 틱 재시도`, id)
      }
    }
    this.persist()
  }

  /** Fail-safe: resume all engine-paused accounts across every provider. */
  private async releaseAll(): Promise<void> {
    for (const provider of PROVIDERS) {
      const led = this.ledger.get(provider)
      if (!led || led.size === 0) {
        this.setProviderState(provider, null, null)
        continue
      }
      let accounts: GatewayAccount[] = []
      try {
        accounts = await getAccounts(provider)
      } catch {
        // Best effort: resume by id even without the account list.
      }
      const byId = new Map(accounts.map((a) => [a.id, a]))
      for (const id of [...led]) {
        try {
          await resumeAccount(provider, id)
          led.delete(id)
          this.pushLog(provider, 'resume', `엔진 OFF 복원: ${byId.get(id) ? label(byId.get(id)!) : id}`, id)
        } catch (err) {
          this.pushLog(provider, 'error', `OFF 복원 resume 실패(${id}): ${errMsg(err)}`, id)
        }
      }
      this.setProviderState(provider, null, null)
      this.lastPlanKey.delete(provider)
      this.lastTarget.delete(provider)
    }
    this.persist()
  }

  // -- helpers --------------------------------------------------------------

  private setProviderState(
    provider: string,
    target: string | null,
    reserve: string | null,
    enginePaused: string[] = [],
  ): void {
    const st = this.providerStates.find((p) => p.provider === provider)
    if (st) {
      st.target = target
      st.reserve = reserve
      st.enginePaused = enginePaused
    }
  }

  private pushLog(
    provider: string,
    action: SteerLogEntry['action'],
    reason: string,
    accountId?: string,
  ): void {
    this.logBuffer.push({ ts: Date.now(), provider, action, accountId, reason })
    if (this.logBuffer.length > LOG_CAP) this.logBuffer.splice(0, this.logBuffer.length - LOG_CAP)
  }

  // -- persistence ----------------------------------------------------------

  private persist(): void {
    const enginePaused: Record<string, string[]> = {}
    for (const [provider, set] of this.ledger) enginePaused[provider] = [...set]
    const data: PersistedState = { enabled: this.enabled, enginePaused }
    try {
      writeFileSync(STATE_PATH, JSON.stringify(data, null, 2), 'utf8')
    } catch (err) {
      this.pushLog('claude', 'error', `상태 저장 실패: ${errMsg(err)}`)
    }
  }

  private restore(): void {
    let raw: string
    try {
      raw = readFileSync(STATE_PATH, 'utf8')
    } catch {
      return // no state file yet — fresh start
    }
    try {
      const data = JSON.parse(raw) as Partial<PersistedState>
      this.enabled = data.enabled === true
      if (data.enginePaused && typeof data.enginePaused === 'object') {
        for (const provider of PROVIDERS) {
          const ids = data.enginePaused[provider]
          if (Array.isArray(ids)) this.ledger.set(provider, new Set(ids.filter((x) => typeof x === 'string')))
        }
      }
    } catch (err) {
      this.pushLog('claude', 'error', `상태 복원 실패(무시하고 초기화): ${errMsg(err)}`)
    }
  }
}

export const policyEngine = new PolicyEngine()
