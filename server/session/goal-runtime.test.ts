import assert from 'node:assert/strict'
import test from 'node:test'

import type { CanonicalGoal, GoalSchedulerLease } from './domain.ts'
import {
  continuationClientRequestId,
  GoalRuntime,
  type GoalRuntimeStore,
} from './goal-runtime.ts'
import type {
  ClaimGoalLeaseInput,
  GoalCasResult,
  HeartbeatGoalLeaseInput,
  RecordGoalTurnInput,
  ReleaseGoalLeaseInput,
  UpdateGoalStatusInput,
} from './store.ts'

function goal(overrides: Partial<CanonicalGoal> = {}): CanonicalGoal {
  return {
    id: 'goal-1',
    threadId: 'thread-1',
    objective: 'Finish the requested work',
    status: 'active',
    statusReason: null,
    revision: 4,
    provider: 'codex',
    model: 'test-model',
    effort: 'high',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    maxAutomaticTurns: 24,
    automaticTurnsUsed: 0,
    maxActiveSeconds: 7_200,
    noProgressCount: 0,
    lastProgressDigest: null,
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    startedAt: '2026-07-19T00:00:00.000Z',
    completedAt: null,
    ...overrides,
  }
}

class FakeGoalStore implements GoalRuntimeStore {
  current: CanonicalGoal | null
  lease: GoalSchedulerLease | null = null
  heartbeatCount = 0
  refuseHeartbeat = false
  statusUpdates: UpdateGoalStatusInput[] = []

  constructor(initial: CanonicalGoal | null) {
    this.current = initial
  }

  getGoal(threadId: string): CanonicalGoal | null {
    return this.current?.threadId === threadId ? this.current : null
  }

  listActiveGoals(): CanonicalGoal[] {
    return this.current?.status === 'active' ? [this.current] : []
  }

  claimGoalLease(input: ClaimGoalLeaseInput): GoalSchedulerLease | null {
    if (this.lease || this.current?.id !== input.goalId
      || this.current.revision !== input.goalRevision || this.current.status !== 'active') return null
    this.lease = {
      leaseId: 'lease-1',
      goalId: input.goalId,
      goalRevision: input.goalRevision,
      ownerId: input.ownerId,
      acquiredAt: '2026-07-19T00:00:00.000Z',
      heartbeatAt: '2026-07-19T00:00:00.000Z',
      expiresAt: '2026-07-19T00:00:30.000Z',
    }
    return this.lease
  }

  heartbeatGoalLease(input: HeartbeatGoalLeaseInput): GoalSchedulerLease | null {
    this.heartbeatCount += 1
    if (this.refuseHeartbeat || this.lease?.leaseId !== input.leaseId) {
      this.lease = null
      return null
    }
    return this.lease
  }

  releaseGoalLease(input: ReleaseGoalLeaseInput): boolean {
    if (this.lease?.leaseId !== input.leaseId) return false
    this.lease = null
    return true
  }

  updateGoalStatus(input: UpdateGoalStatusInput): GoalCasResult {
    this.statusUpdates.push(input)
    if (!this.current || this.current.id !== input.goalId || this.current.revision !== input.expectedRevision) {
      return { status: 'stale', goal: this.current }
    }
    this.current = {
      ...this.current,
      status: input.status,
      statusReason: input.status === 'active' ? null : (input.reason ?? null),
      revision: this.current.revision + 1,
    }
    this.lease = null
    return { status: 'applied', goal: this.current }
  }

  recordGoalTurn(input: RecordGoalTurnInput): GoalCasResult {
    if (!this.current || this.current.id !== input.goalId || this.current.revision !== input.goalRevision) {
      return { status: 'stale', goal: this.current }
    }
    const same = input.progressDigest !== null && input.progressDigest === this.current.lastProgressDigest
    this.current = {
      ...this.current,
      tokensUsed: this.current.tokensUsed + input.tokensUsed,
      timeUsedSeconds: this.current.timeUsedSeconds + input.timeUsedSeconds,
      automaticTurnsUsed: this.current.automaticTurnsUsed + (input.automatic ? 1 : 0),
      noProgressCount: input.progressDigest === null
        ? this.current.noProgressCount + 1
        : same ? this.current.noProgressCount + 1 : 0,
      lastProgressDigest: input.progressDigest ?? this.current.lastProgressDigest,
    }
    return { status: 'applied', goal: this.current }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('restart scan launches an active Goal with a deterministic request ID and lease tuple', async () => {
  const store = new FakeGoalStore(goal({ automaticTurnsUsed: 7 }))
  const requests: Array<{ id: string; lease: string }> = []
  const runtime = new GoalRuntime(store, {
    ownerId: 'runtime-1',
    scanIntervalMs: 60_000,
    launchContinuation: (request) => {
      requests.push({ id: request.clientRequestId, lease: request.goalContext.leaseId })
      return { status: 'started', turnId: 'turn-8' }
    },
  })

  const results = await runtime.start()
  runtime.stop()

  assert.equal(results[0]?.status, 'started')
  assert.deepEqual(requests, [{
    id: 'goal-continuation:goal-1:r4:a8',
    lease: 'lease-1',
  }])
  assert.equal(store.lease, null)
  assert.equal(continuationClientRequestId(goal()), 'goal-continuation:goal-1:r4:a1')
})

test('one runtime never overlaps launch attempts and heartbeats a pending lease', async () => {
  const store = new FakeGoalStore(goal())
  const gate = deferred<{ status: 'started'; turnId: string }>()
  let launches = 0
  const runtime = new GoalRuntime(store, {
    ownerId: 'runtime-1',
    leaseDurationMs: 40,
    heartbeatIntervalMs: 5,
    scanIntervalMs: 60_000,
    launchContinuation: () => {
      launches += 1
      return gate.promise
    },
  })

  const startup = runtime.start()
  await new Promise((resolve) => setTimeout(resolve, 12))
  const duplicate = await runtime.scanActiveGoals()
  assert.equal(duplicate[0]?.status, 'busy')
  assert.equal(launches, 1)
  assert.ok(store.heartbeatCount >= 1)

  gate.resolve({ status: 'started', turnId: 'turn-1' })
  const result = await startup
  runtime.stop()
  assert.equal(result[0]?.status, 'started')
})

test('lost lease aborts a pending launcher and never reports a turn start', async () => {
  const store = new FakeGoalStore(goal())
  store.refuseHeartbeat = true
  const runtime = new GoalRuntime(store, {
    ownerId: 'runtime-1',
    leaseDurationMs: 40,
    heartbeatIntervalMs: 5,
    scanIntervalMs: 60_000,
    launchContinuation: async ({ signal }) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 15))
      return signal.aborted
        ? { status: 'not_started', reason: 'lease_lost' }
        : { status: 'started', turnId: 'unexpected' }
    },
  })

