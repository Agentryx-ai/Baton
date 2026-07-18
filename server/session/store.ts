import type {
  AppendEventInput,
  BeginTurnInput,
  BeginTurnResult,
  CanonicalItem,
  CanonicalGoal,
  CanonicalProvider,
  CanonicalSession,
  CanonicalStreamEvent,
  CanonicalThread,
  CanonicalTurn,
  CreateSessionInput,
  FinishTurnInput,
  GoalId,
  GoalObservation,
  GoalSchedulerLease,
  GoalStatus,
  GoalStatusReason,
  ItemId,
  SessionId,
  ThreadId,
  ThreadSnapshot,
  TurnId,
  UpsertProviderBindingInput,
  ProviderBinding,
} from './domain.ts'
import type { NativeImportStore } from './native-import/contracts.ts'

export interface ForkThreadInput {
  threadId: ThreadId
  forkItemId: ItemId | null
}

export type SessionListScope = 'active' | 'trash' | 'all'

export interface GoalEvent {
  sequence: number
  goalId: GoalId
  threadId: ThreadId
  revision: number
  type: string
  payload: Record<string, unknown>
  createdAt: string
}

export interface CreateGoalInput {
  threadId: ThreadId
  expected: GoalObservation
  objective: string
  provider: CanonicalProvider
  model: string
  effort?: string | null
  tokenBudget?: number | null
  maxAutomaticTurns?: number
  maxActiveSeconds?: number
  replaceExisting?: boolean
}

export interface EditGoalInput {
  goalId: GoalId
  expectedRevision: number
  objective?: string
  provider?: CanonicalProvider
  model?: string
  effort?: string | null
  tokenBudget?: number | null
  maxAutomaticTurns?: number
  maxActiveSeconds?: number
  resetLimitCounters?: boolean
}

export interface UpdateGoalStatusInput {
  goalId: GoalId
  expectedRevision: number
  status: GoalStatus
  reason?: GoalStatusReason | null
  resetLimitCounters?: boolean
}

export interface ClearGoalInput {
  goalId: GoalId
  expectedRevision: number
}

export interface ClaimGoalLeaseInput {
  goalId: GoalId
  goalRevision: number
  ownerId: string
  leaseDurationMs?: number
}

export interface HeartbeatGoalLeaseInput extends ClaimGoalLeaseInput {
  leaseId: string
}

export interface ReleaseGoalLeaseInput {
  leaseId: string
  goalId: GoalId
  goalRevision: number
  ownerId: string
}

export interface RecordGoalTurnInput {
  turnId: TurnId
  goalId: GoalId
  goalRevision: number
  tokensUsed: number
  timeUsedSeconds: number
  automatic: boolean
  progressDigest: string | null
}

export interface CheckpointGoalTurnInput {
  turnId: TurnId
  goalId: GoalId
  goalRevision: number
  /** Cumulative absolute uncached-input plus output tokens for this turn. */
  tokensUsed: number
  /** Cumulative active whole seconds for this turn. */
  timeUsedSeconds: number
  progressDigest?: string | null
}

export interface GoalCasResult {
  status: 'applied' | 'stale'
  goal: CanonicalGoal | null
}

export interface GoalTurnContext {
  goalId: GoalId
  goalRevision: number
  leaseId: string
}

export type GoalAwareBeginTurnInput = BeginTurnInput & {
  goalContext?: GoalTurnContext | null
}

export interface SessionStore extends NativeImportStore {
  createSession(input: CreateSessionInput): CanonicalSession
  listSessions(scope?: SessionListScope): CanonicalSession[]
  getSession(sessionId: SessionId): CanonicalSession | null
  archiveSession(sessionId: SessionId): CanonicalSession
  restoreSession(sessionId: SessionId): CanonicalSession
  purgeExpiredSessions(cutoffIso: string, batchSize?: number): number
  getThread(threadId: ThreadId): CanonicalThread | null
  getSnapshot(threadId: ThreadId): ThreadSnapshot | null
  forkThread(input: ForkThreadInput): CanonicalThread

  beginTurn(input: GoalAwareBeginTurnInput): BeginTurnResult
  getTurn(turnId: TurnId): CanonicalTurn | null
  setTurnActivity(turnId: TurnId, status: Extract<CanonicalTurn['status'], 'running' | 'waiting_tool'>): CanonicalTurn
  appendProviderEvent(input: AppendEventInput): CanonicalItem[]
  finishTurn(input: FinishTurnInput): CanonicalTurn
  upsertProviderBinding(input: UpsertProviderBindingInput): ProviderBinding
  listItems(threadId: ThreadId, afterSequence?: number): CanonicalItem[]
  listEvents(threadId: ThreadId, afterSequence?: number): CanonicalStreamEvent[]
  recoverInterruptedTurns(): number

  getGoal(threadId: ThreadId): CanonicalGoal | null
  listActiveGoals(): CanonicalGoal[]
  listGoalEvents(threadId: ThreadId, afterSequence?: number): GoalEvent[]
  createGoal(input: CreateGoalInput): CanonicalGoal
  editGoal(input: EditGoalInput): CanonicalGoal
  updateGoalStatus(input: UpdateGoalStatusInput): GoalCasResult
  clearGoal(input: ClearGoalInput): void
  claimGoalLease(input: ClaimGoalLeaseInput): GoalSchedulerLease | null
  heartbeatGoalLease(input: HeartbeatGoalLeaseInput): GoalSchedulerLease | null
  releaseGoalLease(input: ReleaseGoalLeaseInput): boolean
  checkpointGoalTurn(input: CheckpointGoalTurnInput): GoalCasResult
  recordGoalTurn(input: RecordGoalTurnInput): GoalCasResult

  close(): void
}

export class SessionStoreError extends Error {
  public readonly code:
    | 'not_found'
    | 'revision_conflict'
    | 'turn_not_running'
    | 'invalid_fork'
    | 'duplicate_request'
    | 'session_busy'
    | 'session_archived'

  constructor(
    code:
      | 'not_found'
      | 'revision_conflict'
      | 'turn_not_running'
      | 'invalid_fork'
      | 'duplicate_request'
      | 'session_busy'
      | 'session_archived',
    message: string,
  ) {
    super(message)
    this.code = code
    this.name = 'SessionStoreError'
  }
}

export class GoalStoreError extends Error {
  public readonly code:
    | 'goal_not_found'
    | 'stale_goal_revision'
    | 'invalid_goal_transition'
    | 'unfinished_goal_exists'
    | 'invalid_goal_input'
    | 'goal_lease_lost'

  constructor(
    code:
      | 'goal_not_found'
      | 'stale_goal_revision'
      | 'invalid_goal_transition'
      | 'unfinished_goal_exists'
      | 'invalid_goal_input'
      | 'goal_lease_lost',
    message: string,
  ) {
    super(message)
    this.code = code
    this.name = 'GoalStoreError'
  }
}
