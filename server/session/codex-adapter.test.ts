import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { NativeProviderEvent, ProviderExecutionContext } from './adapter.ts'
import {
  CodexCanonicalAdapter,
  CodexJsonlRpcClient,
  hardenCodexModelCatalog,
  type CodexAppServerProcess,
  type CodexProcessFactory,
} from './codex-adapter.ts'
import { DEFAULT_AGENT_LOOP_LIMITS } from './domain.ts'
import type { AgentToolDefinition, AgentToolInvocation, NewCanonicalItem, ThreadSnapshot } from './domain.ts'
import type { ImageArtifactRef } from './image-artifacts.ts'

type ExitResult = { code: number | null; signal: NodeJS.Signals | null; stderr?: string }
type Scenario =
  | 'normal'
  | 'compaction'
  | 'tool'
  | 'twoTools'
  | 'twoIdentical'
  | 'duplicateTool'
  | 'duplicateRpc'
  | 'foreignTool'
  | 'foreignStatus'
  | 'foreignProvider'
  | 'twoRounds'
  | 'nextRoundTool'
  | 'usageFallback'
  | 'reroute'
  | 'collab'
  | 'collabChildEvent'
  | 'collabChildTool'
  | 'foreignCollabSender'
  | 'childStartsBeforeCollab'
  | 'subAgentActivity'
  | 'foreignNotification'
  | 'nonSpawnUnknownReceiver'
  | 'forbiddenExecution'
  | 'cancel'
  | 'hangInterrupt'
  | 'steerMalformed'
  | 'steerNull'
  | 'steerForeign'
  | 'steerClosed'
  | 'steerUnsupported'
  | 'steerManual'
  | 'usageLimit'
  | 'transientFailure'
  | 'exit'

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
  hangOnCloseInput = false
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
    if (this.hangOnCloseInput) await new Promise<void>(() => undefined)
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
      web_search: 'disabled',
      project_doc_max_bytes: 0,
      features: {
        multi_agent: true,
        multi_agent_v2: true,
        enable_fanout: false,
        shell_tool: false,
        standalone_web_search: false,
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
      'standalone_web_search',
      'apps',
      'plugins',
    ].map((name) => ({ name, enabled: false })),
  }
}

function scriptedFactory(
  scenario: Scenario,
  created: FakeProcess[],
  argsSeen: string[][],
  environmentsSeen: Array<Readonly<Record<string, string>> | undefined> = [],
): CodexProcessFactory {
  return (_executable, args, environment) => {
    argsSeen.push([...args])
    environmentsSeen.push(environment)
    const process = new FakeProcess((message, self) => {
      const method = message.method
      if (method === 'initialize') {
        self.emit({ id: idOf(message), result: { userAgent: 'codex-test/1', codexHome: 'C:/tmp', platformFamily: 'windows', platformOs: 'windows' } }, true)
      } else if (method === 'config/read') {
        self.emit({ id: idOf(message), result: configResult() }, true)
      } else if (method === 'thread/start') {
        self.emit({
          id: idOf(message),
          result: {
            thread: { id: 'native-thread', ephemeral: false, path: 'C:/tmp/native-thread.jsonl' },
            model: 'gpt-resolved',
            modelProvider: scenario === 'foreignProvider' ? 'openai' : 'baton',
            runtimeWorkspaceRoots: [],
          },
        })
      } else if (method === 'experimentalFeature/list') {
        self.emit({ id: idOf(message), result: featureResult() })
      } else if (method === 'thread/inject_items') {
        self.emit({ id: idOf(message), result: {} })
      } else if (method === 'thread/archive') {
        self.emit({ id: idOf(message), result: {} })
      } else if (method === 'turn/start') {
        self.emit({ id: idOf(message), result: { turn: { id: 'native-turn', status: 'inProgress', items: [] } } })
        queueMicrotask(() => {
          if (
            scenario === 'tool'
            || scenario === 'twoTools'
            || scenario === 'twoIdentical'
            || scenario === 'duplicateTool'
            || scenario === 'nextRoundTool'
          ) {
            emitToolCall(self)
          } else if (scenario === 'duplicateRpc') {
            emitToolCall(self)
            emitToolCall(self)
          } else if (scenario === 'foreignTool') {
            emitToolCall(self, { turnId: 'foreign-turn' })
          } else {
            emitScenario(self, scenario)
          }
        })
      } else if (method === 'turn/steer') {
        if (scenario === 'steerManual') return
        if (scenario === 'steerMalformed') self.emit({ id: idOf(message), result: {} })
        else if (scenario === 'steerNull') self.emit({ id: idOf(message), result: null })
        else if (scenario === 'steerForeign') self.emit({ id: idOf(message), result: { turnId: 'foreign-turn' } })
        else if (scenario === 'steerClosed') {
          self.emit({
            id: idOf(message),
            error: { code: -32600, message: 'Active turn not steerable', data: { type: 'ActiveTurnNotSteerable' } },
          })
        } else if (scenario === 'steerUnsupported') {
          self.emit({ id: idOf(message), error: { code: -32601, message: 'Method not found' } })
        } else self.emit({ id: idOf(message), result: { turnId: 'native-turn' } })
      } else if (method === 'turn/interrupt') {
        if (scenario === 'hangInterrupt') return
        self.emit({ id: idOf(message), result: {} })
        queueMicrotask(() => {
          self.emit({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'native-turn', status: 'interrupted', error: null } } })
        })
      } else if (
        (
          scenario === 'tool'
          || scenario === 'twoTools'
          || scenario === 'twoIdentical'
          || scenario === 'duplicateTool'
          || scenario === 'nextRoundTool'
        )
        && message.id === 60
        && 'result' in message
      ) {
        self.emit({
          method: 'item/completed',
          params: {
            threadId: 'native-thread',
            turnId: 'native-turn',
            item: {
              id: 'dynamic-1',
              type: 'dynamicToolCall',
              tool: 'read_file',
              arguments: { path: 'README.md' },
              status: 'completed',
              contentItems: [{ type: 'inputText', text: 'ok' }],
              success: true,
            },
          },
        })
        if (scenario === 'twoTools') {
          emitToolCall(self, { rpcId: 61, callId: 'provider-call-2', path: 'package.json' })
        } else if (scenario === 'twoIdentical') {
          emitToolCall(self, { rpcId: 61, callId: 'provider-call-2' })
        } else if (scenario === 'duplicateTool') {
          emitToolCall(self, { rpcId: 61 })
        } else if (scenario === 'nextRoundTool') {
          emitUsage(self, 1)
          emitToolCall(self, { rpcId: 61, callId: 'provider-call-2', path: 'package.json' })
        } else {
          emitScenario(self, 'normal')
        }
      } else if (
        (scenario === 'twoTools' || scenario === 'twoIdentical' || scenario === 'duplicateTool')
        && message.id === 61
        && 'result' in message
      ) {
        emitScenario(self, 'normal')
      } else if (scenario === 'collabChildTool' && message.id === 62 && 'result' in message) {
        self.emit({
          method: 'item/completed',
          params: {
            threadId: 'native-child-thread',
            turnId: 'native-child-turn',
            item: { id: 'child-dynamic-1', type: 'dynamicToolCall', status: 'completed' },
          },
        })
        emitScenario(self, 'normal')
      }
    })
    created.push(process)
    return process
  }
}

