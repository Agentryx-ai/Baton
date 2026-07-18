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

function normalizedItems(adapter: StatelessHttpCanonicalAdapter, events: Array<{ eventId: string | null; type: string; payload: unknown; durability: 'durable' | 'ephemeral' }>) {
  return events.flatMap((event) => adapter.normalize(event))
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

test('Claude adapter sends stateless history and records a provider-reported model fallback', async () => {
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
  const items = normalizedItems(adapter, events)
  const assistant = items.find((item) => item.kind === 'assistant_message')
  assert.deepEqual(assistant?.payload, {
    text: 'answer',
    requestedModel: 'claude-fable-5',
    reportedModel: 'claude-opus-4-8',
    modelFallback: true,
    modelProvenance: 'provider_reported',
    effort: 'high',
  })
  const completed = events.find((event) => event.type === 'response/completed')
  assert.ok(completed)
  assert.equal(adapter.extractBinding(completed)?.modelFamily, 'claude-opus-4-8')
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
  const items = normalizedItems(adapter, result.events)
  const assistant = items.find((item) => item.kind === 'assistant_message')
  assert.deepEqual(assistant?.payload, {
    text: 'done', requestedModel: 'claude-fable-5', reportedModel: 'claude-opus-4-8',
    modelFallback: true, modelProvenance: 'provider_reported', effort: 'high',
  })
  assert.deepEqual(items.find((item) => item.kind === 'usage')?.payload, { input_tokens: 13, output_tokens: 5 })
  assert.deepEqual(
    items.filter((item) => item.kind === 'provider_event').map((item) => item.payload),
    [
      {
        round: 1, responseId: 'message-tool', requestedModel: 'claude-fable-5',
        reportedModel: 'claude-fable-5', stopReason: 'tool_use', toolDecision: true,
      },
      {
        round: 2, responseId: 'message-final', requestedModel: 'claude-fable-5',
        reportedModel: 'claude-opus-4-8', stopReason: 'end_turn', toolDecision: false,
      },
    ],
  )
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
      { type: 'tool_result', tool_use_id: 'fast', content: JSON.stringify({ error: { code: 'missing', message: 'not found', retryable: false } }), is_error: true },
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
  const items = normalizedItems(adapter, result.events)
  assert.deepEqual(items.find((item) => item.kind === 'usage')?.payload, {
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
    // Deliberately ignore AbortSignal to verify the adapter-level deadline race.
    fetchImpl: async () => new Promise<Response>(() => undefined),
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

test('tool exceptions become ordered provider error results without dropping later calls', async () => {
  const bodies: Record<string, unknown>[] = []
  const replies = [
    {
      id: 'partial-batch', model: 'claude-fable-5', stop_reason: 'tool_use', usage: {},
      content: [
        { type: 'tool_use', id: 'fails', name: 'read_file', input: { path: 'a' } },
        { type: 'tool_use', id: 'continues', name: 'read_file', input: { path: 'b' } },
      ],
    },
    { id: 'partial-final', model: 'claude-fable-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: {} },
  ]
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'claude', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json(replies.shift())
    },
  })
  const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
    turnId: 'partial-batch', model: 'claude-fable-5',
    input: [{ kind: 'user_message', payload: { text: 'go' } }],
  }, snapshot), executionContext({
    toolDefinitions: [readTool],
    async executeTool(call) {
      if (call.providerCallId === 'fails') throw new Error('sandbox unavailable')
      return { success: true, content: { text: 'still ran' }, error: null }
    },
  })))
  assert.equal(result.terminal.status, 'completed')
  const continuation = bodies[1]?.messages
  assert.ok(Array.isArray(continuation))
  const resultMessage = continuation.at(-1) as Record<string, unknown>
  const blocks = resultMessage.content as Array<Record<string, unknown>>
  assert.deepEqual(blocks.map((block) => [block.tool_use_id, block.is_error === true]), [
    ['fails', true],
    ['continues', false],
  ])
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

test('user cancellation wins immediately over a same-tick late provider completion', async () => {
  let resolveFetch!: (response: Response) => void
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'claude', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async () => new Promise<Response>((resolve) => { resolveFetch = resolve }),
  })
  const execution = await adapter.execute(adapter.materialize({
    turnId: 'cancel-race', model: 'claude-fable-5',
    input: [{ kind: 'user_message', payload: { text: 'go' } }],
  }, snapshot), executionContext())

  const cancellation = execution.cancel()
  resolveFetch(Response.json({
    id: 'too-late', model: 'claude-fable-5', stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'must not persist' }], usage: {},
  }))
  await cancellation
  const result = await collectExecution(adapter, execution)
  assert.equal(result.terminal.status, 'cancelled')
  assert.equal(result.events.some((event) => event.type === 'response/completed'), false)
})

test('provider retries are capped across the entire multi-round turn', async () => {
  let attempts = 0
  const replies = [
    Response.json({ error: { message: 'busy-one' } }, { status: 503 }),
    Response.json({
      id: 'tool-round', model: 'claude-fable-5', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'read', name: 'read_file', input: { path: 'README.md' } }], usage: {},
    }),
    Response.json({ error: { message: 'busy-two' } }, { status: 503 }),
  ]
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'claude', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async () => { attempts += 1; return replies.shift()! },
  })
  const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
    turnId: 'global-retry-budget', model: 'claude-fable-5',
    input: [{ kind: 'user_message', payload: { text: 'go' } }],
  }, snapshot), executionContext({
    toolDefinitions: [readTool],
    limits: { ...DEFAULT_AGENT_LOOP_LIMITS, maxProviderRetries: 1 },
    async executeTool() { return { success: true, content: { text: 'ok' }, error: null } },
  })))
  assert.equal(result.terminal.status, 'failed')
  assert.equal(result.terminal.error?.code, 'provider_retry_exhausted')
  assert.equal(attempts, 3)
})

