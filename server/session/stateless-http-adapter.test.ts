import assert from 'node:assert/strict'
import test from 'node:test'

import { StatelessHttpCanonicalAdapter } from './stateless-http-adapter.ts'
import type { ProviderExecutionContext } from './adapter.ts'
import { DEFAULT_AGENT_LOOP_LIMITS } from './domain.ts'
import type { AgentToolInvocation, AgentToolResult, NewCanonicalItem } from './domain.ts'
import type { ThreadSnapshot } from './domain.ts'
import type { ImageArtifactRef } from './image-artifacts.ts'

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

const TEST_IMAGE: ImageArtifactRef = {
  id: `sha256-${'b'.repeat(64)}`,
  sha256: 'b'.repeat(64),
  mediaType: 'image/png',
  byteLength: 67,
  width: 1,
  height: 1,
  fileName: 'screen.png',
  source: 'upload',
}

async function collectExecution(adapter: StatelessHttpCanonicalAdapter, execution: Awaited<ReturnType<StatelessHttpCanonicalAdapter['execute']>>) {
  const events = []
  for await (const event of execution.events) events.push(event)
  return { events, terminal: await execution.terminal, adapter }
}

function normalizedItems(adapter: StatelessHttpCanonicalAdapter, events: Array<{ eventId: string | null; type: string; payload: unknown; durability: 'durable' | 'ephemeral' }>) {
  return events.flatMap((event) => adapter.normalize(event))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function snapshotWithPriorTurn(items: NewCanonicalItem[]): ThreadSnapshot {
  return {
    ...snapshot,
    items: [
      {
        ...snapshot.items[0]!,
        id: 'prior-user',
        turnId: 'prior-turn',
        sequence: 1,
        kind: 'user_message',
        visibility: 'portable',
        payload: { text: 'go' },
        provider: null,
      },
      ...items.map((item, index) => ({
        ...snapshot.items[0]!,
        id: `prior-item-${index + 2}`,
        turnId: 'prior-turn',
        sequence: index + 2,
        kind: item.kind,
        visibility: item.visibility ?? 'portable',
        payload: item.payload,
        provider: item.provider ?? null,
        nativeId: item.nativeId ?? null,
      })),
    ],
  }
}

const snapshot: ThreadSnapshot = {
  session: {
    id: 'session-1', title: null, preview: null, activeThreadId: 'thread-1',
    projectKey: null, cwd: null,
    permissions: { defaultProfile: 'workspace', override: null, effectiveProfile: 'workspace', source: 'global' },
    schemaVersion: 1,
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
        stop_reason: 'end_turn',
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
  }, {
    ...snapshot,
    thread: { ...snapshot.thread, instructionSnapshot: { developerInstructions: 'Verify before finishing.' } },
  })
  const execution = await adapter.execute(request, executionContext())
  const events = []
  for await (const event of execution.events) events.push(event)
  const sentBody = sentBodies[0]
  assert.ok(sentBody)
  assert.equal((sentBody.output_config as Record<string, unknown>).effort, 'high')
  assert.deepEqual(sentBody.cache_control, { type: 'ephemeral' })
  assert.equal(sentBody.system, 'Verify before finishing.')
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

test('Claude and Gemini hydrate canonical image refs only at the outbound multimodal boundary', async () => {
  for (const provider of ['claude', 'gemini'] as const) {
    const sentBodies: Record<string, unknown>[] = []
    const adapter = new StatelessHttpCanonicalAdapter({
      provider,
      proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
      imageArtifacts: {
        pathFor: () => 'C:/Baton/image-artifacts/screen.png',
        dataUrl: () => 'data:image/png;base64,AAAA',
      },
      fetchImpl: async (_url, init) => {
        sentBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return provider === 'claude'
          ? Response.json({
              id: 'message-image', model: 'claude-opus-4-8', stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'seen' }], usage: {},
            })
          : Response.json({
              id: 'response-image', model: 'gemini-2.5-pro', usage: {},
              choices: [{ finish_reason: 'stop', message: { content: 'seen' } }],
            })
      },
    })
    const materialized = adapter.materialize({
      turnId: `image-${provider}`,
      model: provider === 'claude' ? 'claude-opus-4-8' : 'gemini-2.5-pro',
      input: [{ kind: 'user_message', payload: { attachments: [TEST_IMAGE] } }],
    }, { ...snapshot, items: [] })
    assert.match(JSON.stringify(materialized.body), /baton_image/)
    assert.doesNotMatch(JSON.stringify(materialized.body), /base64,AAAA/)
    const execution = await adapter.execute(materialized, executionContext())
    await collectExecution(adapter, execution)
    const messages = sentBodies[0]?.messages as Array<Record<string, unknown>>
    const user = messages.find((message) => message.role === 'user')
    assert.ok(user)
    const wire = JSON.stringify(user.content)
    assert.match(wire, /AAAA/)
    assert.doesNotMatch(wire, /baton_image/)
    await adapter.shutdown()
  }
})

