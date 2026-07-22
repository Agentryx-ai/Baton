import { createHash, createHmac, randomBytes } from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

import type {
  AppendEventInput,
  BeginSessionResult,
  BeginTurnResult,
  CanonicalFollowUp,
  CanonicalExecution,
  CanonicalGoal,
  GoalCompletionProposal,
  GoalCompletionReceipt,
  GoalEvidenceBundle,
  GoalRequirementClaim,
  GoalVerificationAttempt,
  GoalVerificationDecision,
  GoalVerificationHistory,
  GoalStopReceipt,
  GoalVerifierLease,
  CanonicalItem,
  CanonicalItemKind,
  CanonicalProvider,
  CanonicalSession,
  CanonicalStreamEvent,
  CanonicalStreamEventType,
  CanonicalThread,
  CanonicalTurn,
  ClaimContextCompactionJobInput,
  CompleteContextCompactionJobInput,
  ContextCompactionArtifact,
  ContextCompactionJob,
  ContextCompactionSourceItem,
  CreateContextCompactionJobInput,
  CreateExecutionContextManifestInput,
  CreateSessionInput,
  ExecutionContextManifest,
  ExecutionContextManifestEntry,
  ExecutionPolicySnapshot,
  FailContextCompactionJobInput,
  FinishTurnInput,
  GlobalPermissionSettings,
  GoalSchedulerLease,
  GoalId,
  GoalStatus,
  GoalStatusReason,
  NewCanonicalItem,
  PermissionProfile,
  ProviderBinding,
  ProviderCapabilities,
  ReserveContextCompactionJobInput,
  SessionId,
  ThreadId,
  ThreadSnapshot,
  TurnId,
  UpsertProviderBindingInput,
} from './domain.ts'
import { uuidV7 } from './domain.ts'
import { hasSafeContextToolState } from './context-materializer.js'
import { LEGACY_CONTEXT_VIEW_KEY } from './context-view-contract.js'
import { goalEvidenceHash } from './goal-evidence.ts'
import { latestNativeContextCheckpoint } from './native-context-checkpoint.js'
import type {
  ClaimGoalLeaseInput,
  ClaimGoalVerifierLeaseInput,
  ClaimFollowUpInput,
  BeginSessionInput,
  BeginGoalVerificationInput,
  BeginTurnFromFollowUpInput,
  CloseFollowUpWindowResult,
  CheckpointGoalTurnInput,
  ClearGoalInput,
  CreateGoalInput,
  ConsumeFollowUpInput,
  ConsumeFollowUpResult,
  EditGoalInput,
  EnqueueFollowUpInput,
  EnqueueFollowUpResult,
  ForkThreadInput,
  FinishGoalVerificationInput,
  FinishGoalVerificationResult,
  GoalCasResult,
  GoalAwareBeginTurnInput,
  GoalEvent,
  HeartbeatGoalLeaseInput,
  HeartbeatGoalVerifierLeaseInput,
  InitialSessionRequestIdentity,
  RecordGoalTurnInput,
  ReconcileToolInput,
  ReconcileToolResult,
  RequeueFollowUpInput,
  ReleaseGoalLeaseInput,
  ReleaseGoalVerifierLeaseInput,
  SessionListScope,
  SessionStore,
  UpdateWorkspaceInput,
  UpdateSessionPermissionProfileInput,
  UpdateGoalStatusInput,
} from './store.ts'
import { FollowUpStoreError, GoalStoreError, SessionStoreError } from './store.ts'
import type {
  CommitNativeImportInput,
  NativeImportCommitCheckpoint,
  NativeImportCommitResult,
  NativeImportCommitState,
  NativeImportReceipt,
  NativeGoalReconcileResult,
  NativeImportStoredState,
  NativeSessionCandidate,
  NativeSourceClient,
  NativeSourceIdentity,
} from './native-import/contracts.ts'

const SCHEMA_VERSION = 21
const DEFAULT_PERMISSION_PROFILE: PermissionProfile = 'workspace'
const DEFAULT_GOAL_TURNS = 24
const DEFAULT_GOAL_ACTIVE_SECONDS = 2 * 60 * 60
const DEFAULT_GOAL_LEASE_MS = 30_000
const DEFAULT_GOAL_VERIFIER_LEASE_MS = 45_000
const DEFAULT_FOLLOW_UP_LEASE_MS = 30_000
const ACTIVE_TURN_STATUSES = new Set(['queued', 'running', 'waiting_tool'])
const TERMINAL_TURN_STATUSES = new Set(['completed', 'cancelled', 'failed', 'interrupted'])

type SqlRow = Record<string, string | number | bigint | null | Uint8Array>

export interface SqliteSessionStoreOptions {
  now?: () => string
  idFactory?: () => string
}

interface LineageSegment {
  thread: CanonicalThread
  maximumItemSequence: number | null
}

function nativeCheckpointRepresentedIds(
  lineage: readonly CanonicalItem[],
  canonicalIds: readonly string[],
  provider: CanonicalProvider,
): Set<string> {
  const firstCanonicalId = canonicalIds[0]
  if (!firstCanonicalId) return new Set()
  const checkpoint = latestNativeContextCheckpoint(lineage, provider)
  if (checkpoint?.item.id !== firstCanonicalId) return new Set()
  const checkpointIndex = lineage.findIndex((item) => item.id === firstCanonicalId)
  return new Set(lineage.slice(0, checkpointIndex).map((item) => item.id))
}

function canonicalJson(value: unknown): string {
  const visit = (current: unknown): unknown => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError('Canonical JSON rejects non-finite numbers')
      return Object.is(current, -0) ? 0 : current
    }
    if (Array.isArray(current)) return current.map(visit)
    if (typeof current === 'object') {
      if (current instanceof Uint8Array) throw new TypeError('Canonical JSON rejects binary values')
      const result: Record<string, unknown> = {}
      for (const key of Object.keys(current as Record<string, unknown>).sort()) {
        const child = (current as Record<string, unknown>)[key]
        if (child === undefined) throw new TypeError('Canonical JSON rejects undefined values')
        result[key] = visit(child)
      }
      return result
    }
    throw new TypeError(`Canonical JSON rejects ${typeof current} values`)
  }
  return JSON.stringify(visit(value))
}

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function validateSha256(value: string, field: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new ContextPersistenceError('invalid_input', `${field} must be a lowercase SHA-256 digest`)
  }
}

export class ContextPersistenceError extends Error {
  public readonly code:
    | 'not_found'
    | 'invalid_input'
    | 'idempotency_conflict'
    | 'stale_frontier'
    | 'lease_lost'
    | 'integrity_violation'

  constructor(
    code:
      | 'not_found'
      | 'invalid_input'
      | 'idempotency_conflict'
      | 'stale_frontier'
      | 'lease_lost'
      | 'integrity_violation',
    message: string,
  ) {
    super(message)
    this.code = code
    this.name = 'ContextPersistenceError'
  }
}

const SESSION_PREVIEW_CODE_POINTS = 240

function initialSessionPreview(input: NewCanonicalItem[]): string | null {
  const textValue = input.find((item) => item.kind === 'user_message')?.payload.text
  if (typeof textValue !== 'string') return null
  const normalized = textValue.trim().replace(/\s+/gu, ' ')
  if (!normalized) return null
  const points = Array.from(normalized)
  return points.length <= SESSION_PREVIEW_CODE_POINTS
    ? normalized
    : `${points.slice(0, SESSION_PREVIEW_CODE_POINTS - 1).join('')}…`
}

function parseObject(value: string | number | bigint | null | Uint8Array): Record<string, unknown> {
  if (typeof value !== 'string') throw new Error('Corrupt database: expected JSON text')
  const parsed: unknown = JSON.parse(value)
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Corrupt database: expected JSON object')
  }
  return parsed as Record<string, unknown>
}

function parseNullableObject(
  value: string | number | bigint | null | Uint8Array,
): Record<string, unknown> | null {
  return value === null ? null : parseObject(value)
}

function parseArray(value: string | number | bigint | null | Uint8Array): unknown[] {
  if (typeof value !== 'string') throw new Error('Corrupt database: expected JSON text')
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new Error('Corrupt database: expected JSON array')
  return parsed
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(row: SqlRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`Corrupt database: ${key} is not text`)
  return value
}

function nullableText(row: SqlRow, key: string): string | null {
  const value = row[key]
  if (value !== null && typeof value !== 'string') throw new Error(`Corrupt database: ${key} is not text`)
  return value
}

