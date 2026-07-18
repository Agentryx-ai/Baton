import type {
  AppendEventInput,
  BeginTurnInput,
  BeginTurnResult,
  CanonicalItem,
  CanonicalSession,
  CanonicalStreamEvent,
  CanonicalThread,
  CanonicalTurn,
  CreateSessionInput,
  FinishTurnInput,
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

export interface SessionStore extends NativeImportStore {
  createSession(input: CreateSessionInput): CanonicalSession
  listSessions(): CanonicalSession[]
  getSession(sessionId: SessionId): CanonicalSession | null
  getThread(threadId: ThreadId): CanonicalThread | null
  getSnapshot(threadId: ThreadId): ThreadSnapshot | null
  forkThread(input: ForkThreadInput): CanonicalThread

  beginTurn(input: BeginTurnInput): BeginTurnResult
  getTurn(turnId: TurnId): CanonicalTurn | null
  appendProviderEvent(input: AppendEventInput): CanonicalItem[]
  finishTurn(input: FinishTurnInput): CanonicalTurn
  upsertProviderBinding(input: UpsertProviderBindingInput): ProviderBinding
  listItems(threadId: ThreadId, afterSequence?: number): CanonicalItem[]
  listEvents(threadId: ThreadId, afterSequence?: number): CanonicalStreamEvent[]
  recoverInterruptedTurns(): number

  close(): void
}

export class SessionStoreError extends Error {
  public readonly code:
    | 'not_found'
    | 'revision_conflict'
    | 'turn_not_running'
    | 'invalid_fork'
    | 'duplicate_request'

  constructor(
    code:
      | 'not_found'
      | 'revision_conflict'
      | 'turn_not_running'
      | 'invalid_fork'
      | 'duplicate_request',
    message: string,
  ) {
    super(message)
    this.code = code
    this.name = 'SessionStoreError'
  }
}