test('stateless adapters preserve portable reasoning, plan, task, and summary history', () => {
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'claude',
    proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
  })
  const projected = adapter.materialize({
    turnId: 'turn-portable-history',
    model: 'claude-opus-4-8',
    effort: 'high',
    input: [{ kind: 'user_message', payload: { text: 'next' } }],
  }, {
    ...snapshot,
    items: [
      { ...snapshot.items[0]!, id: 'reasoning', kind: 'reasoning_summary', payload: { summary: ['checked', 'verified'] } },
      { ...snapshot.items[0]!, id: 'plan', sequence: 2, kind: 'plan', payload: { text: 'ship it' } },
      { ...snapshot.items[0]!, id: 'task', sequence: 3, kind: 'task', payload: { plan: [{ step: 'test', status: 'completed' }] } },
      { ...snapshot.items[0]!, id: 'summary', sequence: 4, kind: 'summary', payload: { text: 'prior summary' } },
    ],
  })

  assert.deepEqual((projected.body as { messages: unknown }).messages, [
    { role: 'assistant', content: '[Reasoning summary]\nchecked\nverified\n\n[Plan]\nship it\n\n[Plan]\n[{"step":"test","status":"completed"}]\n\nprior summary' },
    { role: 'user', content: 'next' },
  ])
})

test('Gemini adapter uses the proxy compatibility route without native tools', async () => {
  let requestedUrl = ''
  const sentBodies: Record<string, unknown>[] = []
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'gemini',
    proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async (url, init) => {
      requestedUrl = String(url)
      sentBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json({
        id: 'response-1', model: 'gemini-3.1-pro',
        choices: [{ finish_reason: 'stop', message: { content: 'answer' } }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      })
    },
  })
  const execution = await adapter.execute(adapter.materialize({
    turnId: 'turn-2', model: 'gemini-3.1-pro', effort: null,
    input: [{ kind: 'user_message', payload: { text: 'question' } }],
  }, {
    ...snapshot,
    thread: { ...snapshot.thread, instructionSnapshot: { developerInstructions: 'Use the canonical plan.' } },
  }), executionContext())
  for await (const _event of execution.events) { /* drain */ }
  assert.equal(requestedUrl, 'http://proxy/v1/chat/completions')
  assert.ok(sentBodies[0])
  assert.equal(sentBodies[0].cache_control, undefined)
  assert.deepEqual((sentBodies[0].messages as unknown[])[0], {
    role: 'system', content: 'Use the canonical plan.',
  })
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
  assert.deepEqual(items.filter((item) => item.kind === 'usage').map((item) => item.payload), [
    {
      input_tokens: 8, output_tokens: 3, round: 1,
      usageProvenance: 'provider_rounds_cumulative',
    },
    {
      input_tokens: 13, output_tokens: 5, round: 2,
      usageProvenance: 'provider_rounds_cumulative',
    },
    { input_tokens: 13, output_tokens: 5 },
  ])
  assert.deepEqual(
    items.filter((item) => item.kind === 'provider_event' && item.visibility === 'baton_private')
      .map((item) => item.payload),
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
  assert.deepEqual(items.find((item) => item.visibility === 'provider_private')?.payload, {
    stateVersion: 1,
    round: 1,
    assistant: { role: 'assistant', content: repliesForAssertionClaudeAssistant },
    toolResults: [{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: JSON.stringify({ text: 'contents' }) }],
    }],
  })
})

const repliesForAssertionClaudeAssistant = [
  { type: 'text', text: 'I will inspect it.' },
  { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'README.md' } },
]

test('Claude tool screenshots are hydrated on wire while durable continuation keeps only artifact refs', async () => {
  const bodies: Record<string, unknown>[] = []
  const replies = [
    {
      id: 'tool-image', model: 'claude-opus-4-8', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'capture-1', name: 'ldplayer_capture', input: {} }], usage: {},
    },
    {
      id: 'tool-image-final', model: 'claude-opus-4-8', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'inspected' }], usage: {},
    },
  ]
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'claude',
    proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    imageArtifacts: {
      pathFor: () => 'C:/Baton/image-artifacts/screen.png',
      dataUrl: () => 'data:image/png;base64,AAAA',
    },
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json(replies.shift())
    },
  })
  const captureTool = { ...readTool, name: 'ldplayer_capture', inputSchema: { type: 'object', properties: {} } }
  const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
    turnId: 'tool-image-turn', model: 'claude-opus-4-8',
    input: [{ kind: 'user_message', payload: { text: 'capture' } }],
  }, snapshot), executionContext({
    toolDefinitions: [captureTool],
    async executeTool() {
      return { success: true, content: { artifact: TEST_IMAGE }, images: [TEST_IMAGE], error: null }
    },
  })))

  assert.ok(bodies[1])
  const secondWire = JSON.stringify((bodies[1].messages as unknown[]).at(-1))
  assert.match(secondWire, /"type":"image"/)
  assert.match(secondWire, /AAAA/)
  const privateState = normalizedItems(adapter, result.events)
    .find((item) => item.visibility === 'provider_private')?.payload
  assert.match(JSON.stringify(privateState), /baton_image/)
  assert.doesNotMatch(JSON.stringify(privateState), /base64,AAAA/)
})

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

