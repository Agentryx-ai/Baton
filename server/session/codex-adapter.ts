import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import type {
  AdapterHandshake,
  CanonicalTurnRequest,
  NativeProviderEvent,
  NativeTurnRequest,
  ProviderExecutionContext,
  ProviderSteerRequest,
  ProviderSteerResult,
  ProviderTerminalResult,
  ProviderTurnExecution,
  ProviderSkillResource,
  SessionProviderAdapter,
} from './adapter.ts'
import type { AgentToolResult, NewCanonicalItem, PermissionProfile, ThreadSnapshot } from './domain.ts'
import {
  canonicalConversationCacheKey,
  startCanonicalResponsesBridge,
  type CanonicalResponsesBridge,
} from './canonical-cache-identity.ts'
import { canonicalDeveloperInstructions } from './instruction-snapshot.ts'
import { hasPortableUserContent, imageAttachments, type ImageArtifactResolver } from './image-artifacts.ts'
import { latestNativeContextCheckpoint } from './native-context-checkpoint.ts'
import {
  taskNotificationContextText,
  taskNotificationFromPayload,
} from '../../src/lib/native-task-notification.ts'
import {
  claudeControlMessageContextText,
  claudeControlMessageFromPayload,
} from '../../src/lib/native-claude-control-message.ts'
import {
  codexEnvelopeContextText,
  codexEnvelopeFromPayload,
} from '../../src/lib/native-codex-envelope.ts'

