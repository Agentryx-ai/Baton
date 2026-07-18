/**
 * Smart-rotation policy engine — `reset-imminent-first`.
 *
 * Runs as a 60s-tick daemon inside the BFF. It does NOT proxy traffic. Enabling
 * first establishes CLIProxy fill-first, then the engine observes quota ordering
 * without shrinking the active credential pool. CLIProxy owns request-time 429
 * cooling and failover. See docs/DESIGN.md §5.
 *
 * The engine computes reset-imminent ordering for observability, but the
 * installed CLIProxy contract cannot apply that ordering. Actual request choice
 * remains fill-first over every non-manually-paused credential.
 */

import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'

import {
  getAccounts,
  getQuota,
  resumeAccount,
  setFillFirstRouting,
} from './gateway-client.ts'
import type { GatewayAccount, AccountQuota } from './gateway-client.ts'

import type { PolicyState, PolicyProviderState, SteerLogEntry, PolicyId } from './policy-types.ts'
import { POLICY_ID } from './policy-types.ts'

// ---- constants -------------------------------------------------------------

/** Providers the engine steers, in evaluation order (§5.2 runs per provider). */
const PROVIDERS = ['claude', 'codex'] as const

const TICK_SECONDS = 60
const TICK_MS = TICK_SECONDS * 1000

/** Ring buffer capacity for the steering log (§5.4). */
const LOG_CAP = 50

/** Path to the persisted ledger, next to this module. */
const STATE_PATH = fileURLToPath(new URL('./.baton-state.json', import.meta.url))

// ---- classification --------------------------------------------------------

type Klass = 'ACTIVE' | 'FRESH' | 'BLIND'

interface Classified {
  account: GatewayAccount
  klass: Klass
  /** ms-epoch of the soonest live-window reset (Infinity when unknown) — ACTIVE sort key. */
  resetMs: number
}

/**
 * Is this window a PRIMARY (blocking) limit?
 *
 * Providers expose different shapes:
 *  - Claude: `rateLimitType` = 'five_hour' | 'seven_day' (both primary, no `category`).
 *  - Codex:  `category` = 'usage' (primary 5h/weekly) | 'additional' (a feature
 *            sub-quota like "Codex-Spark" that does NOT block general use).
 * Rule: a window is primary unless it is explicitly an 'additional' sub-quota.
 * "Blocking" identifies the quota kind, not permission to remove the credential.
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
 * - ACTIVE — otherwise; ranked by the SOONEST reset among its primary windows
 *   (the perishable-quota signal behind "reset-imminent-first").
 *
 * Usage percentages are telemetry, not routing authority. Even 100% remains
 * rankable until CLIProxy observes a real request failure and applies its native
 * cooling/failover behavior.
 */
function classify(q: AccountQuota, account: GatewayAccount): Classified {
  if (!q.success) {
    return { account, klass: 'BLIND', resetMs: Infinity }
  }
  const blocking = q.windows.filter(isBlockingWindow)
  if (blocking.length === 0) {
    // No primary anchor on a successful fetch = FRESH (unused account; §5.2).
    return { account, klass: 'FRESH', resetMs: Infinity }
  }
  const resets = blocking
    .map((w) => (w.resetAt ? Date.parse(w.resetAt) : NaN))
    .filter((n) => !Number.isNaN(n))
  const resetMs = resets.length ? Math.min(...resets) : Infinity
  return { account, klass: 'ACTIVE', resetMs }
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
  /** Crash-recovery journal: OFF is not settled until every owned pause is released. */
  recoveryPending?: boolean
}

export interface PolicyEngineDependencies {
  getAccounts: typeof getAccounts
  getQuota: typeof getQuota
  resumeAccount: typeof resumeAccount
  ensureFillFirstRouting: typeof setFillFirstRouting
}

const DEFAULT_DEPENDENCIES: PolicyEngineDependencies = {
  getAccounts,
  getQuota,
  resumeAccount,
  ensureFillFirstRouting: setFillFirstRouting,
}

export interface PolicyEngineOptions {
  /** null disables persistence; intended for isolated unit tests. */
  statePath?: string | null
  tickMs?: number
}

// ---- engine ----------------------------------------------------------------

export class PolicyEngine {
  private enabled = false
  private desiredEnabled = false
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
  /** Serializes user/startup transitions so the last requested state wins. */
  private transition: Promise<void> = Promise.resolve()
  /** Invalidates asynchronous tick results that predate a newer user transition. */
  private transitionEpoch = 0
  private recoveryPending = false

