import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  AdapterHandshake,
  CanonicalTurnRequest,
  NativeProviderEvent,
  NativeTurnRequest,
  ProviderExecutionContext,
  ProviderTurnExecution,
  SessionProviderAdapter,
} from './adapter.js'
import type { CanonicalItem, NewCanonicalItem, ThreadSnapshot } from './domain.js'
import { estimateUtf8Tokens } from './context-materializer.js'
import { ProviderContextSummaryGenerator } from './provider-context-summary-generator.js'

test('provider summary execution is ephemeral, tool-free, and excludes canonical private state', async () => {
  const adapter = new SummaryAdapter()
  const snapshot = fixtureSnapshot()
  const generator = new ProviderContextSummaryGenerator({
    adapter,
    adapterVersion: 'test/1',
    provider: 'claude',
    model: 'claude-test',
    effort: 'high',
    snapshot,
  })
  const result = await generator.generate({
    threadId: snapshot.thread.id,
    sourceItemIds: ['portable'],
    sourceHash: 'a'.repeat(64),
    throughSequence: 1,
    previousSummary: null,
    turns: [{
      id: 'failed-turn', status: 'failed', provider: 'claude', model: 'claude-test', effort: 'high',
      error: { code: 'provider_failed', message: 'terminal failure' },
      startedAt: '2026-07-19T00:00:00.000Z', completedAt: '2026-07-19T00:00:01.000Z',
    }],
    items: [snapshot.items[0]!],
    maximumSummaryTokens: 500,
  })

  assert.equal(result.summary, 'portable compact state')
  assert.equal(result.generator.model, 'claude-test')
  assert.deepEqual(adapter.snapshotSeen?.items, [])
  assert.deepEqual(adapter.snapshotSeen?.bindings, [])
  assert.deepEqual(adapter.contextSeen?.toolDefinitions, [])
  assert.equal(adapter.contextSeen?.limits.maxToolCalls, 0)
  assert.equal(adapter.contextSeen?.limits.turnTimeoutMs, 300_000)
  const prompt = String(adapter.requestSeen?.input[0]?.payload.text)
  assert.match(prompt, /portable user text/)
  assert.match(prompt, /provider_failed/)
  assert.doesNotMatch(prompt, /opaque provider secret/)
})

test('provider summary folds oversized portable history through bounded chronological chunks', async () => {
  const adapter = new SummaryAdapter()
  const snapshot = fixtureSnapshot()
  const items = Array.from({ length: 12 }, (_, index): NewCanonicalItem & { id: string } => ({
    id: `large-${index}`,
    kind: 'tool_result',
    visibility: 'portable',
    provider: 'claude',
    payload: { callId: `call-${index}`, content: 'x'.repeat(6_000) },
  }))
  const canonicalItems: CanonicalItem[] = items.map((item, index) => ({
    ...item,
    visibility: item.visibility ?? 'portable',
    provider: item.provider ?? null,
    sessionId: snapshot.session.id,
    threadId: snapshot.thread.id,
    turnId: 'turn-large',
    sequence: index + 1,
    nativeId: null,
    createdAt: '2026-07-19T00:00:00.000Z',
  }))
  const generator = new ProviderContextSummaryGenerator({
    adapter,
    adapterVersion: 'test/1',
    provider: 'claude',
    model: 'claude-test',
    effort: 'high',
    snapshot,
    inputBudgetTokens: 12_000,
  })

  const result = await generator.generate({
    threadId: snapshot.thread.id,
    sourceItemIds: canonicalItems.map((item) => item.id),
    sourceHash: 'a'.repeat(64),
    throughSequence: canonicalItems.length,
    previousSummary: null,
    turns: [{
      id: 'turn-large', status: 'completed', provider: 'claude', model: 'claude-test', effort: 'high',
      error: null, startedAt: '2026-07-19T00:00:00.000Z', completedAt: '2026-07-19T00:01:00.000Z',
    }],
    items: canonicalItems,
    maximumSummaryTokens: 500,
  })

  assert.equal(result.summary, 'portable compact state')
  assert.ok(adapter.requestsSeen.length > 1)
  assert.equal(adapter.requestsSeen.every((request) =>
    String(request.input[0]?.payload.text).includes('CHUNK ')), true)
  assert.match(String(adapter.requestsSeen[1]?.input[0]?.payload.text), /portable compact state/)
})

