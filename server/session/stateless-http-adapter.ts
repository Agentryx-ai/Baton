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
import type {
  AgentToolDefinition,
  AgentToolResult,
  CanonicalProvider,
  NewCanonicalItem,
  ThreadSnapshot,
} from './domain.ts'

type SupportedProvider = Extract<CanonicalProvider, 'claude' | 'gemini'>
type JsonObject = Record<string, unknown>

class ProviderLoopError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ProviderLoopError'
    this.code = code
  }
}

export interface StatelessProxyConnection {
  baseUrl: string
  token: string
}

export interface StatelessHttpAdapterOptions {
  provider: SupportedProvider
  proxyConnection: () => Promise<StatelessProxyConnection>
  fetchImpl?: typeof fetch
}

interface PortableMessage {
  role: 'user' | 'assistant'
  content: string
}

type ProviderMessage = Record<string, unknown>

interface MaterializedHttpTurn {
  turnId: string
  provider: SupportedProvider
  model: string
  effort: string | null
  messages: PortableMessage[]
}

interface NormalizedResponse {
  responseId: string
  requestedModel: string
  actualModel: string
  effort: string | null
  text: string
  usage: JsonObject
}

class EventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private ended = false

  push(value: T): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.values.push(value)
  }

  end(): void {
    if (this.ended) return
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

export class StatelessHttpCanonicalAdapter implements SessionProviderAdapter {
  readonly provider: SupportedProvider
  private readonly proxyConnectionProvider: () => Promise<StatelessProxyConnection>
  private readonly fetchImpl: typeof fetch
  private connection: StatelessProxyConnection | null = null
  private initializePromise: Promise<AdapterHandshake> | null = null
  private shuttingDown = false
  private readonly active = new Set<AbortController>()

  constructor(options: StatelessHttpAdapterOptions) {
    this.provider = options.provider
    this.proxyConnectionProvider = options.proxyConnection
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  initialize(): Promise<AdapterHandshake> {
    this.initializePromise ??= this.proxyConnectionProvider().then((connection) => {
      this.connection = connection
      return {
        adapterVersion: `baton-${this.provider}-http-v1`,
        capabilities: {
          roles: ['user', 'assistant'],
          contentTypes: ['text'],
          toolCalling: true,
          parallelTools: true,
          contextWindow: null,
          continuation: 'stateless',
          reasoningState: 'portable-summary',
          taskMetadata: false,
          nativeChildExecution: 'disabled',
        },
        exposedNativeAgentTools: [],
        enforcementEvidence: {
          transport: this.provider === 'claude' ? 'anthropic-messages' : 'openai-compatible',
          toolsSent: 'baton-dynamic-only',
          nativeSession: false,
        },
      }
    })
    return this.initializePromise
  }

  validate(request: CanonicalTurnRequest, snapshot: ThreadSnapshot): void {
    if (!request.model.startsWith(this.provider === 'claude' ? 'claude-' : 'gemini-')) {
      throw new Error(`${this.provider} adapter rejected model ${request.model}`)
    }
    if (snapshot.thread.status === 'archived') throw new Error('Cannot execute an archived thread')
    if (request.effort !== null && request.effort !== undefined && request.effort.trim().length === 0) {
      throw new Error('Effort must be null or a non-empty string')
    }
    if (request.input.length === 0) throw new Error(`${this.provider} turn requires text input`)
    for (const item of request.input) {
      if (item.kind !== 'user_message' || portableText(item.payload) === null) {
        throw new Error(`${this.provider} safe mode accepts text user_message input only`)
      }
    }
  }

  materialize(request: CanonicalTurnRequest, snapshot: ThreadSnapshot): NativeTurnRequest {
    this.validate(request, snapshot)
    const messages: PortableMessage[] = []
    for (const item of snapshot.items) {
      if (item.visibility !== 'portable') continue
      const text = portableHistoryText(item.kind, item.payload)
      if (text === null) continue
      appendMessage(messages, item.kind === 'user_message' ? 'user' : 'assistant', text)
    }
    for (const item of request.input) {
      appendMessage(messages, 'user', portableText(item.payload) as string)
    }
    const body: MaterializedHttpTurn = {
      turnId: request.turnId,
      provider: this.provider,
      model: request.model,
      effort: request.effort ?? null,
      messages,
    }
    return { body }
  }

  async execute(
    request: NativeTurnRequest,
    context: ProviderExecutionContext,
  ): Promise<ProviderTurnExecution> {
    if (this.shuttingDown) throw new Error(`${this.provider} adapter is shutting down`)
    await this.initialize()
    if (!this.connection) throw new Error(`${this.provider} proxy connection is unavailable`)
    const body = parseMaterializedTurn(request.body, this.provider)
    const controller = new AbortController()
    this.active.add(controller)
    let cancellationRequested = context.signal.aborted
    let turnTimedOut = false
    const abort = () => {
      cancellationRequested = true
      controller.abort(context.signal.reason)
    }
    if (context.signal.aborted) abort()
    else context.signal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => {
      turnTimedOut = true
      controller.abort(new Error(
        `${this.provider} turn exceeded time limit (${context.limits.turnTimeoutMs}ms)`,
      ))
    }, context.limits.turnTimeoutMs)

    const events = new EventQueue<NativeProviderEvent>()
    let resolveTerminal!: (result: ProviderTerminalResult) => void
    const terminal = new Promise<ProviderTerminalResult>((resolve) => {
      resolveTerminal = resolve
    })

    void this.request(body, controller.signal, context).then((response) => {
      events.push({
        eventId: `${this.provider}:response:${response.responseId}`,
        type: 'response/completed',
        payload: response,
        durability: 'durable',
      })
      events.end()
      resolveTerminal({ status: 'completed', usage: response.usage })
    }).catch((error: unknown) => {
      events.end()
      const message = turnTimedOut
        ? `${this.provider} turn exceeded time limit (${context.limits.turnTimeoutMs}ms)`
        : error instanceof Error ? error.message : String(error)
      resolveTerminal(cancellationRequested
        ? { status: 'cancelled' }
        : {
            status: 'failed',
            error: {
              code: turnTimedOut ? 'turn_time_limit' : providerErrorCode(error),
              message,
            },
          })
    }).finally(() => {
      clearTimeout(timeout)
      context.signal.removeEventListener('abort', abort)
      this.active.delete(controller)
    })

    return {
      events,
      terminal,
      cancel: async () => {
        cancellationRequested = true
        controller.abort(new Error('Turn cancelled by user'))
      },
      dispose: async () => {
        context.signal.removeEventListener('abort', abort)
      },
    }
  }

  normalize(event: NativeProviderEvent): NewCanonicalItem[] {
    if (event.type !== 'response/completed') return []
    const response = parseNormalizedResponse(event.payload)
    return [
      {
        kind: 'assistant_message',
        visibility: 'portable',
        provider: this.provider,
        nativeId: response.responseId,
        payload: {
          text: response.text,
          requestedModel: response.requestedModel,
          actualModel: response.actualModel,
          modelFallback: response.requestedModel !== response.actualModel,
          effort: response.effort,
        },
      },
      {
        kind: 'usage',
        visibility: 'baton_private',
        provider: this.provider,
        payload: response.usage,
      },
    ]
  }

  extractBinding(event: NativeProviderEvent) {
    if (event.type !== 'response/completed') return null
    const response = parseNormalizedResponse(event.payload)
    return {
      nativeResponseId: response.responseId,
      modelFamily: response.actualModel,
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    for (const controller of this.active) controller.abort(new Error('Baton is shutting down'))
    this.active.clear()
  }

  private async request(
    body: MaterializedHttpTurn,
    signal: AbortSignal,
    context: ProviderExecutionContext,
  ): Promise<NormalizedResponse> {
    if (!this.connection) throw new Error(`${this.provider} proxy connection is unavailable`)
    return this.provider === 'claude'
      ? this.requestClaude(body, signal, context)
      : this.requestGemini(body, signal, context)
  }

  private async requestClaude(
    body: MaterializedHttpTurn,
    signal: AbortSignal,
    context: ProviderExecutionContext,
  ): Promise<NormalizedResponse> {
    const messages: ProviderMessage[] = body.messages.map((message) => ({ ...message }))
    const tools = context.toolDefinitions.map(toClaudeTool)
    const usage: JsonObject = {}
    let totalToolCalls = 0
    const identicalCalls = new Map<string, number>()

    for (let round = 1; round <= context.limits.maxModelRoundTrips; round += 1) {
      const response = await fetchWithRetry(this.fetchImpl, `${this.connection!.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.connection!.token,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: body.model,
          max_tokens: 16_384,
          messages,
          ...(tools.length > 0 ? { tools } : {}),
          ...(body.effort ? { output_config: { effort: body.effort } } : {}),
        }),
        signal,
      }, context.limits.maxProviderRetries, signal)
      const payload = await responseJson(response, this.provider)
      mergeNumericUsage(usage, objectValue(payload.usage))
      const content = Array.isArray(payload.content) ? payload.content : []
      const toolUses = content.flatMap((part) => {
        if (!isObject(part) || part.type !== 'tool_use') return []
        return [{
          providerCallId: requiredString(part.id, 'Claude tool use id'),
          name: requiredString(part.name, 'Claude tool name'),
          input: requiredObject(part.input, 'Claude tool input'),
        }]
      })
      const text = content.flatMap((part) => isObject(part) && part.type === 'text'
        && typeof part.text === 'string' ? [part.text] : []).join('')
      const rawStopReason = stringValue(payload.stop_reason)
      const stopReason = rawStopReason ?? (toolUses.length > 0 ? 'tool_use' : 'end_turn')

      if (stopReason === 'end_turn') {
        if (!text) throw new ProviderLoopError('provider_invalid_terminal', 'Claude end_turn response did not contain text')
        return {
          responseId: stringValue(payload.id) ?? `${body.turnId}:response`,
          requestedModel: body.model,
          actualModel: stringValue(payload.model) ?? body.model,
          effort: body.effort,
          text,
          usage,
        }
      }
      if (stopReason === 'pause_turn') {
        assertAnotherModelRound(round, context.limits.maxModelRoundTrips, 'Claude pause_turn')
        messages.push({ role: 'assistant', content })
        continue
      }
      if (stopReason !== 'tool_use') {
        throw new ProviderLoopError(
          stopReason === 'refusal' ? 'provider_refusal' : 'provider_incomplete',
          `Claude stopped without completing the turn: ${stopReason}`,
        )
      }
      if (toolUses.length === 0) throw new Error('Claude returned tool_use without a tool_use block')
      assertAnotherModelRound(round, context.limits.maxModelRoundTrips, 'Claude tool_use')
      enforceToolLimits(toolUses, totalToolCalls, identicalCalls, context)
      totalToolCalls += toolUses.length
      const results = await Promise.all(toolUses.map((toolUse) => context.executeTool({
        callId: `${body.turnId}:${toolUse.providerCallId}`,
        providerCallId: toolUse.providerCallId,
        name: toolUse.name,
        input: toolUse.input,
      })))
      messages.push({ role: 'assistant', content })
      messages.push({
        role: 'user',
        content: results.map((result, index) => claudeToolResult(toolUses[index]!.providerCallId, result)),
      })
    }
    throw new ProviderLoopError(
      'model_round_limit',
      `Claude exceeded model round-trip limit (${context.limits.maxModelRoundTrips})`,
    )
  }

  private async requestGemini(
    body: MaterializedHttpTurn,
    signal: AbortSignal,
    context: ProviderExecutionContext,
  ): Promise<NormalizedResponse> {
    const messages: ProviderMessage[] = body.messages.map((message) => ({ ...message }))
    const tools = context.toolDefinitions.map(toOpenAiTool)
    const usage: JsonObject = {}
    let totalToolCalls = 0
    const identicalCalls = new Map<string, number>()

    for (let round = 1; round <= context.limits.maxModelRoundTrips; round += 1) {
      const response = await fetchWithRetry(this.fetchImpl, `${this.connection!.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.connection!.token}`,
        },
        body: JSON.stringify({
          model: body.model,
          messages,
          max_tokens: 16_384,
          ...(tools.length > 0 ? { tools } : {}),
          ...(body.effort ? { reasoning_effort: body.effort } : {}),
        }),
        signal,
      }, context.limits.maxProviderRetries, signal)
      const payload = await responseJson(response, this.provider)
      mergeNumericUsage(usage, objectValue(payload.usage))
      const choices = Array.isArray(payload.choices) ? payload.choices : []
      const first = isObject(choices[0]) ? choices[0] : null
      if (!first) throw new Error('Gemini response did not contain a choice')
      const message = objectValue(first.message)
      if (!message) throw new Error('Gemini response did not contain a message')
      const toolCalls = parseOpenAiToolCalls(message.tool_calls)
      const text = stringValue(message.content)
      const rawFinishReason = stringValue(first.finish_reason)
      const finishReason = rawFinishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop')
      const normalizedFinishReason = finishReason.toLowerCase()

      if (normalizedFinishReason === 'stop') {
        if (!text) throw new Error('Gemini stop response did not contain text')
        usage.input_tokens = numberValue(usage.prompt_tokens)
        usage.output_tokens = numberValue(usage.completion_tokens)
        return {
          responseId: stringValue(payload.id) ?? `${body.turnId}:response`,
          requestedModel: body.model,
          actualModel: stringValue(payload.model) ?? body.model,
          effort: body.effort,
          text,
          usage,
        }
      }
      if (normalizedFinishReason !== 'tool_calls') {
        throw new ProviderLoopError(
          normalizedFinishReason.includes('safety') ? 'provider_refusal' : 'provider_incomplete',
          `Gemini stopped without completing the turn: ${finishReason}`,
        )
      }
      if (toolCalls.length === 0) throw new Error('Gemini returned tool_calls without a function call')
      assertAnotherModelRound(round, context.limits.maxModelRoundTrips, 'Gemini tool_calls')
      enforceToolLimits(toolCalls, totalToolCalls, identicalCalls, context)
      totalToolCalls += toolCalls.length
      const results = await Promise.all(toolCalls.map((toolCall) => context.executeTool({
        callId: `${body.turnId}:${toolCall.providerCallId}`,
        providerCallId: toolCall.providerCallId,
        name: toolCall.name,
        input: toolCall.input,
      })))
      messages.push({
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: message.tool_calls,
      })
      for (const [index, result] of results.entries()) {
        messages.push({
          role: 'tool',
          tool_call_id: toolCalls[index]!.providerCallId,
          name: toolCalls[index]!.name,
          content: serializeToolResult(result),
        })
      }
    }
    throw new ProviderLoopError(
      'model_round_limit',
      `Gemini exceeded model round-trip limit (${context.limits.maxModelRoundTrips})`,
    )
  }
}

async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  maxRetries: number,
  signal: AbortSignal,
): Promise<Response> {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchImpl(url, init)
      if (!retryableStatus(response.status)) return response
      if (attempt === maxRetries) {
        return response
      }
      await response.arrayBuffer().catch(() => undefined)
    } catch (error) {
      if (signal.aborted) throw error
      lastError = error
      if (attempt === maxRetries) {
        throw new ProviderLoopError(
          'provider_retry_exhausted',
          `Provider request failed after ${maxRetries} retries: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    await retryDelay(Math.min(1_000, 100 * (2 ** attempt)), signal)
  }
  throw new ProviderLoopError(
    'provider_retry_exhausted',
    `Provider retry budget was exhausted${lastError ? `: ${String(lastError)}` : ''}`,
  )
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500
}

async function retryDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function responseJson(response: Response, provider: SupportedProvider): Promise<JsonObject> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ProviderLoopError('provider_invalid_response', `${provider} proxy returned non-JSON HTTP ${response.status}`)
  }
  if (!response.ok) {
    const record = isObject(payload) ? payload : null
    const error = objectValue(record?.error)
    const detail = stringValue(error?.message) ?? stringValue(record?.message)
    throw new ProviderLoopError(
      retryableStatus(response.status) ? 'provider_retry_exhausted' : 'provider_http_error',
      `${provider} proxy returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    )
  }
  if (!isObject(payload)) {
    throw new ProviderLoopError('provider_invalid_response', `${provider} proxy returned an invalid JSON body`)
  }
  return payload
}

function toClaudeTool(tool: AgentToolDefinition): JsonObject {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }
}

function toOpenAiTool(tool: AgentToolDefinition): JsonObject {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }
}

function claudeToolResult(providerCallId: string, result: AgentToolResult): JsonObject {
  return result.success
    ? {
        type: 'tool_result',
        tool_use_id: providerCallId,
        content: JSON.stringify(result.content),
      }
    : {
        type: 'tool_result',
        tool_use_id: providerCallId,
        content: JSON.stringify(result.error),
        is_error: true,
      }
}

function serializeToolResult(result: AgentToolResult): string {
  return JSON.stringify(result.success ? result.content : { error: result.error })
}

function parseOpenAiToolCalls(value: unknown): Array<{
  providerCallId: string
  name: string
  input: JsonObject
}> {
  if (!Array.isArray(value)) return []
  return value.map((entry) => {
    if (!isObject(entry)) throw new Error('Gemini returned an invalid tool call')
    const fn = requiredObject(entry.function, 'Gemini tool function')
    const rawArguments = requiredString(fn.arguments, 'Gemini tool arguments')
    let parsedArguments: unknown
    try {
      parsedArguments = JSON.parse(rawArguments)
    } catch {
      throw new Error('Gemini returned malformed JSON tool arguments')
    }
    return {
      providerCallId: requiredString(entry.id, 'Gemini tool call id'),
      name: requiredString(fn.name, 'Gemini tool name'),
      input: requiredObject(parsedArguments, 'Gemini tool arguments'),
    }
  })
}

function enforceToolLimits(
  calls: ReadonlyArray<{ name: string; input: JsonObject }>,
  priorCallCount: number,
  identicalCalls: Map<string, number>,
  context: ProviderExecutionContext,
): void {
  if (priorCallCount + calls.length > context.limits.maxToolCalls) {
    throw new ProviderLoopError(
      'tool_call_limit',
      `Provider exceeded tool-call limit (${context.limits.maxToolCalls})`,
    )
  }
  for (const call of calls) {
    const fingerprint = `${call.name}:${stableJson(call.input)}`
    const count = (identicalCalls.get(fingerprint) ?? 0) + 1
    if (count > context.limits.maxIdenticalToolCalls) {
      throw new ProviderLoopError(
        'tool_repetition_limit',
        `Provider repeated an identical tool call more than ${context.limits.maxIdenticalToolCalls} times`,
      )
    }
    identicalCalls.set(fingerprint, count)
  }
}

function assertAnotherModelRound(round: number, limit: number, reason: string): void {
  if (round >= limit) {
    throw new ProviderLoopError(
      'model_round_limit',
      `${reason} requires another model round but reached model round-trip limit (${limit})`,
    )
  }
}

function mergeNumericUsage(target: JsonObject, source: JsonObject | null): void {
  if (!source) return
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      target[key] = numberValue(target[key]) + value
    } else if (!(key in target)) {
      target[key] = value
    }
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function parseMaterializedTurn(value: unknown, provider: SupportedProvider): MaterializedHttpTurn {
  if (!isObject(value) || value.provider !== provider || !Array.isArray(value.messages)) {
    throw new Error(`Invalid ${provider} native turn request`)
  }
  return {
    turnId: requiredString(value.turnId, 'canonical turn id'),
    provider,
    model: requiredString(value.model, `${provider} model`),
    effort: typeof value.effort === 'string' ? value.effort : null,
    messages: value.messages.map((message) => {
      if (!isObject(message) || (message.role !== 'user' && message.role !== 'assistant')) {
        throw new Error(`Invalid ${provider} history message`)
      }
      return { role: message.role, content: requiredString(message.content, 'message content') }
    }),
  }
}

function parseNormalizedResponse(value: unknown): NormalizedResponse {
  if (!isObject(value)) throw new Error('Invalid normalized provider response')
  return {
    responseId: requiredString(value.responseId, 'provider response id'),
    requestedModel: requiredString(value.requestedModel, 'requested model'),
    actualModel: requiredString(value.actualModel, 'actual model'),
    effort: typeof value.effort === 'string' ? value.effort : null,
    text: requiredString(value.text, 'provider response text'),
    usage: objectValue(value.usage) ?? {},
  }
}

function appendMessage(messages: PortableMessage[], role: PortableMessage['role'], content: string): void {
  const previous = messages.at(-1)
  if (previous?.role === role) previous.content += `\n\n${content}`
  else messages.push({ role, content })
}

function portableHistoryText(kind: string, payload: JsonObject): string | null {
  if (kind !== 'user_message' && kind !== 'assistant_message' && kind !== 'summary') return null
  return portableText(payload)
}

function portableText(payload: JsonObject): string | null {
  if (typeof payload.text === 'string' && payload.text.trim()) return payload.text
  if (typeof payload.content === 'string' && payload.content.trim()) return payload.content
  return null
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function objectValue(value: unknown): JsonObject | null {
  return isObject(value) ? value : null
}

function requiredObject(value: unknown, label: string): JsonObject {
  const result = objectValue(value)
  if (!result) throw new Error(`${label} is required`)
  return result
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function providerErrorCode(error: unknown): string {
  return error instanceof ProviderLoopError ? error.code : 'provider_failure'
}

function requiredString(value: unknown, label: string): string {
  const result = stringValue(value)
  if (!result) throw new Error(`${label} is required`)
  return result
}
