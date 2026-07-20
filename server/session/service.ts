import type {
  BeginTurnResult,
  BeginSessionResult,
  CanonicalItem,
  CanonicalGoal,
  GoalVerificationHistory,
  CanonicalFollowUp,
  CanonicalProvider,
  CanonicalSession,
  CanonicalStreamEvent,
  CanonicalThread,
  CreateSessionInput,
  NewCanonicalItem,
  SessionId,
  ThreadId,
  ThreadSnapshot,
  TurnId,
  GlobalPermissionSettings,
  PermissionProfile,
} from './domain.ts'
import type {
  ClearGoalInput,
  CreateGoalInput,
  EditGoalInput,
  ForkThreadInput,
  GoalCasResult,
  ReconcileToolInput,
  ReconcileToolResult,
  SessionListScope,
} from './store.ts'

export interface StartTurnInput {
  threadId: ThreadId
  provider: CanonicalProvider
  model: string
  effort?: string | null
  clientRequestId: string
  expectedRevision: number
  input: NewCanonicalItem[]
}

/** Client-owned draft identity plus the immutable first-turn payload. */
export interface StartSessionInput {
  sessionId: SessionId
  clientRequestId: string
  cwd: string | null
  instructionSnapshot?: Record<string, unknown>
  provider: CanonicalProvider
  model: string
  effort?: string | null
  input: NewCanonicalItem[]
}

export class ProviderReadinessError extends Error {
  readonly code = 'provider_not_ready'
  readonly provider: CanonicalProvider

  constructor(provider: CanonicalProvider, options?: ErrorOptions) {
    super(`${provider} provider is not ready`, options)
    this.name = 'ProviderReadinessError'
    this.provider = provider
  }
}

export interface UserGoalStatusInput {
  goalId: string
  expectedRevision: number
  status: 'active' | 'paused'
  provider?: CanonicalProvider
  model?: string
  effort?: string | null
  resetLimitCounters?: boolean
}

export interface WorkspaceMutationInput {
  sessionId: SessionId
  expectedRevision: number
  cwd: string
}

export interface SubmitFollowUpInput {
  threadId: ThreadId
  clientRequestId: string
  expectedTurnId: TurnId
  delivery: 'steer_or_queue' | 'next_turn'
  input: NewCanonicalItem[]
}

export interface ConversationService {
  createSession(input: CreateSessionInput): CanonicalSession
  startSession(input: StartSessionInput): Promise<BeginSessionResult>
  listSessions(scope?: SessionListScope): CanonicalSession[]
  getSession(sessionId: SessionId): CanonicalSession | null
  getPermissionSettings(): GlobalPermissionSettings
  updateDefaultPermissionProfile(profile: PermissionProfile): GlobalPermissionSettings
  updateSessionPermissionProfile(sessionId: SessionId, profile: PermissionProfile | null): CanonicalSession
  archiveSession(sessionId: SessionId): CanonicalSession
  restoreSession(sessionId: SessionId): CanonicalSession
  connectWorkspace(input: WorkspaceMutationInput): CanonicalSession
  disconnectWorkspace(sessionId: SessionId, expectedRevision: number): CanonicalSession
  getSnapshot(threadId: ThreadId): ThreadSnapshot | null
  forkThread(input: ForkThreadInput): CanonicalThread
  listItems(threadId: ThreadId, afterSequence?: number): CanonicalItem[]
  listEvents(threadId: ThreadId, afterSequence?: number): CanonicalStreamEvent[]

  getGoal(threadId: ThreadId): CanonicalGoal | null
  getGoalVerificationHistory(goalId: string): GoalVerificationHistory
  createGoal(input: CreateGoalInput): Promise<CanonicalGoal>
  editGoal(input: EditGoalInput): Promise<CanonicalGoal>
  updateGoalStatus(input: UserGoalStatusInput): Promise<GoalCasResult>
  clearGoal(input: ClearGoalInput): Promise<void>

  startTurn(input: StartTurnInput): Promise<BeginTurnResult>
  submitFollowUp(input: SubmitFollowUpInput): Promise<{ followUp: CanonicalFollowUp; duplicate: boolean }>
  cancelFollowUp(followUpId: string, expectedRevision: number): CanonicalFollowUp
  cancelTurn(turnId: TurnId): Promise<void>
  reconcileTool(input: ReconcileToolInput): ReconcileToolResult

  subscribe(threadId: ThreadId, listener: () => void): () => void
}
