import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  CanonicalItem,
  CanonicalTurn,
  ThreadSnapshot,
} from './domain.js'
import {
  CONTEXT_SUMMARY_PROMPT_VERSION,
  contextSummaryGenerationInput,
  contextSummaryInputHash,
  contextSummaryTurnReceipt,
} from './context-summary-contract.js'
import {
  coverageItems,
  estimateContextTokens,
  isValidArtifact,
  materializeContext,
  sourceHashForItems,
  stableContextPrefixes,
  summarySourceItems,
  type ContextSummaryArtifact,
} from './context-materializer.js'

test('materializes an exact valid summary while retiring covered private wire state', () => {
  const snapshot = makeSnapshot([
    turn('turn-1', 1, 'completed'),
    turn('turn-2', 2, 'completed'),
  ], [
    item('one-user', 'turn-1', 1, 'user_message', { text: 'first' }),
    item('one-private', 'turn-1', 2, 'provider_event', { opaque: 'state' }, 'provider_private'),
    item('one-assistant', 'turn-1', 3, 'assistant_message', { text: 'answer' }),
    item('one-usage', 'turn-1', 4, 'usage', { input: 10 }),
    item('two-user', 'turn-2', 5, 'user_message', { text: 'next' }),
    item('two-assistant', 'turn-2', 6, 'assistant_message', { text: 'done' }),
  ])
  const prefix = stableContextPrefixes(snapshot)[0]!
  const source = coverageItems(snapshot, prefix)
  const artifact = summaryArtifact(snapshot, prefix.throughSequence, source, 'first turn summary')
  const before = structuredClone(snapshot.items)

  const materialized = materializeContext(snapshot, [artifact])

  assert.equal(materialized.artifact?.id, artifact.id)
  assert.deepEqual(materialized.entries.map((entry) =>
    entry.type === 'derived_summary' ? 'summary' : entry.item.id), [
    'summary', 'two-user', 'two-assistant',
  ])
  assert.deepEqual(snapshot.items, before, 'canonical items are never mutated or replaced')
  assert.ok(materialized.estimatedTokens > 0)
})

test('rejects changed bytes or source identity and safely falls back to full history', () => {
  const snapshot = makeSnapshot([turn('turn-1', 1, 'completed')], [
    item('one-user', 'turn-1', 1, 'user_message', { text: 'first' }),
    item('one-assistant', 'turn-1', 2, 'assistant_message', { text: 'answer' }),
  ])
  const prefix = stableContextPrefixes(snapshot)[0]!
  const source = coverageItems(snapshot, prefix)
  const wrongHash = { ...summaryArtifact(snapshot, 2, source, 'summary'), sourceHash: '0'.repeat(64) }
  const wrongIds = { ...summaryArtifact(snapshot, 2, source, 'summary'), id: 'wrong-ids', sourceItemIds: ['one-user'] }

  assert.equal(isValidArtifact(snapshot, wrongHash), false)
  assert.equal(isValidArtifact(snapshot, wrongIds), false)
  const materialized = materializeContext(snapshot, [wrongHash, wrongIds])
  assert.equal(materialized.artifact, null)
  assert.deepEqual([...materialized.invalidArtifactIds].sort(), ['artifact-2', 'wrong-ids'])
  assert.deepEqual(materialized.entries.map((entry) =>
    entry.type === 'canonical_item' ? entry.item.id : 'summary'), ['one-user', 'one-assistant'])
})

