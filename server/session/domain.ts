import { randomBytes } from 'node:crypto'

export type CanonicalProvider = 'claude' | 'codex' | 'gemini'
export type PermissionProfile = 'read_only' | 'workspace' | 'full_access'
export type PermissionProfileSource = 'global' | 'session_override'
export type SessionId = string
export type ThreadId = string
export type TurnId = string
export type ItemId = string
export type ExecutionId = string
export type GoalId = string
export type FollowUpId = string
export type ContextCompactionJobId = string
export type ContextCompactionId = string
export type ExecutionContextManifestId = string

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

export type GoalStatus =
  | 'active'
  | 'verifying'
  | 'paused'
  | 'blocked'
  | 'usage_limited'
  | 'budget_limited'
  | 'complete'

export type GoalReasonSource = 'user' | 'host' | 'provider' | 'model'

export interface GoalStatusReason {
  code: string
  source: GoalReasonSource
  message: string | null
  at: string
}

export interface CanonicalGoal {
  id: GoalId
  threadId: ThreadId
  objective: string
  status: GoalStatus
  statusReason: GoalStatusReason | null
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
  verificationProposalId: string | null
  latestCompletionReceiptId: string | null
  latestStopReceiptId: string | null
}

export type GoalEvidenceKind = 'tool_result' | 'current_turn'

export interface GoalEvidenceReference {
  kind: GoalEvidenceKind
  reference: string | null
  claim: string
}

export interface GoalRequirementClaim {
  id: string
  requirement: string
  evidence: GoalEvidenceReference[]
}

export interface GoalFrozenEvidence {
  id: string
  kind: GoalEvidenceKind
  reference: string
  claim: string
  authoritative: boolean
  payload: Record<string, unknown>
}

export interface GoalEvidenceBundle {
  goalId: GoalId
  goalRevision: number
  objective: string
  proposalSummary: string
  requirements: GoalRequirementClaim[]
  evidence: GoalFrozenEvidence[]
  terminalTurn: {
    id: TurnId
    status: 'completed'
    provider: CanonicalProvider
    model: string
  }
  omissions: string[]
  hash: string
}

export type GoalVerificationOutcome = 'complete' | 'incomplete' | 'impossible' | 'indeterminate'
export type GoalRequirementVerificationResult = 'satisfied' | 'unsatisfied' | 'unproven' | 'impossible'

export interface GoalVerificationRequirement {
  requirementId: string
  result: GoalRequirementVerificationResult
  evidenceIds: string[]
  reason: string
}

export interface GoalVerificationDecision {
  outcome: GoalVerificationOutcome
  reason: string
  requirements: GoalVerificationRequirement[]
  missingEvidence: string[]
  impossibleEvidenceIds: string[]
}

export interface GoalCompletionProposal {
  id: string
  goalId: GoalId
  goalRevision: number
  turnId: TurnId
  summary: string
  requirements: GoalRequirementClaim[]
  evidenceBundle: GoalEvidenceBundle
  status: 'verifying' | 'accepted' | 'rejected' | 'ineligible'
  createdAt: string
  resolvedAt: string | null
}

export interface GoalVerificationAttempt {
  id: string
  proposalId: string
  goalId: GoalId
  goalRevision: number
  evaluatorProvider: CanonicalProvider
  evaluatorModel: string
  evidenceBundleHash: string
  outcome: GoalVerificationOutcome
  decision: GoalVerificationDecision
  usage: Record<string, unknown> | null
  startedAt: string
  completedAt: string
}

export interface GoalCompletionReceipt {
  id: string
  goalId: GoalId
  goalRevision: number
  proposalId: string
  verificationAttemptId: string
  evidenceBundleHash: string
  hostChecks: string[]
  acceptedAt: string
  acceptancePolicyVersion: string
}

export interface GoalStopReceipt {
  id: string
  goalId: GoalId
  goalRevision: number
  verificationAttemptId: string
  kind: 'confirmed_impossible'
  reason: string
  evidenceBundleHash: string
  decidedAt: string
  resumable: boolean
}

export interface GoalVerificationHistory {
  proposals: GoalCompletionProposal[]
  attempts: GoalVerificationAttempt[]
  receipts: GoalCompletionReceipt[]
  stopReceipts: GoalStopReceipt[]
}

export type GoalObservation =
  | { kind: 'none' }
  | { kind: 'goal'; goalId: GoalId; revision: number }

export interface GoalSchedulerLease {
  leaseId: string
  goalId: GoalId
  goalRevision: number
  ownerId: string
  acquiredAt: string
  heartbeatAt: string
  expiresAt: string
}