test('Claude durably preserves and bounds text-only max_tokens continuations', async () => {
  const bodies: Record<string, unknown>[] = []
  const replies = [
    { id: 'chunk-1', model: 'claude-fable-5', stop_reason: 'max_tokens', content: [{ type: 'text', text: 'part one ' }], usage: { output_tokens: 2 } },
    { id: 'chunk-2', model: 'claude-fable-5', stop_reason: 'max_tokens', content: [{ type: 'text', text: 'part two ' }], usage: { output_tokens: 2 } },
    { id: 'final', model: 'claude-fable-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { output_tokens: 1 } },
  ]
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'claude', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json(replies.shift())
    },
  })
  const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
    turnId: 'max-output', model: 'claude-fable-5', input: [{ kind: 'user_message', payload: { text: 'go' } }],
  }, snapshot), executionContext()))

  assert.equal(result.terminal.status, 'completed')
  assert.equal(bodies.length, 3)
  assert.ok(bodies[1])
  assert.deepEqual((bodies[1].messages as unknown[]).slice(-2), [
    { role: 'assistant', content: [{ type: 'text', text: 'part one ' }] },
    { role: 'user', content: 'Please continue from where you left off.' },
  ])
  const items = normalizedItems(adapter, result.events)
  assert.deepEqual(items.filter((item) => item.kind === 'assistant_message').map((item) => item.payload.text), [
    'part one ', 'part two ', 'done',
  ])
  assert.equal(items.filter((item) => item.kind === 'assistant_message')[0]?.payload.incomplete, true)
  const privateState = items.find((item) => item.visibility === 'provider_private')
  assert.deepEqual(privateState?.payload.followUp, {
    role: 'user', content: 'Please continue from where you left off.',
  })
})

for (const stopReason of ['pause_turn', 'max_tokens'] as const) {
  test(`Claude durably records a final allowed ${stopReason} round without a phantom follow-up`, async () => {
    let requests = 0
    const adapter = new StatelessHttpCanonicalAdapter({
      provider: 'claude', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
      fetchImpl: async () => {
        requests += 1
        return Response.json({
          id: `final-${stopReason}`, model: 'claude-fable-5', stop_reason: stopReason,
          content: [{ type: 'text', text: 'durable partial' }],
          usage: { input_tokens: 4, output_tokens: 7 },
        })
      },
    })
    const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
      turnId: `final-${stopReason}`, model: 'claude-fable-5',
      input: [{ kind: 'user_message', payload: { text: 'go' } }],
    }, snapshot), executionContext({
      limits: { ...DEFAULT_AGENT_LOOP_LIMITS, maxModelRoundTrips: 1 },
    })))

    assert.equal(requests, 1)
    assert.equal(result.terminal.status, 'failed')
    assert.equal(result.terminal.error?.code, 'model_round_limit')
    const roundEvents = result.events.filter((event) => event.type === 'response/model-round')
    assert.equal(roundEvents.length, 1)
    const items = normalizedItems(adapter, result.events)
    assert.deepEqual(items.filter((item) => item.kind === 'usage').map((item) => item.payload), [{
      input_tokens: 4,
      output_tokens: 7,
      round: 1,
      usageProvenance: 'provider_rounds_cumulative',
    }])
    const continuation = items.find((item) => item.visibility === 'provider_private')
    assert.ok(continuation)
    assert.equal('followUp' in continuation.payload, false)
    assert.equal(
      items.filter((item) => item.kind === 'assistant_message').length,
      stopReason === 'max_tokens' ? 1 : 0,
    )
  })
}

test('Claude retries an incomplete tool call with only max_tokens changed and executes only the complete call', async () => {
  const bodies: Record<string, unknown>[] = []
  let toolExecutions = 0
  const replies = [
    {
      id: 'truncated-1', model: 'claude-fable-5', stop_reason: 'max_tokens',
      content: [{ type: 'tool_use', id: 'partial-1', name: 'read_file', input: {} }],
      usage: { input_tokens: 5, output_tokens: 4 },
    },
    {
      id: 'truncated-2', model: 'claude-fable-5', stop_reason: 'max_tokens',
      content: [{ type: 'tool_use', id: 'partial-2', name: 'read_file', input: { path: 'partial' } }],
      usage: { input_tokens: 5, output_tokens: 8 },
    },
    {
      id: 'complete-tool', model: 'claude-fable-5', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'complete', name: 'read_file', input: { path: 'README.md' } }],
      usage: { input_tokens: 5, output_tokens: 3 },
    },
    {
      id: 'complete-answer', model: 'claude-fable-5', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 3, output_tokens: 1 },
    },
  ]
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'claude', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json(replies.shift())
    },
  })
  const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
    turnId: 'retry-tool', model: 'claude-fable-5',
    input: [{ kind: 'user_message', payload: { text: 'inspect' } }],
  }, {
    ...snapshot,
    thread: { ...snapshot.thread, instructionSnapshot: { developerInstructions: 'Stay exact.' } },
  }), executionContext({
    toolDefinitions: [readTool],
    async executeTool(call) {
      toolExecutions += 1
      assert.equal(call.providerCallId, 'complete')
      return { success: true, content: { text: 'contents' }, error: null }
    },
  })))

  assert.equal(result.terminal.status, 'completed')
  assert.equal(toolExecutions, 1)
  assert.deepEqual(bodies.map((body) => body.max_tokens), [16_384, 32_768, 65_536, 16_384])
  for (const body of bodies.slice(1, 3)) {
    assert.deepEqual(body.messages, bodies[0]?.messages)
    assert.deepEqual(body.tools, bodies[0]?.tools)
    assert.equal(body.system, bodies[0]?.system)
    assert.equal(body.model, bodies[0]?.model)
  }
  const items = normalizedItems(adapter, result.events)
  assert.deepEqual(
    items.filter((item) => item.kind === 'assistant_message').map((item) => item.payload.text),
    ['done'],
  )
  assert.equal(items.filter((item) => item.visibility === 'provider_private').length, 1)
  assert.equal(items.filter((item) => item.kind === 'usage').length, 5)
})

