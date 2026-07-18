import assert from 'node:assert/strict'
import test from 'node:test'

import { StatelessHttpCanonicalAdapter } from './stateless-http-adapter.ts'
import type { ProviderExecutionContext } from './adapter.ts'
import { DEFAULT_AGENT_LOOP_LIMITS } from './domain.ts'
import type { AgentToolInvocation, AgentToolResult } from './domain.ts'
import type { ThreadSnapshot } from './domain.ts'

function executionContext(overrides: Partial<ProviderExecutionContext> = {}): ProviderExecutionContext {
  return {
    signal: new AbortController().signal,
    toolDefinitions: [],
    limits: DEFAULT_AGENT_LOOP_LIMITS,
    async executeTool() { throw new Error('tool not registered') },
    async denyApproval(): Promise<never> { throw new Error('not used') },
    async denyToolCall(): Promise<never> { throw new Error('not used') },
    ...overrides,
  }
}

const readTool = {
  name: 'read_file',
  description: 'Read a workspace file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  sideEffect: 'read_only' as const,
}

async function collectExecution(adapter: StatelessHttpCanonicalAdapter, execution: Awaited<ReturnType<StatelessHttpCanonicalAdapter['execute']>>) {
  const events = []
  for await (const event of execution.events) events.push(event)
  return { events, terminal: await execution.terminal, adapter }
}

const snapshot: ThreadSnapshot = {
  session: {
    id: 'session-1', title: null, preview: null, activeThreadId: 'thread-1',
    projectKey: null, cwd: null, schemaVersion: 1,
    createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z', archivedAt: null,
    workStatus: 'running',
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
  const execution = await adapter.execute(request, executionContext())
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
  }, snapshot), executionContext())
  for await (const _event of execution.events) { /* drain */ }
  assert.equal(requestedUrl, 'http://proxy/v1/chat/completions')
  assert.equal((await execution.terminal).status, 'completed')
})

test('Claude executes a tool-use round and preserves assistant blocks in the continuation', async () => {
  const bodies: Record<string, unknown>[] = []
  const calls: AgentToolInvocation[] = []
  const replies = [
    {
      id: 'message-tool', model: 'claude-fable-5', stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'I will inspect it.' },
        { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'README.md' } },
      ],
      usage: { input_tokens: 8, output_tokens: 3 },
    },
    {
      id: 'message-final', model: 'claude-opus-4-8', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 5, output_tokens: 2 },
    },
  ]
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'claude',
    proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json(replies.shift())
    },
  })
  const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
    turnId: 'turn-tools', model: 'claude-fable-5', effort: 'high',
    input: [{ kind: 'user_message', payload: { text: 'inspect' } }],
  }, snapshot), executionContext({
    toolDefinitions: [readTool],
    async executeTool(call) {
      calls.push(call)
      return { success: true, content: { text: 'contents' }, error: null }
    },
  })))

  assert.equal(result.terminal.status, 'completed')
  assert.deepEqual(calls, [{
    callId: 'turn-tools:tool-1', providerCallId: 'tool-1', name: 'read_file',
    input: { path: 'README.md' },
  }])
  assert.deepEqual(bodies[0]?.tools, [{
    name: 'read_file', description: 'Read a workspace file', input_schema: readTool.inputSchema,
  }])
  assert.deepEqual(bodies[1]?.messages, [
    { role: 'assistant', content: 'history' },
    { role: 'user', content: 'inspect' },
    { role: 'assistant', content: repliesForAssertionClaudeAssistant },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: JSON.stringify({ text: 'contents' }) }] },
  ])
  const items = adapter.normalize(result.events[0]!)
  assert.deepEqual(items[0]?.payload, {
    text: 'done', requestedModel: 'claude-fable-5', actualModel: 'claude-opus-4-8',
    modelFallback: true, effort: 'high',
  })
  assert.deepEqual(items[1]?.payload, { input_tokens: 13, output_tokens: 5 })
})

const repliesForAssertionClaudeAssistant = [
  { type: 'text', text: 'I will inspect it.' },
  { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'README.md' } },
]

