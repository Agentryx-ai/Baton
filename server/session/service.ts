import type {
  BeginTurnResult,
  CanonicalItem,
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
import type { ForkThreadInput } from './store.ts'

export interface StartTurnInput {
  threadId: ThreadId
  provider: CanonicalProvider
  model: string
  effort?: string | null
  clientRequestId: string
  expectedRevision: number
  input: NewCanonicalItem[]
}

export interface ConversationService {
  createSession(input: CreateSessionInput): CanonicalSession
  listSessions(): CanonicalSession[]
  getSession(sessionId: SessionId): CanonicalSession | null
  getSnapshot(threadId: ThreadId): ThreadSnapshot | null
  forkThread(input: ForkThreadInput): CanonicalThread
  listItems(threadId: ThreadId, afterSequence?: number): CanonicalItem[]
  listEvents(threadId: ThreadId, afterSequence?: number): CanonicalStreamEvent[]

  startTurn(input: StartTurnInput): Promise<BeginTurnResult>
  cancelTurn(turnId: TurnId): Promise<void>

  subscribe(threadId: ThreadId, listener: () => void): () => void
}