test('mixed tool batches are forwarded once in provider order for authoritative coordinator scheduling', async () => {
  const mutationTool = { ...readTool, name: 'write_file', sideEffect: 'workspace_mutation' as const }
  const commandTool = { ...readTool, name: 'run_command', sideEffect: 'workspace_command' as const }
  const calls: string[] = []
  const bodies: Record<string, unknown>[] = []
  const replies = [
    {
      id: 'mixed', model: 'claude-fable-5', stop_reason: 'tool_use', usage: {},
      content: [
        { type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'a' } },
        { type: 'tool_use', id: 'read-2', name: 'read_file', input: { path: 'b' } },
        { type: 'tool_use', id: 'write-1', name: 'write_file', input: { path: 'c' } },
        { type: 'tool_use', id: 'read-3', name: 'read_file', input: { path: 'd' } },
        { type: 'tool_use', id: 'command-1', name: 'run_command', input: { path: 'e' } },
      ],
    },
    { id: 'mixed-final', model: 'claude-fable-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: {} },
  ]
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'claude', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json(replies.shift())
    },
  })
  const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
    turnId: 'mixed-tools', model: 'claude-fable-5',
    input: [{ kind: 'user_message', payload: { text: 'go' } }],
  }, snapshot), executionContext({
    toolDefinitions: [readTool, mutationTool, commandTool],
    async executeTool(call) {
      calls.push(call.providerCallId)
      if (call.providerCallId === 'read-1') await new Promise((resolve) => setTimeout(resolve, 10))
      return { success: true, content: { id: call.providerCallId }, error: null }
    },
  })))
  assert.equal(result.terminal.status, 'completed')
  assert.deepEqual(calls, ['read-1', 'read-2', 'write-1', 'read-3', 'command-1'])
  const continuation = bodies[1]?.messages
  assert.ok(Array.isArray(continuation))
  const resultMessage = continuation.at(-1) as Record<string, unknown>
  const blocks = resultMessage.content as Array<Record<string, unknown>>
  assert.deepEqual(blocks.map((block) => block.tool_use_id), calls)
})

for (const provider of ['claude', 'gemini'] as const) {
  test(`${provider} rejects duplicate provider tool-call ids without executing either call`, async () => {
    let executions = 0
    const payload = provider === 'claude'
      ? {
          id: 'duplicate', model: 'claude-fable-5', stop_reason: 'tool_use', usage: {},
          content: [
            { type: 'tool_use', id: 'same', name: 'read_file', input: { path: 'a' } },
            { type: 'tool_use', id: 'same', name: 'read_file', input: { path: 'b' } },
          ],
        }
      : {
          id: 'duplicate', model: 'gemini-3.1-pro', usage: {},
          choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
            { id: 'same', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
            { id: 'same', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"}' } },
          ] } }],
        }
    const adapter = new StatelessHttpCanonicalAdapter({
      provider, proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
      fetchImpl: async () => Response.json(payload),
    })
    const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
      turnId: `${provider}-duplicate`, model: provider === 'claude' ? 'claude-fable-5' : 'gemini-3.1-pro',
      input: [{ kind: 'user_message', payload: { text: 'go' } }],
    }, snapshot), executionContext({
      toolDefinitions: [readTool],
      async executeTool() { executions += 1; return { success: true, content: {}, error: null } },
    })))
    assert.equal(result.terminal.status, 'failed')
    assert.equal(result.terminal.error?.code, 'provider_duplicate_tool_id')
    assert.equal(executions, 0)
  })
}

test('tool output byte limits produce a bounded provider-contract error', async () => {
  const bodies: Record<string, unknown>[] = []
  const replies = [
    {
      id: 'large-tool', model: 'claude-fable-5', stop_reason: 'tool_use', usage: {},
      content: [{ type: 'tool_use', id: 'large', name: 'read_file', input: { path: 'a' } }],
    },
    { id: 'large-final', model: 'claude-fable-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: {} },
  ]
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'claude', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json(replies.shift())
    },
  })
  const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
    turnId: 'large-output', model: 'claude-fable-5',
    input: [{ kind: 'user_message', payload: { text: 'go' } }],
  }, snapshot), executionContext({
    toolDefinitions: [readTool],
    limits: { ...DEFAULT_AGENT_LOOP_LIMITS, toolOutputBytes: 64 },
    async executeTool() { return { success: true, content: { text: 'x'.repeat(1_000) }, error: null } },
  })))
  assert.equal(result.terminal.status, 'completed')
  const continuation = bodies[1]?.messages
  assert.ok(Array.isArray(continuation))
  const resultMessage = continuation.at(-1)
  assert.ok(resultMessage && typeof resultMessage === 'object')
  const resultContent = (resultMessage as Record<string, unknown>).content
  assert.ok(Array.isArray(resultContent))
  const resultBlock = resultContent[0] as Record<string, unknown>
  assert.equal(resultBlock.is_error, true)
  assert.ok(new TextEncoder().encode(String(resultBlock.content)).byteLength <= 64)
})