function integer(row: SqlRow, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Corrupt database: ${key} is not a safe integer`)
  }
  return value
}

function sourceClientRank(sourceClient: string): number {
  return sourceClient === 'claude_desktop' || sourceClient === 'codex_local' || sourceClient === 'codex_desktop' ? 2 : 1
}

// v3-v5 databases encode the former public Codex name in CHECK constraints. Keep that storage
// value stable while exposing the accurate codex_local contract at every API boundary.
function databaseSourceClient(sourceClient: NativeSourceClient): string {
  return sourceClient === 'codex_local' ? 'codex_desktop' : sourceClient
}

function publicSourceClient(sourceClient: string): NativeSourceClient {
  if (sourceClient === 'codex_desktop') return 'codex_local'
  if (sourceClient === 'claude_desktop' || sourceClient === 'claude_code') return sourceClient
  throw new Error('Corrupt database: source_client is unsupported')
}

function aliasSourceRank(aliasSource: string): number {
  switch (aliasSource) {
    case 'native': return 4
    case 'first_user': return 3
    case 'path_fallback': return 2
    case 'generated': return 1
    default: return 0
  }
}

export class SqliteSessionStore implements SessionStore {
  readonly #db: DatabaseSync
  readonly #now: () => string
  readonly #idFactory: () => string
  #nativeIdentityKey!: Buffer

  constructor(path: string, options: SqliteSessionStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#idFactory = options.idFactory ?? (() => uuidV7())
    this.#db = new DatabaseSync(path, {
      timeout: 5_000,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    })
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA trusted_schema = OFF;
      PRAGMA busy_timeout = 5000;
    `)
    // WAL + NORMAL keeps the database consistent across crashes and power loss
    // (at most the last commits roll back). FULL forced an fsync per commit,
    // which on a gigabyte-scale store held write locks long enough to starve
    // every reader for the full busy_timeout.
    try {
      this.#migrate()
      this.#nativeIdentityKey = this.#loadNativeIdentityKey()
      // Collapse any WAL accumulated by earlier runs (observed at 178 MB after
      // checkpoint starvation): a huge WAL slows every read and makes later
      // checkpoints stall for seconds.
      this.checkpointWal()
    } catch (error) {
      try {
        this.#db.close()
      } catch {
        // Preserve the schema/opening error that caused fail-closed startup.
      }
      throw error
    }
  }

  #migrate(): void {
    this.#transaction('EXCLUSIVE', () => {
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          applied_at TEXT NOT NULL
        ) STRICT;
      `)
      const rows = this.#all(this.#db.prepare('SELECT version FROM schema_migrations ORDER BY version'))
      const versions = rows.map((row) => integer(row, 'version'))
      if (versions.some((version, index) => version !== index + 1 || version > SCHEMA_VERSION)) {
        throw new Error(`Unsupported or non-contiguous session schema: ${versions.join(',')}`)
      }
      if (versions.length === 0) {
        this.#db.exec(`
          CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            title TEXT,
            preview TEXT,
            active_thread_id TEXT NOT NULL,
            project_key TEXT,
            cwd TEXT,
            schema_version INTEGER NOT NULL,
            next_item_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_item_sequence >= 1),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            archived_at TEXT,
            FOREIGN KEY(active_thread_id) REFERENCES threads(id) ON DELETE RESTRICT
              DEFERRABLE INITIALLY DEFERRED
          ) STRICT;

          CREATE TABLE threads (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
            parent_thread_id TEXT REFERENCES threads(id) ON DELETE RESTRICT,
            fork_turn_id TEXT REFERENCES turns(id) ON DELETE RESTRICT,
            fork_item_id TEXT REFERENCES items(id) ON DELETE RESTRICT,
            revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
            status TEXT NOT NULL CHECK(status IN ('idle','running','blocked','failed','archived')),
            instruction_snapshot_json TEXT NOT NULL CHECK(json_valid(instruction_snapshot_json)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK((parent_thread_id IS NULL AND fork_item_id IS NULL) OR parent_thread_id IS NOT NULL)
          ) STRICT;
          CREATE INDEX threads_session ON threads(session_id, created_at, id);

          CREATE TABLE turns (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
            sequence INTEGER NOT NULL CHECK(sequence >= 1),
            provider TEXT NOT NULL CHECK(provider IN ('claude','codex','gemini')),
            model TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('queued','running','waiting_tool','completed','cancelled','failed','interrupted')),
            client_request_id TEXT NOT NULL,
            request_hash TEXT NOT NULL,
            started_at TEXT,
            completed_at TEXT,
            usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
            error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
            UNIQUE(thread_id, sequence),
            UNIQUE(thread_id, client_request_id)
          ) STRICT;
          CREATE UNIQUE INDEX turns_one_active_per_thread ON turns(thread_id)
            WHERE status IN ('queued','running','waiting_tool');

          CREATE TABLE items (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
            turn_id TEXT REFERENCES turns(id) ON DELETE RESTRICT,
            sequence INTEGER NOT NULL CHECK(sequence >= 1),
            kind TEXT NOT NULL,
            visibility TEXT NOT NULL CHECK(visibility IN ('portable','provider_private','baton_private')),
            payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
            provider TEXT CHECK(provider IS NULL OR provider IN ('claude','codex','gemini')),
            native_id TEXT,
            origin_event_id TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(session_id, sequence)
          ) STRICT;
          CREATE INDEX items_thread_sequence ON items(thread_id, sequence);
          CREATE INDEX items_turn ON items(turn_id, sequence);

          CREATE TABLE provider_events (
            turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE RESTRICT,
            event_id TEXT NOT NULL,
            item_ids_json TEXT NOT NULL CHECK(json_valid(item_ids_json)),
            created_at TEXT NOT NULL,
            PRIMARY KEY(turn_id, event_id)
          ) WITHOUT ROWID, STRICT;

          CREATE TABLE executions (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
            turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id) ON DELETE RESTRICT,
            parent_execution_id TEXT REFERENCES executions(id) ON DELETE RESTRICT,
            spawn_item_id TEXT REFERENCES items(id) ON DELETE RESTRICT,
            kind TEXT NOT NULL CHECK(kind IN ('root_turn','child_turn')),
            provider TEXT NOT NULL CHECK(provider IN ('claude','codex','gemini')),
            model TEXT NOT NULL,
            adapter_version TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('queued','running','waiting','completed','cancelled','failed','interrupted')),
            policy_snapshot_json TEXT NOT NULL CHECK(json_valid(policy_snapshot_json)),
            budget_json TEXT NOT NULL CHECK(json_valid(budget_json)),
            usage_json TEXT NOT NULL CHECK(json_valid(usage_json)),
            lease_expires_at TEXT,
            started_at TEXT,
            completed_at TEXT
          ) STRICT;

          CREATE TABLE provider_bindings (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
            provider TEXT NOT NULL CHECK(provider IN ('claude','codex','gemini')),
            model_family TEXT NOT NULL,
            native_thread_id TEXT,
            native_response_id TEXT,
            opaque_state_encrypted BLOB,
            capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)),
            synced_revision INTEGER NOT NULL CHECK(synced_revision >= 0),
            context_digest TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            invalidated_at TEXT
          ) STRICT;
          CREATE UNIQUE INDEX provider_bindings_active ON provider_bindings(thread_id, provider)
            WHERE invalidated_at IS NULL;

          CREATE TABLE stream_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
            turn_id TEXT REFERENCES turns(id) ON DELETE RESTRICT,
            type TEXT NOT NULL,
            payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX stream_events_thread_sequence ON stream_events(thread_id, sequence);

          CREATE TRIGGER items_no_update BEFORE UPDATE ON items BEGIN
            SELECT RAISE(ABORT, 'canonical items are append-only');
          END;
          CREATE TRIGGER items_no_delete BEFORE DELETE ON items BEGIN
            SELECT RAISE(ABORT, 'canonical items are append-only');
          END;
          CREATE TRIGGER stream_events_no_update BEFORE UPDATE ON stream_events BEGIN
            SELECT RAISE(ABORT, 'canonical events are append-only');
          END;
          CREATE TRIGGER stream_events_no_delete BEFORE DELETE ON stream_events BEGIN
            SELECT RAISE(ABORT, 'canonical events are append-only');
          END;
        `)
        this.#db
          .prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
          .run(1, 'canonical-session-v1', this.#now())
        this.#db.exec('PRAGMA user_version = 1')
      }
      let appliedVersion = versions.length === 0 ? 1 : versions.at(-1) ?? 0
      if (appliedVersion < 2) {
        this.#db.exec('ALTER TABLE turns ADD COLUMN effort TEXT')
        this.#db
          .prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
          .run(2, 'turn-reasoning-effort', this.#now())
        this.#db.exec('PRAGMA user_version = 2')
        appliedVersion = 2
      }
      if (appliedVersion < 3) {
        this.#db.exec(`
          CREATE TABLE native_import_meta (
            key TEXT PRIMARY KEY,
            value BLOB NOT NULL
          ) STRICT;
          CREATE TABLE native_session_sources (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
            source_client TEXT NOT NULL CHECK(source_client IN ('codex_desktop','claude_desktop','claude_code')),
            provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
            namespace_key TEXT NOT NULL,
            native_session_id TEXT NOT NULL,
            source_alias TEXT,
            alias_source TEXT NOT NULL,
            project_alias TEXT,
            cwd TEXT,
            current_content_digest TEXT NOT NULL,
            current_prefix_digest TEXT NOT NULL,
            current_last_record_ordinal INTEGER NOT NULL CHECK(current_last_record_ordinal >= 0),
            current_last_record_digest TEXT NOT NULL,
            imported_item_sequence INTEGER NOT NULL CHECK(imported_item_sequence >= 0),
            first_imported_at TEXT NOT NULL,
            last_imported_at TEXT NOT NULL,
            UNIQUE(source_client, namespace_key, native_session_id)
          ) STRICT;
          CREATE INDEX native_session_sources_session ON native_session_sources(session_id);
          CREATE TABLE native_session_identity_keys (
            source_id TEXT NOT NULL REFERENCES native_session_sources(id) ON DELETE RESTRICT,
            provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
            namespace_key TEXT NOT NULL,
            identity_kind TEXT NOT NULL CHECK(identity_kind IN ('native_session_id','cli_session_id')),
            identity_value_hmac TEXT NOT NULL,
            PRIMARY KEY(provider, namespace_key, identity_kind, identity_value_hmac),
            UNIQUE(source_id, identity_kind)
          ) WITHOUT ROWID, STRICT;
          CREATE TABLE native_session_revisions (
            id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL REFERENCES native_session_sources(id) ON DELETE RESTRICT,
            content_digest TEXT NOT NULL,
            prefix_digest TEXT NOT NULL,
            source_head_json TEXT NOT NULL CHECK(json_valid(source_head_json)),
            parser_version TEXT NOT NULL,
            portable_item_count INTEGER NOT NULL CHECK(portable_item_count >= 0),
            skipped_item_count INTEGER NOT NULL CHECK(skipped_item_count >= 0),
            last_record_ordinal INTEGER NOT NULL CHECK(last_record_ordinal >= 0),
            last_record_digest TEXT NOT NULL,
            imported_at TEXT NOT NULL,
            UNIQUE(source_id, content_digest)
          ) STRICT;
          CREATE TABLE native_imported_records (
            source_id TEXT NOT NULL REFERENCES native_session_sources(id) ON DELETE RESTRICT,
            native_record_key_hmac TEXT NOT NULL,
            item_id TEXT REFERENCES items(id) ON DELETE RESTRICT,
            source_revision_id TEXT NOT NULL REFERENCES native_session_revisions(id) ON DELETE RESTRICT,
            source_ordinal INTEGER NOT NULL CHECK(source_ordinal >= 1),
            normalized_record_digest TEXT NOT NULL,
            imported_at TEXT NOT NULL,
            PRIMARY KEY(source_id, native_record_key_hmac)
          ) WITHOUT ROWID, STRICT;
          CREATE TABLE native_import_commits (
            token_nonce_hmac TEXT PRIMARY KEY,
            principal_key TEXT NOT NULL,
            request_digest TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('applying','completed','failed')),
            receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
            created_at TEXT NOT NULL,
            completed_at TEXT
          ) STRICT;
        `)
        this.#db.prepare('INSERT INTO native_import_meta(key,value) VALUES (?,?)').run('identity_hmac_key', randomBytes(32))
        this.#db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
          .run(3, 'native-session-import', this.#now())
        this.#db.exec('PRAGMA user_version = 3')
        appliedVersion = 3
      }
      if (appliedVersion < 4) {
        this.#db.exec(`
          ALTER TABLE native_session_identity_keys RENAME TO native_session_identity_keys_v3;
          CREATE TABLE native_session_identity_keys (
            source_id TEXT NOT NULL REFERENCES native_session_sources(id) ON DELETE RESTRICT,
            provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
            namespace_key TEXT NOT NULL,
            identity_kind TEXT NOT NULL CHECK(identity_kind IN ('native_session_id','cli_session_id')),
            identity_value_hmac TEXT NOT NULL,
            PRIMARY KEY(provider, namespace_key, identity_kind, identity_value_hmac)
          ) WITHOUT ROWID, STRICT;
          INSERT INTO native_session_identity_keys
            SELECT source_id,provider,namespace_key,identity_kind,identity_value_hmac
            FROM native_session_identity_keys_v3;
          DROP TABLE native_session_identity_keys_v3;
          CREATE INDEX native_session_identity_keys_source ON native_session_identity_keys(source_id);
          CREATE TABLE native_session_source_provenance (
            source_id TEXT NOT NULL REFERENCES native_session_sources(id) ON DELETE RESTRICT,
            source_client TEXT NOT NULL CHECK(source_client IN ('codex_desktop','claude_desktop','claude_code')),
            namespace_key TEXT NOT NULL,
            native_session_id_hmac TEXT NOT NULL,
            source_alias TEXT NOT NULL,
            alias_source TEXT NOT NULL,
            project_alias TEXT,
            discovered_at TEXT NOT NULL,
            PRIMARY KEY(source_id,source_client,namespace_key,native_session_id_hmac,source_alias)
          ) WITHOUT ROWID, STRICT;
        `)
        this.#db.prepare('INSERT OR IGNORE INTO native_import_meta(key,value) VALUES (?,?)')
          .run('token_signing_key', randomBytes(32))
        this.#db.prepare('INSERT OR IGNORE INTO native_import_meta(key,value) VALUES (?,?)')
          .run('namespace_hmac_key', randomBytes(32))
        this.#db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
          .run(4, 'native-import-recovery-and-provenance', this.#now())
        this.#db.exec('PRAGMA user_version = 4')
        appliedVersion = 4
      }
      if (appliedVersion < 5) {
        this.#db.exec('ALTER TABLE native_session_sources ADD COLUMN title_source TEXT')
        this.#db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
          .run(5, 'native-session-title-provenance', this.#now())
        this.#db.exec('PRAGMA user_version = 5')
        appliedVersion = 5
      }
      if (appliedVersion < 6) {
        this.#db.exec(`
          CREATE INDEX sessions_archived_expiry
            ON sessions(archived_at, id) WHERE archived_at IS NOT NULL;
          CREATE TABLE session_purge_context (
            session_id TEXT PRIMARY KEY
          ) STRICT;
          DROP TRIGGER items_no_delete;
          CREATE TRIGGER items_no_delete BEFORE DELETE ON items
          WHEN NOT EXISTS (
            SELECT 1 FROM session_purge_context WHERE session_id = OLD.session_id
          ) BEGIN
            SELECT RAISE(ABORT, 'canonical items are append-only');
          END;
          DROP TRIGGER stream_events_no_delete;
          CREATE TRIGGER stream_events_no_delete BEFORE DELETE ON stream_events
          WHEN NOT EXISTS (
            SELECT 1 FROM session_purge_context WHERE session_id = OLD.session_id
          ) BEGIN
            SELECT RAISE(ABORT, 'canonical events are append-only');
          END;
        `)
        this.#db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
          .run(6, 'session-trash-retention', this.#now())
        this.#db.exec('PRAGMA user_version = 6')
        appliedVersion = 6
      }
      if (appliedVersion < 7) {
        this.#db.exec(`
          ALTER TABLE turns ADD COLUMN goal_id TEXT;
          ALTER TABLE turns ADD COLUMN goal_revision INTEGER;
          CREATE TRIGGER turns_goal_context_insert BEFORE INSERT ON turns
          WHEN (NEW.goal_id IS NULL) != (NEW.goal_revision IS NULL)
            OR NEW.goal_revision < 1
          BEGIN
            SELECT RAISE(ABORT, 'turn goal context must be a complete positive tuple');
          END;
          CREATE TRIGGER turns_goal_context_update BEFORE UPDATE OF goal_id,goal_revision ON turns
          WHEN (NEW.goal_id IS NULL) != (NEW.goal_revision IS NULL)
            OR NEW.goal_revision < 1
          BEGIN
            SELECT RAISE(ABORT, 'turn goal context must be a complete positive tuple');
          END;

          CREATE TABLE goals (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id) ON DELETE RESTRICT,
            objective TEXT NOT NULL CHECK(length(objective) BETWEEN 1 AND 4000),
            status TEXT NOT NULL CHECK(status IN ('active','paused','blocked','usage_limited','budget_limited','complete')),
            status_reason_json TEXT CHECK(status_reason_json IS NULL OR json_valid(status_reason_json)),
            revision INTEGER NOT NULL CHECK(revision >= 1),
            provider TEXT NOT NULL CHECK(provider IN ('claude','codex','gemini')),
            model TEXT NOT NULL CHECK(length(model) >= 1),
            effort TEXT,
            token_budget INTEGER CHECK(token_budget IS NULL OR token_budget >= 1),
            tokens_used INTEGER NOT NULL DEFAULT 0 CHECK(tokens_used >= 0),
            time_used_seconds INTEGER NOT NULL DEFAULT 0 CHECK(time_used_seconds >= 0),
            max_automatic_turns INTEGER NOT NULL CHECK(max_automatic_turns >= 1),
            automatic_turns_used INTEGER NOT NULL DEFAULT 0 CHECK(automatic_turns_used >= 0),
            max_active_seconds INTEGER NOT NULL CHECK(max_active_seconds >= 1),
            no_progress_count INTEGER NOT NULL DEFAULT 0 CHECK(no_progress_count >= 0),
            last_progress_digest TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            started_at TEXT NOT NULL,
            completed_at TEXT
          ) STRICT;
          CREATE INDEX goals_active_scheduler ON goals(status, updated_at, id) WHERE status='active';

          CREATE TABLE goal_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            goal_id TEXT NOT NULL,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
            revision INTEGER NOT NULL CHECK(revision >= 1),
            type TEXT NOT NULL,
            payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX goal_events_thread_sequence ON goal_events(thread_id, sequence);
          CREATE TRIGGER goal_events_no_update BEFORE UPDATE ON goal_events BEGIN
            SELECT RAISE(ABORT, 'goal events are append-only');
          END;
          CREATE TRIGGER goal_events_no_delete BEFORE DELETE ON goal_events
          WHEN NOT EXISTS (
            SELECT 1 FROM session_purge_context WHERE session_id = OLD.session_id
          ) BEGIN
            SELECT RAISE(ABORT, 'goal events are append-only');
          END;

          CREATE TABLE goal_scheduler_leases (
            goal_id TEXT PRIMARY KEY REFERENCES goals(id) ON DELETE CASCADE,
            lease_id TEXT NOT NULL UNIQUE,
            goal_revision INTEGER NOT NULL CHECK(goal_revision >= 1),
            owner_id TEXT NOT NULL CHECK(length(owner_id) >= 1),
            acquired_at TEXT NOT NULL,
            heartbeat_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE goal_turn_accounting (
            turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE RESTRICT,
            goal_id TEXT NOT NULL,
            goal_revision INTEGER NOT NULL CHECK(goal_revision >= 1),
            tokens_used INTEGER NOT NULL CHECK(tokens_used >= 0),
            time_used_seconds INTEGER NOT NULL CHECK(time_used_seconds >= 0),
            automatic INTEGER NOT NULL DEFAULT 0 CHECK(automatic IN (0,1)),
            terminal INTEGER NOT NULL DEFAULT 0 CHECK(terminal IN (0,1)),
            progress_digest TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) WITHOUT ROWID, STRICT;
        `)
        this.#db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
          .run(7, 'persistent-goal-runtime', this.#now())
        this.#db.exec('PRAGMA user_version = 7')
        appliedVersion = 7
      }
      if (appliedVersion < 8) {
        this.#db.exec(`
          ALTER TABLE turns ADD COLUMN follow_up_window TEXT NOT NULL DEFAULT 'accepting'
            CHECK(follow_up_window IN ('accepting','closed'));
          UPDATE turns SET follow_up_window='closed'
            WHERE status IN ('completed','cancelled','failed','interrupted');

          CREATE TABLE follow_ups (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
            client_request_id TEXT NOT NULL,
            request_hash TEXT NOT NULL,
            sequence INTEGER NOT NULL CHECK(sequence >= 1),
            delivery TEXT NOT NULL CHECK(delivery IN ('steer_or_queue','next_turn')),
            status TEXT NOT NULL CHECK(status IN ('queued','dispatching','consumed','cancelled','stale_goal','delivery_unknown')),
            target_turn_id TEXT REFERENCES turns(id) ON DELETE RESTRICT,
            consumed_turn_id TEXT REFERENCES turns(id) ON DELETE RESTRICT,
            consumed_item_ids_json TEXT NOT NULL DEFAULT '[]'
              CHECK(json_valid(consumed_item_ids_json) AND json_type(consumed_item_ids_json)='array'),
            goal_id TEXT,
            goal_revision INTEGER CHECK(goal_revision IS NULL OR goal_revision >= 1),
            input_json TEXT NOT NULL CHECK(json_valid(input_json) AND json_type(input_json)='array'),
            dispatch_owner TEXT,
            lease_expires_at TEXT,
            revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            consumed_at TEXT,
            UNIQUE(thread_id, client_request_id),
            UNIQUE(thread_id, sequence),
            CHECK((goal_id IS NULL) = (goal_revision IS NULL)),
            CHECK(
              (status='dispatching' AND dispatch_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
              OR (status!='dispatching' AND dispatch_owner IS NULL AND lease_expires_at IS NULL)
            ),
            CHECK(
              (status='consumed' AND consumed_turn_id IS NOT NULL AND consumed_at IS NOT NULL
                AND json_array_length(consumed_item_ids_json) > 0)
              OR (status!='consumed' AND consumed_turn_id IS NULL AND consumed_at IS NULL
                AND json_array_length(consumed_item_ids_json) = 0)
            )
          ) STRICT;
          CREATE INDEX follow_ups_thread_state_sequence ON follow_ups(thread_id,status,sequence);
          CREATE INDEX follow_ups_target_state_sequence ON follow_ups(target_turn_id,status,sequence);
          CREATE INDEX follow_ups_expired_dispatch ON follow_ups(lease_expires_at,id)
            WHERE status='dispatching';
        `)
        this.#db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
          .run(8, 'durable-follow-up-queue', this.#now())
        this.#db.exec('PRAGMA user_version = 8')
        appliedVersion = 8
      }
      if (appliedVersion < 9) {
        // Older imports copied native metadata into the authoritative workspace column.
        // Native cwd remains in native_session_sources as a user-visible suggestion only.
        const sessionHasCwd = this.#all(this.#db.prepare('PRAGMA table_info(sessions)'))
          .some((row) => text(row, 'name') === 'cwd')
        const nativeSourcesExist = this.#optional(this.#db.prepare(`
          SELECT name FROM sqlite_schema WHERE type='table' AND name='native_session_sources'
        `)) !== null
        if (sessionHasCwd && nativeSourcesExist) {
          this.#db.exec(`
            UPDATE sessions SET cwd=NULL
            WHERE EXISTS (SELECT 1 FROM native_session_sources ns WHERE ns.session_id=sessions.id);
          `)
        }
        this.#db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
          .run(9, 'verified-session-workspace-authority', this.#now())
        this.#db.exec('PRAGMA user_version = 9')
        appliedVersion = 9
      }
      if (appliedVersion < 10) {
        this.#db.exec(`
          ALTER TABLE follow_ups ADD COLUMN after_turn_sequence INTEGER NOT NULL DEFAULT 0
            CHECK(after_turn_sequence >= 0);
          UPDATE follow_ups SET after_turn_sequence=COALESCE(
            (SELECT t.sequence FROM turns t WHERE t.id=follow_ups.target_turn_id),
            (SELECT MAX(t.sequence) FROM turns t
              WHERE t.thread_id=follow_ups.thread_id
                AND t.started_at IS NOT NULL AND t.started_at<=follow_ups.created_at),
            0
          );
        `)
        this.#db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
          .run(10, 'follow-up-turn-boundary', this.#now())
        this.#db.exec('PRAGMA user_version = 10')
        appliedVersion = 10
      }
      if (appliedVersion < 11) {
        this.#db.exec(`
          DROP INDEX follow_ups_thread_state_sequence;
          DROP INDEX follow_ups_target_state_sequence;
          DROP INDEX follow_ups_expired_dispatch;
          ALTER TABLE follow_ups RENAME TO follow_ups_v10;
          CREATE TABLE follow_ups (
            id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
            client_request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
            sequence INTEGER NOT NULL CHECK(sequence>=1), after_turn_sequence INTEGER NOT NULL CHECK(after_turn_sequence>=0),
            delivery TEXT NOT NULL CHECK(delivery IN ('steer_or_queue','next_turn')),
            status TEXT NOT NULL CHECK(status IN ('queued','dispatching','consumed','cancelled','stale_goal','delivery_unknown')),
            target_turn_id TEXT REFERENCES turns(id) ON DELETE RESTRICT,
            consumed_turn_id TEXT REFERENCES turns(id) ON DELETE RESTRICT,
            consumed_item_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(consumed_item_ids_json) AND json_type(consumed_item_ids_json)='array'),
            goal_id TEXT, goal_revision INTEGER CHECK(goal_revision IS NULL OR goal_revision>=1),
            input_json TEXT NOT NULL CHECK(json_valid(input_json) AND json_type(input_json)='array'),
            dispatch_owner TEXT, lease_expires_at TEXT, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, consumed_at TEXT,
            UNIQUE(thread_id,client_request_id), UNIQUE(thread_id,sequence),
            CHECK((goal_id IS NULL)=(goal_revision IS NULL)),
            CHECK((status='dispatching' AND dispatch_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
              OR (status!='dispatching' AND dispatch_owner IS NULL AND lease_expires_at IS NULL)),
            CHECK((status='consumed' AND consumed_turn_id IS NOT NULL AND consumed_at IS NOT NULL AND json_array_length(consumed_item_ids_json)>0)
              OR (status!='consumed' AND consumed_turn_id IS NULL AND consumed_at IS NULL AND json_array_length(consumed_item_ids_json)=0))
          ) STRICT;
          INSERT INTO follow_ups SELECT * FROM follow_ups_v10;
          DROP TABLE follow_ups_v10;
          CREATE INDEX follow_ups_thread_state_sequence ON follow_ups(thread_id,status,sequence);
          CREATE INDEX follow_ups_target_state_sequence ON follow_ups(target_turn_id,status,sequence);
          CREATE INDEX follow_ups_expired_dispatch ON follow_ups(lease_expires_at,id) WHERE status='dispatching';
        `)
        this.#db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
          .run(11, 'follow-up-delivery-unknown', this.#now())
        this.#db.exec('PRAGMA user_version = 11')
        appliedVersion = 11
      }
      if (appliedVersion < 12) {
        this.#db.exec(`
          ALTER TABLE follow_ups ADD COLUMN dispatch_kind TEXT
            CHECK(dispatch_kind IS NULL OR dispatch_kind IN ('steer','next_turn'));
          UPDATE follow_ups SET dispatch_kind=CASE WHEN target_turn_id IS NULL THEN 'next_turn' ELSE 'steer' END
            WHERE status='dispatching';
        `)
        this.#db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
          .run(12, 'follow-up-dispatch-uncertainty', this.#now())
        this.#db.exec('PRAGMA user_version = 12')
        appliedVersion = 12
      }
      if (appliedVersion < 13) {
        this.#db.exec(`
          CREATE TABLE context_compaction_jobs (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
            request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 200),
            request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
            source_item_ids_json TEXT NOT NULL
              CHECK(json_valid(source_item_ids_json) AND json_type(source_item_ids_json)='array'
                AND json_array_length(source_item_ids_json)>0),
            source_hash TEXT NOT NULL CHECK(length(source_hash)=64),
            summary_input_hash TEXT NOT NULL CHECK(length(summary_input_hash)=64),
            status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
            revision INTEGER NOT NULL CHECK(revision>=1),
            lease_owner TEXT,
            lease_expires_at TEXT,
            attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
            error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT,
            UNIQUE(thread_id,request_key),
            CHECK((status='running')=(lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
            CHECK((status IN ('completed','failed'))=(completed_at IS NOT NULL)),
            CHECK((status='failed')=(error_json IS NOT NULL))
          ) STRICT;
          CREATE INDEX context_compaction_jobs_queue
            ON context_compaction_jobs(status,created_at,id) WHERE status IN ('queued','running');

          CREATE TABLE context_compactions (
            id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL UNIQUE REFERENCES context_compaction_jobs(id) ON DELETE RESTRICT,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
            source_hash TEXT NOT NULL CHECK(length(source_hash)=64),
            summary_input_hash TEXT NOT NULL CHECK(length(summary_input_hash)=64),
            artifact_hash TEXT NOT NULL UNIQUE CHECK(length(artifact_hash)=64),
            summary_json TEXT NOT NULL CHECK(json_valid(summary_json) AND json_type(summary_json)='object'),
            generator_provider TEXT NOT NULL CHECK(generator_provider IN ('claude','codex','gemini')),
            generator_model TEXT NOT NULL CHECK(length(generator_model)>=1),
            generator_version TEXT NOT NULL CHECK(length(generator_version)>=1),
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX context_compactions_thread_created
            ON context_compactions(thread_id,created_at,id);

          CREATE TABLE context_compaction_source_items (
            compaction_id TEXT NOT NULL REFERENCES context_compactions(id) ON DELETE RESTRICT,
            ordinal INTEGER NOT NULL CHECK(ordinal>=0),
            item_id TEXT NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
            item_sequence INTEGER NOT NULL CHECK(item_sequence>=1),
            item_digest TEXT NOT NULL CHECK(length(item_digest)=64),
            PRIMARY KEY(compaction_id,ordinal),
            UNIQUE(compaction_id,item_id)
          ) WITHOUT ROWID, STRICT;

          CREATE TABLE context_compaction_job_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id TEXT NOT NULL REFERENCES context_compaction_jobs(id) ON DELETE RESTRICT,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
            revision INTEGER NOT NULL CHECK(revision>=1),
            status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
            payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json)='object'),
            state_hash TEXT NOT NULL CHECK(length(state_hash)=64),
            previous_event_hash TEXT CHECK(previous_event_hash IS NULL OR length(previous_event_hash)=64),
            event_hash TEXT NOT NULL UNIQUE CHECK(length(event_hash)=64),
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX context_compaction_job_events_job
            ON context_compaction_job_events(job_id,sequence);

          CREATE TABLE execution_context_manifests (
            id TEXT PRIMARY KEY,
            execution_id TEXT NOT NULL UNIQUE REFERENCES executions(id) ON DELETE RESTRICT,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
            materializer_version TEXT NOT NULL CHECK(length(materializer_version)>=1),
            materialized_context_hash TEXT NOT NULL CHECK(length(materialized_context_hash)=64),
            manifest_hash TEXT NOT NULL UNIQUE CHECK(length(manifest_hash)=64),
            created_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE execution_context_manifest_entries (
            manifest_id TEXT NOT NULL REFERENCES execution_context_manifests(id) ON DELETE RESTRICT,
            ordinal INTEGER NOT NULL CHECK(ordinal>=0),
            source_kind TEXT NOT NULL CHECK(source_kind IN ('canonical_item','compaction')),
            item_id TEXT REFERENCES items(id) ON DELETE RESTRICT,
            compaction_id TEXT REFERENCES context_compactions(id) ON DELETE RESTRICT,
            digest TEXT NOT NULL CHECK(length(digest)=64),
            PRIMARY KEY(manifest_id,ordinal),
            CHECK(
              (source_kind='canonical_item' AND item_id IS NOT NULL AND compaction_id IS NULL)
              OR (source_kind='compaction' AND item_id IS NULL AND compaction_id IS NOT NULL)
            )
          ) WITHOUT ROWID, STRICT;

          CREATE TRIGGER context_compaction_jobs_immutable_columns BEFORE UPDATE ON context_compaction_jobs
          WHEN NEW.id IS NOT OLD.id OR NEW.thread_id IS NOT OLD.thread_id
            OR NEW.request_key IS NOT OLD.request_key OR NEW.request_hash IS NOT OLD.request_hash
            OR NEW.source_item_ids_json IS NOT OLD.source_item_ids_json
            OR NEW.source_hash IS NOT OLD.source_hash OR NEW.summary_input_hash IS NOT OLD.summary_input_hash
            OR NEW.created_at IS NOT OLD.created_at
          BEGIN SELECT RAISE(ABORT, 'compaction job identity is immutable'); END;
          CREATE TRIGGER context_compaction_jobs_terminal BEFORE UPDATE ON context_compaction_jobs
          WHEN OLD.status IN ('completed','failed')
          BEGIN SELECT RAISE(ABORT, 'terminal compaction jobs are immutable'); END;
          CREATE TRIGGER context_compaction_jobs_transition BEFORE UPDATE OF status ON context_compaction_jobs
          WHEN NOT (
            (OLD.status='queued' AND NEW.status='running')
            OR (OLD.status='running' AND NEW.status IN ('running','queued','completed','failed'))
          )
          BEGIN SELECT RAISE(ABORT, 'invalid compaction job transition'); END;
          CREATE TRIGGER context_compaction_jobs_no_delete BEFORE DELETE ON context_compaction_jobs
          WHEN NOT EXISTS (
            SELECT 1 FROM threads th JOIN session_purge_context pc ON pc.session_id=th.session_id
            WHERE th.id=OLD.thread_id
          ) BEGIN SELECT RAISE(ABORT, 'compaction jobs are durable'); END;

          CREATE TRIGGER context_compactions_no_update BEFORE UPDATE ON context_compactions
          BEGIN SELECT RAISE(ABORT, 'compaction artifacts are append-only'); END;
          CREATE TRIGGER context_compactions_no_delete BEFORE DELETE ON context_compactions
          WHEN NOT EXISTS (
            SELECT 1 FROM threads th JOIN session_purge_context pc ON pc.session_id=th.session_id
            WHERE th.id=OLD.thread_id
          ) BEGIN SELECT RAISE(ABORT, 'compaction artifacts are append-only'); END;
          CREATE TRIGGER context_compaction_sources_no_update BEFORE UPDATE ON context_compaction_source_items
          BEGIN SELECT RAISE(ABORT, 'compaction provenance is append-only'); END;
          CREATE TRIGGER context_compaction_sources_no_delete BEFORE DELETE ON context_compaction_source_items
          WHEN NOT EXISTS (
            SELECT 1 FROM context_compactions c JOIN threads th ON th.id=c.thread_id
            JOIN session_purge_context pc ON pc.session_id=th.session_id
            WHERE c.id=OLD.compaction_id
          ) BEGIN SELECT RAISE(ABORT, 'compaction provenance is append-only'); END;
          CREATE TRIGGER context_compaction_events_no_update BEFORE UPDATE ON context_compaction_job_events
          BEGIN SELECT RAISE(ABORT, 'compaction events are append-only'); END;
          CREATE TRIGGER context_compaction_events_no_delete BEFORE DELETE ON context_compaction_job_events
          WHEN NOT EXISTS (
            SELECT 1 FROM threads th JOIN session_purge_context pc ON pc.session_id=th.session_id
            WHERE th.id=OLD.thread_id
          ) BEGIN SELECT RAISE(ABORT, 'compaction events are append-only'); END;
          CREATE TRIGGER execution_context_manifests_no_update BEFORE UPDATE ON execution_context_manifests
          BEGIN SELECT RAISE(ABORT, 'execution context manifests are append-only'); END;
          CREATE TRIGGER execution_context_manifests_no_delete BEFORE DELETE ON execution_context_manifests
          WHEN NOT EXISTS (
            SELECT 1 FROM threads th JOIN session_purge_context pc ON pc.session_id=th.session_id
            WHERE th.id=OLD.thread_id
          ) BEGIN SELECT RAISE(ABORT, 'execution context manifests are append-only'); END;
          CREATE TRIGGER execution_context_entries_no_update BEFORE UPDATE ON execution_context_manifest_entries
          BEGIN SELECT RAISE(ABORT, 'execution context provenance is append-only'); END;
          CREATE TRIGGER execution_context_entries_no_delete BEFORE DELETE ON execution_context_manifest_entries
          WHEN NOT EXISTS (
            SELECT 1 FROM execution_context_manifests m JOIN threads th ON th.id=m.thread_id
            JOIN session_purge_context pc ON pc.session_id=th.session_id
            WHERE m.id=OLD.manifest_id
          ) BEGIN SELECT RAISE(ABORT, 'execution context provenance is append-only'); END;
        `)
        this.#db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
          .run(13, 'derived-context-compaction-provenance', this.#now())
        this.#db.exec('PRAGMA user_version = 13')
        appliedVersion = 13
      }
      if (appliedVersion < 14) {
        const derivedRows = integer(this.#one(this.#db.prepare(`
          SELECT
            (SELECT COUNT(*) FROM context_compaction_jobs)
            + (SELECT COUNT(*) FROM context_compactions)
            + (SELECT COUNT(*) FROM context_compaction_source_items)
            + (SELECT COUNT(*) FROM context_compaction_job_events)
            + (SELECT COUNT(*) FROM execution_context_manifests)
            + (SELECT COUNT(*) FROM execution_context_manifest_entries) AS count
        `)), 'count')
        if (derivedRows !== 0) {
          throw new ContextPersistenceError(
            'integrity_violation',
            'Schema v13 contains derived-context rows that require an explicit frontier migration',
          )
        }
        this.#db.exec(`
          DROP TRIGGER context_compaction_jobs_immutable_columns;
          DROP TRIGGER context_compaction_jobs_no_delete;
          DROP TRIGGER context_compactions_no_delete;
          DROP TRIGGER context_compaction_sources_no_delete;
          DROP TRIGGER context_compaction_events_no_delete;
          DROP TRIGGER execution_context_manifests_no_delete;
          DROP TRIGGER execution_context_entries_no_delete;
          DROP TRIGGER context_compaction_jobs_terminal;
          DROP TRIGGER context_compaction_jobs_transition;

          ALTER TABLE context_compaction_jobs ADD COLUMN expected_previous_artifact_id TEXT
            CHECK(expected_previous_artifact_id IS NULL OR length(expected_previous_artifact_id)>=1);
          CREATE UNIQUE INDEX context_compaction_jobs_active_frontier
            ON context_compaction_jobs(thread_id,COALESCE(expected_previous_artifact_id,''))
            WHERE status IN ('queued','running');

          CREATE TABLE context_compaction_heads (
            thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE RESTRICT,
            compaction_id TEXT,
            revision INTEGER NOT NULL CHECK(revision>=0),
            head_hash TEXT NOT NULL CHECK(length(head_hash)=64),
            updated_at TEXT NOT NULL
          ) STRICT;

          CREATE TRIGGER context_compaction_jobs_immutable_columns BEFORE UPDATE ON context_compaction_jobs
          WHEN NEW.id IS NOT OLD.id OR NEW.thread_id IS NOT OLD.thread_id
            OR NEW.request_key IS NOT OLD.request_key OR NEW.request_hash IS NOT OLD.request_hash
            OR NEW.source_item_ids_json IS NOT OLD.source_item_ids_json
            OR NEW.source_hash IS NOT OLD.source_hash OR NEW.summary_input_hash IS NOT OLD.summary_input_hash
            OR NEW.expected_previous_artifact_id IS NOT OLD.expected_previous_artifact_id
            OR NEW.created_at IS NOT OLD.created_at
          BEGIN SELECT RAISE(ABORT, 'compaction job identity is immutable'); END;
          CREATE TRIGGER context_compaction_jobs_no_delete BEFORE DELETE ON context_compaction_jobs
          WHEN NOT EXISTS (
            SELECT 1 FROM threads th JOIN session_purge_context pc ON pc.session_id=th.session_id
            WHERE th.id=OLD.thread_id
          ) BEGIN SELECT RAISE(ABORT, 'compaction jobs are durable'); END;
          CREATE TRIGGER context_compactions_no_delete BEFORE DELETE ON context_compactions
          WHEN NOT EXISTS (
            SELECT 1 FROM threads th JOIN session_purge_context pc ON pc.session_id=th.session_id
            WHERE th.id=OLD.thread_id
          ) BEGIN SELECT RAISE(ABORT, 'compaction artifacts are append-only'); END;
          CREATE TRIGGER context_compaction_sources_no_delete BEFORE DELETE ON context_compaction_source_items
          WHEN NOT EXISTS (
            SELECT 1 FROM context_compactions c JOIN threads th ON th.id=c.thread_id
            JOIN session_purge_context pc ON pc.session_id=th.session_id
            WHERE c.id=OLD.compaction_id
          ) BEGIN SELECT RAISE(ABORT, 'compaction provenance is append-only'); END;
          CREATE TRIGGER context_compaction_events_no_delete BEFORE DELETE ON context_compaction_job_events
          WHEN NOT EXISTS (
            SELECT 1 FROM threads th JOIN session_purge_context pc ON pc.session_id=th.session_id
            WHERE th.id=OLD.thread_id
          ) BEGIN SELECT RAISE(ABORT, 'compaction events are append-only'); END;
          CREATE TRIGGER execution_context_manifests_no_delete BEFORE DELETE ON execution_context_manifests
          WHEN NOT EXISTS (
            SELECT 1 FROM threads th JOIN session_purge_context pc ON pc.session_id=th.session_id
            WHERE th.id=OLD.thread_id
          ) BEGIN SELECT RAISE(ABORT, 'execution context manifests are append-only'); END;
          CREATE TRIGGER execution_context_entries_no_delete BEFORE DELETE ON execution_context_manifest_entries
          WHEN NOT EXISTS (
            SELECT 1 FROM execution_context_manifests m JOIN threads th ON th.id=m.thread_id
            JOIN session_purge_context pc ON pc.session_id=th.session_id
            WHERE m.id=OLD.manifest_id
          ) BEGIN SELECT RAISE(ABORT, 'execution context provenance is append-only'); END;
          CREATE TRIGGER context_compaction_jobs_terminal BEFORE UPDATE ON context_compaction_jobs
          WHEN OLD.status='completed'
          BEGIN SELECT RAISE(ABORT, 'terminal compaction jobs are immutable'); END;
          CREATE TRIGGER context_compaction_jobs_transition BEFORE UPDATE OF status ON context_compaction_jobs
          WHEN NOT (
            (OLD.status='queued' AND NEW.status='running')
            OR (OLD.status='running' AND NEW.status IN ('running','queued','completed','failed'))
            OR (OLD.status='failed' AND NEW.status='queued')
          )
          BEGIN SELECT RAISE(ABORT, 'invalid compaction job transition'); END;
          CREATE TRIGGER context_compaction_heads_transition BEFORE UPDATE ON context_compaction_heads
          WHEN NEW.thread_id IS NOT OLD.thread_id OR NEW.revision<>OLD.revision+1
            OR NEW.compaction_id IS OLD.compaction_id
          BEGIN SELECT RAISE(ABORT, 'invalid compaction head transition'); END;
          CREATE TRIGGER context_compaction_heads_no_delete BEFORE DELETE ON context_compaction_heads
          WHEN NOT EXISTS (
            SELECT 1 FROM threads th JOIN session_purge_context pc ON pc.session_id=th.session_id
            WHERE th.id=OLD.thread_id
          ) BEGIN SELECT RAISE(ABORT, 'compaction head is durable'); END;
        `)
        this.#db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
          .run(14, 'derived-context-frontier-cas', this.#now())
        this.#db.exec('PRAGMA user_version = 14')
        appliedVersion = 14
      }
      if (appliedVersion < 15) {
        this.#db.exec(`
          ALTER TABLE sessions ADD COLUMN ldplayer_grant_json TEXT
            CHECK(ldplayer_grant_json IS NULL OR (
              json_valid(ldplayer_grant_json)
              AND json_type(ldplayer_grant_json)='object'
              AND json_extract(ldplayer_grant_json,'$.kind')='ldplayer'
            ));
        `)
        this.#db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
          .run(15, 'session-ldplayer-capability', this.#now())
        this.#db.exec('PRAGMA user_version = 15')
        appliedVersion = 15
      }
      if (appliedVersion < 16) {
        const legacyHeads = this.#all(this.#db.prepare(`
          SELECT thread_id,compaction_id,revision,updated_at FROM context_compaction_heads
        `))
        this.#db.exec(`
          DROP TRIGGER context_compaction_jobs_immutable_columns;
          DROP TRIGGER context_compaction_jobs_no_delete;
          DROP TRIGGER context_compactions_no_delete;
          DROP TRIGGER context_compaction_sources_no_delete;
          DROP TRIGGER context_compaction_events_no_delete;
          DROP TRIGGER execution_context_manifests_no_delete;
          DROP TRIGGER execution_context_entries_no_delete;
          DROP TRIGGER context_compaction_heads_transition;
          DROP TRIGGER context_compaction_heads_no_delete;
          DROP INDEX context_compaction_jobs_active_frontier;

          ALTER TABLE context_compaction_jobs ADD COLUMN view_key TEXT NOT NULL DEFAULT 'legacy-v15'
            CHECK(length(view_key) BETWEEN 1 AND 120);
          CREATE UNIQUE INDEX context_compaction_jobs_active_frontier
            ON context_compaction_jobs(thread_id,view_key,COALESCE(expected_previous_artifact_id,''))
            WHERE status IN ('queued','running');

          ALTER TABLE context_compaction_heads RENAME TO context_compaction_heads_v15;
          CREATE TABLE context_compaction_heads (
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
            view_key TEXT NOT NULL CHECK(length(view_key) BETWEEN 1 AND 120),
            compaction_id TEXT,
            revision INTEGER NOT NULL CHECK(revision>=0),
            head_hash TEXT NOT NULL CHECK(length(head_hash)=64),
            updated_at TEXT NOT NULL,
            PRIMARY KEY(thread_id,view_key)
          ) WITHOUT ROWID, STRICT;

          CREATE TRIGGER context_compaction_jobs_immutable_columns BEFORE UPDATE ON context_compaction_jobs
          WHEN NEW.id IS NOT OLD.id OR NEW.thread_id IS NOT OLD.thread_id
            OR NEW.view_key IS NOT OLD.view_key
            OR NEW.request_key IS NOT OLD.request_key OR NEW.request_hash IS NOT OLD.request_hash
            OR NEW.source_item_ids_json IS NOT OLD.source_item_ids_json
            OR NEW.source_hash IS NOT OLD.source_hash OR NEW.summary_input_hash IS NOT OLD.summary_input_hash
            OR NEW.expected_previous_artifact_id IS NOT OLD.expected_previous_artifact_id
            OR NEW.created_at IS NOT OLD.created_at
          BEGIN SELECT RAISE(ABORT, 'compaction job identity is immutable'); END;
          CREATE TRIGGER context_compaction_heads_transition BEFORE UPDATE ON context_compaction_heads
          WHEN NEW.thread_id IS NOT OLD.thread_id OR NEW.view_key IS NOT OLD.view_key
            OR NEW.revision<>OLD.revision+1 OR NEW.compaction_id IS OLD.compaction_id
          BEGIN SELECT RAISE(ABORT, 'invalid compaction head transition'); END;
        `)
        const insertHead = this.#db.prepare(`
          INSERT INTO context_compaction_heads(
            thread_id,view_key,compaction_id,revision,head_hash,updated_at
          ) VALUES (?,?,?,?,?,?)
        `)
        for (const head of legacyHeads) {
          const threadId = text(head, 'thread_id')
          const compactionId = nullableText(head, 'compaction_id')
          const revision = integer(head, 'revision')
          insertHead.run(
            threadId,
            LEGACY_CONTEXT_VIEW_KEY,
            compactionId,
            revision,
            this.#contextCompactionHeadHash(threadId, LEGACY_CONTEXT_VIEW_KEY, compactionId, revision),
            text(head, 'updated_at'),
          )
        }
        this.#db.exec(`
          DROP TABLE context_compaction_heads_v15;
          CREATE TRIGGER context_compaction_jobs_no_delete BEFORE DELETE ON context_compaction_jobs
          WHEN NOT EXISTS (
            SELECT 1 FROM threads th JOIN session_purge_context pc ON pc.session_id=th.session_id
            WHERE th.id=OLD.thread_id
          ) BEGIN SELECT RAISE(ABORT, 'compaction jobs are durable'); END;
          CREATE TRIGGER context_compactions_no_delete BEFORE DELETE ON context_compactions
          WHEN NOT EXISTS (
            SELECT 1 FROM threads th JOIN session_purge_context pc ON pc.session_id=th.session_id
            WHERE th.id=OLD.thread_id
          ) BEGIN SELECT RAISE(ABORT, 'compaction artifacts are append-only'); END;
          CREATE TRIGGER context_compaction_sources_no_delete BEFORE DELETE ON context_compaction_source_items
          WHEN NOT EXISTS (
            SELECT 1 FROM context_compactions c JOIN threads th ON th.id=c.thread_id
            JOIN session_purge_context pc ON pc.session_id=th.session_id
            WHERE c.id=OLD.compaction_id
          ) BEGIN SELECT RAISE(ABORT, 'compaction provenance is append-only'); END;
          CREATE TRIGGER context_compaction_events_no_delete BEFORE DELETE ON context_compaction_job_events
          WHEN NOT EXISTS (
            SELECT 1 FROM threads th JOIN session_purge_context pc ON pc.session_id=th.session_id
            WHERE th.id=OLD.thread_id
          ) BEGIN SELECT RAISE(ABORT, 'compaction events are append-only'); END;
          CREATE TRIGGER execution_context_manifests_no_delete BEFORE DELETE ON execution_context_manifests
          WHEN NOT EXISTS (
            SELECT 1 FROM threads th JOIN session_purge_context pc ON pc.session_id=th.session_id
            WHERE th.id=OLD.thread_id
          ) BEGIN SELECT RAISE(ABORT, 'execution context manifests are append-only'); END;
          CREATE TRIGGER execution_context_entries_no_delete BEFORE DELETE ON execution_context_manifest_entries
          WHEN NOT EXISTS (
            SELECT 1 FROM execution_context_manifests m JOIN threads th ON th.id=m.thread_id
            JOIN session_purge_context pc ON pc.session_id=th.session_id
            WHERE m.id=OLD.manifest_id
          ) BEGIN SELECT RAISE(ABORT, 'execution context provenance is append-only'); END;
          CREATE TRIGGER context_compaction_heads_no_delete BEFORE DELETE ON context_compaction_heads
          WHEN NOT EXISTS (
            SELECT 1 FROM threads th JOIN session_purge_context pc ON pc.session_id=th.session_id
            WHERE th.id=OLD.thread_id
          ) BEGIN SELECT RAISE(ABORT, 'compaction head is durable'); END;
        `)
        this.#db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
          .run(16, 'derived-context-view-branches', this.#now())
        this.#db.exec('PRAGMA user_version = 16')
        appliedVersion = 16
      }
      if (appliedVersion < 17) {
        const now = this.#now()
        this.#db.exec(`
          ALTER TABLE sessions ADD COLUMN permission_profile_override TEXT
            CHECK(permission_profile_override IS NULL OR permission_profile_override IN ('read_only','workspace','full_access'));
          CREATE TABLE permission_settings (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            default_profile TEXT NOT NULL CHECK(default_profile IN ('read_only','workspace','full_access')),
            updated_at TEXT NOT NULL
          ) STRICT;
        `)
        this.#db.prepare(`
          INSERT INTO permission_settings(singleton,default_profile,updated_at) VALUES(1,?,?)
        `).run(DEFAULT_PERMISSION_PROFILE, now)
        this.#db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
          .run(17, 'generic-permission-profiles', now)
        this.#db.exec('PRAGMA user_version = 17')
        appliedVersion = 17
      }
      if (appliedVersion < 18) {
        this.#db.exec('UPDATE sessions SET ldplayer_grant_json=NULL WHERE ldplayer_grant_json IS NOT NULL')
        this.#db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
          .run(18, 'retire-product-specific-emulator-capability', this.#now())
        this.#db.exec('PRAGMA user_version = 18')
        appliedVersion = 18
      }
      if (appliedVersion < 19) {
        this.#db.exec(`
          ALTER TABLE goals ADD COLUMN verification_proposal_id TEXT;
          ALTER TABLE goals ADD COLUMN latest_completion_receipt_id TEXT;
          ALTER TABLE goals ADD COLUMN latest_stop_receipt_id TEXT;

          CREATE TABLE goal_completion_proposals (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
            goal_id TEXT NOT NULL,
            goal_revision INTEGER NOT NULL CHECK(goal_revision>=1),
            turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE RESTRICT,
            summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 2000),
            requirements_json TEXT NOT NULL CHECK(json_valid(requirements_json) AND json_type(requirements_json)='array'),
            evidence_bundle_json TEXT NOT NULL CHECK(json_valid(evidence_bundle_json) AND json_type(evidence_bundle_json)='object'),
            evidence_bundle_hash TEXT NOT NULL CHECK(length(evidence_bundle_hash)=64),
            status TEXT NOT NULL CHECK(status IN ('verifying','accepted','rejected','ineligible')),
            created_at TEXT NOT NULL,
            resolved_at TEXT,
            UNIQUE(goal_id,goal_revision,turn_id)
          ) STRICT;
          CREATE INDEX goal_completion_proposals_goal ON goal_completion_proposals(goal_id,goal_revision,created_at);
          CREATE TRIGGER goal_completion_proposals_immutable BEFORE UPDATE ON goal_completion_proposals
          WHEN NEW.id<>OLD.id OR NEW.session_id<>OLD.session_id OR NEW.thread_id<>OLD.thread_id
            OR NEW.goal_id<>OLD.goal_id OR NEW.goal_revision<>OLD.goal_revision OR NEW.turn_id<>OLD.turn_id
            OR NEW.summary<>OLD.summary OR NEW.requirements_json<>OLD.requirements_json
            OR NEW.evidence_bundle_json<>OLD.evidence_bundle_json
            OR NEW.evidence_bundle_hash<>OLD.evidence_bundle_hash OR NEW.created_at<>OLD.created_at BEGIN
            SELECT RAISE(ABORT, 'Goal completion proposal evidence is immutable');
          END;
          CREATE TRIGGER goal_completion_proposals_transition BEFORE UPDATE ON goal_completion_proposals
          WHEN NOT (
            OLD.status='verifying' AND NEW.status IN ('accepted','rejected','ineligible')
            AND OLD.resolved_at IS NULL AND NEW.resolved_at IS NOT NULL
          ) BEGIN
            SELECT RAISE(ABORT, 'Invalid Goal completion proposal transition');
          END;
          CREATE TRIGGER goal_completion_proposals_no_delete BEFORE DELETE ON goal_completion_proposals
          WHEN NOT EXISTS (SELECT 1 FROM session_purge_context WHERE session_id=OLD.session_id) BEGIN
            SELECT RAISE(ABORT, 'Goal completion proposals are retained');
          END;

          CREATE TABLE goal_verifier_leases (
            proposal_id TEXT PRIMARY KEY REFERENCES goal_completion_proposals(id) ON DELETE CASCADE,
            lease_id TEXT NOT NULL UNIQUE,
            goal_id TEXT NOT NULL,
            goal_revision INTEGER NOT NULL CHECK(goal_revision>=1),
            owner_id TEXT NOT NULL CHECK(length(owner_id)>=1),
            acquired_at TEXT NOT NULL,
            heartbeat_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE goal_verification_attempts (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
            proposal_id TEXT NOT NULL REFERENCES goal_completion_proposals(id) ON DELETE RESTRICT,
            goal_id TEXT NOT NULL,
            goal_revision INTEGER NOT NULL CHECK(goal_revision>=1),
            evaluator_provider TEXT NOT NULL CHECK(evaluator_provider IN ('claude','codex','gemini')),
            evaluator_model TEXT NOT NULL CHECK(length(evaluator_model)>=1),
            evidence_bundle_hash TEXT NOT NULL CHECK(length(evidence_bundle_hash)=64),
            outcome TEXT NOT NULL CHECK(outcome IN ('complete','incomplete','impossible','indeterminate')),
            decision_json TEXT NOT NULL CHECK(json_valid(decision_json) AND json_type(decision_json)='object'),
            usage_json TEXT CHECK(usage_json IS NULL OR (json_valid(usage_json) AND json_type(usage_json)='object')),
            started_at TEXT NOT NULL,
            completed_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX goal_verification_attempts_goal ON goal_verification_attempts(goal_id,goal_revision,completed_at);
          CREATE TRIGGER goal_verification_attempts_no_update BEFORE UPDATE ON goal_verification_attempts BEGIN
            SELECT RAISE(ABORT, 'Goal verification attempts are append-only');
          END;
          CREATE TRIGGER goal_verification_attempts_no_delete BEFORE DELETE ON goal_verification_attempts
          WHEN NOT EXISTS (SELECT 1 FROM session_purge_context WHERE session_id=OLD.session_id) BEGIN
            SELECT RAISE(ABORT, 'Goal verification attempts are append-only');
          END;

          CREATE TABLE goal_completion_receipts (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
            goal_id TEXT NOT NULL,
            goal_revision INTEGER NOT NULL CHECK(goal_revision>=1),
            proposal_id TEXT NOT NULL REFERENCES goal_completion_proposals(id) ON DELETE RESTRICT,
            verification_attempt_id TEXT NOT NULL UNIQUE REFERENCES goal_verification_attempts(id) ON DELETE RESTRICT,
            evidence_bundle_hash TEXT NOT NULL CHECK(length(evidence_bundle_hash)=64),
            host_checks_json TEXT NOT NULL CHECK(json_valid(host_checks_json) AND json_type(host_checks_json)='array'),
            acceptance_policy_version TEXT NOT NULL,
            accepted_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX goal_completion_receipts_goal ON goal_completion_receipts(goal_id,goal_revision,accepted_at);
          CREATE TRIGGER goal_completion_receipts_no_update BEFORE UPDATE ON goal_completion_receipts BEGIN
            SELECT RAISE(ABORT, 'Goal completion receipts are append-only');
          END;
          CREATE TRIGGER goal_completion_receipts_no_delete BEFORE DELETE ON goal_completion_receipts
          WHEN NOT EXISTS (SELECT 1 FROM session_purge_context WHERE session_id=OLD.session_id) BEGIN
            SELECT RAISE(ABORT, 'Goal completion receipts are append-only');
          END;

          CREATE TABLE goal_stop_receipts (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
            goal_id TEXT NOT NULL,
            goal_revision INTEGER NOT NULL CHECK(goal_revision>=1),
            verification_attempt_id TEXT NOT NULL UNIQUE REFERENCES goal_verification_attempts(id) ON DELETE RESTRICT,
            kind TEXT NOT NULL CHECK(kind='confirmed_impossible'),
            reason TEXT NOT NULL,
            evidence_bundle_hash TEXT NOT NULL CHECK(length(evidence_bundle_hash)=64),
            decided_at TEXT NOT NULL,
            resumable INTEGER NOT NULL CHECK(resumable IN (0,1))
          ) STRICT;
          CREATE INDEX goal_stop_receipts_goal ON goal_stop_receipts(goal_id,goal_revision,decided_at);
          CREATE TRIGGER goal_stop_receipts_no_update BEFORE UPDATE ON goal_stop_receipts BEGIN
            SELECT RAISE(ABORT, 'Goal stop receipts are append-only');
          END;
          CREATE TRIGGER goal_stop_receipts_no_delete BEFORE DELETE ON goal_stop_receipts
          WHEN NOT EXISTS (SELECT 1 FROM session_purge_context WHERE session_id=OLD.session_id) BEGIN
            SELECT RAISE(ABORT, 'Goal stop receipts are append-only');
          END;
        `)
        this.#db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
          .run(19, 'independent-goal-verification', this.#now())
        this.#db.exec('PRAGMA user_version = 19')
        appliedVersion = 19
      }
      if (appliedVersion < 20) {
        // native_imported_records holds one row per imported transcript record
        // (hundreds of thousands of rows) but had no index on its owning
        // source. Purging or looking up by source therefore full-scanned the
        // table inside a write transaction — the observed 75-minute
        // lock-everything purge. The index turns those deletes into range
        // scans. Guarded: hand-built legacy fixtures migrate minimal schemas
        // that may omit the native-import tables entirely.
        const hasImportedRecords = this.#optional(this.#db.prepare(
          "SELECT name AS name FROM sqlite_master WHERE type='table' AND name='native_imported_records'",
        )) !== null
        if (hasImportedRecords) {
          // item_id backs the FK from items: without it, deleting each item
          // FK-scans the whole record table (quadratic across a purge).
          this.#db.exec(`
            CREATE INDEX IF NOT EXISTS native_imported_records_source ON native_imported_records(source_id);
            CREATE INDEX IF NOT EXISTS native_imported_records_item ON native_imported_records(item_id);
          `)
        }
        this.#db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
          .run(20, 'native-imported-records-source-index', this.#now())
        this.#db.exec('PRAGMA user_version = 20')
        appliedVersion = 20
      }
      if (appliedVersion < 21) {
        // Heal databases that recorded v20 while the migration only created the
        // source_id index: without the item_id index a purge's items delete
        // FK-scans the 700K-row record table per item (observed: 28 minutes per
        // 25-session batch; 2.4 s with the index).
        const hasImportedRecords = this.#optional(this.#db.prepare(
          "SELECT name AS name FROM sqlite_master WHERE type='table' AND name='native_imported_records'",
        )) !== null
        if (hasImportedRecords) {
          this.#db.exec(`
            CREATE INDEX IF NOT EXISTS native_imported_records_item ON native_imported_records(item_id);
          `)
        }
        this.#db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
          .run(21, 'native-imported-records-item-index-heal', this.#now())
        this.#db.exec('PRAGMA user_version = 21')
        appliedVersion = 21
      }
      const userVersion = integer(this.#one(this.#db.prepare('PRAGMA user_version')), 'user_version')
      if (versions.length > 0 && userVersion !== SCHEMA_VERSION) {
        throw new Error(`Session schema metadata mismatch: user_version=${userVersion}`)
      }
      this.#validateDerivedContextSchema()
    })
  }

  #validateDerivedContextSchema(): void {
    const required: ReadonlyArray<readonly [type: 'table' | 'index' | 'trigger', name: string]> = [
      ['table', 'context_compaction_jobs'],
      ['table', 'context_compaction_heads'],
      ['table', 'context_compactions'],
      ['table', 'context_compaction_source_items'],
      ['table', 'context_compaction_job_events'],
      ['table', 'execution_context_manifests'],
      ['table', 'execution_context_manifest_entries'],
      ['index', 'context_compaction_jobs_queue'],
      ['index', 'context_compaction_jobs_active_frontier'],
      ['index', 'context_compactions_thread_created'],
      ['index', 'context_compaction_job_events_job'],
      ['trigger', 'context_compaction_jobs_immutable_columns'],
      ['trigger', 'context_compaction_jobs_terminal'],
      ['trigger', 'context_compaction_jobs_transition'],
      ['trigger', 'context_compaction_jobs_no_delete'],
      ['trigger', 'context_compactions_no_update'],
      ['trigger', 'context_compactions_no_delete'],
      ['trigger', 'context_compaction_heads_transition'],
      ['trigger', 'context_compaction_heads_no_delete'],
      ['trigger', 'context_compaction_sources_no_update'],
      ['trigger', 'context_compaction_sources_no_delete'],
      ['trigger', 'context_compaction_events_no_update'],
      ['trigger', 'context_compaction_events_no_delete'],
      ['trigger', 'execution_context_manifests_no_update'],
      ['trigger', 'execution_context_manifests_no_delete'],
      ['trigger', 'execution_context_entries_no_update'],
      ['trigger', 'execution_context_entries_no_delete'],
      ['table', 'goal_completion_proposals'],
      ['table', 'goal_verifier_leases'],
      ['table', 'goal_verification_attempts'],
      ['table', 'goal_completion_receipts'],
      ['table', 'goal_stop_receipts'],
      ['index', 'goal_completion_proposals_goal'],
      ['index', 'goal_verification_attempts_goal'],
      ['index', 'goal_completion_receipts_goal'],
      ['index', 'goal_stop_receipts_goal'],
      ['trigger', 'goal_completion_proposals_immutable'],
      ['trigger', 'goal_completion_proposals_transition'],
      ['trigger', 'goal_completion_proposals_no_delete'],
      ['trigger', 'goal_verification_attempts_no_update'],
      ['trigger', 'goal_verification_attempts_no_delete'],
      ['trigger', 'goal_completion_receipts_no_update'],
      ['trigger', 'goal_completion_receipts_no_delete'],
      ['trigger', 'goal_stop_receipts_no_update'],
      ['trigger', 'goal_stop_receipts_no_delete'],
    ]
    const actual = new Set(this.#all(this.#db.prepare(`
      SELECT type,name FROM sqlite_schema WHERE type IN ('table','index','trigger')
    `)).map((row) => `${text(row, 'type')}:${text(row, 'name')}`))
    const missing = required
      .map(([type, name]) => `${type}:${name}`)
      .filter((identity) => !actual.has(identity))
    if (missing.length > 0) {
      throw new ContextPersistenceError(
        'integrity_violation',
        `Session schema is missing required persistence protections: ${missing.join(', ')}`,
      )
    }
  }

  #transaction<T>(mode: 'IMMEDIATE' | 'EXCLUSIVE', action: () => T): T {
    this.#db.exec(`BEGIN ${mode}`)
    try {
      const result = action()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK')
      throw error
    }
  }

  #all(statement: StatementSync, ...parameters: (string | number | null)[]): SqlRow[] {
    return statement.all(...parameters) as SqlRow[]
  }

  #one(statement: StatementSync, ...parameters: (string | number | null)[]): SqlRow {
    const row = statement.get(...parameters) as SqlRow | undefined
    if (!row) throw new Error('Corrupt database: expected one row')
    return row
  }

  #optional(statement: StatementSync, ...parameters: (string | number | null)[]): SqlRow | null {
    return (statement.get(...parameters) as SqlRow | undefined) ?? null
  }

  createSession(input: CreateSessionInput): CanonicalSession {
    const sessionId = this.#idFactory()
    const threadId = this.#idFactory()
    const now = this.#now()
    this.#transaction('IMMEDIATE', () => {
      this.#db.prepare(`
        INSERT INTO sessions(id,title,preview,active_thread_id,project_key,cwd,schema_version,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?, ?,?)
      `).run(sessionId, input.title ?? null, null, threadId, input.projectKey ?? null, input.cwd ?? null, SCHEMA_VERSION, now, now)
      this.#db.prepare(`
        INSERT INTO threads(id,session_id,parent_thread_id,fork_turn_id,fork_item_id,revision,status,instruction_snapshot_json,created_at,updated_at)
        VALUES (?,?,NULL,NULL,NULL,0,'idle',?,?,?)
      `).run(threadId, sessionId, canonicalJson(input.instructionSnapshot ?? {}), now, now)
      this.#appendStreamEvent(sessionId, threadId, null, 'session_created', { sessionId, threadId }, now)
    })
    return this.getSession(sessionId) as CanonicalSession
  }

  getInitialSessionResult(input: InitialSessionRequestIdentity): BeginSessionResult | null {
    const session = this.getSession(input.sessionId)
    if (!session) return null
    const rootTurnRow = this.#optional(this.#db.prepare(`
      SELECT turn.* FROM turns turn
      JOIN threads thread ON thread.id=turn.thread_id
      WHERE thread.session_id=? AND thread.parent_thread_id IS NULL AND turn.sequence=1
      ORDER BY thread.created_at,thread.id LIMIT 1
    `), input.sessionId)
    if (!rootTurnRow
      || text(rootTurnRow, 'client_request_id') !== input.clientRequestId
      || text(rootTurnRow, 'request_hash') !== input.requestHash) {
      throw new SessionStoreError(
        'initial_session_conflict',
        'Session ID was already used by a different initial request',
      )
    }
    const turn = this.#turn(rootTurnRow)
    const thread = this.getThread(turn.threadId)
    if (!thread) throw new Error('Corrupt database: initial session thread is missing')
    const execution = this.#execution(this.#one(
      this.#db.prepare('SELECT * FROM executions WHERE turn_id=?'),
      turn.id,
    ))
    const initialItems = this.#all(this.#db.prepare(
      'SELECT * FROM items WHERE turn_id=? AND origin_event_id IS NULL ORDER BY sequence',
    ), turn.id).map((row) => this.#item(row))
    return { session, thread, turn, execution, initialItems, duplicate: true }
  }

  beginSession(input: BeginSessionInput): BeginSessionResult {
    return this.#transaction('IMMEDIATE', () => {
      const replay = this.getInitialSessionResult(input)
      if (replay) return replay
      this.#assertPermissionSnapshotCurrent(input.policySnapshot, null)

      const threadId = this.#idFactory()
      const turnId = this.#idFactory()
      const executionId = this.#idFactory()
      const now = this.#now()
      this.#db.prepare(`
        INSERT INTO sessions(id,title,preview,active_thread_id,project_key,cwd,schema_version,created_at,updated_at)
        VALUES (?,NULL,?,?,NULL,?,?,?,?)
      `).run(
        input.sessionId,
        initialSessionPreview(input.input),
        threadId,
        input.cwd,
        SCHEMA_VERSION,
        now,
        now,
      )
      this.#db.prepare(`
        INSERT INTO threads(
          id,session_id,parent_thread_id,fork_turn_id,fork_item_id,revision,status,
          instruction_snapshot_json,created_at,updated_at
        ) VALUES (?,?,NULL,NULL,NULL,1,'running',?,?,?)
      `).run(threadId, input.sessionId, canonicalJson(input.instructionSnapshot), now, now)
      this.#db.prepare(`
        INSERT INTO turns(
          id,thread_id,sequence,provider,model,effort,status,client_request_id,request_hash,
          started_at,goal_id,goal_revision
        ) VALUES (?,?,1,?,?,?,'running',?,?,?,NULL,NULL)
      `).run(
        turnId,
        threadId,
        input.provider,
        input.model,
        input.effort,
        input.clientRequestId,
        input.requestHash,
        now,
      )
      this.#db.prepare(`
        INSERT INTO executions(
          id,session_id,thread_id,turn_id,parent_execution_id,spawn_item_id,kind,provider,model,
          adapter_version,status,policy_snapshot_json,budget_json,usage_json,lease_expires_at,started_at
        ) VALUES (?,?,?,?,NULL,NULL,'root_turn',?,?,?,'running',?,?,?,?,?)
      `).run(
        executionId,
        input.sessionId,
        threadId,
        turnId,
        input.provider,
        input.model,
        input.adapterVersion,
        canonicalJson(input.policySnapshot),
        canonicalJson(input.budget ?? {}),
        canonicalJson({}),
        input.leaseExpiresAt ?? null,
        now,
      )
      const initialItems = this.#appendItems(
        input.sessionId,
        threadId,
        turnId,
        null,
        input.input,
        null,
        now,
      )
      this.#appendStreamEvent(input.sessionId, threadId, null, 'session_created', {
        sessionId: input.sessionId,
        threadId,
      }, now)
      this.#appendStreamEvent(input.sessionId, threadId, turnId, 'turn_started', {
        turnId,
        executionId,
        provider: input.provider,
        model: input.model,
        effort: input.effort,
        itemIds: initialItems.map((item) => item.id),
      }, now)
      return {
        session: this.getSession(input.sessionId) as CanonicalSession,
        thread: this.getThread(threadId) as CanonicalThread,
        turn: this.getTurn(turnId) as CanonicalTurn,
        execution: this.#execution(this.#one(
          this.#db.prepare('SELECT * FROM executions WHERE id=?'),
          executionId,
        )),
        initialItems,
        duplicate: false,
      }
    })
  }

  listSessions(scope: SessionListScope = 'active'): CanonicalSession[] {
    const filter = scope === 'active'
      ? ' WHERE s.archived_at IS NULL'
      : scope === 'trash'
        ? ' WHERE s.archived_at IS NOT NULL'
        : ''
    const orderBy = scope === 'trash' ? 's.archived_at DESC, s.id' : 's.updated_at DESC, s.id'
    return this.#all(this.#db.prepare(`${sessionSelect()}${filter} ORDER BY ${orderBy}`))
      .map((row) => this.#session(row))
  }

  getSession(sessionId: SessionId): CanonicalSession | null {
    const row = this.#optional(this.#db.prepare(`${sessionSelect()} WHERE s.id = ?`), sessionId)
    return row ? this.#session(row) : null
  }

  archiveSession(sessionId: SessionId): CanonicalSession {
    return this.#transaction('IMMEDIATE', () => {
      const session = this.getSession(sessionId)
      if (!session) throw new SessionStoreError('not_found', `Session not found: ${sessionId}`)
      if (session.archivedAt) return session
      const activeTurn = this.#optional(this.#db.prepare(`
        SELECT t.id FROM turns t
        JOIN threads th ON th.id = t.thread_id
        WHERE th.session_id = ? AND t.status IN ('queued','running','waiting_tool')
        LIMIT 1
      `), sessionId)
      if (activeTurn) {
        throw new SessionStoreError('session_busy', '실행 중인 응답이 끝난 뒤 대화를 삭제하세요.')
      }
      this.#db.prepare(`
        DELETE FROM goal_scheduler_leases WHERE goal_id IN (
          SELECT g.id FROM goals g JOIN threads t ON t.id=g.thread_id WHERE t.session_id=?
        )
      `).run(sessionId)
      this.#db.prepare('UPDATE sessions SET archived_at = ? WHERE id = ?').run(this.#now(), sessionId)
      return this.getSession(sessionId) as CanonicalSession
    })
  }

  restoreSession(sessionId: SessionId): CanonicalSession {
    return this.#transaction('IMMEDIATE', () => {
      const session = this.getSession(sessionId)
      if (!session) throw new SessionStoreError('not_found', `Session not found: ${sessionId}`)
      if (!session.archivedAt) return session
      this.#db.prepare('UPDATE sessions SET archived_at = NULL WHERE id = ?').run(sessionId)
      return this.getSession(sessionId) as CanonicalSession
    })
  }

  updateWorkspace(input: UpdateWorkspaceInput): CanonicalSession {
    return this.#transaction('IMMEDIATE', () => {
      const session = this.getSession(input.sessionId)
      if (!session) throw new SessionStoreError('not_found', `Session not found: ${input.sessionId}`)
      if (session.archivedAt) throw new SessionStoreError('session_archived', 'Cannot change an archived session workspace')
      const thread = this.getThread(session.activeThreadId)
      if (!thread) throw new Error('Corrupt database: active thread is missing')
      if (thread.revision !== input.expectedThreadRevision) {
        throw new SessionStoreError('revision_conflict', 'Thread revision changed after the workspace was observed')
      }
      if (thread.status !== 'idle') {
        throw new SessionStoreError('session_busy', 'Workspace can only change while the session is idle')
      }
      const activeGoal = this.#optional(this.#db.prepare(
        "SELECT id FROM goals WHERE thread_id=? AND status='active' LIMIT 1",
      ), thread.id)
      if (activeGoal) throw new SessionStoreError('session_busy', 'Pause or finish the active Goal before changing the workspace')
      if (session.cwd === input.cwd) return session

      const now = this.#now()
      const updated = this.#db.prepare(`
        UPDATE threads SET revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='idle'
      `).run(now, thread.id, input.expectedThreadRevision)
      if (updated.changes !== 1) {
        throw new SessionStoreError('revision_conflict', 'Thread changed while the workspace was being updated')
      }
      this.#db.prepare('UPDATE sessions SET cwd=?,updated_at=? WHERE id=?')
        .run(input.cwd, now, session.id)
      this.#db.prepare(`
        UPDATE provider_bindings SET invalidated_at=?,updated_at=?
        WHERE thread_id=? AND invalidated_at IS NULL
      `).run(now, now, thread.id)
      this.#appendStreamEvent(session.id, thread.id, null, 'workspace_changed', {
        connected: input.cwd !== null,
        previousConnected: session.cwd !== null,
        revision: thread.revision + 1,
      }, now)
      return this.getSession(session.id) as CanonicalSession
    })
  }

  getPermissionSettings(): GlobalPermissionSettings {
    const row = this.#one(this.#db.prepare(`
      SELECT default_profile,updated_at FROM permission_settings WHERE singleton=1
    `))
    return {
      defaultProfile: parsePermissionProfile(text(row, 'default_profile')),
      updatedAt: text(row, 'updated_at'),
    }
  }

  updateDefaultPermissionProfile(profile: PermissionProfile): GlobalPermissionSettings {
    const validated = parsePermissionProfile(profile)
    const now = this.#now()
    this.#db.prepare(`
      UPDATE permission_settings SET default_profile=?,updated_at=? WHERE singleton=1
    `).run(validated, now)
    return this.getPermissionSettings()
  }

  updateSessionPermissionProfile(input: UpdateSessionPermissionProfileInput): CanonicalSession {
    return this.#transaction('IMMEDIATE', () => {
      const session = this.getSession(input.sessionId)
      if (!session) throw new SessionStoreError('not_found', `Session not found: ${input.sessionId}`)
      if (session.archivedAt) throw new SessionStoreError('session_archived', 'Cannot change permissions for an archived session')
      const thread = this.getThread(session.activeThreadId)
      if (!thread) throw new Error('Corrupt database: active thread is missing')
      if (thread.status !== 'idle') {
        throw new SessionStoreError('session_busy', 'Permissions can only change while the current turn is idle')
      }
      const profile = input.profile === null ? null : parsePermissionProfile(input.profile)
      if (session.permissions.override === profile) return session
      const now = this.#now()
      this.#db.prepare(`
        UPDATE sessions SET permission_profile_override=?,updated_at=? WHERE id=?
      `).run(profile, now, session.id)
      this.#appendStreamEvent(session.id, thread.id, null, 'host_capability_changed', {
        capability: 'permission_profile',
        override: profile,
        effectiveProfile: profile ?? this.getPermissionSettings().defaultProfile,
      }, now)
      return this.getSession(session.id) as CanonicalSession
    })
  }

  purgeExpiredSessions(cutoffIso: string, batchSize = 100): number {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
      throw new RangeError('batchSize must be an integer between 1 and 1000')
    }
    return this.#transaction('IMMEDIATE', () => {
      this.#db.exec('PRAGMA defer_foreign_keys = ON')
      const candidates = this.#all(this.#db.prepare(`
        SELECT id FROM sessions
        WHERE archived_at IS NOT NULL AND archived_at <= ?
        ORDER BY archived_at, id
        LIMIT ?
      `), cutoffIso, batchSize).map((row) => text(row, 'id'))
      if (candidates.length === 0) return 0
      const contextCount = integer(this.#one(this.#db.prepare(
        'SELECT COUNT(*) AS count FROM session_purge_context',
      )), 'count')
      if (contextCount !== 0) throw new Error('Session purge context is unexpectedly occupied')
      const insertContext = this.#db.prepare('INSERT INTO session_purge_context(session_id) VALUES (?)')
      for (const sessionId of candidates) insertContext.run(sessionId)

      const sourceIds = `SELECT ns.id FROM native_session_sources ns
        JOIN session_purge_context pc ON pc.session_id = ns.session_id`
      this.#db.exec(`
        DELETE FROM native_imported_records WHERE source_id IN (${sourceIds});
        DELETE FROM native_session_revisions WHERE source_id IN (${sourceIds});
        DELETE FROM native_session_identity_keys WHERE source_id IN (${sourceIds});
        DELETE FROM native_session_source_provenance WHERE source_id IN (${sourceIds});
        DELETE FROM native_session_sources
          WHERE session_id IN (SELECT session_id FROM session_purge_context);
        DELETE FROM goal_stop_receipts
          WHERE session_id IN (SELECT session_id FROM session_purge_context);
        DELETE FROM goal_completion_receipts
          WHERE session_id IN (SELECT session_id FROM session_purge_context);
        DELETE FROM goal_verification_attempts
          WHERE session_id IN (SELECT session_id FROM session_purge_context);
        DELETE FROM goal_completion_proposals
          WHERE session_id IN (SELECT session_id FROM session_purge_context);
        DELETE FROM provider_events WHERE turn_id IN (
          SELECT t.id FROM turns t
          JOIN threads th ON th.id = t.thread_id
          JOIN session_purge_context pc ON pc.session_id = th.session_id
        );
        DELETE FROM goal_turn_accounting WHERE turn_id IN (
          SELECT t.id FROM turns t
          JOIN threads th ON th.id = t.thread_id
          JOIN session_purge_context pc ON pc.session_id = th.session_id
        );
        DELETE FROM goal_events
          WHERE session_id IN (SELECT session_id FROM session_purge_context);
        DELETE FROM goals WHERE thread_id IN (
          SELECT th.id FROM threads th
          JOIN session_purge_context pc ON pc.session_id = th.session_id
        );
        DELETE FROM provider_bindings WHERE thread_id IN (
          SELECT th.id FROM threads th
          JOIN session_purge_context pc ON pc.session_id = th.session_id
        );
        DELETE FROM execution_context_manifest_entries WHERE manifest_id IN (
          SELECT m.id FROM execution_context_manifests m
          JOIN threads th ON th.id=m.thread_id
          JOIN session_purge_context pc ON pc.session_id=th.session_id
        );
        DELETE FROM execution_context_manifests WHERE thread_id IN (
          SELECT th.id FROM threads th
          JOIN session_purge_context pc ON pc.session_id=th.session_id
        );
        DELETE FROM context_compaction_source_items WHERE compaction_id IN (
          SELECT c.id FROM context_compactions c
          JOIN threads th ON th.id=c.thread_id
          JOIN session_purge_context pc ON pc.session_id=th.session_id
        );
        DELETE FROM context_compaction_job_events WHERE thread_id IN (
          SELECT th.id FROM threads th
          JOIN session_purge_context pc ON pc.session_id=th.session_id
        );
        DELETE FROM context_compactions WHERE thread_id IN (
          SELECT th.id FROM threads th
          JOIN session_purge_context pc ON pc.session_id=th.session_id
        );
        DELETE FROM context_compaction_heads WHERE thread_id IN (
          SELECT th.id FROM threads th
          JOIN session_purge_context pc ON pc.session_id=th.session_id
        );
        DELETE FROM context_compaction_jobs WHERE thread_id IN (
          SELECT th.id FROM threads th
          JOIN session_purge_context pc ON pc.session_id=th.session_id
        );
        DELETE FROM executions
          WHERE session_id IN (SELECT session_id FROM session_purge_context);
        DELETE FROM stream_events
          WHERE session_id IN (SELECT session_id FROM session_purge_context);
        DELETE FROM follow_ups
          WHERE session_id IN (SELECT session_id FROM session_purge_context);
        DELETE FROM items
          WHERE session_id IN (SELECT session_id FROM session_purge_context);
        DELETE FROM turns WHERE thread_id IN (
          SELECT th.id FROM threads th
          JOIN session_purge_context pc ON pc.session_id = th.session_id
        );
        DELETE FROM threads
          WHERE session_id IN (SELECT session_id FROM session_purge_context);
        DELETE FROM sessions
          WHERE id IN (SELECT session_id FROM session_purge_context);
        DELETE FROM session_purge_context;
      `)
      const violations = this.#all(this.#db.prepare('PRAGMA foreign_key_check'))
      if (violations.length > 0) throw new Error('Session purge would violate foreign key integrity')
      return candidates.length
    })
  }

  getThread(threadId: ThreadId): CanonicalThread | null {
    const row = this.#optional(this.#db.prepare('SELECT * FROM threads WHERE id = ?'), threadId)
    return row ? this.#thread(row) : null
  }

  getSnapshot(threadId: ThreadId): ThreadSnapshot | null {
    const thread = this.getThread(threadId)
    if (!thread) return null
    const session = this.getSession(thread.sessionId)
    if (!session) throw new Error('Corrupt database: thread session is missing')
    const segments = this.#lineage(thread)
    const items = this.#itemsForSegments(segments, 0)
    const turns: CanonicalTurn[] = []
    for (const segment of segments) {
      const rows = this.#all(this.#db.prepare('SELECT * FROM turns WHERE thread_id = ? ORDER BY sequence'), segment.thread.id)
      for (const row of rows) {
        const turn = this.#turn(row)
        const firstItem = items.find((item) => item.turnId === turn.id)
        if (firstItem || segment.maximumItemSequence === null) turns.push(turn)
      }
    }
    const bindingRows = this.#all(this.#db.prepare(
      `SELECT * FROM provider_bindings
       WHERE thread_id = ? AND invalidated_at IS NULL AND synced_revision = ?
       ORDER BY provider`,
    ), threadId, thread.revision)
    return {
      session,
      thread,
      turns,
      items,
      bindings: bindingRows.map((row) => this.#binding(row)),
      followUps: this.listFollowUps(thread.id),
      goal: this.getGoal(thread.id),
    }
  }

  forkThread(input: ForkThreadInput): CanonicalThread {
    return this.#transaction('IMMEDIATE', () => {
      const parent = this.getThread(input.threadId)
      if (!parent) throw new SessionStoreError('not_found', `Thread not found: ${input.threadId}`)
      if (this.getSession(parent.sessionId)?.archivedAt) {
        throw new SessionStoreError('session_archived', '휴지통의 대화는 분기할 수 없습니다.')
      }
      let forkTurnId: string | null = null
      if (input.forkItemId !== null) {
        const item = this.listItems(parent.id).find((candidate) => candidate.id === input.forkItemId)
        if (!item) throw new SessionStoreError('invalid_fork', 'Fork item is not in the source thread lineage')
        forkTurnId = item.turnId
      }
      const id = this.#idFactory()
      const now = this.#now()
      this.#db.prepare(`
        INSERT INTO threads(id,session_id,parent_thread_id,fork_turn_id,fork_item_id,revision,status,instruction_snapshot_json,created_at,updated_at)
        VALUES (?,?,?,?,?,0,'idle',?,?,?)
      `).run(id, parent.sessionId, parent.id, forkTurnId, input.forkItemId, canonicalJson(parent.instructionSnapshot), now, now)
      this.#db.prepare('UPDATE sessions SET active_thread_id = ?, updated_at = ? WHERE id = ?').run(id, now, parent.sessionId)
      this.#appendStreamEvent(parent.sessionId, id, null, 'thread_forked', {
        threadId: id,
        parentThreadId: parent.id,
        forkItemId: input.forkItemId,
      }, now)
      return this.getThread(id) as CanonicalThread
    })
  }

  beginTurn(input: GoalAwareBeginTurnInput): BeginTurnResult {
    return this.#transaction('IMMEDIATE', () => {
      const existingRow = this.#optional(
        this.#db.prepare('SELECT * FROM turns WHERE thread_id = ? AND client_request_id = ?'),
        input.threadId,
        input.clientRequestId,
      )
      if (existingRow) {
        if (text(existingRow, 'request_hash') !== input.requestHash) {
          throw new SessionStoreError('duplicate_request', 'Client request ID was reused with different content')
        }
        const turn = this.#turn(existingRow)
        const execution = this.#execution(this.#one(this.#db.prepare('SELECT * FROM executions WHERE turn_id = ?'), turn.id))
        const initialItems = this.#all(this.#db.prepare(
          'SELECT * FROM items WHERE turn_id = ? AND origin_event_id IS NULL ORDER BY sequence',
        ), turn.id).map((row) => this.#item(row))
        return { turn, execution, initialItems, duplicate: true }
      }

      const thread = this.getThread(input.threadId)
      if (!thread) throw new SessionStoreError('not_found', `Thread not found: ${input.threadId}`)
      const session = this.getSession(thread.sessionId)
      if (session?.archivedAt) {
        throw new SessionStoreError('session_archived', '휴지통의 대화에는 메시지를 보낼 수 없습니다.')
      }
      if (thread.revision !== input.expectedRevision) {
        throw new SessionStoreError('revision_conflict', `Expected revision ${input.expectedRevision}, got ${thread.revision}`)
      }
      if (thread.status !== 'idle') throw new SessionStoreError('turn_not_running', 'Thread already has an active turn')
      if (!session) throw new Error('Corrupt database: turn session is missing')
      this.#assertPermissionSnapshotCurrent(input.policySnapshot, session)
      // Close imported (turnless) orphan tool calls now, after the caller's
      // expectedRevision was honored but before this turn's items exist: the
      // synthetic results precede every turn item (keeping fresh imports
      // compactable) and never perturb the native-refresh untouched-root
      // accounting, because a turn beginning marks the session touched anyway.
      this.#repairOrphanImportedToolCallsInTxn(input.threadId)

      const now = this.#now()
      const goalContext = input.goalContext ?? null
      const currentGoalRow = this.#optional(
        this.#db.prepare("SELECT * FROM goals WHERE thread_id=? AND status='active'"),
        thread.id,
      )
      let capturedGoalId = currentGoalRow ? text(currentGoalRow, 'id') : null
      let capturedGoalRevision = currentGoalRow ? integer(currentGoalRow, 'revision') : null
      let capturedLeaseSeconds = 0
      if (goalContext) {
        const lease = this.#optional(this.#db.prepare(`
          SELECT l.* FROM goal_scheduler_leases l
          JOIN goals g ON g.id=l.goal_id
          WHERE l.lease_id=? AND l.goal_id=? AND l.goal_revision=?
            AND g.thread_id=? AND g.status='active' AND g.revision=l.goal_revision
        `), goalContext.leaseId, goalContext.goalId, goalContext.goalRevision, thread.id)
        if (!lease || text(lease, 'expires_at') <= now) {
          throw new GoalStoreError('goal_lease_lost', 'Goal scheduler lease is missing, expired, or stale')
        }
        capturedGoalId = goalContext.goalId
        capturedGoalRevision = goalContext.goalRevision
        capturedLeaseSeconds = Math.max(0, Math.floor(
          (Date.parse(now) - Date.parse(text(lease, 'acquired_at'))) / 1_000,
        ))
        if (!currentGoalRow
          || !Number.isSafeInteger(integer(currentGoalRow, 'time_used_seconds') + capturedLeaseSeconds)) {
          throw new GoalStoreError('invalid_goal_input', 'Goal lease accounting would exceed safe integer storage')
        }
      }

      const turnId = this.#idFactory()
      const executionId = this.#idFactory()
      const sequenceRow = this.#one(this.#db.prepare(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM turns WHERE thread_id = ?',
      ), thread.id)
      const turnSequence = integer(sequenceRow, 'next_sequence')
      this.#db.prepare(`
        INSERT INTO turns(id,thread_id,sequence,provider,model,effort,status,client_request_id,request_hash,started_at,goal_id,goal_revision)
        VALUES (?,?,?,?,?,?,'running',?,?,?,?,?)
      `).run(turnId, thread.id, turnSequence, input.provider, input.model, input.effort ?? null,
        input.clientRequestId, input.requestHash, now, capturedGoalId, capturedGoalRevision)
      this.#db.prepare(`
        INSERT INTO executions(id,session_id,thread_id,turn_id,parent_execution_id,spawn_item_id,kind,provider,model,adapter_version,status,policy_snapshot_json,budget_json,usage_json,lease_expires_at,started_at)
        VALUES (?,?,?,?,NULL,NULL,'root_turn',?,?,?,'running',?,?,?,?,?)
      `).run(executionId, thread.sessionId, thread.id, turnId, input.provider, input.model, input.adapterVersion,
        canonicalJson(input.policySnapshot), canonicalJson(input.budget ?? {}), canonicalJson({}), input.leaseExpiresAt ?? null, now)
      const initialItems = this.#appendItems(thread.sessionId, thread.id, turnId, null, input.input, null, now)
      this.#db.prepare("UPDATE threads SET status='running', revision=revision+1, updated_at=? WHERE id=?").run(now, thread.id)
      this.#db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(now, thread.sessionId)
      this.#appendStreamEvent(thread.sessionId, thread.id, turnId, 'turn_started', {
        turnId,
        executionId,
        provider: input.provider,
        model: input.model,
        effort: input.effort ?? null,
        itemIds: initialItems.map((item) => item.id),
      }, now)
      if (goalContext) {
        if (capturedLeaseSeconds > 0) {
          this.#db.prepare(`
            UPDATE goals SET time_used_seconds=time_used_seconds+?,updated_at=?
            WHERE id=? AND revision=? AND status='active'
          `).run(capturedLeaseSeconds, now, goalContext.goalId, goalContext.goalRevision)
        }
        this.#db.prepare(`
          DELETE FROM goal_scheduler_leases
          WHERE lease_id=? AND goal_id=? AND goal_revision=?
        `).run(goalContext.leaseId, goalContext.goalId, goalContext.goalRevision)
      } else if (capturedGoalId !== null) {
        this.#db.prepare('DELETE FROM goal_scheduler_leases WHERE goal_id=?').run(capturedGoalId)
      }
      return {
        turn: this.getTurn(turnId) as CanonicalTurn,
        execution: this.#execution(this.#one(this.#db.prepare('SELECT * FROM executions WHERE id=?'), executionId)),
        initialItems,
        duplicate: false,
      }
    })
  }

  getTurn(turnId: TurnId): CanonicalTurn | null {
    const row = this.#optional(this.#db.prepare('SELECT * FROM turns WHERE id=?'), turnId)
    return row ? this.#turn(row) : null
  }

  beginTurnFromFollowUp(input: BeginTurnFromFollowUpInput): BeginTurnResult {
    if (!input.ownerId) throw new FollowUpStoreError('invalid_follow_up', 'Follow-up lease owner must not be empty')
    const result = this.#transaction<BeginTurnResult | null>('IMMEDIATE', () => {
      const followRow = this.#optional(this.#db.prepare('SELECT * FROM follow_ups WHERE id=?'), input.followUpId)
      if (!followRow) throw new SessionStoreError('not_found', `Follow-up not found: ${input.followUpId}`)
      if (text(followRow, 'status') !== 'dispatching' || nullableText(followRow, 'dispatch_owner') !== input.ownerId) {
        throw new FollowUpStoreError('follow_up_lease_lost', 'Follow-up next-turn claim is no longer owned')
      }
      const observedNow = this.#now()
      if ((nullableText(followRow, 'lease_expires_at') ?? '') <= observedNow) {
        throw new FollowUpStoreError('follow_up_lease_lost', 'Follow-up next-turn claim expired before turn creation')
      }
      if (text(followRow, 'thread_id') !== input.threadId) {
        throw new FollowUpStoreError('invalid_follow_up', 'Follow-up claim belongs to a different thread')
      }
      if (nullableText(followRow, 'target_turn_id') !== null) {
        throw new FollowUpStoreError('invalid_follow_up', 'Next-turn follow-up still targets an active turn')
      }
      const thread = this.getThread(text(followRow, 'thread_id'))
      if (!thread) throw new SessionStoreError('not_found', 'Follow-up thread was removed')
      const session = this.getSession(thread.sessionId)
      if (!session || session.archivedAt) throw new SessionStoreError('session_archived', 'Follow-up session is archived')
      if (thread.status !== 'idle') throw new SessionStoreError('turn_not_running', 'Thread already has an active turn')
      this.#assertPermissionSnapshotCurrent(input.policySnapshot, session)
      // Same turnless-orphan closure as beginTurn: before this turn's items.
      this.#repairOrphanImportedToolCallsInTxn(thread.id)
      const turnSequence = integer(this.#one(this.#db.prepare(
        'SELECT COALESCE(MAX(sequence),0)+1 AS next_sequence FROM turns WHERE thread_id=?',
      ), thread.id), 'next_sequence')
      if (turnSequence <= integer(followRow, 'after_turn_sequence')) {
        throw new FollowUpStoreError('invalid_follow_up', 'Follow-up requires a later canonical turn')
      }
      const goalId = nullableText(followRow, 'goal_id')
      const goalRevision = followRow.goal_revision === null ? null : integer(followRow, 'goal_revision')
      if (goalId !== null && goalRevision !== null && !this.#goalScopeMatches(thread.id, goalId, goalRevision)) {
        this.#setFollowUpTerminal(followRow, 'stale_goal', this.#now())
        return null
      }
      const now = observedNow
      const turnId = this.#idFactory()
      const executionId = this.#idFactory()
      const followUp = this.#followUp(followRow)
      this.#db.prepare(`
        INSERT INTO turns(id,thread_id,sequence,provider,model,effort,status,client_request_id,request_hash,started_at,goal_id,goal_revision)
        VALUES (?,?,?,?,?,?,'running',?,?,?,?,?)
      `).run(turnId, thread.id, turnSequence, input.provider, input.model, input.effort ?? null,
        `follow-up:${followUp.id}`, followUp.requestHash, now, goalId, goalRevision)
      this.#db.prepare(`
        INSERT INTO executions(id,session_id,thread_id,turn_id,parent_execution_id,spawn_item_id,kind,provider,model,adapter_version,status,policy_snapshot_json,budget_json,usage_json,lease_expires_at,started_at)
        VALUES (?,?,?,?,NULL,NULL,'root_turn',?,?,?,'running',?,?,?,?,?)
      `).run(executionId, thread.sessionId, thread.id, turnId, input.provider, input.model, input.adapterVersion,
        canonicalJson(input.policySnapshot), canonicalJson(input.budget ?? {}), canonicalJson({}), input.leaseExpiresAt ?? null, now)
      const items = this.#appendItems(thread.sessionId, thread.id, turnId, null, followUp.input, null, now)
      this.#db.prepare(`
        UPDATE follow_ups SET status='consumed',consumed_turn_id=?,consumed_item_ids_json=?,dispatch_owner=NULL,
          lease_expires_at=NULL,dispatch_kind=NULL,revision=revision+1,updated_at=?,consumed_at=? WHERE id=?
      `).run(turnId, canonicalJson(items.map((item) => item.id)), now, now, followUp.id)
      this.#db.prepare("UPDATE threads SET status='running',revision=revision+1,updated_at=? WHERE id=?").run(now, thread.id)
      this.#db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(now, thread.sessionId)
      if (goalId) this.#db.prepare('DELETE FROM goal_scheduler_leases WHERE goal_id=?').run(goalId)
      this.#appendStreamEvent(thread.sessionId, thread.id, turnId, 'turn_started', {
        turnId, executionId, provider: input.provider, model: input.model, effort: input.effort ?? null,
        itemIds: items.map((item) => item.id), followUpId: followUp.id,
      }, now)
      this.#appendFollowUpChanged(this.#followUp(this.#one(this.#db.prepare('SELECT * FROM follow_ups WHERE id=?'), followUp.id)), now)
      return {
        turn: this.getTurn(turnId) as CanonicalTurn,
        execution: this.#execution(this.#one(this.#db.prepare('SELECT * FROM executions WHERE id=?'), executionId)),
        initialItems: items,
        duplicate: false,
      }
    })
    if (!result) throw new GoalStoreError('stale_goal_revision', 'Follow-up Goal revision changed before delivery')
    return result
  }

  setTurnActivity(
    turnId: TurnId,
    status: Extract<CanonicalTurn['status'], 'running' | 'waiting_tool'>,
  ): CanonicalTurn {
    return this.#transaction('IMMEDIATE', () => {
      const row = this.#optional(this.#db.prepare('SELECT * FROM turns WHERE id=?'), turnId)
      if (!row) throw new SessionStoreError('not_found', `Turn not found: ${turnId}`)
      if (!ACTIVE_TURN_STATUSES.has(text(row, 'status'))) {
        throw new SessionStoreError('turn_not_running', 'Turn activity can only change while the turn is active')
      }
      const executionStatus = status === 'waiting_tool' ? 'waiting' : 'running'
      this.#db.prepare('UPDATE turns SET status=? WHERE id=?').run(status, turnId)
      this.#db.prepare('UPDATE executions SET status=? WHERE turn_id=?').run(executionStatus, turnId)
      this.#db.prepare("UPDATE threads SET status='running' WHERE id=?").run(text(row, 'thread_id'))
      return this.getTurn(turnId) as CanonicalTurn
    })
  }

  appendProviderEvent(input: AppendEventInput): CanonicalItem[] {
    return this.#transaction('IMMEDIATE', () => {
      const duplicate = this.#optional(
        this.#db.prepare('SELECT item_ids_json FROM provider_events WHERE turn_id=? AND event_id=?'),
        input.turnId,
        input.eventId,
      )
      if (duplicate) return this.#itemsByIds(JSON.parse(text(duplicate, 'item_ids_json')) as string[])

      const row = this.#optional(this.#db.prepare(`
        SELECT turns.*, threads.session_id AS session_id FROM turns
        JOIN threads ON threads.id=turns.thread_id WHERE turns.id=?
      `), input.turnId)
      if (!row) throw new SessionStoreError('not_found', `Turn not found: ${input.turnId}`)
      if (!ACTIVE_TURN_STATUSES.has(text(row, 'status'))) {
        throw new SessionStoreError('turn_not_running', 'Provider event requires an active turn')
      }
      const now = this.#now()
      const items = this.#appendItems(text(row, 'session_id'), text(row, 'thread_id'), input.turnId,
        text(row, 'provider') as CanonicalProvider, input.items, input.eventId, now)
      this.#db.prepare('INSERT INTO provider_events(turn_id,event_id,item_ids_json,created_at) VALUES (?,?,?,?)')
        .run(input.turnId, input.eventId, canonicalJson(items.map((item) => item.id)), now)
      if (items.length > 0) {
        this.#appendStreamEvent(text(row, 'session_id'), text(row, 'thread_id'), input.turnId, 'items_appended', {
          eventId: input.eventId,
          itemIds: items.map((item) => item.id),
        }, now)
      }
      return items
    })
  }

  reconcileTool(input: ReconcileToolInput): ReconcileToolResult {
    validateToolReconciliation(input)
    return this.#transaction('IMMEDIATE', () => {
      const turn = this.#optional(this.#db.prepare(`
        SELECT turns.*,threads.session_id AS session_id FROM turns
        JOIN threads ON threads.id=turns.thread_id WHERE turns.id=?
      `), input.turnId)
      if (!turn) throw new SessionStoreError('not_found', `Turn not found: ${input.turnId}`)
      const turnError = parseNullableObject(turn.error_json)
      if (text(turn, 'status') !== 'interrupted' || turnError?.code !== 'unknown_mutation_outcome') {
        throw new SessionStoreError(
          'invalid_reconciliation',
          'Tool reconciliation requires an interrupted unknown-mutation turn',
        )
      }

      const rows = this.#all(this.#db.prepare(
        "SELECT * FROM items WHERE turn_id=? AND kind IN ('tool_call','tool_result') ORDER BY sequence",
      ), input.turnId)
      const note = input.note ?? null
      for (const row of rows) {
        if (text(row, 'kind') !== 'tool_result') continue
        const payload = parseObject(row.payload_json)
        if (payload.callId !== input.callId) continue
        const reconciliation = objectValue(payload.reconciliation)
        if (reconciliation) {
          if (reconciliation.resolution === input.resolution && (reconciliation.note ?? null) === note) {
            return { item: this.#item(row), duplicate: true }
          }
          throw new SessionStoreError(
            'reconciliation_conflict',
            'Tool call was already reconciled with a different resolution or note',
          )
        }
        throw new SessionStoreError('invalid_reconciliation', 'Tool call already has a canonical result')
      }

      const callRow = rows.find((row) => {
        if (text(row, 'kind') !== 'tool_call') return false
        return parseObject(row.payload_json).callId === input.callId
      })
      if (!callRow) throw new SessionStoreError('invalid_reconciliation', 'Unresolved tool call was not found')
      const call = parseObject(callRow.payload_json)
      if (call.sideEffect !== 'workspace_mutation' && call.sideEffect !== 'workspace_command'
        && call.sideEffect !== 'host_mutation') {
        throw new SessionStoreError(
          'invalid_reconciliation',
          'Only unresolved mutating or command tool calls can be reconciled',
        )
      }
      const providerCallId = typeof call.providerCallId === 'string' ? call.providerCallId : null
      const toolName = typeof call.name === 'string' ? call.name : null
      if (!providerCallId || !toolName) throw new Error('Corrupt database: tool call identity is incomplete')

      const now = this.#now()
      const reconciliation = { resolution: input.resolution, note }
      const result = reconciliationToolResult(input.resolution, note)
      const [item] = this.#appendItems(
        text(turn, 'session_id'),
        text(turn, 'thread_id'),
        input.turnId,
        text(turn, 'provider') as CanonicalProvider,
        [{
          kind: 'tool_result',
          visibility: 'portable',
          nativeId: providerCallId,
          payload: {
            callId: input.callId,
            providerCallId,
            toolName,
            reconciliation,
            result,
          },
        }],
        `baton:reconcile:${input.callId}`,
        now,
      )
      if (!item) throw new Error('Tool reconciliation failed to append its canonical result')
      this.#db.prepare('UPDATE threads SET revision=revision+1,updated_at=? WHERE id=?')
        .run(now, text(turn, 'thread_id'))
      this.#db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(now, text(turn, 'session_id'))
      this.#appendStreamEvent(
        text(turn, 'session_id'),
        text(turn, 'thread_id'),
        input.turnId,
        'items_appended',
        { itemIds: [item.id], reconciliation: true },
        now,
      )
      return { item, duplicate: false }
    })
  }

  finishTurn(input: FinishTurnInput): CanonicalTurn {
    return this.#transaction('IMMEDIATE', () => {
      const row = this.#optional(this.#db.prepare(`
        SELECT turns.*, threads.session_id AS session_id FROM turns
        JOIN threads ON threads.id=turns.thread_id WHERE turns.id=?
      `), input.turnId)
      if (!row) throw new SessionStoreError('not_found', `Turn not found: ${input.turnId}`)
      const desiredUsage = input.usage ?? null
      const desiredError = input.error ?? null
      const status = text(row, 'status')
      if (TERMINAL_TURN_STATUSES.has(status)) {
        const same = status === input.status
          && canonicalJson(parseNullableObject(row.usage_json)) === canonicalJson(desiredUsage)
          && canonicalJson(parseNullableObject(row.error_json)) === canonicalJson(desiredError)
        if (same) return this.#turn(row)
        throw new SessionStoreError('turn_not_running', 'Turn already finished with a different result')
      }
      if (!ACTIVE_TURN_STATUSES.has(status)) throw new SessionStoreError('turn_not_running', 'Turn is not active')

      const now = this.#now()
      this.#closeFollowUpWindow(input.turnId, now)
      this.#db.prepare('UPDATE turns SET status=?,completed_at=?,usage_json=?,error_json=? WHERE id=?')
        .run(input.status, now, desiredUsage === null ? null : canonicalJson(desiredUsage),
          desiredError === null ? null : canonicalJson(desiredError), input.turnId)
      this.#db.prepare('UPDATE executions SET status=?,completed_at=?,usage_json=? WHERE turn_id=?')
        .run(input.status, now, canonicalJson(desiredUsage ?? {}), input.turnId)
      this.#db.prepare("UPDATE threads SET status='idle',revision=revision+1,updated_at=? WHERE id=?")
        .run(now, text(row, 'thread_id'))
      this.#db.prepare(`
        UPDATE provider_bindings SET invalidated_at=?,updated_at=?
        WHERE thread_id=? AND invalidated_at IS NULL
      `).run(now, now, text(row, 'thread_id'))
      this.#db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(now, text(row, 'session_id'))
      const eventType: CanonicalStreamEventType = input.status === 'completed'
        ? 'turn_completed'
        : input.status === 'cancelled'
          ? 'turn_cancelled'
          : input.status === 'interrupted'
            ? 'turn_interrupted'
            : 'turn_failed'
      this.#appendStreamEvent(text(row, 'session_id'), text(row, 'thread_id'), input.turnId, eventType, {
        status: input.status,
        usage: desiredUsage,
        error: desiredError,
      }, now)
      return this.getTurn(input.turnId) as CanonicalTurn
    })
  }

  enqueueFollowUp(input: EnqueueFollowUpInput): EnqueueFollowUpResult {
    validateFollowUpInput(input)
    return this.#transaction('IMMEDIATE', () => {
      const duplicateRow = this.#optional(this.#db.prepare(`
        SELECT * FROM follow_ups WHERE thread_id=? AND client_request_id=?
      `), input.threadId, input.clientRequestId)
      if (duplicateRow) {
        if (text(duplicateRow, 'request_hash') !== input.requestHash) {
          throw new SessionStoreError('duplicate_request', 'Follow-up request ID was reused with different content')
        }
        return { followUp: this.#followUp(duplicateRow), duplicate: true }
      }

      const thread = this.getThread(input.threadId)
      if (!thread) throw new SessionStoreError('not_found', `Thread not found: ${input.threadId}`)
      const session = this.getSession(thread.sessionId)
      if (!session) throw new SessionStoreError('not_found', `Session not found: ${thread.sessionId}`)
      if (session.archivedAt) throw new SessionStoreError('session_archived', 'Archived sessions cannot accept follow-ups')

      if (input.targetTurnId !== null) {
        const target = this.#optional(this.#db.prepare('SELECT * FROM turns WHERE id=?'), input.targetTurnId)
        if (!target || text(target, 'thread_id') !== thread.id) {
          throw new FollowUpStoreError('invalid_follow_up', 'Follow-up target turn is not in the thread')
        }
        if (!ACTIVE_TURN_STATUSES.has(text(target, 'status')) || text(target, 'follow_up_window') !== 'accepting') {
          throw new FollowUpStoreError('invalid_follow_up', 'Follow-up target turn is not accepting input')
        }
      }

      const goalMatches = input.scope.kind === 'conversation'
        || this.#goalScopeMatches(thread.id, input.scope.goalId, input.scope.revision)
      const status: CanonicalFollowUp['status'] = goalMatches ? 'queued' : 'stale_goal'
      const sequence = integer(this.#one(this.#db.prepare(`
        SELECT COALESCE(MAX(sequence),0)+1 AS next_sequence FROM follow_ups WHERE thread_id=?
      `), thread.id), 'next_sequence')
      const afterTurnSequence = integer(this.#one(this.#db.prepare(`
        SELECT COALESCE(MAX(sequence),0) AS current_sequence FROM turns WHERE thread_id=?
      `), thread.id), 'current_sequence')
      const id = this.#idFactory()
      const now = this.#now()
      const goalId = input.scope.kind === 'goal' ? input.scope.goalId : null
      const goalRevision = input.scope.kind === 'goal' ? input.scope.revision : null
      this.#db.prepare(`
        INSERT INTO follow_ups(
          id,session_id,thread_id,client_request_id,request_hash,sequence,after_turn_sequence,delivery,status,
          target_turn_id,goal_id,goal_revision,input_json,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(id, thread.sessionId, thread.id, input.clientRequestId, input.requestHash, sequence, afterTurnSequence,
        input.delivery, status, input.targetTurnId, goalId, goalRevision, canonicalJson(input.input), now, now)
      this.#db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(now, thread.sessionId)
      const followUp = this.#followUp(this.#one(this.#db.prepare('SELECT * FROM follow_ups WHERE id=?'), id))
      this.#appendFollowUpChanged(followUp, now)
      return { followUp, duplicate: false }
    })
  }

  listFollowUps(threadId: ThreadId): CanonicalFollowUp[] {
    return this.#all(this.#db.prepare('SELECT * FROM follow_ups WHERE thread_id=? ORDER BY sequence'), threadId)
      .map((row) => this.#followUp(row))
  }

  getFollowUpByClientRequest(threadId: string, clientRequestId: string): CanonicalFollowUp | null {
    const row = this.#optional(this.#db.prepare(
      'SELECT * FROM follow_ups WHERE thread_id=? AND client_request_id=?',
    ), threadId, clientRequestId)
    return row ? this.#followUp(row) : null
  }

  claimFollowUp(input: ClaimFollowUpInput): CanonicalFollowUp | null {
    const duration = validateFollowUpLeaseDuration(input.leaseDurationMs ?? DEFAULT_FOLLOW_UP_LEASE_MS)
    if (!input.ownerId) throw new FollowUpStoreError('invalid_follow_up', 'Follow-up lease owner must not be empty')
    if (input.purpose === 'steer' && !input.targetTurnId) {
      throw new FollowUpStoreError('invalid_follow_up', 'A steer claim requires a target turn')
    }
    return this.#transaction('IMMEDIATE', () => {
      const thread = this.getThread(input.threadId)
      if (!thread) throw new SessionStoreError('not_found', `Thread not found: ${input.threadId}`)
      this.#markStaleGoalFollowUps(thread.id, this.#now())
      const row = this.#optional(this.#db.prepare(`
        SELECT * FROM follow_ups WHERE thread_id=? AND status IN ('queued','dispatching')
        ORDER BY sequence LIMIT 1
      `), thread.id)
      if (!row) return null
      if (text(row, 'status') === 'dispatching') return null
      const targetTurnId = nullableText(row, 'target_turn_id')
      if (input.purpose === 'steer') {
        if (text(row, 'delivery') !== 'steer_or_queue' || targetTurnId !== input.targetTurnId) return null
        const target = this.#optional(this.#db.prepare('SELECT * FROM turns WHERE id=?'), input.targetTurnId as string)
        if (!target || !ACTIVE_TURN_STATUSES.has(text(target, 'status'))
          || text(target, 'follow_up_window') !== 'accepting') return null
      } else if (targetTurnId !== null) {
        return null
      }
      const now = this.#now()
      const expiresAt = new Date(Date.parse(now) + duration).toISOString()
      const changed = this.#db.prepare(`
        UPDATE follow_ups SET status='dispatching',dispatch_owner=?,lease_expires_at=?,dispatch_kind=?,
          revision=revision+1,updated_at=? WHERE id=? AND status='queued'
      `).run(input.ownerId, expiresAt, input.purpose, now, text(row, 'id')).changes
      if (changed !== 1) return null
      const claimed = this.#followUp(this.#one(this.#db.prepare('SELECT * FROM follow_ups WHERE id=?'), text(row, 'id')))
      this.#appendFollowUpChanged(claimed, now)
      return claimed
    })
  }

  consumeFollowUp(input: ConsumeFollowUpInput): ConsumeFollowUpResult {
    if (!input.ownerId) throw new FollowUpStoreError('invalid_follow_up', 'Follow-up lease owner must not be empty')
    return this.#transaction('IMMEDIATE', () => {
      const row = this.#optional(this.#db.prepare('SELECT * FROM follow_ups WHERE id=?'), input.followUpId)
      if (!row) throw new SessionStoreError('not_found', `Follow-up not found: ${input.followUpId}`)
      if (text(row, 'status') === 'consumed') {
        const followUp = this.#followUp(row)
        if (followUp.consumedTurnId !== input.turnId) {
          throw new FollowUpStoreError('invalid_follow_up', 'Follow-up was consumed by a different turn')
        }
        return { status: 'consumed', followUp, items: this.#itemsByIds(followUp.consumedItemIds) }
      }
      const now = this.#now()
      if (text(row, 'status') !== 'dispatching' || nullableText(row, 'dispatch_owner') !== input.ownerId
        || (nullableText(row, 'lease_expires_at') ?? '') <= now) {
        throw new FollowUpStoreError('follow_up_lease_lost', 'Follow-up claim is missing, expired, or owned elsewhere')
      }

      const turn = this.#optional(this.#db.prepare(`
        SELECT turns.*,threads.session_id AS session_id FROM turns
        JOIN threads ON threads.id=turns.thread_id WHERE turns.id=?
      `), input.turnId)
      if (!turn || text(turn, 'thread_id') !== text(row, 'thread_id')) {
        throw new FollowUpStoreError('invalid_follow_up', 'Consume turn is not in the follow-up thread')
      }
      const targetTurnId = nullableText(row, 'target_turn_id')
      if (targetTurnId !== null && targetTurnId !== input.turnId) {
        throw new FollowUpStoreError('invalid_follow_up', 'Claimed follow-up targets a different turn')
      }

      const goalId = nullableText(row, 'goal_id')
      const goalRevision = row.goal_revision === null ? null : integer(row, 'goal_revision')
      if (goalId !== null && goalRevision !== null
        && (!this.#goalScopeMatches(text(row, 'thread_id'), goalId, goalRevision)
          || nullableText(turn, 'goal_id') !== goalId || turn.goal_revision !== goalRevision)) {
        const stale = this.#setFollowUpTerminal(row, 'stale_goal', now)
        return { status: 'stale_goal', followUp: stale, items: [] }
      }
      if (!ACTIVE_TURN_STATUSES.has(text(turn, 'status'))) {
        const queued = this.#requeueClaimedFollowUp(row, input.ownerId, null, now)
        return { status: 'queued', followUp: queued, items: [] }
      }
      if (targetTurnId === null && integer(turn, 'sequence') <= integer(row, 'after_turn_sequence')) {
        const queued = this.#requeueClaimedFollowUp(row, input.ownerId, null, now)
        return { status: 'queued', followUp: queued, items: [] }
      }

      const followUp = this.#followUp(row)
      const items = this.#appendItems(text(turn, 'session_id'), text(row, 'thread_id'), input.turnId,
        null, followUp.input, null, now)
      this.#db.prepare(`
        UPDATE follow_ups SET status='consumed',consumed_turn_id=?,consumed_item_ids_json=?,
          dispatch_owner=NULL,lease_expires_at=NULL,dispatch_kind=NULL,revision=revision+1,updated_at=?,consumed_at=?
        WHERE id=? AND status='dispatching' AND dispatch_owner=?
      `).run(input.turnId, canonicalJson(items.map((item) => item.id)), now, now, followUp.id, input.ownerId)
      const consumed = this.#followUp(this.#one(this.#db.prepare('SELECT * FROM follow_ups WHERE id=?'), followUp.id))
      this.#appendStreamEvent(text(turn, 'session_id'), text(row, 'thread_id'), input.turnId, 'items_appended', {
        followUpId: followUp.id,
        itemIds: items.map((item) => item.id),
      }, now)
      this.#appendFollowUpChanged(consumed, now)
      return { status: 'consumed', followUp: consumed, items }
    })
  }

  requeueFollowUp(input: RequeueFollowUpInput): CanonicalFollowUp {
    if (!input.ownerId) throw new FollowUpStoreError('invalid_follow_up', 'Follow-up lease owner must not be empty')
    return this.#transaction('IMMEDIATE', () => {
      const row = this.#optional(this.#db.prepare('SELECT * FROM follow_ups WHERE id=?'), input.followUpId)
      if (!row) throw new SessionStoreError('not_found', `Follow-up not found: ${input.followUpId}`)
      const now = this.#now()
      return this.#requeueClaimedFollowUp(row, input.ownerId, input.targetTurnId ?? null, now)
    })
  }

  closeFollowUpWindow(turnId: TurnId): CloseFollowUpWindowResult {
    return this.#transaction('IMMEDIATE', () => {
      const turn = this.#optional(this.#db.prepare('SELECT * FROM turns WHERE id=?'), turnId)
      if (!turn) throw new SessionStoreError('not_found', `Turn not found: ${turnId}`)
      return this.#closeFollowUpWindow(turnId, this.#now())
    })
  }

  markStaleGoalFollowUps(threadId: ThreadId): number {
    return this.#transaction('IMMEDIATE', () => {
      if (!this.getThread(threadId)) throw new SessionStoreError('not_found', `Thread not found: ${threadId}`)
      return this.#markStaleGoalFollowUps(threadId, this.#now())
    })
  }

  recoverExpiredFollowUpClaims(cutoffIso = this.#now()): number {
    if (!Number.isFinite(Date.parse(cutoffIso))) {
      throw new FollowUpStoreError('invalid_follow_up', 'Follow-up recovery cutoff must be an ISO timestamp')
    }
    return this.#transaction('IMMEDIATE', () => {
      const rows = this.#all(this.#db.prepare(`
        SELECT * FROM follow_ups WHERE status='dispatching' AND lease_expires_at<=?
        ORDER BY thread_id,sequence
      `), cutoffIso)
      let recovered = 0
      for (const row of rows) {
        const now = this.#now()
        if (nullableText(row, 'dispatch_kind') === 'steer') {
          this.#setFollowUpTerminal(row, 'delivery_unknown', now)
          recovered += 1
          continue
        }
        const goalId = nullableText(row, 'goal_id')
        const goalRevision = row.goal_revision === null ? null : integer(row, 'goal_revision')
        if (goalId !== null && goalRevision !== null
          && !this.#goalScopeMatches(text(row, 'thread_id'), goalId, goalRevision)) {
          this.#setFollowUpTerminal(row, 'stale_goal', now)
        } else {
          const targetId = nullableText(row, 'target_turn_id')
          const target = targetId === null ? null
            : this.#optional(this.#db.prepare('SELECT * FROM turns WHERE id=?'), targetId)
          const retainedTarget = target && ACTIVE_TURN_STATUSES.has(text(target, 'status'))
            && text(target, 'follow_up_window') === 'accepting' ? targetId : null
          this.#db.prepare(`
            UPDATE follow_ups SET status='queued',target_turn_id=?,dispatch_owner=NULL,lease_expires_at=NULL,dispatch_kind=NULL,
              revision=revision+1,updated_at=? WHERE id=? AND status='dispatching'
          `).run(retainedTarget, now, text(row, 'id'))
          const queued = this.#followUp(this.#one(this.#db.prepare('SELECT * FROM follow_ups WHERE id=?'), text(row, 'id')))
          this.#appendFollowUpChanged(queued, now)
        }
        recovered += 1
      }
      return recovered
    })
  }

  cancelFollowUp(followUpId: string, expectedRevision: number): CanonicalFollowUp {
    return this.#transaction('IMMEDIATE', () => {
      const row = this.#optional(this.#db.prepare('SELECT * FROM follow_ups WHERE id=?'), followUpId)
      if (!row) throw new SessionStoreError('not_found', `Follow-up not found: ${followUpId}`)
      if (integer(row, 'revision') !== expectedRevision) {
        throw new SessionStoreError('revision_conflict', 'Follow-up revision changed after it was observed')
      }
      if (text(row, 'status') !== 'queued' && text(row, 'status') !== 'stale_goal') {
        throw new FollowUpStoreError('invalid_follow_up', 'Only queued or stale follow-ups can be cancelled')
      }
      return this.#setFollowUpTerminal(row, 'cancelled', this.#now())
    })
  }

  markFollowUpDeliveryUnknown(followUpId: string, ownerId: string): CanonicalFollowUp {
    return this.#transaction('IMMEDIATE', () => {
      const row = this.#optional(this.#db.prepare('SELECT * FROM follow_ups WHERE id=?'), followUpId)
      if (!row) throw new SessionStoreError('not_found', `Follow-up not found: ${followUpId}`)
      const dispatchOwned = text(row, 'status') === 'dispatching' && nullableText(row, 'dispatch_owner') === ownerId
      if (!dispatchOwned && text(row, 'status') !== 'queued') {
        throw new FollowUpStoreError('follow_up_lease_lost', 'Follow-up delivery claim is no longer owned')
      }
      return this.#setFollowUpTerminal(row, 'delivery_unknown', this.#now())
    })
  }

  markTurnFollowUpsDeliveryUnknown(turnId: string): number {
    return this.#transaction('IMMEDIATE', () => {
      const rows = this.#all(this.#db.prepare(`
        SELECT * FROM follow_ups WHERE target_turn_id=? AND status='dispatching' ORDER BY sequence
      `), turnId)
      const now = this.#now()
      for (const row of rows) this.#setFollowUpTerminal(row, 'delivery_unknown', now)
      return rows.length
    })
  }

  upsertProviderBinding(input: UpsertProviderBindingInput): ProviderBinding {
    if (input.opaqueStateEncrypted != null) {
      throw new Error('Provider opaque state cannot be stored until at-rest encryption is configured')
    }
    return this.#transaction('IMMEDIATE', () => {
      const thread = this.getThread(input.threadId)
      if (!thread) throw new SessionStoreError('not_found', `Thread not found: ${input.threadId}`)
      if (thread.revision !== input.syncedRevision) {
        throw new SessionStoreError(
          'revision_conflict',
          `Binding revision ${input.syncedRevision} does not match thread revision ${thread.revision}`,
        )
      }
      const capabilities = canonicalJson(input.capabilities)
      const existing = this.#optional(this.#db.prepare(
        'SELECT * FROM provider_bindings WHERE thread_id=? AND provider=? AND invalidated_at IS NULL',
      ), input.threadId, input.provider)
      const now = this.#now()
      if (existing && text(existing, 'model_family') === input.modelFamily
        && text(existing, 'capabilities_json') === capabilities
        && (integer(existing, 'synced_revision') < input.syncedRevision
          || text(existing, 'context_digest') === input.contextDigest)) {
        const nativeThreadId = input.nativeThreadId === undefined ? nullableText(existing, 'native_thread_id') : input.nativeThreadId
        const nativeResponseId = input.nativeResponseId === undefined ? nullableText(existing, 'native_response_id') : input.nativeResponseId
        this.#db.prepare(`
          UPDATE provider_bindings
          SET native_thread_id=?,native_response_id=?,synced_revision=?,context_digest=?,updated_at=? WHERE id=?
        `).run(nativeThreadId, nativeResponseId, input.syncedRevision, input.contextDigest, now, text(existing, 'id'))
        return this.#binding(this.#one(this.#db.prepare('SELECT * FROM provider_bindings WHERE id=?'), text(existing, 'id')))
      }
      if (existing) {
        this.#db.prepare('UPDATE provider_bindings SET invalidated_at=?,updated_at=? WHERE id=?')
          .run(now, now, text(existing, 'id'))
      }
      const id = this.#idFactory()
      this.#db.prepare(`
        INSERT INTO provider_bindings(id,thread_id,provider,model_family,native_thread_id,native_response_id,opaque_state_encrypted,capabilities_json,synced_revision,context_digest,updated_at,invalidated_at)
        VALUES (?,?,?,?,?,?,NULL,?,?,?,?,NULL)
      `).run(id, input.threadId, input.provider, input.modelFamily, input.nativeThreadId ?? null,
        input.nativeResponseId ?? null, capabilities, input.syncedRevision, input.contextDigest, now)
      return this.#binding(this.#one(this.#db.prepare('SELECT * FROM provider_bindings WHERE id=?'), id))
    })
  }

  listItems(threadId: ThreadId, afterSequence = 0): CanonicalItem[] {
    const thread = this.getThread(threadId)
    if (!thread) throw new SessionStoreError('not_found', `Thread not found: ${threadId}`)
    return this.#itemsForSegments(this.#lineage(thread), afterSequence)
  }

  createContextCompactionJob(input: CreateContextCompactionJobInput): {
    job: ContextCompactionJob
    duplicate: boolean
  } {
    return this.#persistContextCompactionJob(input, null)
  }

  reserveContextCompactionJob(input: ReserveContextCompactionJobInput): {
    job: ContextCompactionJob
    duplicate: boolean
  } {
    const leaseDurationMs = this.#validateContextCompactionLease(input.ownerId, input.leaseDurationMs)
    return this.#persistContextCompactionJob(input, { ownerId: input.ownerId, leaseDurationMs })
  }

  #persistContextCompactionJob(
    input: CreateContextCompactionJobInput,
    claim: { ownerId: string; leaseDurationMs: number } | null,
  ): { job: ContextCompactionJob; duplicate: boolean } {
    if (!input.requestKey || input.requestKey.length > 200) {
      throw new ContextPersistenceError('invalid_input', 'Compaction requestKey must contain 1 to 200 characters')
    }
    const viewKey = input.viewKey ?? LEGACY_CONTEXT_VIEW_KEY
    if (!viewKey || viewKey.length > 120) {
      throw new ContextPersistenceError('invalid_input', 'Compaction viewKey must contain 1 to 120 characters')
    }
    validateSha256(input.summaryInputHash, 'summaryInputHash')
    return this.#transaction('IMMEDIATE', () => {
      const sourceItems = this.#resolveCompactionSource(input.threadId, input.sourceItemIds)
      const sourceHash = this.#sourceHashForItems(sourceItems)
      const requestHash = sha256Canonical({
        schema: 'baton.context-compaction-request.v2',
        threadId: input.threadId,
        viewKey,
        sourceItemIds: input.sourceItemIds,
        sourceHash,
        summaryInputHash: input.summaryInputHash,
        expectedPreviousArtifactId: input.expectedPreviousArtifactId,
      })
      const existing = this.#optional(this.#db.prepare(`
        SELECT * FROM context_compaction_jobs WHERE thread_id=? AND request_key=?
      `), input.threadId, input.requestKey)
      const now = this.#now()
      const head = this.#ensureContextCompactionHead(input.threadId, viewKey, now)
      const latestArtifactId = nullableText(head, 'compaction_id')
      if (existing) {
        if (text(existing, 'view_key') !== viewKey
          || text(existing, 'request_hash') !== requestHash) {
          throw new ContextPersistenceError(
            'idempotency_conflict',
            'Compaction requestKey was reused with different source or generator input',
          )
        }
        if (text(existing, 'status') === 'completed') {
          const completedArtifact = this.#one(
            this.#db.prepare('SELECT id FROM context_compactions WHERE job_id=?'),
            text(existing, 'id'),
          )
          if (latestArtifactId !== text(completedArtifact, 'id')) {
            throw new ContextPersistenceError(
              'stale_frontier',
              'Completed duplicate is no longer the current compaction frontier',
            )
          }
          return this.#contextCompactionReservationResult(existing, true, claim, now)
        }
        if (latestArtifactId !== input.expectedPreviousArtifactId) {
          throw new ContextPersistenceError(
            'stale_frontier',
            'Compaction artifact frontier changed before the duplicate request was resumed',
          )
        }
        if (text(existing, 'status') !== 'failed') {
          return this.#contextCompactionReservationResult(existing, true, claim, now)
        }
      }
      if (latestArtifactId !== input.expectedPreviousArtifactId) {
        throw new ContextPersistenceError(
          'stale_frontier',
          'Compaction artifact frontier changed before the request was persisted',
        )
      }
      if (input.expectedPreviousArtifactId !== null) {
        const previousRow = this.#one(
          this.#db.prepare('SELECT * FROM context_compactions WHERE id=?'),
          input.expectedPreviousArtifactId,
        )
        const previous = this.#contextCompactionArtifact(previousRow)
        if (previous.viewKey !== viewKey) {
          throw new ContextPersistenceError(
            'invalid_input',
            'Compaction frontier belongs to a different context view',
          )
        }
        const previousSourceIds = previous.sourceItems.map((item) => item.itemId)
        if (sourceItems.length <= previousSourceIds.length
          || previousSourceIds.some((id, index) => sourceItems[index]?.itemId !== id)) {
          throw new ContextPersistenceError(
            'invalid_input',
            'Compaction source must strictly extend the expected frontier coverage',
          )
        }
      }
      if (claim !== null) {
        this.#recoverAbandonedContextCompactionFrontier(
          input.threadId,
          viewKey,
          input.expectedPreviousArtifactId,
          existing ? text(existing, 'id') : null,
          input.requestKey,
          now,
        )
      }
      const competing = this.#optional(this.#db.prepare(`
        SELECT id FROM context_compaction_jobs
        WHERE thread_id=? AND view_key=? AND expected_previous_artifact_id IS ?
          AND status IN ('queued','running')
          AND id IS NOT ?
        LIMIT 1
      `), input.threadId, viewKey, input.expectedPreviousArtifactId,
      existing ? text(existing, 'id') : null)
      if (competing) {
        throw new ContextPersistenceError(
          'stale_frontier',
          'Another compaction request already owns the expected artifact frontier',
        )
      }
      if (existing) {
        this.#db.prepare(`
          UPDATE context_compaction_jobs SET status='queued',revision=revision+1,
            lease_owner=NULL,lease_expires_at=NULL,error_json=NULL,updated_at=?,completed_at=NULL
          WHERE id=?
        `).run(now, text(existing, 'id'))
        const retried = this.#one(
          this.#db.prepare('SELECT * FROM context_compaction_jobs WHERE id=?'),
          text(existing, 'id'),
        )
        this.#appendContextCompactionJobEvent(retried, { reason: 'retry_failed' }, now)
        return this.#contextCompactionReservationResult(retried, true, claim, now)
      }
      const id = this.#idFactory()
      this.#db.prepare(`
        INSERT INTO context_compaction_jobs(
          id,thread_id,view_key,request_key,request_hash,source_item_ids_json,source_hash,summary_input_hash,
          expected_previous_artifact_id,
          status,revision,lease_owner,lease_expires_at,attempt_count,error_json,created_at,updated_at,completed_at
        ) VALUES (?,?,?,?,?,?,?,?,?,'queued',1,NULL,NULL,0,NULL,?,?,NULL)
      `).run(id, input.threadId, viewKey, input.requestKey, requestHash,
        canonicalJson(input.sourceItemIds), sourceHash,
        input.summaryInputHash, input.expectedPreviousArtifactId, now, now)
      const inserted = this.#one(this.#db.prepare('SELECT * FROM context_compaction_jobs WHERE id=?'), id)
      this.#appendContextCompactionJobEvent(inserted, {}, now)
      return this.#contextCompactionReservationResult(inserted, false, claim, now)
    })
  }

  #validateContextCompactionLease(ownerId: string, requestedDurationMs: number | undefined): number {
    if (!ownerId) throw new ContextPersistenceError('invalid_input', 'Compaction lease owner must not be empty')
    const leaseDurationMs = requestedDurationMs ?? 30_000
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 1 || leaseDurationMs > 300_000) {
      throw new ContextPersistenceError('invalid_input', 'Compaction lease duration must be 1 to 300000 milliseconds')
    }
    return leaseDurationMs
  }

  #contextCompactionReservationResult(
    row: SqlRow,
    duplicate: boolean,
    claim: { ownerId: string; leaseDurationMs: number } | null,
    now: string,
  ): { job: ContextCompactionJob; duplicate: boolean } {
    const claimed = claim === null ? row : this.#claimContextCompactionJobRow(row, claim, now)
    return { job: this.#contextCompactionJob(claimed ?? row), duplicate }
  }

  #recoverAbandonedContextCompactionFrontier(
    threadId: ThreadId,
    viewKey: string,
    expectedPreviousArtifactId: string | null,
    exactJobId: string | null,
    replacementRequestKey: string,
    now: string,
  ): void {
    const competing = this.#optional(this.#db.prepare(`
      SELECT * FROM context_compaction_jobs
      WHERE thread_id=? AND view_key=? AND expected_previous_artifact_id IS ?
        AND status IN ('queued','running') AND id IS NOT ?
      LIMIT 1
    `), threadId, viewKey, expectedPreviousArtifactId, exactJobId)
    if (!competing) return
    if (text(competing, 'status') === 'running' && nullableText(competing, 'lease_expires_at')! > now) {
      throw new ContextPersistenceError(
        'stale_frontier',
        'Another compaction request already owns the expected artifact frontier',
      )
    }

    const recoveryOwner = `baton-recovery:${replacementRequestKey.slice(0, 64)}`
    const recovered = this.#claimContextCompactionJobRow(
      competing,
      { ownerId: recoveryOwner, leaseDurationMs: 1 },
      now,
    )
    if (!recovered || text(recovered, 'status') !== 'running'
      || nullableText(recovered, 'lease_owner') !== recoveryOwner) {
      throw new ContextPersistenceError('integrity_violation', 'Abandoned compaction frontier could not be recovered')
    }
    const reason = text(competing, 'status') === 'queued'
      ? 'orphaned_queued_reservation'
      : 'expired_competing_reservation'
    const error = { code: 'abandoned_reservation', reason }
    const errorJson = canonicalJson(error)
    this.#db.prepare(`
      UPDATE context_compaction_jobs SET status='failed',revision=revision+1,
        lease_owner=NULL,lease_expires_at=NULL,error_json=?,updated_at=?,completed_at=? WHERE id=?
    `).run(errorJson, now, now, text(recovered, 'id'))
    const failed = this.#one(
      this.#db.prepare('SELECT * FROM context_compaction_jobs WHERE id=?'),
      text(recovered, 'id'),
    )
    this.#appendContextCompactionJobEvent(
      failed,
      { reason, errorHash: sha256Canonical(error) },
      now,
    )
  }

  #claimContextCompactionJobRow(
    initial: SqlRow,
    input: { ownerId: string; leaseDurationMs: number },
    now: string,
  ): SqlRow | null {
    let row = initial
    const jobId = text(row, 'id')
    if (text(row, 'status') === 'running' && nullableText(row, 'lease_expires_at')! <= now) {
      this.#db.prepare(`
        UPDATE context_compaction_jobs SET status='queued',revision=revision+1,
          lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?
      `).run(now, jobId)
      row = this.#one(this.#db.prepare('SELECT * FROM context_compaction_jobs WHERE id=?'), jobId)
      this.#appendContextCompactionJobEvent(row, { reason: 'lease_expired' }, now)
    }
    if (text(row, 'status') === 'running') {
      if (nullableText(row, 'lease_owner') !== input.ownerId) return null
      const leaseExpiresAt = new Date(Date.parse(now) + input.leaseDurationMs).toISOString()
      this.#db.prepare(`
        UPDATE context_compaction_jobs SET revision=revision+1,lease_expires_at=?,updated_at=?
        WHERE id=?
      `).run(leaseExpiresAt, now, jobId)
      row = this.#one(this.#db.prepare('SELECT * FROM context_compaction_jobs WHERE id=?'), jobId)
      this.#appendContextCompactionJobEvent(row, { reason: 'lease_heartbeat' }, now)
      return row
    }
    if (text(row, 'status') !== 'queued') return null
    const leaseExpiresAt = new Date(Date.parse(now) + input.leaseDurationMs).toISOString()
    this.#db.prepare(`
      UPDATE context_compaction_jobs SET status='running',revision=revision+1,
        lease_owner=?,lease_expires_at=?,attempt_count=attempt_count+1,updated_at=? WHERE id=?
    `).run(input.ownerId, leaseExpiresAt, now, jobId)
    row = this.#one(this.#db.prepare('SELECT * FROM context_compaction_jobs WHERE id=?'), jobId)
    this.#appendContextCompactionJobEvent(row, { attemptCount: integer(row, 'attempt_count') }, now)
    return row
  }

  getContextCompactionJob(jobId: string): ContextCompactionJob | null {
    const row = this.#optional(this.#db.prepare('SELECT * FROM context_compaction_jobs WHERE id=?'), jobId)
    return row ? this.#contextCompactionJob(row) : null
  }

  claimContextCompactionJob(input: ClaimContextCompactionJobInput): ContextCompactionJob | null {
    const leaseDurationMs = this.#validateContextCompactionLease(input.ownerId, input.leaseDurationMs)
    return this.#transaction('IMMEDIATE', () => {
      const row = this.#optional(this.#db.prepare('SELECT * FROM context_compaction_jobs WHERE id=?'), input.jobId)
      if (!row) throw new ContextPersistenceError('not_found', `Compaction job not found: ${input.jobId}`)
      const now = this.#now()
      const claimed = this.#claimContextCompactionJobRow(row, { ownerId: input.ownerId, leaseDurationMs }, now)
      return claimed ? this.#contextCompactionJob(claimed) : null
    })
  }

  completeContextCompactionJob(input: CompleteContextCompactionJobInput): {
    artifact: ContextCompactionArtifact
    duplicate: boolean
  } {
    if (!input.ownerId || !input.generatorModel || !input.generatorVersion) {
      throw new ContextPersistenceError('invalid_input', 'Compaction owner, generator model, and version are required')
    }
    const summaryJson = canonicalJson(input.summary)
    return this.#transaction('IMMEDIATE', () => {
      const row = this.#optional(this.#db.prepare('SELECT * FROM context_compaction_jobs WHERE id=?'), input.jobId)
      if (!row) throw new ContextPersistenceError('not_found', `Compaction job not found: ${input.jobId}`)
      const sourceItems = this.#sourceItemsForJob(row)
      const artifactHash = sha256Canonical({
        schema: 'baton.context-compaction-artifact.v2',
        jobId: input.jobId,
        threadId: text(row, 'thread_id'),
        viewKey: text(row, 'view_key'),
        sourceHash: text(row, 'source_hash'),
        summaryInputHash: text(row, 'summary_input_hash'),
        expectedPreviousArtifactId: nullableText(row, 'expected_previous_artifact_id'),
        summary: JSON.parse(summaryJson) as unknown,
        generatorProvider: input.generatorProvider,
        generatorModel: input.generatorModel,
        generatorVersion: input.generatorVersion,
      })
      const legacyArtifactHash = sha256Canonical({
        schema: 'baton.context-compaction-artifact.v1',
        jobId: input.jobId,
        threadId: text(row, 'thread_id'),
        sourceHash: text(row, 'source_hash'),
        summaryInputHash: text(row, 'summary_input_hash'),
        expectedPreviousArtifactId: nullableText(row, 'expected_previous_artifact_id'),
        summary: JSON.parse(summaryJson) as unknown,
        generatorProvider: input.generatorProvider,
        generatorModel: input.generatorModel,
        generatorVersion: input.generatorVersion,
      })
      if (text(row, 'status') === 'completed') {
        const existing = this.#one(this.#db.prepare('SELECT * FROM context_compactions WHERE job_id=?'), input.jobId)
        if (text(existing, 'artifact_hash') !== artifactHash
          && !(text(row, 'view_key') === LEGACY_CONTEXT_VIEW_KEY
            && text(existing, 'artifact_hash') === legacyArtifactHash)) {
          throw new ContextPersistenceError('idempotency_conflict', 'Completed compaction has different artifact content')
        }
        return { artifact: this.#contextCompactionArtifact(existing), duplicate: true }
      }
      const now = this.#now()
      if (text(row, 'status') !== 'running' || nullableText(row, 'lease_owner') !== input.ownerId
        || nullableText(row, 'lease_expires_at')! <= now) {
        throw new ContextPersistenceError('lease_lost', 'Compaction lease is missing, expired, or owned elsewhere')
      }
      const viewKey = text(row, 'view_key')
      const head = this.#ensureContextCompactionHead(text(row, 'thread_id'), viewKey, now)
      const expectedPreviousArtifactId = nullableText(row, 'expected_previous_artifact_id')
      if (nullableText(head, 'compaction_id') !== expectedPreviousArtifactId) {
        throw new ContextPersistenceError('stale_frontier', 'Compaction head changed before artifact completion')
      }
      const artifactId = this.#idFactory()
      this.#db.prepare(`
        INSERT INTO context_compactions(
          id,job_id,thread_id,source_hash,summary_input_hash,artifact_hash,summary_json,
          generator_provider,generator_model,generator_version,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(artifactId, input.jobId, text(row, 'thread_id'), text(row, 'source_hash'),
        text(row, 'summary_input_hash'), artifactHash, summaryJson, input.generatorProvider,
        input.generatorModel, input.generatorVersion, now)
      const insertSource = this.#db.prepare(`
        INSERT INTO context_compaction_source_items(
          compaction_id,ordinal,item_id,item_sequence,item_digest
        ) VALUES (?,?,?,?,?)
      `)
      for (const source of sourceItems) {
        insertSource.run(artifactId, source.ordinal, source.itemId, source.itemSequence, source.itemDigest)
      }
      this.#db.prepare(`
        UPDATE context_compaction_jobs SET status='completed',revision=revision+1,
          lease_owner=NULL,lease_expires_at=NULL,updated_at=?,completed_at=? WHERE id=?
      `).run(now, now, input.jobId)
      const completed = this.#one(this.#db.prepare('SELECT * FROM context_compaction_jobs WHERE id=?'), input.jobId)
      this.#appendContextCompactionJobEvent(completed, { artifactId, artifactHash }, now)
      const nextHeadRevision = integer(head, 'revision') + 1
      const headHash = this.#contextCompactionHeadHash(
        text(row, 'thread_id'), viewKey, artifactId, nextHeadRevision,
      )
      const advanced = this.#db.prepare(`
        UPDATE context_compaction_heads
        SET compaction_id=?,revision=?,head_hash=?,updated_at=?
        WHERE thread_id=? AND view_key=? AND compaction_id IS ? AND revision=?
      `).run(artifactId, nextHeadRevision, headHash, now, text(row, 'thread_id'),
        viewKey, expectedPreviousArtifactId, integer(head, 'revision'))
      if (Number(advanced.changes) !== 1) {
        throw new ContextPersistenceError('stale_frontier', 'Compaction head compare-and-set failed')
      }
      return {
        artifact: this.#contextCompactionArtifact(this.#one(
          this.#db.prepare('SELECT * FROM context_compactions WHERE id=?'), artifactId,
        )),
        duplicate: false,
      }
    })
  }

  failContextCompactionJob(input: FailContextCompactionJobInput): ContextCompactionJob {
    if (!input.ownerId) throw new ContextPersistenceError('invalid_input', 'Compaction lease owner must not be empty')
    const errorJson = canonicalJson(input.error)
    return this.#transaction('IMMEDIATE', () => {
      const row = this.#optional(this.#db.prepare('SELECT * FROM context_compaction_jobs WHERE id=?'), input.jobId)
      if (!row) throw new ContextPersistenceError('not_found', `Compaction job not found: ${input.jobId}`)
      const now = this.#now()
      if (text(row, 'status') !== 'running' || nullableText(row, 'lease_owner') !== input.ownerId
        || nullableText(row, 'lease_expires_at')! <= now) {
        throw new ContextPersistenceError('lease_lost', 'Compaction lease is missing, expired, or owned elsewhere')
      }
      this.#db.prepare(`
        UPDATE context_compaction_jobs SET status='failed',revision=revision+1,
          lease_owner=NULL,lease_expires_at=NULL,error_json=?,updated_at=?,completed_at=? WHERE id=?
      `).run(errorJson, now, now, input.jobId)
      const failed = this.#one(this.#db.prepare('SELECT * FROM context_compaction_jobs WHERE id=?'), input.jobId)
      this.#appendContextCompactionJobEvent(
        failed,
        { errorHash: sha256Canonical(JSON.parse(errorJson) as unknown) },
        now,
      )
      return this.#contextCompactionJob(failed)
    })
  }

  getContextCompactionArtifact(compactionId: string): ContextCompactionArtifact | null {
    const row = this.#optional(this.#db.prepare('SELECT * FROM context_compactions WHERE id=?'), compactionId)
    return row ? this.#contextCompactionArtifact(row) : null
  }

  getLatestContextCompaction(
    threadId: ThreadId,
    viewKey = LEGACY_CONTEXT_VIEW_KEY,
  ): ContextCompactionArtifact | null {
    if (!this.getThread(threadId)) throw new ContextPersistenceError('not_found', `Thread not found: ${threadId}`)
    if (!viewKey || viewKey.length > 120) {
      throw new ContextPersistenceError('invalid_input', 'Compaction viewKey must contain 1 to 120 characters')
    }
    const head = this.#optional(this.#db.prepare(
      'SELECT * FROM context_compaction_heads WHERE thread_id=? AND view_key=?',
    ), threadId, viewKey)
    if (!head) {
      const artifact = this.#optional(this.#db.prepare(
        `SELECT c.id FROM context_compactions c
         JOIN context_compaction_jobs j ON j.id=c.job_id
         WHERE c.thread_id=? AND j.view_key=? LIMIT 1`,
      ), threadId, viewKey)
      if (artifact) throw new ContextPersistenceError('integrity_violation', 'Compaction head is missing')
      return null
    }
    this.#validateContextCompactionHead(head)
    const compactionId = nullableText(head, 'compaction_id')
    if (compactionId === null) return null
    const row = this.#optional(this.#db.prepare('SELECT * FROM context_compactions WHERE id=?'), compactionId)
    if (!row) throw new ContextPersistenceError('integrity_violation', 'Compaction head artifact is missing')
    return this.#contextCompactionArtifact(row)
  }

  createExecutionContextManifest(input: CreateExecutionContextManifestInput): {
    manifest: ExecutionContextManifest
    duplicate: boolean
  } {
    if (!input.materializerVersion) {
      throw new ContextPersistenceError('invalid_input', 'Context materializer version must not be empty')
    }
    validateSha256(input.materializedContextHash, 'materializedContextHash')
    return this.#transaction('IMMEDIATE', () => {
      const execution = this.#optional(this.#db.prepare('SELECT * FROM executions WHERE id=?'), input.executionId)
      if (!execution) throw new ContextPersistenceError('not_found', `Execution not found: ${input.executionId}`)
      if (text(execution, 'thread_id') !== input.threadId) {
        throw new ContextPersistenceError('invalid_input', 'Execution belongs to a different canonical thread')
      }
      const entries = this.#resolveExecutionContextSources(
        input.threadId,
        text(execution, 'provider') as CanonicalProvider,
        input.sources,
      )
      const manifestHash = sha256Canonical({
        schema: 'baton.execution-context-manifest.v1',
        executionId: input.executionId,
        threadId: input.threadId,
        materializerVersion: input.materializerVersion,
        materializedContextHash: input.materializedContextHash,
        entries,
      })
      const existing = this.#optional(this.#db.prepare(
        'SELECT * FROM execution_context_manifests WHERE execution_id=?',
      ), input.executionId)
      if (existing) {
        if (text(existing, 'manifest_hash') !== manifestHash) {
          throw new ContextPersistenceError('idempotency_conflict', 'Execution already has a different context manifest')
        }
        return { manifest: this.#executionContextManifest(existing), duplicate: true }
      }
      const id = this.#idFactory()
      const now = this.#now()
      this.#db.prepare(`
        INSERT INTO execution_context_manifests(
          id,execution_id,thread_id,materializer_version,materialized_context_hash,manifest_hash,created_at
        ) VALUES (?,?,?,?,?,?,?)
      `).run(id, input.executionId, input.threadId, input.materializerVersion,
        input.materializedContextHash, manifestHash, now)
      const insertEntry = this.#db.prepare(`
        INSERT INTO execution_context_manifest_entries(
          manifest_id,ordinal,source_kind,item_id,compaction_id,digest
        ) VALUES (?,?,?,?,?,?)
      `)
      for (const entry of entries) {
        insertEntry.run(id, entry.ordinal, entry.kind,
          entry.kind === 'canonical_item' ? entry.itemId : null,
          entry.kind === 'compaction' ? entry.compactionId : null,
          entry.digest)
      }
      return {
        manifest: this.#executionContextManifest(this.#one(
          this.#db.prepare('SELECT * FROM execution_context_manifests WHERE id=?'), id,
        )),
        duplicate: false,
      }
    })
  }

  getExecutionContextManifest(executionId: string): ExecutionContextManifest | null {
    const row = this.#optional(this.#db.prepare(
      'SELECT * FROM execution_context_manifests WHERE execution_id=?',
    ), executionId)
    return row ? this.#executionContextManifest(row) : null
  }

  listEvents(threadId: ThreadId, afterSequence = 0): CanonicalStreamEvent[] {
    if (!this.getThread(threadId)) throw new SessionStoreError('not_found', `Thread not found: ${threadId}`)
    return this.#all(this.#db.prepare(
      'SELECT * FROM stream_events WHERE thread_id=? AND sequence>? ORDER BY sequence',
    ), threadId, afterSequence).map((row) => this.#streamEvent(row))
  }

  getGoal(threadId: ThreadId): CanonicalGoal | null {
    const row = this.#optional(this.#db.prepare('SELECT * FROM goals WHERE thread_id=?'), threadId)
    return row ? this.#goal(row) : null
  }

  getGoalById(goalId: GoalId): CanonicalGoal | null {
    const row = this.#optional(this.#db.prepare('SELECT * FROM goals WHERE id=?'), goalId)
    return row ? this.#goal(row) : null
  }

  listActiveGoals(): CanonicalGoal[] {
    return this.#all(this.#db.prepare(`
      SELECT g.* FROM goals g
      JOIN threads t ON t.id=g.thread_id
      JOIN sessions s ON s.id=t.session_id
      WHERE g.status='active' AND g.verification_proposal_id IS NULL AND s.archived_at IS NULL
      ORDER BY g.updated_at,g.id
    `))
      .map((row) => this.#goal(row))
  }

  listGoalEvents(threadId: ThreadId, afterSequence = 0): GoalEvent[] {
    if (!this.getThread(threadId)) throw new SessionStoreError('not_found', `Thread not found: ${threadId}`)
    return this.#all(this.#db.prepare(
      'SELECT * FROM goal_events WHERE thread_id=? AND sequence>? ORDER BY sequence',
    ), threadId, afterSequence).map((row) => this.#goalEvent(row))
  }

  listPendingGoalCompletionProposals(): GoalCompletionProposal[] {
    return this.#all(this.#db.prepare(`
      SELECT p.* FROM goal_completion_proposals p
      JOIN goals g ON g.id=p.goal_id
      JOIN sessions s ON s.id=p.session_id
      WHERE p.status='verifying' AND g.verification_proposal_id=p.id
        AND g.revision=p.goal_revision AND s.archived_at IS NULL
      ORDER BY p.created_at,p.id
    `)).map((row) => this.#goalCompletionProposal(row))
  }

  getGoalVerificationHistory(goalId: GoalId): GoalVerificationHistory {
    return {
      proposals: this.#all(this.#db.prepare(`
        SELECT * FROM goal_completion_proposals WHERE goal_id=? ORDER BY created_at,id
      `), goalId).map((row) => this.#goalCompletionProposal(row)),
      attempts: this.#all(this.#db.prepare(`
        SELECT * FROM goal_verification_attempts WHERE goal_id=? ORDER BY completed_at,id
      `), goalId).map((row) => this.#goalVerificationAttempt(row)),
      receipts: this.#all(this.#db.prepare(`
        SELECT * FROM goal_completion_receipts WHERE goal_id=? ORDER BY accepted_at,id
      `), goalId).map((row) => this.#goalCompletionReceipt(row)),
      stopReceipts: this.#all(this.#db.prepare(`
        SELECT * FROM goal_stop_receipts WHERE goal_id=? ORDER BY decided_at,id
      `), goalId).map((row) => this.#goalStopReceipt(row)),
    }
  }

  beginGoalVerification(input: BeginGoalVerificationInput): GoalCompletionProposal | null {
    return this.#transaction('IMMEDIATE', () => {
      const goalRow = this.#optional(this.#db.prepare('SELECT * FROM goals WHERE id=?'), input.goalId)
      if (!goalRow) return null
      const goal = this.#goal(goalRow)
      if (goal.revision !== input.goalRevision || goal.status !== 'active') return null
      const turn = this.#optional(this.#db.prepare('SELECT * FROM turns WHERE id=?'), input.turnId)
      if (!turn || text(turn, 'status') !== 'completed'
        || nullableText(turn, 'goal_id') !== goal.id
        || integer(turn, 'goal_revision') !== goal.revision) return null
      const terminalAccounting = this.#optional(this.#db.prepare(`
        SELECT terminal FROM goal_turn_accounting WHERE turn_id=? AND goal_id=? AND goal_revision=?
      `), input.turnId, goal.id, goal.revision)
      if (!terminalAccounting || integer(terminalAccounting, 'terminal') !== 1) return null
      validateGoalEvidenceBundle(input.evidenceBundle, goal, input.turnId)
      if (input.summary !== input.evidenceBundle.proposalSummary
        || canonicalJson(input.requirements) !== canonicalJson(input.evidenceBundle.requirements)) {
        throw new GoalStoreError('invalid_goal_input', 'Completion proposal does not match its frozen evidence bundle')
      }
      if (input.summary.trim().length < 1 || [...input.summary].length > 2_000) {
        throw new GoalStoreError('invalid_goal_input', 'Completion proposal summary must contain 1..2000 characters')
      }
      validateGoalRequirementClaims(input.requirements)
      const thread = this.getThread(goal.threadId)
      if (!thread) throw new Error('Corrupt database: Goal thread is missing')
      const now = this.#now()
      const proposalId = this.#idFactory()
      this.#db.prepare(`
        INSERT INTO goal_completion_proposals(
          id,session_id,thread_id,goal_id,goal_revision,turn_id,summary,requirements_json,
          evidence_bundle_json,evidence_bundle_hash,status,created_at,resolved_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?, 'verifying',?,NULL)
      `).run(
        proposalId, thread.sessionId, goal.threadId, goal.id, goal.revision, input.turnId,
        input.summary, canonicalJson(input.requirements), canonicalJson(input.evidenceBundle),
        input.evidenceBundle.hash, now,
      )
      this.#db.prepare(`
        UPDATE goals SET verification_proposal_id=?,status_reason_json=NULL,updated_at=?
        WHERE id=? AND revision=? AND status='active' AND verification_proposal_id IS NULL
      `).run(proposalId, now, goal.id, goal.revision)
      const verifying = this.#goal(this.#one(this.#db.prepare('SELECT * FROM goals WHERE id=?'), goal.id))
      if (verifying.verificationProposalId !== proposalId) throw new Error('Goal verification CAS failed')
      this.#appendGoalEvent(verifying, thread.sessionId, 'goal_verification_started', {
        proposalId,
        turnId: input.turnId,
        evidenceBundleHash: input.evidenceBundle.hash,
      }, now)
      this.#appendGoalChanged(verifying, thread.sessionId, input.turnId, now)
      return this.#goalCompletionProposal(this.#one(this.#db.prepare(
        'SELECT * FROM goal_completion_proposals WHERE id=?',
      ), proposalId))
    })
  }

  claimGoalVerifierLease(input: ClaimGoalVerifierLeaseInput): GoalVerifierLease | null {
    const duration = validateLeaseDuration(input.leaseDurationMs ?? DEFAULT_GOAL_VERIFIER_LEASE_MS)
    if (!input.ownerId) throw new GoalStoreError('invalid_goal_input', 'Goal verifier lease owner must not be empty')
    return this.#transaction('IMMEDIATE', () => {
      const proposal = this.#optional(this.#db.prepare(`
        SELECT p.id FROM goal_completion_proposals p
        JOIN goals g ON g.id=p.goal_id
        WHERE p.id=? AND p.goal_id=? AND p.goal_revision=? AND p.status='verifying'
          AND g.revision=p.goal_revision AND g.verification_proposal_id=p.id
      `), input.proposalId, input.goalId, input.goalRevision)
      if (!proposal) return null
      const now = this.#now()
      const existing = this.#optional(this.#db.prepare(
        'SELECT * FROM goal_verifier_leases WHERE proposal_id=?',
      ), input.proposalId)
      if (existing && text(existing, 'expires_at') > now) return null
      if (existing) this.#db.prepare('DELETE FROM goal_verifier_leases WHERE proposal_id=?').run(input.proposalId)
      const leaseId = this.#idFactory()
      const expiresAt = addMilliseconds(now, duration)
      this.#db.prepare(`
        INSERT INTO goal_verifier_leases(
          proposal_id,lease_id,goal_id,goal_revision,owner_id,acquired_at,heartbeat_at,expires_at
        ) VALUES (?,?,?,?,?,?,?,?)
      `).run(
        input.proposalId, leaseId, input.goalId, input.goalRevision, input.ownerId, now, now, expiresAt,
      )
      return this.#goalVerifierLease(this.#one(this.#db.prepare(
        'SELECT * FROM goal_verifier_leases WHERE proposal_id=?',
      ), input.proposalId))
    })
  }

  heartbeatGoalVerifierLease(input: HeartbeatGoalVerifierLeaseInput): GoalVerifierLease | null {
    const duration = validateLeaseDuration(input.leaseDurationMs ?? DEFAULT_GOAL_VERIFIER_LEASE_MS)
    return this.#transaction('IMMEDIATE', () => {
      const now = this.#now()
      const row = this.#optional(this.#db.prepare(`
        SELECT l.* FROM goal_verifier_leases l
        JOIN goal_completion_proposals p ON p.id=l.proposal_id
        JOIN goals g ON g.id=p.goal_id
        WHERE l.proposal_id=? AND l.lease_id=? AND l.goal_id=? AND l.goal_revision=? AND l.owner_id=?
          AND l.expires_at>? AND p.status='verifying' AND g.verification_proposal_id=p.id
      `), input.proposalId, input.leaseId, input.goalId, input.goalRevision, input.ownerId, now)
      if (!row) return null
      const expiresAt = addMilliseconds(now, duration)
      this.#db.prepare('UPDATE goal_verifier_leases SET heartbeat_at=?,expires_at=? WHERE proposal_id=?')
        .run(now, expiresAt, input.proposalId)
      return this.#goalVerifierLease(this.#one(this.#db.prepare(
        'SELECT * FROM goal_verifier_leases WHERE proposal_id=?',
      ), input.proposalId))
    })
  }

  releaseGoalVerifierLease(input: ReleaseGoalVerifierLeaseInput): boolean {
    return this.#transaction('IMMEDIATE', () => {
      const result = this.#db.prepare(`
        DELETE FROM goal_verifier_leases WHERE proposal_id=? AND lease_id=? AND owner_id=?
      `).run(input.proposalId, input.leaseId, input.ownerId)
      return result.changes === 1
    })
  }

  finishGoalVerification(input: FinishGoalVerificationInput): FinishGoalVerificationResult {
    return this.#transaction('IMMEDIATE', () => {
      const proposalRow = this.#optional(this.#db.prepare(
        'SELECT * FROM goal_completion_proposals WHERE id=?',
      ), input.proposalId)
      const goalRow = this.#optional(this.#db.prepare('SELECT * FROM goals WHERE id=?'), input.goalId)
      if (!proposalRow || !goalRow) return {
        status: 'stale', goal: goalRow ? this.#goal(goalRow) : null,
        attempt: null, receipt: null, stopReceipt: null,
      }
      const proposal = this.#goalCompletionProposal(proposalRow)
      const goal = this.#goal(goalRow)
      const lease = this.#optional(this.#db.prepare(`
        SELECT * FROM goal_verifier_leases
        WHERE proposal_id=? AND lease_id=? AND owner_id=? AND expires_at>?
      `), proposal.id, input.leaseId, input.leaseOwner, this.#now())
      if (proposal.status !== 'verifying' || proposal.goalId !== goal.id
        || proposal.goalRevision !== input.goalRevision || goal.revision !== input.goalRevision
        || goal.verificationProposalId !== proposal.id || goal.status !== 'verifying' || !lease) {
        return { status: 'stale', goal, attempt: null, receipt: null, stopReceipt: null }
      }
      validateGoalVerificationDecision(input.decision)
      const now = this.#now()
      const thread = this.getThread(goal.threadId)
      if (!thread) throw new Error('Corrupt database: Goal thread is missing')
      const attemptId = this.#idFactory()
      this.#db.prepare(`
        INSERT INTO goal_verification_attempts(
          id,session_id,thread_id,proposal_id,goal_id,goal_revision,evaluator_provider,evaluator_model,
          evidence_bundle_hash,outcome,decision_json,usage_json,started_at,completed_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        attemptId, thread.sessionId, goal.threadId, proposal.id, goal.id, goal.revision,
        input.evaluatorProvider, input.evaluatorModel, proposal.evidenceBundle.hash,
        input.decision.outcome, canonicalJson(input.decision),
        input.usage == null ? null : canonicalJson(input.usage), now, now,
      )
      const hostChecks = completionHostChecks(proposal, input.decision)
      const accepted = input.decision.outcome === 'complete' && hostChecks.failures.length === 0
      const impossibleChecks = impossibleHostChecks(proposal, input.decision)
      const impossible = input.decision.outcome === 'impossible' && impossibleChecks.failures.length === 0
      const relevantFailures = input.decision.outcome === 'impossible'
        ? impossibleChecks.failures
        : hostChecks.failures
      const receiptId = accepted ? this.#idFactory() : null
      const stopReceiptId = impossible ? this.#idFactory() : null
      if (receiptId) {
        this.#db.prepare(`
          INSERT INTO goal_completion_receipts(
            id,session_id,thread_id,goal_id,goal_revision,proposal_id,verification_attempt_id,
            evidence_bundle_hash,host_checks_json,acceptance_policy_version,accepted_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          receiptId, thread.sessionId, goal.threadId, goal.id, goal.revision, proposal.id, attemptId,
          proposal.evidenceBundle.hash, canonicalJson(hostChecks.passed), 'goal-v2.1', now,
        )
      }
      if (stopReceiptId) {
        this.#db.prepare(`
          INSERT INTO goal_stop_receipts(
            id,session_id,thread_id,goal_id,goal_revision,verification_attempt_id,kind,reason,
            evidence_bundle_hash,decided_at,resumable
          ) VALUES (?,?,?,?,?,?,'confirmed_impossible',?,?,?,1)
        `).run(
          stopReceiptId, thread.sessionId, goal.threadId, goal.id, goal.revision, attemptId,
          input.decision.reason, proposal.evidenceBundle.hash, now,
        )
      }
      const nextStatus = accepted ? 'complete' : impossible ? 'blocked' : 'active'
      const reason: GoalStatusReason | null = accepted ? null : {
        code: impossible ? 'confirmed_impossible'
          : input.decision.outcome === 'indeterminate' ? 'verification_indeterminate'
            : input.decision.outcome === 'complete' || input.decision.outcome === 'impossible'
              ? 'verification_host_rejected' : 'verification_incomplete',
        source: 'host',
        message: relevantFailures.length > 0
          ? `Verification was not accepted: ${relevantFailures.join('; ')}`
          : input.decision.reason,
        at: now,
      }
      this.#db.prepare(`
        UPDATE goal_completion_proposals SET status=?,resolved_at=? WHERE id=? AND status='verifying'
      `).run(accepted ? 'accepted' : 'rejected', now, proposal.id)
      this.#db.prepare('DELETE FROM goal_verifier_leases WHERE proposal_id=?').run(proposal.id)
      this.#db.prepare(`
        UPDATE goals SET status=?,status_reason_json=?,verification_proposal_id=NULL,
          latest_completion_receipt_id=?,latest_stop_receipt_id=?,updated_at=?,completed_at=?
        WHERE id=? AND revision=? AND verification_proposal_id=?
      `).run(
        nextStatus, reason === null ? null : canonicalJson(reason), receiptId, stopReceiptId,
        now, accepted ? now : null, goal.id, goal.revision, proposal.id,
      )
      const updated = this.#goal(this.#one(this.#db.prepare('SELECT * FROM goals WHERE id=?'), goal.id))
      const attempt = this.#goalVerificationAttempt(this.#one(this.#db.prepare(
        'SELECT * FROM goal_verification_attempts WHERE id=?',
      ), attemptId))
      const receipt = receiptId ? this.#goalCompletionReceipt(this.#one(this.#db.prepare(
        'SELECT * FROM goal_completion_receipts WHERE id=?',
      ), receiptId)) : null
      const stopReceipt = stopReceiptId ? this.#goalStopReceipt(this.#one(this.#db.prepare(
        'SELECT * FROM goal_stop_receipts WHERE id=?',
      ), stopReceiptId)) : null
      this.#appendGoalEvent(updated, thread.sessionId, 'goal_verification_finished', {
        proposalId: proposal.id,
        attemptId,
        outcome: input.decision.outcome,
        accepted,
        hostCheckFailures: relevantFailures,
        receiptId,
        stopReceiptId,
      }, now)
      this.#appendGoalChanged(updated, thread.sessionId, null, now)
      return { status: 'applied', goal: updated, attempt, receipt, stopReceipt }
    })
  }

  createGoal(input: CreateGoalInput): CanonicalGoal {
    validateGoalObjective(input.objective)
    const tokenBudget = validateNullablePositiveInteger(input.tokenBudget ?? null, 'tokenBudget')
    const maxAutomaticTurns = validatePositiveInteger(input.maxAutomaticTurns ?? DEFAULT_GOAL_TURNS, 'maxAutomaticTurns')
    const maxActiveSeconds = validatePositiveInteger(input.maxActiveSeconds ?? DEFAULT_GOAL_ACTIVE_SECONDS, 'maxActiveSeconds')
    if (!input.model) throw new GoalStoreError('invalid_goal_input', 'Goal model must not be empty')
    return this.#transaction('IMMEDIATE', () => {
      const thread = this.getThread(input.threadId)
      if (!thread) throw new SessionStoreError('not_found', `Thread not found: ${input.threadId}`)
      const session = this.getSession(thread.sessionId)
      if (!session) throw new Error('Corrupt database: Goal thread session is missing')
      if (session.archivedAt) throw new SessionStoreError('session_archived', 'Cannot create a Goal in an archived session')
      const currentRow = this.#optional(this.#db.prepare('SELECT * FROM goals WHERE thread_id=?'), input.threadId)
      if (!goalObservationMatches(input.expected, currentRow)) {
        throw new GoalStoreError('stale_goal_revision', 'Current Goal changed after it was observed')
      }
      if (currentRow && text(currentRow, 'status') !== 'complete' && !input.replaceExisting) {
        throw new GoalStoreError('unfinished_goal_exists', 'An unfinished Goal already exists')
      }
      const now = this.#now()
      if (currentRow) {
        const previous = this.#goal(currentRow)
        if (previous.verificationProposalId) {
          this.#db.prepare(`UPDATE goal_completion_proposals SET status='ineligible',resolved_at=? WHERE id=? AND status='verifying'`)
            .run(now, previous.verificationProposalId)
          this.#db.prepare('DELETE FROM goal_verifier_leases WHERE proposal_id=?').run(previous.verificationProposalId)
        }
        this.#db.prepare('DELETE FROM goal_scheduler_leases WHERE goal_id=?').run(previous.id)
        this.#appendGoalEvent(previous, thread.sessionId, 'goal_replaced', { previous }, now)
        this.#db.prepare('DELETE FROM goals WHERE id=?').run(previous.id)
      }
      const id = this.#idFactory()
      this.#db.prepare(`
        INSERT INTO goals(
          id,thread_id,objective,status,status_reason_json,revision,provider,model,effort,
          token_budget,tokens_used,time_used_seconds,max_automatic_turns,automatic_turns_used,
          max_active_seconds,no_progress_count,last_progress_digest,created_at,updated_at,started_at,completed_at
        ) VALUES (?,? ,?,'active',NULL,1,?,?,?, ?,0,0,?,0,?,0,NULL,?,?,?,NULL)
      `).run(id, input.threadId, input.objective, input.provider, input.model, input.effort ?? null,
        tokenBudget, maxAutomaticTurns, maxActiveSeconds, now, now, now)
      const goal = this.#goal(this.#one(this.#db.prepare('SELECT * FROM goals WHERE id=?'), id))
      this.#appendGoalEvent(goal, thread.sessionId, 'goal_created', { goal }, now)
      this.#appendGoalChanged(goal, thread.sessionId, null, now)
      return goal
    })
  }

  editGoal(input: EditGoalInput): CanonicalGoal {
    if (input.objective !== undefined) validateGoalObjective(input.objective)
    if (input.model !== undefined && !input.model) {
      throw new GoalStoreError('invalid_goal_input', 'Goal model must not be empty')
    }
    const requestedTokenBudget = input.tokenBudget === undefined
      ? undefined
      : validateNullablePositiveInteger(input.tokenBudget, 'tokenBudget')
    const requestedMaxTurns = input.maxAutomaticTurns === undefined
      ? undefined
      : validatePositiveInteger(input.maxAutomaticTurns, 'maxAutomaticTurns')
    const requestedMaxSeconds = input.maxActiveSeconds === undefined
      ? undefined
      : validatePositiveInteger(input.maxActiveSeconds, 'maxActiveSeconds')
    return this.#transaction('IMMEDIATE', () => {
      const row = this.#optional(this.#db.prepare('SELECT * FROM goals WHERE id=?'), input.goalId)
      if (!row) throw new GoalStoreError('stale_goal_revision', 'Goal was replaced or cleared')
      const current = this.#goal(row)
      if (current.revision !== input.expectedRevision) {
        throw new GoalStoreError('stale_goal_revision', 'Goal revision changed after it was observed')
      }
      const changed = input.objective !== undefined || input.provider !== undefined || input.model !== undefined
        || Object.prototype.hasOwnProperty.call(input, 'effort') || requestedTokenBudget !== undefined
        || requestedMaxTurns !== undefined || requestedMaxSeconds !== undefined || input.resetLimitCounters === true
      if (!changed) throw new GoalStoreError('invalid_goal_input', 'Goal edit did not contain any changes')

      let nextStatus = current.status
      const largerTokenLimit = requestedTokenBudget !== undefined
        && current.tokenBudget !== null
        && (requestedTokenBudget === null || requestedTokenBudget > current.tokenBudget)
      const largerTurnLimit = requestedMaxTurns !== undefined && requestedMaxTurns > current.maxAutomaticTurns
      const largerTimeLimit = requestedMaxSeconds !== undefined && requestedMaxSeconds > current.maxActiveSeconds
      const reasonCode = current.statusReason?.code
      const largerRelevantLimit = reasonCode === 'goal_token_limit'
        ? largerTokenLimit
        : reasonCode === 'goal_turn_limit'
          ? largerTurnLimit
          : reasonCode === 'goal_time_limit'
            ? largerTimeLimit
            : largerTokenLimit || largerTurnLimit || largerTimeLimit
      if (current.status === 'complete' || current.status === 'verifying') nextStatus = 'active'
      if (current.status === 'budget_limited') {
        const resetRelevantCounter = input.resetLimitCounters === true && reasonCode !== 'goal_token_limit'
        if (!largerRelevantLimit && !resetRelevantCounter) {
          throw new GoalStoreError(
            'invalid_goal_transition',
            'A budget-limited Goal requires a larger relevant limit or explicit counter reset',
          )
        }
        nextStatus = 'active'
      }
      const now = this.#now()
      const revision = current.revision + 1
      const resetCounters = input.resetLimitCounters === true
      this.#db.prepare(`
        UPDATE goals SET
          objective=?,status=?,status_reason_json=?,revision=?,provider=?,model=?,effort=?,token_budget=?,
          tokens_used=?,time_used_seconds=?,max_automatic_turns=?,automatic_turns_used=?,max_active_seconds=?,
          no_progress_count=0,last_progress_digest=NULL,verification_proposal_id=NULL,
          latest_completion_receipt_id=NULL,latest_stop_receipt_id=NULL,updated_at=?,completed_at=?
        WHERE id=? AND revision=?
      `).run(
        input.objective ?? current.objective,
        nextStatus,
        nextStatus === 'active' ? null : (current.statusReason === null ? null : canonicalJson(current.statusReason)),
        revision,
        input.provider ?? current.provider,
        input.model ?? current.model,
        Object.prototype.hasOwnProperty.call(input, 'effort') ? (input.effort ?? null) : current.effort,
        requestedTokenBudget === undefined ? current.tokenBudget : requestedTokenBudget,
        current.tokensUsed,
        resetCounters ? 0 : current.timeUsedSeconds,
        requestedMaxTurns ?? current.maxAutomaticTurns,
        resetCounters ? 0 : current.automaticTurnsUsed,
        requestedMaxSeconds ?? current.maxActiveSeconds,
        now,
        nextStatus === 'active' ? null : current.completedAt,
        current.id,
        current.revision,
      )
      if (current.verificationProposalId) {
        this.#db.prepare(`UPDATE goal_completion_proposals SET status='ineligible',resolved_at=? WHERE id=? AND status='verifying'`)
          .run(now, current.verificationProposalId)
        this.#db.prepare('DELETE FROM goal_verifier_leases WHERE proposal_id=?').run(current.verificationProposalId)
      }
      this.#db.prepare('DELETE FROM goal_scheduler_leases WHERE goal_id=?').run(current.id)
      const goal = this.#goal(this.#one(this.#db.prepare('SELECT * FROM goals WHERE id=?'), current.id))
      const thread = this.getThread(goal.threadId)
      if (!thread) throw new Error('Corrupt database: Goal thread is missing')
      this.#appendGoalEvent(goal, thread.sessionId, 'goal_edited', { previousRevision: current.revision, goal }, now)
      this.#appendGoalChanged(goal, thread.sessionId, null, now)
      return goal
    })
  }

  updateGoalStatus(input: UpdateGoalStatusInput): GoalCasResult {
    if (input.model !== undefined && !input.model) {
      throw new GoalStoreError('invalid_goal_input', 'Goal model must not be empty')
    }
    return this.#transaction('IMMEDIATE', () => {
      const row = this.#optional(this.#db.prepare('SELECT * FROM goals WHERE id=?'), input.goalId)
      if (!row) return { status: 'stale', goal: null }
      const current = this.#goal(row)
      if (current.revision !== input.expectedRevision) return { status: 'stale', goal: current }
      if (!isValidGoalTransition(current.status, input.status, input.resetLimitCounters === true)) {
        throw new GoalStoreError(
          'invalid_goal_transition',
          `Cannot transition Goal from ${current.status} to ${input.status}`,
        )
      }
      if (current.status === 'budget_limited'
        && current.statusReason?.code === 'goal_token_limit'
        && input.status === 'active') {
        throw new GoalStoreError(
          'invalid_goal_transition',
          'A token-limited Goal requires a larger token budget before resume',
        )
      }
      if (input.status !== 'active' && input.status !== 'complete' && !input.reason) {
        throw new GoalStoreError('invalid_goal_input', 'Stopped Goal status requires a reason')
      }
      const now = this.#now()
      const revision = current.revision + 1
      const resetCounters = input.status === 'active' && input.resetLimitCounters === true
      const reason = input.status === 'active' || !input.reason ? null : { ...input.reason, at: now }
      const stoppedForTimeLimit = input.status === 'budget_limited' && reason?.code === 'goal_time_limit'
      this.#db.prepare(`
        UPDATE goals SET status=?,status_reason_json=?,revision=?,provider=?,model=?,effort=?,
          time_used_seconds=?,automatic_turns_used=?,no_progress_count=?,last_progress_digest=?,
          verification_proposal_id=NULL,updated_at=?,completed_at=?
        WHERE id=? AND revision=?
      `).run(
        input.status,
        reason === null ? null : canonicalJson(reason),
        revision,
        input.provider ?? current.provider,
        input.model ?? current.model,
        Object.prototype.hasOwnProperty.call(input, 'effort') ? (input.effort ?? null) : current.effort,
        resetCounters ? 0 : stoppedForTimeLimit
          ? Math.max(current.timeUsedSeconds, current.maxActiveSeconds)
          : current.timeUsedSeconds,
        resetCounters ? 0 : current.automaticTurnsUsed,
        input.status === 'active' ? 0 : current.noProgressCount,
        input.status === 'active' ? null : current.lastProgressDigest,
        now,
        input.status === 'complete' ? now : null,
        current.id,
        current.revision,
      )
      if (current.verificationProposalId) {
        this.#db.prepare(`UPDATE goal_completion_proposals SET status='ineligible',resolved_at=? WHERE id=? AND status='verifying'`)
          .run(now, current.verificationProposalId)
        this.#db.prepare('DELETE FROM goal_verifier_leases WHERE proposal_id=?').run(current.verificationProposalId)
      }
      this.#db.prepare('DELETE FROM goal_scheduler_leases WHERE goal_id=?').run(current.id)
      const goal = this.#goal(this.#one(this.#db.prepare('SELECT * FROM goals WHERE id=?'), current.id))
      const thread = this.getThread(goal.threadId)
      if (!thread) throw new Error('Corrupt database: Goal thread is missing')
      this.#appendGoalEvent(goal, thread.sessionId, `goal_${input.status}`, { previousStatus: current.status, goal }, now)
      this.#appendGoalChanged(goal, thread.sessionId, null, now)
      return { status: 'applied', goal }
    })
  }

  clearGoal(input: ClearGoalInput): void {
    this.#transaction('IMMEDIATE', () => {
      const row = this.#optional(this.#db.prepare('SELECT * FROM goals WHERE id=?'), input.goalId)
      if (!row) throw new GoalStoreError('stale_goal_revision', 'Goal was replaced or cleared')
      const current = this.#goal(row)
      if (current.revision !== input.expectedRevision) {
        throw new GoalStoreError('stale_goal_revision', 'Goal revision changed after it was observed')
      }
      const thread = this.getThread(current.threadId)
      if (!thread) throw new Error('Corrupt database: Goal thread is missing')
      const now = this.#now()
      if (current.verificationProposalId) {
        this.#db.prepare(`UPDATE goal_completion_proposals SET status='ineligible',resolved_at=? WHERE id=? AND status='verifying'`)
          .run(now, current.verificationProposalId)
        this.#db.prepare('DELETE FROM goal_verifier_leases WHERE proposal_id=?').run(current.verificationProposalId)
      }
      this.#db.prepare('DELETE FROM goal_scheduler_leases WHERE goal_id=?').run(current.id)
      this.#db.prepare('DELETE FROM goals WHERE id=?').run(current.id)
      this.#appendGoalEvent(current, thread.sessionId, 'goal_cleared', { goal: current }, now)
      this.#appendGoalChanged(current, thread.sessionId, null, now, 'cleared')
    })
  }

  claimGoalLease(input: ClaimGoalLeaseInput): GoalSchedulerLease | null {
    const duration = validateLeaseDuration(input.leaseDurationMs ?? DEFAULT_GOAL_LEASE_MS)
    if (!input.ownerId) throw new GoalStoreError('invalid_goal_input', 'Goal lease owner must not be empty')
    return this.#transaction('IMMEDIATE', () => {
      const row = this.#optional(this.#db.prepare('SELECT * FROM goals WHERE id=?'), input.goalId)
      if (!row) return null
      const goal = this.#goal(row)
      if (goal.revision !== input.goalRevision || goal.status !== 'active') return null
      const thread = this.getThread(goal.threadId)
      if (!thread || thread.status !== 'idle') return null
      if (this.getSession(thread.sessionId)?.archivedAt) return null
      const activeTurn = this.#optional(this.#db.prepare(`
        SELECT id FROM turns WHERE thread_id=? AND status IN ('queued','running','waiting_tool') LIMIT 1
      `), goal.threadId)
      if (activeTurn) return null
      const unsettledTurn = this.#optional(this.#db.prepare(`
        SELECT t.id FROM turns t
        WHERE t.thread_id=? AND t.goal_id=? AND t.goal_revision=?
          AND t.status IN ('completed','cancelled','failed','interrupted')
          AND NOT EXISTS (
            SELECT 1 FROM goal_turn_accounting a WHERE a.turn_id=t.id AND a.terminal=1
          )
        LIMIT 1
      `), goal.threadId, goal.id, goal.revision)
      if (unsettledTurn) return null
      const now = this.#now()
      const existing = this.#optional(this.#db.prepare('SELECT * FROM goal_scheduler_leases WHERE goal_id=?'), goal.id)
      if (existing && text(existing, 'expires_at') > now) return null
      if (existing) this.#db.prepare('DELETE FROM goal_scheduler_leases WHERE goal_id=?').run(goal.id)
      const leaseId = this.#idFactory()
      const expiresAt = addMilliseconds(now, duration)
      this.#db.prepare(`
        INSERT INTO goal_scheduler_leases(goal_id,lease_id,goal_revision,owner_id,acquired_at,heartbeat_at,expires_at)
        VALUES (?,?,?,?,?,?,?)
      `).run(goal.id, leaseId, goal.revision, input.ownerId, now, now, expiresAt)
      return this.#goalLease(this.#one(this.#db.prepare('SELECT * FROM goal_scheduler_leases WHERE lease_id=?'), leaseId))
    })
  }

  heartbeatGoalLease(input: HeartbeatGoalLeaseInput): GoalSchedulerLease | null {
    const duration = validateLeaseDuration(input.leaseDurationMs ?? DEFAULT_GOAL_LEASE_MS)
    return this.#transaction('IMMEDIATE', () => {
      const now = this.#now()
      const row = this.#optional(this.#db.prepare(`
        SELECT l.* FROM goal_scheduler_leases l
        JOIN goals g ON g.id=l.goal_id
        JOIN threads t ON t.id=g.thread_id
        JOIN sessions s ON s.id=t.session_id
        WHERE l.lease_id=? AND l.goal_id=? AND l.goal_revision=? AND l.owner_id=?
          AND g.status='active' AND g.revision=l.goal_revision AND s.archived_at IS NULL
      `), input.leaseId, input.goalId, input.goalRevision, input.ownerId)
      if (!row || text(row, 'expires_at') <= now) {
        this.#db.prepare(`
          DELETE FROM goal_scheduler_leases WHERE lease_id=? AND goal_id=? AND goal_revision=? AND owner_id=?
        `).run(input.leaseId, input.goalId, input.goalRevision, input.ownerId)
        return null
      }
      const expiresAt = addMilliseconds(now, duration)
      this.#db.prepare('UPDATE goal_scheduler_leases SET heartbeat_at=?,expires_at=? WHERE lease_id=?')
        .run(now, expiresAt, input.leaseId)
      return this.#goalLease(this.#one(this.#db.prepare('SELECT * FROM goal_scheduler_leases WHERE lease_id=?'), input.leaseId))
    })
  }

  releaseGoalLease(input: ReleaseGoalLeaseInput): boolean {
    return this.#transaction('IMMEDIATE', () => {
      const before = this.#optional(this.#db.prepare(`
        SELECT lease_id FROM goal_scheduler_leases
        WHERE lease_id=? AND goal_id=? AND goal_revision=? AND owner_id=?
      `), input.leaseId, input.goalId, input.goalRevision, input.ownerId)
      if (!before) return false
      this.#db.prepare('DELETE FROM goal_scheduler_leases WHERE lease_id=?').run(input.leaseId)
      return true
    })
  }

  checkpointGoalTurn(input: CheckpointGoalTurnInput): GoalCasResult {
    validateNonNegativeInteger(input.tokensUsed, 'tokensUsed')
    validateNonNegativeInteger(input.timeUsedSeconds, 'timeUsedSeconds')
    return this.#transaction('IMMEDIATE', () => this.#checkpointGoalTurn(input))
  }

  recordGoalTurn(input: RecordGoalTurnInput): GoalCasResult {
    validateNonNegativeInteger(input.tokensUsed, 'tokensUsed')
    validateNonNegativeInteger(input.timeUsedSeconds, 'timeUsedSeconds')
    return this.#transaction('IMMEDIATE', () => {
      const turn = this.#optional(this.#db.prepare('SELECT * FROM turns WHERE id=?'), input.turnId)
      if (!turn) throw new SessionStoreError('not_found', `Turn not found: ${input.turnId}`)
      if (nullableText(turn, 'goal_id') !== input.goalId || turn.goal_revision !== input.goalRevision) {
        return { status: 'stale', goal: this.#goalById(input.goalId) }
      }
      if (!TERMINAL_TURN_STATUSES.has(text(turn, 'status'))) {
        throw new SessionStoreError('turn_not_running', 'Goal turn accounting requires a terminal turn')
      }
      const duplicate = this.#optional(this.#db.prepare('SELECT * FROM goal_turn_accounting WHERE turn_id=?'), input.turnId)
      if (duplicate && integer(duplicate, 'terminal') === 1) {
        const same = text(duplicate, 'goal_id') === input.goalId
          && integer(duplicate, 'goal_revision') === input.goalRevision
          && integer(duplicate, 'tokens_used') === input.tokensUsed
          && integer(duplicate, 'time_used_seconds') === input.timeUsedSeconds
          && integer(duplicate, 'automatic') === (input.automatic ? 1 : 0)
          && nullableText(duplicate, 'progress_digest') === input.progressDigest
        if (!same) throw new GoalStoreError('invalid_goal_input', 'Goal turn was already accounted differently')
        const current = this.#goalById(input.goalId)
        return current?.revision === input.goalRevision
          ? { status: 'applied', goal: current }
          : { status: 'stale', goal: current }
      }
      const checkpoint = this.#checkpointGoalTurn(input, false)
      if (checkpoint.status === 'stale' || !checkpoint.goal) return checkpoint
      const current = checkpoint.goal
      if (!Number.isSafeInteger(current.automaticTurnsUsed + (input.automatic ? 1 : 0))) {
        throw new GoalStoreError('invalid_goal_input', 'Goal accounting would exceed safe integer storage')
      }
      const now = this.#now()
      const sameProgress = input.progressDigest !== null && current.lastProgressDigest === input.progressDigest
      const noProgressCount = input.progressDigest === null
        ? current.noProgressCount + 1
        : sameProgress ? current.noProgressCount + 1 : 0
      this.#db.prepare(`
        UPDATE goal_turn_accounting
        SET automatic=?,terminal=1,progress_digest=?,updated_at=?
        WHERE turn_id=? AND terminal=0
      `).run(input.automatic ? 1 : 0, input.progressDigest, now, input.turnId)
      this.#db.prepare(`
        UPDATE goals SET automatic_turns_used=automatic_turns_used+?,
          no_progress_count=?,last_progress_digest=?,updated_at=?
        WHERE id=? AND revision=?
      `).run(input.automatic ? 1 : 0, noProgressCount,
        input.progressDigest ?? current.lastProgressDigest, now, current.id, current.revision)
      const goal = this.#goal(this.#one(this.#db.prepare('SELECT * FROM goals WHERE id=?'), current.id))
      const thread = this.getThread(goal.threadId)
      if (!thread) throw new Error('Corrupt database: Goal thread is missing')
      this.#appendGoalEvent(goal, thread.sessionId, 'goal_turn_accounted', {
        turnId: input.turnId,
        tokensUsed: input.tokensUsed,
        timeUsedSeconds: input.timeUsedSeconds,
        automatic: input.automatic,
        progressDigest: input.progressDigest,
      }, now)
      this.#appendGoalChanged(goal, thread.sessionId, input.turnId, now)
      return { status: 'applied', goal }
    })
  }

  #checkpointGoalTurn(input: CheckpointGoalTurnInput, emitStreamEvent = true): GoalCasResult {
    const turn = this.#optional(this.#db.prepare('SELECT * FROM turns WHERE id=?'), input.turnId)
    if (!turn) throw new SessionStoreError('not_found', `Turn not found: ${input.turnId}`)
    if (nullableText(turn, 'goal_id') !== input.goalId || turn.goal_revision !== input.goalRevision) {
      return { status: 'stale', goal: this.#goalById(input.goalId) }
    }
    const current = this.#goalById(input.goalId)
    if (!current || current.revision !== input.goalRevision) return { status: 'stale', goal: current }
    const previous = this.#optional(this.#db.prepare('SELECT * FROM goal_turn_accounting WHERE turn_id=?'), input.turnId)
    const previousTokens = previous ? integer(previous, 'tokens_used') : 0
    const previousSeconds = previous ? integer(previous, 'time_used_seconds') : 0
    const previousDigest = previous ? nullableText(previous, 'progress_digest') : null
    if (previous && integer(previous, 'terminal') === 1) {
      const unchanged = previousTokens === input.tokensUsed
        && previousSeconds === input.timeUsedSeconds
        && (input.progressDigest === undefined || input.progressDigest === previousDigest)
      if (unchanged) return { status: 'applied', goal: current }
      throw new GoalStoreError('invalid_goal_input', 'A terminal Goal turn cannot accept a different checkpoint')
    }
    if (input.tokensUsed < previousTokens || input.timeUsedSeconds < previousSeconds) {
      throw new GoalStoreError('invalid_goal_input', 'Cumulative Goal checkpoint values cannot decrease')
    }
    const tokenDelta = input.tokensUsed - previousTokens
    const secondsDelta = input.timeUsedSeconds - previousSeconds
    const progressDigest = input.progressDigest === undefined ? previousDigest : input.progressDigest
    if (previous && tokenDelta === 0 && secondsDelta === 0 && progressDigest === previousDigest) {
      return { status: 'applied', goal: current }
    }
    if (!Number.isSafeInteger(current.tokensUsed + tokenDelta)
      || !Number.isSafeInteger(current.timeUsedSeconds + secondsDelta)) {
      throw new GoalStoreError('invalid_goal_input', 'Goal accounting would exceed safe integer storage')
    }
    const now = this.#now()
    if (previous) {
      this.#db.prepare(`
        UPDATE goal_turn_accounting
        SET tokens_used=?,time_used_seconds=?,progress_digest=?,updated_at=?
        WHERE turn_id=? AND terminal=0
      `).run(input.tokensUsed, input.timeUsedSeconds, progressDigest, now, input.turnId)
    } else {
      this.#db.prepare(`
        INSERT INTO goal_turn_accounting(
          turn_id,goal_id,goal_revision,tokens_used,time_used_seconds,automatic,terminal,
          progress_digest,created_at,updated_at
        ) VALUES (?,?,?,?,?,0,0,?,?,?)
      `).run(input.turnId, input.goalId, input.goalRevision, input.tokensUsed, input.timeUsedSeconds,
        progressDigest, now, now)
    }
    this.#db.prepare(`
      UPDATE goals SET tokens_used=tokens_used+?,time_used_seconds=time_used_seconds+?,updated_at=?
      WHERE id=? AND revision=?
    `).run(tokenDelta, secondsDelta, now, current.id, current.revision)
    const goal = this.#goal(this.#one(this.#db.prepare('SELECT * FROM goals WHERE id=?'), current.id))
    const thread = this.getThread(goal.threadId)
    if (!thread) throw new Error('Corrupt database: Goal thread is missing')
    this.#appendGoalEvent(goal, thread.sessionId, 'goal_turn_checkpointed', {
      turnId: input.turnId,
      tokensUsed: input.tokensUsed,
      timeUsedSeconds: input.timeUsedSeconds,
      tokenDelta,
      secondsDelta,
      progressDigest,
    }, now)
    if (emitStreamEvent) this.#appendGoalChanged(goal, thread.sessionId, input.turnId, now)
    return { status: 'applied', goal }
  }

  recoverInterruptedTurns(): number {
    return this.#transaction('IMMEDIATE', () => {
      const rows = this.#all(this.#db.prepare(`
        SELECT turns.*,threads.session_id AS session_id,executions.budget_json AS execution_budget_json
        FROM turns JOIN threads ON threads.id=turns.thread_id
        JOIN executions ON executions.turn_id=turns.id
        WHERE turns.status IN ('queued','running','waiting_tool') ORDER BY turns.id
      `))
      const now = this.#now()
      const recoveredTurnIds = new Set<string>()
      for (const row of rows) {
        const turnId = text(row, 'id')
        recoveredTurnIds.add(turnId)
        this.#closeFollowUpWindow(turnId, now)
        this.#recoverFollowUpClaimsForTurn(turnId, now)
        const unknownMutation = this.#hasUnresolvedMutatingToolCall(turnId)
        const recoveryCode = unknownMutation ? 'unknown_mutation_outcome' : 'runtime_interrupted'
        const goalId = nullableText(row, 'goal_id')
        const goalRevision = row.goal_revision === null ? null : integer(row, 'goal_revision')
        const automatic = parseObject(row.execution_budget_json).goalAutomatic === true
        this.#db.prepare("UPDATE turns SET status='interrupted',completed_at=?,error_json=? WHERE id=?")
          .run(now, canonicalJson({ code: recoveryCode }), turnId)
        this.#db.prepare("UPDATE executions SET status='interrupted',completed_at=? WHERE turn_id=?").run(now, turnId)
        this.#db.prepare("UPDATE threads SET status='idle',revision=revision+1,updated_at=? WHERE id=?")
          .run(now, text(row, 'thread_id'))
        this.#db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(now, text(row, 'session_id'))
        this.#appendStreamEvent(text(row, 'session_id'), text(row, 'thread_id'), turnId, 'turn_interrupted', {
          status: 'interrupted',
          reason: recoveryCode,
        }, now)
        if (goalId !== null && goalRevision !== null) {
          const goalRow = this.#optional(this.#db.prepare(`
            SELECT * FROM goals WHERE id=? AND revision=? AND status='active'
          `), goalId, goalRevision)
          if (goalRow) {
            const previous = this.#goal(goalRow)
            const reason: GoalStatusReason = {
              code: recoveryCode,
              source: 'host',
              message: null,
              at: now,
            }
            this.#db.prepare(`
              UPDATE goals SET status='blocked',status_reason_json=?,revision=revision+1,
                automatic_turns_used=automatic_turns_used+?,updated_at=?
              WHERE id=? AND revision=? AND status='active'
            `).run(canonicalJson(reason), automatic ? 1 : 0, now, goalId, goalRevision)
            this.#db.prepare('DELETE FROM goal_scheduler_leases WHERE goal_id=?').run(goalId)
            const blocked = this.#goal(this.#one(this.#db.prepare('SELECT * FROM goals WHERE id=?'), goalId))
            this.#appendGoalEvent(blocked, text(row, 'session_id'), 'goal_blocked', {
              previousStatus: previous.status,
              interruptedTurnId: turnId,
              goal: blocked,
            }, now)
            this.#appendGoalChanged(blocked, text(row, 'session_id'), turnId, now)
          }
        }
      }

      const interruptedRows = this.#all(this.#db.prepare(`
        SELECT turns.*,threads.session_id AS session_id
        FROM turns JOIN threads ON threads.id=turns.thread_id
        WHERE turns.status='interrupted'
        ORDER BY turns.id
      `))
      for (const row of interruptedRows) {
        if (this.#repairInterruptedReadOnlyToolCalls(row, now) > 0) {
          recoveredTurnIds.add(text(row, 'id'))
        }
      }

      const unsettledGoalTurns = this.#all(this.#db.prepare(`
        SELECT turns.*,threads.session_id AS session_id,executions.budget_json AS execution_budget_json
        FROM turns JOIN threads ON threads.id=turns.thread_id
        JOIN executions ON executions.turn_id=turns.id
        WHERE turns.goal_id IS NOT NULL AND turns.goal_revision IS NOT NULL
          AND turns.status IN ('completed','cancelled','failed','interrupted')
          AND NOT EXISTS (
            SELECT 1 FROM goal_turn_accounting a
            WHERE a.turn_id=turns.id AND a.terminal=1
          )
        ORDER BY turns.id
      `))
      for (const row of unsettledGoalTurns) {
        const turnId = text(row, 'id')
        const goalId = text(row, 'goal_id')
        const goalRevision = integer(row, 'goal_revision')
        const automatic = parseObject(row.execution_budget_json).goalAutomatic === true
        recoveredTurnIds.add(turnId)
        const accounting = this.#optional(this.#db.prepare(
          'SELECT * FROM goal_turn_accounting WHERE turn_id=?',
        ), turnId)
        if (accounting) {
          this.#db.prepare(`
            UPDATE goal_turn_accounting SET automatic=?,terminal=1,updated_at=?
            WHERE turn_id=? AND terminal=0
          `).run(automatic ? 1 : 0, now, turnId)
        } else {
          this.#db.prepare(`
            INSERT INTO goal_turn_accounting(
              turn_id,goal_id,goal_revision,tokens_used,time_used_seconds,automatic,terminal,
              progress_digest,created_at,updated_at
            ) VALUES (?,?,?,0,0,?,1,NULL,?,?)
          `).run(turnId, goalId, goalRevision, automatic ? 1 : 0, now, now)
        }

        const goalRow = this.#optional(this.#db.prepare(`
          SELECT * FROM goals WHERE id=? AND revision=? AND status='active'
        `), goalId, goalRevision)
        if (!goalRow) continue
        const previous = this.#goal(goalRow)
        const reason: GoalStatusReason = {
          code: 'goal_accounting_interrupted',
          source: 'host',
          message: null,
          at: now,
        }
        this.#db.prepare(`
          UPDATE goals SET status='blocked',status_reason_json=?,revision=revision+1,
            automatic_turns_used=automatic_turns_used+?,updated_at=?
          WHERE id=? AND revision=? AND status='active'
        `).run(canonicalJson(reason), automatic ? 1 : 0, now, goalId, goalRevision)
        this.#db.prepare('DELETE FROM goal_scheduler_leases WHERE goal_id=?').run(goalId)
        const blocked = this.#goal(this.#one(this.#db.prepare('SELECT * FROM goals WHERE id=?'), goalId))
        this.#appendGoalEvent(blocked, text(row, 'session_id'), 'goal_blocked', {
          previousStatus: previous.status,
          interruptedTurnId: turnId,
          goal: blocked,
        }, now)
        this.#appendGoalChanged(blocked, text(row, 'session_id'), turnId, now)
      }
      return recoveredTurnIds.size
    })
  }

  /**
   * Imported transcripts (turnless items) can carry tool calls whose results
   * the source app never recorded — the conversation was exported or crashed
   * mid-call, so the result can never arrive. Persist a synthetic error result
   * for each so the transcript closes durably: execution, compaction, and
   * provider views then all observe the same repaired history. Live-turn
   * orphans are deliberately untouched here — read-only ones are repaired at
   * recovery, and mutating ones must go through user reconciliation.
   */
  repairOrphanImportedToolCalls(threadId: ThreadId): number {
    return this.#transaction('IMMEDIATE', () => this.#repairOrphanImportedToolCallsInTxn(threadId))
  }

  #repairOrphanImportedToolCallsInTxn(threadId: ThreadId): number {
    {
      const rows = this.#all(this.#db.prepare(`
        SELECT kind,payload_json,provider FROM items
        WHERE thread_id=? AND turn_id IS NULL AND kind IN ('tool_call','tool_result')
        ORDER BY sequence
      `), threadId)
      // Order-aware, matching the executor's consistency scan exactly: a
      // result closes a call only when it appears after it, and a repeated
      // call record reopens the id. Anything this scan leaves open is what
      // the executor would flag.
      const calls = new Map<string, {
        provider: CanonicalProvider | null
        toolName: string | null
        providerCallId: string | null
      }>()
      for (const row of rows) {
        const payload = parseObject(row.payload_json)
        const callId = typeof payload.callId === 'string' ? payload.callId : null
        if (!callId) continue
        if (text(row, 'kind') === 'tool_result') {
          calls.delete(callId)
          continue
        }
        calls.set(callId, {
          provider: (nullableText(row, 'provider') ?? null) as CanonicalProvider | null,
          toolName: typeof payload.name === 'string' ? payload.name : null,
          providerCallId: typeof payload.providerCallId === 'string' ? payload.providerCallId : null,
        })
      }
      const unresolved = [...calls]
      if (unresolved.length === 0) return 0

      const threadRow = this.#optional(this.#db.prepare('SELECT session_id FROM threads WHERE id=?'), threadId)
      if (!threadRow) throw new Error(`Thread not found for orphan repair: ${threadId}`)
      const sessionId = text(threadRow, 'session_id')
      const now = this.#now()
      const appended: CanonicalItem[] = []
      for (const [callId, call] of unresolved) {
        appended.push(...this.#appendItems(
          sessionId,
          threadId,
          null,
          call.provider,
          [{
            kind: 'tool_result' as const,
            visibility: 'portable' as const,
            nativeId: call.providerCallId,
            payload: {
              callId,
              ...(call.providerCallId ? { providerCallId: call.providerCallId } : {}),
              ...(call.toolName ? { toolName: call.toolName } : {}),
              synthetic: true,
              result: {
                success: false,
                content: null,
                error: {
                  code: 'tool_result_missing',
                  message: 'This tool call has no recorded result; the conversation was imported before it completed.',
                  retryable: false,
                },
              },
            },
          }],
          `baton:repair-orphan-import:${threadId}:${callId}`,
          now,
        ))
      }
      this.#db.prepare('UPDATE threads SET revision=revision+1,updated_at=? WHERE id=?').run(now, threadId)
      this.#db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(now, sessionId)
      this.#appendStreamEvent(sessionId, threadId, null, 'items_appended', {
        itemIds: appended.map((item) => item.id),
        orphanImportRecovery: true,
      }, now)
      return appended.length
    }
  }

  #repairInterruptedReadOnlyToolCalls(turn: SqlRow, now: string): number {
    const turnId = text(turn, 'id')
    const rows = this.#all(this.#db.prepare(`
      SELECT kind,payload_json FROM items
      WHERE turn_id=? AND kind IN ('tool_call','tool_result')
      ORDER BY sequence
    `), turnId)
    const completed = new Set<string>()
    const calls = new Map<string, { providerCallId: string; toolName: string }>()
    for (const row of rows) {
      const payload = parseObject(row.payload_json)
      const callId = typeof payload.callId === 'string' ? payload.callId : null
      if (!callId) continue
      if (text(row, 'kind') === 'tool_result') {
        completed.add(callId)
        continue
      }
      if (payload.sideEffect !== 'read_only' || calls.has(callId)) continue
      const providerCallId = typeof payload.providerCallId === 'string' ? payload.providerCallId : null
      const toolName = typeof payload.name === 'string' ? payload.name : null
      if (!providerCallId || !toolName) throw new Error('Corrupt database: read-only tool call identity is incomplete')
      calls.set(callId, { providerCallId, toolName })
    }
    const unresolved = [...calls].filter(([callId]) => !completed.has(callId))
    if (unresolved.length === 0) return 0

    const items = this.#appendItems(
      text(turn, 'session_id'),
      text(turn, 'thread_id'),
      turnId,
      text(turn, 'provider') as CanonicalProvider,
      unresolved.map(([callId, call]) => ({
        kind: 'tool_result' as const,
        visibility: 'portable' as const,
        nativeId: call.providerCallId,
        payload: {
          callId,
          providerCallId: call.providerCallId,
          toolName: call.toolName,
          result: {
            success: false,
            content: null,
            error: {
              code: 'runtime_interrupted',
              message: 'Runtime interrupted before a durable tool result was recorded; the output is unavailable',
              retryable: false,
            },
          },
        },
      })),
      `baton:recover-interrupted-read-only:${turnId}`,
      now,
    )
    this.#db.prepare('UPDATE threads SET revision=revision+1,updated_at=? WHERE id=?')
      .run(now, text(turn, 'thread_id'))
    this.#db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(now, text(turn, 'session_id'))
    this.#appendStreamEvent(text(turn, 'session_id'), text(turn, 'thread_id'), turnId, 'items_appended', {
      itemIds: items.map((item) => item.id),
      interruptedReadOnlyRecovery: true,
    }, now)
    return items.length
  }

  #hasUnresolvedMutatingToolCall(turnId: TurnId): boolean {
    const rows = this.#all(this.#db.prepare(`
      SELECT kind,payload_json FROM items
      WHERE turn_id=? AND kind IN ('tool_call','tool_result')
      ORDER BY sequence
    `), turnId)
    const completed = new Set<string>()
    const calls: Array<{ callId: string; sideEffect: string | null }> = []
    for (const row of rows) {
      const payload = parseObject(row.payload_json)
      const callId = typeof payload.callId === 'string' ? payload.callId : null
      if (!callId) continue
      if (text(row, 'kind') === 'tool_result') completed.add(callId)
      else calls.push({ callId, sideEffect: typeof payload.sideEffect === 'string' ? payload.sideEffect : null })
    }
    return calls.some((call) => !completed.has(call.callId)
      && (call.sideEffect === 'workspace_mutation' || call.sideEffect === 'workspace_command'
        || call.sideEffect === 'host_mutation'))
  }

  getNativeImportState(identity: NativeSourceIdentity): NativeImportStoredState | null {
    let row = this.#optional(this.#db.prepare(`
      SELECT * FROM native_session_sources
      WHERE source_client=? AND namespace_key=? AND native_session_id=?
    `), databaseSourceClient(identity.sourceClient), identity.namespaceKey, identity.nativeSessionId)
    if (!row) {
      for (const key of identity.identityKeys ?? [{ kind: 'native_session_id' as const, value: identity.nativeSessionId }]) {
        row = this.#optional(this.#db.prepare(`
          SELECT s.* FROM native_session_sources s
          JOIN native_session_identity_keys k ON k.source_id=s.id
          WHERE k.provider=? AND k.namespace_key=? AND k.identity_kind=? AND k.identity_value_hmac=?
        `), identity.provider, key.scopeNamespaceKey ?? identity.namespaceKey, key.kind, this.#nativeHmac(key.value))
        if (row) break
      }
    }
    return row ? this.#nativeImportState(row) : null
  }

  getNativeImportSigningKey(): Buffer {
    return this.#loadNativeMetaKey('token_signing_key')
  }

  getNativeImportNamespaceKey(): Buffer {
    return this.#loadNativeMetaKey('namespace_hmac_key')
  }

  beginNativeImportCommit(tokenNonceHmac: string, principalKey: string, requestDigest: string, allowCreate = true): NativeImportCommitState {
    const existing = this.#optional(this.#db.prepare(
      'SELECT principal_key,request_digest,status,receipt_json FROM native_import_commits WHERE token_nonce_hmac=?',
    ), tokenNonceHmac)
    if (existing) {
      if (text(existing, 'principal_key') !== principalKey || text(existing, 'request_digest') !== requestDigest) {
        throw new Error('native import token nonce was reused with a different request')
      }
      const status = text(existing, 'status')
      if (status !== 'applying' && status !== 'completed') throw new Error(`native import commit is ${status}`)
      return { status, receipt: parseObject(existing.receipt_json) as unknown as NativeImportReceipt }
    }
    if (!allowCreate) throw new Error('native import token has no durable commit')
    this.#db.prepare(`
      INSERT INTO native_import_commits(token_nonce_hmac,principal_key,request_digest,status,receipt_json,created_at)
      VALUES (?,?,?,'applying',?,?)
    `).run(tokenNonceHmac, principalKey, requestDigest, canonicalJson({ results: [] }), this.#now())
    return { status: 'applying', receipt: { results: [] } }
  }

  recordNativeImportCommitResult(checkpoint: NativeImportCommitCheckpoint, result: NativeImportCommitResult): void {
    this.#transaction('IMMEDIATE', () => this.#recordNativeImportCommitResult(checkpoint, result))
  }

  finishNativeImportCommit(tokenNonceHmac: string, receipt: NativeImportReceipt): void {
    const existing = this.#one(this.#db.prepare(
      "SELECT receipt_json FROM native_import_commits WHERE token_nonce_hmac=? AND status='applying'",
    ), tokenNonceHmac)
    if (canonicalJson(parseObject(existing.receipt_json)) !== canonicalJson(receipt)) {
      throw new Error('native import commit receipt does not match durable progress')
    }
    const result = this.#db.prepare(`
      UPDATE native_import_commits SET status='completed',receipt_json=?,completed_at=?
      WHERE token_nonce_hmac=? AND status='applying'
    `).run(canonicalJson(receipt), this.#now(), tokenNonceHmac)
    if (result.changes !== 1) throw new Error('native import commit receipt could not be finalized')
  }

  #recordNativeImportCommitResult(checkpoint: NativeImportCommitCheckpoint, result: NativeImportCommitResult): void {
    const row = this.#one(this.#db.prepare(`
      SELECT principal_key,request_digest,status,receipt_json FROM native_import_commits WHERE token_nonce_hmac=?
    `), checkpoint.tokenNonceHmac)
    if (text(row, 'principal_key') !== checkpoint.principalKey || text(row, 'request_digest') !== checkpoint.requestDigest
      || text(row, 'status') !== 'applying') throw new Error('native import commit checkpoint is not applying')
    const receipt = parseObject(row.receipt_json) as unknown as NativeImportReceipt
    if (!Array.isArray(receipt.results) || receipt.results.length !== checkpoint.candidateOrdinal) {
      throw new Error('native import commit checkpoint is out of order')
    }
    receipt.results.push(result)
    const updated = this.#db.prepare(`
      UPDATE native_import_commits SET receipt_json=? WHERE token_nonce_hmac=? AND status='applying' AND receipt_json=?
    `).run(canonicalJson(receipt), checkpoint.tokenNonceHmac, text(row, 'receipt_json'))
    if (updated.changes !== 1) throw new Error('native import commit checkpoint compare-and-swap failed')
  }

  commitNativeImport(input: CommitNativeImportInput): NativeImportCommitResult {
    return this.#transaction('IMMEDIATE', () => {
      const candidate = input.candidate
      const existing = this.#nativeSourceRow(candidate)
      if (existing && text(existing, 'current_content_digest') === candidate.contentDigest) {
        this.#promoteNativeSource(existing, candidate)
        this.#reconcileNativeGoal(existing, candidate, true)
        const result = { candidateId: candidate.candidateId, status: 'duplicate' as const,
          sessionId: text(existing, 'session_id'), importedItemCount: 0 }
        if (input.commitCheckpoint) this.#recordNativeImportCommitResult(input.commitCheckpoint, result)
        return result
      }
      if (existing) {
        const result = this.#appendNativeImport(existing, input)
        if (input.commitCheckpoint) this.#recordNativeImportCommitResult(input.commitCheckpoint, result)
        return result
      }
      if (input.previewedState) throw new Error('native source identity disappeared after preview')
      const result = this.#createNativeImport(input)
      if (input.commitCheckpoint) this.#recordNativeImportCommitResult(input.commitCheckpoint, result)
      return result
    })
  }

  #createNativeImport(
    input: CommitNativeImportInput,
    preservedIds?: { sessionId: string; threadId: string; sourceId: string },
  ): NativeImportCommitResult {
    const candidate = input.candidate
    const sessionId = preservedIds?.sessionId ?? this.#idFactory()
    const threadId = preservedIds?.threadId ?? this.#idFactory()
    const sourceId = preservedIds?.sourceId ?? this.#idFactory()
    const revisionId = this.#idFactory()
    const now = this.#now()
    this.#db.prepare(`
      INSERT INTO sessions(id,title,preview,active_thread_id,project_key,cwd,schema_version,next_item_sequence,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,1,?,?)
    `).run(
      sessionId, candidate.sourceAlias, null, threadId, candidate.projectGroupKey,
      // The native source records its working directory; carry it onto the
      // session so an imported conversation arrives already connected to its
      // project folder instead of requiring a manual workspace hookup.
      candidate.cwd ?? null,
      SCHEMA_VERSION, now, now,
    )
    this.#db.prepare(`
      INSERT INTO threads(id,session_id,parent_thread_id,fork_turn_id,fork_item_id,revision,status,instruction_snapshot_json,created_at,updated_at)
      VALUES (?,?,NULL,NULL,NULL,0,'idle',?,?,?)
    `).run(threadId, sessionId, canonicalJson({ importMode: 'fork_copy' }), now, now)
    const imported = this.#appendItems(sessionId, threadId, null, candidate.provider, candidate.records.map((record) => record.item), null, now)
    const last = candidate.records.at(-1)
    this.#db.prepare(`
      INSERT INTO native_session_sources(
        id,session_id,source_client,provider,namespace_key,native_session_id,source_alias,alias_source,title_source,project_alias,cwd,
        current_content_digest,current_prefix_digest,current_last_record_ordinal,current_last_record_digest,imported_item_sequence,
        first_imported_at,last_imported_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(sourceId, sessionId, databaseSourceClient(candidate.sourceClient), candidate.provider, candidate.namespaceKey,
      candidate.nativeSessionId, candidate.sourceAlias, candidate.aliasSource, candidate.titleSource ?? null,
      candidate.projectAlias, candidate.cwd,
      candidate.contentDigest, last?.prefixDigest ?? candidate.contentDigest, candidate.records.length,
      last?.digest ?? candidate.contentDigest, imported.length, now, now)
    this.#insertNativeIdentityKeys(sourceId, candidate)
    this.#insertNativeProvenance(sourceId, candidate, now)
    this.#insertNativeRevision(revisionId, sourceId, candidate, now)
    this.#insertNativeRecords(sourceId, revisionId, candidate.records, imported, now)
    this.#appendStreamEvent(sessionId, threadId, null, 'session_created', { sessionId, threadId, imported: true }, now)
    if (imported.length) this.#appendStreamEvent(sessionId, threadId, null, 'items_appended', { itemIds: imported.map((item) => item.id) }, now)
    this.#reconcileNativeGoal(this.#one(this.#db.prepare('SELECT * FROM native_session_sources WHERE id=?'), sourceId), candidate, true)
    return { candidateId: candidate.candidateId, status: 'imported', sessionId, importedItemCount: imported.length }
  }

  #appendNativeImport(existing: SqlRow, input: CommitNativeImportInput): NativeImportCommitResult {
    const candidate = input.candidate
    const current = this.#nativeImportState(existing)
    if (!input.previewedState || input.previewedState.sourceId !== current.sourceId
      || input.previewedState.contentDigest !== current.contentDigest) throw new Error('native import state changed after preview')
    const sessionRow = this.#one(this.#db.prepare(`
      SELECT s.next_item_sequence,s.active_thread_id,t.id AS root_thread_id,t.revision,
        (SELECT COUNT(*) FROM threads child WHERE child.session_id=s.id AND child.id<>t.id) AS fork_count,
        (SELECT COUNT(*) FROM turns turn_row WHERE turn_row.thread_id=t.id) AS turn_count,
        (SELECT COUNT(*) FROM items item_row WHERE item_row.session_id=s.id) AS item_count,
        (SELECT COUNT(*) FROM follow_ups follow_up WHERE follow_up.session_id=s.id) AS follow_up_count,
        (SELECT COUNT(*) FROM provider_bindings binding WHERE binding.thread_id=t.id) AS binding_count,
        (SELECT COUNT(*) FROM goals goal WHERE goal.thread_id=t.id
          AND (goal.revision>1 OR goal.status<>'paused')) AS changed_goal_count
      FROM sessions s JOIN threads t ON t.session_id=s.id AND t.parent_thread_id IS NULL WHERE s.id=?
    `), current.sessionId)
    const untouchedRoot = text(sessionRow, 'active_thread_id') === text(sessionRow, 'root_thread_id')
      && integer(sessionRow, 'fork_count') === 0
      && integer(sessionRow, 'turn_count') === 0
      && integer(sessionRow, 'item_count') === current.importedItemSequence
      && integer(sessionRow, 'next_item_sequence') === current.importedItemSequence + 1
      && integer(sessionRow, 'follow_up_count') === 0
    const boundary = candidate.records[current.lastRecordOrdinal - 1]
    const sourceRewritten = current.lastRecordOrdinal > candidate.records.length
      || (current.lastRecordOrdinal > 0 && (!boundary
        || boundary.prefixDigest !== current.prefixDigest || boundary.digest !== current.lastRecordDigest))
    if (sourceRewritten) {
      if (!untouchedRoot) {
        throw new Error('source_rewritten_conflict: imported session has Baton turns, items, or forks')
      }
      this.#deleteUntouchedNativeImport(current.sourceId, current.sessionId)
      const replacement = this.#createNativeImport({ ...input, previewedState: null }, {
        sessionId: current.sessionId,
        threadId: text(sessionRow, 'root_thread_id'),
        sourceId: current.sourceId,
      })
      return { ...replacement, status: 'updated' }
    }
    if (!untouchedRoot) {
      throw new Error('update_conflict_after_fork: imported session is no longer an untouched root thread')
    }
    const delta = candidate.records.slice(current.lastRecordOrdinal)
    const now = this.#now()
    const threadId = text(sessionRow, 'active_thread_id')
    const imported = this.#appendItems(current.sessionId, threadId, null, candidate.provider, delta.map((record) => record.item), null, now)
    const revisionId = this.#idFactory()
    const last = candidate.records.at(-1)
    const updated = this.#db.prepare(`
      UPDATE native_session_sources SET current_content_digest=?,current_prefix_digest=?,
        current_last_record_ordinal=?,current_last_record_digest=?,imported_item_sequence=?,last_imported_at=?
      WHERE id=? AND current_content_digest=? AND imported_item_sequence=?
    `).run(candidate.contentDigest,
      last?.prefixDigest ?? candidate.contentDigest, candidate.records.length, last?.digest ?? candidate.contentDigest,
      current.importedItemSequence + imported.length, now, current.sourceId, current.contentDigest, current.importedItemSequence)
    if (updated.changes !== 1) throw new Error('native import compare-and-swap failed')
    this.#insertNativeRevision(revisionId, current.sourceId, candidate, now)
    this.#insertNativeRecords(current.sourceId, revisionId, delta, imported, now)
    this.#promoteNativeSource(existing, candidate)
    this.#db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(now, current.sessionId)
    if (imported.length) this.#appendStreamEvent(current.sessionId, threadId, null, 'items_appended', { itemIds: imported.map((item) => item.id), nativeDelta: true }, now)
    this.#reconcileNativeGoal(existing, candidate, true)
    return { candidateId: candidate.candidateId, status: 'updated', sessionId: current.sessionId, importedItemCount: imported.length }
  }

  #deleteUntouchedNativeImport(sourceId: string, sessionId: string): void {
    this.#db.exec('PRAGMA defer_foreign_keys = ON')
    const contextCount = integer(this.#one(this.#db.prepare(
      'SELECT COUNT(*) AS count FROM session_purge_context',
    )), 'count')
    if (contextCount !== 0) throw new Error('Session purge context is unexpectedly occupied')
    this.#db.prepare('INSERT INTO session_purge_context(session_id) VALUES (?)').run(sessionId)
    this.#db.prepare('DELETE FROM native_imported_records WHERE source_id=?').run(sourceId)
    this.#db.prepare('DELETE FROM native_session_revisions WHERE source_id=?').run(sourceId)
    this.#db.prepare('DELETE FROM native_session_identity_keys WHERE source_id=?').run(sourceId)
    this.#db.prepare('DELETE FROM native_session_source_provenance WHERE source_id=?').run(sourceId)
    this.#db.prepare('DELETE FROM native_session_sources WHERE id=?').run(sourceId)
    this.#db.prepare('DELETE FROM goal_events WHERE session_id=?').run(sessionId)
    this.#db.prepare(`DELETE FROM goals WHERE thread_id IN (
      SELECT id FROM threads WHERE session_id=?
    )`).run(sessionId)
    this.#db.prepare(`DELETE FROM provider_bindings WHERE thread_id IN (
      SELECT id FROM threads WHERE session_id=?
    )`).run(sessionId)
    this.#db.prepare('DELETE FROM stream_events WHERE session_id=?').run(sessionId)
    this.#db.prepare('DELETE FROM items WHERE session_id=?').run(sessionId)
    this.#db.prepare('DELETE FROM threads WHERE session_id=?').run(sessionId)
    const deleted = this.#db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId)
    this.#db.prepare('DELETE FROM session_purge_context WHERE session_id=?').run(sessionId)
    if (deleted.changes !== 1 || this.#all(this.#db.prepare('PRAGMA foreign_key_check')).length > 0) {
      throw new Error('native import replacement failed integrity validation')
    }
  }

  reconcileNativeGoal(candidate: NativeSessionCandidate, apply = true): NativeGoalReconcileResult {
    return this.#transaction('IMMEDIATE', () => {
      const source = this.#nativeSourceRow(candidate)
      return source
        ? this.#reconcileNativeGoal(source, candidate, apply)
        : { candidateId: candidate.candidateId, status: 'no_import' }
    })
  }

  #reconcileNativeGoal(source: SqlRow, candidate: NativeSessionCandidate, apply: boolean): NativeGoalReconcileResult {
    const sessionId = text(source, 'session_id')
    const base = { candidateId: candidate.candidateId, sessionId }
    if (!candidate.goal) return { ...base, status: 'no_goal' }
    const threadRow = this.#optional(this.#db.prepare(
      'SELECT id FROM threads WHERE session_id=? AND parent_thread_id IS NULL',
    ), sessionId)
    if (!threadRow) return { ...base, status: 'invalid_goal', error: 'Imported root thread is missing' }
    const threadId = text(threadRow, 'id')
    const contextual = { ...base, threadId }
    const current = this.#optional(this.#db.prepare('SELECT id FROM goals WHERE thread_id=?'), threadId)
    if (current) return { ...contextual, status: 'existing_goal', goalId: text(current, 'id') }
    try {
      validateGoalObjective(candidate.goal.objective)
      if (!candidate.goal.model) throw new GoalStoreError('invalid_goal_input', 'Goal model must not be empty')
    } catch (error) {
      return { ...contextual, status: 'invalid_goal', error: error instanceof Error ? error.message : String(error) }
    }
    if (!apply) return { ...contextual, status: 'would_restore' }

    const now = this.#now()
    const id = this.#idFactory()
    const reason: GoalStatusReason = {
      code: 'native_goal_restored_paused', source: 'host',
      message: 'Restored from an imported native conversation and paused for review', at: now,
    }
    this.#db.prepare(`
      INSERT INTO goals(
        id,thread_id,objective,status,status_reason_json,revision,provider,model,effort,
        token_budget,tokens_used,time_used_seconds,max_automatic_turns,automatic_turns_used,
        max_active_seconds,no_progress_count,last_progress_digest,created_at,updated_at,started_at,completed_at
      ) VALUES (?,?,?,'paused',?,1,?,?,?, NULL,0,0,?,0,?,0,NULL,?,?,?,NULL)
    `).run(id, threadId, candidate.goal.objective, canonicalJson(reason), candidate.provider,
      candidate.goal.model, candidate.goal.effort, DEFAULT_GOAL_TURNS, DEFAULT_GOAL_ACTIVE_SECONDS, now, now, now)
    const restored = this.#goal(this.#one(this.#db.prepare('SELECT * FROM goals WHERE id=?'), id))
    this.#appendGoalEvent(restored, sessionId, 'goal_created', {
      goal: restored,
      nativeImport: {
        sourceId: text(source, 'id'), sourceClient: candidate.sourceClient,
        parserVersion: candidate.parserVersion, evidence: candidate.goal.evidence,
        detectedAt: candidate.goal.detectedAt,
      },
    }, now)
    this.#appendGoalChanged(restored, sessionId, null, now)
    return { ...contextual, status: 'restored', goalId: restored.id }
  }

  #nativeSourceRow(identity: NativeSourceIdentity): SqlRow | null {
    const state = this.getNativeImportState(identity)
    return state ? this.#optional(this.#db.prepare('SELECT * FROM native_session_sources WHERE id=?'), state.sourceId) : null
  }

  #nativeImportState(row: SqlRow): NativeImportStoredState {
    return {
      sourceId: text(row, 'id'), sessionId: text(row, 'session_id'),
      contentDigest: text(row, 'current_content_digest'), prefixDigest: text(row, 'current_prefix_digest'),
      lastRecordOrdinal: integer(row, 'current_last_record_ordinal'), lastRecordDigest: text(row, 'current_last_record_digest'),
      importedItemSequence: integer(row, 'imported_item_sequence'),
    }
  }

  #insertNativeIdentityKeys(sourceId: string, candidate: CommitNativeImportInput['candidate']): void {
    const insert = this.#db.prepare(`
      INSERT OR IGNORE INTO native_session_identity_keys(source_id,provider,namespace_key,identity_kind,identity_value_hmac)
      VALUES (?,?,?,?,?)
    `)
    for (const key of candidate.identityKeys) insert.run(sourceId, candidate.provider,
      key.scopeNamespaceKey ?? candidate.namespaceKey, key.kind, this.#nativeHmac(key.value))
  }

  #promoteNativeSource(existing: SqlRow, candidate: CommitNativeImportInput['candidate']): void {
    const sourceId = text(existing, 'id')
    const now = this.#now()
    this.#db.prepare(`
      INSERT OR IGNORE INTO native_session_identity_keys(source_id,provider,namespace_key,identity_kind,identity_value_hmac)
      VALUES (?,?,?,?,?)
    `).run(sourceId, text(existing, 'provider'), text(existing, 'namespace_key'), 'native_session_id',
      this.#nativeHmac(text(existing, 'native_session_id')))
    this.#insertNativeIdentityKeys(sourceId, candidate)
    this.#insertNativeProvenance(sourceId, candidate, now)
    const currentClient = text(existing, 'source_client')
    const candidateClient = databaseSourceClient(candidate.sourceClient)
    const promoteClient = sourceClientRank(candidate.sourceClient) > sourceClientRank(currentClient)
    const promoteAlias = aliasSourceRank(candidate.aliasSource) > aliasSourceRank(text(existing, 'alias_source'))
      || (aliasSourceRank(candidate.aliasSource) === aliasSourceRank(text(existing, 'alias_source'))
        && candidate.sourceAlias !== nullableText(existing, 'source_alias'))
    const samePrimary = candidateClient === currentClient && candidate.namespaceKey === text(existing, 'namespace_key')
      && candidate.nativeSessionId === text(existing, 'native_session_id')
    const refreshTitleSource = samePrimary && candidate.sourceAlias === nullableText(existing, 'source_alias')
      && aliasSourceRank(candidate.aliasSource) === aliasSourceRank(text(existing, 'alias_source'))
      && candidate.titleSource != null && candidate.titleSource !== nullableText(existing, 'title_source')
    const refreshLocation = samePrimary && (candidate.cwd !== nullableText(existing, 'cwd')
      || candidate.projectAlias !== nullableText(existing, 'project_alias'))
    if (!promoteClient && !promoteAlias && !refreshLocation && !refreshTitleSource) return
    const sourceClient = promoteClient ? candidateClient : currentClient
    const namespaceKey = promoteClient ? candidate.namespaceKey : text(existing, 'namespace_key')
    const nativeSessionId = promoteClient ? candidate.nativeSessionId : text(existing, 'native_session_id')
    const alias = promoteClient || promoteAlias ? candidate.sourceAlias : nullableText(existing, 'source_alias')
    const aliasSource = promoteClient || promoteAlias ? candidate.aliasSource : text(existing, 'alias_source')
    const titleSource = promoteClient || promoteAlias ? candidate.titleSource ?? null
      : refreshTitleSource ? candidate.titleSource ?? null : nullableText(existing, 'title_source')
    const projectAlias = promoteClient || promoteAlias || refreshLocation
      ? candidate.projectAlias : nullableText(existing, 'project_alias')
    const cwd = promoteClient || refreshLocation ? candidate.cwd : nullableText(existing, 'cwd')
    this.#db.prepare(`
      UPDATE native_session_sources SET source_client=?,namespace_key=?,native_session_id=?,source_alias=?,alias_source=?,
        title_source=?,project_alias=?,cwd=?,last_imported_at=? WHERE id=?
    `).run(sourceClient, namespaceKey, nativeSessionId, alias, aliasSource, titleSource, projectAlias, cwd, now, sourceId)
    this.#db.prepare(`
      UPDATE sessions SET title=CASE WHEN title=? OR title IS NULL THEN ? ELSE title END,
        project_key=COALESCE(?,project_key),updated_at=? WHERE id=?
    `).run(nullableText(existing, 'source_alias'), alias, candidate.projectGroupKey, now, text(existing, 'session_id'))
  }

  #insertNativeProvenance(sourceId: string, candidate: CommitNativeImportInput['candidate'], now: string): void {
    this.#db.prepare(`
      INSERT OR IGNORE INTO native_session_source_provenance(
        source_id,source_client,namespace_key,native_session_id_hmac,source_alias,alias_source,project_alias,discovered_at
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(sourceId, databaseSourceClient(candidate.sourceClient), candidate.namespaceKey, this.#nativeHmac(candidate.nativeSessionId),
      candidate.sourceAlias, candidate.aliasSource, candidate.projectAlias, now)
  }

  #insertNativeRevision(revisionId: string, sourceId: string, candidate: CommitNativeImportInput['candidate'], now: string): void {
    const last = candidate.records.at(-1)
    this.#db.prepare(`
      INSERT INTO native_session_revisions(id,source_id,content_digest,prefix_digest,source_head_json,parser_version,
        portable_item_count,skipped_item_count,last_record_ordinal,last_record_digest,imported_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(revisionId, sourceId, candidate.contentDigest, last?.prefixDigest ?? candidate.contentDigest,
      canonicalJson(candidate.sourceHead), candidate.parserVersion, candidate.records.length, candidate.skippedItemCount,
      candidate.records.length, last?.digest ?? candidate.contentDigest, now)
  }

  #insertNativeRecords(sourceId: string, revisionId: string, records: CommitNativeImportInput['candidate']['records'], items: CanonicalItem[], now: string): void {
    const insert = this.#db.prepare(`
      INSERT INTO native_imported_records(source_id,native_record_key_hmac,item_id,source_revision_id,source_ordinal,normalized_record_digest,imported_at)
      VALUES (?,?,?,?,?,?,?)
    `)
    records.forEach((record, index) => insert.run(sourceId, this.#nativeHmac(record.key), items[index]?.id ?? null,
      revisionId, record.ordinal, record.digest, now))
  }

  #loadNativeIdentityKey(): Buffer {
    return this.#loadNativeMetaKey('identity_hmac_key')
  }

  #loadNativeMetaKey(key: string): Buffer {
    const row = this.#one(this.#db.prepare('SELECT value FROM native_import_meta WHERE key=?'), key)
    if (!(row.value instanceof Uint8Array)) throw new Error('Corrupt database: native import HMAC key is missing')
    return Buffer.from(row.value)
  }

  #nativeHmac(value: string): string { return createHmac('sha256', this.#nativeIdentityKey).update(value).digest('hex') }

  /**
   * Checkpoint and truncate the WAL so it cannot grow without bound (long
   * external readers previously starved auto-checkpointing until the WAL hit
   * hundreds of megabytes). Best-effort: with concurrent readers SQLite
   * checkpoints as far as it can and reports busy instead of throwing.
   */
  checkpointWal(): void {
    try {
      this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    } catch {
      // A locked database is not fatal here; the next interval retries.
    }
  }

  close(): void {
    this.#db.close()
  }

  #lineage(leaf: CanonicalThread): LineageSegment[] {
    const reversed: LineageSegment[] = []
    const visited = new Set<string>()
    let current: CanonicalThread | null = leaf
    let cap: number | null = null
    while (current) {
      if (visited.has(current.id)) throw new Error('Corrupt database: thread lineage cycle')
      visited.add(current.id)
      reversed.push({ thread: current, maximumItemSequence: cap })
      if (current.parentThreadId === null) break
      if (current.forkItemId !== null) {
        const forkRow = this.#optional(this.#db.prepare('SELECT sequence,session_id FROM items WHERE id=?'), current.forkItemId)
        if (!forkRow || text(forkRow, 'session_id') !== current.sessionId) {
          throw new Error('Corrupt database: invalid fork item')
        }
        const forkSequence = integer(forkRow, 'sequence')
        cap = cap === null ? forkSequence : Math.min(cap, forkSequence)
      } else {
        cap = 0
      }
      current = this.getThread(current.parentThreadId)
      if (!current) throw new Error('Corrupt database: parent thread is missing')
      if (current.sessionId !== leaf.sessionId) throw new Error('Corrupt database: cross-session lineage')
    }
    return reversed.reverse()
  }

  #itemsForSegments(segments: LineageSegment[], afterSequence: number): CanonicalItem[] {
    const result: CanonicalItem[] = []
    for (const segment of segments) {
      const rows = segment.maximumItemSequence === null
        ? this.#all(this.#db.prepare(
            'SELECT * FROM items WHERE thread_id=? AND sequence>? ORDER BY sequence',
          ), segment.thread.id, afterSequence)
        : this.#all(this.#db.prepare(
            'SELECT * FROM items WHERE thread_id=? AND sequence>? AND sequence<=? ORDER BY sequence',
          ), segment.thread.id, afterSequence, segment.maximumItemSequence)
      result.push(...rows.map((row) => this.#item(row)))
    }
    return result.sort((left, right) => left.sequence - right.sequence)
  }

  #appendItems(
    sessionId: string,
    threadId: string,
    turnId: string | null,
    defaultProvider: CanonicalProvider | null,
    values: NewCanonicalItem[],
    originEventId: string | null,
    now: string,
  ): CanonicalItem[] {
    if (values.length === 0) return []
    const sessionRow = this.#one(this.#db.prepare('SELECT next_item_sequence FROM sessions WHERE id=?'), sessionId)
    let sequence = integer(sessionRow, 'next_item_sequence')
    const result: CanonicalItem[] = []
    const insert = this.#db.prepare(`
      INSERT INTO items(id,session_id,thread_id,turn_id,sequence,kind,visibility,payload_json,provider,native_id,origin_event_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `)
    for (const value of values) {
      const visibility = value.visibility ?? 'portable'
      const provider = value.provider === undefined ? defaultProvider : value.provider
      if (visibility === 'provider_private' && provider == null) {
        throw new TypeError('Provider-private items require provider provenance')
      }
      const id = this.#idFactory()
      insert.run(id, sessionId, threadId, turnId, sequence, value.kind, visibility,
        canonicalJson(value.payload), provider ?? null, value.nativeId ?? null, originEventId, now)
      result.push({
        id,
        sessionId,
        threadId,
        turnId,
        sequence,
        kind: value.kind,
        visibility,
        payload: JSON.parse(canonicalJson(value.payload)) as Record<string, unknown>,
        provider: provider ?? null,
        nativeId: value.nativeId ?? null,
        createdAt: now,
      })
      sequence += 1
    }
    this.#db.prepare('UPDATE sessions SET next_item_sequence=? WHERE id=?').run(sequence, sessionId)
    return result
  }

  #itemsByIds(ids: string[]): CanonicalItem[] {
    if (ids.length === 0) return []
    const statement = this.#db.prepare('SELECT * FROM items WHERE id=?')
    return ids.map((id) => this.#item(this.#one(statement, id)))
  }

  #goalScopeMatches(threadId: string, goalId: string, goalRevision: number): boolean {
    return this.#optional(this.#db.prepare(`
      SELECT id FROM goals WHERE thread_id=? AND id=? AND revision=? AND status='active'
    `), threadId, goalId, goalRevision) !== null
  }

  #markStaleGoalFollowUps(threadId: string, now: string): number {
    const rows = this.#all(this.#db.prepare(`
      SELECT * FROM follow_ups WHERE thread_id=? AND status='queued' AND goal_id IS NOT NULL
      ORDER BY sequence
    `), threadId)
    let changed = 0
    for (const row of rows) {
      if (this.#goalScopeMatches(threadId, text(row, 'goal_id'), integer(row, 'goal_revision'))) continue
      this.#setFollowUpTerminal(row, 'stale_goal', now)
      changed += 1
    }
    return changed
  }

  #setFollowUpTerminal(
    row: SqlRow,
    status: Extract<CanonicalFollowUp['status'], 'cancelled' | 'stale_goal' | 'delivery_unknown'>,
    now: string,
  ): CanonicalFollowUp {
    this.#db.prepare(`
      UPDATE follow_ups SET status=?,target_turn_id=NULL,dispatch_owner=NULL,lease_expires_at=NULL,dispatch_kind=NULL,
        revision=revision+1,updated_at=? WHERE id=?
    `).run(status, now, text(row, 'id'))
    const followUp = this.#followUp(this.#one(this.#db.prepare('SELECT * FROM follow_ups WHERE id=?'), text(row, 'id')))
    this.#appendFollowUpChanged(followUp, now)
    return followUp
  }

  #requeueClaimedFollowUp(
    row: SqlRow,
    ownerId: string,
    targetTurnId: string | null,
    now: string,
  ): CanonicalFollowUp {
    if (text(row, 'status') !== 'dispatching' || nullableText(row, 'dispatch_owner') !== ownerId) {
      throw new FollowUpStoreError('follow_up_lease_lost', 'Follow-up claim is missing or owned elsewhere')
    }
    if (targetTurnId !== null) {
      const target = this.#optional(this.#db.prepare('SELECT * FROM turns WHERE id=?'), targetTurnId)
      if (!target || text(target, 'thread_id') !== text(row, 'thread_id')
        || !ACTIVE_TURN_STATUSES.has(text(target, 'status'))
        || text(target, 'follow_up_window') !== 'accepting') {
        throw new FollowUpStoreError('invalid_follow_up', 'Requeue target turn is not accepting input')
      }
    }
    this.#db.prepare(`
      UPDATE follow_ups SET status='queued',target_turn_id=?,dispatch_owner=NULL,lease_expires_at=NULL,dispatch_kind=NULL,
        revision=revision+1,updated_at=? WHERE id=? AND status='dispatching' AND dispatch_owner=?
    `).run(targetTurnId, now, text(row, 'id'), ownerId)
    const queued = this.#followUp(this.#one(this.#db.prepare('SELECT * FROM follow_ups WHERE id=?'), text(row, 'id')))
    this.#appendFollowUpChanged(queued, now)
    return queued
  }

  #closeFollowUpWindow(turnId: string, now: string): CloseFollowUpWindowResult {
    this.#db.prepare("UPDATE turns SET follow_up_window='closed' WHERE id=?").run(turnId)
    const rows = this.#all(this.#db.prepare(`
      SELECT * FROM follow_ups WHERE target_turn_id=? AND status='queued' ORDER BY sequence
    `), turnId)
    for (const row of rows) {
      this.#db.prepare(`
        UPDATE follow_ups SET target_turn_id=NULL,revision=revision+1,updated_at=? WHERE id=? AND status='queued'
      `).run(now, text(row, 'id'))
      const queued = this.#followUp(this.#one(this.#db.prepare('SELECT * FROM follow_ups WHERE id=?'), text(row, 'id')))
      this.#appendFollowUpChanged(queued, now)
    }
    const inFlight = integer(this.#one(this.#db.prepare(`
      SELECT COUNT(*) AS count FROM follow_ups WHERE target_turn_id=? AND status='dispatching'
    `), turnId), 'count')
    return { requeued: rows.length, inFlight }
  }

  #recoverFollowUpClaimsForTurn(turnId: string, now: string): number {
    const rows = this.#all(this.#db.prepare(`
      SELECT * FROM follow_ups WHERE target_turn_id=? AND status='dispatching' ORDER BY sequence
    `), turnId)
    for (const row of rows) {
      if (nullableText(row, 'dispatch_kind') === 'steer') {
        this.#setFollowUpTerminal(row, 'delivery_unknown', now)
        continue
      }
      const goalId = nullableText(row, 'goal_id')
      const goalRevision = row.goal_revision === null ? null : integer(row, 'goal_revision')
      if (goalId !== null && goalRevision !== null
        && !this.#goalScopeMatches(text(row, 'thread_id'), goalId, goalRevision)) {
        this.#setFollowUpTerminal(row, 'stale_goal', now)
        continue
      }
      this.#db.prepare(`
        UPDATE follow_ups SET status='queued',target_turn_id=NULL,dispatch_owner=NULL,lease_expires_at=NULL,dispatch_kind=NULL,
          revision=revision+1,updated_at=? WHERE id=? AND status='dispatching'
      `).run(now, text(row, 'id'))
      const queued = this.#followUp(this.#one(this.#db.prepare('SELECT * FROM follow_ups WHERE id=?'), text(row, 'id')))
      this.#appendFollowUpChanged(queued, now)
    }
    return rows.length
  }

  #itemEnvelope(row: SqlRow): Record<string, unknown> {
    return {
      id: text(row, 'id'),
      sessionId: text(row, 'session_id'),
      threadId: text(row, 'thread_id'),
      turnId: nullableText(row, 'turn_id'),
      sequence: integer(row, 'sequence'),
      kind: text(row, 'kind'),
      visibility: text(row, 'visibility'),
      payload: parseObject(row.payload_json),
      provider: nullableText(row, 'provider'),
      nativeId: nullableText(row, 'native_id'),
      createdAt: text(row, 'created_at'),
    }
  }

  #itemDigest(row: SqlRow): string {
    return sha256Canonical(this.#itemEnvelope(row))
  }

  #sourceHashForItems(items: ContextCompactionSourceItem[]): string {
    return sha256Canonical(items.map((item) => this.#itemEnvelope(
      this.#one(this.#db.prepare('SELECT * FROM items WHERE id=?'), item.itemId),
    )))
  }

  #resolveCompactionSource(threadId: ThreadId, sourceItemIds: string[]): ContextCompactionSourceItem[] {
    if (!Array.isArray(sourceItemIds) || sourceItemIds.length === 0
      || sourceItemIds.some((id) => typeof id !== 'string' || !id)) {
      throw new ContextPersistenceError('invalid_input', 'Compaction source must contain canonical item IDs')
    }
    if (new Set(sourceItemIds).size !== sourceItemIds.length) {
      throw new ContextPersistenceError('invalid_input', 'Compaction source item IDs must be unique')
    }
    const thread = this.getThread(threadId)
    if (!thread) throw new ContextPersistenceError('not_found', `Thread not found: ${threadId}`)
    const lineage = this.#itemsForSegments(this.#lineage(thread), 0)
    let previousIndex = -1
    for (const id of sourceItemIds) {
      const index = lineage.findIndex((item, candidateIndex) => candidateIndex > previousIndex && item.id === id)
      if (index < 0) {
        throw new ContextPersistenceError(
          'invalid_input',
          'Compaction source must be an exact ordered subset of the canonical thread lineage',
        )
      }
      previousIndex = index
    }
    if (previousIndex < 0) {
      throw new ContextPersistenceError(
        'invalid_input',
        'Compaction source must contain canonical lineage items',
      )
    }
    const frontierSequence = lineage[previousIndex]!.sequence
    const leadingTurnless: CanonicalItem[] = []
    for (const item of lineage) {
      if (item.turnId !== null) break
      leadingTurnless.push(item)
    }
    const leadingTurnlessEnd = leadingTurnless.at(-1)?.sequence
    if (leadingTurnlessEnd !== undefined && leadingTurnlessEnd > frontierSequence) {
      throw new ContextPersistenceError(
        'invalid_input',
        'Compaction source must cover the complete leading turnless prefix',
      )
    }
    const leadingTurnlessIds = new Set(leadingTurnless.map((item) => item.id))
    const covered = lineage.filter((item) => item.sequence <= frontierSequence
      && (item.turnId !== null || leadingTurnlessIds.has(item.id)))
    if (covered.length !== sourceItemIds.length
      || covered.some((item, index) => item.id !== sourceItemIds[index])) {
      throw new ContextPersistenceError(
        'invalid_input',
        'Compaction source must cover every canonical item in the terminal turn prefix',
      )
    }
    if (leadingTurnless.length > 0 && !hasSafeContextToolState(leadingTurnless)) {
      throw new ContextPersistenceError(
        'invalid_input',
        'Compaction source must stay within a terminal prefix with resolved tool state',
      )
    }
    const coveredByTurn = new Map<string, CanonicalItem[]>()
    for (const item of covered) {
      if (item.turnId === null) continue
      const turnItems = coveredByTurn.get(item.turnId) ?? []
      turnItems.push(item)
      coveredByTurn.set(item.turnId, turnItems)
    }
    for (const [turnId, turnItems] of coveredByTurn) {
      const turn = this.#one(this.#db.prepare('SELECT status FROM turns WHERE id=?'), turnId)
      if (!TERMINAL_TURN_STATUSES.has(text(turn, 'status')) || !hasSafeContextToolState(turnItems)) {
        throw new ContextPersistenceError(
          'invalid_input',
          'Compaction source must stay within a terminal prefix with resolved tool state',
        )
      }
    }
    return sourceItemIds.map((itemId, ordinal) => {
      const row = this.#one(this.#db.prepare('SELECT * FROM items WHERE id=?'), itemId)
      const turnId = nullableText(row, 'turn_id')
      if (turnId !== null) {
        const turn = this.#one(this.#db.prepare('SELECT status FROM turns WHERE id=?'), turnId)
        if (!TERMINAL_TURN_STATUSES.has(text(turn, 'status'))) {
          throw new ContextPersistenceError('invalid_input', 'Compaction source cannot include an active turn')
        }
      }
      return {
        ordinal,
        itemId,
        itemSequence: integer(row, 'sequence'),
        itemDigest: this.#itemDigest(row),
      }
    })
  }

  #sourceItemsForJob(row: SqlRow): ContextCompactionSourceItem[] {
    const sourceItemIds = parseArray(row.source_item_ids_json).map((value) => {
      if (typeof value !== 'string' || !value) {
        throw new ContextPersistenceError('integrity_violation', 'Compaction job contains an invalid source item ID')
      }
      return value
    })
    const sourceItems = this.#resolveCompactionSource(text(row, 'thread_id'), sourceItemIds)
    if (this.#sourceHashForItems(sourceItems) !== text(row, 'source_hash')) {
      throw new ContextPersistenceError('integrity_violation', 'Compaction job source hash does not match canonical items')
    }
    const expectedRequestHash = sha256Canonical({
      schema: 'baton.context-compaction-request.v2',
      threadId: text(row, 'thread_id'),
      viewKey: text(row, 'view_key'),
      sourceItemIds,
      sourceHash: text(row, 'source_hash'),
      summaryInputHash: text(row, 'summary_input_hash'),
      expectedPreviousArtifactId: nullableText(row, 'expected_previous_artifact_id'),
    })
    const legacyRequestHash = sha256Canonical({
      schema: 'baton.context-compaction-request.v1',
      threadId: text(row, 'thread_id'),
      sourceItemIds,
      sourceHash: text(row, 'source_hash'),
      summaryInputHash: text(row, 'summary_input_hash'),
      expectedPreviousArtifactId: nullableText(row, 'expected_previous_artifact_id'),
    })
    if (expectedRequestHash !== text(row, 'request_hash')
      && !(text(row, 'view_key') === LEGACY_CONTEXT_VIEW_KEY
        && legacyRequestHash === text(row, 'request_hash'))) {
      throw new ContextPersistenceError('integrity_violation', 'Compaction job request hash is invalid')
    }
    const expectedPreviousArtifactId = nullableText(row, 'expected_previous_artifact_id')
    if (expectedPreviousArtifactId !== null) {
      const previous = this.#optional(
        this.#db.prepare(`
          SELECT c.thread_id,j.view_key FROM context_compactions c
          JOIN context_compaction_jobs j ON j.id=c.job_id WHERE c.id=?
        `),
        expectedPreviousArtifactId,
      )
      if (!previous || text(previous, 'thread_id') !== text(row, 'thread_id')
        || text(previous, 'view_key') !== text(row, 'view_key')) {
        throw new ContextPersistenceError('integrity_violation', 'Compaction job frontier artifact is invalid')
      }
    }
    return sourceItems
  }

  #contextCompactionJob(row: SqlRow): ContextCompactionJob {
    const sourceItems = this.#sourceItemsForJob(row)
    const status = text(row, 'status') as ContextCompactionJob['status']
    const artifactRow = this.#optional(this.#db.prepare(
      'SELECT id FROM context_compactions WHERE job_id=?',
    ), text(row, 'id'))
    if ((status === 'completed') !== (artifactRow !== null)) {
      throw new ContextPersistenceError('integrity_violation', 'Compaction job and artifact completion state diverged')
    }
    this.#validateContextCompactionJobEvents(row)
    return {
      id: text(row, 'id'),
      threadId: text(row, 'thread_id'),
      viewKey: text(row, 'view_key'),
      requestKey: text(row, 'request_key'),
      requestHash: text(row, 'request_hash'),
      sourceItemIds: sourceItems.map((source) => source.itemId),
      sourceHash: text(row, 'source_hash'),
      summaryInputHash: text(row, 'summary_input_hash'),
      expectedPreviousArtifactId: nullableText(row, 'expected_previous_artifact_id'),
      status,
      revision: integer(row, 'revision'),
      leaseOwner: nullableText(row, 'lease_owner'),
      leaseExpiresAt: nullableText(row, 'lease_expires_at'),
      attemptCount: integer(row, 'attempt_count'),
      artifactId: artifactRow ? text(artifactRow, 'id') : null,
      error: parseNullableObject(row.error_json),
      createdAt: text(row, 'created_at'),
      updatedAt: text(row, 'updated_at'),
      completedAt: nullableText(row, 'completed_at'),
    }
  }

  #contextCompactionArtifact(row: SqlRow): ContextCompactionArtifact {
    const sourceRows = this.#all(this.#db.prepare(`
      SELECT * FROM context_compaction_source_items WHERE compaction_id=? ORDER BY ordinal
    `), text(row, 'id'))
    const sourceItems = sourceRows.map((sourceRow, index) => {
      if (integer(sourceRow, 'ordinal') !== index) {
        throw new ContextPersistenceError('integrity_violation', 'Compaction source ordinals are not contiguous')
      }
      const itemRow = this.#optional(this.#db.prepare('SELECT * FROM items WHERE id=?'), text(sourceRow, 'item_id'))
      if (!itemRow || integer(itemRow, 'sequence') !== integer(sourceRow, 'item_sequence')
        || this.#itemDigest(itemRow) !== text(sourceRow, 'item_digest')) {
        throw new ContextPersistenceError('integrity_violation', 'Compaction source item provenance is invalid')
      }
      return {
        ordinal: index,
        itemId: text(sourceRow, 'item_id'),
        itemSequence: integer(sourceRow, 'item_sequence'),
        itemDigest: text(sourceRow, 'item_digest'),
      }
    })
    if (sourceItems.length === 0 || this.#sourceHashForItems(sourceItems) !== text(row, 'source_hash')) {
      throw new ContextPersistenceError('integrity_violation', 'Compaction artifact source hash is invalid')
    }
    const job = this.#optional(this.#db.prepare('SELECT * FROM context_compaction_jobs WHERE id=?'), text(row, 'job_id'))
    if (!job || text(job, 'status') !== 'completed' || text(job, 'thread_id') !== text(row, 'thread_id')
      || text(job, 'source_hash') !== text(row, 'source_hash')
      || text(job, 'summary_input_hash') !== text(row, 'summary_input_hash')) {
      throw new ContextPersistenceError('integrity_violation', 'Compaction artifact does not match its durable job')
    }
    this.#validateContextCompactionJobEvents(job)
    const jobSourceIds = parseArray(job.source_item_ids_json)
    if (canonicalJson(jobSourceIds) !== canonicalJson(sourceItems.map((source) => source.itemId))) {
      throw new ContextPersistenceError('integrity_violation', 'Compaction artifact covers different items than its job')
    }
    const summary = parseObject(row.summary_json)
    const summaryInput = objectValue(summary.summaryInput)
    const summaryPreviousArtifactId = summaryInput?.previousArtifactId
    if (!summaryInput
      || (summaryPreviousArtifactId !== null && typeof summaryPreviousArtifactId !== 'string')
      || summaryPreviousArtifactId !== nullableText(job, 'expected_previous_artifact_id')) {
      throw new ContextPersistenceError(
        'integrity_violation',
        'Compaction summary input does not match its expected artifact frontier',
      )
    }
    const expectedArtifactHash = sha256Canonical({
      schema: 'baton.context-compaction-artifact.v2',
      jobId: text(row, 'job_id'),
      threadId: text(row, 'thread_id'),
      viewKey: text(job, 'view_key'),
      sourceHash: text(row, 'source_hash'),
      summaryInputHash: text(row, 'summary_input_hash'),
      expectedPreviousArtifactId: nullableText(job, 'expected_previous_artifact_id'),
      summary,
      generatorProvider: text(row, 'generator_provider'),
      generatorModel: text(row, 'generator_model'),
      generatorVersion: text(row, 'generator_version'),
    })
    const legacyArtifactHash = sha256Canonical({
      schema: 'baton.context-compaction-artifact.v1',
      jobId: text(row, 'job_id'),
      threadId: text(row, 'thread_id'),
      sourceHash: text(row, 'source_hash'),
      summaryInputHash: text(row, 'summary_input_hash'),
      expectedPreviousArtifactId: nullableText(job, 'expected_previous_artifact_id'),
      summary,
      generatorProvider: text(row, 'generator_provider'),
      generatorModel: text(row, 'generator_model'),
      generatorVersion: text(row, 'generator_version'),
    })
    if (expectedArtifactHash !== text(row, 'artifact_hash')
      && !(text(job, 'view_key') === LEGACY_CONTEXT_VIEW_KEY
        && legacyArtifactHash === text(row, 'artifact_hash'))) {
      throw new ContextPersistenceError('integrity_violation', 'Compaction artifact hash is invalid')
    }
    return {
      id: text(row, 'id'),
      jobId: text(row, 'job_id'),
      threadId: text(row, 'thread_id'),
      viewKey: text(job, 'view_key'),
      sourceHash: text(row, 'source_hash'),
      summaryInputHash: text(row, 'summary_input_hash'),
      artifactHash: text(row, 'artifact_hash'),
      summary,
      generatorProvider: text(row, 'generator_provider') as CanonicalProvider,
      generatorModel: text(row, 'generator_model'),
      generatorVersion: text(row, 'generator_version'),
      sourceItems,
      createdAt: text(row, 'created_at'),
    }
  }

  #resolveExecutionContextSources(
    threadId: ThreadId,
    provider: CanonicalProvider,
    sources: CreateExecutionContextManifestInput['sources'],
  ): ExecutionContextManifestEntry[] {
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new ContextPersistenceError('invalid_input', 'Execution context manifest must have source provenance')
    }
    const thread = this.getThread(threadId)
    if (!thread) throw new ContextPersistenceError('not_found', `Thread not found: ${threadId}`)
    const lineage = this.#itemsForSegments(this.#lineage(thread), 0)
    let representedIds = new Set<string>()
    const canonicalIds: string[] = []
    const entries = sources.map((source, ordinal): ExecutionContextManifestEntry => {
      if (source.kind === 'compaction') {
        if (ordinal !== 0 || sources.some((candidate, index) => index > 0 && candidate.kind === 'compaction')) {
          throw new ContextPersistenceError('invalid_input', 'A manifest may begin with exactly one compaction artifact')
        }
        const row = this.#optional(this.#db.prepare('SELECT * FROM context_compactions WHERE id=?'), source.compactionId)
        if (!row) throw new ContextPersistenceError('not_found', `Compaction not found: ${source.compactionId}`)
        const artifact = this.#contextCompactionArtifact(row)
        if (artifact.threadId !== threadId) {
          throw new ContextPersistenceError('invalid_input', 'Compaction artifact belongs to a different thread')
        }
        representedIds = new Set(artifact.sourceItems.map((item) => item.itemId))
        return { ordinal, kind: 'compaction', compactionId: artifact.id, digest: artifact.artifactHash }
      }
      if (source.kind !== 'canonical_item' || !source.itemId) {
        throw new ContextPersistenceError('invalid_input', 'Manifest source is invalid')
      }
      const row = this.#optional(this.#db.prepare('SELECT * FROM items WHERE id=?'), source.itemId)
      if (!row) throw new ContextPersistenceError('not_found', `Canonical item not found: ${source.itemId}`)
      canonicalIds.push(source.itemId)
      return { ordinal, kind: 'canonical_item', itemId: source.itemId, digest: this.#itemDigest(row) }
    })
    if (representedIds.size === 0) {
      representedIds = nativeCheckpointRepresentedIds(lineage, canonicalIds, provider)
    }
    const expectedCanonicalIds = lineage.filter((item) => !representedIds.has(item.id)).map((item) => item.id)
    if (canonicalIds.length !== expectedCanonicalIds.length
      || canonicalIds.some((id, index) => expectedCanonicalIds[index] !== id)) {
      throw new ContextPersistenceError(
        'invalid_input',
        'Execution context provenance must retain every canonical item not represented by its compaction',
      )
    }
    return entries
  }

  #executionContextManifest(row: SqlRow): ExecutionContextManifest {
    const entryRows = this.#all(this.#db.prepare(`
      SELECT * FROM execution_context_manifest_entries WHERE manifest_id=? ORDER BY ordinal
    `), text(row, 'id'))
    if (entryRows.length === 0) {
      throw new ContextPersistenceError('integrity_violation', 'Execution context manifest has no provenance')
    }
    let representedIds = new Set<string>()
    const canonicalIds: string[] = []
    const entries = entryRows.map((entryRow, index): ExecutionContextManifestEntry => {
      if (integer(entryRow, 'ordinal') !== index) {
        throw new ContextPersistenceError('integrity_violation', 'Execution context ordinals are not contiguous')
      }
      const kind = text(entryRow, 'source_kind')
      if (kind === 'canonical_item') {
        const itemId = nullableText(entryRow, 'item_id')
        const item = itemId ? this.#optional(this.#db.prepare('SELECT * FROM items WHERE id=?'), itemId) : null
        if (!item || this.#itemDigest(item) !== text(entryRow, 'digest')) {
          throw new ContextPersistenceError('integrity_violation', 'Execution context item digest is invalid')
        }
        canonicalIds.push(itemId as string)
        return { ordinal: index, kind, itemId: itemId as string, digest: text(entryRow, 'digest') }
      }
      const compactionId = nullableText(entryRow, 'compaction_id')
      const compactionRow = compactionId
        ? this.#optional(this.#db.prepare('SELECT * FROM context_compactions WHERE id=?'), compactionId)
        : null
      if (!compactionRow) {
        throw new ContextPersistenceError('integrity_violation', 'Execution context compaction is missing')
      }
      const artifact = this.#contextCompactionArtifact(compactionRow)
      if (index !== 0 || artifact.threadId !== text(row, 'thread_id')
        || artifact.artifactHash !== text(entryRow, 'digest')) {
        throw new ContextPersistenceError('integrity_violation', 'Execution context compaction provenance is invalid')
      }
      representedIds = new Set(artifact.sourceItems.map((item) => item.itemId))
      return { ordinal: index, kind: 'compaction', compactionId: artifact.id, digest: artifact.artifactHash }
    })
    const thread = this.getThread(text(row, 'thread_id'))
    if (!thread) throw new ContextPersistenceError('integrity_violation', 'Execution context thread is missing')
    const lineage = this.#itemsForSegments(this.#lineage(thread), 0)
    if (representedIds.size === 0) {
      const execution = this.#optional(this.#db.prepare('SELECT provider FROM executions WHERE id=?'), text(row, 'execution_id'))
      if (!execution) throw new ContextPersistenceError('integrity_violation', 'Execution context execution is missing')
      const lastCanonicalIndex = canonicalIds.length === 0
        ? -1
        : lineage.findIndex((item) => item.id === canonicalIds.at(-1))
      representedIds = nativeCheckpointRepresentedIds(
        lastCanonicalIndex < 0 ? lineage : lineage.slice(0, lastCanonicalIndex + 1),
        canonicalIds,
        text(execution, 'provider') as CanonicalProvider,
      )
    }
    const capturedIds = new Set([...representedIds, ...canonicalIds])
    const lastCapturedIndex = lineage.findLastIndex((item) => capturedIds.has(item.id))
    const capturedLineage = lineage.slice(0, lastCapturedIndex + 1)
    const expectedCanonicalIds = capturedLineage.filter((item) => !representedIds.has(item.id)).map((item) => item.id)
    if (capturedIds.size !== capturedLineage.length
      || canonicalIds.length !== expectedCanonicalIds.length
      || canonicalIds.some((id, index) => expectedCanonicalIds[index] !== id)) {
      throw new ContextPersistenceError('integrity_violation', 'Execution context provenance is not an exact lineage prefix')
    }
    const manifestHash = sha256Canonical({
      schema: 'baton.execution-context-manifest.v1',
      executionId: text(row, 'execution_id'),
      threadId: text(row, 'thread_id'),
      materializerVersion: text(row, 'materializer_version'),
      materializedContextHash: text(row, 'materialized_context_hash'),
      entries,
    })
    if (manifestHash !== text(row, 'manifest_hash')) {
      throw new ContextPersistenceError('integrity_violation', 'Execution context manifest hash is invalid')
    }
    return {
      id: text(row, 'id'),
      executionId: text(row, 'execution_id'),
      threadId: text(row, 'thread_id'),
      materializerVersion: text(row, 'materializer_version'),
      materializedContextHash: text(row, 'materialized_context_hash'),
      manifestHash,
      entries,
      createdAt: text(row, 'created_at'),
    }
  }

  #contextCompactionJobStateHash(row: SqlRow): string {
    const artifact = this.#optional(this.#db.prepare(
      'SELECT id FROM context_compactions WHERE job_id=?',
    ), text(row, 'id'))
    return sha256Canonical({
      schema: 'baton.context-compaction-job-state.v1',
      id: text(row, 'id'),
      threadId: text(row, 'thread_id'),
      requestHash: text(row, 'request_hash'),
      sourceHash: text(row, 'source_hash'),
      summaryInputHash: text(row, 'summary_input_hash'),
      expectedPreviousArtifactId: nullableText(row, 'expected_previous_artifact_id'),
      status: text(row, 'status'),
      revision: integer(row, 'revision'),
      leaseOwner: nullableText(row, 'lease_owner'),
      leaseExpiresAt: nullableText(row, 'lease_expires_at'),
      attemptCount: integer(row, 'attempt_count'),
      artifactId: artifact ? text(artifact, 'id') : null,
      error: parseNullableObject(row.error_json),
      completedAt: nullableText(row, 'completed_at'),
    })
  }

  #contextCompactionHeadHash(
    threadId: ThreadId,
    viewKey: string,
    compactionId: string | null,
    revision: number,
  ): string {
    return sha256Canonical({
      schema: 'baton.context-compaction-head.v2',
      threadId,
      viewKey,
      compactionId,
      revision,
    })
  }

  #ensureContextCompactionHead(threadId: ThreadId, viewKey: string, now: string): SqlRow {
    const initialHash = this.#contextCompactionHeadHash(threadId, viewKey, null, 0)
    this.#db.prepare(`
      INSERT INTO context_compaction_heads(thread_id,view_key,compaction_id,revision,head_hash,updated_at)
      VALUES (?,?,NULL,0,?,?) ON CONFLICT(thread_id,view_key) DO NOTHING
    `).run(threadId, viewKey, initialHash, now)
    const head = this.#one(this.#db.prepare(
      'SELECT * FROM context_compaction_heads WHERE thread_id=? AND view_key=?',
    ), threadId, viewKey)
    this.#validateContextCompactionHead(head)
    return head
  }

  #validateContextCompactionHead(row: SqlRow): void {
    const threadId = text(row, 'thread_id')
    const viewKey = text(row, 'view_key')
    const compactionId = nullableText(row, 'compaction_id')
    const revision = integer(row, 'revision')
    if (this.#contextCompactionHeadHash(threadId, viewKey, compactionId, revision) !== text(row, 'head_hash')) {
      throw new ContextPersistenceError('integrity_violation', 'Compaction head hash is invalid')
    }
    if ((compactionId === null) !== (revision === 0)) {
      throw new ContextPersistenceError('integrity_violation', 'Compaction head revision is inconsistent')
    }
    const artifactCount = integer(this.#one(this.#db.prepare(`
      SELECT COUNT(*) AS count FROM context_compactions c
      JOIN context_compaction_jobs j ON j.id=c.job_id
      WHERE c.thread_id=? AND j.view_key=?
    `), threadId, viewKey), 'count')
    if (artifactCount !== revision) {
      throw new ContextPersistenceError('integrity_violation', 'Compaction head revision does not match artifacts')
    }
    if (compactionId !== null) {
      const artifact = this.#optional(this.#db.prepare(
        `SELECT c.thread_id,j.view_key FROM context_compactions c
         JOIN context_compaction_jobs j ON j.id=c.job_id WHERE c.id=?`,
      ), compactionId)
      if (!artifact || text(artifact, 'thread_id') !== threadId
        || text(artifact, 'view_key') !== viewKey) {
        throw new ContextPersistenceError('integrity_violation', 'Compaction head points to an invalid artifact')
      }
    }
  }

  #validateContextCompactionJobEvents(row: SqlRow): void {
    const events = this.#all(this.#db.prepare(`
      SELECT * FROM context_compaction_job_events WHERE job_id=? ORDER BY sequence
    `), text(row, 'id'))
    let previousEventHash: string | null = null
    let previousRevision = 0
    for (const event of events) {
      const revision = integer(event, 'revision')
      const payload = parseObject(event.payload_json)
      if (text(event, 'thread_id') !== text(row, 'thread_id') || revision !== previousRevision + 1
        || nullableText(event, 'previous_event_hash') !== previousEventHash) {
        throw new ContextPersistenceError('integrity_violation', 'Compaction job event chain is discontinuous')
      }
      const eventHash = sha256Canonical({
        schema: 'baton.context-compaction-job-event.v1',
        jobId: text(event, 'job_id'),
        threadId: text(event, 'thread_id'),
        expectedPreviousArtifactId: nullableText(row, 'expected_previous_artifact_id'),
        revision,
        status: text(event, 'status'),
        payload,
        stateHash: text(event, 'state_hash'),
        previousEventHash,
        createdAt: text(event, 'created_at'),
      })
      if (eventHash !== text(event, 'event_hash')) {
        throw new ContextPersistenceError('integrity_violation', 'Compaction job event hash is invalid')
      }
      previousRevision = revision
      previousEventHash = eventHash
    }
    const latest = events.at(-1)
    if (!latest || integer(latest, 'revision') !== integer(row, 'revision')
      || text(latest, 'status') !== text(row, 'status')
      || text(latest, 'state_hash') !== this.#contextCompactionJobStateHash(row)) {
      throw new ContextPersistenceError('integrity_violation', 'Compaction job state does not match its audit chain')
    }
  }

  #appendContextCompactionJobEvent(
    row: SqlRow,
    payload: Record<string, unknown>,
    now: string,
  ): void {
    const previous = this.#optional(this.#db.prepare(`
      SELECT event_hash FROM context_compaction_job_events WHERE job_id=? ORDER BY sequence DESC LIMIT 1
    `), text(row, 'id'))
    const previousEventHash = previous ? text(previous, 'event_hash') : null
    const stateHash = this.#contextCompactionJobStateHash(row)
    const eventHash = sha256Canonical({
      schema: 'baton.context-compaction-job-event.v1',
      jobId: text(row, 'id'),
      threadId: text(row, 'thread_id'),
      expectedPreviousArtifactId: nullableText(row, 'expected_previous_artifact_id'),
      revision: integer(row, 'revision'),
      status: text(row, 'status'),
      payload,
      stateHash,
      previousEventHash,
      createdAt: now,
    })
    this.#db.prepare(`
      INSERT INTO context_compaction_job_events(
        job_id,thread_id,revision,status,payload_json,state_hash,previous_event_hash,event_hash,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?)
    `).run(text(row, 'id'), text(row, 'thread_id'), integer(row, 'revision'), text(row, 'status'),
      canonicalJson(payload), stateHash, previousEventHash, eventHash, now)
  }

  #appendFollowUpChanged(followUp: CanonicalFollowUp, now: string): void {
    this.#appendStreamEvent(followUp.sessionId, followUp.threadId, followUp.targetTurnId,
      'follow_up_changed', {
        followUpId: followUp.id,
        revision: followUp.revision,
        sequence: followUp.sequence,
        status: followUp.status,
        targetTurnId: followUp.targetTurnId,
        consumedTurnId: followUp.consumedTurnId,
      }, now)
  }

  #assertPermissionSnapshotCurrent(
    policySnapshot: ExecutionPolicySnapshot,
    session: CanonicalSession | null,
  ): void {
    if (policySnapshot.permissionProfile === undefined) return
    const expectedProfile = session?.permissions.effectiveProfile ?? this.getPermissionSettings().defaultProfile
    const expectedSource = session?.permissions.source ?? 'global'
    if (policySnapshot.permissionProfile !== expectedProfile
      || policySnapshot.permissionProfileSource !== expectedSource) {
      throw new SessionStoreError(
        'revision_conflict',
        'Permission settings changed while the turn was starting; refresh and retry',
      )
    }
  }

  #appendStreamEvent(
    sessionId: string,
    threadId: string,
    turnId: string | null,
    type: CanonicalStreamEventType,
    payload: Record<string, unknown>,
    now: string,
  ): void {
    this.#db.prepare(`
      INSERT INTO stream_events(session_id,thread_id,turn_id,type,payload_json,created_at) VALUES (?,?,?,?,?,?)
    `).run(sessionId, threadId, turnId, type, canonicalJson(payload), now)
  }

  #session(row: SqlRow): CanonicalSession {
    const sourceProvider = nullableText(row, 'source_provider')
    const defaultProfile = parsePermissionProfile(text(row, 'default_permission_profile'))
    const permissionOverride = parseNullablePermissionProfile(row.permission_profile_override)
    return {
      id: text(row, 'id'),
      title: nullableText(row, 'title'),
      preview: nullableText(row, 'preview'),
      activeThreadId: text(row, 'active_thread_id'),
      projectKey: nullableText(row, 'project_key'),
      cwd: nullableText(row, 'cwd'),
      permissions: {
        defaultProfile,
        override: permissionOverride,
        effectiveProfile: permissionOverride ?? defaultProfile,
        source: permissionOverride === null ? 'global' : 'session_override',
      },
      schemaVersion: integer(row, 'schema_version'),
      createdAt: text(row, 'created_at'),
      updatedAt: text(row, 'updated_at'),
      archivedAt: nullableText(row, 'archived_at'),
      workStatus: visibleWorkStatus(row),
      source: sourceProvider ? {
        provider: sourceProvider as CanonicalProvider,
        sourceClient: publicSourceClient(text(row, 'source_client')),
        sourceAlias: nullableText(row, 'source_alias'),
        titleSource: nullableText(row, 'source_title_source'),
        projectAlias: nullableText(row, 'source_project_alias'),
        cwd: nullableText(row, 'source_cwd'),
      } : null,
    }
  }

  #thread(row: SqlRow): CanonicalThread {
    return {
      id: text(row, 'id'),
      sessionId: text(row, 'session_id'),
      parentThreadId: nullableText(row, 'parent_thread_id'),
      forkTurnId: nullableText(row, 'fork_turn_id'),
      forkItemId: nullableText(row, 'fork_item_id'),
      revision: integer(row, 'revision'),
      status: text(row, 'status') as CanonicalThread['status'],
      instructionSnapshot: parseObject(row.instruction_snapshot_json),
      createdAt: text(row, 'created_at'),
      updatedAt: text(row, 'updated_at'),
    }
  }

  #turn(row: SqlRow): CanonicalTurn {
    return {
      id: text(row, 'id'),
      threadId: text(row, 'thread_id'),
      goalId: nullableText(row, 'goal_id'),
      goalRevision: row.goal_revision === null ? null : integer(row, 'goal_revision'),
      sequence: integer(row, 'sequence'),
      provider: text(row, 'provider') as CanonicalProvider,
      model: text(row, 'model'),
      effort: nullableText(row, 'effort'),
      status: text(row, 'status') as CanonicalTurn['status'],
      clientRequestId: text(row, 'client_request_id'),
      startedAt: nullableText(row, 'started_at'),
      completedAt: nullableText(row, 'completed_at'),
      usage: parseNullableObject(row.usage_json),
      error: parseNullableObject(row.error_json),
    }
  }

  #item(row: SqlRow): CanonicalItem {
    return {
      id: text(row, 'id'),
      sessionId: text(row, 'session_id'),
      threadId: text(row, 'thread_id'),
      turnId: nullableText(row, 'turn_id'),
      sequence: integer(row, 'sequence'),
      kind: text(row, 'kind') as CanonicalItemKind,
      visibility: text(row, 'visibility') as CanonicalItem['visibility'],
      payload: parseObject(row.payload_json),
      provider: nullableText(row, 'provider') as CanonicalProvider | null,
      nativeId: nullableText(row, 'native_id'),
      createdAt: text(row, 'created_at'),
    }
  }

  #followUp(row: SqlRow): CanonicalFollowUp {
    const goalId = nullableText(row, 'goal_id')
    const goalRevision = row.goal_revision === null ? null : integer(row, 'goal_revision')
    const input = parseArray(row.input_json) as CanonicalFollowUp['input']
    return {
      id: text(row, 'id'),
      sessionId: text(row, 'session_id'),
      threadId: text(row, 'thread_id'),
      clientRequestId: text(row, 'client_request_id'),
      requestHash: text(row, 'request_hash'),
      sequence: integer(row, 'sequence'),
      afterTurnSequence: integer(row, 'after_turn_sequence'),
      delivery: text(row, 'delivery') as CanonicalFollowUp['delivery'],
      status: text(row, 'status') as CanonicalFollowUp['status'],
      targetTurnId: nullableText(row, 'target_turn_id'),
      consumedTurnId: nullableText(row, 'consumed_turn_id'),
      consumedItemIds: parseArray(row.consumed_item_ids_json).map((id) => {
        if (typeof id !== 'string') throw new Error('Corrupt database: consumed item ID is not text')
        return id
      }),
      scope: goalId === null
        ? { kind: 'conversation' }
        : { kind: 'goal', goalId, revision: goalRevision as number },
      input,
      dispatchOwner: nullableText(row, 'dispatch_owner'),
      leaseExpiresAt: nullableText(row, 'lease_expires_at'),
      revision: integer(row, 'revision'),
      createdAt: text(row, 'created_at'),
      updatedAt: text(row, 'updated_at'),
      consumedAt: nullableText(row, 'consumed_at'),
    }
  }

  #execution(row: SqlRow): CanonicalExecution {
    return {
      id: text(row, 'id'),
      sessionId: text(row, 'session_id'),
      threadId: text(row, 'thread_id'),
      turnId: text(row, 'turn_id'),
      parentExecutionId: nullableText(row, 'parent_execution_id'),
      spawnItemId: nullableText(row, 'spawn_item_id'),
      kind: text(row, 'kind') as CanonicalExecution['kind'],
      provider: text(row, 'provider') as CanonicalProvider,
      model: text(row, 'model'),
      adapterVersion: text(row, 'adapter_version'),
      status: text(row, 'status') as CanonicalExecution['status'],
      policySnapshot: parseObject(row.policy_snapshot_json) as unknown as ExecutionPolicySnapshot,
      budget: parseObject(row.budget_json),
      usage: parseObject(row.usage_json),
      leaseExpiresAt: nullableText(row, 'lease_expires_at'),
      startedAt: nullableText(row, 'started_at'),
      completedAt: nullableText(row, 'completed_at'),
    }
  }

  #binding(row: SqlRow): ProviderBinding {
    return {
      id: text(row, 'id'),
      threadId: text(row, 'thread_id'),
      provider: text(row, 'provider') as CanonicalProvider,
      modelFamily: text(row, 'model_family'),
      nativeThreadId: nullableText(row, 'native_thread_id'),
      nativeResponseId: nullableText(row, 'native_response_id'),
      opaqueStateEncrypted: row.opaque_state_encrypted as Uint8Array | null,
      capabilities: parseObject(row.capabilities_json) as unknown as ProviderCapabilities,
      syncedRevision: integer(row, 'synced_revision'),
      contextDigest: text(row, 'context_digest'),
      updatedAt: text(row, 'updated_at'),
      invalidatedAt: nullableText(row, 'invalidated_at'),
    }
  }

  #streamEvent(row: SqlRow): CanonicalStreamEvent {
    return {
      sequence: integer(row, 'sequence'),
      sessionId: text(row, 'session_id'),
      threadId: text(row, 'thread_id'),
      turnId: nullableText(row, 'turn_id'),
      type: text(row, 'type') as CanonicalStreamEventType,
      payload: parseObject(row.payload_json),
      createdAt: text(row, 'created_at'),
    }
  }

  #goal(row: SqlRow): CanonicalGoal {
    const verificationProposalId = nullableText(row, 'verification_proposal_id')
    const storedStatus = text(row, 'status') as Exclude<GoalStatus, 'verifying'>
    return {
      id: text(row, 'id'),
      threadId: text(row, 'thread_id'),
      objective: text(row, 'objective'),
      status: storedStatus === 'active' && verificationProposalId !== null ? 'verifying' : storedStatus,
      statusReason: parseNullableObject(row.status_reason_json) as unknown as GoalStatusReason | null,
      revision: integer(row, 'revision'),
      provider: text(row, 'provider') as CanonicalGoal['provider'],
      model: text(row, 'model'),
      effort: nullableText(row, 'effort'),
      tokenBudget: row.token_budget === null ? null : integer(row, 'token_budget'),
      tokensUsed: integer(row, 'tokens_used'),
      timeUsedSeconds: integer(row, 'time_used_seconds'),
      maxAutomaticTurns: integer(row, 'max_automatic_turns'),
      automaticTurnsUsed: integer(row, 'automatic_turns_used'),
      maxActiveSeconds: integer(row, 'max_active_seconds'),
      noProgressCount: integer(row, 'no_progress_count'),
      lastProgressDigest: nullableText(row, 'last_progress_digest'),
      createdAt: text(row, 'created_at'),
      updatedAt: text(row, 'updated_at'),
      startedAt: text(row, 'started_at'),
      completedAt: nullableText(row, 'completed_at'),
      verificationProposalId,
      latestCompletionReceiptId: nullableText(row, 'latest_completion_receipt_id'),
      latestStopReceiptId: nullableText(row, 'latest_stop_receipt_id'),
    }
  }

  #goalCompletionProposal(row: SqlRow): GoalCompletionProposal {
    const requirements = parseArray(row.requirements_json) as unknown as GoalRequirementClaim[]
    const evidenceBundle = parseObject(row.evidence_bundle_json) as unknown as GoalEvidenceBundle
    const storedHash = text(row, 'evidence_bundle_hash')
    const { hash, ...evidenceContent } = evidenceBundle
    if (hash !== storedHash || goalEvidenceHash(evidenceContent) !== storedHash
      || evidenceBundle.goalId !== text(row, 'goal_id')
      || evidenceBundle.goalRevision !== integer(row, 'goal_revision')
      || evidenceBundle.terminalTurn?.id !== text(row, 'turn_id')
      || evidenceBundle.proposalSummary !== text(row, 'summary')
      || canonicalJson(evidenceBundle.requirements) !== canonicalJson(requirements)) {
      throw new ContextPersistenceError('integrity_violation', 'Stored Goal completion proposal evidence is inconsistent')
    }
    return {
      id: text(row, 'id'),
      goalId: text(row, 'goal_id'),
      goalRevision: integer(row, 'goal_revision'),
      turnId: text(row, 'turn_id'),
      summary: text(row, 'summary'),
      requirements,
      evidenceBundle,
      status: text(row, 'status') as GoalCompletionProposal['status'],
      createdAt: text(row, 'created_at'),
      resolvedAt: nullableText(row, 'resolved_at'),
    }
  }

  #goalVerificationAttempt(row: SqlRow): GoalVerificationAttempt {
    return {
      id: text(row, 'id'),
      proposalId: text(row, 'proposal_id'),
      goalId: text(row, 'goal_id'),
      goalRevision: integer(row, 'goal_revision'),
      evaluatorProvider: text(row, 'evaluator_provider') as CanonicalProvider,
      evaluatorModel: text(row, 'evaluator_model'),
      evidenceBundleHash: text(row, 'evidence_bundle_hash'),
      outcome: text(row, 'outcome') as GoalVerificationAttempt['outcome'],
      decision: parseObject(row.decision_json) as unknown as GoalVerificationDecision,
      usage: parseNullableObject(row.usage_json),
      startedAt: text(row, 'started_at'),
      completedAt: text(row, 'completed_at'),
    }
  }

  #goalCompletionReceipt(row: SqlRow): GoalCompletionReceipt {
    return {
      id: text(row, 'id'),
      goalId: text(row, 'goal_id'),
      goalRevision: integer(row, 'goal_revision'),
      proposalId: text(row, 'proposal_id'),
      verificationAttemptId: text(row, 'verification_attempt_id'),
      evidenceBundleHash: text(row, 'evidence_bundle_hash'),
      hostChecks: parseArray(row.host_checks_json) as string[],
      acceptedAt: text(row, 'accepted_at'),
      acceptancePolicyVersion: text(row, 'acceptance_policy_version'),
    }
  }

  #goalStopReceipt(row: SqlRow): GoalStopReceipt {
    return {
      id: text(row, 'id'),
      goalId: text(row, 'goal_id'),
      goalRevision: integer(row, 'goal_revision'),
      verificationAttemptId: text(row, 'verification_attempt_id'),
      kind: 'confirmed_impossible',
      reason: text(row, 'reason'),
      evidenceBundleHash: text(row, 'evidence_bundle_hash'),
      decidedAt: text(row, 'decided_at'),
      resumable: integer(row, 'resumable') === 1,
    }
  }

  #goalById(goalId: string): CanonicalGoal | null {
    const row = this.#optional(this.#db.prepare('SELECT * FROM goals WHERE id=?'), goalId)
    return row ? this.#goal(row) : null
  }

  #goalLease(row: SqlRow): GoalSchedulerLease {
    return {
      leaseId: text(row, 'lease_id'),
      goalId: text(row, 'goal_id'),
      goalRevision: integer(row, 'goal_revision'),
      ownerId: text(row, 'owner_id'),
      acquiredAt: text(row, 'acquired_at'),
      heartbeatAt: text(row, 'heartbeat_at'),
      expiresAt: text(row, 'expires_at'),
    }
  }

  #goalVerifierLease(row: SqlRow): GoalVerifierLease {
    return {
      leaseId: text(row, 'lease_id'),
      proposalId: text(row, 'proposal_id'),
      goalId: text(row, 'goal_id'),
      goalRevision: integer(row, 'goal_revision'),
      ownerId: text(row, 'owner_id'),
      acquiredAt: text(row, 'acquired_at'),
      heartbeatAt: text(row, 'heartbeat_at'),
      expiresAt: text(row, 'expires_at'),
    }
  }

  #goalEvent(row: SqlRow): GoalEvent {
    return {
      sequence: integer(row, 'sequence'),
      goalId: text(row, 'goal_id'),
      threadId: text(row, 'thread_id'),
      revision: integer(row, 'revision'),
      type: text(row, 'type'),
      payload: parseObject(row.payload_json),
      createdAt: text(row, 'created_at'),
    }
  }

  #appendGoalEvent(
    goal: CanonicalGoal,
    sessionId: string,
    type: string,
    payload: Record<string, unknown>,
    now: string,
  ): void {
    this.#db.prepare(`
      INSERT INTO goal_events(goal_id,session_id,thread_id,revision,type,payload_json,created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(goal.id, sessionId, goal.threadId, goal.revision, type, canonicalJson(payload), now)
  }

  #appendGoalChanged(
    goal: CanonicalGoal,
    sessionId: string,
    turnId: string | null,
    now: string,
    status: GoalStatus | 'cleared' = goal.status,
  ): void {
    this.#appendStreamEvent(sessionId, goal.threadId, turnId, 'goal_changed', {
      goalId: goal.id,
      revision: goal.revision,
      status,
    }, now)
  }
}

function validateFollowUpInput(input: EnqueueFollowUpInput): void {
  if (!input.clientRequestId || !input.requestHash) {
    throw new FollowUpStoreError('invalid_follow_up', 'Follow-up request identity must not be empty')
  }
  if (input.delivery !== 'steer_or_queue' && input.delivery !== 'next_turn') {
    throw new FollowUpStoreError('invalid_follow_up', 'Follow-up delivery mode is invalid')
  }
  if (input.delivery === 'next_turn' && input.targetTurnId !== null) {
    throw new FollowUpStoreError('invalid_follow_up', 'Next-turn follow-ups cannot target the active turn')
  }
  if (input.scope.kind === 'goal'
    && (!input.scope.goalId || !Number.isSafeInteger(input.scope.revision) || input.scope.revision < 1)) {
    throw new FollowUpStoreError('invalid_follow_up', 'Goal-scoped follow-up requires a positive Goal revision')
  }
  if (!Array.isArray(input.input) || input.input.length === 0) {
    throw new FollowUpStoreError('invalid_follow_up', 'Follow-up must contain at least one user message')
  }
  for (const item of input.input) {
    if (item.kind !== 'user_message' || (item.visibility !== undefined && item.visibility !== 'portable')
      || (item.provider !== undefined && item.provider !== null)
      || (item.nativeId !== undefined && item.nativeId !== null)) {
      throw new FollowUpStoreError(
        'invalid_follow_up',
        'Follow-up input may contain only portable provider-neutral user messages',
      )
    }
  }
}

function validateFollowUpLeaseDuration(duration: number): number {
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 300_000) {
    throw new FollowUpStoreError('invalid_follow_up', 'Follow-up lease duration must be between 1 and 300000 milliseconds')
  }
  return duration
}

function validateGoalObjective(objective: string): void {
  const length = [...objective].length
  if (length < 1 || length > 4_000) {
    throw new GoalStoreError('invalid_goal_input', 'Goal objective must contain 1 to 4000 Unicode characters')
  }
}

function validateToolReconciliation(input: ReconcileToolInput): void {
  if (typeof input.callId !== 'string' || !input.callId.trim()) {
    throw new SessionStoreError('invalid_reconciliation', 'Tool reconciliation callId is required')
  }
  if (input.resolution !== 'succeeded'
    && input.resolution !== 'failed'
    && input.resolution !== 'unknown_acknowledged') {
    throw new SessionStoreError('invalid_reconciliation', 'Tool reconciliation resolution is invalid')
  }
  if (input.note !== undefined) {
    if (typeof input.note !== 'string') {
      throw new SessionStoreError('invalid_reconciliation', 'Tool reconciliation note must be a string')
    }
    if ([...input.note].length > 500) {
      throw new SessionStoreError('invalid_reconciliation', 'Tool reconciliation note exceeds 500 Unicode characters')
    }
  }
}

function reconciliationToolResult(
  resolution: ReconcileToolInput['resolution'],
  note: string | null,
): Record<string, unknown> {
  if (resolution === 'succeeded') {
    return {
      success: true,
      content: { reconciliation: { resolution, note } },
      error: null,
    }
  }
  const code = resolution === 'failed'
    ? 'reconciled_tool_failure'
    : 'unknown_mutation_acknowledged'
  const message = resolution === 'failed'
    ? 'User confirmed that the interrupted tool operation failed'
    : 'User acknowledged that the interrupted tool outcome remains unknown'
  return {
    success: false,
    content: null,
    metadata: { reconciliation: { resolution, note } },
    error: { code, message, retryable: false },
  }
}

function validatePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GoalStoreError('invalid_goal_input', `${field} must be a positive safe integer`)
  }
  return value
}