test('validates the exact prompt provenance and complete previous-artifact chain', () => {
  const snapshot = makeSnapshot([
    turn('turn-1', 1, 'completed'),
    {
      ...turn('turn-2', 2, 'failed'),
      error: { code: 'provider_failed', message: 'upstream stopped' },
      completedAt: '2026-07-19T00:02:00Z',
    },
  ], [
    item('one-user', 'turn-1', 1, 'user_message', { text: 'first' }),
    item('one-private', 'turn-1', 2, 'provider_event', { opaque: 'secret' }, 'provider_private'),
    item('one-assistant', 'turn-1', 3, 'assistant_message', { text: 'answer' }),
    item('two-user', 'turn-2', 4, 'user_message', { text: 'second' }),
    item('two-assistant', 'turn-2', 5, 'assistant_message', { text: 'failed answer' }),
  ])
  const prefixes = stableContextPrefixes(snapshot)
  const firstSource = coverageItems(snapshot, prefixes[0]!)
  const first = summaryArtifact(snapshot, prefixes[0]!.throughSequence, firstSource, 'first summary')
  const secondSource = coverageItems(snapshot, prefixes[1]!)
  const second = summaryArtifact(snapshot, prefixes[1]!.throughSequence, secondSource, 'second summary', first)

  assert.equal(isValidArtifact(snapshot, second, [first, second]), true)
  assert.equal(materializeContext(snapshot, [first, second]).artifact?.id, second.id)

  const wrongDelta = {
    ...second,
    summaryInput: { ...second.summaryInput, deltaItemIds: ['two-assistant', 'two-user'] },
  }
  assert.equal(isValidArtifact(snapshot, wrongDelta, [first, wrongDelta]), false)

  const wrongGenerator = {
    ...second,
    generator: { ...second.generator, model: 'changed-model' },
  }
  assert.equal(isValidArtifact(snapshot, wrongGenerator, [first, wrongGenerator]), false)

  const wrongPromptVersion = {
    ...second,
    summaryInput: { ...second.summaryInput, promptVersion: 'baton-context-summary-prompt/v0' },
  }
  assert.equal(isValidArtifact(snapshot, wrongPromptVersion, [first, wrongPromptVersion]), false)

  const wrongMaximum = {
    ...second,
    summaryInput: { ...second.summaryInput, maximumSummaryTokens: 101 },
  }
  assert.equal(isValidArtifact(snapshot, wrongMaximum, [first, wrongMaximum]), false)

  const changedSnapshot = structuredClone(snapshot)
  changedSnapshot.items.find((entry) => entry.id === 'two-user')!.payload = { text: 'tampered delta bytes' }
  const changedSource = coverageItems(changedSnapshot, stableContextPrefixes(changedSnapshot)[1]!)
  const forgedSourceHash = { ...second, sourceHash: sourceHashForItems(changedSource) }
  assert.equal(
    isValidArtifact(changedSnapshot, forgedSourceHash, [first, forgedSourceHash]),
    false,
    'rehashing canonical coverage cannot hide portable prompt-byte changes',
  )

  const changedPrevious = { ...first, summary: 'tampered prior summary' }
  assert.equal(isValidArtifact(snapshot, second, [changedPrevious, second]), false)
  assert.equal(isValidArtifact(snapshot, second, [second]), false, 'missing prior artifacts invalidate the chain')
})

test('terminal receipt status, error, provider, model, effort, and timestamps are exact hash inputs', () => {
  const baseTurn = {
    ...turn('turn-1', 1, 'failed'),
    provider: 'claude' as const,
    model: 'claude-test',
    effort: 'high',
    error: { code: 'provider_failed', message: 'upstream stopped' },
    startedAt: '2026-07-19T00:00:00Z',
    completedAt: '2026-07-19T00:01:00Z',
  }
  const items = [item('one-user', 'turn-1', 1, 'user_message', { text: 'first' })]
  const snapshot = makeSnapshot([baseTurn], items)
  const artifact = summaryArtifact(snapshot, 1, items, 'summary')
  const mutations: Array<[string, Partial<CanonicalTurn>]> = [
    ['status', { status: 'cancelled' }],
    ['error', { error: { code: 'different', message: 'changed' } }],
    ['provider', { provider: 'codex' }],
    ['model', { model: 'changed-model' }],
    ['effort', { effort: 'low' }],
    ['startedAt', { startedAt: '2026-07-19T00:00:01Z' }],
    ['completedAt', { completedAt: '2026-07-19T00:01:01Z' }],
  ]

  for (const [field, mutation] of mutations) {
    const changed = makeSnapshot([{ ...baseTurn, ...mutation }], items)
    assert.equal(isValidArtifact(changed, artifact), false, `${field} mutation must invalidate provenance`)
  }
})

test('source hash is deterministic across payload key order and changes with canonical metadata', () => {
  const left = item('item-1', 'turn-1', 1, 'user_message', { z: 2, a: { d: 4, b: 3 } })
  const right = item('item-1', 'turn-1', 1, 'user_message', { a: { b: 3, d: 4 }, z: 2 })
  assert.equal(sourceHashForItems([left]), sourceHashForItems([right]))
  assert.notEqual(sourceHashForItems([left]), sourceHashForItems([{ ...right, createdAt: '2026-07-19T01:00:01Z' }]))
})

