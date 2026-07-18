import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type {
  AdapterHandshake,
  CanonicalTurnRequest,
  NativeProviderEvent,
  NativeTurnRequest,
  ProviderExecutionContext,
  ProviderTerminalResult,
  ProviderTurnExecution,
  SessionProviderAdapter,
} from './adapter.ts'
import type { NewCanonicalItem, ThreadSnapshot } from './domain.ts'

const HARDENING_OVERRIDES = Object.freeze({
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.enable_fanout': false,
  'features.shell_tool': false,
  'features.apps': false,
  'features.plugins': false,
})

const VERIFIED_FEATURES = [
  'multi_agent',
  'multi_agent_v2',
  'enable_fanout',
  'shell_tool',
  'apps',
  'plugins',
] as const

const ALLOWED_ITEM_TYPES = new Set(['userMessage', 'agentMessage', 'reasoning', 'plan'])

type JsonObject = Record<string, unknown>
type ExitResult = { code: number | null; signal: NodeJS.Signals | null; stderr?: string }

export interface CodexAppServerProcess {
  readonly stdout: AsyncIterable<string | Uint8Array>
  readonly exited: Promise<ExitResult>
  write(line: string): Promise<void>
  closeInput(): Promise<void>
  kill(): Promise<void>
}

export type CodexProcessFactory = (
  executable: string,
  args: readonly string[],
  environment?: Readonly<Record<string, string>>,
) => CodexAppServerProcess

export interface CodexProxyConnection {
  baseUrl: string
  token: string
}

export interface CodexAdapterOptions {
  executable?: string
  processFactory?: CodexProcessFactory
  shutdownTimeoutMs?: number
  proxyConnection?: () => Promise<CodexProxyConnection>
}

interface MaterializedCodexTurn {
  turnId: string
  model: string
  effort: string | null
  cwd: string | null
  history: JsonObject[]
  input: Array<{ type: 'text'; text: string }>
}

interface RpcMessage {
  id?: string | number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<T>) => void
    reject: (error: unknown) => void
  }> = []
  private ended = false
  private failure: unknown = null

  push(value: T): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve({ value, done: false })
    else this.values.push(value)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true })
  }

  fail(error: unknown): void {
    if (this.ended) return
    this.failure = error
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.failure !== null) return Promise.reject(this.failure)
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject })
        })
      },
    }
  }
}

/** JSONL JSON-RPC client used by the adapter and its protocol contract tests. */
export class CodexJsonlRpcClient {
  private readonly process: CodexAppServerProcess
  private readonly pending = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >()
  private readonly messages = new AsyncQueue<RpcMessage>()
  private nextId = 1
  private readonly pump: Promise<void>

  constructor(process: CodexAppServerProcess) {
    this.process = process
    this.pump = this.readOutput()
    void this.process.exited.then(
      (result) => this.failPending(new Error(`Codex app-server exited (${exitLabel(result)})`)),
      (error: unknown) => this.failPending(error),
    )
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    try {
      await this.process.write(`${JSON.stringify({ method, id, ...(params === undefined ? {} : { params }) })}\n`)
    } catch (error) {
      this.pending.delete(id)
      throw error
    }
    return response
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.process.write(
      `${JSON.stringify({ method, ...(params === undefined ? {} : { params }) })}\n`,
    )
  }

  incoming(): AsyncIterable<RpcMessage> {
    return this.messages
  }

  async drained(): Promise<void> {
    await this.pump
  }

  private async readOutput(): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for await (const chunk of this.process.stdout) {
        buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line.length > 0) this.accept(JSON.parse(line) as RpcMessage)
          newline = buffer.indexOf('\n')
        }
      }
      buffer += decoder.decode()
      if (buffer.trim().length > 0) this.accept(JSON.parse(buffer) as RpcMessage)
      this.failPending(new Error('Codex app-server stdout closed'))
      this.messages.end()
    } catch (error) {
      this.failPending(error)
      this.messages.fail(error)
    }
  }

  private accept(message: RpcMessage): void {
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(
          new Error(
            `Codex app-server request failed: ${message.error.message ?? 'unknown JSON-RPC error'}`,
          ),
        )
      } else pending.resolve(message.result)
      return
    }
    this.messages.push(message)
  }

  private failPending(error: unknown): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