test('provider summary retries only the interrupted chunk after a transient stream disconnect', async () => {
  const adapter = new SummaryAdapter(1)
  const snapshot = fixtureSnapshot()
  const generator = new ProviderContextSummaryGenerator({
    adapter,
    adapterVersion: 'test/1',
    provider: 'claude',
    model: 'claude-test',
    effort: 'high',
    snapshot,
  })
  const result = await generator.generate({
    threadId: snapshot.thread.id,
    sourceItemIds: ['portable'],
    sourceHash: 'a'.repeat(64),
    throughSequence: 1,
    previousSummary: null,
    turns: [],
    items: [snapshot.items[0]!],
    maximumSummaryTokens: 500,
  })

  assert.equal(result.summary, 'portable compact state')
  assert.equal(adapter.requestsSeen.length, 2)
  assert.equal(
    adapter.requestsSeen[0]?.input[0]?.payload.text,
    adapter.requestsSeen[1]?.input[0]?.payload.text,
  )
})

test('large target windows use the model budget while keeping each summary prompt bounded', async () => {
  const adapter = new SummaryAdapter()
  const snapshot = fixtureSnapshot()
  const items: CanonicalItem[] = Array.from({ length: 120 }, (_, index) => ({
    id: `bounded-${index}`,
    sessionId: snapshot.session.id,
    threadId: snapshot.thread.id,
    turnId: 'turn-bounded',
    sequence: index + 1,
    kind: 'assistant_message',
    visibility: 'portable',
    provider: 'codex',
    nativeId: null,
    payload: { text: 'x'.repeat(6_000) },
    createdAt: '2026-07-19T00:00:00.000Z',
  }))
  const generator = new ProviderContextSummaryGenerator({
    adapter,
    adapterVersion: 'test/1',
    provider: 'claude',
    model: 'claude-test',
    effort: 'high',
    snapshot,
    inputBudgetTokens: 258_400,
  })
  await generator.generate({
    threadId: snapshot.thread.id,
    sourceItemIds: items.map((item) => item.id),
    sourceHash: 'a'.repeat(64),
    throughSequence: items.length,
    previousSummary: null,
    turns: [{
      id: 'turn-bounded', status: 'completed', provider: 'codex', model: 'gpt-test', effort: 'high',
      error: null, startedAt: '2026-07-19T00:00:00.000Z', completedAt: '2026-07-19T00:01:00.000Z',
    }],
    items,
    maximumSummaryTokens: 8_192,
  })

  assert.ok(adapter.requestsSeen.length > 1)
  assert.equal(adapter.requestsSeen.every((request) =>
    estimateUtf8Tokens(String(request.input[0]?.payload.text)) <= 141_000), true)
})

test('provider summary deterministically bounds oversized output while retaining its beginning and end', async () => {
  const oversized = `BEGIN-${'middle '.repeat(2_000)}-END`
  const adapter = new SummaryAdapter(0, oversized)
  const snapshot = fixtureSnapshot()
  const generator = new ProviderContextSummaryGenerator({
    adapter,
    adapterVersion: 'test/1',
    provider: 'claude',
    model: 'claude-test',
    effort: 'high',
    snapshot,
  })

  const result = await generator.generate({
    threadId: snapshot.thread.id,
    sourceItemIds: ['portable'],
    sourceHash: 'a'.repeat(64),
    throughSequence: 1,
    previousSummary: null,
    turns: [],
    items: [snapshot.items[0]!],
    maximumSummaryTokens: 128,
  })

  assert.ok(estimateUtf8Tokens(result.summary) <= 128)
  assert.match(result.summary, /^BEGIN-/)
  assert.match(result.summary, /-END$/)
  assert.match(result.summary, /middle omitted to enforce Baton summary limit/)
  assert.match(String(adapter.requestSeen?.input[0]?.payload.text), /never exceed 128 tokens/)
})

class SummaryAdapter implements SessionProviderAdapter {
  readonly provider = 'claude' as const
  requestSeen: CanonicalTurnRequest | null = null
  requestsSeen: CanonicalTurnRequest[] = []
  snapshotSeen: ThreadSnapshot | null = null
  contextSeen: ProviderExecutionContext | null = null
  failuresRemaining: number
  readonly responseText: string

