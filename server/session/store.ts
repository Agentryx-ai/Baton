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

export type SessionListScope = 'active' | 'trash' | 'all'

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