export class CodexCanonicalAdapter implements SessionProviderAdapter {
  readonly provider = 'codex' as const
  private readonly executable: string
  private readonly processFactory: CodexProcessFactory
  private readonly shutdownTimeoutMs: number
  private readonly proxyConnectionProvider: (() => Promise<CodexProxyConnection>) | undefined
  private proxyConnection: CodexProxyConnection | null = null
  private initializePromise: Promise<AdapterHandshake> | null = null
  private mcpDisableOverrides: Record<string, false> = {}
  private readonly active = new Set<ProviderTurnExecution>()
  private shuttingDown = false

  constructor(options: CodexAdapterOptions = {}) {
    this.executable = options.executable ?? (process.platform === 'win32' ? 'codex.cmd' : 'codex')
    this.processFactory = options.processFactory ?? spawnCodexProcess
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000
    this.proxyConnectionProvider = options.proxyConnection
  }

  initialize(): Promise<AdapterHandshake> {
    this.initializePromise ??= this.preflight()
    return this.initializePromise
  }

  validate(request: CanonicalTurnRequest, snapshot: ThreadSnapshot): void {
    if (request.model.trim().length === 0) throw new Error('Codex model is required')
    if (snapshot.thread.status === 'archived') throw new Error('Cannot execute an archived thread')
    if (request.input.length === 0) throw new Error('Codex turn requires text input')
    for (const item of request.input) {
      if (item.kind !== 'user_message' || portableText(item.payload) === null) {
        throw new Error('Safe Codex mode accepts text user_message input only')
      }
    }
  }

  materialize(request: CanonicalTurnRequest, snapshot: ThreadSnapshot): NativeTurnRequest {
    this.validate(request, snapshot)
    const history = snapshot.items.flatMap((item): JsonObject[] => {
      if (item.visibility !== 'portable') return []
      const text = portableHistoryText(item.kind, item.payload)
      if (text === null) return []
      const role = item.kind === 'user_message' ? 'user' : 'assistant'
      return [
        {
          type: 'message',
          role,
          content: [
            {
              type: role === 'user' ? 'input_text' : 'output_text',
              text,
            },
          ],
        },
      ]
    })
    const body: MaterializedCodexTurn = {
      turnId: request.turnId,
      model: request.model,
      effort: request.effort ?? null,
      cwd: snapshot.session.cwd,
      history,
      input: request.input.map((item) => ({
        type: 'text',
        text: portableText(item.payload) as string,
      })),
    }
    return { body }
  }

  async execute(
    request: NativeTurnRequest,
    context: ProviderExecutionContext,
  ): Promise<ProviderTurnExecution> {
    if (this.shuttingDown) throw new Error('Codex adapter is shutting down')
    await this.initialize()
    const body = parseMaterializedRequest(request.body)
    const process = this.processFactory(
      this.executable,
      launchArgs(this.mcpDisableOverrides, this.proxyConnection),
      proxyEnvironment(this.proxyConnection),
    )
    const client = new CodexJsonlRpcClient(process)
    const eventQueue = new AsyncQueue<NativeProviderEvent>()
    let terminalResult: ProviderTerminalResult | null = null
    let terminalResolve!: (result: ProviderTerminalResult) => void
    const terminal = new Promise<ProviderTerminalResult>((resolve) => {
      terminalResolve = resolve
    })
    let disposed = false
    let nativeThreadId: string | null = null
    let nativeTurnId: string | null = null
    let latestUsage: Record<string, unknown> | null = null
    let cancelPromise: Promise<void> | null = null

    const finish = (result: ProviderTerminalResult): void => {
      if (terminalResult !== null) return
      terminalResult = result
      terminalResolve(result)
      eventQueue.end()
    }

    const fail = (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error)
      if (terminalResult === null) {
        eventQueue.push({
          eventId: `codex:error:${body.turnId}:${digest(message)}`,
          type: 'adapter/error',
          payload: { message },
          durability: 'durable',
        })
      }
      finish({ status: 'failed', error: { message } })
      void process.kill().catch(() => undefined)
    }