test('Claude stops incomplete tool retries at the declared max_tokens cap', async () => {
  const maxTokens: unknown[] = []
  let toolExecutions = 0
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'claude', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      maxTokens.push(body.max_tokens)
      return Response.json({
        id: `partial-${maxTokens.length}`, model: 'claude-fable-5', stop_reason: 'max_tokens',
        content: [{ type: 'tool_use', id: `partial-${maxTokens.length}`, name: 'read_file', input: {} }],
        usage: { output_tokens: 1 },
      })
    },
  })
  const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
    turnId: 'retry-tool-cap', model: 'claude-fable-5',
    input: [{ kind: 'user_message', payload: { text: 'inspect' } }],
  }, snapshot), executionContext({
    toolDefinitions: [readTool],
    async executeTool() {
      toolExecutions += 1
      return { success: true, content: {}, error: null }
    },
  })))

  assert.deepEqual(maxTokens, [16_384, 32_768, 65_536])
  assert.equal(toolExecutions, 0)
  assert.equal(result.terminal.status, 'failed')
  assert.equal(result.terminal.error?.code, 'provider_incomplete_tool_call')
  const items = normalizedItems(adapter, result.events)
  assert.equal(items.filter((item) => item.kind === 'usage').length, 3)
  assert.equal(items.filter((item) => item.kind === 'assistant_message').length, 0)
  assert.equal(items.filter((item) => item.visibility === 'provider_private').length, 0)
})

test('stateless history replays same-provider continuation blocks exactly and ports aggregate text without separators', async () => {
  const firstChunk = [
    { type: 'thinking', thinking: 'private reasoning', signature: 'signed' },
    { type: 'text', text: 'part one ' },
  ]
  const replies = [
    { id: 'chunk-1', model: 'claude-fable-5', stop_reason: 'max_tokens', content: firstChunk, usage: {} },
    { id: 'chunk-2', model: 'claude-fable-5', stop_reason: 'max_tokens', content: [{ type: 'text', text: 'part two ' }], usage: {} },
    { id: 'final', model: 'claude-fable-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: {} },
  ]
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'claude', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async () => Response.json(replies.shift()),
  })
  const prior = await collectExecution(adapter, await adapter.execute(adapter.materialize({
    turnId: 'prior-turn', model: 'claude-fable-5',
    input: [{ kind: 'user_message', payload: { text: 'go' } }],
  }, { ...snapshot, items: [] }), executionContext()))
  assert.equal(prior.terminal.status, 'completed')
  const priorSnapshot = snapshotWithPriorTurn(normalizedItems(adapter, prior.events))

  const replayBodies: Record<string, unknown>[] = []
  const replayAdapter = new StatelessHttpCanonicalAdapter({
    provider: 'claude', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async (_url, init) => {
      replayBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json({
        id: 'replay-final', model: 'claude-fable-5', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'second turn done' }], usage: {},
      })
    },
  })
  const sameProvider = replayAdapter.materialize({
    turnId: 'same-provider', model: 'claude-fable-5',
    input: [{ kind: 'user_message', payload: { text: 'next' } }],
  }, priorSnapshot)
  const exactReplay = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: firstChunk },
    { role: 'user', content: 'Please continue from where you left off.' },
    { role: 'assistant', content: [{ type: 'text', text: 'part two ' }] },
    { role: 'user', content: 'Please continue from where you left off.' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'next' },
  ]
  assert.deepEqual((sameProvider.body as { messages: unknown }).messages, exactReplay)
  const replay = await collectExecution(replayAdapter, await replayAdapter.execute(
    sameProvider,
    executionContext(),
  ))
  assert.equal(replay.terminal.status, 'completed')
  assert.deepEqual(replayBodies[0]?.messages, exactReplay)

  const gemini = new StatelessHttpCanonicalAdapter({
    provider: 'gemini', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
  })
  const switchedProvider = gemini.materialize({
    turnId: 'switched-provider', model: 'gemini-3.1-pro',
    input: [{ kind: 'user_message', payload: { text: 'next' } }],
  }, priorSnapshot)
  assert.deepEqual((switchedProvider.body as { messages: unknown }).messages, [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'part one part two done' },
    { role: 'user', content: 'next' },
  ])
})

test('Claude stops after three output continuations instead of looping forever', async () => {
  let requests = 0
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'claude', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async () => {
      requests += 1
      return Response.json({
        id: `chunk-${requests}`, model: 'claude-fable-5', stop_reason: 'max_tokens',
        content: [{ type: 'text', text: `chunk ${requests}` }], usage: { output_tokens: 1 },
      })
    },
  })
  const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
    turnId: 'max-output-limit', model: 'claude-fable-5',
    input: [{ kind: 'user_message', payload: { text: 'go' } }],
  }, snapshot), executionContext({
    limits: { ...DEFAULT_AGENT_LOOP_LIMITS, maxModelRoundTrips: 8 },
  })))
  assert.equal(requests, 4)
  assert.equal(result.terminal.status, 'failed')
  assert.equal(result.terminal.error?.code, 'output_continuation_limit')
})