test('stable prefix includes safe terminal failures but stops before active or unresolved turns', () => {
  for (const status of ['failed', 'interrupted', 'cancelled'] as const) {
    const snapshot = makeSnapshot([
      turn('turn-1', 1, 'completed'),
      turn('turn-2', 2, status),
      turn('turn-3', 3, 'completed'),
    ], [
      item('one-user', 'turn-1', 1, 'user_message', { text: 'ok' }),
      item('two-user', 'turn-2', 2, 'user_message', { text: 'unsafe' }),
      item('three-user', 'turn-3', 3, 'user_message', { text: 'later' }),
    ])
    assert.deepEqual(stableContextPrefixes(snapshot).map((prefix) => prefix.throughSequence), [1, 2, 3])
  }

  const running = makeSnapshot([
    turn('turn-1', 1, 'completed'),
    turn('turn-2', 2, 'running'),
    turn('turn-3', 3, 'completed'),
  ], [
    item('one-user', 'turn-1', 1, 'user_message', { text: 'ok' }),
    item('two-user', 'turn-2', 2, 'user_message', { text: 'active' }),
    item('three-user', 'turn-3', 3, 'user_message', { text: 'later' }),
  ])
  assert.deepEqual(stableContextPrefixes(running).map((prefix) => prefix.throughSequence), [1])

  const unresolved = makeSnapshot([turn('turn-1', 1, 'completed')], [
    item('call', 'turn-1', 1, 'tool_call', { callId: 'call-1', sideEffect: 'read_only' }),
  ])
  assert.deepEqual(stableContextPrefixes(unresolved), [])
})

test('unknown mutation outcome cannot become a summary source', () => {
  const snapshot = makeSnapshot([turn('turn-1', 1, 'completed')], [
    item('call', 'turn-1', 1, 'tool_call', { callId: 'call-1', sideEffect: 'workspace_mutation' }),
    item('result', 'turn-1', 2, 'tool_result', {
      callId: 'call-1',
      result: {
        success: false,
        metadata: { reconciliation: { resolution: 'unknown_outcome' } },
        error: { code: 'unknown_mutation_acknowledged' },
      },
    }),
  ])
  assert.deepEqual(stableContextPrefixes(snapshot), [])

  const hostSnapshot = makeSnapshot([turn('turn-host', 1, 'completed')], [
    item('host-call', 'turn-host', 1, 'tool_call', { callId: 'host-1', sideEffect: 'host_mutation' }),
    item('host-result', 'turn-host', 2, 'tool_result', {
      callId: 'host-1',
      result: {
        success: false,
        metadata: { reconciliation: { resolution: 'unknown_outcome' } },
        error: { code: 'unknown_mutation_acknowledged' },
      },
    }),
  ])
  assert.deepEqual(stableContextPrefixes(hostSnapshot), [])
})

test('provider-private, Baton-private, usage, and provider-event records never enter summary input', () => {
  const snapshot = makeSnapshot([turn('turn-1', 1, 'completed')], [
    item('portable', 'turn-1', 1, 'assistant_message', { text: 'yes' }),
    item('provider-private', 'turn-1', 2, 'assistant_message', { secret: true }, 'provider_private'),
    item('baton-private', 'turn-1', 3, 'task', { internal: true }, 'baton_private'),
    item('usage', 'turn-1', 4, 'usage', { total: 1 }),
    item('event', 'turn-1', 5, 'provider_event', { native: true }),
  ])
  const source = summarySourceItems(snapshot, stableContextPrefixes(snapshot)[0]!)
  assert.deepEqual(source.map((entry) => entry.id), ['portable'])
})

test('token estimates are deterministic and count UTF-8 bytes conservatively', () => {
  const snapshot = makeSnapshot([turn('turn-1', 1, 'completed')], [
    item('unicode', 'turn-1', 1, 'user_message', { text: '한글 메시지' }),
  ])
  const entries = materializeContext(snapshot, []).entries
  assert.equal(estimateContextTokens(entries), estimateContextTokens(entries))
  assert.ok(estimateContextTokens(entries) >= 12)
})

test('fork snapshots retain and compact parent lineage items in session sequence order', () => {
  const parentTurn = { ...turn('parent-turn', 1, 'completed'), threadId: 'parent-thread' }
  const childTurn = { ...turn('child-turn', 1, 'completed'), threadId: 'thread-1' }
  const parentUser = { ...item('parent-user', 'parent-turn', 1, 'user_message', { text: 'parent' }),
    threadId: 'parent-thread' }
  const parentAssistant = { ...item('parent-assistant', 'parent-turn', 2, 'assistant_message', { text: 'parent answer' }),
    threadId: 'parent-thread' }
  const childUser = item('child-user', 'child-turn', 3, 'user_message', { text: 'child' })
  const childAssistant = item('child-assistant', 'child-turn', 4, 'assistant_message', { text: 'child answer' })
  const snapshot = makeSnapshot(
    [childTurn, parentTurn],
    [childAssistant, parentUser, childUser, parentAssistant],
  )

  const prefixes = stableContextPrefixes(snapshot)
  assert.deepEqual(prefixes.map((prefix) => prefix.throughSequence), [2, 4])
  assert.deepEqual(summarySourceItems(snapshot, prefixes[1]!).map((entry) => entry.id), [
    'parent-user', 'parent-assistant', 'child-user', 'child-assistant',
  ])
})