function emitToolCall(process: FakeProcess, options: {
  rpcId?: number
  threadId?: string
  turnId?: string
  callId?: string
  path?: string
} = {}): void {
  const rpcId = options.rpcId ?? 60
  const threadId = options.threadId ?? 'native-thread'
  const turnId = options.turnId ?? 'native-turn'
  const callId = options.callId ?? 'provider-call-1'
  const filePath = options.path ?? 'README.md'
  process.emit({
    method: 'item/started',
    params: {
      threadId,
      turnId,
      item: {
        id: `dynamic-${callId}`,
        type: 'dynamicToolCall',
        tool: 'read_file',
        arguments: { path: filePath },
        status: 'inProgress',
      },
    },
  })
  process.emit({
    method: 'item/tool/call',
    id: rpcId,
    params: {
      threadId,
      turnId,
      callId,
      tool: 'read_file',
      arguments: { path: filePath },
    },
  })
}

function emitScenario(process: FakeProcess, scenario: Scenario): void {
  if (scenario === 'exit') {
    process.exit({ code: 7, signal: null, stderr: 'invalid test configuration' })
    return
  }
  if (scenario === 'childStartsBeforeCollab') {
    process.emit({
      method: 'thread/started',
      params: {
        thread: { id: 'native-child-thread', parentThreadId: 'native-thread' },
      },
    })
    process.emit({
      method: 'turn/started',
      params: {
        threadId: 'native-child-thread',
        turn: { id: 'native-child-turn', status: 'inProgress', items: [] },
      },
    })
    process.emit({
      method: 'item/completed',
      params: {
        threadId: 'native-child-thread',
        turnId: 'native-child-turn',
        item: { id: 'child-message-1', type: 'agentMessage', text: 'private child output' },
      },
    })
    process.emit({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'native-child-thread',
        turnId: 'native-child-turn',
        tokenUsage: { total: { totalTokens: 999 } },
      },
    })
    process.emit({
      method: 'model/rerouted',
      params: {
        threadId: 'native-child-thread',
        turnId: 'native-child-turn',
        fromModel: 'child-model',
        toModel: 'child-rerouted',
        reason: 'serverReroute',
      },
    })
    process.emit({
      method: 'turn/completed',
      params: {
        threadId: 'native-child-thread',
        turn: { id: 'native-child-turn', status: 'completed', error: null },
      },
    })
    process.emit({
      method: 'item/completed',
      params: {
        threadId: 'native-thread',
        turnId: 'native-turn',
        item: {
          id: 'collab-child-1',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'completed',
          senderThreadId: 'native-thread',
          receiverThreadIds: ['native-child-thread'],
        },
      },
    })
  }
  if (scenario === 'foreignNotification') {
    process.emit({
      method: 'item/completed',
      params: {
        threadId: 'unrelated-native-root',
        turnId: 'unrelated-native-turn',
        item: { id: 'foreign-message-1', type: 'agentMessage', text: 'unrelated output' },
      },
    })
  }
  if (scenario === 'subAgentActivity') {
    process.emit({
      method: 'item/completed',
      params: {
        threadId: 'native-thread',
        turnId: 'native-turn',
        item: { id: 'subagent-activity-1', type: 'subAgentActivity', kind: 'started' },
      },
    })
  }
  if (scenario === 'nonSpawnUnknownReceiver') {
    process.emit({
      method: 'item/completed',
      params: {
        threadId: 'native-thread',
        turnId: 'native-turn',
        item: {
          id: 'collab-wait-1',
          type: 'collabAgentToolCall',
          tool: 'wait',
          status: 'completed',
          senderThreadId: 'native-thread',
          receiverThreadIds: ['unowned-native-thread'],
        },
      },
    })
    return
  }
  if (scenario === 'collab' || scenario === 'collabChildEvent'
    || scenario === 'collabChildTool' || scenario === 'foreignCollabSender') {
    if (scenario === 'collabChildEvent') {
      process.emit({
        method: 'thread/started',
        params: { thread: { id: 'native-child-thread', parentThreadId: 'native-thread' } },
      })
    }
    process.emit({
      method: 'item/completed',
      params: {
        threadId: scenario === 'collabChildEvent' ? 'native-child-thread' : 'native-thread',
        turnId: scenario === 'collabChildEvent' ? 'native-child-turn' : 'native-turn',
        item: {
          id: 'collab-1',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'completed',
          senderThreadId: scenario === 'foreignCollabSender' ? 'foreign-thread' : 'native-thread',
          receiverThreadIds: ['native-child-thread'],
        },
      },
    })
    if (scenario === 'collabChildEvent') {
      process.emit({
        method: 'item/completed',
        params: {
          threadId: 'native-child-thread',
          turnId: 'native-child-turn',
          item: { id: 'child-reasoning-1', type: 'reasoning', summary: ['checked by child'] },
        },
      })
    }
    if (scenario === 'collabChildTool') {
      emitToolCall(process, {
        rpcId: 62,
        threadId: 'native-child-thread',
        turnId: 'native-child-turn',
        callId: 'child-provider-call',
      })
      return
    }
  }
  if (scenario === 'forbiddenExecution') {
    process.emit({
      method: 'item/completed',
      params: {
        threadId: 'native-thread',
        turnId: 'native-turn',
        item: { id: 'command-1', type: 'commandExecution' },
      },
    })
    return
  }
  if (scenario === 'usageLimit') {
    process.emit({
      method: 'turn/completed',
      params: {
        threadId: 'native-thread',
        turn: {
          id: 'native-turn',
          status: 'failed',
          error: {
            message: 'quota exhausted',
            codexErrorInfo: 'usageLimitExceeded',
            additionalDetails: 'preserved',
          },
        },
      },
    })
    return
  }
  if (scenario === 'transientFailure') {
    process.emit({
      method: 'turn/completed',
      params: {
        threadId: 'native-thread',
        turn: {
          id: 'native-turn',
          status: 'failed',
          error: {
            message: 'unexpected status 503 Service Unavailable: upstream connect error',
            codexErrorInfo: 'other',
            additionalDetails: null,
          },
        },
      },
    })
    return
  }
  if (scenario === 'cancel' || scenario === 'hangInterrupt' || scenario.startsWith('steer')) return
  if (scenario === 'foreignStatus') {
    process.emit({
      method: 'thread/status/changed',
      params: { threadId: 'detached-internal-thread', status: { type: 'idle' } },
    })
  }
  if (scenario === 'twoRounds') {
    emitUsage(process, 1)
    emitUsage(process, 2)
  }
  if (scenario === 'reroute') {
    process.emit({
      method: 'model/rerouted',
      params: {
        threadId: 'native-thread',
        turnId: 'native-turn',
        fromModel: 'gpt-resolved',
        toModel: 'gpt-routed',
        reason: 'serverReroute',
      },
    })
  }
  if (scenario === 'compaction') {
    process.emit({
      method: 'item/completed',
      params: {
        threadId: 'native-thread', turnId: 'native-turn',
        item: { id: 'compact-1', type: 'contextCompaction' },
      },
    })
  }
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
  if (scenario === 'usageFallback') emitUsageFallback(process)
  else if (scenario !== 'twoRounds') emitUsage(process, 5)
  process.emit({
    method: 'turn/completed',
    params: {
      threadId: 'native-thread',
      turn: { id: 'native-turn', status: 'completed', error: null },
    },
  })
}