  constructor(failuresRemaining = 0, responseText = 'portable compact state') {
    this.failuresRemaining = failuresRemaining
    this.responseText = responseText
  }

  async initialize(): Promise<AdapterHandshake> {
    return {
      adapterVersion: 'test/1',
      capabilities: {
        roles: ['user', 'assistant'], contentTypes: ['text'], toolCalling: false,
        parallelTools: false, contextWindow: 128_000, continuation: 'stateless',
        reasoningState: 'portable-summary', taskMetadata: false, nativeChildExecution: 'disabled',
      },
      exposedNativeAgentTools: [],
      enforcementEvidence: {},
    }
  }

  validate(request: CanonicalTurnRequest, snapshot: ThreadSnapshot): void {
    this.requestSeen = request
    this.requestsSeen.push(request)
    this.snapshotSeen = snapshot
  }

  materialize(request: CanonicalTurnRequest): NativeTurnRequest {
    return { body: request }
  }

  async execute(_request: NativeTurnRequest, context: ProviderExecutionContext): Promise<ProviderTurnExecution> {
    this.contextSeen = context
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1
      return {
        events: (async function* (): AsyncIterable<NativeProviderEvent> {})(),
        terminal: Promise.resolve({
          status: 'failed',
          error: {
            code: 'stream_disconnected',
            message: 'stream disconnected before completion: stream closed before response.completed',
          },
        }),
        steer: async () => ({ status: 'closed' }),
        cancel: async () => undefined,
        dispose: async () => undefined,
      }
    }
    const responseText = this.responseText
    const events = (async function* (): AsyncIterable<NativeProviderEvent> {
      yield {
        eventId: 'summary', type: 'assistant', durability: 'durable',
        payload: { text: responseText },
      }
    })()
    return {
      events,
      terminal: Promise.resolve({ status: 'completed' }),
      steer: async () => ({ status: 'closed' }),
      cancel: async () => undefined,
      dispose: async () => undefined,
    }
  }

  normalize(event: NativeProviderEvent): NewCanonicalItem[] {
    const payload = event.payload as Record<string, unknown>
    return [{ kind: 'assistant_message', payload: { text: payload.text } }]
  }

  extractBinding(): null { return null }
  async shutdown(): Promise<void> {}
}

function fixtureSnapshot(): ThreadSnapshot {
  return {
    session: {
      id: 'session', title: null, preview: null, activeThreadId: 'thread', projectKey: null,
      cwd: null, permissions: { defaultProfile: 'workspace', override: null, effectiveProfile: 'workspace', source: 'global' },
      schemaVersion: 1, createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z', archivedAt: null, workStatus: 'idle', source: null,
    },
    thread: {
      id: 'thread', sessionId: 'session', parentThreadId: null, forkTurnId: null,
      forkItemId: null, status: 'idle', revision: 0, instructionSnapshot: { secret: 'do not reuse' },
      createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z',
    },
    turns: [],
    items: [
      {
        id: 'portable', sessionId: 'session', threadId: 'thread', turnId: null, sequence: 1,
        kind: 'user_message', visibility: 'portable', payload: { text: 'portable user text' },
        provider: null, nativeId: null, createdAt: '2026-07-19T00:00:00.000Z',
      },
      {
        id: 'private', sessionId: 'session', threadId: 'thread', turnId: null, sequence: 2,
        kind: 'provider_event', visibility: 'provider_private', payload: { text: 'opaque provider secret' },
        provider: 'claude', nativeId: null, createdAt: '2026-07-19T00:00:00.000Z',
      },
    ],
    bindings: [{
      id: 'binding', threadId: 'thread', provider: 'claude', modelFamily: 'claude-test',
      nativeThreadId: 'private-native-id', nativeResponseId: null, opaqueStateEncrypted: null,
      syncedRevision: 0, contextDigest: '', capabilities: {
        roles: ['user', 'assistant'], contentTypes: ['text'], toolCalling: false,
        parallelTools: false, contextWindow: 128_000, continuation: 'stateless',
        reasoningState: 'portable-summary', taskMetadata: false, nativeChildExecution: 'disabled',
      }, invalidatedAt: null,
      updatedAt: '2026-07-19T00:00:00.000Z',
    }],
    followUps: [],
    goal: null,
  }
}