for (const stopReason of ['model_context_window_exceeded', 'refusal']) {
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
  assert.deepEqual(items.filter((item) => item.kind === 'usage').map((item) => item.payload), [
    {
      prompt_tokens: 4, completion_tokens: 2, input_tokens: 4, output_tokens: 2, round: 1,
      usageProvenance: 'provider_rounds_cumulative',
    },
    {
      prompt_tokens: 7, completion_tokens: 3, input_tokens: 7, output_tokens: 3, round: 2,
      usageProvenance: 'provider_rounds_cumulative',
    },
    { prompt_tokens: 7, completion_tokens: 3, input_tokens: 7, output_tokens: 3 },
  ])
  assert.deepEqual(items.find((item) => item.visibility === 'provider_private')?.payload, {
    stateVersion: 1,
    round: 1,
    assistant: {
      role: 'assistant', content: null,
      tool_calls: [{ id: 'g-call', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
    },
    toolResults: [{
      role: 'tool', tool_call_id: 'g-call', name: 'read_file',
      content: JSON.stringify({ text: 'contents' }),
    }],
  })
})

test('Gemini re-executes durable assistant tool calls and tool results without flattening wire history', async () => {
  const toolCalls = [{
    id: 'g-call',
    type: 'function',
    function: { name: 'read_file', arguments: '{"path":"README.md"}' },
  }]
  const firstReplies = [
    {
      id: 'g-tool', model: 'gemini-3.1-pro',
      choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: toolCalls } }],
      usage: {},
    },
    {
      id: 'g-final', model: 'gemini-3.1-pro',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
      usage: {},
    },
  ]
  const firstAdapter = new StatelessHttpCanonicalAdapter({
    provider: 'gemini', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async () => Response.json(firstReplies.shift()),
  })
  const first = await collectExecution(firstAdapter, await firstAdapter.execute(firstAdapter.materialize({
    turnId: 'gemini-prior', model: 'gemini-3.1-pro',
    input: [{ kind: 'user_message', payload: { text: 'go' } }],
  }, { ...snapshot, items: [] }), executionContext({
    toolDefinitions: [readTool],
    async executeTool() {
      return { success: true, content: { text: 'contents' }, error: null }
    },
  })))
  assert.equal(first.terminal.status, 'completed')
  const durableSnapshot = snapshotWithPriorTurn(normalizedItems(firstAdapter, first.events))

  const replayBodies: Record<string, unknown>[] = []
  const replayAdapter = new StatelessHttpCanonicalAdapter({
    provider: 'gemini', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async (_url, init) => {
      replayBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json({
        id: 'g-second-final', model: 'gemini-3.1-pro',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'second done' } }],
        usage: {},
      })
    },
  })
  const replay = await collectExecution(replayAdapter, await replayAdapter.execute(replayAdapter.materialize({
    turnId: 'gemini-second', model: 'gemini-3.1-pro',
    input: [{ kind: 'user_message', payload: { text: 'next' } }],
  }, durableSnapshot), executionContext()))

  assert.equal(replay.terminal.status, 'completed')
  assert.deepEqual(replayBodies[0]?.messages, [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: toolCalls },
    {
      role: 'tool', tool_call_id: 'g-call', name: 'read_file',
      content: JSON.stringify({ text: 'contents' }),
    },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'next' },
  ])
})

for (const provider of ['claude', 'gemini'] as const) {
  test(`${provider} accepts FIFO live follow-ups at an end boundary only after starting the next request`, async () => {
    const firstResponse = deferred<Response>()
    const bodies: Record<string, unknown>[] = []
    const adapter = new StatelessHttpCanonicalAdapter({
      provider, proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        if (bodies.length === 1) return firstResponse.promise
        return Response.json(provider === 'claude'
          ? {
              id: 'second', model: 'claude-fable-5', stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'second answer' }], usage: {},
            }
          : {
              id: 'second', model: 'gemini-3.1-pro',
              choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'second answer' } }],
              usage: {},
            })
      },
    })
    const execution = await adapter.execute(adapter.materialize({
      turnId: `${provider}-live-end`,
      model: provider === 'claude' ? 'claude-fable-5' : 'gemini-3.1-pro',
      input: [{ kind: 'user_message', payload: { text: 'initial' } }],
    }, { ...snapshot, items: [] }), executionContext())
    assert.ok(execution.steer)
    const collected = collectExecution(adapter, execution)
    const firstSteer = execution.steer({
      followUpId: 'follow-1', text: 'first constraint', expectedTurnId: `${provider}-live-end`,
    })
    const secondSteer = execution.steer({
      followUpId: 'follow-2', text: 'second constraint', expectedTurnId: `${provider}-live-end`,
    })
    firstResponse.resolve(Response.json(provider === 'claude'
      ? {
          id: 'first', model: 'claude-fable-5', stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'first answer' }], usage: {},
        }
      : {
          id: 'first', model: 'gemini-3.1-pro',
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'first answer' } }],
          usage: {},
        }))

    assert.deepEqual(await firstSteer, { status: 'accepted' })
    assert.equal(bodies.length, 2, 'accepted must not resolve before the next fetch starts')
    assert.deepEqual(await secondSteer, { status: 'accepted' })
    const result = await collected
    assert.equal(result.terminal.status, 'completed')
    const continuationBody = bodies[1]
    assert.ok(continuationBody)
    assert.deepEqual((continuationBody.messages as unknown[]).slice(-3), [
      provider === 'claude'
        ? { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] }
        : { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'first constraint' },
      { role: 'user', content: 'second constraint' },
    ])
    const items = normalizedItems(adapter, result.events)
    const privateState = items.find((item) => item.visibility === 'provider_private')
    assert.ok(privateState)
    assert.deepEqual((privateState.payload.liveFollowUps as unknown[]).map((entry) =>
      (entry as { followUpId: string }).followUpId), ['follow-1', 'follow-2'])
    assert.equal(items.filter((item) => item.kind === 'assistant_message'
      && item.payload.text === 'first answer').length, 1)

    if (provider === 'claude') {
      const replaySnapshot = snapshotWithPriorTurn(items)
      const last = replaySnapshot.items.at(-1)!
      replaySnapshot.items.push(
        { ...last, id: 'consumed-follow-1', sequence: last.sequence + 1, kind: 'user_message', visibility: 'portable', provider: null, nativeId: null, payload: { text: 'first constraint' } },
        { ...last, id: 'consumed-follow-2', sequence: last.sequence + 2, kind: 'user_message', visibility: 'portable', provider: null, nativeId: null, payload: { text: 'second constraint' } },
      )
      const replay = adapter.materialize({
        turnId: 'later', model: 'claude-fable-5',
        input: [{ kind: 'user_message', payload: { text: 'later' } }],
      }, replaySnapshot)
      const replayMessages = (replay.body as { messages: Array<Record<string, unknown>> }).messages
      assert.equal(replayMessages.filter((message) => JSON.stringify(message.content).includes('first answer')).length, 1)
      assert.equal(replayMessages.filter((message) => message.content === 'first constraint').length, 1)
      assert.equal(replayMessages.filter((message) => message.content === 'second constraint').length, 1)
    }
  })
}

