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
import { SqliteSessionStore } from './sqlite-store.ts'
import { GoalStoreError, SessionStoreError } from './store.ts'

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

test('schema v1 migrates through v7 with Goal storage and retention guards without rewriting turns', (t) => {
  const path = databasePath(t)
  const legacy = new DatabaseSync(path)
  legacy.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL) STRICT;
    INSERT INTO schema_migrations VALUES(1, 'canonical-session-v1', '2026-07-18T00:00:00.000Z');
    PRAGMA user_version = 1;
    CREATE TABLE sessions(
      id TEXT PRIMARY KEY, archived_at TEXT
    ) STRICT;
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
  assert.equal((inspected.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 7)
  const migrations = inspected.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>
  const sourceColumns = inspected.prepare('PRAGMA table_info(native_session_sources)').all() as Array<{ name: string }>
  assert.deepEqual(migrations.map((row) => row.version), [1, 2, 3, 4, 5, 6, 7])
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
})

test('schema v6 migrates to v7 in place and reopens without replaying the migration', (t) => {
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
  assert.equal((inspected.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 7)
  assert.deepEqual(
    (inspected.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>)
      .map((row) => row.version),
    [1, 2, 3, 4, 5, 6, 7],
  )
  assert.equal((inspected.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=7")
    .get() as { count: number }).count, 1)
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
  firstStore.close()

  const recoveredStore = new SqliteSessionStore(path, options)
  t.after(() => recoveredStore.close())
  assert.equal(recoveredStore.recoverInterruptedTurns(), 1)
  assert.equal(recoveredStore.recoverInterruptedTurns(), 0)
  assert.equal(recoveredStore.getTurn(started.turn.id)?.status, 'interrupted')
  assert.equal(recoveredStore.getThread(session.activeThreadId)?.status, 'idle')
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
