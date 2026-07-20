import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import type { AdapterHandshake, SessionProviderAdapter } from './adapter.js'
import {
  CanonicalContextRuntime,
  ContextInputTooLargeError,
} from './canonical-context-runtime.js'
import {
  CONTEXT_SUMMARY_PROMPT_VERSION,
  contextSummaryGenerationInput,
  contextSummaryInputHash,
  contextSummaryTurnReceipt,
} from './context-summary-contract.js'
import { SqliteSessionStore } from './sqlite-store.js'
import {
  coverageItems,
  sourceHashForItems,
  stableContextPrefixes,
  summarySourceItems,
} from './context-materializer.js'
import { SqliteContextCompactionStore } from './sqlite-context-compaction.js'

test('missing adapter metadata uses the selected Codex model native input budget', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'baton-context-model-default-'))
  const store = new SqliteSessionStore(path.join(directory, 'session.sqlite'))
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const runtime = new CanonicalContextRuntime(store, 'model-default-test')

  const result = runtime.assertUpcomingInputFits({
    ready: {
      adapter: { provider: 'codex' } as SessionProviderAdapter,
      handshake: handshake(null),
    },
    provider: 'codex',
    model: 'gpt-5.6-sol',
    instructionSnapshot: {},
    upcomingInput: [{ kind: 'user_message', payload: { text: 'x'.repeat(450_000) } }],
    toolDefinitions: [],
  })

  assert.equal(result.inputBudgetTokens, 258_400)
  assert.ok(result.additionalInputTokens > 104_000)
})

test('oversized upcoming input is rejected before a canonical turn is created', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'baton-context-input-'))
  const store = new SqliteSessionStore(path.join(directory, 'session.sqlite'))
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = store.createSession({ instructionSnapshot: { developerInstructions: 'be exact' } })
  const snapshot = store.getSnapshot(session.activeThreadId)!
  const runtime = new CanonicalContextRuntime(store, 'context-test')

  await assert.rejects(runtime.compactBeforeTurn({
    snapshot,
    ready: {
      adapter: { provider: 'codex' } as SessionProviderAdapter,
      handshake: handshake(1_000),
    },
    provider: 'codex',
    model: 'gpt-test',
    effort: 'high',
    upcomingInput: [{ kind: 'user_message', payload: { text: 'x'.repeat(10_000) } }],
    toolDefinitions: [],
  }), (error) => error instanceof ContextInputTooLargeError
    && error.code === 'context_input_too_large'
    && error.estimatedInputTokens >= error.usableInputTokens)

  assert.equal(store.getSnapshot(session.activeThreadId)?.turns.length, 0)
})

test('a non-compacting fallback that remains over budget is rejected before beginTurn', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'baton-context-fallback-budget-'))
  const store = new SqliteSessionStore(path.join(directory, 'session.sqlite'))
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = store.createSession({ instructionSnapshot: { developerInstructions: 'be exact' } })
  const first = store.beginTurn({
    threadId: session.activeThreadId,
    provider: 'codex',
    model: 'gpt-test',
    clientRequestId: 'large-history',
    requestHash: 'large-history',
    expectedRevision: 0,
    input: [{ kind: 'user_message', payload: { text: 'x'.repeat(50_000) } }],
    adapterVersion: 'test/1',
    policySnapshot: {
      delegationMode: 'disabled', allowedTools: [], approvalPolicy: 'never', cwd: null,
      maxDepth: 0, capabilityGrant: null,
    },
  })
  store.finishTurn({ turnId: first.turn.id, status: 'completed' })
  const snapshot = store.getSnapshot(session.activeThreadId)!

  await assert.rejects(new CanonicalContextRuntime(store, 'fallback-budget-test').compactBeforeTurn({
    snapshot,
    ready: {
      adapter: { provider: 'codex' } as SessionProviderAdapter,
      handshake: handshake(10_000),
    },
    provider: 'codex',
    model: 'gpt-test',
    effort: 'high',
    upcomingInput: [{ kind: 'user_message', payload: { text: 'next' } }],
    toolDefinitions: [],
  }), (error) => error instanceof ContextInputTooLargeError
    && error.code === 'context_input_too_large'
    && error.estimatedInputTokens > error.usableInputTokens)

  assert.equal(store.getSnapshot(session.activeThreadId)?.turns.length, 1)
})

