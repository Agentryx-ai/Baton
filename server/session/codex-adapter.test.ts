import assert from 'node:assert/strict'
import test from 'node:test'
import type { NativeProviderEvent, ProviderExecutionContext } from './adapter.ts'
import {
  CodexCanonicalAdapter,
  CodexJsonlRpcClient,
  type CodexAppServerProcess,
  type CodexProcessFactory,
} from './codex-adapter.ts'
import type { NewCanonicalItem, ThreadSnapshot } from './domain.ts'

type ExitResult = { code: number | null; signal: NodeJS.Signals | null }
type Scenario = 'normal' | 'collab' | 'cancel' | 'exit'

class TestStream<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = []
  private ended = false

  push(value: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.values.push(value)
  }

  end(): void {
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

class FakeProcess implements CodexAppServerProcess {
  readonly stream = new TestStream<string | Uint8Array>()
  readonly stdout = this.stream
  readonly writes: Array<Record<string, unknown>> = []
  readonly exited: Promise<ExitResult>
  private exitResolve!: (result: ExitResult) => void
  private hasExited = false
  private readonly onWrite: ((message: Record<string, unknown>, self: FakeProcess) => void) | undefined

  constructor(onWrite?: (message: Record<string, unknown>, self: FakeProcess) => void) {
    this.onWrite = onWrite
    this.exited = new Promise((resolve) => {
      this.exitResolve = resolve
    })
  }

  async write(line: string): Promise<void> {
    const message = JSON.parse(line) as Record<string, unknown>
    this.writes.push(message)
    this.onWrite?.(message, this)
  }

  async closeInput(): Promise<void> {
    this.exit({ code: 0, signal: null })
  }

  async kill(): Promise<void> {
    this.exit({ code: null, signal: 'SIGTERM' })
  }

  emit(message: Record<string, unknown>, fragmented = false): void {
    const line = `${JSON.stringify(message)}\n`
    if (!fragmented) {
      this.stream.push(line)
      return
    }
    const split = Math.max(1, Math.floor(line.length / 2))
    this.stream.push(Buffer.from(line.slice(0, split)))
    this.stream.push(Buffer.from(line.slice(split)))
  }

  exit(result: ExitResult): void {
    if (this.hasExited) return
    this.hasExited = true
    this.stream.end()
    this.exitResolve(result)
  }
}

function idOf(message: Record<string, unknown>): string | number {
  assert.ok(typeof message.id === 'string' || typeof message.id === 'number')
  return message.id
}

function configResult(): Record<string, unknown> {
  return {
    config: {
      agents: { enabled: false },
      features: {
        multi_agent: false,
        multi_agent_v2: false,
        enable_fanout: false,
        shell_tool: false,
        apps: false,
        plugins: false,
      },
      mcp_servers: {},
    },
  }
}

function featureResult(): Record<string, unknown> {
  return {
    data: [
      'multi_agent',
      'multi_agent_v2',
      'enable_fanout',
      'shell_tool',
      'apps',
      'plugins',
    ].map((name) => ({ name, enabled: false })),
  }
}

function scriptedFactory(scenario: Scenario, created: FakeProcess[], argsSeen: string[][]): CodexProcessFactory {
  return (_executable, args) => {
    argsSeen.push([...args])
    const process = new FakeProcess((message, self) => {
      const method = message.method
      if (method === 'initialize') {
        self.emit({ id: idOf(message), result: { userAgent: 'codex-test/1', codexHome: 'C:/tmp', platformFamily: 'windows', platformOs: 'windows' } }, true)
      } else if (method === 'config/read') {
        self.emit({ id: idOf(message), result: configResult() }, true)
      } else if (method === 'thread/start') {
        self.emit({ id: idOf(message), result: { thread: { id: 'native-thread', ephemeral: true, path: null } } })
      } else if (method === 'experimentalFeature/list') {
        self.emit({ id: idOf(message), result: featureResult() })
      } else if (method === 'thread/inject_items') {
        self.emit({ id: idOf(message), result: {} })
      } else if (method === 'turn/start') {
        self.emit({ id: idOf(message), result: { turn: { id: 'native-turn', status: 'inProgress', items: [] } } })
        queueMicrotask(() => emitScenario(self, scenario))
      } else if (method === 'turn/interrupt') {
        self.emit({ id: idOf(message), result: {} })
        queueMicrotask(() => {
          self.emit({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'native-turn', status: 'interrupted', error: null } } })
        })
      }
    })
    created.push(process)
    return process
  }
}

