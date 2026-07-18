import { DatabaseSync, type StatementSync } from 'node:sqlite'

import type {
  AppendEventInput,
  BeginTurnInput,
  BeginTurnResult,
  CanonicalExecution,
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
import type { ForkThreadInput, SessionStore } from './store.ts'
import { SessionStoreError } from './store.ts'

const SCHEMA_VERSION = 2
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

export class SqliteSessionStore implements SessionStore {
  readonly #db: DatabaseSync
  readonly #now: () => string
  readonly #idFactory: () => string

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

  listSessions(): CanonicalSession[] {
    return this.#all(this.#db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC, id')).map((row) => this.#session(row))
  }

  getSession(sessionId: SessionId): CanonicalSession | null {
    const row = this.#optional(this.#db.prepare('SELECT * FROM sessions WHERE id = ?'), sessionId)
    return row ? this.#session(row) : null
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
    return { session, thread, turns, items, bindings: bindingRows.map((row) => this.#binding(row)) }
  }

  forkThread(input: ForkThreadInput): CanonicalThread {
    return this.#transaction('IMMEDIATE', () => {
      const parent = this.getThread(input.threadId)
      if (!parent) throw new SessionStoreError('not_found', `Thread not found: ${input.threadId}`)
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

  beginTurn(input: BeginTurnInput): BeginTurnResult {
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
      if (thread.revision !== input.expectedRevision) {
        throw new SessionStoreError('revision_conflict', `Expected revision ${input.expectedRevision}, got ${thread.revision}`)
      }
      if (thread.status !== 'idle') throw new SessionStoreError('turn_not_running', 'Thread already has an active turn')

      const now = this.#now()
      const turnId = this.#idFactory()
      const executionId = this.#idFactory()
      const sequenceRow = this.#one(this.#db.prepare(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM turns WHERE thread_id = ?',
      ), thread.id)
      const turnSequence = integer(sequenceRow, 'next_sequence')
      this.#db.prepare(`
        INSERT INTO turns(id,thread_id,sequence,provider,model,effort,status,client_request_id,request_hash,started_at)
        VALUES (?,?,?,?,?,?,'running',?,?,?)
      `).run(turnId, thread.id, turnSequence, input.provider, input.model, input.effort ?? null,
        input.clientRequestId, input.requestHash, now)
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
        this.#db.prepare("UPDATE turns SET status='interrupted',completed_at=? WHERE id=?").run(now, turnId)
        this.#db.prepare("UPDATE executions SET status='interrupted',completed_at=? WHERE turn_id=?").run(now, turnId)
        this.#db.prepare("UPDATE threads SET status='idle',revision=revision+1,updated_at=? WHERE id=?")
          .run(now, text(row, 'thread_id'))
        this.#db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(now, text(row, 'session_id'))
        this.#appendStreamEvent(text(row, 'session_id'), text(row, 'thread_id'), turnId, 'turn_interrupted', {
          status: 'interrupted',
          reason: 'process_restart',
        }, now)
      }
      return rows.length
    })
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
    turnId: string,
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
    return {
      id: text(row, 'id'),
      title: nullableText(row, 'title'),
      preview: nullableText(row, 'preview'),
      activeThreadId: text(row, 'active_thread_id'),
      projectKey: nullableText(row, 'project_key'),
      cwd: nullableText(row, 'cwd'),
      schemaVersion: integer(row, 'schema_version'),
      createdAt: text(row, 'created_at'),
      updatedAt: text(row, 'updated_at'),
      archivedAt: nullableText(row, 'archived_at'),
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
}
