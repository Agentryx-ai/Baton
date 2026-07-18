export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject
export interface JsonObject {
  [key: string]: JsonValue
}

export type CanonicalProvider = 'claude' | 'codex' | 'gemini'
export type ThreadStatus = 'idle' | 'running' | 'blocked' | 'failed' | 'archived'
export type TurnStatus =
  | 'queued'
  | 'running'
  | 'waiting_tool'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted'

export type CanonicalItemKind =
  | 'user_message'
  | 'assistant_message'
  | 'reasoning_summary'
  | 'tool_call'
  | 'tool_result'
  | 'file_change'
  | 'approval'
  | 'plan'
  | 'task'
  | 'usage'
  | 'error'
  | 'summary'
  | 'provider_event'

export interface CanonicalSessionDto {
  id: string
  title: string | null
  preview: string | null
  activeThreadId: string
  projectKey: string | null
  cwd: string | null
  schemaVersion: number
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

export interface CanonicalThreadDto {
  id: string
  sessionId: string
  parentThreadId: string | null
  forkTurnId: string | null
  forkItemId: string | null
  revision: number
  status: ThreadStatus
  instructionSnapshot: JsonObject
  createdAt: string
  updatedAt: string
}

export interface CanonicalTurnDto {
  id: string
  threadId: string
  sequence: number
  provider: CanonicalProvider
  model: string
  status: TurnStatus
  clientRequestId: string
  startedAt: string | null
  completedAt: string | null
  usage: JsonObject | null
  error: JsonObject | null
}

export interface CanonicalItemDto {
  id: string
  sessionId: string
  threadId: string
  turnId: string | null
  sequence: number
  kind: CanonicalItemKind
  visibility: 'portable' | 'provider_private' | 'baton_private'
  payload: JsonObject
  provider: CanonicalProvider | null
  nativeId: string | null
  createdAt: string
}

export interface ThreadSnapshotDto {
  session: CanonicalSessionDto
  thread: CanonicalThreadDto
  turns: CanonicalTurnDto[]
  items: CanonicalItemDto[]
  bindings: JsonValue[]
}

export type CanonicalStreamEventType =
  | 'session_created'
  | 'thread_forked'
  | 'turn_started'
  | 'items_appended'
  | 'turn_completed'
  | 'turn_cancelled'
  | 'turn_failed'
  | 'turn_interrupted'

export interface CanonicalStreamEventDto {
  sequence: number
  sessionId: string
  threadId: string
  turnId: string | null
  type: CanonicalStreamEventType
  payload: JsonObject
  createdAt: string
}

export interface CreateSessionDto {
  title?: string | null
  projectKey?: string | null
  cwd?: string | null
  instructionSnapshot?: JsonObject
}

export interface StartTurnDto {
  provider: CanonicalProvider
  model: string
  clientRequestId: string
  expectedRevision: number
  input: Array<{
    kind: 'user_message'
    visibility: 'portable'
    payload: JsonObject
  }>
}

export interface BeginTurnResultDto {
  turn: CanonicalTurnDto
  initialItems: CanonicalItemDto[]
  duplicate: boolean
  execution: {
    id: string
    status: string
  }
}