test('Claude executes parallel tools but returns one ordered tool-result user message', async () => {
  const bodies: Record<string, unknown>[] = []
  const completionOrder: string[] = []
  const replies = [
    {
      id: 'parallel', model: 'claude-fable-5', stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'slow', name: 'read_file', input: { path: 'a' } },
        { type: 'tool_use', id: 'fast', name: 'read_file', input: { path: 'b' } },
      ], usage: {},
    },
    { id: 'final', model: 'claude-fable-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: {} },
  ]
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'claude', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json(replies.shift())
    },
  })
  const execution = await adapter.execute(adapter.materialize({
    turnId: 'parallel-turn', model: 'claude-fable-5', input: [{ kind: 'user_message', payload: { text: 'go' } }],
  }, snapshot), executionContext({
    toolDefinitions: [readTool],
    async executeTool(call): Promise<AgentToolResult> {
      if (call.providerCallId === 'slow') await new Promise((resolve) => setTimeout(resolve, 10))
      completionOrder.push(call.providerCallId)
      return call.providerCallId === 'fast'
        ? { success: false, content: null, error: { code: 'missing', message: 'not found', retryable: false } }
        : { success: true, content: { value: 'a' }, error: null }
    },
  }))
  const result = await collectExecution(adapter, execution)
  assert.equal(result.terminal.status, 'completed')
  assert.deepEqual(completionOrder, ['fast', 'slow'])
  const messages = bodies[1]?.messages as Array<Record<string, unknown>>
  assert.deepEqual(messages.at(-1), {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'slow', content: JSON.stringify({ value: 'a' }) },
      { type: 'tool_result', tool_use_id: 'fast', content: JSON.stringify({ code: 'missing', message: 'not found', retryable: false }), is_error: true },
    ],
  })
})

test('Claude replays pause-turn assistant content exactly and continues without a fake user turn', async () => {
  const bodies: Record<string, unknown>[] = []
  const pausedContent = [{ type: 'server_tool_use', id: 'server-1', name: 'web_search', input: { query: 'x' } }]
  const replies = [
    { id: 'paused', model: 'claude-fable-5', stop_reason: 'pause_turn', content: pausedContent, usage: { input_tokens: 2 } },
    { id: 'final', model: 'claude-fable-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'continued' }], usage: { output_tokens: 1 } },
  ]
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'claude', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json(replies.shift())
    },
  })
  const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
    turnId: 'pause', model: 'claude-fable-5', input: [{ kind: 'user_message', payload: { text: 'research' } }],
  }, snapshot), executionContext()))
  assert.equal(result.terminal.status, 'completed')
  const continuationBody = bodies[1]
  assert.ok(continuationBody)
  assert.deepEqual((continuationBody.messages as unknown[]).at(-1), { role: 'assistant', content: pausedContent })
})

for (const stopReason of ['max_tokens', 'model_context_window_exceeded', 'refusal']) {
  test(`Claude does not report ${stopReason} as a completed turn`, async () => {
    const adapter = new StatelessHttpCanonicalAdapter({
      provider: 'claude', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
      fetchImpl: async () => Response.json({
        id: 'incomplete', model: 'claude-fable-5', stop_reason: stopReason,
        content: [{ type: 'text', text: 'partial' }], usage: {},
      }),
    })
    const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
      turnId: 'incomplete', model: 'claude-fable-5', input: [{ kind: 'user_message', payload: { text: 'go' } }],
    }, snapshot), executionContext()))
    assert.equal(result.terminal.status, 'failed')
    assert.match(String(result.terminal.error?.message), new RegExp(stopReason))
  })
}

test('Claude enforces the model round-trip limit before executing an unresumable tool call', async () => {
  let toolExecuted = false
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'claude', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async () => Response.json({
      id: 'tool', model: 'claude-fable-5', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'call', name: 'read_file', input: { path: 'a' } }], usage: {},
    }),
  })
  const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
    turnId: 'limited', model: 'claude-fable-5', input: [{ kind: 'user_message', payload: { text: 'go' } }],
  }, snapshot), executionContext({
    toolDefinitions: [readTool], limits: { ...DEFAULT_AGENT_LOOP_LIMITS, maxModelRoundTrips: 1 },
    async executeTool() { toolExecuted = true; return { success: true, content: {}, error: null } },
  })))
  assert.equal(result.terminal.status, 'failed')
  assert.equal(toolExecuted, false)
  assert.match(String(result.terminal.error?.message), /model round-trip limit/i)
})

