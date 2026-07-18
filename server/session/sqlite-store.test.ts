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
import { SessionStoreError } from './store.ts'

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

test('schema v1 migrates through v6 with retention guards without rewriting turns', (t) => {
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
  assert.equal((inspected.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 6)
  const migrations = inspected.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>
  const sourceColumns = inspected.prepare('PRAGMA table_info(native_session_sources)').all() as Array<{ name: string }>
  assert.deepEqual(migrations.map((row) => row.version), [1, 2, 3, 4, 5, 6])
  assert.equal(sourceColumns.some((column) => column.name === 'title_source'), true)
  const indexes = inspected.prepare("SELECT name FROM sqlite_schema WHERE type='index'").all() as Array<{ name: string }>
  assert.equal(indexes.some((index) => index.name === 'sessions_archived_expiry'), true)
})

test('sessions move to trash, remain readable for restore, and reject new work while archived', (t) => {
  let now = '2026-07-18T00:00:00.000Z'
  const store = new SqliteSessionStore(databasePath(t), {
    ...deterministicOptions(),
    now: () => now,
  })
  t.after(() => store.close())
  const session = store.createSession({ title: 'Trash me' })

  const archived = store.archiveSession(session.id)
  assert.equal(archived.archivedAt, now)
  assert.deepEqual(store.listSessions(), [])
  assert.deepEqual(store.listSessions('trash').map((candidate) => candidate.id), [session.id])
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