function makeSnapshot(turns: CanonicalTurn[], items: CanonicalItem[]): ThreadSnapshot {
  return {
    session: {
      id: 'session-1', title: null, preview: null, activeThreadId: 'thread-1', projectKey: null,
      cwd: null, permissions: { defaultProfile: 'workspace', override: null, effectiveProfile: 'workspace', source: 'global' },
      schemaVersion: 1, createdAt: '2026-07-19T00:00:00Z',
      updatedAt: '2026-07-19T00:00:00Z', archivedAt: null, workStatus: 'idle',
    },
    thread: {
      id: 'thread-1', sessionId: 'session-1', parentThreadId: null, forkTurnId: null, forkItemId: null,
      revision: 1, status: 'idle', instructionSnapshot: {}, createdAt: '2026-07-19T00:00:00Z',
      updatedAt: '2026-07-19T00:00:00Z',
    },
    turns,
    items,
    bindings: [],
  }
}

function turn(id: string, sequence: number, status: CanonicalTurn['status']): CanonicalTurn {
  return {
    id, threadId: 'thread-1', goalId: null, goalRevision: null, sequence, provider: 'codex',
    model: 'test', effort: null, status, clientRequestId: `request-${sequence}`,
    startedAt: '2026-07-19T00:00:00Z',
    completedAt: status === 'completed' ? '2026-07-19T00:01:00Z' : null,
    usage: null, error: null,
  }
}

function item(
  id: string,
  turnId: string,
  sequence: number,
  kind: CanonicalItem['kind'],
  payload: Record<string, unknown>,
  visibility: CanonicalItem['visibility'] = 'portable',
): CanonicalItem {
  return {
    id, sessionId: 'session-1', threadId: 'thread-1', turnId, sequence, kind, visibility, payload,
    provider: visibility === 'provider_private' ? 'codex' : null, nativeId: null,
    createdAt: '2026-07-19T01:00:00Z',
  }
}

function summaryArtifact(
  snapshot: ThreadSnapshot,
  throughSequence: number,
  source: readonly CanonicalItem[],
  summary: string,
  previous: ContextSummaryArtifact | null = null,
): ContextSummaryArtifact {
  const prefix = stableContextPrefixes(snapshot)
    .find((candidate) => candidate.throughSequence === throughSequence)!
  const previousPrefix = previous === null
    ? null
    : stableContextPrefixes(snapshot)
      .find((candidate) => candidate.throughSequence === previous.throughSequence)!
  const previousSourceIds = new Set(previous?.sourceItemIds ?? [])
  const delta = summarySourceItems(snapshot, prefix)
    .filter((entry) => !previousSourceIds.has(entry.id))
  const previousTurnIds = new Set(previousPrefix?.turns.map((entry) => entry.id) ?? [])
  const receipts = prefix.turns
    .filter((entry) => !previousTurnIds.has(entry.id))
    .map(contextSummaryTurnReceipt)
  const generator = { id: 'test', model: 'test-model', effort: null, version: '1' }
  const generationInput = contextSummaryGenerationInput({
    threadId: snapshot.thread.id,
    sourceItemIds: source.map((entry) => entry.id),
    sourceHash: sourceHashForItems(source),
    throughSequence,
    previousSummary: previous,
    turns: receipts,
    items: delta,
    maximumSummaryTokens: 100,
  })
  return {
    schemaVersion: 1,
    id: `artifact-${throughSequence}`,
    threadId: snapshot.thread.id,
    sourceItemIds: source.map((entry) => entry.id),
    sourceHash: sourceHashForItems(source),
    summaryInputHash: contextSummaryInputHash(generationInput, generator),
    summaryInput: {
      promptVersion: CONTEXT_SUMMARY_PROMPT_VERSION,
      previousArtifactId: previous?.id ?? null,
      deltaItemIds: delta.map((entry) => entry.id),
      turnIds: receipts.map((entry) => entry.id),
      maximumSummaryTokens: 100,
    },
    throughSequence,
    summary,
    generator,
    estimatedSummaryTokens: 10,
    createdAt: '2026-07-19T02:00:00Z',
  }
}