function emitScenario(process: FakeProcess, scenario: Scenario): void {
  if (scenario === 'exit') {
    process.exit({ code: 7, signal: null })
    return
  }
  if (scenario === 'collab') {
    process.emit({
      method: 'item/completed',
      params: {
        threadId: 'native-thread',
        turnId: 'native-turn',
        item: { id: 'collab-1', type: 'collabAgentToolCall' },
      },
    })
    return
  }
  if (scenario === 'cancel') return
  process.emit({
    method: 'item/completed',
    params: {
      threadId: 'native-thread',
      turnId: 'native-turn',
      item: { id: 'message-1', type: 'agentMessage', text: 'done' },
    },
  }, true)
  process.emit({
    method: 'item/completed',
    params: {
      threadId: 'native-thread',
      turnId: 'native-turn',
      item: { id: 'reasoning-1', type: 'reasoning', summary: ['checked'] },
    },
  })
  process.emit({
    method: 'item/completed',
    params: {
      threadId: 'native-thread',
      turnId: 'native-turn',
      item: { id: 'plan-1', type: 'plan', text: '1. finish' },
    },
  })
  process.emit({
    method: 'turn/plan/updated',
    params: {
      threadId: 'native-thread',
      turnId: 'native-turn',
      explanation: null,
      plan: [{ step: 'finish', status: 'completed' }],
    },
  })
  process.emit({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'native-thread',
      turnId: 'native-turn',
      tokenUsage: { last: { inputTokens: 3, outputTokens: 2 } },
    },
  })
  process.emit({
    method: 'turn/completed',
    params: {
      threadId: 'native-thread',
      turn: { id: 'native-turn', status: 'completed', error: null },
    },
  })
}

function context(): ProviderExecutionContext {
  return {
    signal: new AbortController().signal,
    async denyApproval(): Promise<never> { throw new Error('approval denied') },
    async denyToolCall(): Promise<never> { throw new Error('tool denied') },
  }
}

function snapshot(): ThreadSnapshot {
  const now = new Date(0).toISOString()
  return {
    session: {
      id: 'session', title: null, preview: null, activeThreadId: 'thread', projectKey: null,
      cwd: 'C:/workspace', schemaVersion: 1, createdAt: now, updatedAt: now, archivedAt: null,
    },
    thread: {
      id: 'thread', sessionId: 'session', parentThreadId: null, forkTurnId: null, forkItemId: null,
      revision: 1, status: 'idle', instructionSnapshot: {}, createdAt: now, updatedAt: now,
    },
    turns: [],
    items: [{
      id: 'history-1', sessionId: 'session', threadId: 'thread', turnId: null, sequence: 1,
      kind: 'assistant_message', visibility: 'portable', payload: { text: 'previous' },
      provider: 'claude', nativeId: null, createdAt: now,
    }],
    bindings: [],
  }
}

function request() {
  return {
    turnId: 'canonical-turn',
    model: 'gpt-test',
    input: [{ kind: 'user_message', payload: { text: 'hello' } }] satisfies NewCanonicalItem[],
  }
}

