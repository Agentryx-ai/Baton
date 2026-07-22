import type {
  CanonicalGoal,
  GoalSchedulerLease,
  TurnId,
} from './domain.ts'
import type {
  GoalCasResult,
  GoalTurnContext,
  RecordGoalTurnInput,
  SessionStore,
} from './store.ts'

export const GOAL_LEASE_DURATION_MS = 30_000
export const GOAL_LEASE_HEARTBEAT_MS = 10_000
export const GOAL_NO_PROGRESS_LIMIT = 3

export interface GoalContinuationRequest {
  goal: CanonicalGoal
  goalContext: GoalTurnContext
  clientRequestId: string
  signal: AbortSignal
}

/**
 * The launcher must durably begin the canonical turn with `goalContext` before it
 * returns `started`. Beginning the turn consumes the scheduler lease in the same
 * transaction. It should return immediately after that transaction and execute
 * the provider loop independently.
 */
export type GoalContinuationLauncher = (
  request: GoalContinuationRequest,
) => Promise<GoalLaunchResult> | GoalLaunchResult

export type GoalLaunchResult =
  | { status: 'started'; turnId: TurnId }
  | { status: 'not_started'; reason: 'busy' | 'stale' | 'lease_lost' | 'cancelled' }
  | {
      status: 'failed'
      category: 'provider_failure' | 'provider_usage_limit' | 'context_input_too_large'
      message?: string
    }

export type GoalScheduleResult =
  | { status: 'started'; goal: CanonicalGoal; turnId: TurnId }
  | { status: 'limited'; goal: CanonicalGoal | null }
  | { status: 'inactive'; goal: CanonicalGoal | null }
  | { status: 'busy'; goal: CanonicalGoal }
  | { status: 'lease_unavailable'; goal: CanonicalGoal }
  | { status: 'lease_lost'; goal: CanonicalGoal | null }
  | { status: 'stale'; goal: CanonicalGoal | null }
  | { status: 'stopped'; goal: CanonicalGoal }
  | { status: 'failed'; goal: CanonicalGoal | null }

export interface AutomaticGoalTurnResult {
  turnId: TurnId
  goalId: string
  goalRevision: number
  tokensUsed: number
  timeUsedSeconds: number
  progressDigest: string | null
}

export interface GoalRuntimeOptions {
  ownerId: string
  launchContinuation: GoalContinuationLauncher
  onGoalChanged?: (goal: CanonicalGoal) => void
  leaseDurationMs?: number
  heartbeatIntervalMs?: number
  scanIntervalMs?: number
  now?: () => Date
}

export type GoalRuntimeStore = Pick<
  SessionStore,
  | 'getGoal'
  | 'listActiveGoals'
  | 'claimGoalLease'
  | 'heartbeatGoalLease'
  | 'releaseGoalLease'
  | 'updateGoalStatus'
  | 'recordGoalTurn'
>

export function continuationClientRequestId(goal: CanonicalGoal): string {
  return `goal-continuation:${goal.id}:r${goal.revision}:a${goal.automaticTurnsUsed + 1}`
}

/**
 * Provider-neutral scheduler for Baton-owned Goals. Provider execution remains
 * behind `launchContinuation`; this class owns only durable eligibility, leases,
 * runaway limits, and status transitions.
 */
export class GoalRuntime {
  readonly #store: GoalRuntimeStore
  readonly #ownerId: string
  readonly #launchContinuation: GoalContinuationLauncher
  readonly #onGoalChanged: (goal: CanonicalGoal) => void
  readonly #leaseDurationMs: number
  readonly #heartbeatIntervalMs: number
  readonly #scanIntervalMs: number
  readonly #now: () => Date
  readonly #inFlightGoalIds = new Set<string>()
  readonly #pendingControllers = new Map<string, AbortController>()
  readonly #inFlightSettlements = new Map<string, Promise<void>>()
  #scanTimer: ReturnType<typeof setInterval> | null = null
  #stopped = true