function validateNullablePositiveInteger(value: number | null, field: string): number | null {
  return value === null ? null : validatePositiveInteger(value, field)
}

function validateNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GoalStoreError('invalid_goal_input', `${field} must be a non-negative safe integer`)
  }
  return value
}

function validateLeaseDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5 * 60_000) {
    throw new GoalStoreError('invalid_goal_input', 'Goal lease duration must be between 1 and 300000 milliseconds')
  }
  return value
}

function addMilliseconds(iso: string, milliseconds: number): string {
  const timestamp = Date.parse(iso)
  if (!Number.isFinite(timestamp)) throw new Error('Store clock returned an invalid ISO timestamp')
  return new Date(timestamp + milliseconds).toISOString()
}

function goalObservationMatches(
  expected: CreateGoalInput['expected'],
  current: SqlRow | null,
): boolean {
  if (expected.kind === 'none') return current === null
  return current !== null
    && text(current, 'id') === expected.goalId
    && integer(current, 'revision') === expected.revision
}

function isValidGoalTransition(current: GoalStatus, next: GoalStatus, resetLimitCounters: boolean): boolean {
  if (current === 'active') {
    return next === 'paused' || next === 'blocked' || next === 'usage_limited'
      || next === 'budget_limited'
  }

  if (current === 'verifying') return next === 'paused' || next === 'blocked'
  if (next !== 'active') return false
  if (current === 'paused' || current === 'blocked' || current === 'usage_limited') return true
  return current === 'budget_limited' && resetLimitCounters
}