    const dispose = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      await process.closeInput().catch(() => undefined)
      const exited = await Promise.race([
        process.exited.then(() => true, () => true),
        delay(this.shutdownTimeoutMs).then(() => false),
      ])
      if (!exited) {
        await process.kill().catch(() => undefined)
        await Promise.race([
          process.exited.catch(() => undefined),
          delay(this.shutdownTimeoutMs),
        ])
      }
    }

    const cancel = async (): Promise<void> => {
      cancelPromise ??= (async () => {
        if (terminalResult !== null) return
        if (nativeThreadId === null || nativeTurnId === null) {
          fail(new Error('Codex turn could not be interrupted before native ids were assigned'))
          return
        }
        try {
          await withTimeout(client.request('turn/interrupt', {
            threadId: nativeThreadId,
            turnId: nativeTurnId,
          }), this.shutdownTimeoutMs, 'Codex turn/interrupt request')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          finish({ status: 'interrupted', error: { message } })
          await process.kill().catch(() => undefined)
          return
        }
        const result = await withTimeout(
          terminal,
          this.shutdownTimeoutMs,
          'Codex interrupted terminal event',
        )
        if (result.status !== 'interrupted' && result.status !== 'completed') {
          throw new Error(`Codex interruption ended as ${result.status}`)
        }
      })().catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error)
        finish({ status: 'interrupted', error: { message } })
        await process.kill().catch(() => undefined)
      })
      return cancelPromise
    }

    const execution: ProviderTurnExecution = { events: eventQueue, terminal, cancel, dispose }
    this.active.add(execution)
    void terminal.finally(() => {
      this.active.delete(execution)
      void dispose()
    })

    try {
      const initialize = asObject(
        await client.request('initialize', {
          clientInfo: { name: 'baton', title: 'Baton', version: '0.1.0' },
          capabilities: {
            experimentalApi: true,
            mcpServerOpenaiFormElicitation: false,
          },
        }),
        'initialize response',
      )
      if (typeof initialize.userAgent !== 'string') {
        throw new Error('Codex initialize response omitted userAgent')
      }
      await client.notify('initialized')
      const effectiveConfig = asObject(await client.request('config/read', {}), 'config/read result')
      assertHardeningConfig(effectiveConfig)
      assertMcpServersDisabled(effectiveConfig)

      const start = asObject(
        await client.request('thread/start', {
          model: body.model,
          effort: body.effort,
          cwd: body.cwd,
          environments: [],
          runtimeWorkspaceRoots: [],
          ephemeral: true,
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          config: { ...HARDENING_OVERRIDES, ...this.mcpDisableOverrides },
        }),
        'thread/start result',
      )
      const thread = asObject(start.thread, 'thread/start thread')
      if (thread.ephemeral !== true || thread.path !== null) {
        throw new Error('Codex canonical mode requires an ephemeral thread with no rollout path')
      }
      if (!Array.isArray(start.runtimeWorkspaceRoots) || start.runtimeWorkspaceRoots.length !== 0) {
        throw new Error('Codex canonical mode requires zero execution environment roots')
      }
      nativeThreadId = requiredString(thread.id, 'Codex thread id')
      assertFeatureList(
        asObject(
          await client.request('experimentalFeature/list', { threadId: nativeThreadId }),
          'experimentalFeature/list result',
        ),
      )
      if (body.history.length > 0) {
        await client.request('thread/inject_items', {
          threadId: nativeThreadId,
          items: body.history,
        })
      }
      const turnStart = asObject(
        await client.request('turn/start', {
          threadId: nativeThreadId,
          clientUserMessageId: body.turnId,
          input: body.input,
          model: body.model,
          effort: body.effort,
          environments: [],
          runtimeWorkspaceRoots: [],
          approvalsReviewer: 'user',
          approvalPolicy: 'never',
        }),
        'turn/start result',
      )
      nativeTurnId = requiredString(asObject(turnStart.turn, 'turn/start turn').id, 'Codex turn id')

      void (async () => {
        try {
          for await (const message of client.incoming()) {
            if (message.method === undefined) continue
            if (message.id !== undefined) {
              if (isApprovalRequest(message.method)) {
                await context.denyApproval(message).catch(() => undefined)
              } else {
                await context.denyToolCall(message).catch(() => undefined)
              }
              throw capabilityViolation(`unexpected server request ${message.method}`)
            }
            const params = asOptionalObject(message.params)
            if (isForbiddenNotification(message.method, params)) {
              throw capabilityViolation(`unexpected native execution event ${message.method}`)
            }
            if (message.method === 'thread/tokenUsage/updated') {
              const usage = asOptionalObject(params?.tokenUsage)
              latestUsage = asOptionalObject(usage?.last) ?? usage
            }
            const event = nativeEvent(message.method, params)
            eventQueue.push(event)
            if (message.method === 'turn/completed') {
              const turn = asObject(params?.turn, 'turn/completed turn')
              if (turn.id !== nativeTurnId) continue
              const status = terminalStatus(turn.status)
              finish({
                status,
                usage: latestUsage,
                error: asOptionalObject(turn.error),
              })
              return
            }
          }
          if (terminalResult === null) fail(new Error('Codex event stream closed before turn completion'))
        } catch (error) {
          fail(error)
        }
      })()

      void process.exited.then(
        (result) => {
          if (terminalResult === null) {
            fail(new Error(`Codex app-server exited before turn completion (${exitLabel(result)})`))
          }
        },
        fail,
      )
      const cancelOnAbort = () => { void cancel().catch(() => undefined) }
      if (context.signal.aborted) cancelOnAbort()
      else context.signal.addEventListener('abort', cancelOnAbort, { once: true })
      return execution
    } catch (error) {
      fail(error)
      await dispose()
      return execution
    }
  }

  normalize(event: NativeProviderEvent): NewCanonicalItem[] {
    const payload = asOptionalObject(event.payload)
    if (event.type === 'item/completed') {
      const item = asOptionalObject(payload?.item)
      if (item === null) return []
      const type = item?.type
      const nativeId = typeof item?.id === 'string' ? item.id : null
      // The canonical input item is committed before provider execution. Ignore Codex's echo.
      if (type === 'userMessage') return []
      if (type === 'agentMessage' && typeof item.text === 'string') {
        return [{ kind: 'assistant_message', payload: { text: item.text }, provider: 'codex', nativeId }]
      }
      if (type === 'reasoning') {
        return [{
          kind: 'reasoning_summary',
          payload: { summary: Array.isArray(item.summary) ? item.summary : [] },
          provider: 'codex',
          nativeId,
        }]
      }
      if (type === 'plan' && typeof item.text === 'string') {
        return [{ kind: 'plan', payload: { text: item.text }, provider: 'codex', nativeId }]
      }
    }
    if (event.type === 'turn/plan/updated') {
      return [{
        kind: 'task',
        payload: {
          explanation: payload?.explanation ?? null,
          plan: Array.isArray(payload?.plan) ? payload.plan : [],
        },
        provider: 'codex',
      }]
    }
    if (event.type === 'thread/tokenUsage/updated') {
      return [{ kind: 'usage', visibility: 'baton_private', payload: payload ?? {}, provider: 'codex' }]
    }
    if (event.type === 'adapter/error') {
      return [{ kind: 'error', payload: payload ?? {}, provider: 'codex' }]
    }
    return []
  }

  // Every safe Codex turn owns an ephemeral process/thread that is disposed at
  // completion. Persisting its native id would create a false resumable binding.
  extractBinding(_event: NativeProviderEvent) { return null }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    await Promise.allSettled([...this.active].map((execution) => execution.dispose()))
  }

  private async preflight(): Promise<AdapterHandshake> {
    this.proxyConnection = this.proxyConnectionProvider
      ? await this.proxyConnectionProvider()
      : null
    const initial = await this.inspectConfig({})
    const config = asObject(initial.configRead.config, 'config/read config')
    this.mcpDisableOverrides = mcpServerDisableOverrides(config)
    const hardened = Object.keys(this.mcpDisableOverrides).length > 0
      ? await this.inspectConfig(this.mcpDisableOverrides)
      : initial
    const evidence = assertHardeningConfig(hardened.configRead)
    assertMcpServersDisabled(hardened.configRead)
    return {
      adapterVersion: requiredString(hardened.initialized.userAgent, 'Codex userAgent'),
      capabilities: {
        roles: ['user', 'assistant'],
        contentTypes: ['text'],
        toolCalling: false,
        parallelTools: false,
        contextWindow: null,
        continuation: 'stateless',
        reasoningState: 'portable-summary',
        taskMetadata: true,
        nativeChildExecution: 'disabled',
      },
      exposedNativeAgentTools: [],
      enforcementEvidence: {
        ...evidence,
        mcpServersDisabled: Object.keys(this.mcpDisableOverrides).length,
      },
    }
  }

  private async inspectConfig(
    overrides: Record<string, false>,
  ): Promise<{ initialized: JsonObject; configRead: JsonObject }> {
    const process = this.processFactory(
      this.executable,
      launchArgs(overrides, this.proxyConnection),
      proxyEnvironment(this.proxyConnection),
    )
    const client = new CodexJsonlRpcClient(process)
    try {
      const initialized = asObject(
        await client.request('initialize', {
          clientInfo: { name: 'baton', title: 'Baton', version: '0.1.0' },
          capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: false },
        }),
        'initialize response',
      )
      await client.notify('initialized')
      const configRead = asObject(await client.request('config/read', {}), 'config/read result')
      return { initialized, configRead }
    } finally {
      await process.closeInput().catch(() => undefined)
      const exited = await Promise.race([
        process.exited.then(() => true, () => true),
        delay(this.shutdownTimeoutMs).then(() => false),
      ])
      if (!exited) await process.kill().catch(() => undefined)
    }
  }
}