function emitUsage(process: FakeProcess, totalTokens: number): void {
  process.emit({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'native-thread',
      turnId: 'native-turn',
      tokenUsage: {
        total: { totalTokens },
        last: { inputTokens: 3, outputTokens: 2 },
      },
    },
  })
}

function emitUsageFallback(process: FakeProcess): void {
  process.emit({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'native-thread',
      turnId: 'native-turn',
      tokenUsage: { last: { inputTokens: 3, outputTokens: 2 } },
    },
  })
}

function context(options: {
  tools?: AgentToolDefinition[]
  executeTool?: (request: AgentToolInvocation) => Promise<Awaited<ReturnType<ProviderExecutionContext['executeTool']>>>
  signal?: AbortSignal
  limits?: Partial<typeof DEFAULT_AGENT_LOOP_LIMITS>
} = {}): ProviderExecutionContext {
  return {
    signal: options.signal ?? new AbortController().signal,
    toolDefinitions: options.tools ?? [],
    limits: { ...DEFAULT_AGENT_LOOP_LIMITS, ...options.limits },
    executeTool: options.executeTool ?? (async () => { throw new Error('tool not registered') }),
    async denyApproval(): Promise<never> { throw new Error('approval denied') },
    async denyToolCall(): Promise<never> { throw new Error('tool denied') },
  }
}

function snapshot(): ThreadSnapshot {
  const now = new Date(0).toISOString()
  return {
    session: {
      id: 'session', title: null, preview: null, activeThreadId: 'thread', projectKey: null,
      cwd: 'C:/workspace', permissions: { defaultProfile: 'workspace', override: null, effectiveProfile: 'workspace', source: 'global' },
      schemaVersion: 1, createdAt: now, updatedAt: now, archivedAt: null,
      workStatus: 'idle',
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

const TEST_IMAGE: ImageArtifactRef = {
  id: `sha256-${'a'.repeat(64)}`,
  sha256: 'a'.repeat(64),
  mediaType: 'image/png',
  byteLength: 67,
  width: 1,
  height: 1,
  fileName: 'screen.png',
  source: 'upload',
}

test('materializes canonical image references as Codex localImage input and data-only replay history', () => {
  const adapter = new CodexCanonicalAdapter({
    processFactory: () => new FakeProcess(),
    imageArtifacts: {
      pathFor: () => 'C:/Baton/image-artifacts/screen.png',
      dataUrl: () => 'data:image/png;base64,AAAA',
    },
  })
  const projected = adapter.materialize({
    turnId: 'image-turn', model: 'gpt-test',
    input: [{ kind: 'user_message', payload: { attachments: [TEST_IMAGE] } }],
  }, {
    ...snapshot(),
    items: [{
      ...snapshot().items[0]!,
      kind: 'user_message',
      payload: { text: 'prior image', attachments: [TEST_IMAGE] },
    }],
  }).body as Record<string, unknown>
  assert.deepEqual(projected.input, [{ type: 'localImage', path: 'C:/Baton/image-artifacts/screen.png' }])
  assert.deepEqual(projected.history, [{
    type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'prior image' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    ],
  }])
})

test('injects exact Codex native replacement history and only the uncovered suffix', () => {
  const adapter = new CodexCanonicalAdapter({ processFactory: () => new FakeProcess() })
  const base = snapshot()
  const nativeHistory = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'native summary' }] },
    { type: 'compaction', encrypted_content: 'opaque-checkpoint' },
  ]
  const projected = adapter.materialize(request(), {
    ...base,
    items: [
      base.items[0]!,
      {
        ...base.items[0]!, id: 'checkpoint', sequence: 2, kind: 'provider_event',
        visibility: 'provider_private', provider: 'codex',
        payload: { nativeContextCheckpoint: {
          version: 1, provider: 'codex', format: 'codex_replacement_history',
          history: nativeHistory, sourceModel: 'gpt-test',
        } },
      },
      { ...base.items[0]!, id: 'suffix', sequence: 3, payload: { text: 'suffix answer' } },
    ],
  }).body as Record<string, unknown>

  assert.deepEqual(projected.history, [
    ...nativeHistory,
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'suffix answer' }] },
  ])
})