test('generator failure and full-runtime fallback cannot bypass the post-compaction budget', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'baton-context-failed-compaction-budget-'))
  const store = new SqliteSessionStore(path.join(directory, 'session.sqlite'))
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = store.createSession({})
  for (let index = 0; index < 3; index += 1) {
    const turn = store.beginTurn({
      threadId: session.activeThreadId,
      provider: 'codex',
      model: 'gpt-test',
      clientRequestId: `history-${index}`,
      requestHash: `history-${index}`,
      expectedRevision: store.getThread(session.activeThreadId)!.revision,
      input: [{ kind: 'user_message', payload: { text: `${index}:${'x'.repeat(20_000)}` } }],
      adapterVersion: 'test/1',
      policySnapshot: {
        delegationMode: 'disabled', allowedTools: [], approvalPolicy: 'never', cwd: null,
        maxDepth: 0, capabilityGrant: null,
      },
    })
    store.finishTurn({ turnId: turn.turn.id, status: 'completed' })
  }
  const snapshot = store.getSnapshot(session.activeThreadId)!
  let generatorAttempts = 0
  const failingGeneratorAdapter = {
    provider: 'codex',
    validate() {},
    materialize() { return { body: {} } },
    async execute() {
      generatorAttempts += 1
      throw new Error('summary unavailable')
    },
  } as unknown as SessionProviderAdapter
  const runtime = new CanonicalContextRuntime(store, 'failed-compaction-budget-test')
  const request = {
    snapshot,
    provider: 'codex' as const,
    model: 'gpt-test',
    effort: 'high',
    upcomingInput: [{ kind: 'user_message' as const, payload: { text: 'next' } }],
    toolDefinitions: [],
  }

  await assert.rejects(runtime.compactBeforeTurn({
    ...request,
    ready: { adapter: failingGeneratorAdapter, handshake: handshake(10_000) },
  }), (error) => error instanceof ContextInputTooLargeError)
  assert.equal(generatorAttempts, 1, 'the generator failure path must be exercised')

  await assert.rejects(runtime.compactBeforeTurn({
    ...request,
    ready: {
      adapter: { provider: 'claude' } as SessionProviderAdapter,
      handshake: handshake(10_000),
    },
  }), (error) => error instanceof ContextInputTooLargeError)
})

