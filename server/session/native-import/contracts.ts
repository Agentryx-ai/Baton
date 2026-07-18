import type { CanonicalProvider, NewCanonicalItem } from '../domain.ts'

export type NativeSourceClient = 'codex_desktop' | 'claude_desktop' | 'claude_code'
export type NativeImportCandidateStatus = 'new' | 'update_available' | 'duplicate'

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
  sourceHead: NativeSourceHead
  contentDigest: string
  /** Prefix digest at portableItemCount, used as the append-only record cursor. */
  prefixDigest: string
  /** Present even for metadata-only scans; never infer this count from records. */
  portableItemCount: number
  /** Reader-private opaque locator. It must never cross the HTTP/UI boundary. */
  sourceLocator?: { path: string }
  /** Empty during metadata-only scans and populated only by materialize(). */
  records: NativePortableRecord[]
  skippedItemCount: number
  parserVersion: string
  warnings: string[]
  identityKeys: NativeIdentityKey[]
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
  getNativeImportSigningKey(): Buffer
  beginNativeImportCommit(tokenNonceHmac: string, principalKey: string, requestDigest: string, allowCreate?: boolean): NativeImportCommitState
  recordNativeImportCommitResult(checkpoint: NativeImportCommitCheckpoint, result: NativeImportCommitResult): void
  finishNativeImportCommit(tokenNonceHmac: string, receipt: NativeImportReceipt): void
}
