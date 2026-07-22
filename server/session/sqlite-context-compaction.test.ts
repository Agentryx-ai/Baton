import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CONTEXT_SUMMARY_PROMPT_VERSION,
  contextSummaryGenerationInput,
  contextSummaryInputHash,
  contextSummaryTurnReceipt,
} from './context-summary-contract.js'
import {
  coverageItems,
  materializeContext,
  sourceHashForItems,
  stableContextPrefixes,
  summarySourceItems,
} from './context-materializer.js'
import {
  contextCompactionRequestKey,
  persistExecutionContextManifest,
  snapshotWithMaterializedContext,
  SqliteContextCompactionStore,
} from './sqlite-context-compaction.js'
import { SqliteSessionStore } from './sqlite-store.js'

test('native compact checkpoint manifest survives store reopen with exact immutable provenance', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'baton-native-checkpoint-manifest-'))
  const databasePath = path.join(directory, 'session.sqlite')
  let store = new SqliteSessionStore(databasePath)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = store.createSession({})
  const imported = store.beginTurn({
    threadId: session.activeThreadId,
    provider: 'codex',
    model: 'gpt-test',
    clientRequestId: 'imported',
    requestHash: 'imported',
    expectedRevision: 0,
    input: [{ kind: 'user_message', payload: { text: 'canonical prefix' } }],
    adapterVersion: 'test/1',
    policySnapshot: {
      delegationMode: 'disabled', allowedTools: [], approvalPolicy: 'never',
      cwd: null, maxDepth: 0, capabilityGrant: null,
    },
  })
  store.appendProviderEvent({
    turnId: imported.turn.id,
    eventId: 'native-checkpoint',
    items: [{
      kind: 'provider_event',
      visibility: 'provider_private',
      provider: 'codex',
      payload: {
        nativeContextCheckpoint: {
          version: 1,
          provider: 'codex',
          format: 'codex_replacement_history',
          history: [{ type: 'compaction', encrypted_content: 'opaque' }],
          sourceModel: 'gpt-test',
        },
      },
    }, { kind: 'assistant_message', payload: { text: 'canonical suffix' } }],
  })
  store.finishTurn({ turnId: imported.turn.id, status: 'completed' })

  const resumed = store.beginTurn({
    threadId: session.activeThreadId,
    provider: 'codex',
    model: 'gpt-test',
    clientRequestId: 'resumed',
    requestHash: 'resumed',
    expectedRevision: store.getThread(session.activeThreadId)!.revision,
    input: [{ kind: 'user_message', payload: { text: 'resume' } }],
    adapterVersion: 'test/1',
    policySnapshot: {
      delegationMode: 'disabled', allowedTools: [], approvalPolicy: 'never',
      cwd: null, maxDepth: 0, capabilityGrant: null,
    },
  })
  const current = store.getSnapshot(session.activeThreadId)!
  const itemsBeforeAppend = [...current.items]
  const selected = materializeContext(current, [], 'codex')
  assert.deepEqual(selected.entries.map((entry) =>
    entry.type === 'canonical_item' ? entry.item.sequence : -1), [2, 3, 4])
  persistExecutionContextManifest(store, resumed.execution, selected)
  const manifestBeforeReopen = store.getExecutionContextManifest(resumed.execution.id)
  assert.deepEqual(manifestBeforeReopen?.entries.map((entry) =>
    entry.kind === 'canonical_item' ? entry.itemId : entry.compactionId),
  selected.entries.map((entry) => entry.type === 'canonical_item' ? entry.item.id : entry.artifact.id))

  store.appendProviderEvent({
    turnId: resumed.turn.id,
    eventId: 'later-answer',
    items: [{ kind: 'assistant_message', payload: { text: 'later canonical item' } }],
  })
  store.finishTurn({ turnId: resumed.turn.id, status: 'completed' })
  const grown = store.getSnapshot(session.activeThreadId)!
  const appendedItems = grown.items.filter((item) =>
    !itemsBeforeAppend.some((previous) => previous.id === item.id))
  assert.equal(appendedItems.length, 1)
  assert.equal(appendedItems[0]?.sequence, 5)
  assert.equal(appendedItems[0]?.kind, 'assistant_message')
  const itemIdsBeforeReopen = grown.items.map((item) => item.id)
  store.close()
  store = new SqliteSessionStore(databasePath)

  const reopened = store.getSnapshot(session.activeThreadId)!
  const reopenedItemIds = reopened.items.map((item) => item.id)
  assert.deepEqual(reopenedItemIds, itemIdsBeforeReopen,
    'store reopen must preserve the exact canonical sequence without replay duplicates')
  assert.equal(new Set(reopenedItemIds).size, reopenedItemIds.length)
  const reopenedSelection = materializeContext(reopened, [], 'codex')
  assert.deepEqual(reopenedSelection.entries.map((entry) =>
    entry.type === 'canonical_item' ? entry.item.sequence : -1), [2, 3, 4, 5])
  const persistedManifest = store.getExecutionContextManifest(resumed.execution.id)
  assert.deepEqual(persistedManifest, manifestBeforeReopen,
    'later canonical growth and store reopen must not change the checkpoint frontier of an immutable manifest')
  const sequenceByItemId = new Map(reopened.items.map((item) => [item.id, item.sequence]))
  assert.deepEqual(persistedManifest?.entries.map((entry) =>
    entry.kind === 'canonical_item' ? sequenceByItemId.get(entry.itemId) : -1), [2, 3, 4])

  const switched = store.beginTurn({
    threadId: session.activeThreadId,
    provider: 'claude',
    model: 'claude-test',
    clientRequestId: 'switched',
    requestHash: 'switched',
    expectedRevision: store.getThread(session.activeThreadId)!.revision,
    input: [{ kind: 'user_message', payload: { text: 'switch provider' } }],
    adapterVersion: 'test/1',
    policySnapshot: {
      delegationMode: 'disabled', allowedTools: [], approvalPolicy: 'never',
      cwd: null, maxDepth: 0, capabilityGrant: null,
    },
  })
  const foreignSelection = materializeContext(store.getSnapshot(session.activeThreadId)!, [], 'codex')
  assert.throws(() => persistExecutionContextManifest(store, switched.execution, foreignSelection),
    /retain every canonical item/,
    'a native checkpoint cannot cover canonical history for a different execution provider')
})