function readFileTool(): AgentToolDefinition {
  return {
    name: 'read_file',
    description: 'Read a workspace file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    sideEffect: 'read_only',
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

test('Codex model catalog validation preserves provider-native agent support', () => {
  const hardened = hardenCodexModelCatalog(JSON.stringify({
    models: [
      { slug: 'gpt-5.6-sol', display_name: 'Sol', multi_agent_version: 'v2' },
      { slug: 'gpt-5.6-luna', display_name: 'Luna', multi_agent_version: 'v1' },
    ],
    etag: 'keep-me',
  }))
  assert.equal(hardened.modelCount, 2)
  assert.deepEqual(JSON.parse(hardened.json), {
    models: [
      { slug: 'gpt-5.6-sol', display_name: 'Sol', multi_agent_version: 'v2' },
      { slug: 'gpt-5.6-luna', display_name: 'Luna', multi_agent_version: 'v1' },
    ],
    etag: 'keep-me',
  })
})

test('Codex model catalog hardening fails closed on malformed or unidentified models', () => {
  assert.throws(() => hardenCodexModelCatalog('{'), /valid JSON/)
  assert.throws(() => hardenCodexModelCatalog('{"models":[]}'), /contain any models/)
  assert.throws(
    () => hardenCodexModelCatalog('{"models":[{"display_name":"missing slug"}]}'),
    /omitted its slug/,
  )
})

test('Codex preflight bounds a hung initialize request and terminates its process', async () => {
  const created: FakeProcess[] = []
  const adapter = new CodexCanonicalAdapter({
    shutdownTimeoutMs: 5,
    processFactory: () => {
      const process = new FakeProcess()
      created.push(process)
      return process
    },
  })

  await assert.rejects(adapter.initialize(), /initialize request timed out after 5ms/)
  assert.equal(created.length, 1)
  assert.deepEqual(await created[0]?.exited, { code: 0, signal: null })
})

test('Codex preflight bounds a hung stdin close and kills the process tree', async () => {
  const process = new FakeProcess((message, self) => {
    if (message.method === 'initialize') {
      self.emit({ id: idOf(message), result: { userAgent: 'codex-test/1' } })
    } else if (message.method === 'config/read') {
      self.emit({ id: idOf(message), result: configResult() })
    }
  })
  process.hangOnCloseInput = true
  const adapter = new CodexCanonicalAdapter({
    shutdownTimeoutMs: 5,
    processFactory: () => process,
  })

  const handshake = await adapter.initialize()
  assert.equal(handshake.adapterVersion, 'codex-test/1')
  assert.deepEqual(await process.exited, { code: null, signal: 'SIGTERM' })
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
  const environmentsSeen: Array<Readonly<Record<string, string>> | undefined> = []
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('normal', created, argsSeen, environmentsSeen),
    proxyConnection: async () => ({
      baseUrl: 'http://127.0.0.1:8317',
      token: 'proxy-token',
    }),
    shutdownTimeoutMs: 20,
  })
  const handshake = await adapter.initialize()
  assert.equal(handshake.capabilities.nativeChildExecution, 'exposed')
  assert.deepEqual(handshake.exposedNativeAgentTools, [
    'spawn_agent', 'send_input', 'resume_agent', 'wait', 'close_agent',
  ])
  assert.equal(handshake.capabilities.toolCalling, true)
  assert.equal(handshake.enforcementEvidence.source, 'config/read')
  assert.deepEqual(handshake.enforcementEvidence.providerLocalMetadataTools, ['update_plan'])
  const instructedSnapshot = snapshot()
  instructedSnapshot.thread.instructionSnapshot = { developerInstructions: 'Verify before finishing.' }
  const materialized = adapter.materialize(request(), instructedSnapshot)
  const execution = await adapter.execute(materialized, context())
  const [events, terminal] = await Promise.all([collect(execution.events), execution.terminal])
  assert.equal(terminal.status, 'completed')
  assert.deepEqual(terminal.usage, { totalTokens: 5, usageSource: 'tokenUsage.total' })
  const normalized = events.flatMap((event) => adapter.normalize(event))
  assert.ok(normalized.some((item) => item.kind === 'assistant_message'))
  assert.ok(normalized.some((item) => item.kind === 'reasoning_summary'))
  assert.ok(normalized.some((item) => item.kind === 'plan'))
  assert.ok(normalized.some((item) => item.kind === 'task'))
  assert.deepEqual(normalized.find((item) => item.kind === 'usage')?.payload, {
    totalTokens: 5,
    usageSource: 'tokenUsage.total',
    providerUsageSnapshot: {
      total: { totalTokens: 5 },
      last: { inputTokens: 3, outputTokens: 2 },
    },
  })
  for (const args of argsSeen) {
    assert.ok(args.includes('web_search="disabled"'))
    assert.ok(args.includes('project_doc_max_bytes=0'))
    assert.ok(args.includes('features.multi_agent=true'))
    assert.ok(args.includes('features.multi_agent_v2=true'))
    assert.ok(args.includes('features.enable_fanout=false'))
    assert.ok(args.includes('features.shell_tool=false'))
    assert.ok(args.includes('features.standalone_web_search=false'))
    assert.ok(args.includes('model_provider="baton"'))
    assert.ok(args.includes('model_providers.baton.name="Baton Native"'))
    assert.ok(args.includes('model_providers.baton.base_url="http://127.0.0.1:8317/v1"'))
    assert.ok(args.includes('model_providers.baton.env_key="BATON_PROXY_TOKEN"'))
    assert.ok(args.includes('model_providers.baton.wire_api="responses"'))
    assert.ok(args.includes('model_providers.baton.request_max_retries=0'))
    assert.ok(args.includes('model_providers.baton.stream_max_retries=0'))
    assert.ok(!args.some((argument) => argument.includes('proxy-token')))
  }
  assert.equal(environmentsSeen.length, 2)
  for (const environment of environmentsSeen) {
    assert.equal(environment?.BATON_PROXY_TOKEN, 'proxy-token')
    assert.equal(environment?.CODEX_HOME, path.join(tmpdir(), 'baton-codex-test-home'))
  }
  const turnProcess = created[1]
  const initialize = turnProcess.writes.find((message) => message.method === 'initialize')
  assert.ok(initialize)
  assert.deepEqual(
    (initialize.params as Record<string, Record<string, unknown>>).capabilities.optOutNotificationMethods,
    ['thread/status/changed'],
  )
  const threadStart = turnProcess.writes.find((message) => message.method === 'thread/start')
  assert.ok(threadStart)
  const params = threadStart.params as Record<string, unknown>
  assert.equal(params.ephemeral, false)
  assert.deepEqual(params.environments, [])
  assert.deepEqual(params.runtimeWorkspaceRoots, [])
  assert.equal(params.approvalsReviewer, 'user')
  assert.equal(params.approvalPolicy, 'never')
  assert.match(String(params.developerInstructions), /Baton is the canonical execution owner/)
  assert.match(String(params.developerInstructions), /Codex-native collaboration\/subagent tools/)
  assert.match(String(params.developerInstructions), /Verify before finishing\.$/)
  assert.deepEqual(params.dynamicTools, [])
  assert.deepEqual(params.config, {
    web_search: 'disabled',
    project_doc_max_bytes: 0,
    'features.multi_agent': true,
    'features.multi_agent_v2': true,
    'features.enable_fanout': false,
    'features.shell_tool': false,
    'features.standalone_web_search': false,
    'features.apps': false,
    'features.plugins': false,
  })
  const turnStart = turnProcess.writes.find((message) => message.method === 'turn/start')
  assert.ok(turnStart)
  assert.deepEqual((turnStart.params as Record<string, unknown>).environments, [])
  assert.deepEqual((turnStart.params as Record<string, unknown>).runtimeWorkspaceRoots, [])
  assert.equal((turnStart.params as Record<string, unknown>).webSearch, undefined)
  assert.equal((threadStart.params as Record<string, unknown>).allowProviderModelFallback, false)
  assert.ok(turnProcess.writes.some((message) => message.method === 'thread/inject_items'))
  await adapter.shutdown()
})

