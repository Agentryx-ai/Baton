import type {
  AppendEventInput,
  BeginSessionResult,
  BeginTurnInput,
  BeginTurnResult,
  CanonicalItem,
  CanonicalFollowUp,
  CanonicalGoal,
  GoalCompletionProposal,
  GoalCompletionReceipt,
  GoalEvidenceBundle,
  GoalRequirementClaim,
  GoalVerificationDecision,
  GoalVerificationHistory,
  GoalVerificationAttempt,
  GoalStopReceipt,
  GoalVerifierLease,
  CanonicalProvider,
  CanonicalSession,
  CanonicalStreamEvent,
  CanonicalThread,
  CanonicalTurn,
  CreateSessionInput,
  FinishTurnInput,
  FollowUpDelivery,
  FollowUpId,
  FollowUpScope,
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
  GlobalPermissionSettings,
  PermissionProfile,
} from './domain.ts'
import type { NativeImportStore } from './native-import/contracts.ts'

export interface ForkThreadInput {
  threadId: ThreadId
  forkItemId: ItemId | null
}

export type SessionListScope = 'active' | 'trash' | 'all'

export type ToolReconciliationResolution = 'succeeded' | 'failed' | 'unknown_acknowledged'

export interface ReconcileToolInput {
  turnId: TurnId
  callId: string
  resolution: ToolReconciliationResolution
  note?: string
}

export interface ReconcileToolResult {
  item: CanonicalItem
  duplicate: boolean
}

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
  provider?: CanonicalProvider
  model?: string
  effort?: string | null
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

export interface BeginGoalVerificationInput {
  goalId: GoalId
  goalRevision: number
  turnId: TurnId
  summary: string
  requirements: GoalRequirementClaim[]
  evidenceBundle: GoalEvidenceBundle
}

export interface FinishGoalVerificationInput {
  proposalId: string
  goalId: GoalId
  goalRevision: number
  evaluatorProvider: CanonicalProvider
  evaluatorModel: string
  decision: GoalVerificationDecision
  usage?: Record<string, unknown> | null
  leaseId: string
  leaseOwner: string
}

export interface ClaimGoalVerifierLeaseInput {
  proposalId: string
  goalId: GoalId
  goalRevision: number
  ownerId: string
  leaseDurationMs?: number
}

export interface HeartbeatGoalVerifierLeaseInput extends ClaimGoalVerifierLeaseInput {
  leaseId: string
}

export interface ReleaseGoalVerifierLeaseInput {
  proposalId: string
  leaseId: string
  ownerId: string
}

export interface FinishGoalVerificationResult {
  status: 'applied' | 'stale'
  goal: CanonicalGoal | null
  attempt: GoalVerificationAttempt | null
  receipt: GoalCompletionReceipt | null
  stopReceipt: GoalStopReceipt | null
}

export interface EnqueueFollowUpInput {
  threadId: ThreadId
  clientRequestId: string
  requestHash: string
  delivery: FollowUpDelivery
  /** Active turn to steer; null means the intent is waiting for a later canonical turn. */
  targetTurnId: TurnId | null
  scope: FollowUpScope
  input: CanonicalFollowUp['input']
}

export interface EnqueueFollowUpResult {
  followUp: CanonicalFollowUp
  duplicate: boolean
}

export interface ClaimFollowUpInput {
  threadId: ThreadId
  ownerId: string
  purpose: 'steer' | 'next_turn'
  targetTurnId?: TurnId
  leaseDurationMs?: number
}

export interface ConsumeFollowUpInput {
  followUpId: FollowUpId
  ownerId: string
  turnId: TurnId
}

export type ConsumeFollowUpResult =
  | { status: 'consumed'; followUp: CanonicalFollowUp; items: CanonicalItem[] }
  | { status: 'queued' | 'stale_goal'; followUp: CanonicalFollowUp; items: [] }

export interface RequeueFollowUpInput {
  followUpId: FollowUpId
  ownerId: string
  targetTurnId?: TurnId | null
}

export interface CloseFollowUpWindowResult {
  requeued: number
  inFlight: number
}

export type BeginTurnFromFollowUpInput = Omit<BeginTurnInput,
  'clientRequestId' | 'requestHash' | 'expectedRevision' | 'input'> & {
    followUpId: FollowUpId
    ownerId: string
  }

export type GoalAwareBeginTurnInput = BeginTurnInput & {
  goalContext?: GoalTurnContext | null
}

export interface BeginSessionInput {
  sessionId: SessionId
  clientRequestId: string
  requestHash: string
  cwd: string | null
  instructionSnapshot: Record<string, unknown>
  provider: CanonicalProvider
  model: string
  effort: string | null
  input: BeginTurnInput['input']
  adapterVersion: string
  policySnapshot: BeginTurnInput['policySnapshot']
  budget?: Record<string, unknown>
  leaseExpiresAt?: string | null
}

export interface InitialSessionRequestIdentity {
  sessionId: SessionId
  clientRequestId: string
  requestHash: string
}

export interface UpdateWorkspaceInput {
  sessionId: SessionId
  expectedThreadRevision: number
  /** Already canonicalized by the service boundary; null disconnects the workspace. */
  cwd: string | null
}

export interface UpdateSessionPermissionProfileInput {
  sessionId: SessionId
  profile: PermissionProfile | null
}

