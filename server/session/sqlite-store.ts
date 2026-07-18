import { createHmac, randomBytes } from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

import type {
  AppendEventInput,
  BeginTurnResult,
  CanonicalExecution,
  CanonicalGoal,
  CanonicalItem,
  CanonicalItemKind,
  CanonicalProvider,
  CanonicalSession,
  CanonicalStreamEvent,
  CanonicalStreamEventType,
  CanonicalThread,
  CanonicalTurn,
  CreateSessionInput,
  ExecutionPolicySnapshot,
  FinishTurnInput,
  GoalSchedulerLease,
  GoalId,
  GoalStatus,
  GoalStatusReason,
  NewCanonicalItem,
  ProviderBinding,
  ProviderCapabilities,
  SessionId,
  ThreadId,
  ThreadSnapshot,
  TurnId,
  UpsertProviderBindingInput,
} from './domain.ts'
import { uuidV7 } from './domain.ts'
import type {
  ClaimGoalLeaseInput,
  CheckpointGoalTurnInput,
  ClearGoalInput,
  CreateGoalInput,
  EditGoalInput,
  ForkThreadInput,
  GoalCasResult,
  GoalAwareBeginTurnInput,
  GoalEvent,
  HeartbeatGoalLeaseInput,
  RecordGoalTurnInput,
  ReleaseGoalLeaseInput,
  SessionListScope,
  SessionStore,
  UpdateGoalStatusInput,
} from './store.ts'
import { GoalStoreError, SessionStoreError } from './store.ts'
import type {
  CommitNativeImportInput,
  NativeImportCommitCheckpoint,
  NativeImportCommitResult,
  NativeImportCommitState,
  NativeImportReceipt,
  NativeImportStoredState,
  NativeSourceClient,
  NativeSourceIdentity,
} from './native-import/contracts.ts'

