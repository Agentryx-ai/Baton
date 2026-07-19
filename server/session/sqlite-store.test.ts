import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, type TestContext } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import type {
  BeginTurnInput,
  ExecutionPolicySnapshot,
  ProviderCapabilities,
} from './domain.ts'
import { ContextPersistenceError, SqliteSessionStore } from './sqlite-store.ts'
import { sourceHashForItems } from './context-materializer.ts'
import { FollowUpStoreError, GoalStoreError, SessionStoreError } from './store.ts'
import type { BeginSessionInput } from './store.ts'
import type { NativeSessionCandidate } from './native-import/contracts.ts'

const policy: ExecutionPolicySnapshot = {
  delegationMode: 'disabled',
  allowedTools: [],
  approvalPolicy: 'never',
  cwd: null,
  maxDepth: 0,
  capabilityGrant: null,
}

const capabilities: ProviderCapabilities = {
  roles: ['user', 'assistant'],
  contentTypes: ['text'],
  toolCalling: true,
  parallelTools: false,
  contextWindow: 128_000,
  continuation: 'hybrid',
  reasoningState: 'opaque',
  taskMetadata: true,
  nativeChildExecution: 'disabled',
}

function deterministicOptions() {
  let id = 0
  let time = Date.parse('2026-07-18T00:00:00.000Z')
  return {
    idFactory: () => `id-${String(++id).padStart(5, '0')}`,
    now: () => new Date(time++).toISOString(),
  }
}

const temporaryDirectories: string[] = []

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
})

function databasePath(_t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'baton-session-'))
  temporaryDirectories.push(directory)
  return join(directory, 'sessions.sqlite')
}

function downgradeEmptyDerivedSchemaToV13(path: string): void {
  const database = new DatabaseSync(path)
  database.exec(`
    DROP INDEX context_compaction_jobs_active_frontier;
    DROP TRIGGER context_compaction_jobs_immutable_columns;
    DROP TRIGGER context_compaction_jobs_terminal;
    DROP TRIGGER context_compaction_jobs_transition;
    DROP TABLE context_compaction_heads;
    ALTER TABLE context_compaction_jobs DROP COLUMN view_key;
    ALTER TABLE context_compaction_jobs DROP COLUMN expected_previous_artifact_id;

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
    DELETE FROM schema_migrations WHERE version>=14;
    ALTER TABLE sessions DROP COLUMN ldplayer_grant_json;
    PRAGMA user_version=13;
  `)
  database.close()
}

function beginInput(threadId: string, request = 'request-1', hash = 'hash-1'): BeginTurnInput {
  return {
    threadId,
    provider: 'codex',
    model: 'gpt-test',
    effort: 'high',
    clientRequestId: request,
    requestHash: hash,
    expectedRevision: 0,
    input: [{ kind: 'user_message', payload: { text: 'hello' } }],
    adapterVersion: 'test-adapter/1',
    policySnapshot: policy,
  }
}

function beginSessionInput(
  overrides: Partial<BeginSessionInput> = {},
): BeginSessionInput {
  return {
    sessionId: 'client-session-1',
    clientRequestId: 'client-request-1',
    requestHash: 'initial-hash-1',
    cwd: 'C:\\verified\\project',
    instructionSnapshot: { schemaVersion: 1, developerInstructions: 'Keep changes focused.' },
    provider: 'codex',
    model: 'gpt-test',
    effort: 'high',
    input: [{ kind: 'user_message', payload: { text: '  First\n\nrequest  ' } }],
    adapterVersion: 'test-adapter/1',
    policySnapshot: { ...policy, cwd: 'C:\\verified\\project' },
    budget: { effort: 'high' },
    ...overrides,
  }
}

test('initial session materialization is atomic, idempotent, and keeps schema v16', (t) => {
  const path = databasePath(t)
  const store = new SqliteSessionStore(path, deterministicOptions())
  const input = beginSessionInput()
  const started = store.beginSession(input)

  assert.equal(started.duplicate, false)
  assert.equal(started.session.id, input.sessionId)
  assert.equal(started.session.title, null)
  assert.equal(started.session.preview, 'First request')
  assert.equal(started.session.projectKey, null)
  assert.equal(started.session.cwd, input.cwd)
  assert.equal(started.thread.parentThreadId, null)
  assert.equal(started.thread.revision, 1)
  assert.equal(started.thread.status, 'running')
  assert.deepEqual(started.thread.instructionSnapshot, input.instructionSnapshot)
  assert.equal(started.turn.sequence, 1)
  assert.equal(started.execution.kind, 'root_turn')
  assert.deepEqual(started.initialItems.map((item) => item.kind), ['user_message'])
  assert.deepEqual(store.listEvents(started.thread.id).map((event) => event.type), [
    'session_created',
    'turn_started',
  ])

  const duplicate = store.beginSession(input)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.thread.id, started.thread.id)
  assert.equal(duplicate.turn.id, started.turn.id)
  assert.equal(duplicate.execution.id, started.execution.id)
  assert.deepEqual(duplicate.initialItems.map((item) => item.id), started.initialItems.map((item) => item.id))
  assert.throws(
    () => store.beginSession({ ...input, requestHash: 'different-hash' }),
    (error) => error instanceof SessionStoreError && error.code === 'initial_session_conflict',
  )

  const database = new DatabaseSync(path, { readOnly: true })
  t.after(() => database.close())
  for (const [table, expected] of [
    ['sessions', 1],
    ['threads', 1],
    ['turns', 1],
    ['executions', 1],
    ['items', 1],
    ['stream_events', 2],
  ] as const) {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
    assert.equal(row.count, expected, table)
  }
  assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 16)
  store.close()

  const reopened = new SqliteSessionStore(path, deterministicOptions())
  t.after(() => reopened.close())
  const replayAfterReopen = reopened.getInitialSessionResult(input)
  assert.equal(replayAfterReopen?.duplicate, true)
  assert.equal(replayAfterReopen?.turn.id, started.turn.id)
})

test('initial session rolls every row back when canonical serialization fails', (t) => {
  const path = databasePath(t)
  const store = new SqliteSessionStore(path, deterministicOptions())
  t.after(() => store.close())
  const invalidSnapshot = {
    schemaVersion: 1,
    developerInstructions: 'valid',
    invalid: undefined,
  } as unknown as Record<string, unknown>

  assert.throws(
    () => store.beginSession(beginSessionInput({ instructionSnapshot: invalidSnapshot })),
    /Canonical JSON rejects undefined values/,
  )
  assert.deepEqual(store.listSessions('all'), [])
  const database = new DatabaseSync(path, { readOnly: true })
  t.after(() => database.close())
  for (const table of ['sessions', 'threads', 'turns', 'executions', 'items', 'stream_events']) {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
    assert.equal(row.count, 0, table)
  }
})

test('two open SQLite connections observe one idempotent initial graph', async (t) => {
  const path = databasePath(t)
  const first = new SqliteSessionStore(path, deterministicOptions())
  const second = new SqliteSessionStore(path, deterministicOptions())
  t.after(() => {
    first.close()
    second.close()
  })
  const input = beginSessionInput({ sessionId: 'two-connection-session' })

  // DatabaseSync calls cannot overlap inside one JS isolate, but separate live connections still
  // prove that the second transaction observes the committed receipt instead of duplicating it.
  const results = await Promise.all([
    Promise.resolve().then(() => first.beginSession(input)),
    Promise.resolve().then(() => second.beginSession(input)),
  ])
  assert.deepEqual(results.map((result) => result.duplicate).sort(), [false, true])
  assert.equal(results[0]?.turn.id, results[1]?.turn.id)
  assert.equal(first.listSessions('all').length, 1)
  const database = new DatabaseSync(path, { readOnly: true })
  t.after(() => database.close())
  for (const [table, expected] of [
    ['sessions', 1], ['threads', 1], ['turns', 1], ['executions', 1], ['items', 1], ['stream_events', 2],
  ] as const) {
    assert.equal((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, expected)
  }
})

function nativeCandidate(contents: string[], cwd: string, contentDigest: string): NativeSessionCandidate {
  return {
    candidateId: 'candidate-1',
    sourceClient: 'codex_local',
    provider: 'codex',
    namespaceKey: 'native-test',
    nativeSessionId: 'native-session-1',
    identityKeys: [],
    sourceAlias: 'Imported task',
    aliasSource: 'native',
    titleSource: 'metadata:user',
    projectAlias: 'Source project',
    projectGroupKey: 'source-project',
    cwd,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    nativeOrigin: 'cli',
    nativeArchived: false,
    sourceHead: { size: contents.length, mtimeMs: contents.length, finalRecordDigest: `digest-${contents.length}` },
    contentDigest,
    prefixDigest: `prefix-${contents.length}`,
    portableItemCount: contents.length,
    records: contents.map((text, index) => ({
      key: `record-${index + 1}`,
      ordinal: index + 1,
      digest: `digest-${index + 1}`,
      prefixDigest: `prefix-${index + 1}`,
      item: { kind: 'user_message', payload: { text } },
      createdAt: '2026-07-18T00:00:00.000Z',
    })),
    skippedItemCount: 0,
    parserVersion: 'test/1',
    warnings: [],
    materialized: true,
  }
}

test('schema v1 migrates through v16 with host capability storage', (t) => {
  const path = databasePath(t)
  const legacy = new DatabaseSync(path)
  legacy.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL) STRICT;
    INSERT INTO schema_migrations VALUES(1, 'canonical-session-v1', '2026-07-18T00:00:00.000Z');
    PRAGMA user_version = 1;
    CREATE TABLE sessions(
      id TEXT PRIMARY KEY, archived_at TEXT
    ) STRICT;
    CREATE TABLE threads(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE turns(
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
      client_request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      started_at TEXT, completed_at TEXT, usage_json TEXT, error_json TEXT
    ) STRICT;
    INSERT INTO turns VALUES(
      'turn-1','thread-1',1,'claude','claude-fable-5','completed','request-1','hash-1',
      '2026-07-18T00:00:00.000Z','2026-07-18T00:00:01.000Z',NULL,NULL
    );
    CREATE TABLE items(
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL
    ) STRICT;
    CREATE TABLE stream_events(
      sequence INTEGER PRIMARY KEY, session_id TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER items_no_delete BEFORE DELETE ON items BEGIN
      SELECT RAISE(ABORT, 'canonical items are append-only');
    END;
    CREATE TRIGGER stream_events_no_delete BEFORE DELETE ON stream_events BEGIN
      SELECT RAISE(ABORT, 'canonical events are append-only');
    END;
  `)
  legacy.close()

  const store = new SqliteSessionStore(path)
  t.after(() => store.close())
  assert.equal(store.getTurn('turn-1')?.effort, null)
  const inspected = new DatabaseSync(path, { readOnly: true })
  t.after(() => inspected.close())
  assert.equal((inspected.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 16)
  const migrations = inspected.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>
  const sourceColumns = inspected.prepare('PRAGMA table_info(native_session_sources)').all() as Array<{ name: string }>
  assert.deepEqual(migrations.map((row) => row.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
  assert.equal(sourceColumns.some((column) => column.name === 'title_source'), true)
  const indexes = inspected.prepare("SELECT name FROM sqlite_schema WHERE type='index'").all() as Array<{ name: string }>
  assert.equal(indexes.some((index) => index.name === 'sessions_archived_expiry'), true)
  const turnColumns = inspected.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>
  assert.equal(turnColumns.some((column) => column.name === 'goal_id'), true)
  assert.equal(turnColumns.some((column) => column.name === 'goal_revision'), true)
  const goalTables = inspected.prepare(`
    SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'goal%'
  `).all() as Array<{ name: string }>
  assert.deepEqual(goalTables.map((table) => table.name).sort(), [
    'goal_events',
    'goal_scheduler_leases',
    'goal_turn_accounting',
    'goals',
  ])
  assert.equal((inspected.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table' AND name='follow_ups'
  `).get() as { count: number }).count, 1)
  assert.equal((inspected.prepare(`
    SELECT COUNT(*) AS count FROM pragma_table_info('follow_ups') WHERE name='after_turn_sequence'
  `).get() as { count: number }).count, 1)
  assert.equal((inspected.prepare('SELECT follow_up_window FROM turns WHERE id=?').get('turn-1') as {
    follow_up_window: string
  }).follow_up_window, 'closed')
})

