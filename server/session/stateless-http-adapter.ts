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
import type { CanonicalProvider, NewCanonicalItem, ThreadSnapshot } from './domain.ts'

type SupportedProvider = Extract<CanonicalProvider, 'claude' | 'gemini'>
type JsonObject = Record<string, unknown>

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
          toolCalling: false,
          parallelTools: false,
          contextWindow: null,
          continuation: 'stateless',
          reasoningState: 'portable-summary',
          taskMetadata: false,
          nativeChildExecution: 'disabled',
        },
        exposedNativeAgentTools: [],
        enforcementEvidence: {
          transport: this.provider === 'claude' ? 'anthropic-messages' : 'openai-compatible',
          toolsSent: false,
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
    const abort = () => controller.abort(context.signal.reason)
    if (context.signal.aborted) abort()
    else context.signal.addEventListener('abort', abort, { once: true })

    const events = new EventQueue<NativeProviderEvent>()
    let resolveTerminal!: (result: ProviderTerminalResult) => void
    const terminal = new Promise<ProviderTerminalResult>((resolve) => {
      resolveTerminal = resolve
    })

    void this.request(body, controller.signal).then((response) => {
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
      const message = error instanceof Error ? error.message : String(error)
      resolveTerminal(controller.signal.aborted
        ? { status: 'cancelled' }
        : { status: 'failed', error: { message } })
    }).finally(() => {
      context.signal.removeEventListener('abort', abort)
      this.active.delete(controller)
    })

    return {
      events,
      terminal,
      cancel: async () => controller.abort(new Error('Turn cancelled by user')),
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

  private async request(body: MaterializedHttpTurn, signal: AbortSignal): Promise<NormalizedResponse> {
    if (!this.connection) throw new Error(`${this.provider} proxy connection is unavailable`)
    return this.provider === 'claude'
      ? this.requestClaude(body, signal)
      : this.requestGemini(body, signal)
  }

  private async requestClaude(
    body: MaterializedHttpTurn,
    signal: AbortSignal,
  ): Promise<NormalizedResponse> {
    const response = await this.fetchImpl(`${this.connection!.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.connection!.token,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: body.model,
        max_tokens: 16_384,
        messages: body.messages,
        ...(body.effort ? { output_config: { effort: body.effort } } : {}),
      }),
      signal,
    })
    const payload = await responseJson(response, this.provider)
    const content = Array.isArray(payload.content) ? payload.content : []
    const text = content.flatMap((part) => isObject(part) && part.type === 'text'
      && typeof part.text === 'string' ? [part.text] : []).join('')
    if (!text) throw new Error('Claude response did not contain text')
    return {
      responseId: stringValue(payload.id) ?? `${body.turnId}:response`,
      requestedModel: body.model,
      actualModel: stringValue(payload.model) ?? body.model,
      effort: body.effort,
      text,
      usage: objectValue(payload.usage) ?? {},
    }
  }

  private async requestGemini(
    body: MaterializedHttpTurn,
    signal: AbortSignal,
  ): Promise<NormalizedResponse> {
    const response = await this.fetchImpl(`${this.connection!.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.connection!.token}`,
      },
      body: JSON.stringify({
        model: body.model,
        messages: body.messages,
        max_tokens: 16_384,
        ...(body.effort ? { reasoning_effort: body.effort } : {}),
      }),
      signal,
    })
    const payload = await responseJson(response, this.provider)
    const choices = Array.isArray(payload.choices) ? payload.choices : []
    const first = isObject(choices[0]) ? choices[0] : null
    const message = objectValue(first?.message)
    const text = stringValue(message?.content)
    if (!text) throw new Error('Gemini response did not contain text')
    const rawUsage = objectValue(payload.usage) ?? {}
    return {
      responseId: stringValue(payload.id) ?? `${body.turnId}:response`,
      requestedModel: body.model,
      actualModel: stringValue(payload.model) ?? body.model,
      effort: body.effort,
      text,
      usage: {
        ...rawUsage,
        input_tokens: numberValue(rawUsage.prompt_tokens),
        output_tokens: numberValue(rawUsage.completion_tokens),
      },
    }
  }
}

async function responseJson(response: Response, provider: SupportedProvider): Promise<JsonObject> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error(`${provider} proxy returned non-JSON HTTP ${response.status}`)
  }
  if (!response.ok) {
    const record = isObject(payload) ? payload : null
    const error = objectValue(record?.error)
    const detail = stringValue(error?.message) ?? stringValue(record?.message)
    throw new Error(`${provider} proxy returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
  }
  if (!isObject(payload)) throw new Error(`${provider} proxy returned an invalid JSON body`)
  return payload
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

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function requiredString(value: unknown, label: string): string {
  const result = stringValue(value)
  if (!result) throw new Error(`${label} is required`)
  return result
}
