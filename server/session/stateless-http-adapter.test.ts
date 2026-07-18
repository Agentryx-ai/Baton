import assert from 'node:assert/strict'
import test from 'node:test'

import { StatelessHttpCanonicalAdapter } from './stateless-http-adapter.ts'
import type { ThreadSnapshot } from './domain.ts'

const snapshot: ThreadSnapshot = {
  session: {
    id: 'session-1', title: null, preview: null, activeThreadId: 'thread-1',
    projectKey: null, cwd: null, schemaVersion: 1,
    createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z', archivedAt: null,
  },
  thread: {
    id: 'thread-1', sessionId: 'session-1', parentThreadId: null, forkTurnId: null,
    forkItemId: null, revision: 1, status: 'running', instructionSnapshot: {},
    createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
  },
  turns: [],
  items: [{
    id: 'item-1', sessionId: 'session-1', threadId: 'thread-1', turnId: 'old-turn',
    sequence: 1, kind: 'assistant_message', visibility: 'portable', payload: { text: 'history' },
    provider: 'codex', nativeId: null, createdAt: '2026-07-18T00:00:00.000Z',
  }],
  bindings: [],
}

test('Claude adapter sends stateless history and records an actual-model fallback', async () => {
  const sentBodies: Record<string, unknown>[] = []
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'claude',
    proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json({
        id: 'message-1',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'answer' }],
        usage: { input_tokens: 10, output_tokens: 2 },
      })
    },
  })

  const handshake = await adapter.initialize()
  assert.equal(handshake.capabilities.nativeChildExecution, 'disabled')
  assert.deepEqual(handshake.exposedNativeAgentTools, [])
  const request = adapter.materialize({
    turnId: 'turn-1',
    model: 'claude-fable-5',
    effort: 'high',
    input: [{ kind: 'user_message', payload: { text: 'question' } }],
  }, snapshot)
  const execution = await adapter.execute(request, {
    signal: new AbortController().signal,
    async denyApproval() { throw new Error('not used') },
    async denyToolCall() { throw new Error('not used') },
  })
  const events = []
  for await (const event of execution.events) events.push(event)
  const sentBody = sentBodies[0]
  assert.ok(sentBody)
  assert.equal((sentBody.output_config as Record<string, unknown>).effort, 'high')
  assert.deepEqual(sentBody.messages, [
    { role: 'assistant', content: 'history' },
    { role: 'user', content: 'question' },
  ])
  assert.equal((await execution.terminal).status, 'completed')
  const items = adapter.normalize(events[0]!)
  assert.deepEqual(items[0]?.payload, {
    text: 'answer',
    requestedModel: 'claude-fable-5',
    actualModel: 'claude-opus-4-8',
    modelFallback: true,
    effort: 'high',
  })
  assert.equal(adapter.extractBinding(events[0]!)?.modelFamily, 'claude-opus-4-8')
})

test('Gemini adapter uses the proxy compatibility route without native tools', async () => {
  let requestedUrl = ''
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'gemini',
    proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async (url) => {
      requestedUrl = String(url)
      return Response.json({
        id: 'response-1', model: 'gemini-3.1-pro',
        choices: [{ message: { content: 'answer' } }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      })
    },
  })
  const execution = await adapter.execute(adapter.materialize({
    turnId: 'turn-2', model: 'gemini-3.1-pro', effort: null,
    input: [{ kind: 'user_message', payload: { text: 'question' } }],
  }, snapshot), {
    signal: new AbortController().signal,
    async denyApproval() { throw new Error('not used') },
    async denyToolCall() { throw new Error('not used') },
  })
  for await (const _event of execution.events) { /* drain */ }
  assert.equal(requestedUrl, 'http://proxy/v1/chat/completions')
  assert.equal((await execution.terminal).status, 'completed')
})