function launchArgs(
  additional: Record<string, false> = {},
  connection: CodexProxyConnection | null = null,
): string[] {
  const providerOverrides = connection ? {
    model_provider: 'baton',
    'model_providers.baton.name': 'Baton CLIProxy',
    'model_providers.baton.base_url': `${connection.baseUrl}/v1`,
    'model_providers.baton.env_key': 'BATON_PROXY_TOKEN',
    'model_providers.baton.wire_api': 'responses',
  } : {}
  const overrides = Object.entries({
    ...HARDENING_OVERRIDES,
    ...providerOverrides,
    ...additional,
  }).flatMap(([key, value]) => [
    '--config',
    `${key}=${valueAsToml(value)}`,
  ])
  return [...overrides, 'app-server', '--stdio']
}

function valueAsToml(value: unknown): string {
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (value && typeof value === 'object' && Object.keys(value as JsonObject).length === 0) return '{}'
  throw new Error('Unsupported Codex hardening override')
}

function proxyEnvironment(
  connection: CodexProxyConnection | null,
): Readonly<Record<string, string>> | undefined {
  return connection ? { BATON_PROXY_TOKEN: connection.token } : undefined
}

function assertHardeningConfig(result: JsonObject): Record<string, unknown> {
  const config = asObject(result.config, 'config/read config')
  const checks: Record<string, unknown> = {}
  for (const [key, expected] of Object.entries(HARDENING_OVERRIDES)) {
    const actual = readPath(config, key.split('.'))
    const emptyObjectExpected = typeof expected === 'object'
    const matches = emptyObjectExpected
      ? actual === undefined || (isObject(actual) && Object.keys(actual).length === 0)
      : actual === expected
    if (!matches) throw capabilityViolation(`effective Codex config did not enforce ${key}`)
    checks[key] = actual ?? {}
  }
  return { source: 'config/read', effective: checks, launchOverrides: launchArgs().slice(0, -2) }
}

