import type {
  BeginTurnResult,
  CanonicalItem,
  CanonicalGoal,
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

export interface UserGoalStatusInput {
  goalId: string
  expectedRevision: number
  status: 'active' | 'paused'
  resetLimitCounters?: boolean
}

export interface ConversationService {
  createSession(input: CreateSessionInput): CanonicalSession
  listSessions(scope?: SessionListScope): CanonicalSession[]
  getSession(sessionId: SessionId): CanonicalSession | null
  archiveSession(sessionId: SessionId): CanonicalSession
  restoreSession(sessionId: SessionId): CanonicalSession
  getSnapshot(threadId: ThreadId): ThreadSnapshot | null
  forkThread(input: ForkThreadInput): CanonicalThread
  listItems(threadId: ThreadId, afterSequence?: number): CanonicalItem[]
  listEvents(threadId: ThreadId, afterSequence?: number): CanonicalStreamEvent[]

  getGoal(threadId: ThreadId): CanonicalGoal | null
  createGoal(input: CreateGoalInput): Promise<CanonicalGoal>
  editGoal(input: EditGoalInput): Promise<CanonicalGoal>
  updateGoalStatus(input: UserGoalStatusInput): Promise<GoalCasResult>
  clearGoal(input: ClearGoalInput): Promise<void>

  startTurn(input: StartTurnInput): Promise<BeginTurnResult>
  cancelTurn(turnId: TurnId): Promise<void>
  reconcileTool(input: ReconcileToolInput): ReconcileToolResult

  subscribe(threadId: ThreadId, listener: () => void): () => void
}
