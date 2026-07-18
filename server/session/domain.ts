import { randomBytes } from 'node:crypto'

export type CanonicalProvider = 'claude' | 'codex' | 'gemini'
export type SessionId = string
export type ThreadId = string
export type TurnId = string
export type ItemId = string
export type ExecutionId = string

export type ThreadStatus = 'idle' | 'running' | 'blocked' | 'failed' | 'archived'
export type TurnStatus =
  | 'queued'
  | 'running'
  | 'waiting_tool'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted'
export type ExecutionStatus =
  | 'queued'
  | 'running'
  | 'waiting'
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

export interface CanonicalSession {
  id: SessionId
  title: string | null
  preview: string | null
  activeThreadId: ThreadId
  projectKey: string | null
  cwd: string | null
  schemaVersion: number
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  source?: {
    provider: CanonicalProvider
    sourceClient: 'codex_local' | 'claude_desktop' | 'claude_code'
    sourceAlias: string | null
    titleSource: string | null
    projectAlias: string | null
  } | null
}

export interface CanonicalThread {
  id: ThreadId
  sessionId: SessionId
  parentThreadId: ThreadId | null
  forkTurnId: TurnId | null
  forkItemId: ItemId | null
  revision: number
  status: ThreadStatus
  instructionSnapshot: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface CanonicalTurn {
  id: TurnId
  threadId: ThreadId
  sequence: number
  provider: CanonicalProvider
  model: string
  effort: string | null
  status: TurnStatus
  clientRequestId: string
  startedAt: string | null
  completedAt: string | null
  usage: Record<string, unknown> | null
  error: Record<string, unknown> | null
}

export interface CanonicalItem {
  id: ItemId
  sessionId: SessionId
  threadId: ThreadId
  turnId: TurnId | null
  /** Monotonic within a session, including every forked thread. */
  sequence: number
  kind: CanonicalItemKind
  visibility: 'portable' | 'provider_private' | 'baton_private'
  payload: Record<string, unknown>
  provider: CanonicalProvider | null
  nativeId: string | null
  createdAt: string
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

export interface CanonicalStreamEvent {
  /** Database-monotonic durable SSE cursor. */
  sequence: number
  sessionId: SessionId
  threadId: ThreadId
  turnId: TurnId | null
  type: CanonicalStreamEventType
  payload: Record<string, unknown>
  createdAt: string
}

export interface NewCanonicalItem {
  kind: CanonicalItemKind
  visibility?: 'portable' | 'provider_private' | 'baton_private'
  payload: Record<string, unknown>
  provider?: CanonicalProvider | null
  nativeId?: string | null
}

export interface CanonicalExecution {
  id: ExecutionId
  sessionId: SessionId
  threadId: ThreadId
  turnId: TurnId
  parentExecutionId: ExecutionId | null
  spawnItemId: ItemId | null
  kind: 'root_turn' | 'child_turn'
  provider: CanonicalProvider
  model: string
  adapterVersion: string
  status: ExecutionStatus
  policySnapshot: ExecutionPolicySnapshot
  budget: Record<string, unknown>
  usage: Record<string, unknown>
  leaseExpiresAt: string | null
  startedAt: string | null
  completedAt: string | null
}

export interface ExecutionPolicySnapshot {
  delegationMode: 'disabled' | 'baton-managed'
  allowedTools: string[]
  approvalPolicy: string
  cwd: string | null
  maxDepth: number
  capabilityGrant: string | null
}

export interface ProviderBinding {
  id: string
  threadId: ThreadId
  provider: CanonicalProvider
  modelFamily: string
  nativeThreadId: string | null
  nativeResponseId: string | null
  opaqueStateEncrypted: Uint8Array | null
  capabilities: ProviderCapabilities
  syncedRevision: number
  contextDigest: string
  updatedAt: string
  invalidatedAt: string | null
}

export interface ProviderCapabilities {
  roles: string[]
  contentTypes: string[]
  toolCalling: boolean
  parallelTools: boolean
  contextWindow: number | null
  continuation: 'stateless' | 'native' | 'hybrid'
  reasoningState: 'none' | 'opaque' | 'portable-summary'
  taskMetadata: boolean
  nativeChildExecution: 'disabled' | 'exposed'
}

export interface ThreadSnapshot {
  session: CanonicalSession
  thread: CanonicalThread
  turns: CanonicalTurn[]
  items: CanonicalItem[]
  bindings: ProviderBinding[]
}

export interface CreateSessionInput {
  title?: string | null
  projectKey?: string | null
  cwd?: string | null
  instructionSnapshot?: Record<string, unknown>
}

export interface BeginTurnInput {
  threadId: ThreadId
  provider: CanonicalProvider
  model: string
  effort?: string | null
  clientRequestId: string
  requestHash: string
  expectedRevision: number
  input: NewCanonicalItem[]
  adapterVersion: string
  policySnapshot: ExecutionPolicySnapshot
  budget?: Record<string, unknown>
  leaseExpiresAt?: string | null
}

export interface BeginTurnResult {
  turn: CanonicalTurn
  execution: CanonicalExecution
  initialItems: CanonicalItem[]
  duplicate: boolean
}

export interface UpsertProviderBindingInput {
  threadId: ThreadId
  provider: CanonicalProvider
  modelFamily: string
  nativeThreadId?: string | null
  nativeResponseId?: string | null
  opaqueStateEncrypted?: Uint8Array | null
  capabilities: ProviderCapabilities
  syncedRevision: number
  contextDigest: string
}

export interface AppendEventInput {
  turnId: TurnId
  eventId: string
  items: NewCanonicalItem[]
}

export interface FinishTurnInput {
  turnId: TurnId
  status: Extract<TurnStatus, 'completed' | 'cancelled' | 'failed' | 'interrupted'>
  usage?: Record<string, unknown> | null
  error?: Record<string, unknown> | null
}

/** RFC 9562 UUIDv7. Time ordered across milliseconds; random within one millisecond. */
export function uuidV7(now = Date.now(), random = randomBytes(10)): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffff_ffff_ffff) {
    throw new RangeError('UUIDv7 timestamp must fit in 48 bits')
  }
  if (random.byteLength < 10) throw new RangeError('UUIDv7 requires 10 random bytes')

  const bytes = Buffer.allocUnsafe(16)
  let timestamp = now
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256
    timestamp = Math.floor(timestamp / 256)
  }
  bytes[6] = 0x70 | (random[0] & 0x0f)
  bytes[7] = random[1]
  bytes[8] = 0x80 | (random[2] & 0x3f)
  random.copy(bytes, 9, 3, 10)
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