function mcpServerDisableOverrides(config: JsonObject): Record<string, false> {
  const servers = asOptionalObject(config.mcp_servers)
  if (!servers) return {}
  return Object.fromEntries(Object.keys(servers).sort().map((name) => [
    `mcp_servers.${tomlKeySegment(name)}.enabled`,
    false,
  ]))
}

function assertMcpServersDisabled(result: JsonObject): void {
  const config = asObject(result.config, 'config/read config')
  const servers = asOptionalObject(config.mcp_servers)
  if (!servers) return
  for (const [name, value] of Object.entries(servers)) {
    const server = asOptionalObject(value)
    if (server?.enabled !== false) {
      throw capabilityViolation(`MCP server remained enabled: ${name}`)
    }
  }
}

function tomlKeySegment(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value)
}

function assertFeatureList(result: JsonObject): void {
  if (!Array.isArray(result.data)) throw new Error('Codex feature list omitted data')
  const states = new Map<string, unknown>()
  for (const entry of result.data) {
    if (isObject(entry) && typeof entry.name === 'string') states.set(entry.name, entry.enabled)
  }
  for (const feature of VERIFIED_FEATURES) {
    if (states.get(feature) !== false) {
      throw capabilityViolation(`effective Codex thread feature ${feature} is not disabled`)
    }
  }
}

