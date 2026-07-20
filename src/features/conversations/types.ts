export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject
export interface JsonObject {
  [key: string]: JsonValue
}

export type CanonicalProvider = 'claude' | 'codex' | 'gemini'
export type PermissionProfile = 'read_only' | 'workspace' | 'full_access'
export type ThreadStatus = 'idle' | 'running' | 'blocked' | 'failed' | 'archived'
export type TurnStatus =
  | 'queued'
  | 'running'
  | 'waiting_tool'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted'

export type VisibleWorkStatus =
  | 'archived'
  | 'waiting_user'
  | 'waiting_approval'
  | 'waiting_tool'
  | 'running'
  | 'queued'
  | 'awaiting_goal_turn'
  | 'usage_limited'
  | 'budget_limited'
  | 'blocked'
  | 'paused'
  | 'failed'
  | 'interrupted'
  | 'cancelled'
  | 'complete'
  | 'completed'
  | 'imported'
  | 'idle'

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
  permissions: SessionPermissionStateDto
  schemaVersion: number
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  workStatus: VisibleWorkStatus
  source?: NativeSessionSourceSummaryDto | null
}

export interface PermissionSettingsDto {
  defaultProfile: PermissionProfile
  updatedAt: string
}

export interface SessionPermissionStateDto {
  defaultProfile: PermissionProfile
  override: PermissionProfile | null
  effectiveProfile: PermissionProfile
  source: 'global' | 'session_override'
}

export interface ImageArtifactRefDto extends JsonObject {
  id: string
  sha256: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  byteLength: number
  width: number | null
  height: number | null
  fileName: string
  source: 'upload' | 'tool_capture'
}

export type NativeImportSourceClient = 'codex_local' | 'claude_desktop' | 'claude_code'
export type CodexNativeOrigin = 'cli' | 'ide_app' | 'exec' | 'subagent' | 'other'
export interface CodexNativeScanFilter {
  origins: Exclude<CodexNativeOrigin, 'subagent'>[]
  includeSubagents: boolean
  includeArchived: boolean
}

export interface NativeSessionSourceSummaryDto {
  provider: CanonicalProvider
  sourceClient: NativeImportSourceClient
  sourceAlias: string | null
  titleSource?: string | null
  projectAlias: string | null
  cwd?: string | null
}

export type NativeImportCandidateStatus =
  | 'new'
  | 'existing'
  | 'update_available'
  | 'duplicate'
  | 'unavailable'
  | 'unsupported'

export interface NativeImportCandidateDto {
  id: string
  sourceClient: NativeImportSourceClient
  provider: CanonicalProvider
  status: NativeImportCandidateStatus
  sourceAlias: string | null
  aliasSource: 'native' | 'generated' | 'first_user' | 'path_fallback'
  titleSource?: string | null
  projectAlias: string | null
  createdAt: string | null
  updatedAt: string | null
  nativeOrigin?: CodexNativeOrigin | null
  nativeArchived?: boolean
  messageCount: number
  portableItemCount: number
  skippedItemCount: number
  warningCount: number
  analysisPending: boolean
}

export interface NativeImportPreviewDto {
  token: string
  expiresAt: string
  summary: {
    total: number
    new: number
    existing: number
    updateAvailable: number
    duplicate: number
    unavailable: number
    unsupported: number
    portableItems: number
    skippedItems: number
    analysisPending: boolean
  }
  candidates: NativeImportCandidateDto[]
  warnings: string[]
}

export type NativeImportCommitStatus = 'imported' | 'updated' | 'duplicate' | 'stale' | 'failed'

export interface NativeImportCommitResultDto {
  candidateId: string
  status: NativeImportCommitStatus
  sessionId?: string
  error?: string
}

export interface NativeImportCommitDto {
  summary: {
    total: number
    imported: number
    updated: number
    duplicate: number
    stale: number
    failed: number
  }
  results: NativeImportCommitResultDto[]
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
  goalId: string | null
  goalRevision: number | null
  sequence: number
  provider: CanonicalProvider
  model: string
  effort: string | null
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
  itemsTruncated?: boolean
  bindings: JsonValue[]
  followUps?: CanonicalFollowUpDto[]
  goal?: CanonicalGoalDto | null
}