  constructor(store: GoalRuntimeStore, options: GoalRuntimeOptions) {
    if (options.ownerId.trim().length === 0) throw new TypeError('Goal runtime ownerId must not be empty')
    this.#store = store
    this.#ownerId = options.ownerId
    this.#launchContinuation = options.launchContinuation
    this.#onGoalChanged = options.onGoalChanged ?? (() => {})
    this.#leaseDurationMs = options.leaseDurationMs ?? GOAL_LEASE_DURATION_MS
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? GOAL_LEASE_HEARTBEAT_MS
    this.#scanIntervalMs = options.scanIntervalMs ?? 1_000
    this.#now = options.now ?? (() => new Date())
    if (this.#leaseDurationMs <= 0 || this.#heartbeatIntervalMs <= 0 || this.#scanIntervalMs <= 0) {
      throw new RangeError('Goal runtime intervals must be positive')
    }
    if (this.#heartbeatIntervalMs >= this.#leaseDurationMs) {
      throw new RangeError('Goal heartbeat interval must be shorter than the lease duration')
    }
  }

  /** Starts the restart scan and periodic idle-Goal discovery. */
  async start(): Promise<GoalScheduleResult[]> {
    if (!this.#stopped) return []
    this.#stopped = false
    this.#scanTimer = setInterval(() => {
      // Startup callers observe the initial scan. Later scans are best-effort;
      // the next interval retries transient store failures without creating an
      // unhandled rejection in the server process.
      void this.scanActiveGoals().catch(() => undefined)
    }, this.#scanIntervalMs)
    this.#scanTimer.unref?.()
    return this.scanActiveGoals()
  }