function parseMaterializedRequest(value: unknown): MaterializedCodexTurn {
  const body = asObject(value, 'Codex native turn request')
  if (!Array.isArray(body.history) || !Array.isArray(body.input)) {
    throw new Error('Invalid Codex native turn request')
  }
  return {
    turnId: requiredString(body.turnId, 'canonical turn id'),
    model: requiredString(body.model, 'Codex model'),
    effort: typeof body.effort === 'string' ? body.effort : null,
    cwd: typeof body.cwd === 'string' ? body.cwd : null,
    history: body.history.map((item) => asObject(item, 'Codex history item')),
    input: body.input.map((item) => {
      const input = asObject(item, 'Codex text input')
      return { type: 'text', text: requiredString(input.text, 'Codex input text') }
    }),
  }
}

function nativeEvent(method: string, params: JsonObject | null): NativeProviderEvent {
  const durable = method === 'item/completed'
    || method === 'turn/plan/updated'
    || method === 'thread/tokenUsage/updated'
  return {
    eventId: durable ? durableEventId(method, params) : null,
    type: method,
    payload: params,
    durability: durable ? 'durable' : 'ephemeral',
  }
}

function durableEventId(method: string, params: JsonObject | null): string {
  const item = asOptionalObject(params?.item)
  const identity = typeof item?.id === 'string'
    ? item.id
    : `${params?.threadId ?? ''}:${params?.turnId ?? ''}:${digest(JSON.stringify(params ?? {}))}`
  return `codex:${method}:${identity}`
}

function isForbiddenNotification(method: string, params: JsonObject | null): boolean {
  if (method.startsWith('item/autoApprovalReview/')) return true
  if (method === 'rawResponseItem/completed') return true
  if (method !== 'item/started' && method !== 'item/completed') return false
  const item = asOptionalObject(params?.item)
  return typeof item?.type !== 'string' || !ALLOWED_ITEM_TYPES.has(item.type)
}

function isApprovalRequest(method: string): boolean {
  return method.includes('requestApproval')
    || method === 'item/tool/requestUserInput'
    || method === 'mcpServer/elicitation/request'
}

function terminalStatus(value: unknown): ProviderTerminalResult['status'] {
  if (value === 'completed') return 'completed'
  if (value === 'interrupted') return 'interrupted'
  if (value === 'failed') return 'failed'
  throw new Error(`Unexpected Codex terminal status ${String(value)}`)
}

function portableHistoryText(kind: string, payload: JsonObject): string | null {
  const text = portableText(payload)
  if (text === null) return null
  if (kind === 'user_message' || kind === 'assistant_message') return text
  if (kind === 'reasoning_summary') return `[Reasoning summary]\n${text}`
  if (kind === 'plan' || kind === 'task') return `[Plan]\n${text}`
  if (kind === 'summary') return `[Conversation summary]\n${text}`
  return null
}