export interface GoalVerifierLease {
  leaseId: string
  proposalId: string
  goalId: GoalId
  goalRevision: number
  ownerId: string
  acquiredAt: string
  heartbeatAt: string
  expiresAt: string
}

export type VisibleWorkStatus =
  | 'archived'
  | 'waiting_user'
  | 'waiting_approval'
  | 'waiting_tool'
  | 'running'
  | 'queued'
  | 'awaiting_goal_turn'
  | 'verifying'
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

export interface AgentLoopLimits {
  maxModelRoundTrips: number | null
  maxToolCalls: number | null
  maxIdenticalToolCalls: number | null
  toolTimeoutMs: number
  toolOutputBytes: number
  turnTimeoutMs: number | null
  maxProviderRetries: number
}

export const DEFAULT_AGENT_LOOP_LIMITS: Readonly<AgentLoopLimits> = Object.freeze({
  // Codex runs until it reaches a terminal response, and Claude Agent SDK's
  // maxTurns default is undefined. Provider-independent loop ceilings are
  // therefore opt-in rather than Baton-only defaults.
  maxModelRoundTrips: null,
  maxToolCalls: null,
  maxIdenticalToolCalls: null,
  toolTimeoutMs: 120_000,
  toolOutputBytes: 256 * 1_024,
  turnTimeoutMs: null,
  maxProviderRetries: 3,
})

export type AgentToolSideEffect = 'read_only' | 'workspace_mutation' | 'workspace_command' | 'host_mutation' | 'goal'

export interface AgentToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  sideEffect: AgentToolSideEffect
}

export interface AgentToolInvocation {
  callId: string
  providerCallId: string
  name: string
  input: Record<string, unknown>
}

export type AgentToolResult =
  | {
      success: true
      content: Record<string, unknown>
      /** Immutable local images returned to the current provider without embedding bytes in canonical JSON. */
      images?: import('./image-artifacts.ts').ImageArtifactRef[]
      metadata?: Record<string, unknown>
      error: null
    }
  | {
      success: false
      content: null
      metadata?: Record<string, unknown>
      error: { code: string; message: string; retryable: boolean }
    }

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
  permissions: SessionPermissionState
  schemaVersion: number
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  /** Derived display state; it does not own or mutate execution state. */
  workStatus: VisibleWorkStatus
  source?: {
    provider: CanonicalProvider
    sourceClient: 'codex_local' | 'claude_desktop' | 'claude_code'
    sourceAlias: string | null
    titleSource: string | null
    projectAlias: string | null
    /** Native metadata only. It is never an authorized tool root until the user connects it. */
    cwd: string | null
  } | null
}

export interface GlobalPermissionSettings {
  defaultProfile: PermissionProfile
  updatedAt: string
}