test('canonical Codex execution uses an authenticated per-turn cache bridge without exposing the upstream credential', async () => {
  const argsSeen: string[][] = []
  const environmentsSeen: Array<Readonly<Record<string, string>> | undefined> = []
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('normal', [], argsSeen, environmentsSeen),
    proxyConnection: async () => ({
      baseUrl: 'http://127.0.0.1:8317',
      token: 'upstream-proxy-token',
    }),
    cacheIdentitySecret: Buffer.alloc(32, 11),
    shutdownTimeoutMs: 20,
  })
  const handshake = await adapter.initialize()
  assert.equal(
    handshake.enforcementEvidence.canonicalCacheIdentity,
    'hmac-sha256-loopback-responses-bridge-v1',
  )
  const materialized = adapter.materialize(request(), snapshot())
  assert.equal(
    (materialized.body as Record<string, unknown>).canonicalThreadId,
    snapshot().thread.id,
  )
  const execution = await adapter.execute(materialized, context())
  await collect(execution.events)
  assert.equal((await execution.terminal).status, 'completed')
  await execution.dispose()

  assert.equal(argsSeen.length, 2)
  const turnBaseUrl = argsSeen[1]?.find((argument) =>
    argument.startsWith('model_providers.baton.base_url='))
  assert.ok(turnBaseUrl)
  assert.doesNotMatch(turnBaseUrl, /8317/)
  assert.match(turnBaseUrl, /^model_providers\.baton\.base_url="http:\/\/127\.0\.0\.1:\d+\/v1"$/)
  assert.equal(environmentsSeen[0]?.BATON_PROXY_TOKEN, 'upstream-proxy-token')
  assert.notEqual(environmentsSeen[1]?.BATON_PROXY_TOKEN, 'upstream-proxy-token')
  assert.ok(environmentsSeen[1]?.BATON_PROXY_TOKEN)
  await adapter.shutdown()
})

test('Codex automatic compaction is recorded as private lifecycle metadata instead of a capability failure', async () => {
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('compaction', [], []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
  const events = await collect(execution.events)
  assert.equal((await execution.terminal).status, 'completed')
  assert.deepEqual(events.flatMap((event) => adapter.normalize(event)).find((item) =>
    item.kind === 'provider_event' && item.payload.event === 'context_compaction'), {
    kind: 'provider_event',
    visibility: 'baton_private',
    payload: { event: 'context_compaction', status: 'completed' },
    provider: 'codex',
    nativeId: 'compact-1',
  })
})

test('adapter falls back to last usage only when Codex omits the cumulative total', async () => {
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('usageFallback', [], []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
  const [events, terminal] = await Promise.all([collect(execution.events), execution.terminal])

  assert.deepEqual(terminal.usage, {
    inputTokens: 3,
    outputTokens: 2,
    usageSource: 'tokenUsage.last',
  })
  assert.deepEqual(events.flatMap((event) => adapter.normalize(event))
    .find((item) => item.kind === 'usage')?.payload, {
      ...terminal.usage,
      providerUsageSnapshot: { last: { inputTokens: 3, outputTokens: 2 } },
    })
})

test('adapter exposes only Baton dynamic tools and returns their result through the provider call id', async () => {
  const created: FakeProcess[] = []
  const invocations: AgentToolInvocation[] = []
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('tool', created, []),
    shutdownTimeoutMs: 20,
    imageArtifacts: {
      pathFor: () => 'C:/Baton/image-artifacts/screen.png',
      dataUrl: () => 'data:image/png;base64,AAAA',
    },
  })
  const tool = readFileTool()
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context({
    tools: [tool],
    executeTool: async (invocation) => {
      invocations.push(invocation)
      return { success: true, content: { text: 'contents' }, images: [TEST_IMAGE], error: null }
    },
  }))
  const events = await collect(execution.events)
  assert.equal((await execution.terminal).status, 'completed')
  assert.deepEqual(invocations, [{
    callId: 'canonical-turn:provider-call-1',
    providerCallId: 'provider-call-1',
    name: 'read_file',
    input: { path: 'README.md' },
  }])
  const threadStart = created[1].writes.find((message) => message.method === 'thread/start')
  assert.ok(threadStart)
  assert.deepEqual((threadStart.params as Record<string, unknown>).dynamicTools, [{
    type: 'function',
    name: 'read_file',
    description: 'Read a workspace file',
    inputSchema: tool.inputSchema,
  }])
  const response = created[1].writes.find((message) => message.id === 60 && 'result' in message)
  assert.deepEqual(response?.result, {
    contentItems: [{
      type: 'inputText',
      text: JSON.stringify({ success: true, content: { text: 'contents' }, images: [TEST_IMAGE], error: null }),
    }, {
      type: 'inputImage',
      imageUrl: 'data:image/png;base64,AAAA',
    }],
    success: true,
  })
  const assistant = events.flatMap((event) => adapter.normalize(event))
    .find((item) => item.kind === 'assistant_message')
  assert.deepEqual(assistant?.payload, {
    text: 'done',
    requestedModel: 'gpt-test',
    resolvedModel: 'gpt-resolved',
    resolvedProvider: 'baton',
    effort: null,
  })
  await adapter.shutdown()
})