function portableText(payload: JsonObject): string | null {
  if (typeof payload.text === 'string' && payload.text.length > 0) return payload.text
  if (typeof payload.content === 'string' && payload.content.length > 0) return payload.content
  if (Array.isArray(payload.summary)) {
    const parts = payload.summary.filter((part): part is string => typeof part === 'string')
    if (parts.length > 0) return parts.join('\n')
  }
  if (Array.isArray(payload.plan)) return JSON.stringify(payload.plan)
  return null
}

function spawnCodexProcess(
  executable: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): CodexAppServerProcess {
  const invocation = resolveCodexInvocation(executable, args)
  const child = spawn(invocation.executable, invocation.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    detached: process.platform !== 'win32',
    env: { ...process.env, ...environment },
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  let spawnError: unknown = null
  child.once('error', (error) => {
    spawnError = error
  })
  const exited = new Promise<ExitResult>((resolve, reject) => {
    child.once('exit', (code, signal) => {
      if (spawnError) reject(spawnError)
      else resolve({ code, signal, stderr: stderr.trim() })
    })
    child.once('error', reject)
  })
  return {
    stdout: child.stdout,
    exited,
    write: (line) => new Promise<void>((resolve, reject) => {
      child.stdin.write(line, (error) => error
        ? reject(new Error(`${error.message}${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
        : resolve())
    }),
    closeInput: () => new Promise<void>((resolve) => {
      if (child.stdin.destroyed) resolve()
      else child.stdin.end(resolve)
    }),
    kill: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      if (process.platform === 'win32') {
        await new Promise<void>((resolve) => {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          })
          killer.once('error', () => {
            child.kill()
            resolve()
          })
          killer.once('exit', () => resolve())
        })
      } else if (child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill() }
      }
    },
  }
}

interface CodexInvocation {
  executable: string
  args: string[]
}

/** Resolve the npm shim to the native Codex binary so Baton owns one OS process tree. */
function resolveCodexInvocation(executable: string, args: readonly string[]): CodexInvocation {
  if (process.platform !== 'win32') return { executable, args: [...args] }
  if (/\.exe$/i.test(executable)) return { executable, args: [...args] }
  if (!/^codex(?:\.cmd)?$/i.test(path.basename(executable))) {
    throw new Error('Unsafe Codex command shim; configure the native codex executable')
  }

  const shim = resolveWindowsCommand(executable)
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
  const triple = process.arch === 'arm64'
    ? 'aarch64-pc-windows-msvc'
    : 'x86_64-pc-windows-msvc'
  const native = path.join(
    path.dirname(shim),
    'node_modules',
    '@openai',
    'codex',
    'node_modules',
    '@openai',
    `codex-win32-${architecture}`,
    'vendor',
    triple,
    'bin',
    'codex.exe',
  )
  if (!existsSync(native)) {
    throw new Error(`Native Codex executable was not found next to ${shim}`)
  }
  return { executable: native, args: [...args] }
}

function resolveWindowsCommand(executable: string): string {
  if (path.isAbsolute(executable) && existsSync(executable)) return executable
  const requested = /\.cmd$/i.test(executable) ? executable : `${executable}.cmd`
  const matches = execFileSync('where.exe', [requested], { encoding: 'utf8', windowsHide: true })
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
  const match = matches.find((entry) => existsSync(entry))
  if (!match) throw new Error(`Codex command was not found: ${requested}`)
  return match
}

function capabilityViolation(message: string): Error {
  return new Error(`Codex capability violation: ${message}`)
}

function asObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new Error(`${label} must be an object`)
  return value
}

function asOptionalObject(value: unknown): JsonObject | null {
  return isObject(value) ? value : null
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`)
  return value
}

function readPath(value: unknown, path: string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (!isObject(current)) return undefined
    current = current[key]
  }
  return current
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function exitLabel(result: ExitResult): string {
  const status = result.signal ?? `code ${String(result.code)}`
  return result.stderr ? `${status}: ${result.stderr}` : status
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds)
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