test('corrupt derived context falls back to full canonical history and a full manifest', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'baton-context-fallback-'))
  const databasePath = path.join(directory, 'session.sqlite')
  const store = new SqliteSessionStore(databasePath)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = store.createSession({})
  const first = store.beginTurn({
    threadId: session.activeThreadId, provider: 'claude', model: 'claude-test',
    clientRequestId: 'first', requestHash: 'first', expectedRevision: 0,
    input: [{ kind: 'user_message', payload: { text: 'canonical question' } }],
    adapterVersion: 'test/1',
    policySnapshot: {
      delegationMode: 'disabled', allowedTools: [], approvalPolicy: 'never', cwd: null,
      maxDepth: 0, capabilityGrant: null,
    },
  })
  store.appendProviderEvent({
    turnId: first.turn.id,
    eventId: 'answer',
    items: [{ kind: 'assistant_message', payload: { text: 'canonical answer' } }],
  })
  store.finishTurn({ turnId: first.turn.id, status: 'completed' })
  const completed = store.getSnapshot(session.activeThreadId)!
  const prefix = stableContextPrefixes(completed).at(-1)!
  const coverage = coverageItems(completed, prefix)
  const portable = summarySourceItems(completed, prefix)
  const contextStore = new SqliteContextCompactionStore(store, 'claude', 'fallback-owner')
  assert.equal(await contextStore.saveArtifact({
    schemaVersion: 1,
    id: 'candidate',
    threadId: completed.thread.id,
    sourceItemIds: coverage.map((item) => item.id),
    sourceHash: sourceHashForItems(coverage),
    summaryInputHash: 'a'.repeat(64),
    summaryInput: {
      promptVersion: 'test/v1', previousArtifactId: null,
      deltaItemIds: portable.map((item) => item.id), turnIds: [first.turn.id],
      maximumSummaryTokens: 256,
    },
    throughSequence: prefix.throughSequence,
    summary: 'derived summary',
    generator: { id: 'test', model: 'claude-test', effort: null, version: '1' },
    estimatedSummaryTokens: 8,
    createdAt: '2026-07-19T00:00:00.000Z',
  }, null), 'stored')

  const second = store.beginTurn({
    threadId: session.activeThreadId, provider: 'claude', model: 'claude-test',
    clientRequestId: 'second', requestHash: 'second',
    expectedRevision: store.getThread(session.activeThreadId)!.revision,
    input: [{ kind: 'user_message', payload: { text: 'next' } }],
    adapterVersion: 'test/1',
    policySnapshot: {
      delegationMode: 'disabled', allowedTools: [], approvalPolicy: 'never', cwd: null,
      maxDepth: 0, capabilityGrant: null,
    },
  })
  const current = store.getSnapshot(session.activeThreadId)!
  const external = new DatabaseSync(databasePath)
  external.exec('DROP TRIGGER context_compactions_no_update')
  external.prepare("UPDATE context_compactions SET summary_json='{}'").run()
  external.close()

  const materialized = await new CanonicalContextRuntime(store, 'fallback-runtime')
    .materializeForExecution({
      snapshot: current,
      execution: second.execution,
      provider: 'claude',
    })
  assert.deepEqual(materialized.items.map((item) => item.id), current.items.map((item) => item.id))
  assert.equal(
    store.getExecutionContextManifest(second.execution.id)?.entries.every((entry) =>
      entry.kind === 'canonical_item'),
    true,
  )
})