test('Gemini executes function calls, returns tool messages, and accumulates usage', async () => {
  const bodies: Record<string, unknown>[] = []
  const replies = [
    {
      id: 'g-tool', model: 'gemini-3.1-pro',
      choices: [{ finish_reason: 'tool_calls', message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'g-call', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
      } }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    },
    {
      id: 'g-final', model: 'gemini-3.1-pro',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    },
  ]
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'gemini', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json(replies.shift())
    },
  })
  const calls: AgentToolInvocation[] = []
  const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
    turnId: 'gemini-tools', model: 'gemini-3.1-pro', effort: 'high',
    input: [{ kind: 'user_message', payload: { text: 'inspect' } }],
  }, snapshot), executionContext({
    toolDefinitions: [readTool],
    async executeTool(call) { calls.push(call); return { success: true, content: { text: 'contents' }, error: null } },
  })))
  assert.equal(result.terminal.status, 'completed')
  assert.deepEqual(calls[0], {
    callId: 'gemini-tools:g-call', providerCallId: 'g-call', name: 'read_file', input: { path: 'README.md' },
  })
  assert.deepEqual(bodies[0]?.tools, [{ type: 'function', function: {
    name: 'read_file', description: 'Read a workspace file', parameters: readTool.inputSchema,
  } }])
  const continuationBody = bodies[1]
  assert.ok(continuationBody)
  assert.deepEqual((continuationBody.messages as unknown[]).slice(-2), [
    { role: 'assistant', content: null, tool_calls: [{ id: 'g-call', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] },
    { role: 'tool', tool_call_id: 'g-call', name: 'read_file', content: JSON.stringify({ text: 'contents' }) },
  ])
  const items = adapter.normalize(result.events[0]!)
  assert.deepEqual(items[1]?.payload, {
    prompt_tokens: 7, completion_tokens: 3, input_tokens: 7, output_tokens: 3,
  })
})

test('Gemini enforces the model round-trip limit before executing function calls', async () => {
  let toolExecuted = false
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'gemini', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async () => Response.json({
      id: 'g-tool', model: 'gemini-3.1-pro',
      choices: [{ finish_reason: 'tool_calls', message: {
        content: null,
        tool_calls: [{ id: 'g-call', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
      } }], usage: {},
    }),
  })
  const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
    turnId: 'g-limited', model: 'gemini-3.1-pro', input: [{ kind: 'user_message', payload: { text: 'go' } }],
  }, snapshot), executionContext({
    toolDefinitions: [readTool], limits: { ...DEFAULT_AGENT_LOOP_LIMITS, maxModelRoundTrips: 1 },
    async executeTool() { toolExecuted = true; return { success: true, content: {}, error: null } },
  })))
  assert.equal(result.terminal.status, 'failed')
  assert.equal(toolExecuted, false)
  assert.match(String(result.terminal.error?.message), /model round-trip limit/i)
})

test('a provider turn timeout fails instead of being misreported as user cancellation', async () => {
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'claude', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }),
  })
  const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
    turnId: 'timeout', model: 'claude-fable-5', input: [{ kind: 'user_message', payload: { text: 'go' } }],
  }, snapshot), executionContext({
    limits: { ...DEFAULT_AGENT_LOOP_LIMITS, turnTimeoutMs: 5 },
  })))
  assert.equal(result.terminal.status, 'failed')
  assert.match(String(result.terminal.error?.message), /exceeded time limit/i)
  assert.equal(result.terminal.error?.code, 'turn_time_limit')
})

test('transient provider failures use the bounded retry budget', async () => {
  let attempts = 0
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'claude', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async () => {
      attempts += 1
      if (attempts === 1) return Response.json({ error: { message: 'busy' } }, { status: 503 })
      return Response.json({
        id: 'retried', model: 'claude-fable-5', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'done' }], usage: {},
      })
    },
  })
  const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
    turnId: 'retry', model: 'claude-fable-5', input: [{ kind: 'user_message', payload: { text: 'go' } }],
  }, snapshot), executionContext({
    limits: { ...DEFAULT_AGENT_LOOP_LIMITS, maxProviderRetries: 1 },
  })))
  assert.equal(result.terminal.status, 'completed')
  assert.equal(attempts, 2)
})

test('retry exhaustion is a typed provider failure', async () => {
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'gemini', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async () => Response.json({ error: { message: 'busy' } }, { status: 503 }),
  })
  const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
    turnId: 'retry-failed', model: 'gemini-3.1-pro',
    input: [{ kind: 'user_message', payload: { text: 'go' } }],
  }, snapshot), executionContext({
    limits: { ...DEFAULT_AGENT_LOOP_LIMITS, maxProviderRetries: 1 },
  })))
  assert.equal(result.terminal.status, 'failed')
  assert.equal(result.terminal.error?.code, 'provider_retry_exhausted')
})

for (const finishReason of ['length', 'content_filter', 'MAX_TOKENS', 'SAFETY']) {
  test(`Gemini does not report ${finishReason} as a completed turn`, async () => {
    const adapter = new StatelessHttpCanonicalAdapter({
      provider: 'gemini', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
      fetchImpl: async () => Response.json({
        id: 'g-incomplete', model: 'gemini-3.1-pro',
        choices: [{ finish_reason: finishReason, message: { content: 'partial' } }], usage: {},
      }),
    })
    const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
      turnId: 'g-incomplete', model: 'gemini-3.1-pro', input: [{ kind: 'user_message', payload: { text: 'go' } }],
    }, snapshot), executionContext()))
    assert.equal(result.terminal.status, 'failed')
    assert.match(String(result.terminal.error?.message), new RegExp(finishReason, 'i'))
  })
}