function validateGoalEvidenceBundle(bundle: GoalEvidenceBundle, goal: CanonicalGoal, turnId: string): void {
  if (bundle.goalId !== goal.id || bundle.goalRevision !== goal.revision
    || bundle.objective !== goal.objective || bundle.terminalTurn.id !== turnId
    || bundle.terminalTurn.status !== 'completed') {
    throw new GoalStoreError('invalid_goal_input', 'Frozen Goal evidence does not match the Goal turn')
  }
  const { hash, ...content } = bundle
  validateSha256(hash, 'Goal evidence bundle hash')
  if (goalEvidenceHash(content) !== hash) {
    throw new GoalStoreError('invalid_goal_input', 'Frozen Goal evidence bundle hash does not match its content')
  }
  const ids = bundle.evidence.map((entry) => entry.id)
  if (new Set(ids).size !== ids.length) {
    throw new GoalStoreError('invalid_goal_input', 'Frozen Goal evidence IDs must be unique')
  }
}

function validateGoalRequirementClaims(requirements: readonly GoalRequirementClaim[]): void {
  if (requirements.length < 1 || requirements.length > 64) {
    throw new GoalStoreError('invalid_goal_input', 'Completion proposal requires 1..64 requirements')
  }
  const ids = new Set<string>()
  for (const requirement of requirements) {
    if (!requirement.id || ids.has(requirement.id) || !requirement.requirement.trim()
      || requirement.evidence.length < 1 || requirement.evidence.length > 32) {
      throw new GoalStoreError('invalid_goal_input', 'Completion proposal requirements are invalid')
    }
    ids.add(requirement.id)
  }
}