  const result = await runtime.start()
  runtime.stop()
  assert.equal(result[0]?.status, 'lease_lost')
})

test('limits are committed in token, turn, time, then no-progress order', async () => {
  const cases: Array<[Partial<CanonicalGoal>, string, string]> = [
    [{ tokenBudget: 10, tokensUsed: 10, automaticTurnsUsed: 24, timeUsedSeconds: 7_200, noProgressCount: 3 }, 'budget_limited', 'goal_token_limit'],
    [{ automaticTurnsUsed: 24, timeUsedSeconds: 7_200, noProgressCount: 3 }, 'budget_limited', 'goal_turn_limit'],
    [{ timeUsedSeconds: 7_200, noProgressCount: 3 }, 'budget_limited', 'goal_time_limit'],
    [{ noProgressCount: 3 }, 'blocked', 'no_progress'],
  ]

  for (const [overrides, expectedStatus, expectedCode] of cases) {
    const store = new FakeGoalStore(goal(overrides))
    const runtime = new GoalRuntime(store, {
      ownerId: 'runtime-1',
      scanIntervalMs: 60_000,
      launchContinuation: () => assert.fail('a limited Goal must not launch'),
    })
    const result = await runtime.start()
    runtime.stop()
    assert.equal(result[0]?.status, 'limited')
    assert.equal(store.current?.status, expectedStatus)
    assert.equal(store.current?.statusReason?.code, expectedCode)
  }
})

test('terminal accounting stops at the 24th automatic turn before another launch', async () => {
  const store = new FakeGoalStore(goal({ automaticTurnsUsed: 23 }))
  let launches = 0
  const runtime = new GoalRuntime(store, {
    ownerId: 'runtime-1',
    scanIntervalMs: 60_000,
    launchContinuation: () => {
      launches += 1
      return { status: 'started', turnId: 'unexpected' }
    },
  })
  await runtime.start()
  // The restart scan is not the turn under test.
  launches = 0

  const result = await runtime.recordAutomaticTurn({
    turnId: 'turn-24',
    goalId: 'goal-1',
    goalRevision: 4,
    tokensUsed: 25,
    timeUsedSeconds: 3,
    progressDigest: 'digest-24',
  })
  runtime.stop()

  assert.equal(result.status, 'limited')
  assert.equal(store.current?.statusReason?.code, 'goal_turn_limit')
  assert.equal(launches, 0)
})

test('pause is committed before interrupt and stale pause does not interrupt', async () => {
  const store = new FakeGoalStore(goal())
  const order: string[] = []
  const originalUpdate = store.updateGoalStatus.bind(store)
  store.updateGoalStatus = (input) => {
    order.push('pause')
    return originalUpdate(input)
  }
  const runtime = new GoalRuntime(store, {
    ownerId: 'runtime-1',
    launchContinuation: () => ({ status: 'not_started', reason: 'busy' }),
  })

  const applied = await runtime.pauseBeforeInterrupt({
    goalId: 'goal-1',
    goalRevision: 4,
    interrupt: () => { order.push('interrupt') },
  })
  assert.equal(applied.status, 'applied')
  assert.deepEqual(order, ['pause', 'interrupt'])

  let staleInterrupted = false
  const stale = await runtime.pauseBeforeInterrupt({
    goalId: 'goal-1',
    goalRevision: 4,
    interrupt: () => { staleInterrupted = true },
  })
  assert.equal(stale.status, 'stale')
  assert.equal(staleInterrupted, false)
})

test('stale candidates and provider failures cannot overwrite a newer Goal revision', async () => {
  const store = new FakeGoalStore(goal({ revision: 5 }))
  const runtime = new GoalRuntime(store, {
    ownerId: 'runtime-1',
    launchContinuation: () => ({ status: 'started', turnId: 'never' }),
  })
  const stale = await runtime.schedule(goal({ revision: 4 }))
  assert.equal(stale.status, 'inactive')

  const stopped = runtime.stopForProviderFailure({
    goalId: 'goal-1',
    goalRevision: 4,
    category: 'provider_failure',
  })
  assert.equal(stopped.status, 'stale')
  assert.equal(store.current?.status, 'active')
})