export type FollowUpDeliveryDto = 'steer_or_queue' | 'next_turn'
export type FollowUpStatusDto =
  | 'queued'
  | 'dispatching'
  | 'consumed'
  | 'cancelled'
  | 'stale_goal'
  | 'delivery_unknown'

export interface CanonicalFollowUpDto {
  id: string
  sessionId: string
  threadId: string
  clientRequestId: string
  requestHash: string
  sequence: number
  afterTurnSequence: number
  delivery: FollowUpDeliveryDto
  status: FollowUpStatusDto
  targetTurnId: string | null
  consumedTurnId: string | null
  consumedItemIds: string[]
  scope: { kind: 'conversation' } | { kind: 'goal'; goalId: string; revision: number }
  input: Array<{
    kind: 'user_message'
    visibility?: 'portable'
    payload: JsonObject
  }>
  dispatchOwner: string | null
  leaseExpiresAt: string | null
  revision: number
  createdAt: string
  updatedAt: string
  consumedAt: string | null
}

export interface CanonicalGoalDto {
  id: string
  threadId: string
  objective: string
  status: 'active' | 'paused' | 'blocked' | 'usage_limited' | 'budget_limited' | 'complete'
  statusReason: {
    code: string
    source: 'user' | 'host' | 'provider' | 'model'
    message: string | null
    at: string
  } | null
  revision: number
  provider: CanonicalProvider
  model: string
  effort: string | null
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  maxAutomaticTurns: number
  automaticTurnsUsed: number
  maxActiveSeconds: number
  noProgressCount: number
  lastProgressDigest: string | null
  createdAt: string
  updatedAt: string
  startedAt: string
  completedAt: string | null
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
  | 'workspace_changed'
  | 'host_capability_changed'
  | 'goal_changed'

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

export interface FirstTurnDto {
  clientRequestId: string
  cwd: string | null
  instructionSnapshot?: JsonObject
  provider: CanonicalProvider
  model: string
  effort?: string | null
  input: Array<{
    kind: 'user_message'
    visibility: 'portable'
    payload: JsonObject
  }>
}

export interface FirstTurnResultDto {
  session: CanonicalSessionDto
  thread: CanonicalThreadDto
  turn: CanonicalTurnDto
  execution: {
    id: string
    status: string
  }
  initialItems: CanonicalItemDto[]
  duplicate: boolean
}

export type NativeFolderPickResultDto =
  | { status: 'selected'; cwd: string }
  | { status: 'cancelled' }

export interface StartTurnDto {
  provider: CanonicalProvider
  model: string
  effort?: string | null
  clientRequestId: string
  expectedRevision: number
  input: Array<{
    kind: 'user_message'
    visibility: 'portable'
    payload: JsonObject
  }>
}

export interface EnqueueFollowUpDto {
  clientRequestId: string
  expectedTurnId: string
  delivery: FollowUpDeliveryDto
  input: Array<{
    kind: 'user_message'
    visibility: 'portable'
    payload: JsonObject
  }>
}

export interface CreateGoalDto {
  expected: { kind: 'none' } | { kind: 'goal'; goalId: string; revision: number }
  objective: string
  provider: CanonicalProvider
  model: string
  effort?: string | null
  tokenBudget?: number | null
  maxAutomaticTurns?: number
  maxActiveSeconds?: number
  replaceExisting?: boolean
}

export interface EditGoalDto {
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

export type UnknownMutationResolution = 'succeeded' | 'failed' | 'unknown_acknowledged'

export interface ReconcileUnknownMutationDto {
  callId: string
  resolution: UnknownMutationResolution
  note?: string
}

export interface ReconcileUnknownMutationResultDto {
  item: CanonicalItemDto
  duplicate: boolean
}

export interface ProviderModelDescriptorDto {
  id: string
  displayName: string
  description: string
  effortLevels: string[]
  defaultEffort: string | null
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