function validateGoalVerificationDecision(decision: GoalVerificationDecision): void {
  if (!['complete', 'incomplete', 'impossible', 'indeterminate'].includes(decision.outcome)
    || !decision.reason.trim() || [...decision.reason].length > 4_000
    || !Array.isArray(decision.requirements) || !Array.isArray(decision.missingEvidence)
    || !Array.isArray(decision.impossibleEvidenceIds)) {
    throw new GoalStoreError('invalid_goal_input', 'Goal verifier returned an invalid decision')
  }
  const ids = new Set<string>()
  for (const result of decision.requirements) {
    if (!result.requirementId || ids.has(result.requirementId)
      || !['satisfied', 'unsatisfied', 'unproven', 'impossible'].includes(result.result)
      || !Array.isArray(result.evidenceIds) || !result.reason.trim()) {
      throw new GoalStoreError('invalid_goal_input', 'Goal verifier requirement results are invalid')
    }
    ids.add(result.requirementId)
  }
}

function completionHostChecks(
  proposal: GoalCompletionProposal,
  decision: GoalVerificationDecision,
): { passed: string[]; failures: string[] } {
  const passed = [
    'normal_provider_termination',
    'terminal_goal_accounting',
    'goal_revision_match',
    'evidence_bundle_hash_match',
  ]
  const failures: string[] = []
  const expected = new Set(proposal.requirements.map((requirement) => requirement.id))
  const actual = new Set(decision.requirements.map((requirement) => requirement.requirementId))
  if (expected.size !== actual.size || [...expected].some((id) => !actual.has(id))) {
    failures.push('requirement coverage is incomplete')
  } else {
    passed.push('complete_requirement_coverage')
  }
  const evidence = new Map(proposal.evidenceBundle.evidence.map((entry) => [entry.id, entry]))
  for (const result of decision.requirements) {
    if (result.result !== 'satisfied') failures.push(`${result.requirementId} is ${result.result}`)
    if (result.evidenceIds.length < 1) failures.push(`${result.requirementId} cites no evidence`)
    for (const evidenceId of result.evidenceIds) {
      const entry = evidence.get(evidenceId)
      if (!entry) failures.push(`${result.requirementId} cites unknown evidence ${evidenceId}`)
      else if (!entry.authoritative) failures.push(`${result.requirementId} cites non-authoritative evidence ${evidenceId}`)
      else if (entry.payload.requirementId !== result.requirementId) {
        failures.push(`${result.requirementId} cites evidence belonging to another requirement`)
      }
    }
  }
  if (decision.missingEvidence.length > 0) failures.push('verifier reported missing evidence')
  if (decision.impossibleEvidenceIds.length > 0 && decision.outcome === 'complete') {
    failures.push('complete decision also reported impossibility evidence')
  }
  if (failures.length === 0) passed.push('authoritative_evidence_references')
  return { passed, failures: [...new Set(failures)] }
}