export interface SessionPermissionState {
  defaultProfile: PermissionProfile
  override: PermissionProfile | null
  effectiveProfile: PermissionProfile
  source: PermissionProfileSource
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
  /** Captured Goal identity at turn start; null for turns outside an active Goal. */
  goalId: GoalId | null
  goalRevision: number | null
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

export type ContextCompactionJobStatus = 'queued' | 'running' | 'completed' | 'failed'

/** Durable work receipt for producing a derived summary. Canonical items are never replaced. */
export interface ContextCompactionJob {
  id: ContextCompactionJobId
  threadId: ThreadId
  /** Provider/budget contract for this independent derived-context branch. */
  viewKey: string
  requestKey: string
  requestHash: string
  sourceItemIds: ItemId[]
  sourceHash: string
  summaryInputHash: string
  /** Artifact frontier observed by the caller; null means no prior artifact existed. */
  expectedPreviousArtifactId: ContextCompactionId | null
  status: ContextCompactionJobStatus
  revision: number
  leaseOwner: string | null
  leaseExpiresAt: string | null
  attemptCount: number
  artifactId: ContextCompactionId | null
  error: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface ContextCompactionSourceItem {
  ordinal: number
  itemId: ItemId
  itemSequence: number
  itemDigest: string
}

/** Immutable derived context artifact; it is provenance, never canonical conversation history. */
export interface ContextCompactionArtifact {
  id: ContextCompactionId
  jobId: ContextCompactionJobId
  threadId: ThreadId
  viewKey: string
  sourceHash: string
  summaryInputHash: string
  artifactHash: string
  summary: Record<string, unknown>
  generatorProvider: CanonicalProvider
  generatorModel: string
  generatorVersion: string
  sourceItems: ContextCompactionSourceItem[]
  createdAt: string
}

export type ExecutionContextManifestEntry =
  | { ordinal: number; kind: 'canonical_item'; itemId: ItemId; digest: string }
  | { ordinal: number; kind: 'compaction'; compactionId: ContextCompactionId; digest: string }

/** Immutable replay/audit receipt for the exact provider-neutral context selected for an execution. */
export interface ExecutionContextManifest {
  id: ExecutionContextManifestId
  executionId: ExecutionId
  threadId: ThreadId
  materializerVersion: string
  materializedContextHash: string
  manifestHash: string
  entries: ExecutionContextManifestEntry[]
  createdAt: string
}

export type ExecutionContextSourceRef =
  | { kind: 'canonical_item'; itemId: ItemId }
  | { kind: 'compaction'; compactionId: ContextCompactionId }

export interface CreateContextCompactionJobInput {
  threadId: ThreadId
  /** Omitted only by legacy low-level callers; new runtime paths must provide it. */
  viewKey?: string
  /** Stable caller-generated idempotency key for this exact compaction request. */
  requestKey: string
  /** Exact canonical prefix, in lineage order, covered by the derived summary. */
  sourceItemIds: ItemId[]
  /** Digest of the visibility-filtered generator input, distinct from the full canonical source hash. */
  summaryInputHash: string
  /** Compare-and-set frontier. The job is accepted only while this remains the latest artifact. */
  expectedPreviousArtifactId: ContextCompactionId | null
}

export interface ClaimContextCompactionJobInput {
  jobId: ContextCompactionJobId
  ownerId: string
  leaseDurationMs?: number
}

/** Creates/reclaims and leases one exact compaction request in a single durable transaction. */
export interface ReserveContextCompactionJobInput extends CreateContextCompactionJobInput {
  ownerId: string
  leaseDurationMs?: number
}

export interface CompleteContextCompactionJobInput {
  jobId: ContextCompactionJobId
  ownerId: string
  summary: Record<string, unknown>
  generatorProvider: CanonicalProvider
  generatorModel: string
  generatorVersion: string
}

export interface FailContextCompactionJobInput {
  jobId: ContextCompactionJobId
  ownerId: string
  error: Record<string, unknown>
}

export interface CreateExecutionContextManifestInput {
  executionId: ExecutionId
  threadId: ThreadId
  materializerVersion: string
  /** Hash of the exact provider-neutral context body produced by the materializer. */
  materializedContextHash: string
  /** Either every canonical lineage item, or one prefix compaction followed by its exact uncovered suffix. */
  sources: ExecutionContextSourceRef[]
}

export type FollowUpDelivery = 'steer_or_queue' | 'next_turn'
export type FollowUpStatus = 'queued' | 'dispatching' | 'consumed' | 'cancelled' | 'stale_goal' | 'delivery_unknown'
export type FollowUpScope =
  | { kind: 'conversation' }
  | { kind: 'goal'; goalId: GoalId; revision: number }

/** Baton-owned user intent awaiting deterministic delivery to a canonical turn. */
export interface CanonicalFollowUp {
  id: FollowUpId
  sessionId: SessionId
  threadId: ThreadId
  clientRequestId: string
  requestHash: string
  sequence: number
  /** Greatest canonical turn sequence that existed when this intent was enqueued. */
  afterTurnSequence: number
  delivery: FollowUpDelivery
  status: FollowUpStatus
  targetTurnId: TurnId | null
  consumedTurnId: TurnId | null
  consumedItemIds: ItemId[]
  scope: FollowUpScope
  input: NewCanonicalItem[]
  dispatchOwner: string | null
  leaseExpiresAt: string | null
  revision: number
  createdAt: string
  updatedAt: string
  consumedAt: string | null
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
  | 'follow_up_changed'
  | 'workspace_changed'
  | 'host_capability_changed'
  | 'goal_changed'

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
  delegationMode: 'disabled' | 'provider-native' | 'baton-managed'
  allowedTools: string[]
  approvalPolicy: string
  cwd: string | null
  maxDepth: number
  capabilityGrant: string | null
  permissionProfile?: PermissionProfile
  permissionProfileSource?: PermissionProfileSource
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
  /** Durable pending/delivered user intents; optional for legacy/in-memory stores. */
  followUps?: CanonicalFollowUp[]
  /** Current Baton-owned Goal projection; absent only in legacy/in-memory adapters. */
  goal?: CanonicalGoal | null
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

/** Result of atomically materializing a draft conversation and its first turn. */
export interface BeginSessionResult extends BeginTurnResult {
  session: CanonicalSession
  thread: CanonicalThread
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