export interface SessionStore extends NativeImportStore {
  getPermissionSettings(): GlobalPermissionSettings
  updateDefaultPermissionProfile(profile: PermissionProfile): GlobalPermissionSettings
  updateSessionPermissionProfile(input: UpdateSessionPermissionProfileInput): CanonicalSession
  createSession(input: CreateSessionInput): CanonicalSession
  getInitialSessionResult(input: InitialSessionRequestIdentity): BeginSessionResult | null
  beginSession(input: BeginSessionInput): BeginSessionResult
  listSessions(scope?: SessionListScope): CanonicalSession[]
  getSession(sessionId: SessionId): CanonicalSession | null
  archiveSession(sessionId: SessionId): CanonicalSession
  restoreSession(sessionId: SessionId): CanonicalSession
  updateWorkspace(input: UpdateWorkspaceInput): CanonicalSession
  purgeExpiredSessions(cutoffIso: string, batchSize?: number): number
  getThread(threadId: ThreadId): CanonicalThread | null
  getSnapshot(threadId: ThreadId): ThreadSnapshot | null
  forkThread(input: ForkThreadInput): CanonicalThread

  beginTurn(input: GoalAwareBeginTurnInput): BeginTurnResult
  beginTurnFromFollowUp(input: BeginTurnFromFollowUpInput): BeginTurnResult
  getTurn(turnId: TurnId): CanonicalTurn | null
  setTurnActivity(turnId: TurnId, status: Extract<CanonicalTurn['status'], 'running' | 'waiting_tool'>): CanonicalTurn
  appendProviderEvent(input: AppendEventInput): CanonicalItem[]
  reconcileTool(input: ReconcileToolInput): ReconcileToolResult
  finishTurn(input: FinishTurnInput): CanonicalTurn
  enqueueFollowUp(input: EnqueueFollowUpInput): EnqueueFollowUpResult
  listFollowUps(threadId: ThreadId): CanonicalFollowUp[]
  getFollowUpByClientRequest(threadId: ThreadId, clientRequestId: string): CanonicalFollowUp | null
  claimFollowUp(input: ClaimFollowUpInput): CanonicalFollowUp | null
  consumeFollowUp(input: ConsumeFollowUpInput): ConsumeFollowUpResult
  requeueFollowUp(input: RequeueFollowUpInput): CanonicalFollowUp
  closeFollowUpWindow(turnId: TurnId): CloseFollowUpWindowResult
  markStaleGoalFollowUps(threadId: ThreadId): number
  recoverExpiredFollowUpClaims(cutoffIso?: string): number
  cancelFollowUp(followUpId: FollowUpId, expectedRevision: number): CanonicalFollowUp
  markFollowUpDeliveryUnknown(followUpId: FollowUpId, ownerId: string): CanonicalFollowUp
  markTurnFollowUpsDeliveryUnknown(turnId: TurnId): number
  upsertProviderBinding(input: UpsertProviderBindingInput): ProviderBinding
  listItems(threadId: ThreadId, afterSequence?: number): CanonicalItem[]
  listEvents(threadId: ThreadId, afterSequence?: number): CanonicalStreamEvent[]
  recoverInterruptedTurns(): number

  getGoal(threadId: ThreadId): CanonicalGoal | null
  getGoalById(goalId: GoalId): CanonicalGoal | null
  listActiveGoals(): CanonicalGoal[]
  listGoalEvents(threadId: ThreadId, afterSequence?: number): GoalEvent[]
  listPendingGoalCompletionProposals(): GoalCompletionProposal[]
  getGoalVerificationHistory(goalId: GoalId): GoalVerificationHistory
  createGoal(input: CreateGoalInput): CanonicalGoal
  editGoal(input: EditGoalInput): CanonicalGoal
  updateGoalStatus(input: UpdateGoalStatusInput): GoalCasResult
  clearGoal(input: ClearGoalInput): void
  claimGoalLease(input: ClaimGoalLeaseInput): GoalSchedulerLease | null
  heartbeatGoalLease(input: HeartbeatGoalLeaseInput): GoalSchedulerLease | null
  releaseGoalLease(input: ReleaseGoalLeaseInput): boolean
  checkpointGoalTurn(input: CheckpointGoalTurnInput): GoalCasResult
  recordGoalTurn(input: RecordGoalTurnInput): GoalCasResult
  beginGoalVerification(input: BeginGoalVerificationInput): GoalCompletionProposal | null
  claimGoalVerifierLease(input: ClaimGoalVerifierLeaseInput): GoalVerifierLease | null
  heartbeatGoalVerifierLease(input: HeartbeatGoalVerifierLeaseInput): GoalVerifierLease | null
  releaseGoalVerifierLease(input: ReleaseGoalVerifierLeaseInput): boolean
  finishGoalVerification(input: FinishGoalVerificationInput): FinishGoalVerificationResult

  close(): void
}

export class SessionStoreError extends Error {
  public readonly code:
    | 'not_found'
    | 'revision_conflict'
    | 'turn_not_running'
    | 'invalid_fork'
    | 'duplicate_request'
    | 'initial_session_conflict'
    | 'session_busy'
    | 'session_archived'
    | 'invalid_reconciliation'
    | 'reconciliation_conflict'

  constructor(
    code:
      | 'not_found'
      | 'revision_conflict'
      | 'turn_not_running'
      | 'invalid_fork'
      | 'duplicate_request'
      | 'initial_session_conflict'
      | 'session_busy'
      | 'session_archived'
      | 'invalid_reconciliation'
      | 'reconciliation_conflict',
    message: string,
  ) {
    super(message)
    this.code = code
    this.name = 'SessionStoreError'
  }
}

export class FollowUpStoreError extends Error {
  public readonly code: 'invalid_follow_up' | 'follow_up_lease_lost'

  constructor(
    code: 'invalid_follow_up' | 'follow_up_lease_lost',
    message: string,
  ) {
    super(message)
    this.code = code
    this.name = 'FollowUpStoreError'
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