test('small-model compaction is a derived view and a larger model restores the full canonical ledger', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'baton-context-model-switch-'))
  const store = new SqliteSessionStore(path.join(directory, 'session.sqlite'))
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = store.createSession({})
  const first = store.beginTurn({
    threadId: session.activeThreadId, provider: 'codex', model: 'gpt-large',
    clientRequestId: 'first', requestHash: 'first', expectedRevision: 0,
    input: [{ kind: 'user_message', payload: { text: 'canonical question' } }],
    adapterVersion: 'test/1',
    policySnapshot: {
      delegationMode: 'disabled', allowedTools: [], approvalPolicy: 'never', cwd: null,
      maxDepth: 0, capabilityGrant: null,
    },
  })
  store.appendProviderEvent({
    turnId: first.turn.id,
    eventId: 'answer',
    items: [{ kind: 'assistant_message', payload: { text: 'canonical answer' } }],
  })
  store.finishTurn({ turnId: first.turn.id, status: 'completed' })
  const completed = store.getSnapshot(session.activeThreadId)!
  const prefix = stableContextPrefixes(completed).at(-1)!
  const coverage = coverageItems(completed, prefix)
  const portable = summarySourceItems(completed, prefix)
  const generator = { id: 'test', model: 'gpt-small', effort: 'high', version: '1' }
  const generationInput = contextSummaryGenerationInput({
    threadId: completed.thread.id,
    sourceItemIds: coverage.map((item) => item.id),
    sourceHash: sourceHashForItems(coverage),
    throughSequence: prefix.throughSequence,
    previousSummary: null,
    turns: prefix.turns.map(contextSummaryTurnReceipt),
    items: portable,
    maximumSummaryTokens: 256,
  })
  const smallViewKey = 'codex-small-budget-v1'
  const smallStore = new SqliteContextCompactionStore(
    store,
    'codex',
    'small-view-owner',
    smallViewKey,
  )
  assert.equal(await smallStore.saveArtifact({
    schemaVersion: 1,
    id: 'candidate',
    threadId: completed.thread.id,
    sourceItemIds: coverage.map((item) => item.id),
    sourceHash: sourceHashForItems(coverage),
    summaryInputHash: contextSummaryInputHash(generationInput, generator),
    summaryInput: {
      promptVersion: CONTEXT_SUMMARY_PROMPT_VERSION,
      previousArtifactId: null,
      deltaItemIds: portable.map((item) => item.id),
      turnIds: [first.turn.id],
      maximumSummaryTokens: 256,
    },
    throughSequence: prefix.throughSequence,
    summary: 'small model summary',
    generator,
    estimatedSummaryTokens: 8,
    createdAt: '2026-07-19T00:00:00.000Z',
  }, null), 'stored')
  const artifact = (await smallStore.listArtifacts(completed.thread.id)).at(-1)!

  const smallTurn = store.beginTurn({
    threadId: session.activeThreadId, provider: 'codex', model: 'gpt-small',
    clientRequestId: 'small', requestHash: 'small',
    expectedRevision: store.getThread(session.activeThreadId)!.revision,
    input: [{ kind: 'user_message', payload: { text: 'small-model turn' } }],
    adapterVersion: 'test/1',
    policySnapshot: {
      delegationMode: 'disabled', allowedTools: [], approvalPolicy: 'never', cwd: null,
      maxDepth: 0, capabilityGrant: null,
    },
    budget: { contextCompaction: { viewKey: smallViewKey, artifactId: artifact.id } },
  })
  const runtime = new CanonicalContextRuntime(store, 'switch-runtime')
  const smallSnapshot = store.getSnapshot(session.activeThreadId)!
  const smallMaterialized = await runtime.materializeForExecution({
    snapshot: smallSnapshot,
    execution: smallTurn.execution,
    provider: 'codex',
  })
  assert.equal(smallMaterialized.items[0]?.kind, 'summary')
  store.finishTurn({ turnId: smallTurn.turn.id, status: 'completed' })

  const largeTurn = store.beginTurn({
    threadId: session.activeThreadId, provider: 'codex', model: 'gpt-large',
    clientRequestId: 'large', requestHash: 'large',
    expectedRevision: store.getThread(session.activeThreadId)!.revision,
    input: [{ kind: 'user_message', payload: { text: 'large-model turn' } }],
    adapterVersion: 'test/1',
    policySnapshot: {
      delegationMode: 'disabled', allowedTools: [], approvalPolicy: 'never', cwd: null,
      maxDepth: 0, capabilityGrant: null,
    },
    budget: { contextCompaction: { viewKey: 'codex-large-budget-v1', artifactId: null } },
  })
  const largeSnapshot = store.getSnapshot(session.activeThreadId)!
  const largeMaterialized = await runtime.materializeForExecution({
    snapshot: largeSnapshot,
    execution: largeTurn.execution,
    provider: 'codex',
  })
  assert.deepEqual(
    largeMaterialized.items.map((item) => item.id),
    largeSnapshot.items.map((item) => item.id),
  )
  assert.equal(largeMaterialized.items.some((item) => item.kind === 'summary'), false)
})

function handshake(contextWindow: number | null): AdapterHandshake {
  return {
    adapterVersion: 'test/1',
    capabilities: {
      roles: ['user', 'assistant'], contentTypes: ['text'], toolCalling: false,
      parallelTools: false, contextWindow, continuation: 'stateless',
      reasoningState: 'portable-summary', taskMetadata: false, nativeChildExecution: 'disabled',
    },
    exposedNativeAgentTools: [],
    enforcementEvidence: {},
  }
}
