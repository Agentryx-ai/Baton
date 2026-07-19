import type { CanonicalProvider, NewCanonicalItem } from '../domain.ts'

export type NativeSourceClient = 'codex_local' | 'claude_desktop' | 'claude_code'
export type NativeImportCandidateStatus = 'new' | 'existing' | 'update_available' | 'duplicate'
export type CodexNativeOrigin = 'cli' | 'ide_app' | 'exec' | 'subagent' | 'other'

export interface CodexNativeScanFilter {
  origins?: Exclude<CodexNativeOrigin, 'subagent'>[]
  includeSubagents?: boolean
  includeArchived?: boolean
}

export interface NativeSourceIdentity {
  sourceClient: NativeSourceClient
  provider: Extract<CanonicalProvider, 'codex' | 'claude'>
  namespaceKey: string
  nativeSessionId: string
  identityKeys?: NativeIdentityKey[]
}

export interface NativeIdentityKey {
  kind: 'native_session_id' | 'cli_session_id'
  value: string
  /** Pseudonymous scope in which this identity is stable. */
  scopeNamespaceKey?: string
}

export type NativeSourceWarningStatus = 'unavailable' | 'unsupported' | 'corrupt'

export interface NativeSourceWarning {
  sourceClient: NativeSourceClient
  status: NativeSourceWarningStatus
  code: string
  message: string
  count?: number
}

export interface NativeSourceHead {
  size: number
  mtimeMs: number
  finalRecordDigest: string
}

export interface NativePortableRecord {
  key: string
  ordinal: number
  digest: string
  prefixDigest: string
  item: NewCanonicalItem
  createdAt: string | null
}

export interface NativeGoalSnapshot {
  objective: string
  model: string
  effort: string | null
  detectedAt: string | null
  evidence: 'slash_command' | 'claude_goal_status' | 'claude_goal_confirmation' | 'codex_goal_tool'
}

export interface NativeSessionCandidate extends NativeSourceIdentity {
  candidateId: string
  sourceAlias: string
  aliasSource: 'native' | 'generated' | 'first_user' | 'path_fallback'
  /** Native provenance such as custom-title, ai-title, agent-name, or metadata:user. */
  titleSource?: string | null
  projectAlias: string | null
  /** Stable pseudonym used for grouping without exposing the raw cwd. */
  projectGroupKey: string | null
  cwd: string | null
  createdAt: string | null
  updatedAt: string | null
  nativeOrigin?: CodexNativeOrigin
  nativeArchived?: boolean
  sourceHead: NativeSourceHead
  contentDigest: string
  /** Prefix digest at portableItemCount, used as the append-only record cursor. */
  prefixDigest: string
  /** Zero during inventory scans and populated only after materialization. */
  portableItemCount: number
  /** Reader-private opaque locator. It must never cross the HTTP/UI boundary. */
  sourceLocator?: { path: string }
  /** Empty during metadata-only scans and populated only by materialize(). */
  records: NativePortableRecord[]
  /** Last explicitly unresolved native Goal, populated only during materialization. */
  goal?: NativeGoalSnapshot | null
  skippedItemCount: number
  parserVersion: string
  warnings: string[]
  identityKeys: NativeIdentityKey[]
  /** False for the lightweight inventory; true only after the transcript was parsed. */
  materialized: boolean
}

export interface NativeImportStoredState {
  sourceId: string
  sessionId: string
  contentDigest: string
  prefixDigest: string
  lastRecordOrdinal: number
  lastRecordDigest: string
  importedItemSequence: number
}

export interface NativeImportPreviewCandidate extends Omit<NativeSessionCandidate, 'records' | 'sourceLocator'> {
  status: NativeImportCandidateStatus
}

export interface NativeImportPreviewRequest {
  sources?: NativeSourceClient[]
  codex?: CodexNativeScanFilter
}

export interface NativeImportPreview {
  token: string
  expiresAt: string
  candidates: NativeImportPreviewCandidate[]
  warnings: string[]
}

export interface NativeImportCommitRequest {
  token: string
  candidateIds: string[]
}

export type NativeImportCommitStatus = 'imported' | 'updated' | 'duplicate' | 'stale' | 'failed'

export interface NativeImportCommitResult {
  candidateId: string
  status: NativeImportCommitStatus
  sessionId?: string
  importedItemCount?: number
  error?: string
}

export type NativeGoalReconcileStatus =
  | 'would_restore'
  | 'restored'
  | 'no_import'
  | 'no_goal'
  | 'existing_goal'
  | 'source_update_required'
  | 'invalid_goal'

export interface NativeGoalReconcileResult {
  candidateId: string
  status: NativeGoalReconcileStatus
  sessionId?: string
  threadId?: string
  goalId?: string
  error?: string
}

export interface NativeImportReceipt {
  results: NativeImportCommitResult[]
}

export interface NativeSourceReader {
  readonly sourceClient: NativeSourceClient
  /** All candidate kinds emitted by a composite reader. */
  readonly sourceClients?: readonly NativeSourceClient[]
  /** Replaced for every scan. Consumers must read it after scan settles. */
  readonly lastScanWarnings?: readonly NativeSourceWarning[]
  /** True when scan returned a truncated inventory and the preview must not be tokenized. */
  readonly inventoryOverflow?: boolean
  /** Best known total or omitted count associated with inventoryOverflow. */
  readonly overflowCount?: number
  scan(options?: NativeSourceScanOptions): Promise<NativeSessionCandidate[]>
  materialize(candidate: NativeSessionCandidate): Promise<NativeSessionCandidate>
}

export interface NativeSourceScanOptions {
  includeRecords?: boolean
  codex?: CodexNativeScanFilter
  /** Limits composite readers to source kinds requested by the preview. */
  sources?: NativeSourceClient[]
}

export interface CommitNativeImportInput {
  candidate: NativeSessionCandidate
  previewedState: NativeImportStoredState | null
  commitCheckpoint?: NativeImportCommitCheckpoint
}

export interface NativeImportCommitCheckpoint {
  tokenNonceHmac: string
  principalKey: string
  requestDigest: string
  candidateOrdinal: number
}

export interface NativeImportCommitState {
  status: 'applying' | 'completed'
  receipt: NativeImportReceipt
}

export interface NativeImportStore {
  getNativeImportState(identity: NativeSourceIdentity): NativeImportStoredState | null
  commitNativeImport(input: CommitNativeImportInput): NativeImportCommitResult
  reconcileNativeGoal(candidate: NativeSessionCandidate, apply?: boolean): NativeGoalReconcileResult
  getNativeImportSigningKey(): Buffer
  beginNativeImportCommit(tokenNonceHmac: string, principalKey: string, requestDigest: string, allowCreate?: boolean): NativeImportCommitState
  recordNativeImportCommitResult(checkpoint: NativeImportCommitCheckpoint, result: NativeImportCommitResult): void
  finishNativeImportCommit(tokenNonceHmac: string, receipt: NativeImportReceipt): void
}