for (const provider of ['claude', 'gemini'] as const) {
  test(`${provider} appends FIFO live follow-ups after every tool result`, async () => {
    const firstResponse = deferred<Response>()
    const bodies: Record<string, unknown>[] = []
    const adapter = new StatelessHttpCanonicalAdapter({
      provider, proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        if (bodies.length === 1) return firstResponse.promise
        return Response.json(provider === 'claude'
          ? { id: 'final', model: 'claude-fable-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: {} }
          : { id: 'final', model: 'gemini-3.1-pro', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }], usage: {} })
      },
    })
    const execution = await adapter.execute(adapter.materialize({
      turnId: `${provider}-live-tool`, model: provider === 'claude' ? 'claude-fable-5' : 'gemini-3.1-pro',
      input: [{ kind: 'user_message', payload: { text: 'inspect' } }],
    }, { ...snapshot, items: [] }), executionContext({
      toolDefinitions: [readTool],
      async executeTool() { return { success: true, content: { text: 'contents' }, error: null } },
    }))
    const collected = collectExecution(adapter, execution)
    const steers = ['one', 'two'].map((text, index) => execution.steer!({
      followUpId: `tool-follow-${index}`, text, expectedTurnId: `${provider}-live-tool`,
    }))
    firstResponse.resolve(Response.json(provider === 'claude'
      ? {
          id: 'tool', model: 'claude-fable-5', stop_reason: 'tool_use', usage: {},
          content: [{ type: 'tool_use', id: 'call', name: 'read_file', input: { path: 'README.md' } }],
        }
      : {
          id: 'tool', model: 'gemini-3.1-pro', usage: {},
          choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
            tool_calls: [{ id: 'call', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] } }],
        }))
    assert.deepEqual(await Promise.all(steers), [{ status: 'accepted' }, { status: 'accepted' }])
    assert.equal(bodies.length, 2)
    const messages = bodies[1]?.messages as Array<Record<string, unknown>>
    assert.deepEqual(messages.slice(-2).map((message) => message.content), ['one', 'two'])
    const toolResultIndex = messages.findLastIndex((message) => provider === 'claude'
      ? Array.isArray(message.content) && (message.content as Array<Record<string, unknown>>)[0]?.type === 'tool_result'
      : message.role === 'tool')
    assert.ok(toolResultIndex >= 0)
    assert.equal(messages[toolResultIndex + 1]?.content, 'one')
    assert.equal((await collected).terminal.status, 'completed')
  })
}