test('schema-v14 store round-trips a derived summary and exact execution manifest', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'baton-context-store-'))
  const store = new SqliteSessionStore(path.join(directory, 'session.sqlite'))
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = store.createSession({})
  const first = store.beginTurn({
    threadId: session.activeThreadId,
    provider: 'claude',
    model: 'claude-test',
    clientRequestId: 'first',
    requestHash: 'first-hash',
    expectedRevision: 0,
    input: [{ kind: 'user_message', payload: { text: 'canonical user' } }],
    adapterVersion: 'test/1',
    policySnapshot: {
      delegationMode: 'disabled', allowedTools: [], approvalPolicy: 'never',
      cwd: null, maxDepth: 0, capabilityGrant: null,
    },
  })
  store.appendProviderEvent({
    turnId: first.turn.id,
    eventId: 'assistant-event',
    items: [
      { kind: 'assistant_message', payload: { text: 'canonical answer' } },
      { kind: 'provider_event', visibility: 'provider_private', provider: 'claude', payload: { opaque: true } },
    ],
  })
  store.finishTurn({ turnId: first.turn.id, status: 'completed' })

  const completed = store.getSnapshot(session.activeThreadId)!
  const prefix = stableContextPrefixes(completed).at(-1)!
  const source = coverageItems(completed, prefix)
  const portableSource = summarySourceItems(completed, prefix)
  const contextStore = new SqliteContextCompactionStore(store, 'claude', 'test-owner')
  const firstGenerator = { id: 'test-generator', model: 'claude-test', effort: null, version: '1' }
  const firstInput = contextSummaryGenerationInput({
    threadId: completed.thread.id,
    sourceItemIds: source.map((item) => item.id),
    sourceHash: sourceHashForItems(source),
    throughSequence: prefix.throughSequence,
    previousSummary: null,
    turns: prefix.turns.map(contextSummaryTurnReceipt),
    items: portableSource,
    maximumSummaryTokens: 256,
  })
  const firstCandidate = {
    schemaVersion: 1,
    id: 'candidate-id',
    threadId: completed.thread.id,
    sourceItemIds: source.map((item) => item.id),
    sourceHash: sourceHashForItems(source),
    summaryInputHash: contextSummaryInputHash(firstInput, firstGenerator),
    summaryInput: {
      promptVersion: CONTEXT_SUMMARY_PROMPT_VERSION, previousArtifactId: null,
      deltaItemIds: portableSource.map((item) => item.id), turnIds: [first.turn.id], maximumSummaryTokens: 256,
    },
    throughSequence: prefix.throughSequence,
    summary: 'derived continuation state',
    generator: firstGenerator,
    estimatedSummaryTokens: 8,
    createdAt: '2026-07-19T00:00:00.000Z',
  } as const
  const competingStore = new SqliteContextCompactionStore(store, 'codex', 'competing-owner')
  const competingGenerator = { id: 'other-generator', model: 'gpt-test', effort: 'high', version: '2' }
  const competingCandidate = {
    ...firstCandidate,
    summaryInputHash: contextSummaryInputHash(firstInput, competingGenerator),
    summary: 'different generation contract candidate',
    generator: competingGenerator,
  } as const
  const firstKey = contextCompactionRequestKey(firstCandidate.sourceHash, firstCandidate.summaryInputHash)
  const competingKey = contextCompactionRequestKey(
    competingCandidate.sourceHash,
    competingCandidate.summaryInputHash,
  )
  assert.notEqual(firstKey, competingKey)
  assert.ok(firstKey.length <= 200 && competingKey.length <= 200)
  const [firstReservation, competingReservation] = await Promise.all([
    contextStore.reserveGeneration({
      threadId: firstCandidate.threadId,
      sourceItemIds: firstCandidate.sourceItemIds,
      sourceHash: firstCandidate.sourceHash,
      summaryInputHash: firstCandidate.summaryInputHash,
      expectedPreviousArtifactId: null,
      generator: firstGenerator,
    }),
    competingStore.reserveGeneration({
      threadId: competingCandidate.threadId,
      sourceItemIds: competingCandidate.sourceItemIds,
      sourceHash: competingCandidate.sourceHash,
      summaryInputHash: competingCandidate.summaryInputHash,
      expectedPreviousArtifactId: null,
      generator: competingGenerator,
    }),
  ])
  assert.equal(firstReservation.status, 'reserved')
  assert.equal(competingReservation.status, 'superseded',
    'head reservation serializes distinct generation contracts before provider work')
  assert.equal(firstReservation.status === 'reserved'
    ? await contextStore.failGeneration(firstReservation.reservation, {
      code: 'generator_failed', message: 'provider offline',
    })
    : null, 'failed')
  assert.deepEqual(store.getContextCompactionJob(
    firstReservation.status === 'reserved' ? firstReservation.reservation.receiptId : '',
  )?.error, { code: 'generator_failed', message: 'provider offline' })

  const resumed = await contextStore.reserveGeneration({
    threadId: firstCandidate.threadId,
    sourceItemIds: firstCandidate.sourceItemIds,
    sourceHash: firstCandidate.sourceHash,
    summaryInputHash: firstCandidate.summaryInputHash,
    expectedPreviousArtifactId: null,
    generator: firstGenerator,
  })
  assert.equal(resumed.status, 'reserved', 'the exact failed request is durably resumable')
  assert.equal(resumed.status === 'reserved'
    ? await contextStore.completeGeneration(resumed.reservation, firstCandidate)
    : null, 'stored')

  const artifacts = await contextStore.listArtifacts(completed.thread.id)
  assert.equal(artifacts.length, 1)
  assert.notEqual(artifacts[0]?.id, 'candidate-id', 'the immutable DB artifact owns its durable ID')
  const materialized = materializeContext(completed, artifacts)
  assert.deepEqual(materialized.entries.map((entry) =>
    entry.type === 'derived_summary' ? 'summary' : entry.item.kind), ['summary'])

  const revision = store.getThread(session.activeThreadId)!.revision
  const second = store.beginTurn({
    threadId: session.activeThreadId,
    provider: 'claude',
    model: 'claude-test',
    clientRequestId: 'second',
    requestHash: 'second-hash',
    expectedRevision: revision,
    input: [{ kind: 'user_message', payload: { text: 'next question' } }],
    adapterVersion: 'test/1',
    policySnapshot: {
      delegationMode: 'disabled', allowedTools: [], approvalPolicy: 'never',
      cwd: null, maxDepth: 0, capabilityGrant: null,
    },
  })
  const current = store.getSnapshot(session.activeThreadId)!
  const selected = materializeContext(current, artifacts)
  persistExecutionContextManifest(store, second.execution, selected)
  const manifest = store.getExecutionContextManifest(second.execution.id)!
  assert.deepEqual(manifest.entries.map((entry) => entry.kind), [
    'compaction', 'canonical_item',
  ])
  const providerSnapshot = snapshotWithMaterializedContext(current, selected)
  assert.equal(providerSnapshot.items[0]?.kind, 'summary')
  assert.equal(providerSnapshot.items.at(-1)?.kind, 'user_message')
  store.finishTurn({ turnId: second.turn.id, status: 'completed' })
  const advanced = store.getSnapshot(session.activeThreadId)!
  const advancedPrefix = stableContextPrefixes(advanced).at(-1)!
  const advancedSource = coverageItems(advanced, advancedPrefix)
  assert.equal(await contextStore.saveArtifact({
    ...firstCandidate,
    id: 'stale-candidate',
    sourceItemIds: advancedSource.map((item) => item.id),
    sourceHash: sourceHashForItems(advancedSource),
    summaryInputHash: 'c'.repeat(64),
    summaryInput: {
      ...firstCandidate.summaryInput,
      previousArtifactId: null,
      deltaItemIds: advancedSource.slice(source.length).map((item) => item.id),
      turnIds: [second.turn.id],
    },
    throughSequence: advancedPrefix.throughSequence,
    summary: 'stale writer should not replace the head',
  }, null), 'superseded', 'stale head CAS maps to a losing writer result')

  const previous = artifacts[0]!
  const advancedPortableSource = summarySourceItems(advanced, advancedPrefix)
  const previousSourceIds = new Set(previous.sourceItemIds)
  const advancedDelta = advancedPortableSource.filter((item) => !previousSourceIds.has(item.id))
  const secondGenerator = { id: 'test-generator', model: 'claude-test', effort: null, version: '1' }
  const secondInput = contextSummaryGenerationInput({
    threadId: advanced.thread.id,
    sourceItemIds: advancedSource.map((item) => item.id),
    sourceHash: sourceHashForItems(advancedSource),
    throughSequence: advancedPrefix.throughSequence,
    previousSummary: previous,
    turns: advancedPrefix.turns
      .filter((turn) => turn.id !== first.turn.id)
      .map(contextSummaryTurnReceipt),
    items: advancedDelta,
    maximumSummaryTokens: 256,
  })
  const secondCandidate = {
    schemaVersion: 1,
    id: 'second-candidate-id',
    threadId: advanced.thread.id,
    sourceItemIds: advancedSource.map((item) => item.id),
    sourceHash: secondInput.sourceHash,
    summaryInputHash: contextSummaryInputHash(secondInput, secondGenerator),
    summaryInput: {
      promptVersion: CONTEXT_SUMMARY_PROMPT_VERSION,
      previousArtifactId: previous.id,
      deltaItemIds: advancedDelta.map((item) => item.id),
      turnIds: [second.turn.id],
      maximumSummaryTokens: 256,
    },
    throughSequence: advancedPrefix.throughSequence,
    summary: 'advanced derived continuation state',
    generator: secondGenerator,
    estimatedSummaryTokens: 8,
    createdAt: '2026-07-19T00:01:00.000Z',
  } as const
  assert.equal(await contextStore.saveArtifact(secondCandidate, previous.id), 'stored')
  const chain = await contextStore.listArtifacts(advanced.thread.id)
  assert.equal(chain.length, 2)
  assert.deepEqual(chain.map((artifact) => artifact.id), [previous.id, chain[1]!.id])
  const advancedMaterialized = materializeContext(advanced, chain)
  assert.equal(advancedMaterialized.artifact?.id, chain[1]!.id)
  assert.deepEqual(advancedMaterialized.entries.map((entry) =>
    entry.type === 'derived_summary' ? 'summary' : entry.item.kind), ['summary'])
})