function impossibleHostChecks(
  proposal: GoalCompletionProposal,
  decision: GoalVerificationDecision,
): { passed: string[]; failures: string[] } {
  const passed: string[] = []
  const failures: string[] = []
  const expected = new Set(proposal.requirements.map((requirement) => requirement.id))
  const actual = new Set(decision.requirements.map((requirement) => requirement.requirementId))
  if (expected.size !== actual.size || [...expected].some((id) => !actual.has(id))) {
    failures.push('requirement coverage is incomplete')
  }
  if (decision.impossibleEvidenceIds.length < 1) failures.push('impossible decision cites no affirmative evidence')
  const evidence = new Map(proposal.evidenceBundle.evidence.map((entry) => [entry.id, entry]))
  for (const evidenceId of decision.impossibleEvidenceIds) {
    const entry = evidence.get(evidenceId)
    if (!entry) failures.push(`impossible decision cites unknown evidence ${evidenceId}`)
    else if (!entry.authoritative) failures.push(`impossible decision cites non-authoritative evidence ${evidenceId}`)
    else if (entry.kind !== 'tool_result') failures.push(`impossible decision cites non-tool evidence ${evidenceId}`)
  }
  const impossibleRequirements = decision.requirements.filter((requirement) => requirement.result === 'impossible')
  if (impossibleRequirements.length < 1) {
    failures.push('no requirement was independently classified as impossible')
  }
  for (const requirement of impossibleRequirements) {
    if (requirement.evidenceIds.length < 1) {
      failures.push(`${requirement.requirementId} cites no impossibility evidence`)
    }
    for (const evidenceId of requirement.evidenceIds) {
      const entry = evidence.get(evidenceId)
      if (!entry) failures.push(`${requirement.requirementId} cites unknown evidence ${evidenceId}`)
      else if (!entry.authoritative) {
        failures.push(`${requirement.requirementId} cites non-authoritative evidence ${evidenceId}`)
      } else if (entry.kind !== 'tool_result') {
        failures.push(`${requirement.requirementId} cites non-tool evidence ${evidenceId}`)
      } else if (entry.payload.requirementId !== requirement.requirementId) {
        failures.push(`${requirement.requirementId} cites evidence belonging to another requirement`)
      }
      if (!decision.impossibleEvidenceIds.includes(evidenceId)) {
        failures.push(`${requirement.requirementId} evidence ${evidenceId} is absent from impossibleEvidenceIds`)
      }
    }
  }
  if (failures.length === 0) passed.push('affirmative_authoritative_impossibility_evidence')
  return { passed, failures: [...new Set(failures)] }
}