for (const stopReason of ['pause_turn', 'max_tokens'] as const) {
  test(`Claude orders live steer after the ${stopReason} continuation protocol`, async () => {
    const firstResponse = deferred<Response>()
    const bodies: Record<string, unknown>[] = []
    const adapter = new StatelessHttpCanonicalAdapter({
      provider: 'claude', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        if (bodies.length === 1) return firstResponse.promise
        return Response.json({ id: 'final', model: 'claude-fable-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: {} })
      },
    })
    const execution = await adapter.execute(adapter.materialize({
      turnId: `claude-${stopReason}`, model: 'claude-fable-5',
      input: [{ kind: 'user_message', payload: { text: 'go' } }],
    }, { ...snapshot, items: [] }), executionContext())
    const collected = collectExecution(adapter, execution)
    const steer = execution.steer!({ followUpId: 'live', text: 'live constraint', expectedTurnId: `claude-${stopReason}` })
    firstResponse.resolve(Response.json({
      id: 'boundary', model: 'claude-fable-5', stop_reason: stopReason,
      content: [{ type: 'text', text: 'boundary text' }], usage: {},
    }))
    assert.deepEqual(await steer, { status: 'accepted' })
    const continuationBody = bodies[1]
    assert.ok(continuationBody)
    const tail = (continuationBody.messages as Array<Record<string, unknown>>)
      .slice(stopReason === 'max_tokens' ? -3 : -2)
    assert.deepEqual(tail.map((message) => message.content), stopReason === 'max_tokens'
      ? [[{ type: 'text', text: 'boundary text' }], 'Please continue from where you left off.', 'live constraint']
      : [[{ type: 'text', text: 'boundary text' }], 'live constraint'])
    assert.equal((await collected).terminal.status, 'completed')
  })
}

test('stateless steer closes at the final round and across cancel, dispose, and terminal races', async () => {
  const finalGate = deferred<Response>()
  let finalRequests = 0
  const finalAdapter = new StatelessHttpCanonicalAdapter({
    provider: 'gemini', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async () => { finalRequests += 1; return finalGate.promise },
  })
  const finalExecution = await finalAdapter.execute(finalAdapter.materialize({
    turnId: 'final-round', model: 'gemini-3.1-pro', input: [{ kind: 'user_message', payload: { text: 'go' } }],
  }, { ...snapshot, items: [] }), executionContext({ limits: { ...DEFAULT_AGENT_LOOP_LIMITS, maxModelRoundTrips: 1 } }))
  const finalCollected = collectExecution(finalAdapter, finalExecution)
  const finalSteer = finalExecution.steer!({ followUpId: 'final', text: 'too late', expectedTurnId: 'final-round' })
  finalGate.resolve(Response.json({ id: 'final', model: 'gemini-3.1-pro', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }], usage: {} }))
  assert.deepEqual(await finalSteer, { status: 'closed' })
  assert.equal((await finalCollected).terminal.status, 'completed')
  assert.equal(finalRequests, 1)
  assert.deepEqual(await finalExecution.steer!({ followUpId: 'terminal', text: 'late', expectedTurnId: 'final-round' }), { status: 'closed' })

  for (const action of ['cancel', 'dispose'] as const) {
    const gate = deferred<Response>()
    const adapter = new StatelessHttpCanonicalAdapter({
      provider: 'claude', proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
      fetchImpl: async () => gate.promise,
    })
    const execution = await adapter.execute(adapter.materialize({
      turnId: `race-${action}`, model: 'claude-fable-5', input: [{ kind: 'user_message', payload: { text: 'go' } }],
    }, { ...snapshot, items: [] }), executionContext())
    const collected = collectExecution(adapter, execution)
    const steer = execution.steer!({ followUpId: action, text: 'pending', expectedTurnId: `race-${action}` })
    await execution[action]()
    assert.deepEqual(await steer, { status: 'closed' })
    if (action === 'dispose') {
      gate.resolve(Response.json({ id: 'done', model: 'claude-fable-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: {} }))
      assert.equal((await collected).terminal.status, 'completed')
    } else {
      assert.equal((await collected).terminal.status, 'cancelled')
    }
  }
})

for (const provider of ['claude', 'gemini'] as const) {
  test(`${provider} persists cumulative usage and private continuation state before the next request`, async () => {
    let requestCount = 0
    let continuationPersisted = false
    let cumulativeUsagePersisted = false
    let cumulativeUsageAtBoundary: Record<string, unknown> | null = null
    const adapter = new StatelessHttpCanonicalAdapter({
      provider,
      proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
      fetchImpl: async () => {
        requestCount += 1
        if (requestCount === 1) {
          return Response.json(provider === 'claude'
            ? {
                id: 'private-tool', model: 'claude-fable-5', stop_reason: 'tool_use',
                usage: { input_tokens: 2, output_tokens: 1 },
                content: [{ type: 'tool_use', id: 'private-call', name: 'read_file', input: { path: 'fixture.txt' } }],
              }
            : {
                id: 'private-tool', model: 'gemini-3.1-pro',
                usage: { prompt_tokens: 2, completion_tokens: 1 },
                choices: [{ finish_reason: 'tool_calls', message: {
                  role: 'assistant', content: null,
                  tool_calls: [{
                    id: 'private-call', type: 'function',
                    function: { name: 'read_file', arguments: '{"path":"fixture.txt"}' },
                  }],
                } }],
              })
        }
        assert.equal(continuationPersisted, true)
        assert.equal(cumulativeUsagePersisted, true)
        assert.deepEqual(cumulativeUsageAtBoundary, provider === 'claude'
          ? {
              input_tokens: 2, output_tokens: 1, round: 1,
              usageProvenance: 'provider_rounds_cumulative',
            }
          : {
              prompt_tokens: 2, completion_tokens: 1, input_tokens: 2, output_tokens: 1, round: 1,
              usageProvenance: 'provider_rounds_cumulative',
            })
        return Response.json(provider === 'claude'
          ? {
              id: 'private-final', model: 'claude-fable-5', stop_reason: 'end_turn', usage: {},
              content: [{ type: 'text', text: 'done' }],
            }
          : {
              id: 'private-final', model: 'gemini-3.1-pro', usage: {},
              choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
            })
      },
    })
    const execution = await adapter.execute(adapter.materialize({
      turnId: `${provider}-private-state`,
      model: provider === 'claude' ? 'claude-fable-5' : 'gemini-3.1-pro',
      input: [{ kind: 'user_message', payload: { text: 'inspect fixture' } }],
    }, snapshot), executionContext({
      toolDefinitions: [readTool],
      async executeTool() { return { success: true, content: { text: 'fixture-result' }, error: null } },
    }))

    for await (const event of execution.events) {
      const normalized = adapter.normalize(event)
      if (normalized.some((item) => item.kind === 'usage'
        && item.payload.usageProvenance === 'provider_rounds_cumulative')) {
        cumulativeUsagePersisted = true
        cumulativeUsageAtBoundary = normalized.find((item) => item.kind === 'usage'
          && item.payload.usageProvenance === 'provider_rounds_cumulative')?.payload ?? null
      }
      const continuation = normalized.find((item) => item.visibility === 'provider_private')
      if (!continuation) continue
      assert.equal(continuation.kind, 'provider_event')
      assert.equal(continuation.provider, provider)
      assert.equal(continuation.payload.stateVersion, 1)
      assert.equal(continuation.payload.round, 1)
      assert.ok(continuation.payload.assistant)
      assert.ok(Array.isArray(continuation.payload.toolResults))
      continuationPersisted = true
    }
    assert.equal((await execution.terminal).status, 'completed')
    assert.equal(continuationPersisted, true)
    assert.equal(cumulativeUsagePersisted, true)
    assert.equal(requestCount, 2)
  })
}

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

for (const provider of ['claude', 'gemini'] as const) {
  test(`${provider} rejects a response with no explicit terminal reason`, async () => {
    const adapter = new StatelessHttpCanonicalAdapter({
      provider,
      proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
      fetchImpl: async () => Response.json(provider === 'claude'
        ? {
            id: 'missing-stop', model: 'claude-fable-5', usage: {},
            content: [{ type: 'text', text: 'ambiguous' }],
          }
        : {
            id: 'missing-finish', model: 'gemini-3.1-pro', usage: {},
            choices: [{ message: { content: 'ambiguous' } }],
          }),
    })
    const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
      turnId: `${provider}-missing-terminal-reason`,
      model: provider === 'claude' ? 'claude-fable-5' : 'gemini-3.1-pro',
      input: [{ kind: 'user_message', payload: { text: 'go' } }],
    }, snapshot), executionContext()))

    assert.equal(result.terminal.status, 'failed')
    assert.equal(result.terminal.error?.code, 'provider_invalid_terminal')
  })
}