  stop(): void {
    this.#stopped = true
    if (this.#scanTimer) clearInterval(this.#scanTimer)
    this.#scanTimer = null
    for (const controller of this.#pendingControllers.values()) controller.abort()
  }

  async scanActiveGoals(): Promise<GoalScheduleResult[]> {
    if (this.#stopped) return []
    const goals = this.#store.listActiveGoals()
    return Promise.all(goals.map((goal) => this.schedule(goal)))
  }

  /** Integration hook to avoid waiting for the periodic scan after a turn ends. */
  async notifyThreadIdle(threadId: string): Promise<GoalScheduleResult | null> {
    if (this.#stopped) return null
    const goal = this.#store.getGoal(threadId)
    if (!goal) return null
    return this.schedule(goal)
  }

  async schedule(candidate: CanonicalGoal): Promise<GoalScheduleResult> {
    const current = this.#store.getGoal(candidate.threadId)
    if (!sameGoalRevision(current, candidate) || current.status !== 'active') {
      return { status: 'inactive', goal: current }
    }
    const limited = this.#enforceLimits(current)
    if (limited) return limited
    if (this.#stopped) return { status: 'stopped', goal: current }
    if (this.#inFlightGoalIds.has(current.id)) return { status: 'busy', goal: current }

    this.#inFlightGoalIds.add(current.id)
    let settleInFlight!: () => void
    const inFlightSettled = new Promise<void>((resolve) => { settleInFlight = resolve })
    this.#inFlightSettlements.set(current.id, inFlightSettled)
    try {
      return await this.#claimAndLaunch(current)
    } finally {
      this.#inFlightGoalIds.delete(current.id)
      this.#pendingControllers.delete(current.id)
      this.#inFlightSettlements.delete(current.id)
      settleInFlight()
    }
  }

  /**
   * Records a terminal automatic turn, applies deterministic Goal limits, then
   * immediately attempts the next continuation if the Goal is still active.
   */
  async recordAutomaticTurn(input: AutomaticGoalTurnResult): Promise<GoalScheduleResult> {
    const recorded = this.#store.recordGoalTurn({
      ...input,
      automatic: true,
    } satisfies RecordGoalTurnInput)
    if (recorded.status === 'stale' || !recorded.goal) {
      return { status: 'stale', goal: recorded.goal }
    }
    const limited = this.#enforceLimits(recorded.goal)
    if (limited) return limited
    return this.schedule(recorded.goal)
  }

  /** Maps a terminal provider condition using the turn's captured Goal tuple. */
  stopForProviderFailure(input: {
    goalId: string
    goalRevision: number
    category: 'provider_failure' | 'provider_usage_limit' | 'context_input_too_large'
    message?: string
  }): GoalCasResult {
    const usageLimited = input.category === 'provider_usage_limit'
    return this.#notifyApplied(this.#store.updateGoalStatus({
      goalId: input.goalId,
      expectedRevision: input.goalRevision,
      status: usageLimited ? 'usage_limited' : 'blocked',
      reason: {
        code: input.category,
        source: usageLimited ? 'provider' : 'host',
        message: input.message ?? null,
        at: this.#now().toISOString(),
      },
    }))
  }

  /** Commits pause before invoking the non-transactional provider interrupt. */
  async pauseBeforeInterrupt(input: {
    goalId: string
    goalRevision: number
    interrupt: () => Promise<void> | void
    message?: string
  }): Promise<GoalCasResult> {
    const paused = this.#notifyApplied(this.#store.updateGoalStatus({
      goalId: input.goalId,
      expectedRevision: input.goalRevision,
      status: 'paused',
      reason: {
        code: 'user_cancelled',
        source: 'user',
        message: input.message ?? null,
        at: this.#now().toISOString(),
      },
    }))
    if (paused.status === 'applied') {
      await this.interruptAfterPause(input.goalId, input.interrupt)
    }
    return paused
  }

  /** Releases pending scheduler ownership after a durable pause has been committed. */
  async interruptAfterPause(goalId: string, interrupt: () => Promise<void> | void): Promise<void> {
    const inFlightSettled = this.#inFlightSettlements.get(goalId) ?? Promise.resolve()
    this.#pendingControllers.get(goalId)?.abort()
    await Promise.all([
      inFlightSettled,
      Promise.resolve().then(interrupt),
    ])
  }

  async #claimAndLaunch(goal: CanonicalGoal): Promise<GoalScheduleResult> {
    const lease = this.#store.claimGoalLease({
      goalId: goal.id,
      goalRevision: goal.revision,
      ownerId: this.#ownerId,
      leaseDurationMs: this.#leaseDurationMs,
    })
    if (!lease) return { status: 'lease_unavailable', goal }

    const controller = new AbortController()
    this.#pendingControllers.set(goal.id, controller)
    let leaseLost = false
    let timeLimitReached = false
    const remainingActiveMs = Math.max(1, (goal.maxActiveSeconds - goal.timeUsedSeconds) * 1_000)
    const activeTimeLimit = setTimeout(() => {
      timeLimitReached = true
      controller.abort(new Error('Goal active-time limit reached while preparing continuation'))
      try {
        this.#notifyApplied(this.#store.updateGoalStatus({
          goalId: goal.id,
          expectedRevision: goal.revision,
          status: 'budget_limited',
          reason: {
            code: 'goal_time_limit',
            source: 'host',
            message: null,
            at: this.#now().toISOString(),
          },
        }))
      } catch {
        // A concurrent user mutation wins its revision CAS; the aborted launch
        // still cannot consume the stale lease.
      }
    }, remainingActiveMs)
    const heartbeat = setInterval(() => {
      try {
        const refreshed = this.#store.heartbeatGoalLease({
          leaseId: lease.leaseId,
          goalId: goal.id,
          goalRevision: goal.revision,
          ownerId: this.#ownerId,
          leaseDurationMs: this.#leaseDurationMs,
        })
        if (refreshed) return
      } catch {
        // A heartbeat error has the same safety meaning as a missing lease: the
        // launcher must not durably begin work without revalidating the tuple.
      }
      if (!leaseLost) {
        leaseLost = true
        controller.abort()
      }
    }, this.#heartbeatIntervalMs)
    heartbeat.unref?.()

    try {
      const result = await this.#launchContinuation({
        goal,
        goalContext: goalContext(goal, lease),
        clientRequestId: continuationClientRequestId(goal),
        signal: controller.signal,
      })
      if (timeLimitReached) {
        return { status: 'limited', goal: this.#store.getGoal(goal.threadId) }
      }
      if (result.status === 'started') {
        return { status: 'started', goal, turnId: result.turnId }
      }
      if (result.status === 'failed') {
        const stopped = this.stopForProviderFailure({
          goalId: goal.id,
          goalRevision: goal.revision,
          category: result.category,
          message: result.message,
        })
        return { status: 'failed', goal: stopped.goal }
      }
      if (leaseLost || result.reason === 'lease_lost') {
        return { status: 'lease_lost', goal: this.#store.getGoal(goal.threadId) }
      }
      if (result.reason === 'stale') {
        return { status: 'stale', goal: this.#store.getGoal(goal.threadId) }
      }
      return { status: 'lease_unavailable', goal }
    } catch {
      if (timeLimitReached) {
        return { status: 'limited', goal: this.#store.getGoal(goal.threadId) }
      }
      if (leaseLost || controller.signal.aborted) {
        return { status: 'lease_lost', goal: this.#store.getGoal(goal.threadId) }
      }
      const stopped = this.stopForProviderFailure({
        goalId: goal.id,
        goalRevision: goal.revision,
        category: 'provider_failure',
        message: 'The automatic continuation could not be started.',
      })
      return { status: 'failed', goal: stopped.goal }
    } finally {
      clearTimeout(activeTimeLimit)
      clearInterval(heartbeat)
      this.#store.releaseGoalLease({
        leaseId: lease.leaseId,
        goalId: goal.id,
        goalRevision: goal.revision,
        ownerId: this.#ownerId,
      })
    }
  }

  #enforceLimits(goal: CanonicalGoal): GoalScheduleResult | null {
    const limit = exhaustedLimit(goal)
    if (!limit) return null
    const stopped = this.#notifyApplied(this.#store.updateGoalStatus({
      goalId: goal.id,
      expectedRevision: goal.revision,
      status: limit.status,
      reason: {
        code: limit.code,
        source: 'host',
        message: null,
        at: this.#now().toISOString(),
      },
    }))
    return { status: stopped.status === 'applied' ? 'limited' : 'stale', goal: stopped.goal }
  }

  #notifyApplied(result: GoalCasResult): GoalCasResult {
    if (result.status === 'applied' && result.goal) this.#onGoalChanged(result.goal)
    return result
  }
}

function sameGoalRevision(current: CanonicalGoal | null, expected: CanonicalGoal): current is CanonicalGoal {
  return current?.id === expected.id && current.revision === expected.revision
}

function goalContext(goal: CanonicalGoal, lease: GoalSchedulerLease): GoalTurnContext {
  return {
    goalId: goal.id,
    goalRevision: goal.revision,
    leaseId: lease.leaseId,
  }
}

function exhaustedLimit(goal: CanonicalGoal): {
  status: 'blocked' | 'budget_limited'
  code: 'goal_token_limit' | 'goal_turn_limit' | 'goal_time_limit' | 'no_progress'
} | null {
  if (goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) {
    return { status: 'budget_limited', code: 'goal_token_limit' }
  }
  if (goal.automaticTurnsUsed >= goal.maxAutomaticTurns) {
    return { status: 'budget_limited', code: 'goal_turn_limit' }
  }
  if (goal.timeUsedSeconds >= goal.maxActiveSeconds) {
    return { status: 'budget_limited', code: 'goal_time_limit' }
  }
  if (goal.noProgressCount >= GOAL_NO_PROGRESS_LIMIT) {
    return { status: 'blocked', code: 'no_progress' }
  }
  return null
}