  private readonly statePath: string | null
  private readonly tickMs: number
  private readonly dependencies: PolicyEngineDependencies

  constructor(
    dependencies: PolicyEngineDependencies = DEFAULT_DEPENDENCIES,
    options: PolicyEngineOptions = {},
  ) {
    this.dependencies = dependencies
    this.statePath = options.statePath === undefined ? STATE_PATH : options.statePath
    this.tickMs = options.tickMs ?? TICK_MS
    for (const p of PROVIDERS) this.ledger.set(p, new Set())
    this.restore()
    this.desiredEnabled = this.enabled
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
    this.desiredEnabled = b
    this.transitionEpoch += 1
    const operation = this.transition.then(() => this.applyEnabled(b))
    this.transition = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async applyEnabled(b: boolean): Promise<PolicyState> {
    if (b !== this.desiredEnabled) return this.getState()
    if (b === this.enabled) {
      if (!b && this.recoveryPending) await this.releaseAll()
      if (b) {
        try {
          await this.dependencies.ensureFillFirstRouting()
        } catch (err) {
          this.enabled = false
          this.stop()
          this.recoveryPending = this.hasEnginePausedAccounts()
          this.persist()
          this.pushLog('claude', 'error', `fill-first routing prerequisite failed: ${errMsg(err)}`)
          await this.releaseAll()
          throw err
        }
        if (b !== this.desiredEnabled) return this.getState()
        await this.runTickSafe(true)
      }
      return this.getState()
    }
    if (b) {
      // Request-path routing remains CLIProxy's authority. Do not claim the
      // policy is enabled or start its timer until fill-first is acknowledged.
      try {
        await this.dependencies.ensureFillFirstRouting()
      } catch (err) {
        this.enabled = false
        this.stop()
        this.recoveryPending = this.hasEnginePausedAccounts()
        this.persist()
        this.pushLog('claude', 'error', `fill-first routing prerequisite failed: ${errMsg(err)}`)
        await this.releaseAll()
        throw err
      }
      if (b !== this.desiredEnabled) return this.getState()
      this.enabled = true
      this.persist()
      this.pushLog('claude', 'info', '엔진 ON — 즉시 틱 수행')
      this.startTimer()
      await this.runTickSafe(true)
    } else {
      this.enabled = false
      this.stop()
      this.recoveryPending = this.hasEnginePausedAccounts()
      this.persist()
      // Fail-safe restore: resume everything the engine paused, then stop (§5.3).
      this.pushLog('claude', 'info', '엔진 OFF — 엔진이 pause한 계정 전부 resume 후 정지')
      await this.releaseAll()
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
    // re-establish fill-first before ticking (§5.3 BFF-restart case). A failed
    // prerequisite leaves the engine disabled (fail-closed).
    if (!this.enabled && this.recoveryPending) {
      const recovery = this.transition.then(async () => {
        if (!this.enabled && this.recoveryPending) await this.releaseAll()
      })
      this.transition = recovery.then(() => undefined, () => undefined)
      void recovery
      return
    }
    if (this.enabled && !this.timer) {
      this.enabled = false
      this.recoveryPending = this.hasEnginePausedAccounts()
      this.persist()
      void this.setEnabled(true).catch(() => {
        // setEnabled records the actionable contract error and persists OFF.
      })
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
    this.timer = setInterval(() => void this.runTickSafe(), this.tickMs)
  }

  /** Wraps a full tick: never throws, records lastTickAt, guards re-entry. */
  private async runTickSafe(routingVerified = false): Promise<void> {
    if (!this.enabled || this.ticking) return
    const epoch = this.transitionEpoch
    this.ticking = true
    try {
      if (!routingVerified) {
        try {
          await this.dependencies.ensureFillFirstRouting()
        } catch (err) {
          if (epoch !== this.transitionEpoch) return
          await this.disableAfterRoutingLoss(err, epoch)
          return
        }
        if (epoch !== this.transitionEpoch || !this.enabled || !this.desiredEnabled) return
        const evaluation = this.transition.then(() => this.evaluateProviders(epoch))
        this.transition = evaluation.then(() => undefined, () => undefined)
        await evaluation
      } else {
        await this.evaluateProviders(epoch)
      }
    } finally {
      this.ticking = false
    }
  }

  private async evaluateProviders(epoch: number): Promise<void> {
    for (const provider of PROVIDERS) {
      if (!this.isCurrentEpoch(epoch)) return
      try {
        await this.tickProvider(provider, epoch)
      } catch (err) {
        if (!this.isCurrentEpoch(epoch)) return
        // Gateway/CLIProxy down or unexpected error: log, change nothing, retry
        // next tick (§5.3 gateway-down case).
        this.pushLog(provider, 'error', `틱 실패 — 정책 변경 없음: ${errMsg(err)}`)
      }
    }
    if (this.isCurrentEpoch(epoch)) this.lastTickAt = Date.now()
  }

  private async tickProvider(provider: string, epoch: number): Promise<void> {
    // 1. accounts (a failure here bubbles to runTickSafe → whole-provider skip).
    const accounts = await this.dependencies.getAccounts(provider)
    if (!this.isCurrentEpoch(epoch)) return

    const led = this.ledger.get(provider) ?? new Set<string>()
    // Prune ledger ids for accounts that no longer exist (deleted between ticks),
    // so we don't loop forever trying to resume a ghost id (§5.3 robustness).
    const liveIds = new Set(accounts.map((a) => a.id))
    for (const id of [...led]) if (!liveIds.has(id)) led.delete(id)

    // 2. quotas in parallel; a per-account fetch failure → BLIND this tick.
    const classified = await Promise.all(
      accounts.map(async (account): Promise<Classified> => {
        try {
          const quota = await this.dependencies.getQuota(provider, account.id)
          return classify(quota, account)
        } catch {
          return { account, klass: 'BLIND', resetMs: Infinity }
        }
      }),
    )
    if (!this.isCurrentEpoch(epoch)) return

    // 3. rank: ACTIVE by resetAt asc (soonest first) → FRESH → BLIND.
    //    Exclude USER-paused accounts — a manually-paused account must never be
    //    picked as target/reserve (it would be a false status). Engine-paused accounts
    //    (in the ledger) stay rankable so the reset-cascade can resume them.
    const rankable = classified.filter((c) => !c.account.paused || led.has(c.account.id))
    const active = rankable
      .filter((c) => c.klass === 'ACTIVE')
      .sort((a, b) => a.resetMs - b.resetMs)
    const fresh = rankable.filter((c) => c.klass === 'FRESH')
    const blind = rankable.filter((c) => c.klass === 'BLIND')
    const rank = [...active, ...fresh, ...blind]

    // Edge: no usable account → release steering. A single usable account is
    // still a valid informational first choice.
    const selection = selectTargetAndReserve(rank.map((item) => item.account))
    if (!selection.target) {
      const released = await this.releaseProvider(
        provider,
        accounts,
        '순위 가능 계정 0개 — 조향 해제',
        epoch,
      )
      if (!released || !this.isCurrentEpoch(epoch)) return
      // Publish whatever the engine still has paused (releaseProvider drops ids it
      // successfully resumed; ids it failed to resume remain engine-paused).
      this.setProviderState(provider, null, null, [...led])
      this.lastPlanKey.set(provider, 'RELEASE')
      this.lastTarget.delete(provider)
      this.persist()
      return
    }

    // 4. Rank for observability only. The entire non-manually-paused set remains
    // available to CLIProxy's fill-first + native 429 failover.
    const target = selection.target
    const reserve = selection.reserve
    const poolIds = rank.map((item) => item.account.id).sort()
    const planKey = JSON.stringify({ t: target.id, r: reserve?.id ?? null, pool: poolIds })

    // Quota fetch failure only changes the informational ordering to BLIND. It
    // must never delay restoration of a credential or mutate the active pool.
    // 5. Restore legacy engine-owned pauses, but never create new pauses.
    const applied = await this.applyPlan(provider, accounts, target, reserve, epoch)
    if (!applied || !this.isCurrentEpoch(epoch)) return
    this.lastPlanKey.set(provider, planKey)
    this.recoveryPending = this.hasEnginePausedAccounts()
    this.setProviderState(provider, target.id, reserve?.id ?? null, [...led])
    this.persist()
  }

  private async applyPlan(
    provider: string,
    accounts: GatewayAccount[],
    target: GatewayAccount,
    reserve: GatewayAccount | null,
    epoch: number,
  ): Promise<boolean> {
    const led = this.ledger.get(provider) ?? new Set<string>()

    // Release every legacy engine-owned pause so a third or later valid account
    // remains available for native failover. A manual pause is never in this
    // ledger because the engine never records an already-paused credential.
    for (const acc of accounts) {
      if (!this.isCurrentEpoch(epoch)) return false
      if (!led.has(acc.id)) continue // User-owned pause: absolute no-op.
      if (acc.paused) {
        await this.dependencies.resumeAccount(provider, acc.id)
        led.delete(acc.id)
        if (!this.isCurrentEpoch(epoch)) return false
        this.pushLog(provider, 'resume', `엔진 pause 복구: ${label(acc)}`, acc.id)
      } else {
        led.delete(acc.id)
      }
    }

    if (!this.isCurrentEpoch(epoch)) return false
    // This rank is observability only. Request choice, 429 cooling, and failover
    // remain CLIProxy authority under fill-first.
    if (this.lastTarget.get(provider) !== target.id) {
      this.lastTarget.set(provider, target.id)
      const reserveNote = reserve ? '' : ' · 예비 없음'
      this.pushLog(provider, 'target', `정책 1순위: ${label(target)} — 리셋 임박 관측 순위${reserveNote}`, target.id)
    }
    return true
  }

  // -- release paths --------------------------------------------------------

  /** Resume every engine-paused account for one provider; clear that ledger. */
  private async releaseProvider(
    provider: string,
    accounts: GatewayAccount[],
    reason: string,
    epoch: number,
  ): Promise<boolean> {
    const led = this.ledger.get(provider)
    if (!led || led.size === 0) return this.isCurrentEpoch(epoch)
    const byId = new Map(accounts.map((a) => [a.id, a]))
    for (const id of [...led]) {
      if (!this.isCurrentEpoch(epoch)) return false
      try {
        // Only bother resuming if it is still paused; either way drop from ledger.
        const acc = byId.get(id)
        if (!acc || acc.paused) await this.dependencies.resumeAccount(provider, id)
        led.delete(id)
        if (!this.isCurrentEpoch(epoch)) return false
        this.pushLog(provider, 'resume', `조향 해제 — 엔진 pause 복구: ${acc ? label(acc) : id}`, id)
      } catch (err) {
        if (!this.isCurrentEpoch(epoch)) return false
        this.pushLog(provider, 'error', `resume 실패(${id}): ${errMsg(err)} — 다음 틱 재시도`, id)
      }
    }
    if (!this.isCurrentEpoch(epoch)) return false
    this.pushLog(provider, 'info', reason)
    this.persist()
    return true
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
        accounts = await this.dependencies.getAccounts(provider)
      } catch {
        // Best effort: resume by id even without the account list.
      }
      const byId = new Map(accounts.map((a) => [a.id, a]))
      for (const id of [...led]) {
        try {
          await this.dependencies.resumeAccount(provider, id)
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
    this.recoveryPending = this.hasEnginePausedAccounts()
    this.persist()
  }

  private async disableAfterRoutingLoss(error: unknown, expectedEpoch: number): Promise<void> {
    if (expectedEpoch !== this.transitionEpoch) return
    this.enabled = false
    this.desiredEnabled = false
    this.transitionEpoch += 1
    this.stop()
    this.recoveryPending = this.hasEnginePausedAccounts()
    this.persist()
    this.pushLog('claude', 'error', `fill-first routing prerequisite lost: ${errMsg(error)}`)
    const recovery = this.transition.then(() => this.releaseAll())
    this.transition = recovery.then(() => undefined, () => undefined)
    await recovery
  }

  private hasEnginePausedAccounts(): boolean {
    return [...this.ledger.values()].some((ids) => ids.size > 0)
  }

  private isCurrentEpoch(epoch: number): boolean {
    return epoch === this.transitionEpoch && this.enabled && this.desiredEnabled
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
    if (!this.statePath) return
    const enginePaused: Record<string, string[]> = {}
    for (const [provider, set] of this.ledger) enginePaused[provider] = [...set]
    const data: PersistedState = {
      enabled: this.enabled,
      enginePaused,
      recoveryPending: this.recoveryPending,
    }
    try {
      writeFileSync(this.statePath, JSON.stringify(data, null, 2), 'utf8')
    } catch (err) {
      this.pushLog('claude', 'error', `상태 저장 실패: ${errMsg(err)}`)
    }
  }

  private restore(): void {
    if (!this.statePath) return
    let raw: string
    try {
      raw = readFileSync(this.statePath, 'utf8')
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
      this.recoveryPending = data.recoveryPending === true
        || (!this.enabled && this.hasEnginePausedAccounts())
    } catch (err) {
      this.pushLog('claude', 'error', `상태 복원 실패(무시하고 초기화): ${errMsg(err)}`)
    }
  }
}

export const policyEngine = new PolicyEngine()