test('adapter audits provider-native collaboration and archives parent and child threads', async () => {
  const created: FakeProcess[] = []
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('collab', created, []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
  const events = await collect(execution.events)
  const terminal = await execution.terminal
  assert.equal(terminal.status, 'completed')
  assert.deepEqual(events.flatMap((event) => adapter.normalize(event)).find((item) =>
    item.kind === 'provider_event' && item.payload.event === 'provider_native_collaboration'), {
    kind: 'provider_event',
    visibility: 'baton_private',
    payload: {
      event: 'provider_native_collaboration',
      tool: 'spawnAgent',
      status: 'completed',
      senderThreadId: 'native-thread',
      receiverThreadIds: ['native-child-thread'],
    },
    provider: 'codex',
    nativeId: 'collab-1',
  })
  await execution.dispose()
  assert.deepEqual(created[1].writes.filter((message) => message.method === 'thread/archive')
    .map((message) => message.params), [
    { threadId: 'native-child-thread' },
    { threadId: 'native-thread' },
  ])
})

test('adapter accepts follow-up events from a registered provider-native child thread', async () => {
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('collabChildEvent', [], []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
  const events = await collect(execution.events)
  assert.equal((await execution.terminal).status, 'completed')
  assert.ok(events.some((event) => event.type === 'item/completed'
    && (event.payload as Record<string, unknown> | null)?.threadId === 'native-child-thread'))
})

test('adapter rejects collaboration events from an unowned sender thread', async () => {
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('foreignCollabSender', [], []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
  assert.equal((await execution.terminal).status, 'failed')
})

test('adapter executes Baton dynamic tools for a registered provider-native child thread', async () => {
  const invocations: AgentToolInvocation[] = []
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('collabChildTool', [], []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context({
    tools: [readFileTool()],
    executeTool: async (invocation) => {
      invocations.push(invocation)
      return { success: true, content: { text: 'child contents' }, error: null }
    },
  }))
  assert.equal((await execution.terminal).status, 'completed')
  assert.deepEqual(invocations, [{
    callId: 'canonical-turn:native-child-thread:native-child-turn:child-provider-call',
    providerCallId: 'child-provider-call',
    name: 'read_file',
    input: { path: 'README.md' },
  }])
})

test('adapter registers an owned child from thread/started before collaboration completes', async () => {
  const created: FakeProcess[] = []
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('childStartsBeforeCollab', created, []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
  const events = await collect(execution.events)
  const terminal = await execution.terminal
  assert.equal(terminal.status, 'completed')
  assert.deepEqual(terminal.usage, { totalTokens: 5, usageSource: 'tokenUsage.total' })
  const normalized = events.flatMap((event) => adapter.normalize(event))
  assert.ok(normalized.some((item) => item.kind === 'provider_event'
    && item.payload.event === 'provider_native_collaboration'))
  assert.ok(!normalized.some((item) => item.kind === 'assistant_message'
    && item.payload.text === 'private child output'))
  assert.equal(normalized.find((item) => item.kind === 'assistant_message')?.payload.resolvedModel, 'gpt-resolved')
  await execution.dispose()
  assert.ok(created[1].writes.some((message) => message.method === 'thread/archive'
    && (message.params as Record<string, unknown>).threadId === 'native-child-thread'))
})

test('adapter ignores notifications from an unrelated native root thread', async () => {
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('foreignNotification', [], []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
  const events = await collect(execution.events)
  assert.equal((await execution.terminal).status, 'completed')
  assert.ok(!events.some((event) => (event.payload as Record<string, unknown> | null)?.threadId
    === 'unrelated-native-root'))
})

test('adapter accepts native subagent activity without adding portable history', async () => {
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('subAgentActivity', [], []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
  const events = await collect(execution.events)
  assert.equal((await execution.terminal).status, 'completed')
  assert.ok(events.some((event) => event.type === 'item/completed'
    && ((event.payload as Record<string, unknown> | null)?.item as Record<string, unknown> | undefined)?.id
      === 'subagent-activity-1'))
  assert.ok(!events.flatMap((event) => adapter.normalize(event)).some((item) =>
    item.nativeId === 'subagent-activity-1'))
})

test('adapter does not grant ownership from non-spawn collaboration receivers', async () => {
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('nonSpawnUnknownReceiver', [], []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
  assert.equal((await execution.terminal).status, 'failed')
})

test('adapter still rejects unrelated native execution items', async () => {
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('forbiddenExecution', [], []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
  const events = await collect(execution.events)
  const terminal = await execution.terminal
  assert.equal(terminal.status, 'failed')
  assert.match(String(terminal.error?.message), /capability violation.*commandExecution/)
  assert.ok(events.some((event) => event.type === 'adapter/error'))
})

test('adapter forwards every unique call so the durable coordinator can enforce total limits', async () => {
  const created: FakeProcess[] = []
  const invocations: AgentToolInvocation[] = []
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('twoTools', created, []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context({
    tools: [readFileTool()],
    limits: { maxToolCalls: 1 },
    executeTool: async (invocation) => {
      invocations.push(invocation)
      if (invocations.length > 1) {
        return {
          success: false,
          content: null,
          error: { code: 'tool_call_limit', message: 'limit', retryable: false },
        }
      }
      return { success: true, content: { text: 'ok' }, error: null }
    },
  }))
  const terminal = await execution.terminal
  assert.equal(terminal.status, 'completed')
  assert.equal(invocations.length, 2)
  const secondResponse = created[1].writes.find((message) => message.id === 61 && 'result' in message)
  assert.ok(secondResponse)
  assert.equal((secondResponse.result as Record<string, unknown>).success, false)
  assert.match(JSON.stringify(secondResponse.result), /tool_call_limit/)
})

test('adapter blocks a new-round tool before side effects after the host round limit', async () => {
  const invocations: AgentToolInvocation[] = []
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('nextRoundTool', [], []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context({
    tools: [readFileTool()],
    limits: { maxModelRoundTrips: 1 },
    executeTool: async (invocation) => {
      invocations.push(invocation)
      return { success: true, content: { text: 'ok' }, error: null }
    },
  }))

  const terminal = await execution.terminal
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.error?.code, 'model_round_limit')
  assert.deepEqual(invocations, [])
})

test('adapter allows a tool with one follow-up round left and blocks the next tool before side effects', async () => {
  const invocations: AgentToolInvocation[] = []
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('nextRoundTool', [], []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context({
    tools: [readFileTool()],
    limits: { maxModelRoundTrips: 2 },
    executeTool: async (invocation) => {
      invocations.push(invocation)
      return { success: true, content: { text: 'ok' }, error: null }
    },
  }))

  const terminal = await execution.terminal
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.error?.code, 'model_round_limit')
  assert.deepEqual(invocations.map((invocation) => invocation.providerCallId), ['provider-call-1'])
})

test('adapter delegates repetition policy but replays an exact duplicate provider call id once', async () => {
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('twoTools', [], []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context({
    tools: [readFileTool()],
    limits: { maxIdenticalToolCalls: 1 },
    executeTool: async () => ({ success: true, content: { text: 'ok' }, error: null }),
  }))
  // The scripted calls use different paths, so both are distinct and allowed.
  assert.equal((await execution.terminal).status, 'completed')

  const identicalAdapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('twoIdentical', [], []),
    shutdownTimeoutMs: 20,
  })
  const identicalExecution = await identicalAdapter.execute(
    identicalAdapter.materialize(request(), snapshot()),
    context({
      tools: [readFileTool()],
      limits: { maxIdenticalToolCalls: 1 },
      executeTool: async (invocation) => invocation.providerCallId === 'provider-call-2'
        ? {
            success: false,
            content: null,
            error: { code: 'tool_repetition_limit', message: 'limit', retryable: false },
          }
        : { success: true, content: { text: 'ok' }, error: null },
    }),
  )
  assert.equal((await identicalExecution.terminal).status, 'completed')

  const duplicateAdapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('duplicateTool', [], []),
    shutdownTimeoutMs: 20,
  })
  let executions = 0
  const duplicateExecution = await duplicateAdapter.execute(
    duplicateAdapter.materialize(request(), snapshot()),
    context({
      tools: [readFileTool()],
      limits: { maxIdenticalToolCalls: 1 },
      executeTool: async () => {
        executions += 1
        return { success: true, content: { text: 'ok' }, error: null }
      },
    }),
  )
  // An exact replay of the same provider call id reuses its completed result.
  assert.equal((await duplicateExecution.terminal).status, 'completed')
  assert.equal(executions, 1)
})

test('adapter rejects foreign native ids', async () => {
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('foreignTool', [], []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context({
    tools: [readFileTool()],
    executeTool: async () => ({ success: true, content: { text: 'ok' }, error: null }),
  }))
  const terminal = await execution.terminal
  assert.equal(terminal.status, 'failed')
  assert.match(String(terminal.error?.message), /foreign/)
})

test('adapter ignores opted-out global lifecycle events for detached Codex threads', async () => {
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('foreignStatus', [], []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
  assert.equal((await execution.terminal).status, 'completed')
})

test('adapter rejects a resolved provider that bypasses the configured Baton proxy', async () => {
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('foreignProvider', [], []),
    proxyConnection: async () => ({ baseUrl: 'http://127.0.0.1:8317', token: 'proxy-token' }),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
  const terminal = await execution.terminal
  assert.equal(terminal.status, 'failed')
  assert.match(String(terminal.error?.message), /resolved model provider openai did not match baton/)
})

test('adapter rejects duplicate JSON-RPC tool request ids', async () => {
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('duplicateRpc', [], []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context({
    tools: [readFileTool()],
    executeTool: async () => ({ success: true, content: { text: 'ok' }, error: null }),
  }))
  const terminal = await execution.terminal
  assert.equal(terminal.status, 'failed')
  assert.match(String(terminal.error?.message), /duplicate/)
})

test('adapter waits for the coordinator authoritative tool settlement', async () => {
  let resolveTool!: (value: Awaited<ReturnType<ProviderExecutionContext['executeTool']>>) => void
  const never = new Promise<Awaited<ReturnType<ProviderExecutionContext['executeTool']>>>((resolve) => {
    resolveTool = resolve
  })
  const created: FakeProcess[] = []
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('tool', created, []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context({
    tools: [readFileTool()],
    limits: { toolTimeoutMs: 5 },
    executeTool: () => never,
  }))
  let terminalSettled = false
  void execution.terminal.then(() => { terminalSettled = true })
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(terminalSettled, false)
  assert.equal(created[1].writes.some((message) => message.id === 60 && 'result' in message), false)

  resolveTool({ success: true, content: { text: 'late' }, error: null })
  assert.equal((await execution.terminal).status, 'completed')
  const response = created[1].writes.find((message) => message.id === 60 && 'result' in message)
  assert.deepEqual(response?.result, {
    contentItems: [{
      type: 'inputText',
      text: JSON.stringify({ success: true, content: { text: 'late' }, error: null }),
    }],
    success: true,
  })
})

test('adapter counts observable model rounds from distinct cumulative usage updates', async () => {
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('twoRounds', [], []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context({
    limits: { maxModelRoundTrips: 1 },
  }))
  const terminal = await execution.terminal
  assert.equal(terminal.status, 'failed')
  assert.equal(terminal.error?.code, 'model_round_limit')
})

test('thread response and reroute provenance are preserved without relabeling the request', async () => {
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('reroute', [], []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
  const events = await collect(execution.events)
  assert.equal((await execution.terminal).status, 'completed')
  const assistant = events.flatMap((event) => adapter.normalize(event))
    .find((item) => item.kind === 'assistant_message')
  assert.deepEqual(assistant?.payload, {
    text: 'done',
    requestedModel: 'gpt-test',
    resolvedModel: 'gpt-routed',
    resolvedProvider: 'baton',
    effort: null,
  })
})

test('cancel sends turn/interrupt and waits for interrupted completion', async () => {
  const created: FakeProcess[] = []
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('cancel', created, []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
  await execution.cancel()
  assert.equal((await execution.terminal).status, 'cancelled')
  assert.ok(created[1].writes.some((message) => message.method === 'turn/interrupt'))
})

test('live follow-up uses exact turn/steer contract and never injects it as reconstructed history', async () => {
  const created: FakeProcess[] = []
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('cancel', created, []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
  assert.ok(execution.steer)
  const turnProcess = created[1]
  const initialInjectCount = turnProcess.writes.filter((message) => message.method === 'thread/inject_items').length
  const initialSteerCount = turnProcess.writes.filter((message) => message.method === 'turn/steer').length

  assert.deepEqual(await execution.steer({
    followUpId: 'follow-up-wrong-turn',
    text: 'must not be sent',
    expectedTurnId: 'another-canonical-turn',
  }), { status: 'closed' })
  assert.equal(turnProcess.writes.filter((message) => message.method === 'turn/steer').length, initialSteerCount)

  assert.deepEqual(await execution.steer({
    followUpId: 'follow-up-1',
    text: 'continue with this constraint',
    expectedTurnId: 'canonical-turn',
  }), { status: 'accepted' })
  const steerRpc = turnProcess.writes.find((message) => message.method === 'turn/steer')
  assert.deepEqual(steerRpc?.params, {
    threadId: 'native-thread',
    clientUserMessageId: 'follow-up-1',
    input: [{ type: 'text', text: 'continue with this constraint' }],
    expectedTurnId: 'native-turn',
  })
  assert.equal(
    turnProcess.writes.filter((message) => message.method === 'thread/inject_items').length,
    initialInjectCount,
    'live follow-up must not use thread/inject_items',
  )

  await execution.cancel()
  assert.deepEqual(await execution.steer({
    followUpId: 'follow-up-after-close',
    text: 'must remain queued',
    expectedTurnId: 'canonical-turn',
  }), { status: 'closed' })
  assert.equal(turnProcess.writes.filter((message) => message.method === 'turn/steer').length, initialSteerCount + 1)
})

test('malformed or foreign turn/steer acknowledgements remain unknown outcomes', async (t) => {
  for (const scenario of ['steerMalformed', 'steerNull', 'steerForeign'] as const) {
    await t.test(scenario, async () => {
      const created: FakeProcess[] = []
      const adapter = new CodexCanonicalAdapter({
        processFactory: scriptedFactory(scenario, created, []),
        shutdownTimeoutMs: 20,
      })
      const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
      assert.ok(execution.steer)
      await assert.rejects(execution.steer({
        followUpId: `follow-up-${scenario}`,
        text: 'keep this pending',
        expectedTurnId: 'canonical-turn',
      }), /outcome is unknown and must not be consumed or retried automatically/)
      assert.equal(created[1].writes.filter((message) => message.method === 'turn/steer').length, 1)
      await execution.cancel()
      assert.equal((await execution.terminal).status, 'cancelled')
    })
  }
})

test('official Codex steer closure and unsupported errors are deterministic outcomes', async (t) => {
  for (const [scenario, status] of [
    ['steerClosed', 'closed'],
    ['steerUnsupported', 'unsupported'],
  ] as const) {
    await t.test(scenario, async () => {
      const adapter = new CodexCanonicalAdapter({
        processFactory: scriptedFactory(scenario, [], []),
        shutdownTimeoutMs: 20,
      })
      const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
      assert.ok(execution.steer)
      assert.deepEqual(await execution.steer({
        followUpId: `follow-up-${scenario}`,
        text: 'classify without retry',
        expectedTurnId: 'canonical-turn',
      }), { status })
      await execution.cancel()
    })
  }
})

test('cancel closes queued steers and waits for the in-flight acknowledgement', async () => {
  const created: FakeProcess[] = []
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('steerManual', created, []),
    shutdownTimeoutMs: 50,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
  assert.ok(execution.steer)
  const first = execution.steer({
    followUpId: 'follow-up-in-flight',
    text: 'first',
    expectedTurnId: 'canonical-turn',
  })
  await Promise.resolve()
  const process = created[1]
  const firstRpc = process.writes.find((message) => message.method === 'turn/steer')
  assert.ok(firstRpc)
  const second = execution.steer({
    followUpId: 'follow-up-queued',
    text: 'second',
    expectedTurnId: 'canonical-turn',
  })
  const cancelling = execution.cancel()
  await Promise.resolve()
  assert.equal(process.writes.filter((message) => message.method === 'turn/steer').length, 1)

  process.emit({ id: idOf(firstRpc), result: { turnId: 'native-turn' } })
  assert.deepEqual(await first, { status: 'accepted' })
  assert.deepEqual(await second, { status: 'closed' })
  await cancelling
  assert.equal((await execution.terminal).status, 'cancelled')
  assert.equal(process.writes.filter((message) => message.method === 'turn/steer').length, 1)
})

test('cancel hard-stops a Codex process when turn/interrupt never answers', async () => {
  const created: FakeProcess[] = []
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('hangInterrupt', created, []),
    shutdownTimeoutMs: 10,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
  await execution.cancel()
  const terminal = await execution.terminal
  assert.equal(terminal.status, 'cancelled')
  assert.match(String(terminal.error?.message), /timed out/)
  assert.deepEqual(await created[1].exited, { code: null, signal: 'SIGTERM' })
})

test('abort and turn timeout win over a late native completion', async () => {
  const controller = new AbortController()
  const created: FakeProcess[] = []
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('cancel', created, []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context({
    signal: controller.signal,
  }))
  controller.abort()
  created[1].emit({
    method: 'turn/completed',
    params: {
      threadId: 'native-thread',
      turn: { id: 'native-turn', status: 'completed', error: null },
    },
  })
  const aborted = await execution.terminal
  assert.equal(aborted.status, 'cancelled')
  assert.equal(aborted.error?.code, 'user_cancelled')

  const timeoutAdapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('cancel', [], []),
    shutdownTimeoutMs: 20,
  })
  const timeoutExecution = await timeoutAdapter.execute(
    timeoutAdapter.materialize(request(), snapshot()),
    context({ limits: { turnTimeoutMs: 5 } }),
  )
  const timedOut = await timeoutExecution.terminal
  assert.equal(timedOut.status, 'cancelled')
  assert.equal(timedOut.error?.code, 'turn_time_limit')
})

test('process exit before turn completion produces a failed terminal result', async () => {
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('exit', [], []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
  const terminal = await execution.terminal
  assert.equal(terminal.status, 'failed')
  assert.match(String(terminal.error?.message), /code 7: invalid test configuration/)
})

test('Codex usage-limit TurnError is normalized without discarding official fields', async () => {
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('usageLimit', [], []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
  const terminal = await execution.terminal
  assert.equal(terminal.status, 'failed')
  assert.deepEqual(terminal.error, {
    message: 'quota exhausted',
    codexErrorInfo: 'usageLimitExceeded',
    additionalDetails: 'preserved',
    code: 'provider_usage_limit',
  })
})

test('Codex exhausted transient upstream errors retain fields and receive a retryable category', async () => {
  const adapter = new CodexCanonicalAdapter({
    processFactory: scriptedFactory('transientFailure', [], []),
    shutdownTimeoutMs: 20,
  })
  const execution = await adapter.execute(adapter.materialize(request(), snapshot()), context())
  const terminal = await execution.terminal
  assert.equal(terminal.status, 'failed')
  assert.deepEqual(terminal.error, {
    message: 'unexpected status 503 Service Unavailable: upstream connect error',
    codexErrorInfo: 'other',
    additionalDetails: null,
    code: 'provider_retry_exhausted',
  })
})