for (const provider of ['claude', 'gemini'] as const) {
  test(`${provider} rejects a final reason that still contains pending tool calls`, async () => {
    let toolExecuted = false
    const adapter = new StatelessHttpCanonicalAdapter({
      provider,
      proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
      fetchImpl: async () => Response.json(provider === 'claude'
        ? {
            id: 'contradictory-stop', model: 'claude-fable-5', stop_reason: 'end_turn', usage: {},
            content: [
              { type: 'text', text: 'looks final' },
              { type: 'tool_use', id: 'still-pending', name: 'read_file', input: { path: 'a' } },
            ],
          }
        : {
            id: 'contradictory-finish', model: 'gemini-3.1-pro', usage: {},
            choices: [{
              finish_reason: 'stop',
              message: {
                content: 'looks final',
                tool_calls: [{
                  id: 'still-pending', type: 'function',
                  function: { name: 'read_file', arguments: '{"path":"a"}' },
                }],
              },
            }],
          }),
    })
    const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
      turnId: `${provider}-contradictory-terminal`,
      model: provider === 'claude' ? 'claude-fable-5' : 'gemini-3.1-pro',
      input: [{ kind: 'user_message', payload: { text: 'go' } }],
    }, snapshot), executionContext({
      toolDefinitions: [readTool],
      async executeTool() { toolExecuted = true; return { success: true, content: {}, error: null } },
    })))

    assert.equal(result.terminal.status, 'failed')
    assert.equal(result.terminal.error?.code, 'provider_invalid_terminal')
    assert.equal(toolExecuted, false)
  })
}

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

for (const provider of ['claude', 'gemini'] as const) {
  test(`${provider} classifies exhausted HTTP 429 responses as a provider usage limit`, async () => {
    let attempts = 0
    const adapter = new StatelessHttpCanonicalAdapter({
      provider,
      proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
      fetchImpl: async () => {
        attempts += 1
        return Response.json({ error: { message: 'quota exhausted' } }, { status: 429 })
      },
    })
    const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
      turnId: `${provider}-usage-limited`,
      model: provider === 'claude' ? 'claude-fable-5' : 'gemini-3.1-pro',
      input: [{ kind: 'user_message', payload: { text: 'go' } }],
    }, snapshot), executionContext({
      limits: { ...DEFAULT_AGENT_LOOP_LIMITS, maxProviderRetries: 1 },
    })))

    assert.equal(result.terminal.status, 'failed')
    assert.equal(result.terminal.error?.code, 'provider_usage_limit')
    assert.equal(attempts, 2)
  })
}

test('a non-JSON HTTP 429 still preserves the provider usage-limit category', async () => {
  const adapter = new StatelessHttpCanonicalAdapter({
    provider: 'claude',
    proxyConnection: async () => ({ baseUrl: 'http://proxy', token: 'secret' }),
    fetchImpl: async () => new Response('rate limited', { status: 429 }),
  })
  const result = await collectExecution(adapter, await adapter.execute(adapter.materialize({
    turnId: 'claude-non-json-usage-limited', model: 'claude-fable-5',
    input: [{ kind: 'user_message', payload: { text: 'go' } }],
  }, snapshot), executionContext({
    limits: { ...DEFAULT_AGENT_LOOP_LIMITS, maxProviderRetries: 1 },
  })))

  assert.equal(result.terminal.status, 'failed')
  assert.equal(result.terminal.error?.code, 'provider_usage_limit')
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