const HARDENING_OVERRIDES = Object.freeze({
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

const CODEX_SANDBOX_BY_PERMISSION = Object.freeze({
  read_only: { mode: 'read-only', type: 'readOnly' },
  workspace: { mode: 'workspace-write', type: 'workspaceWrite' },
  full_access: { mode: 'danger-full-access', type: 'dangerFullAccess' },
} satisfies Record<PermissionProfile, {
  mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  type: 'readOnly' | 'workspaceWrite' | 'dangerFullAccess'
}>)

const VERIFIED_FEATURES = [
  'enable_fanout',
  'shell_tool',
  'standalone_web_search',
  'apps',
  'plugins',
] as const

// Status notifications describe every thread known to the process, including
// detached/internal threads, and are not execution events for the active turn.
// thread/started stays enabled because its parentThreadId is the authoritative
// ownership link for provider-native children that start before the collab item.
const IGNORED_GLOBAL_NOTIFICATIONS = new Set([
  'thread/status/changed',
])

const CANONICAL_TOOL_BOUNDARY_INSTRUCTIONS = `Baton is the canonical execution owner.
Use the dynamic tools exposed by Baton and Codex-native collaboration/subagent tools. Native child
agents are provider-managed, inherit this turn's safety and workspace boundaries, and are recorded
as private provider audit events rather than Baton-owned child executions. Do not invoke Codex-native
shell, web search, MCP, app, plugin, approval, or other task-execution tools. If requested work requires
an unavailable capability, continue safely with available tools or report the exact limitation.
When a selected skill provides a filesystem location, read its files with read_skill_resource using
the skill name and a skill-relative path (normally SKILL.md). Never pass an absolute skill path to
read_file.`

const ALLOWED_ITEM_TYPES = new Set([
  'userMessage',
  'agentMessage',
  'reasoning',
  'plan',
  'dynamicToolCall',
  'contextCompaction',
  'collabAgentToolCall',
  'subAgentActivity',
])

const CODEX_NATIVE_AGENT_TOOLS = Object.freeze([
  'spawn_agent',
  'send_input',
  'resume_agent',
  'wait',
  'close_agent',
])

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
  /** Test/embedding override. Production defaults to a fresh Baton-owned temporary home. */
  isolatedCodexHome?: string
  /** Durable installation-local secret; never sent to Codex or the upstream provider. */
  cacheIdentitySecret?: Uint8Array
  imageArtifacts?: ImageArtifactResolver
}

interface MaterializedCodexTurn {
  turnId: string
  canonicalThreadId: string
  model: string
  effort: string | null
  cwd: string | null
  permissionProfile: PermissionProfile
  developerInstructions: string | null
  history: JsonObject[]
  input: Array<{ type: 'text'; text: string } | { type: 'localImage'; path: string }>
}

interface RpcMessage {
  id?: string | number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

class CodexRpcError extends Error {
  readonly code: number | undefined
  readonly data: unknown

  constructor(error: NonNullable<RpcMessage['error']>) {
    super(`Codex app-server request failed: ${error.message ?? 'unknown JSON-RPC error'}`)
    this.name = 'CodexRpcError'
    this.code = error.code
    this.data = error.data
  }
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

  async respond(id: string | number, result: unknown): Promise<void> {
    await this.process.write(`${JSON.stringify({ id, result })}\n`)
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
      const result = await this.process.exited
      const error = new Error(`Codex app-server exited (${exitLabel(result)})`)
      this.failPending(error)
      this.messages.fail(error)
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
        pending.reject(new CodexRpcError(message.error))
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
  private readonly isolatedCodexHome: string
  private readonly ownsIsolatedCodexHome: boolean
  private readonly installsHardenedModelCatalog: boolean
  private readonly cacheIdentitySecret: Buffer | null
  private readonly imageArtifacts: ImageArtifactResolver | null
  private proxyConnection: CodexProxyConnection | null = null
  private modelCatalogPath: string | null = null
  private modelCatalogModelCount = 0
  private initializePromise: Promise<AdapterHandshake> | null = null
  private mcpDisableOverrides: Record<string, false> = {}
  private readonly active = new Set<ProviderTurnExecution>()
  private shuttingDown = false

  constructor(options: CodexAdapterOptions = {}) {
    this.executable = options.executable ?? (process.platform === 'win32' ? 'codex.cmd' : 'codex')
    this.processFactory = options.processFactory ?? spawnCodexProcess
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000
    this.proxyConnectionProvider = options.proxyConnection
    this.cacheIdentitySecret = options.cacheIdentitySecret === undefined
      ? null
      : Buffer.from(options.cacheIdentitySecret)
    this.imageArtifacts = options.imageArtifacts ?? null
    if (this.cacheIdentitySecret !== null && this.cacheIdentitySecret.byteLength < 32) {
      throw new TypeError('Codex canonical cache identity secret must contain at least 32 bytes')
    }
    this.ownsIsolatedCodexHome = options.isolatedCodexHome === undefined && options.processFactory === undefined
    this.installsHardenedModelCatalog = options.processFactory === undefined
    this.isolatedCodexHome = options.isolatedCodexHome
      ?? (options.processFactory
        ? path.join(tmpdir(), 'baton-codex-test-home')
        : mkdtempSync(path.join(tmpdir(), 'baton-codex-')))
  }

  initialize(): Promise<AdapterHandshake> {
    this.initializePromise ??= this.preflight()
    return this.initializePromise
  }

  validate(request: CanonicalTurnRequest, snapshot: ThreadSnapshot): void {
    if (request.model.trim().length === 0) throw new Error('Codex model is required')
    if (snapshot.thread.status === 'archived') throw new Error('Cannot execute an archived thread')
    if (request.input.length === 0) throw new Error('Codex turn requires input')
    for (const item of request.input) {
      if (item.kind !== 'user_message' || !hasPortableUserContent(item.payload)) {
        throw new Error('Safe Codex mode accepts portable text and image user_message input only')
      }
    }
  }

  materialize(request: CanonicalTurnRequest, snapshot: ThreadSnapshot): NativeTurnRequest {
    this.validate(request, snapshot)
    const nativeCheckpoint = latestNativeContextCheckpoint(snapshot.items, 'codex')
    const replayItems = nativeCheckpoint === null
      ? snapshot.items
      : snapshot.items.filter((item) => item.sequence > nativeCheckpoint.item.sequence)
    const checkpointHistory = nativeCheckpoint?.checkpoint.provider === 'codex'
      ? nativeCheckpoint.checkpoint.history
      : []
    const history = [...checkpointHistory, ...replayItems.flatMap((item): JsonObject[] => {
      if (item.visibility !== 'portable') return []
      const text = portableHistoryText(item.kind, item.payload)
      const attachments = item.kind === 'user_message' ? imageAttachments(item.payload) : []
      if (text === null && attachments.length === 0) return []
      const role = item.kind === 'user_message' ? 'user' : 'assistant'
      if (attachments.length > 0 && !this.imageArtifacts) {
        throw new Error('Codex history contains images without an artifact resolver')
      }
      return [
        {
          type: 'message',
          role,
          content: [
            ...(text === null ? [] : [{
              type: role === 'user' ? 'input_text' : 'output_text',
              text,
            }]),
            ...attachments.map((attachment) => ({
              type: 'input_image',
              image_url: this.imageArtifacts!.dataUrl(attachment),
            })),
          ],
        },
      ]
    })]
    const body: MaterializedCodexTurn = {
      turnId: request.turnId,
      canonicalThreadId: snapshot.thread.id,
      model: request.model,
      effort: request.effort ?? null,
      cwd: snapshot.session.cwd,
      permissionProfile: snapshot.session.permissions.effectiveProfile,
      developerInstructions: canonicalToolBoundaryInstructions(
        canonicalDeveloperInstructions(snapshot.thread.instructionSnapshot),
      ),
      history,
      input: request.input.flatMap((item) => {
        const text = portableText(item.payload)
        const attachments = imageAttachments(item.payload)
        if (attachments.length > 0 && !this.imageArtifacts) {
          throw new Error('Codex input contains images without an artifact resolver')
        }
        return [
          ...(text === null ? [] : [{ type: 'text' as const, text }]),
          ...attachments.map((attachment) => ({
            type: 'localImage' as const,
            path: this.imageArtifacts!.pathFor(attachment),
          })),
        ]
      }),
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
    let cacheBridge: CanonicalResponsesBridge | null = null
    let process: CodexAppServerProcess
    try {
      cacheBridge = this.proxyConnection && this.cacheIdentitySecret
        ? await startCanonicalResponsesBridge({
            upstreamBaseUrl: this.proxyConnection.baseUrl,
            upstreamToken: this.proxyConnection.token,
            promptCacheKey: canonicalConversationCacheKey(
              this.cacheIdentitySecret,
              body.canonicalThreadId,
            ),
            allowedToolNames: context.toolDefinitions.map((definition) => definition.name),
          })
        : null
      const executionConnection = cacheBridge
        ? { baseUrl: cacheBridge.baseUrl, token: cacheBridge.token }
        : this.proxyConnection
      process = this.processFactory(
        this.executable,
        launchArgs(this.mcpDisableOverrides, executionConnection, this.modelCatalogPath),
        proxyEnvironment(executionConnection, this.isolatedCodexHome),
      )
    } catch (error) {
      await cacheBridge?.close().catch(() => undefined)
      throw error
    }
    const client = new CodexJsonlRpcClient(process)
    const eventQueue = new AsyncQueue<NativeProviderEvent>()
    let terminalResult: ProviderTerminalResult | null = null
    let terminalResolve!: (result: ProviderTerminalResult) => void
    const terminal = new Promise<ProviderTerminalResult>((resolve) => {
      terminalResolve = resolve
    })
    let disposed = false
    let disposePromise: Promise<void> | null = null
    let nativeThreadId: string | null = null
    let nativeTurnId: string | null = null
    const nativeChildThreadIds = new Set<string>()
    let cumulativeUsage: Record<string, unknown> | null = null
    let cancelPromise: Promise<void> | null = null
    let terminalOverride: ProviderTerminalResult | null = null
    let resolvedModel: string | null = null
    let resolvedProvider: string | null = null
    let modelRoundTrips = 0
    const seenUsageTotals = new Set<string>()
    const providerCalls = new Map<string, { signature: string; result: Promise<AgentToolResult> }>()
    const rpcRequestIds = new Set<string | number>()
    let abortListener: (() => void) | null = null
    let turnTimer: NodeJS.Timeout | null = null
    let acceptingSteers = false
    let steerSerial: Promise<void> = Promise.resolve()

    const closeSteers = (): Promise<void> => {
      acceptingSteers = false
      return steerSerial
    }

    const steer = (steerRequest: ProviderSteerRequest): Promise<ProviderSteerResult> => {
      if (!steerRequest.followUpId || !steerRequest.text) {
        return Promise.reject(new TypeError('Codex steer requires a follow-up ID and text'))
      }
      if (steerRequest.expectedTurnId !== body.turnId || !acceptingSteers
        || nativeThreadId === null || nativeTurnId === null || terminalResult !== null) {
        return Promise.resolve({ status: 'closed' })
      }
      const operation = steerSerial.then(async (): Promise<ProviderSteerResult> => {
        if (!acceptingSteers || nativeThreadId === null || nativeTurnId === null || terminalResult !== null) {
          return { status: 'closed' }
        }
        try {
          const response = await client.request('turn/steer', {
            threadId: nativeThreadId,
            clientUserMessageId: steerRequest.followUpId,
            input: [{ type: 'text', text: steerRequest.text }],
            expectedTurnId: nativeTurnId,
          })
          assertCodexSteerResponse(response, nativeTurnId)
          return { status: 'accepted' }
        } catch (error) {
          return codexSteerFailure(error)
        }
      })
      steerSerial = operation.then(() => undefined, () => undefined)
      return operation
    }

    const finish = (result: ProviderTerminalResult): void => {
      if (terminalResult !== null) return
      acceptingSteers = false
      const effectiveResult = terminalOverride ?? result
      terminalResult = effectiveResult
      if (turnTimer !== null) clearTimeout(turnTimer)
      if (abortListener !== null) context.signal.removeEventListener('abort', abortListener)
      terminalResolve(effectiveResult)
      eventQueue.end()
    }

    const fail = (error: unknown, code?: string): void => {
      const message = error instanceof Error ? error.message : String(error)
      if (terminalResult === null) {
        eventQueue.push({
          eventId: `codex:error:${body.turnId}:${digest(message)}`,
          type: 'adapter/error',
          payload: { ...(code ? { code } : {}), message },
          durability: 'durable',
        })
      }
      finish({ status: 'failed', error: { ...(code ? { code } : {}), message } })
      void process.kill().catch(() => undefined)
    }

    const failLimit = (code: string, message: string): void => {
      if (terminalResult !== null || terminalOverride !== null) return
      terminalOverride = { status: 'failed', error: { code, message } }
      fail(new Error(message), code)
    }

    const dispose = (): Promise<void> => {
      disposePromise ??= (async () => {
        disposed = true
        acceptingSteers = false
        await Promise.race([closeSteers(), delay(this.shutdownTimeoutMs)])
        const threadIds = [...nativeChildThreadIds, nativeThreadId].filter(
          (threadId): threadId is string => threadId !== null,
        )
        for (const threadId of threadIds) {
          await withTimeout(
            client.request('thread/archive', { threadId }),
            this.shutdownTimeoutMs,
            'Codex thread/archive request',
          ).catch(() => undefined)
        }
        const inputClosed = await Promise.race([
          process.closeInput().then(() => true, () => true),
          delay(this.shutdownTimeoutMs).then(() => false),
        ])
        const exited = inputClosed && await Promise.race([
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
        await cacheBridge?.close().catch(() => undefined)
      })()
      return disposePromise
    }

    const cancel = async (code = 'user_cancelled', message = 'Codex turn was cancelled'): Promise<void> => {
      acceptingSteers = false
      if (terminalResult !== null) return
      const priorCode = terminalOverride?.error?.code
      if (terminalOverride === null || (code === 'user_cancelled' && priorCode !== 'user_cancelled')) {
        terminalOverride = { status: 'cancelled', error: { code, message } }
      }
      cancelPromise ??= (async () => {
        await Promise.race([closeSteers(), delay(this.shutdownTimeoutMs)])
        if (terminalResult !== null) return
        if (nativeThreadId === null || nativeTurnId === null) {
          finish(terminalOverride as ProviderTerminalResult)
          await process.kill().catch(() => undefined)
          return
        }
        try {
          await withTimeout(client.request('turn/interrupt', {
            threadId: nativeThreadId,
            turnId: nativeTurnId,
          }), this.shutdownTimeoutMs, 'Codex turn/interrupt request')
        } catch (error) {
          const interruptMessage = error instanceof Error ? error.message : String(error)
          if (terminalOverride?.error?.code === code) {
            terminalOverride = {
              status: 'cancelled',
              error: { code, message: `${message}: ${interruptMessage}` },
            }
          }
          finish(terminalOverride as ProviderTerminalResult)
          await process.kill().catch(() => undefined)
          return
        }
        const result = await withTimeout(
          terminal,
          this.shutdownTimeoutMs,
          'Codex interrupted terminal event',
        )
        if (result.status !== 'cancelled') {
          throw new Error(`Codex interruption ended as ${result.status}`)
        }
      })().catch(async (error) => {
        const interruptMessage = error instanceof Error ? error.message : String(error)
        if (terminalOverride?.error?.code === code) {
          terminalOverride = {
            status: 'cancelled',
            error: { code, message: `${message}: ${interruptMessage}` },
          }
        }
        finish(terminalOverride as ProviderTerminalResult)
        await process.kill().catch(() => undefined)
      })
      return cancelPromise
    }

    const execution: ProviderTurnExecution = { events: eventQueue, terminal, steer, cancel, dispose }
    this.active.add(execution)
    void terminal.finally(() => {
      this.active.delete(execution)
      void dispose()
    })
    abortListener = () => {
      void cancel('user_cancelled', 'Codex turn was cancelled by the caller').catch(() => undefined)
    }
    context.signal.addEventListener('abort', abortListener, { once: true })
    if (context.limits.turnTimeoutMs !== null) {
      turnTimer = setTimeout(() => {
        void cancel('turn_time_limit', 'Codex turn exceeded the wall-clock limit').catch(() => undefined)
      }, context.limits.turnTimeoutMs)
    }
    if (context.signal.aborted) {
      abortListener()
      return execution
    }

    try {
      const initialize = asObject(
        await client.request('initialize', {
          clientInfo: { name: 'baton', title: 'Baton', version: '0.1.0' },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: [...IGNORED_GLOBAL_NOTIFICATIONS],
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
          allowProviderModelFallback: false,
          cwd: body.cwd,
          developerInstructions: body.developerInstructions,
          environments: [],
          runtimeWorkspaceRoots: [],
          ephemeral: false,
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          sandbox: CODEX_SANDBOX_BY_PERMISSION[body.permissionProfile].mode,
          dynamicTools: context.toolDefinitions.map(dynamicToolSpec),
          config: { ...HARDENING_OVERRIDES, ...this.mcpDisableOverrides },
        }),
        'thread/start result',
      )
      resolvedModel = requiredString(start.model, 'Codex resolved model')
      resolvedProvider = requiredString(start.modelProvider, 'Codex resolved model provider')
      const expectedProvider = 'baton'
      if (resolvedProvider !== expectedProvider) {
        throw capabilityViolation(
          `resolved model provider ${resolvedProvider} did not match ${expectedProvider}`,
        )
      }
      const thread = asObject(start.thread, 'thread/start thread')
      if (thread.ephemeral !== false || typeof thread.path !== 'string' || thread.path.length === 0) {
        throw new Error('Codex provider-native delegation requires a persisted thread with a rollout path')
      }
      if (!Array.isArray(start.runtimeWorkspaceRoots) || start.runtimeWorkspaceRoots.length !== 0) {
        throw new Error('Codex canonical mode requires zero execution environment roots')
      }
      const effectiveSandbox = asObject(start.sandbox, 'Codex effective sandbox')
      const expectedSandboxType = CODEX_SANDBOX_BY_PERMISSION[body.permissionProfile].type
      if (effectiveSandbox.type !== expectedSandboxType) {
        throw capabilityViolation(
          `effective Codex sandbox ${String(effectiveSandbox.type)} did not match ${expectedSandboxType}`,
        )
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
      if (terminalResult === null && terminalOverride === null && !disposed) acceptingSteers = true

      void (async () => {
        try {
          for await (const message of client.incoming()) {
            if (message.method === undefined) continue
            if (message.id !== undefined) {
              if (message.method === 'item/tool/call') {
                if (rpcRequestIds.has(message.id)) {
                  throw capabilityViolation(`duplicate JSON-RPC tool request id ${String(message.id)}`)
                }
                rpcRequestIds.add(message.id)
                const toolCall = parseDynamicToolCall(message.params)
                const childToolCall = nativeChildThreadIds.has(toolCall.threadId)
                if ((!childToolCall && toolCall.threadId !== nativeThreadId)
                  || (!childToolCall && toolCall.turnId !== nativeTurnId)) {
                  throw capabilityViolation('dynamic tool call referenced a foreign thread or turn')
                }
                if (!context.toolDefinitions.some((definition) => definition.name === toolCall.tool)) {
                  throw capabilityViolation(`dynamic tool call requested unregistered tool ${toolCall.tool}`)
                }
                const signature = canonicalJson([toolCall.tool, toolCall.arguments])
                const providerCallKey = canonicalJson([
                  toolCall.threadId,
                  toolCall.turnId,
                  toolCall.callId,
                ])
                const existing = providerCalls.get(providerCallKey)
                if (existing && existing.signature !== signature) {
                  throw capabilityViolation(`dynamic tool call id ${toolCall.callId} was reused with different input`)
                }
                if (!existing && context.limits.maxModelRoundTrips !== null
                  && modelRoundTrips + 1 >= context.limits.maxModelRoundTrips) {
                  failLimit(
                    'model_round_limit',
                    'Codex requested a tool after the host model round-trip limit',
                  )
                  return
                }
                let resultPromise = existing?.result
                if (!resultPromise) {
                  resultPromise = context.executeTool({
                    callId: childToolCall
                      ? `${body.turnId}:${toolCall.threadId}:${toolCall.turnId}:${toolCall.callId}`
                      : `${body.turnId}:${toolCall.callId}`,
                    providerCallId: toolCall.callId,
                    name: toolCall.tool,
                    input: toolCall.arguments,
                  })
                  providerCalls.set(providerCallKey, { signature, result: resultPromise })
                }
                const result = await resultPromise
                if (terminalResult !== null) return
                await client.respond(message.id, {
                  contentItems: codexToolResultContent(result, this.imageArtifacts),
                  success: result.success,
                })
                continue
              }
              if (isApprovalRequest(message.method)) {
                await context.denyApproval(message).catch(() => undefined)
              } else {
                await context.denyToolCall(message).catch(() => undefined)
              }
              throw capabilityViolation(`unexpected server request ${message.method}`)
            }
            if (IGNORED_GLOBAL_NOTIFICATIONS.has(message.method)) continue
            const params = asOptionalObject(message.params)
            if (message.method === 'thread/started') {
              trackNativeStartedThread(params, nativeThreadId, nativeChildThreadIds)
              continue
            }
            const eventScope = activeNativeEventScope(
              params,
              nativeThreadId,
              nativeTurnId,
              nativeChildThreadIds,
            )
            if (eventScope === 'foreign') continue
            trackNativeChildThreads(params, nativeThreadId, nativeChildThreadIds)
            trackNativeSubAgentActivity(message.method, params, nativeThreadId, nativeChildThreadIds)
            const forbiddenItemType = forbiddenNotificationItemType(message.method, params)
            if (forbiddenItemType !== null) {
              throw capabilityViolation(
                `unexpected native execution event ${message.method}:${forbiddenItemType}`,
              )
            }
            if (eventScope === 'root' && message.method === 'thread/tokenUsage/updated') {
              const snapshot = codexUsageSnapshot(params)
              cumulativeUsage = snapshot === null
                ? null
                : { ...snapshot.usage, usageSource: snapshot.source }
              const roundIdentity = canonicalJson(cumulativeUsage ?? {})
              if (!seenUsageTotals.has(roundIdentity)) {
                seenUsageTotals.add(roundIdentity)
                modelRoundTrips += 1
                if (context.limits.maxModelRoundTrips !== null
                  && modelRoundTrips > context.limits.maxModelRoundTrips) {
                  failLimit('model_round_limit', 'Codex exceeded the observable model round-trip limit')
                  return
                }
              }
            }
            if (eventScope === 'root' && message.method === 'model/rerouted') {
              const fromModel = requiredString(params?.fromModel, 'Codex reroute source model')
              const toModel = requiredString(params?.toModel, 'Codex reroute target model')
              if (fromModel !== resolvedModel) {
                throw capabilityViolation('Codex model reroute did not originate from the active model')
              }
              resolvedModel = toModel
            }
            const eventParams = message.method === 'thread/tokenUsage/updated' && cumulativeUsage !== null
              ? { ...params, usage: cumulativeUsage }
              : params
            const event = nativeEvent(
              message.method,
              addModelProvenance(eventParams, {
                requestedModel: body.model,
                requestedEffort: body.effort,
                resolvedModel: requiredString(resolvedModel, 'active Codex model'),
                resolvedProvider: requiredString(resolvedProvider, 'active Codex model provider'),
              }),
            )
            const item = asOptionalObject(params?.item)
            if (eventScope === 'root' || item?.type === 'collabAgentToolCall') {
              eventQueue.push(event)
            }
            if (eventScope === 'root' && message.method === 'turn/completed') {
              const turn = asObject(params?.turn, 'turn/completed turn')
              if (turn.id !== nativeTurnId) {
                throw capabilityViolation('turn completion referenced a foreign native turn')
              }
              const status = terminalStatus(turn.status)
              finish({
                status,
                usage: cumulativeUsage,
                error: normalizeTurnError(turn.error),
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
        return [{
          kind: 'assistant_message',
          payload: {
            text: item.text,
            requestedModel: typeof payload?.requestedModel === 'string'
              ? payload.requestedModel
              : null,
            resolvedModel: typeof payload?.resolvedModel === 'string'
              ? payload.resolvedModel
              : null,
            resolvedProvider: typeof payload?.resolvedProvider === 'string'
              ? payload.resolvedProvider
              : null,
            effort: typeof payload?.requestedEffort === 'string'
              ? payload.requestedEffort
              : null,
          },
          provider: 'codex',
          nativeId,
        }]
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
      if (type === 'contextCompaction') {
        return [{
          kind: 'provider_event',
          visibility: 'baton_private',
          payload: { event: 'context_compaction', status: 'completed' },
          provider: 'codex',
          nativeId,
        }]
      }
      if (type === 'collabAgentToolCall') {
        return [{
          kind: 'provider_event',
          visibility: 'baton_private',
          payload: {
            event: 'provider_native_collaboration',
            tool: typeof item.tool === 'string' ? item.tool : null,
            status: typeof item.status === 'string' ? item.status : 'completed',
            senderThreadId: typeof item.senderThreadId === 'string' ? item.senderThreadId : null,
            receiverThreadIds: Array.isArray(item.receiverThreadIds)
              ? item.receiverThreadIds.filter((value): value is string => typeof value === 'string')
              : [],
          },
          provider: 'codex',
          nativeId,
        }]
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
      const snapshot = codexUsageSnapshot(payload)
      const cumulative = asOptionalObject(payload?.usage)
        ?? (snapshot === null ? null : { ...snapshot.usage, usageSource: snapshot.source })
      return [{
        kind: 'usage',
        visibility: 'baton_private',
        payload: cumulative === null
          ? (payload ?? {})
          : {
              ...cumulative,
              providerUsageSnapshot: asOptionalObject(payload?.tokenUsage),
            },
        provider: 'codex',
      }]
    }
    if (event.type === 'adapter/error') {
      return [{ kind: 'error', payload: payload ?? {}, provider: 'codex' }]
    }
    return []
  }

  // Every Codex turn owns a transient provider thread which is persisted only
  // long enough for native child threads to resolve, then archived on dispose.
  // Persisting its native id would create a false resumable Baton binding.
  extractBinding(_event: NativeProviderEvent) { return null }

  skillResources(): readonly ProviderSkillResource[] {
    return discoverCodexSkillResources(this.isolatedCodexHome)
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    await Promise.allSettled([...this.active].map((execution) => execution.dispose()))
    if (this.ownsIsolatedCodexHome) rmSync(this.isolatedCodexHome, { recursive: true, force: true })
  }

  private async preflight(): Promise<AdapterHandshake> {
    if (this.ownsIsolatedCodexHome) seedUserCodexSkills(this.isolatedCodexHome)
    if (this.installsHardenedModelCatalog && this.modelCatalogPath === null) {
      mkdirSync(this.isolatedCodexHome, { recursive: true })
      const hardenedCatalog = installHardenedModelCatalog(
        this.executable,
        this.isolatedCodexHome,
        this.shutdownTimeoutMs,
      )
      this.modelCatalogPath = hardenedCatalog.path
      this.modelCatalogModelCount = hardenedCatalog.modelCount
    }
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
        contentTypes: ['text', 'image'],
        toolCalling: true,
        parallelTools: true,
        contextWindow: null,
        continuation: 'stateless',
        reasoningState: 'portable-summary',
        taskMetadata: true,
        nativeChildExecution: 'exposed',
      },
      exposedNativeAgentTools: [...CODEX_NATIVE_AGENT_TOOLS],
      enforcementEvidence: {
        ...evidence,
        mcpServersDisabled: Object.keys(this.mcpDisableOverrides).length,
        toolTransport: 'client-owned-dynamic-functions',
        providerLocalMetadataTools: ['update_plan'],
        modelSelectedMultiAgent: this.modelCatalogPath === null
          ? 'test-process-factory'
          : `provider-native-for-${this.modelCatalogModelCount}-models`,
        canonicalCacheIdentity: this.cacheIdentitySecret
          ? 'hmac-sha256-loopback-responses-bridge-v1'
          : 'disabled-no-installation-secret',
      },
    }
  }

  private async inspectConfig(
    overrides: Record<string, false>,
  ): Promise<{ initialized: JsonObject; configRead: JsonObject }> {
    const process = this.processFactory(
      this.executable,
      launchArgs(overrides, this.proxyConnection, this.modelCatalogPath),
      proxyEnvironment(this.proxyConnection, this.isolatedCodexHome),
    )
    const client = new CodexJsonlRpcClient(process)
    try {
      const initialized = asObject(
        await withTimeout(client.request('initialize', {
          clientInfo: { name: 'baton', title: 'Baton', version: '0.1.0' },
          capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: false },
        }), this.shutdownTimeoutMs, 'Codex initialize request'),
        'initialize response',
      )
      await client.notify('initialized')
      const configRead = asObject(
        await withTimeout(client.request('config/read', {}), this.shutdownTimeoutMs, 'Codex config/read request'),
        'config/read result',
      )
      return { initialized, configRead }
    } finally {
      const inputClosed = await Promise.race([
        process.closeInput().then(() => true, () => true),
        delay(this.shutdownTimeoutMs).then(() => false),
      ])
      if (!inputClosed) {
        await process.kill().catch(() => undefined)
      } else {
        const exited = await Promise.race([
          process.exited.then(() => true, () => true),
          delay(this.shutdownTimeoutMs).then(() => false),
        ])
        if (!exited) await process.kill().catch(() => undefined)
      }
    }
  }
}

function seedUserCodexSkills(isolatedCodexHome: string): void {
  const target = path.join(isolatedCodexHome, 'skills')
  mkdirSync(target, { recursive: true })
  for (const source of [path.join(homedir(), '.codex', 'skills'), path.join(homedir(), '.agents', 'skills')]) {
    if (!existsSync(source)) continue
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.system' || existsSync(path.join(target, entry.name))) continue
      cpSync(path.join(source, entry.name), path.join(target, entry.name), {
        recursive: true,
        dereference: false,
        errorOnExist: false,
        force: false,
      })
    }
  }
}

function discoverCodexSkillResources(isolatedCodexHome: string): readonly ProviderSkillResource[] {
  const roots = [path.join(isolatedCodexHome, 'skills'), path.join(isolatedCodexHome, 'skills', '.system')]
  const resources = new Map<string, string>()
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.system') continue
      const skillRoot = path.join(root, entry.name)
      if (existsSync(path.join(skillRoot, 'SKILL.md')) && !resources.has(entry.name)) {
        resources.set(entry.name, skillRoot)
      }
    }
  }
  return Object.freeze([...resources].map(([id, root]) => Object.freeze({ id, root })))
}

export function hardenCodexModelCatalog(raw: string): { json: string; modelCount: number } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Codex model catalog was not valid JSON')
  }
  const catalog = asObject(parsed, 'Codex model catalog')
  if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
    throw new Error('Codex model catalog did not contain any models')
  }
  const models = catalog.models.map((value, index) => {
    const model = asObject(value, `Codex model catalog entry ${String(index)}`)
    if (typeof model.slug !== 'string' || model.slug.trim().length === 0) {
      throw new Error(`Codex model catalog entry ${String(index)} omitted its slug`)
    }
    return { ...model }
  })
  return { json: JSON.stringify({ ...catalog, models }), modelCount: models.length }
}

function installHardenedModelCatalog(
  executable: string,
  isolatedCodexHome: string,
  timeoutMs: number,
): { path: string; modelCount: number } {
  let raw: string | null = null
  // The installed CLI's bundled catalog is deterministic and does not depend on
  // the user's provider, credentials, gateway, or network availability.
  for (const args of [['debug', 'models', '--bundled'], ['debug', 'models']] as const) {
    try {
      const invocation = resolveCodexInvocation(executable, args)
      raw = execFileSync(invocation.executable, invocation.args, {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
      })
      break
    } catch {
      // The online view is only a bounded compatibility fallback if this CLI
      // version does not expose its bundled catalog.
    }
  }
  if (raw === null) throw new Error('Codex model catalog could not be read for canonical hardening')
  const hardened = hardenCodexModelCatalog(raw)
  const target = path.join(isolatedCodexHome, 'baton-model-catalog.json')
  writeFileSync(target, hardened.json, { encoding: 'utf8', mode: 0o600 })
  return { path: target, modelCount: hardened.modelCount }
}

function launchArgs(
  additional: Record<string, false> = {},
  connection: CodexProxyConnection | null = null,
  modelCatalogPath: string | null = null,
): string[] {
  const providerOverrides = connection ? {
    model_provider: 'baton',
    'model_providers.baton.name': 'Baton Native',
    'model_providers.baton.base_url': `${connection.baseUrl}/v1`,
    'model_providers.baton.env_key': 'BATON_PROXY_TOKEN',
    'model_providers.baton.wire_api': 'responses',
    // Baton owns the retry budget. Hidden app-server retries are disabled so
    // one provider request cannot multiply the host-authoritative turn limit.
    'model_providers.baton.request_max_retries': 0,
    'model_providers.baton.stream_max_retries': 0,
  } : {}
  const overrides = Object.entries({
    ...HARDENING_OVERRIDES,
    ...(modelCatalogPath ? { model_catalog_json: modelCatalogPath } : {}),
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
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (value && typeof value === 'object' && Object.keys(value as JsonObject).length === 0) return '{}'
  throw new Error('Unsupported Codex hardening override')
}

function proxyEnvironment(
  connection: CodexProxyConnection | null,
  isolatedCodexHome: string,
): Readonly<Record<string, string>> {
  return {
    CODEX_HOME: isolatedCodexHome,
    ...(connection ? { BATON_PROXY_TOKEN: connection.token } : {}),
  }
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
    canonicalThreadId: requiredString(body.canonicalThreadId, 'canonical thread id'),
    model: requiredString(body.model, 'Codex model'),
    effort: typeof body.effort === 'string' ? body.effort : null,
    cwd: typeof body.cwd === 'string' ? body.cwd : null,
    permissionProfile: parsePermissionProfile(body.permissionProfile),
    developerInstructions: typeof body.developerInstructions === 'string' ? body.developerInstructions : null,
    history: body.history.map((item) => asObject(item, 'Codex history item')),
    input: body.input.map((item) => {
      const input = asObject(item, 'Codex input')
      if (input.type === 'text') return { type: 'text', text: requiredString(input.text, 'Codex input text') }
      if (input.type === 'localImage') {
        return { type: 'localImage', path: requiredString(input.path, 'Codex local image path') }
      }
      throw new Error('Invalid Codex input type')
    }),
  }
}

function parsePermissionProfile(value: unknown): PermissionProfile {
  if (value === 'read_only' || value === 'workspace' || value === 'full_access') return value
  throw new Error('Invalid Codex permission profile')
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

function dynamicToolSpec(definition: ProviderExecutionContext['toolDefinitions'][number]): JsonObject {
  return {
    type: 'function',
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
  }
}

function codexToolResultContent(
  result: AgentToolResult,
  artifacts: ImageArtifactResolver | null,
): JsonObject[] {
  const content: JsonObject[] = [{ type: 'inputText', text: JSON.stringify(result) }]
  for (const image of result.success ? result.images ?? [] : []) {
    if (!artifacts) throw new Error('Codex tool returned an image without an artifact resolver')
    content.push({ type: 'inputImage', imageUrl: artifacts.dataUrl(image) })
  }
  return content
}

function parseDynamicToolCall(value: unknown): {
  threadId: string
  turnId: string
  callId: string
  tool: string
  arguments: JsonObject
} {
  const params = asObject(value, 'item/tool/call params')
  return {
    threadId: requiredString(params.threadId, 'dynamic tool thread id'),
    turnId: requiredString(params.turnId, 'dynamic tool turn id'),
    callId: requiredString(params.callId, 'dynamic tool call id'),
    tool: requiredString(params.tool, 'dynamic tool name'),
    arguments: asObject(params.arguments, 'dynamic tool arguments'),
  }
}

function addModelProvenance(
  params: JsonObject | null,
  provenance: {
    requestedModel: string
    requestedEffort: string | null
    resolvedModel: string
    resolvedProvider: string
  },
): JsonObject | null {
  if (!params) return null
  return { ...params, ...provenance }
}

function codexUsageSnapshot(params: JsonObject | null): {
  usage: JsonObject
  source: 'tokenUsage.total' | 'tokenUsage.last' | 'tokenUsage'
} | null {
  const tokenUsage = asOptionalObject(params?.tokenUsage)
  if (!tokenUsage) return null
  const total = asOptionalObject(tokenUsage.total)
  if (total) return { usage: total, source: 'tokenUsage.total' }
  const last = asOptionalObject(tokenUsage.last)
  if (last) return { usage: last, source: 'tokenUsage.last' }
  return { usage: tokenUsage, source: 'tokenUsage' }
}

function activeNativeEventScope(
  params: JsonObject | null,
  threadId: string,
  turnId: string,
  childThreadIds: ReadonlySet<string>,
): 'root' | 'child' | 'foreign' {
  const eventThreadId = typeof params?.threadId === 'string' ? params.threadId : null
  if (eventThreadId !== null && eventThreadId !== threadId) {
    return childThreadIds.has(eventThreadId) ? 'child' : 'foreign'
  }
  if (typeof params?.turnId === 'string' && params.turnId !== turnId) {
    throw capabilityViolation('Codex event referenced a foreign native turn')
  }
  return 'root'
}

function trackNativeChildThreads(
  params: JsonObject | null,
  rootThreadId: string,
  threadIds: Set<string>,
): void {
  const item = asOptionalObject(params?.item)
  if (item?.type !== 'collabAgentToolCall' || !Array.isArray(item.receiverThreadIds)) return
  if (typeof item.senderThreadId !== 'string'
    || (item.senderThreadId !== rootThreadId && !threadIds.has(item.senderThreadId))) {
    throw capabilityViolation('Codex collaboration event referenced a foreign native sender thread')
  }
  const receivers = item.receiverThreadIds.filter(
    (threadId): threadId is string => typeof threadId === 'string' && threadId.length > 0,
  )
  if (item.tool === 'spawnAgent') {
    for (const threadId of receivers) threadIds.add(threadId)
    return
  }
  if (receivers.some((threadId) => threadId !== rootThreadId && !threadIds.has(threadId))) {
    throw capabilityViolation('Codex collaboration event referenced an unowned native receiver thread')
  }
}

function trackNativeSubAgentActivity(
  method: string,
  params: JsonObject | null,
  rootThreadId: string,
  threadIds: Set<string>,
): void {
  if (method !== 'item/completed') return
  const item = asOptionalObject(params?.item)
  if (item?.type !== 'subAgentActivity' || item.kind !== 'started') return
  if (typeof item.agentThreadId === 'string' && item.agentThreadId.trim().length > 0
    && item.agentThreadId !== rootThreadId
    && typeof item.agentPath === 'string' && item.agentPath.trim().length > 0) {
    threadIds.add(item.agentThreadId)
  }
}

function trackNativeStartedThread(
  params: JsonObject | null,
  rootThreadId: string,
  threadIds: Set<string>,
): void {
  const thread = asOptionalObject(params?.thread)
  if (thread === null || typeof thread.id !== 'string') return
  if (thread.id === rootThreadId) return
  const parentThreadId = typeof thread.parentThreadId === 'string' ? thread.parentThreadId : null
  if (parentThreadId === rootThreadId || (parentThreadId !== null && threadIds.has(parentThreadId))) {
    threadIds.add(thread.id)
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function durableEventId(method: string, params: JsonObject | null): string {
  const item = asOptionalObject(params?.item)
  const identity = typeof item?.id === 'string'
    ? item.id
    : `${params?.threadId ?? ''}:${params?.turnId ?? ''}:${digest(JSON.stringify(params ?? {}))}`
  return `codex:${method}:${identity}`
}

function canonicalToolBoundaryInstructions(userInstructions: string | null): string {
  return userInstructions === null
    ? CANONICAL_TOOL_BOUNDARY_INSTRUCTIONS
    : `${CANONICAL_TOOL_BOUNDARY_INSTRUCTIONS}\n\n${userInstructions}`
}

function forbiddenNotificationItemType(method: string, params: JsonObject | null): string | null {
  if (method.startsWith('item/autoApprovalReview/')) return 'autoApprovalReview'
  if (method === 'rawResponseItem/completed') return null
  if (method !== 'item/started' && method !== 'item/completed') return null
  const item = asOptionalObject(params?.item)
  if (typeof item?.type !== 'string') return 'missing'
  if (ALLOWED_ITEM_TYPES.has(item.type)) return null
  const kind = typeof item.kind === 'string' ? item.kind : null
  return kind === null ? item.type : `${item.type}:${kind}`
}

function isApprovalRequest(method: string): boolean {
  return method.includes('requestApproval')
    || method === 'item/tool/requestUserInput'
    || method === 'mcpServer/elicitation/request'
}

function normalizeTurnError(value: unknown): JsonObject | null {
  const error = asOptionalObject(value)
  if (error?.codexErrorInfo === 'usageLimitExceeded') {
    return { ...error, code: 'provider_usage_limit' }
  }
  const message = typeof error?.message === 'string' ? error.message : ''
  if (/unexpected status (?:408|409|5\d\d)\b/i.test(message)
    || /(?:connection (?:termination|reset)|stream disconnected before completion)/i.test(message)) {
    return { ...error, code: 'provider_retry_exhausted' }
  }
  return error
}

function terminalStatus(value: unknown): ProviderTerminalResult['status'] {
  if (value === 'completed') return 'completed'
  if (value === 'interrupted') return 'interrupted'
  if (value === 'failed') return 'failed'
  throw new Error(`Unexpected Codex terminal status ${String(value)}`)
}

function codexSteerFailure(error: unknown): ProviderSteerResult {
  if (!(error instanceof CodexRpcError)) throw error
  const detail = `${error.message} ${safeErrorData(error.data)}`.toLowerCase()
  if (error.code === -32601 || detail.includes('method not found')) return { status: 'unsupported' }
  if (detail.includes('active turn not steerable')
    || detail.includes('activeturnnotsteerable')
    || detail.includes('no active turn')
    || detail.includes('expected turn')
    || detail.includes('expectedturnid')
    || detail.includes('turn mismatch')) {
    return { status: 'closed' }
  }
  throw error
}

function assertCodexSteerResponse(value: unknown, expectedNativeTurnId: string): void {
  const response = asOptionalObject(value)
  if (response?.turnId !== expectedNativeTurnId) {
    throw new Error(
      'Codex turn/steer did not confirm the active native turn; delivery outcome is unknown and must not be consumed or retried automatically',
    )
  }
}

function safeErrorData(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
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
  const taskNotification = taskNotificationFromPayload(payload)
  if (taskNotification) return taskNotificationContextText(taskNotification)
  const controlMessage = claudeControlMessageFromPayload(payload)
  if (controlMessage) return claudeControlMessageContextText(controlMessage)
  const codexEnvelope = codexEnvelopeFromPayload(payload)
  if (codexEnvelope) return codexEnvelopeContextText(codexEnvelope)
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
export function resolveCodexInvocation(executable: string, args: readonly string[]): CodexInvocation {
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
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