function sessionSelect(): string {
  return `
    SELECT s.*,
      (SELECT t.status FROM turns t WHERE t.thread_id=s.active_thread_id ORDER BY t.sequence DESC LIMIT 1) AS latest_turn_status,
      (SELECT CASE WHEN g.status='active' AND g.verification_proposal_id IS NOT NULL
        THEN 'verifying' ELSE g.status END FROM goals g WHERE g.thread_id=s.active_thread_id) AS current_goal_status,
      (SELECT ps.default_profile FROM permission_settings ps WHERE ps.singleton=1) AS default_permission_profile,
      (SELECT ns.provider FROM native_session_sources ns WHERE ns.session_id=s.id ORDER BY ns.first_imported_at LIMIT 1) AS source_provider,
      (SELECT ns.source_client FROM native_session_sources ns WHERE ns.session_id=s.id ORDER BY ns.first_imported_at LIMIT 1) AS source_client,
      (SELECT ns.source_alias FROM native_session_sources ns WHERE ns.session_id=s.id ORDER BY ns.first_imported_at LIMIT 1) AS source_alias,
      (SELECT ns.title_source FROM native_session_sources ns WHERE ns.session_id=s.id ORDER BY ns.first_imported_at LIMIT 1) AS source_title_source,
      (SELECT ns.project_alias FROM native_session_sources ns WHERE ns.session_id=s.id ORDER BY ns.first_imported_at LIMIT 1) AS source_project_alias,
      (SELECT ns.cwd FROM native_session_sources ns WHERE ns.session_id=s.id ORDER BY ns.first_imported_at LIMIT 1) AS source_cwd
    FROM sessions s
  `
}