async function collect(events: AsyncIterable<NativeProviderEvent>): Promise<NativeProviderEvent[]> {
  const result: NativeProviderEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

test('JSONL client parses fragmented frames and correlates out-of-order responses', async () => {
  const process = new FakeProcess()
  const client = new CodexJsonlRpcClient(process)
  const first = client.request('first')
  const second = client.request('second')
  await Promise.resolve()
  const firstId = idOf(process.writes[0])
  const secondId = idOf(process.writes[1])
  process.emit({ id: secondId, result: 'two' }, true)
  process.emit({ id: firstId, result: 'one' }, true)
  assert.equal(await first, 'one')
  assert.equal(await second, 'two')
  await process.closeInput()
})

test('preflight discovers inherited MCP servers and relaunches with each one disabled', async () => {
  const argsSeen: string[][] = []
  const factory: CodexProcessFactory = (_executable, args) => {
    const disabled = args.includes('mcp_servers.agent-tools.enabled=false')
    argsSeen.push([...args])
    return new FakeProcess((message, self) => {
      if (message.method === 'initialize') {
        self.emit({ id: idOf(message), result: { userAgent: 'codex-test/1' } })
      } else if (message.method === 'config/read') {
        self.emit({
          id: idOf(message),
          result: {
            config: {
              ...configResult().config as Record<string, unknown>,
              mcp_servers: { 'agent-tools': { enabled: !disabled, command: 'agent-server' } },
            },
          },
        })
      }
    })
  }
  const adapter = new CodexCanonicalAdapter({ processFactory: factory, shutdownTimeoutMs: 20 })
  const handshake = await adapter.initialize()
  assert.equal(handshake.enforcementEvidence.mcpServersDisabled, 1)
  assert.equal(argsSeen.length, 2)
  assert.ok(argsSeen[1].includes('mcp_servers.agent-tools.enabled=false'))
  await adapter.shutdown()
})

test('adapter applies process and thread hardening and normalizes durable text, plan, and usage', async () => {
  const created: FakeProcess[] = []
  const argsSeen: string[][] = []
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('normal', created, argsSeen),
    shutdownTimeoutMs: 20,
  })
  const handshake = await adapter.initialize()
  assert.equal(handshake.capabilities.nativeChildExecution, 'disabled')
  assert.equal(handshake.capabilities.toolCalling, false)
  assert.equal(handshake.enforcementEvidence.source, 'config/read')
  const materialized = adapter.materialize(request(), snapshot())
  const execution = await adapter.execute(materialized, context())
  const [events, terminal] = await Promise.all([collect(execution.events), execution.terminal])
  assert.equal(terminal.status, 'completed')
  assert.deepEqual(terminal.usage, { inputTokens: 3, outputTokens: 2 })
  const normalized = events.flatMap((event) => adapter.normalize(event))
  assert.ok(normalized.some((item) => item.kind === 'assistant_message'))
  assert.ok(normalized.some((item) => item.kind === 'reasoning_summary'))
  assert.ok(normalized.some((item) => item.kind === 'plan'))
  assert.ok(normalized.some((item) => item.kind === 'task'))
  assert.ok(normalized.some((item) => item.kind === 'usage'))
  for (const args of argsSeen) {
    assert.ok(args.includes('features.multi_agent=false'))
    assert.ok(args.includes('features.multi_agent_v2=false'))
    assert.ok(args.includes('features.enable_fanout=false'))
    assert.ok(args.includes('features.shell_tool=false'))
  }
  const turnProcess = created[1]
  const threadStart = turnProcess.writes.find((message) => message.method === 'thread/start')
  assert.ok(threadStart)
  const params = threadStart.params as Record<string, unknown>
  assert.equal(params.ephemeral, true)
  assert.equal(params.approvalsReviewer, 'user')
  assert.equal(params.approvalPolicy, 'never')
  assert.deepEqual(params.config, {
    'features.multi_agent': false,
    'features.multi_agent_v2': false,
    'features.enable_fanout': false,
    'features.shell_tool': false,
    'features.apps': false,
    'features.plugins': false,
  })
  assert.ok(turnProcess.writes.some((message) => message.method === 'thread/inject_items'))
  await adapter.shutdown()
})

test('adapter treats native collaboration events as a fatal capability violation', async () => {
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('collab', [], []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
  const events = await collect(execution.events)
  const terminal = await execution.terminal
  assert.equal(terminal.status, 'failed')
  assert.match(String(terminal.error?.message), /capability violation/)
  assert.ok(events.some((event) => event.type === 'adapter/error'))
})

test('cancel sends turn/interrupt and waits for interrupted completion', async () => {
  const created: FakeProcess[] = []
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('cancel', created, []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
  await execution.cancel()
  assert.equal((await execution.terminal).status, 'interrupted')
  assert.ok(created[1].writes.some((message) => message.method === 'turn/interrupt'))
})

test('process exit before turn completion produces a failed terminal result', async () => {
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('exit', [], []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
  const terminal = await execution.terminal
  assert.equal(terminal.status, 'failed')
  assert.match(String(terminal.error?.message), /exited|closed/)
})