const SCHEMA_VERSION = 7
const DEFAULT_GOAL_TURNS = 24
const DEFAULT_GOAL_ACTIVE_SECONDS = 2 * 60 * 60
const DEFAULT_GOAL_LEASE_MS = 30_000
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
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA trusted_schema = OFF;
      PRAGMA busy_timeout = 5000;
    `)
    this.#migrate()
    this.#nativeIdentityKey = this.#loadNativeIdentityKey()
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
      const userVersion = integer(this.#one(this.#db.prepare('PRAGMA user_version')), 'user_version')
      if (versions.length > 0 && userVersion !== SCHEMA_VERSION) {
        throw new Error(`Session schema metadata mismatch: user_version=${userVersion}`)
      }
    })
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
        DELETE FROM executions
          WHERE session_id IN (SELECT session_id FROM session_purge_context);
        DELETE FROM stream_events
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
      if (this.getSession(thread.sessionId)?.archivedAt) {
        throw new SessionStoreError('session_archived', '휴지통의 대화에는 메시지를 보낼 수 없습니다.')
      }
      if (thread.revision !== input.expectedRevision) {
        throw new SessionStoreError('revision_conflict', `Expected revision ${input.expectedRevision}, got ${thread.revision}`)
      }
      if (thread.status !== 'idle') throw new SessionStoreError('turn_not_running', 'Thread already has an active turn')

      const now = this.#now()
      const goalContext = input.goalContext ?? null
      const currentGoalRow = this.#optional(
        this.#db.prepare("SELECT * FROM goals WHERE thread_id=? AND status='active'"),
        thread.id,
      )
      let capturedGoalId = currentGoalRow ? text(currentGoalRow, 'id') : null
      let capturedGoalRevision = currentGoalRow ? integer(currentGoalRow, 'revision') : null
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
      WHERE g.status='active' AND s.archived_at IS NULL
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
      if (current.status === 'complete') nextStatus = 'active'
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
          no_progress_count=0,last_progress_digest=NULL,updated_at=?,completed_at=?
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
      this.#db.prepare('DELETE FROM goal_scheduler_leases WHERE goal_id=?').run(current.id)
      const goal = this.#goal(this.#one(this.#db.prepare('SELECT * FROM goals WHERE id=?'), current.id))
      const thread = this.getThread(goal.threadId)
      if (!thread) throw new Error('Corrupt database: Goal thread is missing')
      this.#appendGoalEvent(goal, thread.sessionId, 'goal_edited', { previousRevision: current.revision, goal }, now)
      return goal
    })
  }

  updateGoalStatus(input: UpdateGoalStatusInput): GoalCasResult {
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
      this.#db.prepare(`
        UPDATE goals SET status=?,status_reason_json=?,revision=?,time_used_seconds=?,automatic_turns_used=?,
          no_progress_count=?,last_progress_digest=?,updated_at=?,completed_at=?
        WHERE id=? AND revision=?
      `).run(
        input.status,
        reason === null ? null : canonicalJson(reason),
        revision,
        resetCounters ? 0 : current.timeUsedSeconds,
        resetCounters ? 0 : current.automaticTurnsUsed,
        input.status === 'active' ? 0 : current.noProgressCount,
        input.status === 'active' ? null : current.lastProgressDigest,
        now,
        input.status === 'complete' ? now : null,
        current.id,
        current.revision,
      )
      this.#db.prepare('DELETE FROM goal_scheduler_leases WHERE goal_id=?').run(current.id)
      const goal = this.#goal(this.#one(this.#db.prepare('SELECT * FROM goals WHERE id=?'), current.id))
      const thread = this.getThread(goal.threadId)
      if (!thread) throw new Error('Corrupt database: Goal thread is missing')
      this.#appendGoalEvent(goal, thread.sessionId, `goal_${input.status}`, { previousStatus: current.status, goal }, now)
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
      this.#db.prepare('DELETE FROM goal_scheduler_leases WHERE goal_id=?').run(current.id)
      this.#db.prepare('DELETE FROM goals WHERE id=?').run(current.id)
      this.#appendGoalEvent(current, thread.sessionId, 'goal_cleared', { goal: current }, now)
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
      const checkpoint = this.#checkpointGoalTurn(input)
      if (checkpoint.status === 'stale' || !checkpoint.goal) return checkpoint
      const current = checkpoint.goal
      if (!Number.isSafeInteger(current.automaticTurnsUsed + (input.automatic ? 1 : 0))) {
        throw new GoalStoreError('invalid_goal_input', 'Goal accounting would exceed safe integer storage')
      }
      const now = this.#now()
      const sameProgress = input.progressDigest !== null && current.lastProgressDigest === input.progressDigest
      const noProgressCount = input.progressDigest === null
        ? current.noProgressCount
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
      return { status: 'applied', goal }
    })
  }

  #checkpointGoalTurn(input: CheckpointGoalTurnInput): GoalCasResult {
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
    return { status: 'applied', goal }
  }

  recoverInterruptedTurns(): number {
    return this.#transaction('IMMEDIATE', () => {
      const rows = this.#all(this.#db.prepare(`
        SELECT turns.*,threads.session_id AS session_id FROM turns JOIN threads ON threads.id=turns.thread_id
        WHERE turns.status IN ('queued','running','waiting_tool') ORDER BY turns.id
      `))
      if (rows.length === 0) return 0
      const now = this.#now()
      for (const row of rows) {
        const turnId = text(row, 'id')
        const unknownMutation = this.#hasUnresolvedMutatingToolCall(turnId)
        const recoveryCode = unknownMutation ? 'unknown_mutation_outcome' : 'runtime_interrupted'
        const goalId = nullableText(row, 'goal_id')
        const goalRevision = row.goal_revision === null ? null : integer(row, 'goal_revision')
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
              UPDATE goals SET status='blocked',status_reason_json=?,revision=revision+1,updated_at=?
              WHERE id=? AND revision=? AND status='active'
            `).run(canonicalJson(reason), now, goalId, goalRevision)
            this.#db.prepare('DELETE FROM goal_scheduler_leases WHERE goal_id=?').run(goalId)
            const blocked = this.#goal(this.#one(this.#db.prepare('SELECT * FROM goals WHERE id=?'), goalId))
            this.#appendGoalEvent(blocked, text(row, 'session_id'), 'goal_blocked', {
              previousStatus: previous.status,
              interruptedTurnId: turnId,
              goal: blocked,
            }, now)
          }
        }
      }
      return rows.length
    })
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
      && (call.sideEffect === 'workspace_mutation' || call.sideEffect === 'workspace_command'))
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

  #createNativeImport(input: CommitNativeImportInput): NativeImportCommitResult {
    const candidate = input.candidate
    const sessionId = this.#idFactory()
    const threadId = this.#idFactory()
    const sourceId = this.#idFactory()
    const revisionId = this.#idFactory()
    const now = this.#now()
    this.#db.prepare(`
      INSERT INTO sessions(id,title,preview,active_thread_id,project_key,cwd,schema_version,next_item_sequence,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,1,?,?)
    `).run(sessionId, candidate.sourceAlias, null, threadId, candidate.projectGroupKey, candidate.cwd, SCHEMA_VERSION, now, now)
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
    return { candidateId: candidate.candidateId, status: 'imported', sessionId, importedItemCount: imported.length }
  }

  #appendNativeImport(existing: SqlRow, input: CommitNativeImportInput): NativeImportCommitResult {
    const candidate = input.candidate
    const current = this.#nativeImportState(existing)
    if (!input.previewedState || input.previewedState.sourceId !== current.sourceId
      || input.previewedState.contentDigest !== current.contentDigest) throw new Error('native import state changed after preview')
    const boundary = candidate.records[current.lastRecordOrdinal - 1]
    if (current.lastRecordOrdinal > candidate.records.length || (current.lastRecordOrdinal > 0 && (!boundary
      || boundary.prefixDigest !== current.prefixDigest || boundary.digest !== current.lastRecordDigest))) {
      throw new Error('source_rewritten: only append-only native deltas can be imported')
    }
    const sessionRow = this.#one(this.#db.prepare(`
      SELECT s.next_item_sequence,s.active_thread_id,t.id AS root_thread_id,t.revision,
        (SELECT COUNT(*) FROM threads child WHERE child.session_id=s.id AND child.id<>t.id) AS fork_count,
        (SELECT COUNT(*) FROM turns turn_row WHERE turn_row.thread_id=t.id) AS turn_count,
        (SELECT COUNT(*) FROM items item_row WHERE item_row.session_id=s.id) AS item_count
      FROM sessions s JOIN threads t ON t.session_id=s.id AND t.parent_thread_id IS NULL WHERE s.id=?
    `), current.sessionId)
    if (text(sessionRow, 'active_thread_id') !== text(sessionRow, 'root_thread_id')
      || integer(sessionRow, 'revision') !== 0 || integer(sessionRow, 'fork_count') !== 0
      || integer(sessionRow, 'turn_count') !== 0 || integer(sessionRow, 'item_count') !== current.importedItemSequence
      || integer(sessionRow, 'next_item_sequence') !== current.importedItemSequence + 1) {
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
    return { candidateId: candidate.candidateId, status: 'updated', sessionId: current.sessionId, importedItemCount: imported.length }
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
    return {
      id: text(row, 'id'),
      title: nullableText(row, 'title'),
      preview: nullableText(row, 'preview'),
      activeThreadId: text(row, 'active_thread_id'),
      projectKey: nullableText(row, 'project_key'),
      cwd: sourceProvider ? null : nullableText(row, 'cwd'),
      schemaVersion: integer(row, 'schema_version'),
      createdAt: text(row, 'created_at'),
      updatedAt: text(row, 'updated_at'),
      archivedAt: nullableText(row, 'archived_at'),
      workStatus: visibleWorkStatus(row, sourceProvider !== null),
      source: sourceProvider ? {
        provider: sourceProvider as CanonicalProvider,
        sourceClient: publicSourceClient(text(row, 'source_client')),
        sourceAlias: nullableText(row, 'source_alias'),
        titleSource: nullableText(row, 'source_title_source'),
        projectAlias: nullableText(row, 'source_project_alias'),
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
    return {
      id: text(row, 'id'),
      threadId: text(row, 'thread_id'),
      objective: text(row, 'objective'),
      status: text(row, 'status') as GoalStatus,
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
}

function validateGoalObjective(objective: string): void {
  const length = [...objective].length
  if (length < 1 || length > 4_000) {
    throw new GoalStoreError('invalid_goal_input', 'Goal objective must contain 1 to 4000 Unicode characters')
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
      || next === 'budget_limited' || next === 'complete'
  }
  if (next !== 'active') return false
  if (current === 'paused' || current === 'blocked' || current === 'usage_limited') return true
  return current === 'budget_limited' && resetLimitCounters
}

function sessionSelect(): string {
  return `
    SELECT s.*,
      (SELECT t.status FROM turns t WHERE t.thread_id=s.active_thread_id ORDER BY t.sequence DESC LIMIT 1) AS latest_turn_status,
      (SELECT g.status FROM goals g WHERE g.thread_id=s.active_thread_id) AS current_goal_status,
      (SELECT ns.provider FROM native_session_sources ns WHERE ns.session_id=s.id ORDER BY ns.first_imported_at LIMIT 1) AS source_provider,
      (SELECT ns.source_client FROM native_session_sources ns WHERE ns.session_id=s.id ORDER BY ns.first_imported_at LIMIT 1) AS source_client,
      (SELECT ns.source_alias FROM native_session_sources ns WHERE ns.session_id=s.id ORDER BY ns.first_imported_at LIMIT 1) AS source_alias,
      (SELECT ns.title_source FROM native_session_sources ns WHERE ns.session_id=s.id ORDER BY ns.first_imported_at LIMIT 1) AS source_title_source,
      (SELECT ns.project_alias FROM native_session_sources ns WHERE ns.session_id=s.id ORDER BY ns.first_imported_at LIMIT 1) AS source_project_alias
    FROM sessions s
  `
}

function visibleWorkStatus(row: SqlRow, imported: boolean): CanonicalSession['workStatus'] {
  if (nullableText(row, 'archived_at') !== null) return 'archived'
  const turn = nullableText(row, 'latest_turn_status')
  if (turn === 'waiting_tool' || turn === 'running' || turn === 'queued') return turn
  const goal = nullableText(row, 'current_goal_status')
  if (goal === 'usage_limited' || goal === 'budget_limited' || goal === 'blocked' || goal === 'paused') return goal
  if (turn === 'failed' || turn === 'interrupted' || turn === 'cancelled') return turn
  if (goal === 'complete') return 'complete'
  if (turn === 'completed') return 'completed'
  if (imported) return 'imported'
  return 'idle'
}