function parsePermissionProfile(value: string): PermissionProfile {
  if (value === 'read_only' || value === 'workspace' || value === 'full_access') return value
  throw new Error(`Unsupported permission profile: ${value}`)
}

function parseNullablePermissionProfile(value: SqlRow[string]): PermissionProfile | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error('Permission profile override must be text')
  return parsePermissionProfile(value)
}

// Imported sessions carry no special status: provenance is not a work state,
// so they surface whatever their content implies (usually idle), exactly like
// a native Baton conversation.
function visibleWorkStatus(row: SqlRow): CanonicalSession['workStatus'] {
  if (nullableText(row, 'archived_at') !== null) return 'archived'
  const turn = nullableText(row, 'latest_turn_status')
  if (turn === 'waiting_tool' || turn === 'running' || turn === 'queued') return turn
  const goal = nullableText(row, 'current_goal_status')
  if (goal === 'active') return 'awaiting_goal_turn'
  if (goal === 'verifying') return 'verifying'
  if (goal === 'usage_limited' || goal === 'budget_limited' || goal === 'blocked' || goal === 'paused') return goal
  if (turn === 'failed' || turn === 'interrupted' || turn === 'cancelled') return turn
  if (goal === 'complete') return 'complete'
  if (turn === 'completed') return 'completed'
  return 'idle'
}
