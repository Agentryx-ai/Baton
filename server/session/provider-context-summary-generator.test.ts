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
import type { NewCanonicalItem, ThreadSnapshot } from './domain.js'
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
  const prompt = String(adapter.requestSeen?.input[0]?.payload.text)
  assert.match(prompt, /portable user text/)
  assert.match(prompt, /provider_failed/)
  assert.doesNotMatch(prompt, /opaque provider secret/)
})

class SummaryAdapter implements SessionProviderAdapter {
  readonly provider = 'claude' as const
  requestSeen: CanonicalTurnRequest | null = null
  snapshotSeen: ThreadSnapshot | null = null
  contextSeen: ProviderExecutionContext | null = null

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
    this.snapshotSeen = snapshot
  }

  materialize(request: CanonicalTurnRequest): NativeTurnRequest {
    return { body: request }
  }

  async execute(_request: NativeTurnRequest, context: ProviderExecutionContext): Promise<ProviderTurnExecution> {
    this.contextSeen = context
    const events = (async function* (): AsyncIterable<NativeProviderEvent> {
      yield {
        eventId: 'summary', type: 'assistant', durability: 'durable',
        payload: { text: 'portable compact state' },
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
    return [{ kind: 'assistant_message', visibility: 'portable', payload: { text: payload.text } }]
  }

  extractBinding(): null { return null }
  async shutdown(): Promise<void> {}
}

function fixtureSnapshot(): ThreadSnapshot {
  return {
    session: {
      id: 'session', title: null, preview: null, activeThreadId: 'thread', projectKey: null,
      cwd: null, schemaVersion: 1, createdAt: '2026-07-19T00:00:00.000Z',
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