test('schema v6 migrates to v16 in place and reopens without replaying migrations', (t) => {
  const path = databasePath(t)
  const legacy = new DatabaseSync(path)
  legacy.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL) STRICT;
    INSERT INTO schema_migrations VALUES
      (1,'canonical-session-v1','2026-07-18T00:00:00.000Z'),
      (2,'turn-reasoning-effort','2026-07-18T00:00:00.000Z'),
      (3,'native-session-import','2026-07-18T00:00:00.000Z'),
      (4,'native-import-recovery-and-provenance','2026-07-18T00:00:00.000Z'),
      (5,'native-session-title-provenance','2026-07-18T00:00:00.000Z'),
      (6,'session-trash-retention','2026-07-18T00:00:00.000Z');
    PRAGMA user_version = 6;
    CREATE TABLE sessions(
      id TEXT PRIMARY KEY,title TEXT,preview TEXT,active_thread_id TEXT NOT NULL,project_key TEXT,cwd TEXT,
      schema_version INTEGER NOT NULL,next_item_sequence INTEGER NOT NULL,created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,archived_at TEXT
    ) STRICT;
    CREATE TABLE threads(
      id TEXT PRIMARY KEY,session_id TEXT NOT NULL,parent_thread_id TEXT,fork_turn_id TEXT,fork_item_id TEXT,
      revision INTEGER NOT NULL,status TEXT NOT NULL,instruction_snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE turns(
      id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,sequence INTEGER NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,
      status TEXT NOT NULL,client_request_id TEXT NOT NULL,request_hash TEXT NOT NULL,started_at TEXT,completed_at TEXT,
      usage_json TEXT,error_json TEXT,effort TEXT
    ) STRICT;
    CREATE TABLE session_purge_context(session_id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE native_import_meta(key TEXT PRIMARY KEY,value BLOB NOT NULL) STRICT;
    INSERT INTO native_import_meta VALUES('identity_hmac_key',zeroblob(32));
    INSERT INTO sessions VALUES(
      'session-v6',NULL,NULL,'thread-v6',NULL,NULL,1,1,
      '2026-07-18T00:00:00.000Z','2026-07-18T00:00:00.000Z',NULL
    );
    INSERT INTO threads VALUES(
      'thread-v6','session-v6',NULL,NULL,NULL,0,'idle','{}',
      '2026-07-18T00:00:00.000Z','2026-07-18T00:00:00.000Z'
    );
    INSERT INTO turns VALUES(
      'turn-v6','thread-v6',1,'codex','gpt-test','completed','request-v6','hash-v6',
      '2026-07-18T00:00:00.000Z','2026-07-18T00:00:01.000Z',NULL,NULL,'high'
    );
  `)
  legacy.close()

  const first = new SqliteSessionStore(path)
  assert.equal(first.getTurn('turn-v6')?.model, 'gpt-test')
  first.close()
  const reopened = new SqliteSessionStore(path)
  t.after(() => reopened.close())
  const inspected = new DatabaseSync(path, { readOnly: true })
  t.after(() => inspected.close())
  assert.equal((inspected.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 16)
  assert.deepEqual(
    (inspected.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>)
      .map((row) => row.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  )
  assert.equal((inspected.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=7")
    .get() as { count: number }).count, 1)
  assert.equal((inspected.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=8")
    .get() as { count: number }).count, 1)
  assert.equal((inspected.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=9")
    .get() as { count: number }).count, 1)
  assert.equal((inspected.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=10")
    .get() as { count: number }).count, 1)
})

test('schema v10 rebuilds follow-up constraints through v16 with foreign keys and reopens once', (t) => {
  const path = databasePath(t)
  const legacy = new DatabaseSync(path)
  legacy.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,applied_at TEXT NOT NULL) STRICT;
    INSERT INTO schema_migrations SELECT value,'v'||value,'2026-07-18T00:00:00.000Z' FROM json_each('[1,2,3,4,5,6,7,8,9,10]');
    PRAGMA user_version=10;
    CREATE TABLE sessions(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE threads(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE turns(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE native_import_meta(key TEXT PRIMARY KEY,value BLOB NOT NULL) STRICT;
    INSERT INTO native_import_meta VALUES('identity_hmac_key',zeroblob(32));
    CREATE TABLE follow_ups(
      id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),thread_id TEXT NOT NULL REFERENCES threads(id),
      client_request_id TEXT NOT NULL,request_hash TEXT NOT NULL,sequence INTEGER NOT NULL,after_turn_sequence INTEGER NOT NULL,
      delivery TEXT NOT NULL,status TEXT NOT NULL,target_turn_id TEXT REFERENCES turns(id),consumed_turn_id TEXT REFERENCES turns(id),
      consumed_item_ids_json TEXT NOT NULL,goal_id TEXT,goal_revision INTEGER,input_json TEXT NOT NULL,
      dispatch_owner TEXT,lease_expires_at TEXT,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,consumed_at TEXT,
      UNIQUE(thread_id,client_request_id),UNIQUE(thread_id,sequence)
    ) STRICT;
    CREATE INDEX follow_ups_thread_state_sequence ON follow_ups(thread_id,status,sequence);
    CREATE INDEX follow_ups_target_state_sequence ON follow_ups(target_turn_id,status,sequence);
    CREATE INDEX follow_ups_expired_dispatch ON follow_ups(lease_expires_at,id) WHERE status='dispatching';
    INSERT INTO sessions VALUES('s'); INSERT INTO threads VALUES('th');
    INSERT INTO follow_ups VALUES('f','s','th','r','h',1,0,'next_turn','queued',NULL,NULL,'[]',NULL,NULL,'[{"kind":"user_message","payload":{"text":"x"}}]',NULL,NULL,1,'2026-07-18','2026-07-18',NULL);
  `)
  legacy.close()
  const first = new SqliteSessionStore(path)
  first.close()
  const reopened = new SqliteSessionStore(path)
  t.after(() => reopened.close())
  const inspected = new DatabaseSync(path, { readOnly: true })
  t.after(() => inspected.close())
  assert.equal((inspected.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 16)
  assert.deepEqual(inspected.prepare('PRAGMA foreign_key_check').all(), [])
  assert.equal((inspected.prepare('SELECT status FROM follow_ups WHERE id=?').get('f') as { status: string }).status, 'queued')
})

test('schema v12 migrates once to immutable derived context tables and preserves canonical rows', (t) => {
  const path = databasePath(t)
  const initial = new SqliteSessionStore(path, deterministicOptions())
  const session = initial.createSession({ title: 'migration sentinel' })
  initial.close()

  const legacy = new DatabaseSync(path)
  legacy.exec(`
    DROP TABLE execution_context_manifest_entries;
    DROP TABLE execution_context_manifests;
    DROP TABLE context_compaction_source_items;
    DROP TABLE context_compaction_job_events;
    DROP TABLE context_compaction_heads;
    DROP TABLE context_compactions;
    DROP TABLE context_compaction_jobs;
    DELETE FROM schema_migrations WHERE version>=13;
    ALTER TABLE sessions DROP COLUMN ldplayer_grant_json;
    PRAGMA user_version=12;
  `)
  legacy.close()

  const migrated = new SqliteSessionStore(path, deterministicOptions())
  assert.equal(migrated.getSession(session.id)?.title, 'migration sentinel')
  migrated.close()
  const reopened = new SqliteSessionStore(path, deterministicOptions())
  t.after(() => reopened.close())

  const inspected = new DatabaseSync(path, { readOnly: true })
  t.after(() => inspected.close())
  assert.equal((inspected.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 16)
  assert.deepEqual(
    (inspected.prepare('SELECT version FROM schema_migrations WHERE version>=13 ORDER BY version')
      .all() as Array<{ version: number }>).map((row) => row.version),
    [13, 14, 15, 16],
  )
  const tables = (inspected.prepare(`
    SELECT name FROM sqlite_schema WHERE type='table'
      AND (name LIKE 'context_compaction%' OR name LIKE 'execution_context%')
    ORDER BY name
  `).all() as Array<{ name: string }>).map((row) => row.name)
  assert.deepEqual(tables, [
    'context_compaction_heads',
    'context_compaction_job_events',
    'context_compaction_jobs',
    'context_compaction_source_items',
    'context_compactions',
    'execution_context_manifest_entries',
    'execution_context_manifests',
  ])
})

test('schema v16 reopen fails closed when a derived-context protection trigger is missing', (t) => {
  const path = databasePath(t)
  const initial = new SqliteSessionStore(path, deterministicOptions())
  initial.close()
  const external = new DatabaseSync(path)
  external.exec('DROP TRIGGER context_compaction_heads_transition')
  external.close()
  assert.throws(
    () => new SqliteSessionStore(path, deterministicOptions()),
    (error: unknown) => error instanceof ContextPersistenceError
      && error.code === 'integrity_violation'
      && error.message.includes('trigger:context_compaction_heads_transition'),
  )
})

test('an empty released v13 database migrates through v16 and gains the authoritative frontier schema', (t) => {
  const path = databasePath(t)
  const initial = new SqliteSessionStore(path, deterministicOptions())
  const session = initial.createSession({ title: 'old-v13 sentinel' })
  initial.close()
  downgradeEmptyDerivedSchemaToV13(path)

  const migrated = new SqliteSessionStore(path, deterministicOptions())
  assert.equal(migrated.getSession(session.id)?.title, 'old-v13 sentinel')
  migrated.close()
  const inspected = new DatabaseSync(path, { readOnly: true })
  t.after(() => inspected.close())
  assert.equal((inspected.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 16)
  assert.ok((inspected.prepare(`
    SELECT 1 FROM pragma_table_info('context_compaction_jobs')
    WHERE name='expected_previous_artifact_id'
  `).get()))
  assert.ok(inspected.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type='table' AND name='context_compaction_heads'
  `).get())
  assert.equal((inspected.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=14')
    .get() as { count: number }).count, 1)
})

test('v13 frontier migration fails closed instead of guessing over existing derived rows', (t) => {
  const path = databasePath(t)
  const initial = new SqliteSessionStore(path, deterministicOptions())
  const session = initial.createSession({})
  initial.close()
  downgradeEmptyDerivedSchemaToV13(path)
  const external = new DatabaseSync(path)
  external.prepare(`
    INSERT INTO context_compaction_jobs(
      id,thread_id,request_key,request_hash,source_item_ids_json,source_hash,summary_input_hash,
      status,revision,lease_owner,lease_expires_at,attempt_count,error_json,created_at,updated_at,completed_at
    ) VALUES (?,?,?,?,?,?,?,'queued',1,NULL,NULL,0,NULL,?,?,NULL)
  `).run('legacy-job', session.activeThreadId, 'legacy-request', 'a'.repeat(64), '["legacy-item"]',
    'b'.repeat(64), 'c'.repeat(64), '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z')
  external.close()
  assert.throws(
    () => new SqliteSessionStore(path, deterministicOptions()),
    (error: unknown) => error instanceof ContextPersistenceError
      && error.code === 'integrity_violation'
      && error.message.includes('explicit frontier migration'),
  )
})

test('compaction artifacts cover an exact immutable canonical prefix and survive reopen', (t) => {
  const path = databasePath(t)
  const store = new SqliteSessionStore(path, deterministicOptions())
  const session = store.createSession({})
  const first = store.beginTurn(beginInput(session.activeThreadId))
  store.appendProviderEvent({
    turnId: first.turn.id,
    eventId: 'first-reply',
    items: [{ kind: 'assistant_message', payload: { text: 'answer' } }],
  })
  store.finishTurn({ turnId: first.turn.id, status: 'completed' })
  const source = store.listItems(session.activeThreadId)
  const created = store.createContextCompactionJob({
    threadId: session.activeThreadId,
    requestKey: 'compact-prefix-1',
    sourceItemIds: source.map((item) => item.id),
    summaryInputHash: 'a'.repeat(64),
    expectedPreviousArtifactId: null,
  })
  assert.equal(created.duplicate, false)
  assert.equal(created.job.status, 'queued')
  assert.deepEqual(created.job.sourceItemIds, source.map((item) => item.id))
  assert.equal(created.job.sourceHash, sourceHashForItems(source))
  assert.equal(store.createContextCompactionJob({
    threadId: session.activeThreadId,
    requestKey: 'compact-prefix-1',
    sourceItemIds: source.map((item) => item.id),
    summaryInputHash: 'a'.repeat(64),
    expectedPreviousArtifactId: null,
  }).duplicate, true)
  assert.throws(() => store.createContextCompactionJob({
    threadId: session.activeThreadId,
    requestKey: 'compact-prefix-1',
    sourceItemIds: [source[0]!.id],
    summaryInputHash: 'a'.repeat(64),
    expectedPreviousArtifactId: null,
  }), (error: unknown) => error instanceof ContextPersistenceError && error.code === 'idempotency_conflict')

  const claimed = store.claimContextCompactionJob({ jobId: created.job.id, ownerId: 'worker-1' })
  assert.equal(claimed?.status, 'running')
  assert.equal(claimed?.attemptCount, 1)
  const completed = store.completeContextCompactionJob({
    jobId: created.job.id,
    ownerId: 'worker-1',
    summary: { text: 'Derived summary only', format: 'portable-v1', summaryInput: { previousArtifactId: null } },
    generatorProvider: 'codex',
    generatorModel: 'gpt-test',
    generatorVersion: 'compactor/1',
  })
  assert.equal(completed.duplicate, false)
  assert.deepEqual(completed.artifact.sourceItems.map((item) => item.itemId), source.map((item) => item.id))
  assert.equal(store.completeContextCompactionJob({
    jobId: created.job.id,
    ownerId: 'worker-1',
    summary: { format: 'portable-v1', text: 'Derived summary only', summaryInput: { previousArtifactId: null } },
    generatorProvider: 'codex',
    generatorModel: 'gpt-test',
    generatorVersion: 'compactor/1',
  }).duplicate, true)
  assert.equal(store.listItems(session.activeThreadId).length, source.length)
  store.close()

  const reopened = new SqliteSessionStore(path, deterministicOptions())
  t.after(() => reopened.close())
  assert.equal(reopened.getContextCompactionJob(created.job.id)?.artifactId, completed.artifact.id)
  assert.deepEqual(
    reopened.getContextCompactionArtifact(completed.artifact.id)?.summary,
    { format: 'portable-v1', summaryInput: { previousArtifactId: null }, text: 'Derived summary only' },
  )
  assert.equal(reopened.getLatestContextCompaction(session.activeThreadId)?.id, completed.artifact.id)
  assert.deepEqual(reopened.listItems(session.activeThreadId).map((item) => item.id), source.map((item) => item.id))
})

test('compaction creation is idempotent across connections and rejects source reordering or active turns', async (t) => {
  const path = databasePath(t)
  const firstStore = new SqliteSessionStore(path, deterministicOptions())
  const secondStore = new SqliteSessionStore(path, deterministicOptions())
  t.after(() => {
    firstStore.close()
    secondStore.close()
  })
  const session = firstStore.createSession({})
  const firstTurn = firstStore.beginTurn(beginInput(session.activeThreadId))
  firstStore.appendProviderEvent({
    turnId: firstTurn.turn.id,
    eventId: 'reply',
    items: [{ kind: 'assistant_message', payload: { text: 'done' } }],
  })
  firstStore.finishTurn({ turnId: firstTurn.turn.id, status: 'completed' })
  const completedItems = firstStore.listItems(session.activeThreadId)
  const activeTurn = firstStore.beginTurn({
    ...beginInput(session.activeThreadId, 'request-2', 'hash-2'),
    expectedRevision: 2,
  })
  const allItems = firstStore.listItems(session.activeThreadId)
  assert.throws(() => firstStore.createContextCompactionJob({
    threadId: session.activeThreadId,
    requestKey: 'includes-active',
    sourceItemIds: allItems.map((item) => item.id),
    summaryInputHash: 'b'.repeat(64),
    expectedPreviousArtifactId: null,
  }), (error: unknown) => error instanceof ContextPersistenceError && error.code === 'invalid_input')
  assert.throws(() => firstStore.createContextCompactionJob({
    threadId: session.activeThreadId,
    requestKey: 'reordered',
    sourceItemIds: [completedItems[1]!.id, completedItems[0]!.id],
    summaryInputHash: 'b'.repeat(64),
    expectedPreviousArtifactId: null,
  }), (error: unknown) => error instanceof ContextPersistenceError && error.code === 'invalid_input')

  const input = {
    threadId: session.activeThreadId,
    requestKey: 'cross-connection',
    sourceItemIds: completedItems.map((item) => item.id),
    summaryInputHash: 'c'.repeat(64),
    expectedPreviousArtifactId: null,
  }
  const results = await Promise.all([
    Promise.resolve().then(() => firstStore.createContextCompactionJob(input)),
    Promise.resolve().then(() => secondStore.createContextCompactionJob(input)),
  ])
  assert.deepEqual(results.map((result) => result.duplicate).sort(), [false, true])
  assert.equal(results[0]?.job.id, results[1]?.job.id)
  const jobId = results[0]!.job.id
  assert.equal(firstStore.claimContextCompactionJob({ jobId, ownerId: 'shared-worker' })?.status, 'running')
  const completionInput = {
    jobId,
    ownerId: 'shared-worker',
    summary: { text: 'cross-connection summary', summaryInput: { previousArtifactId: null } },
    generatorProvider: 'codex' as const,
    generatorModel: 'gpt-test',
    generatorVersion: 'compactor/1',
  }
  const completions = await Promise.all([
    Promise.resolve().then(() => firstStore.completeContextCompactionJob(completionInput)),
    Promise.resolve().then(() => secondStore.completeContextCompactionJob(completionInput)),
  ])
  assert.deepEqual(completions.map((result) => result.duplicate).sort(), [false, true])
  assert.equal(completions[0]?.artifact.id, completions[1]?.artifact.id)
  firstStore.finishTurn({ turnId: activeTurn.turn.id, status: 'cancelled' })
})

test('compaction head CAS admits only one different writer per frontier and survives reopen', async (t) => {
  const path = databasePath(t)
  const firstStore = new SqliteSessionStore(path)
  const secondStore = new SqliteSessionStore(path)
  const session = firstStore.createSession({})
  const turn = firstStore.beginTurn(beginInput(session.activeThreadId))
  firstStore.finishTurn({ turnId: turn.turn.id, status: 'completed' })
  const sourceItemIds = firstStore.listItems(session.activeThreadId).map((item) => item.id)
  const requests = [
    {
      threadId: session.activeThreadId,
      requestKey: 'writer-a',
      sourceItemIds,
      summaryInputHash: 'a'.repeat(64),
      expectedPreviousArtifactId: null,
    },
    {
      threadId: session.activeThreadId,
      requestKey: 'writer-b',
      sourceItemIds,
      summaryInputHash: 'b'.repeat(64),
      expectedPreviousArtifactId: null,
    },
  ]
  const raced = await Promise.allSettled([
    Promise.resolve().then(() => firstStore.createContextCompactionJob(requests[0]!)),
    Promise.resolve().then(() => secondStore.createContextCompactionJob(requests[1]!)),
  ])
  const accepted = raced.filter((result) => result.status === 'fulfilled')
  const rejected = raced.filter((result) => result.status === 'rejected')
  assert.equal(accepted.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal(
    (rejected[0] as PromiseRejectedResult).reason instanceof ContextPersistenceError
      && (rejected[0] as PromiseRejectedResult).reason.code,
    'stale_frontier',
  )
  const acceptedJob = (accepted[0] as PromiseFulfilledResult<
    ReturnType<SqliteSessionStore['createContextCompactionJob']>
  >).value.job
  assert.equal(firstStore.claimContextCompactionJob({
    jobId: acceptedJob.id,
    ownerId: 'winner',
  })?.status, 'running')
  const artifact = firstStore.completeContextCompactionJob({
    jobId: acceptedJob.id,
    ownerId: 'winner',
    summary: { text: 'winner', summaryInput: { previousArtifactId: null } },
    generatorProvider: 'codex',
    generatorModel: 'gpt-test',
    generatorVersion: 'compactor/1',
  }).artifact
  assert.equal(secondStore.getLatestContextCompaction(session.activeThreadId)?.id, artifact.id)
  assert.throws(
    () => secondStore.createContextCompactionJob({ ...requests[1]!, requestKey: 'stale-after-complete' }),
    (error: unknown) => error instanceof ContextPersistenceError && error.code === 'stale_frontier',
  )
  firstStore.close()
  secondStore.close()

  const reopened = new SqliteSessionStore(path)
  t.after(() => reopened.close())
  assert.equal(reopened.getLatestContextCompaction(session.activeThreadId)?.id, artifact.id)
  assert.equal(reopened.getContextCompactionJob(acceptedJob.id)?.expectedPreviousArtifactId, null)
})

test('context view heads advance independently for different model budgets', (t) => {
  const store = new SqliteSessionStore(databasePath(t), deterministicOptions())
  t.after(() => store.close())
  const session = store.createSession({})
  const turn = store.beginTurn(beginInput(session.activeThreadId))
  store.finishTurn({ turnId: turn.turn.id, status: 'completed' })
  const sourceItemIds = store.listItems(session.activeThreadId).map((item) => item.id)

  const completeView = (viewKey: string, requestKey: string, hash: string) => {
    const job = store.reserveContextCompactionJob({
      threadId: session.activeThreadId,
      viewKey,
      requestKey,
      sourceItemIds,
      summaryInputHash: hash.repeat(64),
      expectedPreviousArtifactId: null,
      ownerId: `owner-${viewKey}`,
    }).job
    return store.completeContextCompactionJob({
      jobId: job.id,
      ownerId: `owner-${viewKey}`,
      summary: { text: viewKey, summaryInput: { previousArtifactId: null } },
      generatorProvider: 'codex',
      generatorModel: 'gpt-test',
      generatorVersion: 'compactor/1',
    }).artifact
  }

  const small = completeView('codex-258k-v1', 'small-view', 'a')
  const large = completeView('codex-1m-v1', 'large-view', 'b')
  assert.equal(store.getLatestContextCompaction(session.activeThreadId, 'codex-258k-v1')?.id, small.id)
  assert.equal(store.getLatestContextCompaction(session.activeThreadId, 'codex-1m-v1')?.id, large.id)
  assert.notEqual(small.id, large.id)
  assert.equal(small.viewKey, 'codex-258k-v1')
  assert.equal(large.viewKey, 'codex-1m-v1')
})

test('atomic compaction reservation retires a queued orphan before a different contract completes', (t) => {
  const path = databasePath(t)
  const now = '2026-07-18T00:00:00.000Z'
  const store = new SqliteSessionStore(path, { ...deterministicOptions(), now: () => now })
  t.after(() => store.close())
  const session = store.createSession({})
  const turn = store.beginTurn(beginInput(session.activeThreadId))
  store.finishTurn({ turnId: turn.turn.id, status: 'completed' })
  const sourceItemIds = store.listItems(session.activeThreadId).map((item) => item.id)
  const orphan = store.createContextCompactionJob({
    threadId: session.activeThreadId,
    requestKey: 'queued-before-claim',
    sourceItemIds,
    summaryInputHash: 'a'.repeat(64),
    expectedPreviousArtifactId: null,
  }).job

  const replacement = store.reserveContextCompactionJob({
    threadId: session.activeThreadId,
    requestKey: 'different-contract-after-queued-crash',
    sourceItemIds,
    summaryInputHash: 'b'.repeat(64),
    expectedPreviousArtifactId: null,
    ownerId: 'provider-b',
  }).job
  assert.equal(replacement.status, 'running')
  assert.equal(replacement.leaseOwner, 'provider-b')
  assert.deepEqual(store.getContextCompactionJob(orphan.id)?.error, {
    code: 'abandoned_reservation',
    reason: 'orphaned_queued_reservation',
  })
  const artifact = store.completeContextCompactionJob({
    jobId: replacement.id,
    ownerId: 'provider-b',
    summary: { text: 'replacement', summaryInput: { previousArtifactId: null } },
    generatorProvider: 'codex',
    generatorModel: 'gpt-test',
    generatorVersion: 'compactor/1',
  }).artifact
  assert.equal(store.getLatestContextCompaction(session.activeThreadId)?.id, artifact.id)

  const inspected = new DatabaseSync(path, { readOnly: true })
  t.after(() => inspected.close())
  assert.deepEqual(
    (inspected.prepare(`
      SELECT status FROM context_compaction_job_events WHERE job_id=? ORDER BY sequence
    `).all(orphan.id) as Array<{ status: string }>).map((event) => event.status),
    ['queued', 'running', 'failed'],
  )
})

test('atomic compaction reservation retires an expired competing contract before completion', (t) => {
  const path = databasePath(t)
  let now = '2026-07-18T00:00:00.000Z'
  const store = new SqliteSessionStore(path, { ...deterministicOptions(), now: () => now })
  t.after(() => store.close())
  const session = store.createSession({})
  const turn = store.beginTurn(beginInput(session.activeThreadId))
  store.finishTurn({ turnId: turn.turn.id, status: 'completed' })
  const sourceItemIds = store.listItems(session.activeThreadId).map((item) => item.id)
  const expired = store.reserveContextCompactionJob({
    threadId: session.activeThreadId,
    requestKey: 'provider-a-running',
    sourceItemIds,
    summaryInputHash: 'c'.repeat(64),
    expectedPreviousArtifactId: null,
    ownerId: 'provider-a',
    leaseDurationMs: 1_000,
  }).job
  assert.equal(expired.status, 'running')

  now = '2026-07-18T00:00:02.000Z'
  const replacement = store.reserveContextCompactionJob({
    threadId: session.activeThreadId,
    requestKey: 'provider-b-different-contract',
    sourceItemIds,
    summaryInputHash: 'd'.repeat(64),
    expectedPreviousArtifactId: null,
    ownerId: 'provider-b',
  }).job
  assert.equal(replacement.status, 'running')
  assert.equal(replacement.leaseOwner, 'provider-b')
  assert.deepEqual(store.getContextCompactionJob(expired.id)?.error, {
    code: 'abandoned_reservation',
    reason: 'expired_competing_reservation',
  })
  const artifact = store.completeContextCompactionJob({
    jobId: replacement.id,
    ownerId: 'provider-b',
    summary: { text: 'replacement', summaryInput: { previousArtifactId: null } },
    generatorProvider: 'claude',
    generatorModel: 'claude-test',
    generatorVersion: 'compactor/1',
  }).artifact
  assert.equal(store.getLatestContextCompaction(session.activeThreadId)?.id, artifact.id)
})

test('an exact failed compaction request is explicitly requeued at the same head frontier', (t) => {
  const path = databasePath(t)
  const store = new SqliteSessionStore(path, deterministicOptions())
  t.after(() => store.close())
  const session = store.createSession({})
  const turn = store.beginTurn(beginInput(session.activeThreadId))
  store.finishTurn({ turnId: turn.turn.id, status: 'completed' })
  const request = {
    threadId: session.activeThreadId,
    requestKey: 'retry-exact-failure',
    sourceItemIds: store.listItems(session.activeThreadId).map((item) => item.id),
    summaryInputHash: '9'.repeat(64),
    expectedPreviousArtifactId: null,
  }
  const job = store.createContextCompactionJob(request).job
  store.claimContextCompactionJob({ jobId: job.id, ownerId: 'first-worker' })
  store.failContextCompactionJob({
    jobId: job.id,
    ownerId: 'first-worker',
    error: { code: 'temporary' },
  })
  const retried = store.createContextCompactionJob(request)
  assert.equal(retried.duplicate, true)
  assert.equal(retried.job.id, job.id)
  assert.equal(retried.job.status, 'queued')
  assert.equal(retried.job.error, null)
  assert.equal(store.claimContextCompactionJob({
    jobId: job.id,
    ownerId: 'second-worker',
  })?.attemptCount, 2)
  const completed = store.completeContextCompactionJob({
    jobId: job.id,
    ownerId: 'second-worker',
    summary: { text: 'retry succeeded', summaryInput: { previousArtifactId: null } },
    generatorProvider: 'claude',
    generatorModel: 'claude-test',
    generatorVersion: 'compactor/1',
  })
  assert.equal(store.getLatestContextCompaction(session.activeThreadId)?.id, completed.artifact.id)

  const inspected = new DatabaseSync(path, { readOnly: true })
  t.after(() => inspected.close())
  assert.deepEqual(
    (inspected.prepare(`
      SELECT status FROM context_compaction_job_events WHERE job_id=? ORDER BY sequence
    `).all(job.id) as Array<{ status: string }>).map((event) => event.status),
    ['queued', 'running', 'failed', 'queued', 'running', 'completed'],
  )
})

test('chained artifact frontier is immutable, hash-bound, and valid after reopen', (t) => {
  const path = databasePath(t)
  const store = new SqliteSessionStore(path, deterministicOptions())
  const session = store.createSession({})
  const firstTurn = store.beginTurn(beginInput(session.activeThreadId))
  store.finishTurn({ turnId: firstTurn.turn.id, status: 'completed' })
  const firstJob = store.createContextCompactionJob({
    threadId: session.activeThreadId,
    requestKey: 'chain-first',
    sourceItemIds: store.listItems(session.activeThreadId).map((item) => item.id),
    summaryInputHash: '7'.repeat(64),
    expectedPreviousArtifactId: null,
  }).job
  store.claimContextCompactionJob({ jobId: firstJob.id, ownerId: 'worker' })
  const firstArtifact = store.completeContextCompactionJob({
    jobId: firstJob.id,
    ownerId: 'worker',
    summary: { text: 'first', summaryInput: { previousArtifactId: null } },
    generatorProvider: 'codex',
    generatorModel: 'gpt-test',
    generatorVersion: 'compactor/1',
  }).artifact
  assert.throws(() => store.createContextCompactionJob({
    threadId: session.activeThreadId,
    requestKey: 'chain-regression',
    sourceItemIds: store.listItems(session.activeThreadId).map((item) => item.id),
    summaryInputHash: '4'.repeat(64),
    expectedPreviousArtifactId: firstArtifact.id,
  }), (error: unknown) => error instanceof ContextPersistenceError && error.code === 'invalid_input')
  const secondTurn = store.beginTurn({
    ...beginInput(session.activeThreadId, 'request-chain-2', 'hash-chain-2'),
    expectedRevision: 2,
  })
  store.finishTurn({ turnId: secondTurn.turn.id, status: 'completed' })
  const secondJob = store.createContextCompactionJob({
    threadId: session.activeThreadId,
    requestKey: 'chain-second',
    sourceItemIds: store.listItems(session.activeThreadId).map((item) => item.id),
    summaryInputHash: '8'.repeat(64),
    expectedPreviousArtifactId: firstArtifact.id,
  }).job
  store.claimContextCompactionJob({ jobId: secondJob.id, ownerId: 'worker' })
  const secondArtifact = store.completeContextCompactionJob({
    jobId: secondJob.id,
    ownerId: 'worker',
    summary: { text: 'second', summaryInput: { previousArtifactId: firstArtifact.id } },
    generatorProvider: 'codex',
    generatorModel: 'gpt-test',
    generatorVersion: 'compactor/1',
  }).artifact
  store.close()

  const reopened = new SqliteSessionStore(path, deterministicOptions())
  t.after(() => reopened.close())
  assert.equal(reopened.getContextCompactionJob(secondJob.id)?.expectedPreviousArtifactId, firstArtifact.id)
  assert.equal(reopened.getLatestContextCompaction(session.activeThreadId)?.id, secondArtifact.id)
  const external = new DatabaseSync(path)
  t.after(() => external.close())
  assert.throws(
    () => external.prepare(`
      UPDATE context_compaction_jobs SET expected_previous_artifact_id=NULL WHERE id=?
    `).run(secondJob.id),
    /(?:identity|terminal compaction jobs) (?:is|are) immutable/,
  )
  external.exec('DROP TRIGGER context_compaction_jobs_immutable_columns')
  external.exec('DROP TRIGGER context_compaction_jobs_terminal')
  external.prepare(`
    UPDATE context_compaction_jobs SET expected_previous_artifact_id=NULL WHERE id=?
  `).run(secondJob.id)
  assert.throws(
    () => reopened.getContextCompactionJob(secondJob.id),
    (error: unknown) => error instanceof ContextPersistenceError && error.code === 'integrity_violation',
  )
})

test('terminal failed, cancelled, and interrupted turns are compactable but unresolved tools are not', (t) => {
  const store = new SqliteSessionStore(databasePath(t), deterministicOptions())
  t.after(() => store.close())
  const session = store.createSession({})
  for (const [index, status] of (['failed', 'cancelled', 'interrupted'] as const).entries()) {
    const turn = store.beginTurn({
      ...beginInput(session.activeThreadId, `terminal-${index}`, `terminal-hash-${index}`),
      expectedRevision: store.getThread(session.activeThreadId)!.revision,
    })
    store.finishTurn({
      turnId: turn.turn.id,
      status,
      ...(status === 'failed' ? { error: { code: 'provider_failed' } } : {}),
    })
  }
  const terminalSource = store.listItems(session.activeThreadId).map((item) => item.id)
  assert.equal(store.createContextCompactionJob({
    threadId: session.activeThreadId,
    requestKey: 'terminal-prefix',
    sourceItemIds: terminalSource,
    summaryInputHash: '6'.repeat(64),
    expectedPreviousArtifactId: null,
  }).job.status, 'queued')

  const other = store.createSession({})
  const unresolved = store.beginTurn(beginInput(other.activeThreadId))
  store.appendProviderEvent({
    turnId: unresolved.turn.id,
    eventId: 'unresolved-call',
    items: [{
      kind: 'tool_call',
      payload: { callId: 'call-1', name: 'read_file', input: { path: 'x' }, sideEffect: 'read' },
    }],
  })
  store.finishTurn({ turnId: unresolved.turn.id, status: 'interrupted' })
  assert.throws(() => store.createContextCompactionJob({
    threadId: other.activeThreadId,
    requestKey: 'unsafe-tool-prefix',
    sourceItemIds: store.listItems(other.activeThreadId).map((item) => item.id),
    summaryInputHash: '5'.repeat(64),
    expectedPreviousArtifactId: null,
  }), (error: unknown) => error instanceof ContextPersistenceError && error.code === 'invalid_input')
})

test('execution manifests preserve exact compaction and uncovered suffix provenance', (t) => {
  const path = databasePath(t)
  const store = new SqliteSessionStore(path, deterministicOptions())
  const session = store.createSession({})
  const first = store.beginTurn(beginInput(session.activeThreadId))
  store.appendProviderEvent({
    turnId: first.turn.id,
    eventId: 'reply-1',
    items: [{ kind: 'assistant_message', payload: { text: 'first answer' } }],
  })
  store.finishTurn({ turnId: first.turn.id, status: 'completed' })
  const compactedItems = store.listItems(session.activeThreadId)
  const job = store.createContextCompactionJob({
    threadId: session.activeThreadId,
    requestKey: 'manifest-prefix',
    sourceItemIds: compactedItems.map((item) => item.id),
    summaryInputHash: 'd'.repeat(64),
    expectedPreviousArtifactId: null,
  }).job
  store.claimContextCompactionJob({ jobId: job.id, ownerId: 'worker' })
  const artifact = store.completeContextCompactionJob({
    jobId: job.id,
    ownerId: 'worker',
    summary: { text: 'first turn summary', summaryInput: { previousArtifactId: null } },
    generatorProvider: 'claude',
    generatorModel: 'claude-test',
    generatorVersion: 'compactor/1',
  }).artifact
  const second = store.beginTurn({
    ...beginInput(session.activeThreadId, 'request-2', 'hash-2'),
    expectedRevision: 2,
  })
  const suffix = store.listItems(session.activeThreadId).slice(compactedItems.length)
  const input = {
    executionId: second.execution.id,
    threadId: session.activeThreadId,
    materializerVersion: 'context-builder/1',
    materializedContextHash: 'e'.repeat(64),
    sources: [
      { kind: 'compaction' as const, compactionId: artifact.id },
      ...suffix.map((item) => ({ kind: 'canonical_item' as const, itemId: item.id })),
    ],
  }
  const created = store.createExecutionContextManifest(input)
  assert.equal(created.duplicate, false)
  assert.deepEqual(created.manifest.entries.map((entry) => entry.kind), ['compaction', 'canonical_item'])
  assert.equal(store.createExecutionContextManifest(input).duplicate, true)
  assert.throws(() => store.createExecutionContextManifest({
    ...input,
    materializedContextHash: 'f'.repeat(64),
  }), (error: unknown) => error instanceof ContextPersistenceError && error.code === 'idempotency_conflict')
  store.finishTurn({ turnId: second.turn.id, status: 'cancelled' })
  store.close()

  const reopened = new SqliteSessionStore(path, deterministicOptions())
  t.after(() => reopened.close())
  assert.equal(reopened.getExecutionContextManifest(second.execution.id)?.manifestHash, created.manifest.manifestHash)
})

test('derived context append-only guards reject mutation and hashes detect forced tampering', (t) => {
  const path = databasePath(t)
  const store = new SqliteSessionStore(path, deterministicOptions())
  t.after(() => store.close())
  const session = store.createSession({})
  const turn = store.beginTurn(beginInput(session.activeThreadId))
  store.finishTurn({ turnId: turn.turn.id, status: 'completed' })
  const job = store.createContextCompactionJob({
    threadId: session.activeThreadId,
    requestKey: 'tamper-test',
    sourceItemIds: store.listItems(session.activeThreadId).map((item) => item.id),
    summaryInputHash: '1'.repeat(64),
    expectedPreviousArtifactId: null,
  }).job
  store.claimContextCompactionJob({ jobId: job.id, ownerId: 'worker' })
  const artifact = store.completeContextCompactionJob({
    jobId: job.id,
    ownerId: 'worker',
    summary: { text: 'trusted', summaryInput: { previousArtifactId: null } },
    generatorProvider: 'codex',
    generatorModel: 'gpt-test',
    generatorVersion: 'compactor/1',
  }).artifact

  const external = new DatabaseSync(path)
  t.after(() => external.close())
  assert.throws(
    () => external.prepare('UPDATE context_compactions SET summary_json=? WHERE id=?')
      .run('{"text":"changed"}', artifact.id),
    /append-only/,
  )
  assert.throws(
    () => external.prepare('DELETE FROM context_compaction_source_items WHERE compaction_id=?').run(artifact.id),
    /append-only/,
  )
  assert.throws(
    () => external.prepare('DELETE FROM context_compaction_jobs WHERE id=?').run(job.id),
    /durable/,
  )
  external.exec('DROP TRIGGER context_compactions_no_update')
  external.prepare('UPDATE context_compactions SET summary_json=? WHERE id=?').run('{"text":"tampered"}', artifact.id)
  assert.throws(
    () => store.getContextCompactionArtifact(artifact.id),
    (error: unknown) => error instanceof ContextPersistenceError && error.code === 'integrity_violation',
  )
  assert.deepEqual(store.listItems(session.activeThreadId).map((item) => item.payload), [{ text: 'hello' }])
})

test('expired compaction leases are durably reclaimed and terminal failure survives reopen', (t) => {
  const path = databasePath(t)
  let now = '2026-07-18T00:00:00.000Z'
  const store = new SqliteSessionStore(path, {
    ...deterministicOptions(),
    now: () => now,
  })
  const session = store.createSession({})
  const turn = store.beginTurn(beginInput(session.activeThreadId))
  store.finishTurn({ turnId: turn.turn.id, status: 'completed' })
  const job = store.createContextCompactionJob({
    threadId: session.activeThreadId,
    requestKey: 'lease-recovery',
    sourceItemIds: store.listItems(session.activeThreadId).map((item) => item.id),
    summaryInputHash: '2'.repeat(64),
    expectedPreviousArtifactId: null,
  }).job
  assert.equal(store.claimContextCompactionJob({
    jobId: job.id,
    ownerId: 'dead-worker',
    leaseDurationMs: 1_000,
  })?.attemptCount, 1)
  now = '2026-07-18T00:00:02.000Z'
  const reclaimed = store.claimContextCompactionJob({
    jobId: job.id,
    ownerId: 'recovery-worker',
    leaseDurationMs: 1_000,
  })
  assert.equal(reclaimed?.attemptCount, 2)
  assert.equal(reclaimed?.leaseOwner, 'recovery-worker')
  const failed = store.failContextCompactionJob({
    jobId: job.id,
    ownerId: 'recovery-worker',
    error: { code: 'generator_unavailable', retryable: true },
  })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.revision, 5)
  store.close()

  const reopened = new SqliteSessionStore(path, { now: () => now })
  t.after(() => reopened.close())
  assert.deepEqual(reopened.getContextCompactionJob(job.id)?.error, {
    code: 'generator_unavailable',
    retryable: true,
  })
  assert.equal(reopened.claimContextCompactionJob({ jobId: job.id, ownerId: 'late-worker' }), null)
  const inspected = new DatabaseSync(path, { readOnly: true })
  t.after(() => inspected.close())
  assert.deepEqual(
    (inspected.prepare(`
      SELECT status FROM context_compaction_job_events WHERE job_id=? ORDER BY sequence
    `).all(job.id) as Array<{ status: string }>).map((row) => row.status),
    ['queued', 'running', 'queued', 'running', 'failed'],
  )
})

test('the current compaction owner heartbeats a long provider generation lease', (t) => {
  const path = databasePath(t)
  let now = '2026-07-18T00:00:00.000Z'
  const store = new SqliteSessionStore(path, { ...deterministicOptions(), now: () => now })
  t.after(() => store.close())
  const session = store.createSession({})
  const turn = store.beginTurn(beginInput(session.activeThreadId))
  store.finishTurn({ turnId: turn.turn.id, status: 'completed' })
  const job = store.createContextCompactionJob({
    threadId: session.activeThreadId,
    requestKey: 'heartbeat-lease',
    sourceItemIds: store.listItems(session.activeThreadId).map((item) => item.id),
    summaryInputHash: '3'.repeat(64),
    expectedPreviousArtifactId: null,
  }).job
  const claimed = store.claimContextCompactionJob({
    jobId: job.id, ownerId: 'summary-worker', leaseDurationMs: 1_000,
  })!
  now = '2026-07-18T00:00:00.500Z'
  const extended = store.claimContextCompactionJob({
    jobId: job.id, ownerId: 'summary-worker', leaseDurationMs: 1_000,
  })!
  assert.equal(extended.revision, claimed.revision + 1)
  assert.equal(extended.leaseExpiresAt, '2026-07-18T00:00:01.500Z')
  now = '2026-07-18T00:00:01.200Z'
  assert.equal(store.claimContextCompactionJob({
    jobId: job.id, ownerId: 'competing-worker', leaseDurationMs: 1_000,
  }), null)
  const inspected = new DatabaseSync(path, { readOnly: true })
  t.after(() => inspected.close())
  assert.deepEqual(
    (inspected.prepare(`
      SELECT status FROM context_compaction_job_events WHERE job_id=? ORDER BY sequence
    `).all(job.id) as Array<{ status: string }>).map((event) => event.status),
    ['queued', 'running', 'running'],
  )
})

test('trash purge removes derived context only inside the authorized retention transaction', (t) => {
  const path = databasePath(t)
  let now = '2026-06-01T00:00:00.000Z'
  const store = new SqliteSessionStore(path, {
    ...deterministicOptions(),
    now: () => now,
  })
  t.after(() => store.close())
  const session = store.createSession({})
  const first = store.beginTurn(beginInput(session.activeThreadId))
  store.finishTurn({ turnId: first.turn.id, status: 'completed' })
  const compactedItems = store.listItems(session.activeThreadId)
  const job = store.createContextCompactionJob({
    threadId: session.activeThreadId,
    requestKey: 'purge-derived',
    sourceItemIds: compactedItems.map((item) => item.id),
    summaryInputHash: '3'.repeat(64),
    expectedPreviousArtifactId: null,
  }).job
  store.claimContextCompactionJob({ jobId: job.id, ownerId: 'worker' })
  const artifact = store.completeContextCompactionJob({
    jobId: job.id,
    ownerId: 'worker',
    summary: { text: 'purge with session', summaryInput: { previousArtifactId: null } },
    generatorProvider: 'codex',
    generatorModel: 'gpt-test',
    generatorVersion: 'compactor/1',
  }).artifact
  const second = store.beginTurn({
    ...beginInput(session.activeThreadId, 'request-2', 'hash-2'),
    expectedRevision: 2,
  })
  const suffix = store.listItems(session.activeThreadId).slice(compactedItems.length)
  store.createExecutionContextManifest({
    executionId: second.execution.id,
    threadId: session.activeThreadId,
    materializerVersion: 'context-builder/1',
    materializedContextHash: '4'.repeat(64),
    sources: [
      { kind: 'compaction', compactionId: artifact.id },
      ...suffix.map((item) => ({ kind: 'canonical_item' as const, itemId: item.id })),
    ],
  })
  store.finishTurn({ turnId: second.turn.id, status: 'completed' })
  store.archiveSession(session.id)
  now = '2026-07-02T00:00:00.000Z'
  assert.equal(store.purgeExpiredSessions('2026-07-01T00:00:00.000Z'), 1)

  const inspected = new DatabaseSync(path, { readOnly: true })
  t.after(() => inspected.close())
  for (const table of [
    'context_compaction_jobs',
    'context_compaction_job_events',
    'context_compaction_heads',
    'context_compactions',
    'context_compaction_source_items',
    'execution_context_manifests',
    'execution_context_manifest_entries',
  ]) {
    assert.equal((inspected.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, 0, table)
  }
  assert.deepEqual(inspected.prepare('PRAGMA foreign_key_check').all(), [])
})

test('sessions move to trash, remain readable for restore, and reject new work while archived', (t) => {
  let now = '2026-07-18T00:00:00.000Z'
  const store = new SqliteSessionStore(databasePath(t), {
    ...deterministicOptions(),
    now: () => now,
  })
  t.after(() => store.close())
  const session = store.createSession({ title: 'Trash me' })
  const goal = store.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'do not schedule while trashed',
    provider: 'codex',
    model: 'gpt-test',
  })
  const lease = store.claimGoalLease({ goalId: goal.id, goalRevision: goal.revision, ownerId: 'scheduler' })
  assert.ok(lease)

  const archived = store.archiveSession(session.id)
  assert.equal(archived.archivedAt, now)
  assert.deepEqual(store.listSessions(), [])
  assert.deepEqual(store.listSessions('trash').map((candidate) => candidate.id), [session.id])
  assert.deepEqual(store.listActiveGoals(), [])
  assert.equal(store.heartbeatGoalLease({
    leaseId: lease.leaseId,
    goalId: goal.id,
    goalRevision: goal.revision,
    ownerId: 'scheduler',
  }), null)
  assert.equal(store.getSnapshot(session.activeThreadId)?.session.id, session.id)
  assert.throws(
    () => store.beginTurn(beginInput(session.activeThreadId)),
    (error: unknown) => error instanceof SessionStoreError && error.code === 'session_archived',
  )
  assert.throws(
    () => store.forkThread({ threadId: session.activeThreadId, forkItemId: null }),
    (error: unknown) => error instanceof SessionStoreError && error.code === 'session_archived',
  )

  now = '2026-07-19T00:00:00.000Z'
  const restored = store.restoreSession(session.id)
  assert.equal(restored.archivedAt, null)
  assert.deepEqual(store.listSessions().map((candidate) => candidate.id), [session.id])
  assert.deepEqual(store.listActiveGoals().map((candidate) => candidate.id), [goal.id])
  assert.equal(restored.updatedAt, session.updatedAt, 'trash lifecycle must not rewrite last conversation activity')
})

test('archiving an active session is rejected and does not interrupt its turn', (t) => {
  const store = new SqliteSessionStore(databasePath(t), deterministicOptions())
  t.after(() => store.close())
  const session = store.createSession({})
  const started = store.beginTurn(beginInput(session.activeThreadId))
  assert.throws(
    () => store.archiveSession(session.id),
    (error: unknown) => error instanceof SessionStoreError && error.code === 'session_busy',
  )
  assert.equal(store.getTurn(started.turn.id)?.status, 'running')
  assert.equal(store.getSession(session.id)?.archivedAt, null)
})

test('workspace mutation uses thread CAS, invalidates bindings, and blocks active Goals', (t) => {
  const store = new SqliteSessionStore(databasePath(t), deterministicOptions())
  t.after(() => store.close())
  const session = store.createSession({})
  store.upsertProviderBinding({
    threadId: session.activeThreadId,
    provider: 'codex',
    modelFamily: 'gpt-test',
    nativeThreadId: 'native-thread',
    nativeResponseId: null,
    opaqueStateEncrypted: null,
    capabilities,
    syncedRevision: 0,
    contextDigest: 'context-0',
  })

  const connected = store.updateWorkspace({
    sessionId: session.id,
    expectedThreadRevision: 0,
    cwd: 'C:\\verified',
  })
  assert.equal(connected.cwd, 'C:\\verified')
  assert.equal(store.getThread(session.activeThreadId)?.revision, 1)
  assert.deepEqual(store.getSnapshot(session.activeThreadId)?.bindings, [])
  assert.deepEqual(store.listEvents(session.activeThreadId).at(-1)?.payload, {
    connected: true,
    previousConnected: false,
    revision: 1,
  })
  assert.throws(
    () => store.updateWorkspace({ sessionId: session.id, expectedThreadRevision: 0, cwd: null }),
    (error: unknown) => error instanceof SessionStoreError && error.code === 'revision_conflict',
  )

  const goal = store.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'keep workspace stable',
    provider: 'codex',
    model: 'gpt-test',
  })
  assert.throws(
    () => store.updateWorkspace({ sessionId: session.id, expectedThreadRevision: 1, cwd: null }),
    (error: unknown) => error instanceof SessionStoreError && error.code === 'session_busy',
  )
  store.updateGoalStatus({
    goalId: goal.id,
    expectedRevision: goal.revision,
    status: 'paused',
    reason: { code: 'user_paused', source: 'user', message: null, at: '2026-07-18T00:00:00.000Z' },
  })
  assert.equal(store.updateWorkspace({
    sessionId: session.id,
    expectedThreadRevision: 1,
    cwd: null,
  }).cwd, null)
  assert.equal(store.getThread(session.activeThreadId)?.revision, 2)
})

test('LDPlayer capability is exact, revision-CAS guarded, and revocable only while idle', (t) => {
  const store = new SqliteSessionStore(databasePath(t), deterministicOptions())
  t.after(() => store.close())
  const session = store.createSession({})
  const grant = {
    kind: 'ldplayer' as const,
    installationRoot: 'C:\\LDPlayer\\LDPlayer9',
    instanceIndex: 14,
    instanceName: 'Audit-LD9-Fresh',
  }
  const connected = store.updateLdPlayerGrant({
    sessionId: session.id,
    expectedThreadRevision: 0,
    grant,
  })
  assert.deepEqual(connected.ldPlayer, grant)
  assert.equal(store.getThread(session.activeThreadId)?.revision, 1)
  assert.deepEqual(store.listEvents(session.activeThreadId).at(-1)?.payload, {
    capability: 'ldplayer', connected: true, previousConnected: false, revision: 1,
  })
  assert.throws(
    () => store.updateLdPlayerGrant({ sessionId: session.id, expectedThreadRevision: 0, grant: null }),
    (error: unknown) => error instanceof SessionStoreError && error.code === 'revision_conflict',
  )
  const started = store.beginTurn({ ...beginInput(session.activeThreadId), expectedRevision: 1 })
  const activeRevision = store.getThread(session.activeThreadId)?.revision ?? -1
  assert.throws(
    () => store.updateLdPlayerGrant({ sessionId: session.id, expectedThreadRevision: activeRevision, grant: null }),
    (error: unknown) => error instanceof SessionStoreError && error.code === 'session_busy',
  )
  store.finishTurn({ turnId: started.turn.id, status: 'completed' })
  const disconnected = store.updateLdPlayerGrant({
    sessionId: session.id,
    expectedThreadRevision: store.getThread(session.activeThreadId)?.revision ?? -1,
    grant: null,
  })
  assert.equal(disconnected.ldPlayer, null)
})

test('native cwd remains a suggestion and refresh never overwrites the authorized workspace', (t) => {
  const store = new SqliteSessionStore(databasePath(t), deterministicOptions())
  t.after(() => store.close())
  const first = nativeCandidate(['one'], 'C:\\source-old', 'content-1')
  const imported = store.commitNativeImport({ candidate: first, previewedState: null })
  assert.equal(imported.status, 'imported')
  assert.ok(imported.sessionId)
  const importedSession = store.getSession(imported.sessionId)
  assert.equal(importedSession?.cwd, null)
  assert.equal(importedSession?.source?.cwd, 'C:\\source-old')

  store.updateWorkspace({
    sessionId: imported.sessionId,
    expectedThreadRevision: 0,
    cwd: 'C:\\authorized',
  })
  const previewedState = store.getNativeImportState(first)
  assert.ok(previewedState)
  const refreshed = store.commitNativeImport({
    candidate: nativeCandidate(['one', 'two'], 'C:\\source-new', 'content-2'),
    previewedState,
  })
  assert.equal(refreshed.status, 'updated')
  assert.equal(store.getSession(imported.sessionId)?.cwd, 'C:\\authorized')
  assert.equal(store.getSession(imported.sessionId)?.source?.cwd, 'C:\\source-new')
})

test('expired trash purge is batched, scoped, and preserves append-only guards', (t) => {
  const path = databasePath(t)
  let now = '2026-05-01T00:00:00.000Z'
  const store = new SqliteSessionStore(path, {
    ...deterministicOptions(),
    now: () => now,
  })
  t.after(() => store.close())

  const expired = store.createSession({ title: 'Expired' })
  store.createGoal({
    threadId: expired.activeThreadId,
    expected: { kind: 'none' },
    objective: 'retained until trash expiry',
    provider: 'codex',
    model: 'gpt-test',
  })
  const expiredTurn = store.beginTurn(beginInput(expired.activeThreadId))
  store.appendProviderEvent({
    turnId: expiredTurn.turn.id,
    eventId: 'reply',
    items: [{ kind: 'assistant_message', payload: { text: 'answer' } }],
  })
  store.finishTurn({ turnId: expiredTurn.turn.id, status: 'completed' })
  store.archiveSession(expired.id)

  now = '2026-07-18T00:00:00.000Z'
  const recent = store.createSession({ title: 'Recent trash' })
  store.archiveSession(recent.id)
  const active = store.createSession({ title: 'Active' })

  const external = new DatabaseSync(path)
  t.after(() => external.close())
  assert.throws(
    () => external.prepare('DELETE FROM items WHERE session_id = ?').run(expired.id),
    /append-only/,
  )

  assert.equal(store.purgeExpiredSessions('2026-06-01T00:00:00.000Z', 100), 1)
  assert.equal(store.getSession(expired.id), null)
  assert.equal((external.prepare('SELECT COUNT(*) AS count FROM goal_events WHERE session_id=?')
    .get(expired.id) as { count: number }).count, 0)
  assert.ok(store.getSession(recent.id))
  assert.ok(store.getSession(active.id))
  assert.deepEqual(store.listSessions('trash').map((candidate) => candidate.id), [recent.id])
  assert.equal(store.purgeExpiredSessions('2026-06-01T00:00:00.000Z', 100), 0)
  assert.throws(
    () => external.prepare('DELETE FROM stream_events WHERE session_id = ?').run(active.id),
    /append-only/,
  )
})

test('create, append, finish, and replay are stable after reopening the database', (t) => {
  const path = databasePath(t)
  const options = deterministicOptions()
  const store = new SqliteSessionStore(path, options)
  const session = store.createSession({ title: 'Canonical session', instructionSnapshot: { z: 1, a: true } })
  const started = store.beginTurn(beginInput(session.activeThreadId))
  assert.equal(started.turn.effort, 'high')
  const appended = store.appendProviderEvent({
    turnId: started.turn.id,
    eventId: 'native-event-1',
    items: [{ kind: 'assistant_message', payload: { text: 'world' }, nativeId: 'native-item-1' }],
  })
  store.finishTurn({ turnId: started.turn.id, status: 'completed', usage: { output: 1, input: 2 } })

  assert.equal(started.initialItems[0]?.sequence, 1)
  assert.equal(appended[0]?.sequence, 2)
  const before = JSON.stringify({
    snapshot: store.getSnapshot(session.activeThreadId),
    events: store.listEvents(session.activeThreadId),
  })
  store.close()

  const reopened = new SqliteSessionStore(path, options)
  t.after(() => reopened.close())
  const after = JSON.stringify({
    snapshot: reopened.getSnapshot(session.activeThreadId),
    events: reopened.listEvents(session.activeThreadId),
  })
  assert.equal(after, before)
  assert.deepEqual(reopened.listEvents(session.activeThreadId).map((event) => event.type), [
    'session_created',
    'turn_started',
    'items_appended',
    'turn_completed',
  ])
})

test('Goal projection survives reopen and create/edit use revision CAS', (t) => {
  const path = databasePath(t)
  const options = deterministicOptions()
  const first = new SqliteSessionStore(path, options)
  const session = first.createSession({ title: 'Persistent Goal' })
  const created = first.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'Finish the requested implementation',
    provider: 'codex',
    model: 'gpt-test',
  })
  assert.equal(created.revision, 1)
  assert.equal(created.maxAutomaticTurns, 24)
  assert.equal(created.maxActiveSeconds, 7_200)
  first.close()

  const reopened = new SqliteSessionStore(path, options)
  t.after(() => reopened.close())
  assert.deepEqual(reopened.getGoal(session.activeThreadId), created)
  assert.throws(
    () => reopened.editGoal({ goalId: created.id, expectedRevision: 0, objective: 'stale' }),
    (error: unknown) => error instanceof GoalStoreError && error.code === 'stale_goal_revision',
  )
  const edited = reopened.editGoal({
    goalId: created.id,
    expectedRevision: created.revision,
    objective: 'Finish and verify every requested item',
    provider: 'claude',
    model: 'claude-test',
  })
  assert.equal(edited.id, created.id)
  assert.equal(edited.revision, 2)
  assert.equal(edited.provider, 'claude')
  assert.equal(edited.objective, 'Finish and verify every requested item')
  assert.throws(
    () => reopened.createGoal({
      threadId: session.activeThreadId,
      expected: { kind: 'goal', goalId: edited.id, revision: edited.revision },
      objective: 'another',
      provider: 'codex',
      model: 'gpt-test',
    }),
    (error: unknown) => error instanceof GoalStoreError && error.code === 'unfinished_goal_exists',
  )
  const replacement = reopened.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'goal', goalId: edited.id, revision: edited.revision },
    objective: 'confirmed replacement',
    provider: 'codex',
    model: 'gpt-test',
    replaceExisting: true,
  })
  assert.notEqual(replacement.id, edited.id)
  assert.equal(replacement.revision, 1)
  assert.deepEqual(reopened.listActiveGoals().map((goal) => goal.id), [replacement.id])
  assert.deepEqual(reopened.listGoalEvents(session.activeThreadId).map((event) => event.type), [
    'goal_created',
    'goal_edited',
    'goal_replaced',
    'goal_created',
  ])
})

test('Goal status transitions are deterministic and stopped states require explicit resume', (t) => {
  const store = new SqliteSessionStore(databasePath(t), deterministicOptions())
  t.after(() => store.close())
  const session = store.createSession({})
  const created = store.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'complete the task',
    provider: 'codex',
    model: 'gpt-test',
  })
  const pausedResult = store.updateGoalStatus({
    goalId: created.id,
    expectedRevision: created.revision,
    status: 'paused',
    reason: { code: 'user_paused', source: 'user', message: null, at: '2026-07-18T00:00:01.000Z' },
  })
  assert.equal(pausedResult.status, 'applied')
  const paused = pausedResult.goal
  assert.ok(paused)
  assert.equal(paused.status, 'paused')
  assert.throws(
    () => store.updateGoalStatus({
      goalId: paused.id,
      expectedRevision: paused.revision,
      status: 'paused',
      reason: { code: 'again', source: 'user', message: null, at: '2026-07-18T00:00:02.000Z' },
    }),
    (error: unknown) => error instanceof GoalStoreError && error.code === 'invalid_goal_transition',
  )
  const resumedResult = store.updateGoalStatus({
    goalId: paused.id,
    expectedRevision: paused.revision,
    status: 'active',
  })
  assert.equal(resumedResult.status, 'applied')
  assert.equal(resumedResult.goal?.statusReason, null)
  const completedResult = store.updateGoalStatus({
    goalId: created.id,
    expectedRevision: resumedResult.goal?.revision ?? -1,
    status: 'complete',
  })
  assert.equal(completedResult.goal?.status, 'complete')
  assert.ok(completedResult.goal?.completedAt)
  const reactivated = store.editGoal({
    goalId: created.id,
    expectedRevision: completedResult.goal?.revision ?? -1,
    objective: 'complete the expanded task',
  })
  assert.equal(reactivated.status, 'active')
  assert.equal(reactivated.completedAt, null)
  assert.equal(store.updateGoalStatus({
    goalId: created.id,
    expectedRevision: 1,
    status: 'complete',
  }).status, 'stale')
  const budgeted = store.editGoal({
    goalId: reactivated.id,
    expectedRevision: reactivated.revision,
    tokenBudget: 10,
  })
  const limited = store.updateGoalStatus({
    goalId: budgeted.id,
    expectedRevision: budgeted.revision,
    status: 'budget_limited',
    reason: { code: 'goal_token_limit', source: 'host', message: null, at: '2026-07-18T00:00:03.000Z' },
  }).goal
  assert.ok(limited)
  assert.throws(
    () => store.updateGoalStatus({
      goalId: limited.id,
      expectedRevision: limited.revision,
      status: 'active',
      resetLimitCounters: true,
    }),
    (error: unknown) => error instanceof GoalStoreError && error.code === 'invalid_goal_transition',
  )
  assert.equal(store.editGoal({
    goalId: limited.id,
    expectedRevision: limited.revision,
    tokenBudget: 20,
  }).status, 'active')
})

test('Goal projection mutations append objective-free durable SSE cursors', (t) => {
  const store = new SqliteSessionStore(databasePath(t), deterministicOptions())
  t.after(() => store.close())
  const session = store.createSession({})
  const goal = store.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'do not expose this objective in SSE',
    provider: 'codex',
    model: 'gpt-test',
  })
  const edited = store.editGoal({
    goalId: goal.id,
    expectedRevision: goal.revision,
    objective: 'still private from SSE',
  })
  const paused = store.updateGoalStatus({
    goalId: goal.id,
    expectedRevision: edited.revision,
    status: 'paused',
    reason: { code: 'user_paused', source: 'user', message: null, at: '' },
  }).goal
  assert.ok(paused)
  const resumed = store.updateGoalStatus({
    goalId: goal.id,
    expectedRevision: paused.revision,
    status: 'active',
  }).goal
  assert.ok(resumed)
  const started = store.beginTurn(beginInput(session.activeThreadId))
  store.checkpointGoalTurn({
    turnId: started.turn.id,
    goalId: resumed.id,
    goalRevision: resumed.revision,
    tokensUsed: 2,
    timeUsedSeconds: 1,
  })
  store.finishTurn({ turnId: started.turn.id, status: 'completed' })
  store.recordGoalTurn({
    turnId: started.turn.id,
    goalId: resumed.id,
    goalRevision: resumed.revision,
    tokensUsed: 2,
    timeUsedSeconds: 1,
    automatic: false,
    progressDigest: null,
  })
  store.clearGoal({ goalId: resumed.id, expectedRevision: resumed.revision })

  const events = store.listEvents(session.activeThreadId).filter((event) => event.type === 'goal_changed')
  assert.deepEqual(events.map((event) => event.payload), [
    { goalId: goal.id, revision: 1, status: 'active' },
    { goalId: goal.id, revision: 2, status: 'active' },
    { goalId: goal.id, revision: 3, status: 'paused' },
    { goalId: goal.id, revision: 4, status: 'active' },
    { goalId: goal.id, revision: 4, status: 'active' },
    { goalId: goal.id, revision: 4, status: 'active' },
    { goalId: goal.id, revision: 4, status: 'cleared' },
  ])
  assert.ok(events.every((event, index) => index === 0 || event.sequence > events[index - 1]!.sequence))
  assert.ok(events.every((event) => !('objective' in event.payload)))
})

test('a lease-side Goal time limit records the exhausted active-time boundary', (t) => {
  const store = new SqliteSessionStore(databasePath(t), deterministicOptions())
  t.after(() => store.close())
  const session = store.createSession({})
  const goal = store.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'bound readiness time',
    provider: 'codex',
    model: 'gpt-test',
    maxActiveSeconds: 5,
  })
  const limited = store.updateGoalStatus({
    goalId: goal.id,
    expectedRevision: goal.revision,
    status: 'budget_limited',
    reason: { code: 'goal_time_limit', source: 'host', message: null, at: '' },
  }).goal
  assert.equal(limited?.timeUsedSeconds, 5)
})

test('Goal scheduler lease is exclusive, heartbeats, expires, and is consumed with the turn link', (t) => {
  let now = '2026-07-18T00:00:00.000Z'
  let id = 0
  const path = databasePath(t)
  const store = new SqliteSessionStore(path, {
    idFactory: () => `goal-id-${++id}`,
    now: () => now,
  })
  t.after(() => store.close())
  const session = store.createSession({})
  const goal = store.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'lease test',
    provider: 'codex',
    model: 'gpt-test',
  })
  const first = store.claimGoalLease({ goalId: goal.id, goalRevision: goal.revision, ownerId: 'owner-a' })
  assert.ok(first)
  assert.equal(store.claimGoalLease({ goalId: goal.id, goalRevision: goal.revision, ownerId: 'owner-b' }), null)
  now = '2026-07-18T00:00:10.000Z'
  const heartbeat = store.heartbeatGoalLease({
    leaseId: first.leaseId,
    goalId: goal.id,
    goalRevision: goal.revision,
    ownerId: 'owner-a',
  })
  assert.equal(heartbeat?.expiresAt, '2026-07-18T00:00:40.000Z')
  now = '2026-07-18T00:00:41.000Z'
  const reclaimed = store.claimGoalLease({ goalId: goal.id, goalRevision: goal.revision, ownerId: 'owner-b' })
  assert.ok(reclaimed)
  assert.notEqual(reclaimed.leaseId, first.leaseId)

  now = '2026-07-18T00:00:46.000Z'
  const linked = store.beginTurn({
    ...beginInput(session.activeThreadId),
    goalContext: { goalId: goal.id, goalRevision: goal.revision, leaseId: reclaimed.leaseId },
  } as BeginTurnInput & { goalContext: { goalId: string; goalRevision: number; leaseId: string } })
  assert.equal(store.releaseGoalLease({
    leaseId: reclaimed.leaseId,
    goalId: goal.id,
    goalRevision: goal.revision,
    ownerId: 'owner-b',
  }), false)
  assert.equal(store.claimGoalLease({ goalId: goal.id, goalRevision: goal.revision, ownerId: 'owner-c' }), null)
  const inspected = new DatabaseSync(path, { readOnly: true })
  t.after(() => inspected.close())
  const turnRow = inspected.prepare('SELECT goal_id,goal_revision FROM turns WHERE id=?').get(linked.turn.id) as {
    goal_id: string
    goal_revision: number
  }
  assert.equal(turnRow.goal_id, goal.id)
  assert.equal(turnRow.goal_revision, goal.revision)
  assert.equal(store.getGoalById(goal.id)?.timeUsedSeconds, 5)
})

test('ordinary turns capture only an active Goal', (t) => {
  let id = 0
  const store = new SqliteSessionStore(databasePath(t), {
    idFactory: () => `active-goal-id-${++id}`,
  })
  t.after(() => store.close())
  const session = store.createSession({})
  const goal = store.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'capture only while active',
    provider: 'codex',
    model: 'gpt-test',
  })

  const activeTurn = store.beginTurn(beginInput(session.activeThreadId))
  assert.equal(activeTurn.turn.goalId, goal.id)
  assert.equal(activeTurn.turn.goalRevision, goal.revision)
  store.finishTurn({ turnId: activeTurn.turn.id, status: 'completed' })

  const paused = store.updateGoalStatus({
    goalId: goal.id,
    expectedRevision: goal.revision,
    status: 'paused',
    reason: { code: 'user_paused', source: 'user', message: 'paused by user', at: '2026-07-18T00:00:00.000Z' },
  })
  assert.equal(paused.status, 'applied')
  assert.equal(paused.goal?.status, 'paused')
  const ordinaryTurn = store.beginTurn({
    ...beginInput(session.activeThreadId, 'request-2', 'hash-2'),
    expectedRevision: store.getThread(session.activeThreadId)?.revision ?? -1,
  })
  assert.equal(ordinaryTurn.turn.goalId, null)
  assert.equal(ordinaryTurn.turn.goalRevision, null)
})

test('stale Goal turn completion cannot mutate a newer revision and accounting is replay-safe', (t) => {
  let now = '2026-07-18T00:00:00.000Z'
  let id = 0
  const store = new SqliteSessionStore(databasePath(t), {
    idFactory: () => `account-id-${++id}`,
    now: () => now,
  })
  t.after(() => store.close())
  const session = store.createSession({})
  const goal = store.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'account every turn once',
    provider: 'codex',
    model: 'gpt-test',
  })
  const lease = store.claimGoalLease({ goalId: goal.id, goalRevision: 1, ownerId: 'scheduler' })
  assert.ok(lease)
  const started = store.beginTurn({
    ...beginInput(session.activeThreadId),
    goalContext: { goalId: goal.id, goalRevision: 1, leaseId: lease.leaseId },
  } as BeginTurnInput & { goalContext: { goalId: string; goalRevision: number; leaseId: string } })
  const checkpoint = {
    turnId: started.turn.id,
    goalId: goal.id,
    goalRevision: 1,
    tokensUsed: 5,
    timeUsedSeconds: 1,
    progressDigest: 'partial-a',
  }
  assert.equal(store.checkpointGoalTurn(checkpoint).goal?.tokensUsed, 5)
  assert.equal(store.checkpointGoalTurn(checkpoint).goal?.tokensUsed, 5, 'checkpoint replay must add no delta')
  const edited = store.editGoal({ goalId: goal.id, expectedRevision: 1, objective: 'newer objective' })
  store.finishTurn({ turnId: started.turn.id, status: 'completed' })
  assert.equal(store.recordGoalTurn({
    turnId: started.turn.id,
    goalId: goal.id,
    goalRevision: 1,
    tokensUsed: 10,
    timeUsedSeconds: 2,
    automatic: true,
    progressDigest: 'digest-a',
  }).status, 'stale')
  assert.equal(store.getGoal(session.activeThreadId)?.tokensUsed, 5)

  now = '2026-07-18T00:01:00.000Z'
  const secondLease = store.claimGoalLease({ goalId: goal.id, goalRevision: edited.revision, ownerId: 'scheduler' })
  assert.ok(secondLease)
  const second = store.beginTurn({
    ...beginInput(
      session.activeThreadId,
      'request-2',
      'hash-2',
    ),
    expectedRevision: store.getThread(session.activeThreadId)?.revision ?? -1,
    goalContext: { goalId: goal.id, goalRevision: edited.revision, leaseId: secondLease.leaseId },
  } as BeginTurnInput & { goalContext: { goalId: string; goalRevision: number; leaseId: string } })
  store.finishTurn({ turnId: second.turn.id, status: 'completed' })
  assert.equal(store.claimGoalLease({
    goalId: goal.id,
    goalRevision: edited.revision,
    ownerId: 'early-scheduler',
  }), null, 'the next turn must wait for terminal accounting')
  const accounting = {
    turnId: second.turn.id,
    goalId: goal.id,
    goalRevision: edited.revision,
    tokensUsed: 12,
    timeUsedSeconds: 3,
    automatic: true,
    progressDigest: 'digest-a',
  }
  const accounted = store.recordGoalTurn(accounting)
  assert.equal(accounted.status, 'applied')
  assert.equal(accounted.goal?.tokensUsed, 17)
  assert.equal(accounted.goal?.timeUsedSeconds, 4)
  assert.equal(accounted.goal?.automaticTurnsUsed, 1)
  assert.equal(accounted.goal?.noProgressCount, 0)
  assert.deepEqual(store.recordGoalTurn(accounting), accounted)

  now = '2026-07-18T00:02:00.000Z'
  const thirdLease = store.claimGoalLease({ goalId: goal.id, goalRevision: edited.revision, ownerId: 'scheduler' })
  assert.ok(thirdLease)
  const third = store.beginTurn({
    ...beginInput(session.activeThreadId, 'request-3', 'hash-3'),
    expectedRevision: store.getThread(session.activeThreadId)?.revision ?? -1,
    goalContext: { goalId: goal.id, goalRevision: edited.revision, leaseId: thirdLease.leaseId },
  } as BeginTurnInput & { goalContext: { goalId: string; goalRevision: number; leaseId: string } })
  store.finishTurn({ turnId: third.turn.id, status: 'completed' })
  const repeated = store.recordGoalTurn({
    ...accounting,
    turnId: third.turn.id,
    tokensUsed: 4,
    timeUsedSeconds: 1,
  })
  assert.equal(repeated.goal?.tokensUsed, 21)
  assert.equal(repeated.goal?.automaticTurnsUsed, 2)
  assert.equal(repeated.goal?.noProgressCount, 1)
})

test('clearing a Goal revokes its lease and retains an append-only clear event', (t) => {
  const path = databasePath(t)
  const store = new SqliteSessionStore(path, deterministicOptions())
  t.after(() => store.close())
  const session = store.createSession({})
  const goal = store.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'clear safely',
    provider: 'claude',
    model: 'claude-test',
  })
  const lease = store.claimGoalLease({ goalId: goal.id, goalRevision: goal.revision, ownerId: 'scheduler' })
  assert.ok(lease)
  store.clearGoal({ goalId: goal.id, expectedRevision: goal.revision })
  assert.equal(store.getGoal(session.activeThreadId), null)
  assert.equal(store.heartbeatGoalLease({
    leaseId: lease.leaseId,
    goalId: goal.id,
    goalRevision: goal.revision,
    ownerId: 'scheduler',
  }), null)
  assert.equal(store.listGoalEvents(session.activeThreadId).at(-1)?.type, 'goal_cleared')
  const inspected = new DatabaseSync(path)
  t.after(() => inspected.close())
  assert.throws(() => inspected.prepare('DELETE FROM goal_events').run(), /append-only/)
})

test('turn requests, provider events, and terminal updates are idempotent', (t) => {
  const store = new SqliteSessionStore(databasePath(t), deterministicOptions())
  t.after(() => store.close())
  const session = store.createSession({})
  const input = beginInput(session.activeThreadId)
  const first = store.beginTurn(input)
  const duplicate = store.beginTurn(input)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.turn.id, first.turn.id)
  assert.deepEqual(duplicate.initialItems, first.initialItems)
  assert.throws(
    () => store.beginTurn({ ...input, requestHash: 'different', expectedRevision: 1 }),
    (error: unknown) => error instanceof SessionStoreError && error.code === 'duplicate_request',
  )

  const event = {
    turnId: first.turn.id,
    eventId: 'event-1',
    items: [{ kind: 'assistant_message' as const, payload: { text: 'answer' } }],
  }
  const firstItems = store.appendProviderEvent(event)
  assert.deepEqual(store.appendProviderEvent(event), firstItems)
  assert.equal(store.listItems(session.activeThreadId).length, 2)

  const finished = store.finishTurn({ turnId: first.turn.id, status: 'completed', usage: { tokens: 3 } })
  assert.deepEqual(
    store.finishTurn({ turnId: first.turn.id, status: 'completed', usage: { tokens: 3 } }),
    finished,
  )
  assert.throws(
    () => store.finishTurn({ turnId: first.turn.id, status: 'failed', error: { message: 'late' } }),
    (error: unknown) => error instanceof SessionStoreError && error.code === 'turn_not_running',
  )
})

test('follow-up enqueue is idempotent, claims strict FIFO, and atomically appends accepted user messages', (t) => {
  const store = new SqliteSessionStore(databasePath(t), deterministicOptions())
  t.after(() => store.close())
  const session = store.createSession({ title: 'follow-up' })
  const started = store.beginTurn(beginInput(session.activeThreadId))
  const firstInput = {
    threadId: session.activeThreadId,
    clientRequestId: 'follow-up-1',
    requestHash: 'follow-up-hash-1',
    delivery: 'steer_or_queue' as const,
    targetTurnId: started.turn.id,
    scope: { kind: 'conversation' as const },
    input: [{ kind: 'user_message' as const, payload: { text: 'first follow-up' } }],
  }
  const first = store.enqueueFollowUp(firstInput)
  assert.equal(first.duplicate, false)
  assert.equal(store.enqueueFollowUp(firstInput).duplicate, true)
  assert.throws(
    () => store.enqueueFollowUp({ ...firstInput, requestHash: 'different-hash' }),
    (error: unknown) => error instanceof SessionStoreError && error.code === 'duplicate_request',
  )
  const second = store.enqueueFollowUp({
    ...firstInput,
    clientRequestId: 'follow-up-2',
    requestHash: 'follow-up-hash-2',
    input: [{ kind: 'user_message', payload: { text: 'second follow-up' } }],
  }).followUp
  assert.deepEqual(store.listFollowUps(session.activeThreadId).map((followUp) => followUp.sequence), [1, 2])

  const claimedFirst = store.claimFollowUp({
    threadId: session.activeThreadId,
    ownerId: 'dispatcher-a',
    purpose: 'steer',
    targetTurnId: started.turn.id,
  })
  assert.equal(claimedFirst?.id, first.followUp.id)
  assert.equal(store.claimFollowUp({
    threadId: session.activeThreadId,
    ownerId: 'dispatcher-b',
    purpose: 'steer',
    targetTurnId: started.turn.id,
  }), null, 'an in-flight head must block later sequence claims')
  const consumedFirst = store.consumeFollowUp({
    followUpId: first.followUp.id,
    ownerId: 'dispatcher-a',
    turnId: started.turn.id,
  })
  assert.equal(consumedFirst.status, 'consumed')
  assert.equal(consumedFirst.items.length, 1)
  assert.equal(consumedFirst.items[0]?.kind, 'user_message')
  assert.equal(consumedFirst.items[0]?.provider, null)
  assert.equal(consumedFirst.items[0]?.turnId, started.turn.id)
  assert.deepEqual(consumedFirst.items[0]?.payload, { text: 'first follow-up' })
  assert.deepEqual(store.consumeFollowUp({
    followUpId: first.followUp.id,
    ownerId: 'dispatcher-a',
    turnId: started.turn.id,
  }), consumedFirst, 'consume replay must return the same canonical items')

  const claimedSecond = store.claimFollowUp({
    threadId: session.activeThreadId,
    ownerId: 'dispatcher-b',
    purpose: 'steer',
    targetTurnId: started.turn.id,
  })
  assert.equal(claimedSecond?.id, second.id)
  const itemCountBefore = store.listItems(session.activeThreadId).length
  assert.throws(
    () => store.consumeFollowUp({ followUpId: second.id, ownerId: 'wrong-owner', turnId: started.turn.id }),
    (error: unknown) => error instanceof FollowUpStoreError && error.code === 'follow_up_lease_lost',
  )
  assert.equal(store.listItems(session.activeThreadId).length, itemCountBefore)
  assert.deepEqual(store.getSnapshot(session.activeThreadId)?.followUps?.map((followUp) => followUp.status), [
    'consumed',
    'dispatching',
  ])
})

test('follow-up closing and expired-lease recovery preserve FIFO intent for the next turn', (t) => {
  let now = '2026-07-18T00:00:00.000Z'
  const store = new SqliteSessionStore(databasePath(t), { ...deterministicOptions(), now: () => now })
  t.after(() => store.close())
  const session = store.createSession({ title: 'follow-up recovery' })
  const started = store.beginTurn(beginInput(session.activeThreadId))
  const enqueue = (number: number) => store.enqueueFollowUp({
    threadId: session.activeThreadId,
    clientRequestId: `follow-up-${number}`,
    requestHash: `follow-up-hash-${number}`,
    delivery: 'steer_or_queue',
    targetTurnId: started.turn.id,
    scope: { kind: 'conversation' },
    input: [{ kind: 'user_message', payload: { text: `follow-up ${number}` } }],
  }).followUp
  const first = enqueue(1)
  const second = enqueue(2)
  assert.equal(store.claimFollowUp({
    threadId: session.activeThreadId,
    ownerId: 'dispatcher',
    purpose: 'steer',
    targetTurnId: started.turn.id,
    leaseDurationMs: 1_000,
  })?.id, first.id)
  assert.deepEqual(store.closeFollowUpWindow(started.turn.id), { requeued: 1, inFlight: 1 })
  assert.equal(store.listFollowUps(session.activeThreadId)[1]?.targetTurnId, null)
  assert.equal(store.claimFollowUp({
    threadId: session.activeThreadId,
    ownerId: 'blocked-steer',
    purpose: 'steer',
    targetTurnId: started.turn.id,
  }), null)

  now = '2026-07-18T00:00:02.000Z'
  assert.equal(store.recoverExpiredFollowUpClaims(), 1)
  assert.deepEqual(store.listFollowUps(session.activeThreadId).map((followUp) => ({
    id: followUp.id,
    status: followUp.status,
    targetTurnId: followUp.targetTurnId,
  })), [
    { id: first.id, status: 'delivery_unknown', targetTurnId: null },
    { id: second.id, status: 'queued', targetTurnId: null },
  ])
  assert.equal(store.claimFollowUp({
    threadId: session.activeThreadId,
    ownerId: 'next-turn-dispatcher',
    purpose: 'next_turn',
  })?.id, second.id)
})

test('next-turn follow-ups reject the existing turn and survive lease recovery for a later turn', (t) => {
  let now = '2026-07-18T00:00:00.000Z'
  const store = new SqliteSessionStore(databasePath(t), { ...deterministicOptions(), now: () => now })
  t.after(() => store.close())
  const session = store.createSession({ title: 'next-turn boundary' })
  const existing = store.beginTurn(beginInput(session.activeThreadId, 'existing-turn', 'existing-hash'))
  const followUp = store.enqueueFollowUp({
    threadId: session.activeThreadId,
    clientRequestId: 'next-turn-follow-up',
    requestHash: 'next-turn-follow-up-hash',
    delivery: 'next_turn',
    targetTurnId: null,
    scope: { kind: 'conversation' },
    input: [{ kind: 'user_message', payload: { text: 'deliver only later' } }],
  }).followUp
  assert.equal(followUp.afterTurnSequence, existing.turn.sequence)

  assert.equal(store.claimFollowUp({
    threadId: session.activeThreadId,
    ownerId: 'wrong-turn-dispatcher',
    purpose: 'next_turn',
  })?.id, followUp.id)
  const itemCountBefore = store.listItems(session.activeThreadId).length
  const rejected = store.consumeFollowUp({
    followUpId: followUp.id,
    ownerId: 'wrong-turn-dispatcher',
    turnId: existing.turn.id,
  })
  assert.equal(rejected.status, 'queued')
  assert.equal(store.listItems(session.activeThreadId).length, itemCountBefore)

  store.finishTurn({ turnId: existing.turn.id, status: 'completed' })
  const later = store.beginTurn({
    ...beginInput(session.activeThreadId, 'later-turn', 'later-hash'),
    expectedRevision: store.getThread(session.activeThreadId)?.revision ?? -1,
  })
  assert.ok(later.turn.sequence > followUp.afterTurnSequence)
  assert.equal(store.claimFollowUp({
    threadId: session.activeThreadId,
    ownerId: 'crashed-dispatcher',
    purpose: 'next_turn',
    leaseDurationMs: 1_000,
  })?.id, followUp.id)

  assert.throws(() => store.beginTurnFromFollowUp({
    followUpId: followUp.id, ownerId: 'crashed-dispatcher', threadId: 'foreign-thread',
    provider: 'codex', model: 'gpt-test', effort: null, adapterVersion: 'test/1', policySnapshot: policy,
  }), (error: unknown) => error instanceof FollowUpStoreError && error.code === 'invalid_follow_up')

  now = '2026-07-18T00:00:02.000Z'
  assert.throws(() => store.beginTurnFromFollowUp({
    followUpId: followUp.id, ownerId: 'crashed-dispatcher', threadId: session.activeThreadId,
    provider: 'codex', model: 'gpt-test', effort: null, adapterVersion: 'test/1', policySnapshot: policy,
  }), (error: unknown) => error instanceof FollowUpStoreError && error.code === 'follow_up_lease_lost')
  assert.equal(store.recoverExpiredFollowUpClaims(), 1)
  assert.equal(store.claimFollowUp({
    threadId: session.activeThreadId,
    ownerId: 'recovered-dispatcher',
    purpose: 'next_turn',
  })?.id, followUp.id)
  const consumed = store.consumeFollowUp({
    followUpId: followUp.id,
    ownerId: 'recovered-dispatcher',
    turnId: later.turn.id,
  })
  assert.equal(consumed.status, 'consumed')
  assert.deepEqual(consumed.items.map((item) => item.payload), [{ text: 'deliver only later' }])
  assert.equal(consumed.followUp.consumedTurnId, later.turn.id)
})

test('follow-up cancellation CAS and delivery-unknown are terminal and replay-safe', (t) => {
  const store = new SqliteSessionStore(databasePath(t), deterministicOptions())
  t.after(() => store.close())
  const session = store.createSession({})
  const queued = store.enqueueFollowUp({
    threadId: session.activeThreadId, clientRequestId: 'cancel-me', requestHash: 'cancel-hash',
    delivery: 'next_turn', targetTurnId: null, scope: { kind: 'conversation' },
    input: [{ kind: 'user_message', payload: { text: 'cancel' } }],
  }).followUp
  assert.equal(store.cancelFollowUp(queued.id, queued.revision).status, 'cancelled')
  assert.throws(() => store.cancelFollowUp(queued.id, queued.revision),
    (error: unknown) => error instanceof SessionStoreError && error.code === 'revision_conflict')

  const active = store.beginTurn(beginInput(session.activeThreadId))
  const uncertain = store.enqueueFollowUp({
    threadId: session.activeThreadId, clientRequestId: 'unknown', requestHash: 'unknown-hash',
    delivery: 'steer_or_queue', targetTurnId: active.turn.id, scope: { kind: 'conversation' },
    input: [{ kind: 'user_message', payload: { text: 'maybe delivered' } }],
  }).followUp
  store.claimFollowUp({ threadId: session.activeThreadId, ownerId: 'pump', purpose: 'steer', targetTurnId: active.turn.id })
  assert.equal(store.markFollowUpDeliveryUnknown(uncertain.id, 'pump').status, 'delivery_unknown')
  assert.equal(store.claimFollowUp({ threadId: session.activeThreadId, ownerId: 'retry', purpose: 'steer', targetTurnId: active.turn.id }), null)
})

test('beginTurnFromFollowUp atomically consumes input and commits stale Goal observation', (t) => {
  const store = new SqliteSessionStore(databasePath(t), deterministicOptions())
  t.after(() => store.close())
  const session = store.createSession({})
  const existing = store.beginTurn(beginInput(session.activeThreadId))
  const next = store.enqueueFollowUp({
    threadId: session.activeThreadId, clientRequestId: 'next', requestHash: 'next-hash',
    delivery: 'next_turn', targetTurnId: null, scope: { kind: 'conversation' },
    input: [{ kind: 'user_message', payload: { text: 'atomic next' } }],
  }).followUp
  store.claimFollowUp({ threadId: session.activeThreadId, ownerId: 'next-owner', purpose: 'next_turn' })
  store.finishTurn({ turnId: existing.turn.id, status: 'completed' })
  const started = store.beginTurnFromFollowUp({
    followUpId: next.id, ownerId: 'next-owner', threadId: session.activeThreadId,
    provider: 'codex', model: 'gpt-test', effort: null, adapterVersion: 'test/1', policySnapshot: policy,
  })
  assert.equal(started.initialItems[0]?.payload.text, 'atomic next')
  assert.equal(store.listFollowUps(session.activeThreadId).find((item) => item.id === next.id)?.status, 'consumed')
  store.finishTurn({ turnId: started.turn.id, status: 'completed' })
  const goal = store.createGoal({
    threadId: session.activeThreadId, expected: { kind: 'none' }, objective: 'old', provider: 'codex', model: 'gpt-test',
  })
  const stale = store.enqueueFollowUp({
    threadId: session.activeThreadId, clientRequestId: 'stale-next', requestHash: 'stale-hash',
    delivery: 'next_turn', targetTurnId: null, scope: { kind: 'goal', goalId: goal.id, revision: goal.revision },
    input: [{ kind: 'user_message', payload: { text: 'old goal only' } }],
  }).followUp
  store.claimFollowUp({ threadId: session.activeThreadId, ownerId: 'stale-owner', purpose: 'next_turn' })
  store.editGoal({ goalId: goal.id, expectedRevision: goal.revision, objective: 'new' })
  assert.throws(() => store.beginTurnFromFollowUp({
    followUpId: stale.id, ownerId: 'stale-owner', threadId: session.activeThreadId,
    provider: 'codex', model: 'gpt-test', effort: null, adapterVersion: 'test/1', policySnapshot: policy,
  }), (error: unknown) => error instanceof GoalStoreError && error.code === 'stale_goal_revision')
  assert.equal(store.listFollowUps(session.activeThreadId).find((item) => item.id === stale.id)?.status, 'stale_goal')
})

test('Goal-scoped follow-ups become stale deterministically without appending unseen input', (t) => {
  const store = new SqliteSessionStore(databasePath(t), deterministicOptions())
  t.after(() => store.close())
  const session = store.createSession({ title: 'Goal follow-up' })
  const goal = store.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'original objective',
    provider: 'codex',
    model: 'gpt-test',
  })
  const started = store.beginTurn(beginInput(session.activeThreadId))
  const scoped = store.enqueueFollowUp({
    threadId: session.activeThreadId,
    clientRequestId: 'goal-follow-up',
    requestHash: 'goal-follow-up-hash',
    delivery: 'steer_or_queue',
    targetTurnId: started.turn.id,
    scope: { kind: 'goal', goalId: goal.id, revision: goal.revision },
    input: [{ kind: 'user_message', payload: { text: 'only for the observed Goal' } }],
  }).followUp
  assert.equal(store.claimFollowUp({
    threadId: session.activeThreadId,
    ownerId: 'goal-dispatcher',
    purpose: 'steer',
    targetTurnId: started.turn.id,
  })?.id, scoped.id)
  store.editGoal({ goalId: goal.id, expectedRevision: goal.revision, objective: 'replacement objective' })
  const itemCountBefore = store.listItems(session.activeThreadId).length
  const stale = store.consumeFollowUp({
    followUpId: scoped.id,
    ownerId: 'goal-dispatcher',
    turnId: started.turn.id,
  })
  assert.equal(stale.status, 'stale_goal')
  assert.deepEqual(stale.items, [])
  assert.equal(store.listItems(session.activeThreadId).length, itemCountBefore)

  const staleOnArrival = store.enqueueFollowUp({
    threadId: session.activeThreadId,
    clientRequestId: 'already-stale',
    requestHash: 'already-stale-hash',
    delivery: 'steer_or_queue',
    targetTurnId: started.turn.id,
    scope: { kind: 'goal', goalId: goal.id, revision: goal.revision },
    input: [{ kind: 'user_message', payload: { text: 'stale at enqueue' } }],
  }).followUp
  assert.equal(staleOnArrival.status, 'stale_goal')
  assert.equal(store.markStaleGoalFollowUps(session.activeThreadId), 0)
})

test('follow-up input rejects provider-private or provider-authored canonical records', (t) => {
  const store = new SqliteSessionStore(databasePath(t), deterministicOptions())
  t.after(() => store.close())
  const session = store.createSession({ title: 'follow-up validation' })
  assert.throws(() => store.enqueueFollowUp({
    threadId: session.activeThreadId,
    clientRequestId: 'invalid-follow-up',
    requestHash: 'invalid-follow-up-hash',
    delivery: 'next_turn',
    targetTurnId: null,
    scope: { kind: 'conversation' },
    input: [{ kind: 'assistant_message', visibility: 'provider_private', provider: 'codex', payload: { text: 'no' } }],
  }), (error: unknown) => error instanceof FollowUpStoreError && error.code === 'invalid_follow_up')
})

test('turn activity keeps turn, execution, and thread status synchronized and is idempotent', (t) => {
  const path = databasePath(t)
  const store = new SqliteSessionStore(path, deterministicOptions())
  t.after(() => store.close())
  const session = store.createSession({})
  assert.equal(session.workStatus, 'idle')
  const started = store.beginTurn(beginInput(session.activeThreadId))
  assert.equal(store.getSession(session.id)?.workStatus, 'running')
  assert.equal(store.setTurnActivity(started.turn.id, 'waiting_tool').status, 'waiting_tool')
  assert.equal(store.getSession(session.id)?.workStatus, 'waiting_tool')
  assert.equal(store.setTurnActivity(started.turn.id, 'waiting_tool').status, 'waiting_tool')
  assert.equal(store.getThread(session.activeThreadId)?.status, 'running')
  const inspected = new DatabaseSync(path, { readOnly: true })
  t.after(() => inspected.close())
  assert.equal((inspected.prepare('SELECT status FROM executions WHERE turn_id=?').get(started.turn.id) as {
    status: string
  }).status, 'waiting')
  assert.equal(store.setTurnActivity(started.turn.id, 'running').status, 'running')
  assert.equal((inspected.prepare('SELECT status FROM executions WHERE turn_id=?').get(started.turn.id) as {
    status: string
  }).status, 'running')
  store.finishTurn({ turnId: started.turn.id, status: 'completed' })
  assert.equal(store.getSession(session.id)?.workStatus, 'completed')
  assert.throws(
    () => store.setTurnActivity(started.turn.id, 'waiting_tool'),
    (error: unknown) => error instanceof SessionStoreError && error.code === 'turn_not_running',
  )
})

test('an active Goal is projected as queued instead of the previous terminal turn', (t) => {
  const store = new SqliteSessionStore(databasePath(t), deterministicOptions())
  t.after(() => store.close())
  const session = store.createSession({})
  const turn = store.beginTurn(beginInput(session.activeThreadId))
  store.finishTurn({ turnId: turn.turn.id, status: 'completed' })
  assert.equal(store.getSession(session.id)?.workStatus, 'completed')

  const goal = store.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'continue after the completed turn',
    provider: 'codex',
    model: 'gpt-test',
  })
  assert.equal(store.getSession(session.id)?.workStatus, 'queued')

  store.updateGoalStatus({
    goalId: goal.id,
    expectedRevision: goal.revision,
    status: 'blocked',
    reason: { code: 'context_input_too_large', source: 'host', message: null, at: '2026-07-20T00:00:00.000Z' },
  })
  assert.equal(store.getSession(session.id)?.workStatus, 'blocked')
})

test('fork replay stops at the exact inherited item and branches remain isolated', (t) => {
  const store = new SqliteSessionStore(databasePath(t), deterministicOptions())
  t.after(() => store.close())
  const session = store.createSession({})
  const rootId = session.activeThreadId
  const first = store.beginTurn(beginInput(rootId, 'root-1', 'hash-root-1'))
  const firstReply = store.appendProviderEvent({
    turnId: first.turn.id,
    eventId: 'reply-1',
    items: [{ kind: 'assistant_message', payload: { text: 'first' } }],
  })[0]
  assert.ok(firstReply)
  store.finishTurn({ turnId: first.turn.id, status: 'completed' })

  const second = store.beginTurn({ ...beginInput(rootId, 'root-2', 'hash-root-2'), expectedRevision: 2 })
  store.appendProviderEvent({
    turnId: second.turn.id,
    eventId: 'reply-2',
    items: [{ kind: 'assistant_message', payload: { text: 'second' } }],
  })
  store.finishTurn({ turnId: second.turn.id, status: 'completed' })

  const branch = store.forkThread({ threadId: rootId, forkItemId: firstReply.id })
  assert.deepEqual(store.listItems(branch.id).map((item) => (item.payload as { text: string }).text), ['hello', 'first'])
  const branchTurn = store.beginTurn({
    ...beginInput(branch.id, 'branch-1', 'hash-branch-1'),
    provider: 'claude',
    model: 'claude-test',
  })
  store.appendProviderEvent({
    turnId: branchTurn.turn.id,
    eventId: 'branch-reply',
    items: [{ kind: 'assistant_message', payload: { text: 'branch' } }],
  })
  store.finishTurn({ turnId: branchTurn.turn.id, status: 'completed' })

  assert.deepEqual(store.listItems(rootId).map((item) => (item.payload as { text: string }).text), [
    'hello', 'first', 'hello', 'second',
  ])
  assert.deepEqual(store.listItems(branch.id).map((item) => (item.payload as { text: string }).text), [
    'hello', 'first', 'hello', 'branch',
  ])
  const nested = store.forkThread({ threadId: branch.id, forkItemId: first.initialItems[0]?.id ?? null })
  assert.deepEqual(store.listItems(nested.id).map((item) => (item.payload as { text: string }).text), ['hello'])
})

test('a failure while serializing initial input rolls back the whole turn transaction', (t) => {
  const store = new SqliteSessionStore(databasePath(t), deterministicOptions())
  t.after(() => store.close())
  const session = store.createSession({})
  const invalid = beginInput(session.activeThreadId, 'retryable', 'invalid-hash')
  invalid.input = [{ kind: 'user_message', payload: { bad: undefined } }]
  assert.throws(() => store.beginTurn(invalid), /undefined/)
  assert.equal(store.getSnapshot(session.activeThreadId)?.turns.length, 0)
  assert.equal(store.listItems(session.activeThreadId).length, 0)
  assert.equal(store.getThread(session.activeThreadId)?.revision, 0)

  const valid = beginInput(session.activeThreadId, 'retryable', 'valid-hash')
  assert.equal(store.beginTurn(valid).duplicate, false)
})

test('startup recovery deterministically interrupts durable active turns once', (t) => {
  const path = databasePath(t)
  const options = deterministicOptions()
  const firstStore = new SqliteSessionStore(path, options)
  const session = firstStore.createSession({})
  const started = firstStore.beginTurn(beginInput(session.activeThreadId))
  const followUp = firstStore.enqueueFollowUp({
    threadId: session.activeThreadId,
    clientRequestId: 'recover-follow-up',
    requestHash: 'recover-follow-up-hash',
    delivery: 'steer_or_queue',
    targetTurnId: started.turn.id,
    scope: { kind: 'conversation' },
    input: [{ kind: 'user_message', payload: { text: 'do not lose me' } }],
  }).followUp
  assert.equal(firstStore.claimFollowUp({
    threadId: session.activeThreadId,
    ownerId: 'dead-runtime',
    purpose: 'steer',
    targetTurnId: started.turn.id,
  })?.id, followUp.id)
  firstStore.close()

  const recoveredStore = new SqliteSessionStore(path, options)
  t.after(() => recoveredStore.close())
  assert.equal(recoveredStore.recoverInterruptedTurns(), 1)
  assert.equal(recoveredStore.recoverInterruptedTurns(), 0)
  assert.equal(recoveredStore.getTurn(started.turn.id)?.status, 'interrupted')
  assert.equal(recoveredStore.getThread(session.activeThreadId)?.status, 'idle')
  assert.deepEqual(recoveredStore.listFollowUps(session.activeThreadId).map((candidate) => ({
    status: candidate.status,
    targetTurnId: candidate.targetTurnId,
    dispatchOwner: candidate.dispatchOwner,
  })), [{ status: 'delivery_unknown', targetTurnId: null, dispatchOwner: null }])
  assert.equal(recoveredStore.claimFollowUp({
    threadId: session.activeThreadId,
    ownerId: 'replacement-runtime',
    purpose: 'next_turn',
  }), null)
  assert.equal(
    recoveredStore.listEvents(session.activeThreadId).filter((event) => event.type === 'turn_interrupted').length,
    1,
  )
})

test('startup recovery blocks the exact active Goal revision owned by an interrupted turn', (t) => {
  const path = databasePath(t)
  let now = '2026-07-18T00:00:00.000Z'
  let id = 0
  const options = { idFactory: () => `recover-id-${++id}`, now: () => now }
  const firstStore = new SqliteSessionStore(path, options)
  const session = firstStore.createSession({})
  const goal = firstStore.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'recover without silent continuation',
    provider: 'codex',
    model: 'gpt-test',
  })
  const lease = firstStore.claimGoalLease({ goalId: goal.id, goalRevision: goal.revision, ownerId: 'scheduler' })
  assert.ok(lease)
  firstStore.beginTurn({
    ...beginInput(session.activeThreadId),
    budget: { goalAutomatic: true },
    goalContext: { goalId: goal.id, goalRevision: goal.revision, leaseId: lease.leaseId },
  } as BeginTurnInput & { goalContext: { goalId: string; goalRevision: number; leaseId: string } })
  firstStore.close()

  now = '2026-07-18T00:01:00.000Z'
  const recovered = new SqliteSessionStore(path, options)
  t.after(() => recovered.close())
  assert.equal(recovered.recoverInterruptedTurns(), 1)
  const blocked = recovered.getGoal(session.activeThreadId)
  assert.equal(blocked?.status, 'blocked')
  assert.equal(blocked?.revision, goal.revision + 1)
  assert.equal(blocked?.statusReason?.code, 'runtime_interrupted')
  assert.equal(blocked?.automaticTurnsUsed, 1)
  assert.equal(recovered.listActiveGoals().length, 0)
  assert.equal(recovered.recoverInterruptedTurns(), 0)
  assert.equal(recovered.listGoalEvents(session.activeThreadId).filter((event) => event.type === 'goal_blocked').length, 1)
})

test('startup recovery reports an unresolved mutating tool as an unknown outcome', (t) => {
  const path = databasePath(t)
  const options = deterministicOptions()
  const first = new SqliteSessionStore(path, options)
  const session = first.createSession({})
  const goal = first.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'recover a mutation safely',
    provider: 'codex',
    model: 'gpt-test',
  })
  const started = first.beginTurn(beginInput(session.activeThreadId))
  first.appendProviderEvent({
    turnId: started.turn.id,
    eventId: 'unresolved-mutation-call',
    items: [{
      kind: 'tool_call',
      payload: {
        callId: 'mutation-1', providerCallId: 'provider-mutation-1', name: 'write_file',
        input: { path: 'x' }, sideEffect: 'workspace_mutation',
      },
    }],
  })
  first.close()

  const recovered = new SqliteSessionStore(path, options)
  t.after(() => recovered.close())
  assert.equal(recovered.recoverInterruptedTurns(), 1)
  assert.equal(recovered.getTurn(started.turn.id)?.error?.code, 'unknown_mutation_outcome')
  assert.equal(recovered.getGoalById(goal.id)?.statusReason?.code, 'unknown_mutation_outcome')
})

test('unknown mutation reconciliation appends one durable result and preserves explicit Goal resume', (t) => {
  const path = databasePath(t)
  const options = deterministicOptions()
  const first = new SqliteSessionStore(path, options)
  const session = first.createSession({})
  const goal = first.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'reconcile explicitly',
    provider: 'codex',
    model: 'gpt-test',
  })
  const started = first.beginTurn(beginInput(session.activeThreadId))
  first.appendProviderEvent({
    turnId: started.turn.id,
    eventId: 'reconcile-call',
    items: [{
      kind: 'tool_call',
      payload: {
        callId: 'mutation-1', providerCallId: 'provider-mutation-1', name: 'write_file',
        input: { path: 'x' }, sideEffect: 'workspace_mutation',
      },
    }],
  })
  first.close()

  const recovered = new SqliteSessionStore(path, options)
  assert.equal(recovered.recoverInterruptedTurns(), 1)
  const eventCursor = recovered.listEvents(session.activeThreadId).at(-1)?.sequence ?? 0
  const result = recovered.reconcileTool({
    turnId: started.turn.id,
    callId: 'mutation-1',
    resolution: 'unknown_acknowledged',
    note: 'workspace inspected',
  })
  assert.equal(result.duplicate, false)
  assert.equal(result.item.kind, 'tool_result')
  assert.equal(result.item.visibility, 'portable')
  assert.deepEqual(result.item.payload.reconciliation, {
    resolution: 'unknown_acknowledged', note: 'workspace inspected',
  })
  assert.equal((result.item.payload.result as { success: boolean }).success, false)
  assert.deepEqual(recovered.listEvents(session.activeThreadId, eventCursor).map((event) => ({
    type: event.type, turnId: event.turnId, payload: event.payload,
  })), [{
    type: 'items_appended',
    turnId: started.turn.id,
    payload: { itemIds: [result.item.id], reconciliation: true },
  }])
  assert.equal(recovered.getGoalById(goal.id)?.status, 'blocked')
  assert.equal(recovered.getGoalById(goal.id)?.statusReason?.code, 'unknown_mutation_outcome')
  recovered.close()

  const reopened = new SqliteSessionStore(path, options)
  t.after(() => reopened.close())
  const duplicate = reopened.reconcileTool({
    turnId: started.turn.id,
    callId: 'mutation-1',
    resolution: 'unknown_acknowledged',
    note: 'workspace inspected',
  })
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.item.id, result.item.id)
  assert.equal(reopened.listEvents(session.activeThreadId, eventCursor).length, 1)
  assert.throws(() => reopened.reconcileTool({
    turnId: started.turn.id,
    callId: 'mutation-1',
    resolution: 'succeeded',
    note: 'workspace inspected',
  }), (error: unknown) => error instanceof SessionStoreError && error.code === 'reconciliation_conflict')
})

test('tool reconciliation rejects invalid state, call identity, and oversized notes', (t) => {
  const path = databasePath(t)
  const options = deterministicOptions()
  const first = new SqliteSessionStore(path, options)
  const session = first.createSession({})
  const started = first.beginTurn(beginInput(session.activeThreadId))
  first.appendProviderEvent({
    turnId: started.turn.id,
    eventId: 'read-call',
    items: [
      {
        kind: 'tool_call',
        payload: {
          callId: 'mutation-1', providerCallId: 'provider-mutation-1', name: 'write_file',
          input: { path: 'x' }, sideEffect: 'workspace_mutation',
        },
      },
      {
        kind: 'tool_call',
        payload: {
          callId: 'read-1', providerCallId: 'provider-read-1', name: 'read_file',
          input: { path: 'x' }, sideEffect: 'read_only',
        },
      },
    ],
  })
  first.close()

  const recovered = new SqliteSessionStore(path, options)
  t.after(() => recovered.close())
  assert.equal(recovered.recoverInterruptedTurns(), 1)
  for (const input of [
    { turnId: started.turn.id, callId: 'read-1', resolution: 'failed' as const },
    { turnId: started.turn.id, callId: 'missing', resolution: 'failed' as const },
    { turnId: started.turn.id, callId: 'read-1', resolution: 'failed' as const, note: 'x'.repeat(501) },
  ]) {
    assert.throws(
      () => recovered.reconcileTool(input),
      (error: unknown) => error instanceof SessionStoreError && error.code === 'invalid_reconciliation',
    )
  }
})

test('startup recovery fail-closes terminal Goal turns with missing or partial terminal accounting', (t) => {
  for (const checkpointed of [false, true]) {
    const path = databasePath(t)
    const options = deterministicOptions()
    const first = new SqliteSessionStore(path, options)
    const session = first.createSession({})
    const goal = first.createGoal({
      threadId: session.activeThreadId,
      expected: { kind: 'none' },
      objective: checkpointed ? 'partial accounting' : 'missing accounting',
      provider: 'codex',
      model: 'gpt-test',
    })
    const lease = first.claimGoalLease({ goalId: goal.id, goalRevision: goal.revision, ownerId: 'old-runtime' })
    assert.ok(lease)
    const started = first.beginTurn({
      ...beginInput(session.activeThreadId),
      budget: { goalAutomatic: true },
      goalContext: { goalId: goal.id, goalRevision: goal.revision, leaseId: lease.leaseId },
    })
    if (checkpointed) {
      first.checkpointGoalTurn({
        turnId: started.turn.id,
        goalId: goal.id,
        goalRevision: goal.revision,
        tokensUsed: 5,
        timeUsedSeconds: 1,
      })
    }
    first.finishTurn({ turnId: started.turn.id, status: 'completed' })
    first.close()

    const recovered = new SqliteSessionStore(path, options)
    assert.equal(recovered.recoverInterruptedTurns(), 1)
    const blocked = recovered.getGoalById(goal.id)
    assert.equal(blocked?.status, 'blocked')
    assert.equal(blocked?.statusReason?.code, 'goal_accounting_interrupted')
    assert.equal(blocked?.tokensUsed, checkpointed ? 5 : 0)
    assert.equal(blocked?.automaticTurnsUsed, 1)
    assert.equal(recovered.recoverInterruptedTurns(), 0, 'terminal accounting recovery must be idempotent')
    assert.equal(recovered.listEvents(session.activeThreadId).filter((event) => (
      event.type === 'goal_changed' && event.payload.status === 'blocked'
    )).length, 1)

    const inspected = new DatabaseSync(path, { readOnly: true })
    try {
      const accounting = inspected.prepare(`
        SELECT automatic,terminal,tokens_used,time_used_seconds FROM goal_turn_accounting WHERE turn_id=?
      `).get(started.turn.id) as { automatic: number; terminal: number; tokens_used: number; time_used_seconds: number }
      assert.deepEqual({ ...accounting }, {
        automatic: 1,
        terminal: 1,
        tokens_used: checkpointed ? 5 : 0,
        time_used_seconds: checkpointed ? 1 : 0,
      })
    } finally {
      inspected.close()
    }

    assert.ok(blocked)
    const resumed = recovered.updateGoalStatus({
      goalId: blocked.id,
      expectedRevision: blocked.revision,
      status: 'active',
    }).goal
    assert.ok(resumed)
    const nextLease = recovered.claimGoalLease({
      goalId: resumed.id,
      goalRevision: resumed.revision,
      ownerId: 'new-runtime',
    })
    assert.ok(nextLease, 'explicit resume must not remain deadlocked behind recovered accounting')
    recovered.close()
  }
})

test('startup recovery leaves normally terminal-accounted Goal turns unchanged', (t) => {
  const path = databasePath(t)
  const options = deterministicOptions()
  const first = new SqliteSessionStore(path, options)
  const session = first.createSession({})
  const goal = first.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'already accounted',
    provider: 'codex',
    model: 'gpt-test',
  })
  const started = first.beginTurn(beginInput(session.activeThreadId))
  first.finishTurn({ turnId: started.turn.id, status: 'completed' })
  first.recordGoalTurn({
    turnId: started.turn.id,
    goalId: goal.id,
    goalRevision: goal.revision,
    tokensUsed: 3,
    timeUsedSeconds: 1,
    automatic: false,
    progressDigest: 'verified-progress',
  })
  first.close()

  const recovered = new SqliteSessionStore(path, options)
  t.after(() => recovered.close())
  assert.equal(recovered.recoverInterruptedTurns(), 0)
  assert.equal(recovered.getGoalById(goal.id)?.status, 'active')
  assert.equal(recovered.listEvents(session.activeThreadId).filter((event) => (
    event.type === 'goal_changed' && event.payload.status === 'blocked'
  )).length, 0)
})

test('provider bindings reject plaintext opaque state and invalidate incompatible context', (t) => {
  const store = new SqliteSessionStore(databasePath(t), deterministicOptions())
  t.after(() => store.close())
  const session = store.createSession({})
  const thread = store.getThread(session.activeThreadId)
  assert.ok(thread)
  const base = {
    threadId: thread.id,
    provider: 'codex' as const,
    modelFamily: 'gpt',
    capabilities,
    syncedRevision: thread.revision,
    contextDigest: 'digest-a',
  }
  assert.throws(
    () => store.upsertProviderBinding({ ...base, opaqueStateEncrypted: new Uint8Array([1]) }),
    /encryption/,
  )
  const first = store.upsertProviderBinding({ ...base, nativeThreadId: 'native-1' })
  assert.equal(store.upsertProviderBinding({ ...base, nativeResponseId: 'response-1' }).id, first.id)
  const replacement = store.upsertProviderBinding({ ...base, contextDigest: 'digest-b' })
  assert.notEqual(replacement.id, first.id)
  assert.deepEqual(store.getSnapshot(thread.id)?.bindings.map((binding) => binding.id), [replacement.id])

  const turn = store.beginTurn(beginInput(thread.id))
  assert.deepEqual(store.getSnapshot(thread.id)?.bindings, [], 'running revisions must not expose stale bindings')
  store.finishTurn({ turnId: turn.turn.id, status: 'completed' })
  assert.deepEqual(store.getSnapshot(thread.id)?.bindings, [], 'finished turns invalidate prior bindings')
})
