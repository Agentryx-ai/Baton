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
  SessionProviderAdapter,
} from './adapter.ts'
import type {
  AgentToolDefinition,
  AgentToolInvocation,
  AgentToolResult,
  CanonicalProvider,
  NewCanonicalItem,
  ThreadSnapshot,
} from './domain.ts'
import { canonicalDeveloperInstructions } from './instruction-snapshot.ts'
import { hasPortableUserContent, imageAttachments, parseImageArtifactRef, type ImageArtifactResolver } from './image-artifacts.ts'

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
  imageArtifacts?: ImageArtifactResolver
}

type ProviderMessage = Record<string, unknown>

interface MaterializedHttpTurn {
  turnId: string
  provider: SupportedProvider
  model: string
  effort: string | null
  developerInstructions: string | null
  messages: ProviderMessage[]
}

interface NormalizedResponse {
  responseId: string
  requestedModel: string
  reportedModel: string | null
  effort: string | null
  text: string
  usage: JsonObject
}

interface ModelRoundProvenance {
  round: number
  responseId: string | null
  requestedModel: string
  reportedModel: string | null
  stopReason: string
  toolDecision: boolean
}

interface ProviderContinuationState {
  assistant: ProviderMessage
  toolResults: ProviderMessage[]
  followUp?: ProviderMessage
  liveFollowUps?: Array<{ followUpId: string; message: ProviderMessage }>
}

interface ModelRoundRecord extends ModelRoundProvenance {
  usage: JsonObject
  usageProvenance: 'provider_rounds_cumulative'
  continuation?: ProviderContinuationState
}

interface RetryBudget {
  readonly maximum: number
  remaining: number
}

const CLAUDE_INITIAL_MAX_TOKENS = 16_384
const CLAUDE_MAX_TOKENS = 65_536
const CLAUDE_OUTPUT_CONTINUATION_LIMIT = 3

type ProviderToolCall = Pick<AgentToolInvocation, 'providerCallId' | 'name' | 'input'>

class EventQueue<T> implements AsyncIterable<T> {
  private readonly values: Array<{ value: T; acknowledge: (() => void) | null }> = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private deliveredAcknowledge: (() => void) | null = null
  private ended = false

  push(value: T): void {
    this.enqueue(value, null)
  }

  pushAndWait(value: T): Promise<void> {
    if (this.ended) return Promise.resolve()
    // The consumer requests the next item only after it has normalized and
    // durably stored the current one. Continuation requests wait for that
    // boundary so provider-private replay state cannot race ahead of storage.
    return new Promise((resolve) => this.enqueue(value, resolve))
  }

  private enqueue(value: T, acknowledge: (() => void) | null): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) {
      this.deliveredAcknowledge = acknowledge
      waiter({ value, done: false })
    } else {
      this.values.push({ value, acknowledge })
    }
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    this.deliveredAcknowledge?.()
    this.deliveredAcknowledge = null
    for (const queued of this.values) queued.acknowledge?.()
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        this.deliveredAcknowledge?.()
        this.deliveredAcknowledge = null
        const queued = this.values.shift()
        if (queued !== undefined) {
          this.deliveredAcknowledge = queued.acknowledge
          return Promise.resolve({ value: queued.value, done: false })
        }
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

interface ClaimedSteer {
  request: ProviderSteerRequest
  resolve: (result: ProviderSteerResult) => void
  settled: boolean
}

class LiveSteerQueue {
  private readonly pending: ClaimedSteer[] = []
  private readonly unsettled = new Set<ClaimedSteer>()
  private accepting = true
  private readonly expectedTurnId: string

  constructor(expectedTurnId: string) {
    this.expectedTurnId = expectedTurnId
  }

  steer(request: ProviderSteerRequest): Promise<ProviderSteerResult> {
    if (!request.followUpId || !request.text) {
      return Promise.reject(new TypeError('Stateless steer requires a follow-up ID and text'))
    }
    if (!this.accepting || request.expectedTurnId !== this.expectedTurnId) {
      return Promise.resolve({ status: 'closed' })
    }
    return new Promise((resolve) => {
      const entry = { request, resolve, settled: false }
      this.pending.push(entry)
      this.unsettled.add(entry)
    })
  }

  claim(round: number, limit: number | null, sealIfEmpty = false): ClaimedSteer[] {
    if (!this.accepting || (limit !== null && round >= limit)) {
      this.close()
      return []
    }
    if (this.pending.length === 0) {
      if (sealIfEmpty) this.close()
      return []
    }
    return this.pending.splice(0)
  }

  continuation(batch: readonly ClaimedSteer[]): NonNullable<ProviderContinuationState['liveFollowUps']> {
    return batch.filter((entry) => !entry.settled).map((entry) => ({
      followUpId: entry.request.followUpId,
      message: { role: 'user', content: entry.request.text },
    }))
  }

  appendAndAccept(messages: ProviderMessage[], batch: readonly ClaimedSteer[]): number {
    if (!this.accepting) return 0
    let accepted = 0
    for (const entry of batch) {
      if (entry.settled) continue
      messages.push({ role: 'user', content: entry.request.text })
      entry.settled = true
      this.unsettled.delete(entry)
      entry.resolve({ status: 'accepted' })
      accepted += 1
    }
    return accepted
  }

  close(): void {
    if (!this.accepting && this.unsettled.size === 0) return
    this.accepting = false
    this.pending.length = 0
    for (const entry of this.unsettled) {
      if (entry.settled) continue
      entry.settled = true
      entry.resolve({ status: 'closed' })
    }
    this.unsettled.clear()
  }
}

export class StatelessHttpCanonicalAdapter implements SessionProviderAdapter {
  readonly provider: SupportedProvider
  private readonly proxyConnectionProvider: () => Promise<StatelessProxyConnection>
  private readonly fetchImpl: typeof fetch
  private readonly imageArtifacts: ImageArtifactResolver | null
  private connection: StatelessProxyConnection | null = null
  private initializePromise: Promise<AdapterHandshake> | null = null
  private shuttingDown = false
  private readonly active = new Set<AbortController>()

  constructor(options: StatelessHttpAdapterOptions) {
    this.provider = options.provider
    this.proxyConnectionProvider = options.proxyConnection
    this.fetchImpl = options.fetchImpl ?? fetch
    this.imageArtifacts = options.imageArtifacts ?? null
  }

  initialize(): Promise<AdapterHandshake> {
    this.initializePromise ??= this.proxyConnectionProvider().then((connection) => {
      this.connection = connection
      return {
        adapterVersion: `baton-${this.provider}-http-v1`,
        capabilities: {
          roles: ['user', 'assistant'],
          contentTypes: ['text', 'image'],
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
    if (request.input.length === 0) throw new Error(`${this.provider} turn requires input`)
    for (const item of request.input) {
      if (item.kind !== 'user_message' || !hasPortableUserContent(item.payload)) {
        throw new Error(`${this.provider} safe mode accepts portable text and image user_message input only`)
      }
    }
  }

  materialize(request: CanonicalTurnRequest, snapshot: ThreadSnapshot): NativeTurnRequest {
    this.validate(request, snapshot)
    const messages = materializeProviderHistory(snapshot, this.provider)
    for (const item of request.input) {
      messages.push({ role: 'user', content: portableUserContent(item.payload) })
    }
    const body: MaterializedHttpTurn = {
      turnId: request.turnId,
      provider: this.provider,
      model: request.model,
      effort: request.effort ?? null,
      developerInstructions: canonicalDeveloperInstructions(snapshot.thread.instructionSnapshot),
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
    const timeout = context.limits.turnTimeoutMs === null ? null : setTimeout(() => {
      turnTimedOut = true
      controller.abort(new Error(
        `${this.provider} turn exceeded time limit (${context.limits.turnTimeoutMs}ms)`,
      ))
    }, context.limits.turnTimeoutMs)

    const events = new EventQueue<NativeProviderEvent>()
    const steerQueue = new LiveSteerQueue(body.turnId)
    let resolveTerminal!: (result: ProviderTerminalResult) => void
    const terminal = new Promise<ProviderTerminalResult>((resolve) => {
      resolveTerminal = resolve
    })

    const emitModelRound = (
      round: ModelRoundProvenance,
      usage: JsonObject,
      continuation?: ProviderContinuationState,
    ): Promise<void> => {
      if (controller.signal.aborted) return Promise.resolve()
      const event: NativeProviderEvent = {
        eventId: `${this.provider}:model-round:${body.turnId}:${round.round}`,
        type: 'response/model-round',
        payload: {
          ...round,
          usage: { ...usage },
          usageProvenance: 'provider_rounds_cumulative',
          ...(continuation ? { continuation } : {}),
        } satisfies ModelRoundRecord,
        durability: 'durable',
      }
      return events.pushAndWait(event)
    }

    const providerRequest = this.request(body, controller.signal, context, emitModelRound, steerQueue)
    void Promise.race([providerRequest, rejectOnAbort(controller.signal)]).then((response) => {
      if (turnTimedOut) {
        throw new ProviderLoopError(
          'turn_time_limit',
          `${this.provider} turn exceeded time limit (${context.limits.turnTimeoutMs}ms)`,
        )
      }
      if (cancellationRequested || controller.signal.aborted) {
        throw controller.signal.reason ?? new Error('Turn cancelled by user')
      }
      steerQueue.close()
      events.push({
        eventId: `${this.provider}:response:${response.responseId}`,
        type: 'response/completed',
        payload: response,
        durability: 'durable',
      })
      events.end()
      resolveTerminal({ status: 'completed', usage: response.usage })
    }).catch((error: unknown) => {
      steerQueue.close()
      events.end()
      const message = turnTimedOut
        ? `${this.provider} turn exceeded time limit (${context.limits.turnTimeoutMs}ms)`
        : error instanceof Error ? error.message : String(error)
      resolveTerminal(turnTimedOut
        ? {
            status: 'failed',
            error: {
              code: 'turn_time_limit',
              message,
            },
          }
        : cancellationRequested
          ? { status: 'cancelled' }
          : {
              status: 'failed',
              error: {
                code: providerErrorCode(error),
                message,
              },
            })
    }).finally(() => {
      if (timeout !== null) clearTimeout(timeout)
      context.signal.removeEventListener('abort', abort)
      this.active.delete(controller)
    })

    return {
      events,
      terminal,
      steer: (steerRequest) => steerQueue.steer(steerRequest),
      cancel: async () => {
        cancellationRequested = true
        steerQueue.close()
        controller.abort(new Error('Turn cancelled by user'))
      },
      dispose: async () => {
        steerQueue.close()
        context.signal.removeEventListener('abort', abort)
      },
    }
  }

  normalize(event: NativeProviderEvent): NewCanonicalItem[] {
    if (event.type === 'response/model-round') {
      const round = parseModelRoundProvenance(event.payload)
      const items: NewCanonicalItem[] = [{
        kind: 'provider_event',
        visibility: 'baton_private',
        provider: this.provider,
        nativeId: round.responseId,
        payload: round,
      }]
      const usage = objectValue(event.payload)?.usage
      if (isObject(usage)) {
        items.push({
          kind: 'usage',
          visibility: 'baton_private',
          provider: this.provider,
          payload: {
            ...usage,
            round: round.round,
            usageProvenance: 'provider_rounds_cumulative',
          },
        })
      }
      const continuation = parseProviderContinuation(event.payload)
      if (continuation) {
        items.push({
          kind: 'provider_event',
          visibility: 'provider_private',
          provider: this.provider,
          nativeId: round.responseId,
          payload: {
            stateVersion: 1,
            round: round.round,
            assistant: continuation.assistant,
            toolResults: continuation.toolResults,
            ...(continuation.followUp ? { followUp: continuation.followUp } : {}),
            ...(continuation.liveFollowUps ? { liveFollowUps: continuation.liveFollowUps } : {}),
          },
        })
        if (round.stopReason === 'max_tokens' || round.stopReason === 'model_context_window_exceeded') {
          const partialText = providerMessageText(continuation.assistant)
          if (partialText) {
            items.push({
              kind: 'assistant_message',
              visibility: 'portable',
              provider: this.provider,
              nativeId: round.responseId,
              payload: {
                text: partialText,
                requestedModel: round.requestedModel,
                reportedModel: round.reportedModel,
                modelFallback: round.reportedModel !== null && round.requestedModel !== round.reportedModel,
                modelProvenance: round.reportedModel === null ? 'unreported' : 'provider_reported',
                incomplete: true,
                continuationIndex: round.round,
              },
            })
          }
        }
        if (continuation.liveFollowUps?.length
          && (round.stopReason === 'end_turn' || round.stopReason.toLowerCase() === 'stop')) {
          const intermediateText = providerMessageText(continuation.assistant)
          if (intermediateText) {
            items.push({
              kind: 'assistant_message',
              visibility: 'portable',
              provider: this.provider,
              nativeId: round.responseId,
              payload: {
                text: intermediateText,
                requestedModel: round.requestedModel,
                reportedModel: round.reportedModel,
                modelFallback: round.reportedModel !== null && round.requestedModel !== round.reportedModel,
                modelProvenance: round.reportedModel === null ? 'unreported' : 'provider_reported',
                continuation: true,
              },
            })
          }
        }
      }
      return items
    }
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
          reportedModel: response.reportedModel,
          modelFallback: response.reportedModel !== null
            && response.requestedModel !== response.reportedModel,
          modelProvenance: response.reportedModel === null ? 'unreported' : 'provider_reported',
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
      ...(response.reportedModel === null ? {} : { modelFamily: response.reportedModel }),
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
    onModelRound: (
      round: ModelRoundProvenance,
      usage: JsonObject,
      continuation?: ProviderContinuationState,
    ) => Promise<void>,
    steerQueue: LiveSteerQueue,
  ): Promise<NormalizedResponse> {
    if (!this.connection) throw new Error(`${this.provider} proxy connection is unavailable`)
    return this.provider === 'claude'
      ? this.requestClaude(body, signal, context, onModelRound, steerQueue)
      : this.requestGemini(body, signal, context, onModelRound, steerQueue)
  }

  private async requestClaude(
    body: MaterializedHttpTurn,
    signal: AbortSignal,
    context: ProviderExecutionContext,
    onModelRound: (
      round: ModelRoundProvenance,
      usage: JsonObject,
      continuation?: ProviderContinuationState,
    ) => Promise<void>,
    steerQueue: LiveSteerQueue,
  ): Promise<NormalizedResponse> {
    const messages: ProviderMessage[] = body.messages.map((message) => hydrateProviderMessage(
      message,
      'claude',
      this.imageArtifacts,
    ))
    const tools = context.toolDefinitions.map(toClaudeTool)
    const usage: JsonObject = {}
    const seenProviderCallIds = new Set<string>()
    const retryBudget = createRetryBudget(context.limits.maxProviderRetries)
    let outputContinuations = 0
    let requestMaxTokens = CLAUDE_INITIAL_MAX_TOKENS

    for (let round = 1; context.limits.maxModelRoundTrips === null
      || round <= context.limits.maxModelRoundTrips; round += 1) {
      const response = await fetchWithRetry(this.fetchImpl, `${this.connection!.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.connection!.token,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: body.model,
          max_tokens: requestMaxTokens,
          // Anthropic automatic prompt caching advances the breakpoint with
          // the growing canonical history. No provider-visible thread ID is
          // needed; cache reuse remains prefix-bound by the Messages API.
          cache_control: { type: 'ephemeral' },
          ...(body.developerInstructions ? { system: body.developerInstructions } : {}),
          messages,
          ...(tools.length > 0 ? { tools } : {}),
          ...(body.effort ? { output_config: { effort: body.effort } } : {}),
        }),
        signal,
      }, retryBudget, signal)
      const payload = await responseJson(response, this.provider)
      mergeNumericUsage(usage, objectValue(payload.usage))
      const content = Array.isArray(payload.content) ? payload.content : []
      const hasToolDecision = content.some((part) => isObject(part) && part.type === 'tool_use')
      const rawStopReason = stringValue(payload.stop_reason)
      const stopReason = rawStopReason ?? 'missing'
      const roundRecord: ModelRoundProvenance = {
        round,
        responseId: stringValue(payload.id),
        requestedModel: body.model,
        reportedModel: stringValue(payload.model),
        stopReason,
        toolDecision: hasToolDecision,
      }
      let roundRecorded = false
      const recordRound = async (continuation?: ProviderContinuationState): Promise<void> => {
        if (roundRecorded) return
        roundRecorded = true
        await onModelRound(roundRecord, usage, continuation)
      }
      const text = content.flatMap((part) => isObject(part) && part.type === 'text'
        && typeof part.text === 'string' ? [part.text] : []).join('')
      const assistantMessage = { role: 'assistant', content }

      if (!rawStopReason) {
        await recordRound()
        throw new ProviderLoopError(
          'provider_invalid_terminal',
          'Claude response did not contain stop_reason',
        )
      }

      if (stopReason === 'max_tokens' && hasToolDecision) {
        await recordRound()
        if (requestMaxTokens >= CLAUDE_MAX_TOKENS) {
          throw new ProviderLoopError(
            'provider_incomplete_tool_call',
            `Claude reached max_tokens with an incomplete tool call at the retry cap (${CLAUDE_MAX_TOKENS})`,
          )
        }
        assertAnotherModelRound(round, context.limits.maxModelRoundTrips, 'Claude incomplete tool retry')
        requestMaxTokens = Math.min(requestMaxTokens * 2, CLAUDE_MAX_TOKENS)
        continue
      }

      let toolUses: ProviderToolCall[]
      try {
        toolUses = content.flatMap((part) => {
          if (!isObject(part) || part.type !== 'tool_use') return []
          return [{
            providerCallId: requiredString(part.id, 'Claude tool use id'),
            name: requiredString(part.name, 'Claude tool name'),
            input: requiredObject(part.input, 'Claude tool input'),
          }]
        })
      } catch (error) {
        await recordRound()
        throw error
      }

      if (stopReason === 'end_turn') {
        if (toolUses.length > 0) {
          await recordRound()
          throw new ProviderLoopError(
            'provider_invalid_terminal',
            'Claude end_turn response contained pending tool_use blocks',
          )
        }
        if (!text) {
          await recordRound()
          throw new ProviderLoopError('provider_invalid_terminal', 'Claude end_turn response did not contain text')
        }
        const steers = steerQueue.claim(round, context.limits.maxModelRoundTrips, true)
        if (steers.length > 0) {
          await recordRound({
            assistant: assistantMessage,
            toolResults: [],
            liveFollowUps: steerQueue.continuation(steers),
          })
          messages.push(assistantMessage)
          if (steerQueue.appendAndAccept(messages, steers) > 0) {
            requestMaxTokens = CLAUDE_INITIAL_MAX_TOKENS
            continue
          }
        } else {
          await recordRound()
        }
        return {
          responseId: stringValue(payload.id) ?? `${body.turnId}:response`,
          requestedModel: body.model,
          reportedModel: stringValue(payload.model),
          effort: body.effort,
          text,
          usage,
        }
      }
      if (stopReason === 'pause_turn') {
        const steers = steerQueue.claim(round, context.limits.maxModelRoundTrips)
        await recordRound({
          assistant: assistantMessage,
          toolResults: [],
          ...(steers.length > 0 ? { liveFollowUps: steerQueue.continuation(steers) } : {}),
        })
        assertAnotherModelRound(round, context.limits.maxModelRoundTrips, 'Claude pause_turn')
        messages.push(assistantMessage)
        steerQueue.appendAndAccept(messages, steers)
        continue
      }
      if (stopReason === 'max_tokens') {
        if (!text) {
          await recordRound({ assistant: assistantMessage, toolResults: [] })
          throw new ProviderLoopError('provider_continuation_stalled', 'Claude max_tokens response contained no text')
        }
        outputContinuations += 1
        const canContinue = outputContinuations <= CLAUDE_OUTPUT_CONTINUATION_LIMIT
          && (context.limits.maxModelRoundTrips === null || round < context.limits.maxModelRoundTrips)
        const followUp = canContinue
          ? { role: 'user', content: 'Please continue from where you left off.' }
          : undefined
        const steers = canContinue
          ? steerQueue.claim(round, context.limits.maxModelRoundTrips)
          : []
        await recordRound({
          assistant: assistantMessage,
          toolResults: [],
          ...(followUp ? { followUp } : {}),
          ...(steers.length > 0 ? { liveFollowUps: steerQueue.continuation(steers) } : {}),
        })
        if (outputContinuations > CLAUDE_OUTPUT_CONTINUATION_LIMIT) {
          throw new ProviderLoopError(
            'output_continuation_limit',
            `Claude exceeded the bounded output continuation limit (${CLAUDE_OUTPUT_CONTINUATION_LIMIT})`,
          )
        }
        assertAnotherModelRound(round, context.limits.maxModelRoundTrips, 'Claude max_tokens')
        if (!followUp) throw new Error('Claude continuation follow-up was not materialized')
        messages.push(assistantMessage, followUp)
        steerQueue.appendAndAccept(messages, steers)
        continue
      }
      if (stopReason !== 'tool_use') {
        await recordRound(
          stopReason === 'model_context_window_exceeded'
            ? { assistant: { role: 'assistant', content }, toolResults: [] }
            : undefined,
        )
        throw new ProviderLoopError(
          stopReason === 'refusal' ? 'provider_refusal' : 'provider_incomplete',
          `Claude stopped without completing the turn: ${stopReason}`,
        )
      }
      if (toolUses.length === 0) {
        await recordRound()
        throw new ProviderLoopError('provider_invalid_terminal', 'Claude returned tool_use without a tool_use block')
      }
      if (context.limits.maxModelRoundTrips !== null && round >= context.limits.maxModelRoundTrips) {
        await recordRound({
          assistant: { role: 'assistant', content },
          toolResults: [],
        })
      }
      assertAnotherModelRound(round, context.limits.maxModelRoundTrips, 'Claude tool_use')
      try {
        assertUniqueToolCallIds(toolUses, seenProviderCallIds, 'Claude')
      } catch (error) {
        await recordRound()
        throw error
      }
      const results = await executeToolBatch(body.turnId, toolUses, context, signal)
      const durableToolResultMessage = {
        role: 'user',
        content: results.map((result, index) => claudeToolResult(
          toolUses[index]!.providerCallId,
          result,
          context.limits.toolOutputBytes,
          this.imageArtifacts,
        )),
      }
      const toolResultMessage = hydrateProviderMessage(durableToolResultMessage, 'claude', this.imageArtifacts)
      const steers = steerQueue.claim(round, context.limits.maxModelRoundTrips)
      await recordRound({
        assistant: assistantMessage,
        toolResults: [durableToolResultMessage],
        ...(steers.length > 0 ? { liveFollowUps: steerQueue.continuation(steers) } : {}),
      })
      messages.push(assistantMessage, toolResultMessage)
      steerQueue.appendAndAccept(messages, steers)
      requestMaxTokens = CLAUDE_INITIAL_MAX_TOKENS
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
    onModelRound: (
      round: ModelRoundProvenance,
      usage: JsonObject,
      continuation?: ProviderContinuationState,
    ) => Promise<void>,
    steerQueue: LiveSteerQueue,
  ): Promise<NormalizedResponse> {
    const messages: ProviderMessage[] = body.messages.map((message) => hydrateProviderMessage(
      message,
      'gemini',
      this.imageArtifacts,
    ))
    const tools = context.toolDefinitions.map(toOpenAiTool)
    const usage: JsonObject = {}
    const seenProviderCallIds = new Set<string>()
    const retryBudget = createRetryBudget(context.limits.maxProviderRetries)

    for (let round = 1; context.limits.maxModelRoundTrips === null
      || round <= context.limits.maxModelRoundTrips; round += 1) {
      const response = await fetchWithRetry(this.fetchImpl, `${this.connection!.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.connection!.token}`,
        },
        body: JSON.stringify({
          model: body.model,
          messages: body.developerInstructions
            ? [{ role: 'system', content: body.developerInstructions }, ...messages]
            : messages,
          max_tokens: 16_384,
          ...(tools.length > 0 ? { tools } : {}),
          ...(body.effort ? { reasoning_effort: body.effort } : {}),
        }),
        signal,
      }, retryBudget, signal)
      const payload = await responseJson(response, this.provider)
      mergeNumericUsage(usage, objectValue(payload.usage))
      usage.input_tokens = numberValue(usage.prompt_tokens)
      usage.output_tokens = numberValue(usage.completion_tokens)
      const choices = Array.isArray(payload.choices) ? payload.choices : []
      const first = isObject(choices[0]) ? choices[0] : null
      if (!first) throw new Error('Gemini response did not contain a choice')
      const message = objectValue(first.message)
      if (!message) throw new Error('Gemini response did not contain a message')
      const text = stringValue(message.content)
      const hasToolDecision = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
      const rawFinishReason = stringValue(first.finish_reason)
      if (!rawFinishReason) {
        throw new ProviderLoopError(
          'provider_invalid_terminal',
          'Gemini response did not contain finish_reason',
        )
      }
      const finishReason = rawFinishReason
      const normalizedFinishReason = finishReason.toLowerCase()
      const roundRecord: ModelRoundProvenance = {
        round,
        responseId: stringValue(payload.id),
        requestedModel: body.model,
        reportedModel: stringValue(payload.model),
        stopReason: finishReason,
        toolDecision: hasToolDecision,
      }
      const toolCalls = parseOpenAiToolCalls(message.tool_calls)

      if (normalizedFinishReason === 'stop') {
        if (toolCalls.length > 0) {
          throw new ProviderLoopError(
            'provider_invalid_terminal',
            'Gemini stop response contained pending tool calls',
          )
        }
        if (!text) throw new ProviderLoopError('provider_invalid_terminal', 'Gemini stop response did not contain text')
        const assistantMessage = { role: 'assistant', content: text }
        const steers = steerQueue.claim(round, context.limits.maxModelRoundTrips, true)
        if (steers.length > 0) {
          await onModelRound(roundRecord, usage, {
            assistant: assistantMessage,
            toolResults: [],
            liveFollowUps: steerQueue.continuation(steers),
          })
          messages.push(assistantMessage)
          if (steerQueue.appendAndAccept(messages, steers) > 0) continue
        } else {
          await onModelRound(roundRecord, usage)
        }
        return {
          responseId: stringValue(payload.id) ?? `${body.turnId}:response`,
          requestedModel: body.model,
          reportedModel: stringValue(payload.model),
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
      assertUniqueToolCallIds(toolCalls, seenProviderCallIds, 'Gemini')
      const results = await executeToolBatch(body.turnId, toolCalls, context, signal)
      const assistantMessage = {
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: message.tool_calls,
      }
      const toolResultMessages: ProviderMessage[] = []
      for (const [index, result] of results.entries()) {
        toolResultMessages.push({
          role: 'tool',
          tool_call_id: toolCalls[index]!.providerCallId,
          name: toolCalls[index]!.name,
          content: serializeToolResult(result, context.limits.toolOutputBytes).content,
        })
        const images = result.success ? result.images ?? [] : []
        if (images.length > 0) {
          toolResultMessages.push({
            role: 'user',
            content: [
              { type: 'text', text: `Image output from ${toolCalls[index]!.name}` },
              ...images.map((image) => ({
                type: 'baton_image',
                artifact: image,
              })),
            ],
          })
        }
      }
      const steers = steerQueue.claim(round, context.limits.maxModelRoundTrips)
      await onModelRound(roundRecord, usage, {
        assistant: assistantMessage,
        toolResults: toolResultMessages,
        ...(steers.length > 0 ? { liveFollowUps: steerQueue.continuation(steers) } : {}),
      })
      messages.push(
        assistantMessage,
        ...toolResultMessages.map((message) => hydrateProviderMessage(message, 'gemini', this.imageArtifacts)),
      )
      steerQueue.appendAndAccept(messages, steers)
    }
    throw new ProviderLoopError(
      'model_round_limit',
      `Gemini exceeded model round-trip limit (${context.limits.maxModelRoundTrips})`,
    )
  }
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  budget: RetryBudget,
  signal: AbortSignal,
): Promise<Response> {
  let localAttempt = 0
  while (true) {
    try {
      const response = await fetchImpl(url, init)
      if (!retryableStatus(response.status)) return response
      if (!consumeRetry(budget)) return response
      await response.arrayBuffer().catch(() => undefined)
    } catch (error) {
      if (signal.aborted) throw error
      if (!consumeRetry(budget)) {
        throw new ProviderLoopError(
          'provider_retry_exhausted',
          `Provider request failed after ${budget.maximum} total retries: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    await retryDelay(Math.min(1_000, 100 * (2 ** localAttempt)), signal)
    localAttempt += 1
  }
}

function createRetryBudget(maximum: number): RetryBudget {
  return { maximum, remaining: maximum }
}

function consumeRetry(budget: RetryBudget): boolean {
  if (budget.remaining <= 0) return false
  budget.remaining -= 1
  return true
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
    throw new ProviderLoopError(
      response.status === 429 ? 'provider_usage_limit' : 'provider_invalid_response',
      `${provider} proxy returned non-JSON HTTP ${response.status}`,
    )
  }
  if (!response.ok) {
    const record = isObject(payload) ? payload : null
    const error = objectValue(record?.error)
    const detail = stringValue(error?.message) ?? stringValue(record?.message)
    throw new ProviderLoopError(
      response.status === 429
        ? 'provider_usage_limit'
        : retryableStatus(response.status) ? 'provider_retry_exhausted' : 'provider_http_error',
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

function claudeToolResult(
  providerCallId: string,
  result: AgentToolResult,
  byteLimit: number,
  _artifacts: ImageArtifactResolver | null,
): JsonObject {
  const serialized = serializeToolResult(result, byteLimit)
  const images = result.success ? result.images ?? [] : []
  return {
    type: 'tool_result',
    tool_use_id: providerCallId,
    content: images.length === 0
      ? serialized.content
      : [
          { type: 'text', text: serialized.content },
          ...images.map((image) => ({
            type: 'baton_image',
            artifact: image,
          })),
        ],
    ...(serialized.isError ? { is_error: true } : {}),
  }
}

function serializeToolResult(
  result: AgentToolResult,
  byteLimit: number,
): { content: string; isError: boolean } {
  const payload = result.success ? result.content : { error: result.error }
  let content: string
  try {
    content = JSON.stringify(payload)
  } catch {
    content = JSON.stringify({ error: { code: 'tool_result_serialization', message: 'Tool result was not JSON serializable' } })
    return boundedSerializedError(content, byteLimit)
  }
  if (utf8Bytes(content) <= byteLimit) return { content, isError: !result.success }
  return boundedSerializedError(
    JSON.stringify({
      error: {
        code: 'tool_output_limit',
        message: `Tool result exceeded the ${byteLimit}-byte output limit`,
      },
    }),
    byteLimit,
  )
}

function boundedSerializedError(content: string, byteLimit: number): { content: string; isError: true } {
  for (const candidate of [content, '{"error":"tool_output_limit"}', '"tool_output_limit"', 'null', '']) {
    if (utf8Bytes(candidate) <= byteLimit) return { content: candidate, isError: true }
  }
  return { content: '', isError: true }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
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

function assertUniqueToolCallIds(
  calls: readonly ProviderToolCall[],
  seen: Set<string>,
  provider: string,
): void {
  const batchIds = new Set<string>()
  for (const call of calls) {
    if (seen.has(call.providerCallId) || batchIds.has(call.providerCallId)) {
      throw new ProviderLoopError(
        'provider_duplicate_tool_id',
        `${provider} returned duplicate tool call id ${call.providerCallId}`,
      )
    }
    batchIds.add(call.providerCallId)
  }
  for (const id of batchIds) seen.add(id)
}

async function executeToolBatch(
  turnId: string,
  calls: readonly ProviderToolCall[],
  context: ProviderExecutionContext,
  signal: AbortSignal,
): Promise<AgentToolResult[]> {
  return Promise.all(calls.map((call) => executeToolSafely(turnId, call, context, signal)))
}

async function executeToolSafely(
  turnId: string,
  call: ProviderToolCall,
  context: ProviderExecutionContext,
  signal: AbortSignal,
): Promise<AgentToolResult> {
  if (signal.aborted) return unavailableToolResult(signal.reason)
  try {
    return await context.executeTool({
      callId: `${turnId}:${call.providerCallId}`,
      providerCallId: call.providerCallId,
      name: call.name,
      input: call.input,
    })
  } catch (error) {
    return unavailableToolResult(error)
  }
}

function unavailableToolResult(reason: unknown): AgentToolResult {
  return {
    success: false,
    content: null,
    error: {
      code: 'tool_execution_failed',
      message: reason instanceof Error ? reason.message : String(reason ?? 'Tool was not executed'),
      retryable: false,
    },
  }
}

function assertAnotherModelRound(round: number, limit: number | null, reason: string): void {
  if (limit !== null && round >= limit) {
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

function parseMaterializedTurn(value: unknown, provider: SupportedProvider): MaterializedHttpTurn {
  if (!isObject(value) || value.provider !== provider || !Array.isArray(value.messages)) {
    throw new Error(`Invalid ${provider} native turn request`)
  }
  return {
    turnId: requiredString(value.turnId, 'canonical turn id'),
    provider,
    model: requiredString(value.model, `${provider} model`),
    effort: typeof value.effort === 'string' ? value.effort : null,
    developerInstructions: typeof value.developerInstructions === 'string' ? value.developerInstructions : null,
    messages: value.messages.map((message) => parseProviderHistoryMessage(message, provider)),
  }
}

function parseProviderHistoryMessage(value: unknown, provider: SupportedProvider): ProviderMessage {
  if (!isObject(value)) throw new Error(`Invalid ${provider} history message`)
  return provider === 'claude'
    ? parseClaudeHistoryMessage(value)
    : parseGeminiHistoryMessage(value)
}

function parseClaudeHistoryMessage(message: JsonObject): ProviderMessage {
  if (message.role !== 'user' && message.role !== 'assistant') {
    throw new Error('Invalid claude history role')
  }
  if (typeof message.content === 'string') {
    return { role: message.role, content: message.content }
  }
  if (!Array.isArray(message.content) || message.content.some((part) => !isObject(part))) {
    throw new Error('Invalid claude structured history content')
  }
  return { role: message.role, content: message.content }
}

function parseGeminiHistoryMessage(message: JsonObject): ProviderMessage {
  if (message.role === 'user') {
    if (typeof message.content === 'string') return { role: 'user', content: requiredString(message.content, 'Gemini user message content') }
    if (!Array.isArray(message.content) || message.content.some((part) => !isObject(part))) {
      throw new Error('Invalid Gemini structured user content')
    }
    return { role: 'user', content: message.content }
  }
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: requiredString(message.tool_call_id, 'Gemini tool call id'),
      name: requiredString(message.name, 'Gemini tool name'),
      content: requiredString(message.content, 'Gemini tool result content'),
    }
  }
  if (message.role !== 'assistant') throw new Error('Invalid gemini history role')
  const content = message.content === null
    ? null
    : requiredString(message.content, 'Gemini assistant message content')
  if (message.tool_calls === undefined) {
    if (content === null) throw new Error('Gemini assistant history requires content or tool calls')
    return { role: 'assistant', content }
  }
  if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0
    || message.tool_calls.some((call) => !isObject(call))) {
    throw new Error('Invalid Gemini assistant tool calls')
  }
  return { role: 'assistant', content, tool_calls: message.tool_calls }
}

function parseNormalizedResponse(value: unknown): NormalizedResponse {
  if (!isObject(value)) throw new Error('Invalid normalized provider response')
  return {
    responseId: requiredString(value.responseId, 'provider response id'),
    requestedModel: requiredString(value.requestedModel, 'requested model'),
    reportedModel: typeof value.reportedModel === 'string' ? value.reportedModel : null,
    effort: typeof value.effort === 'string' ? value.effort : null,
    text: requiredString(value.text, 'provider response text'),
    usage: objectValue(value.usage) ?? {},
  }
}

function parseModelRoundProvenance(value: unknown): ModelRoundProvenance & JsonObject {
  if (!isObject(value)) throw new Error('Invalid model-round provenance')
  return {
    round: requiredPositiveInteger(value.round, 'model round'),
    responseId: typeof value.responseId === 'string' ? value.responseId : null,
    requestedModel: requiredString(value.requestedModel, 'requested model'),
    reportedModel: typeof value.reportedModel === 'string' ? value.reportedModel : null,
    stopReason: requiredString(value.stopReason, 'provider stop reason'),
    toolDecision: value.toolDecision === true,
  }
}

function parseProviderContinuation(value: unknown): ProviderContinuationState | null {
  if (!isObject(value) || value.continuation === undefined) return null
  const continuation = requiredObject(value.continuation, 'provider continuation')
  const assistant = requiredObject(continuation.assistant, 'provider continuation assistant')
  if (!Array.isArray(continuation.toolResults) || continuation.toolResults.some((result) => !isObject(result))) {
    throw new Error('Provider continuation tool results must be structured messages')
  }
  const liveFollowUps = parseLiveFollowUps(continuation.liveFollowUps)
  return {
    assistant,
    toolResults: continuation.toolResults as ProviderMessage[],
    ...(continuation.followUp === undefined
      ? {}
      : { followUp: requiredObject(continuation.followUp, 'provider continuation follow-up') }),
    ...(liveFollowUps ? { liveFollowUps } : {}),
  }
}

function parseLiveFollowUps(value: unknown): ProviderContinuationState['liveFollowUps'] {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('Provider live follow-ups must be an array')
  return value.map((entry) => {
    const parsed = requiredObject(entry, 'provider live follow-up')
    return {
      followUpId: requiredString(parsed.followUpId, 'provider live follow-up id'),
      message: requiredObject(parsed.message, 'provider live follow-up message'),
    }
  })
}

function providerMessageText(message: ProviderMessage): string | null {
  if (typeof message.content === 'string') return message.content.trim() ? message.content : null
  if (!Array.isArray(message.content)) return null
  const text = message.content.flatMap((part) => isObject(part) && part.type === 'text'
    && typeof part.text === 'string' ? [part.text] : []).join('')
  return text.trim() ? text : null
}

function materializeProviderHistory(
  snapshot: ThreadSnapshot,
  provider: SupportedProvider,
): ProviderMessage[] {
  const messages: ProviderMessage[] = []
  const ordered = [...snapshot.items].sort((left, right) => left.sequence - right.sequence)
  for (let index = 0; index < ordered.length;) {
    const first = ordered[index]!
    const turnKey = first.turnId ?? `item:${first.id}`
    const group = []
    while (index < ordered.length) {
      const item = ordered[index]!
      const itemTurnKey = item.turnId ?? `item:${item.id}`
      if (itemTurnKey !== turnKey) break
      group.push(item)
      index += 1
    }

    const exactContinuations = group.flatMap((item) => {
      if (item.visibility !== 'provider_private' || item.provider !== provider) return []
      const continuation = parseStoredProviderContinuation(item.payload)
      return continuation === null ? [] : [{ item, continuation }]
    })
    const exactByItemId = new Map(exactContinuations.map((entry) => [entry.item.id, entry.continuation]))
    const hasExactContinuation = exactContinuations.length > 0
    const aggregatePortableContinuation = !hasExactContinuation && group.some((item) => (
      item.visibility === 'portable'
      && item.kind === 'assistant_message'
      && item.payload.incomplete === true
    ))

    for (const item of group) {
      const exact = exactByItemId.get(item.id)
      if (exact) {
        messages.push(
          { ...exact.assistant },
          ...exact.toolResults.map((result) => ({ ...result })),
          ...(exact.followUp ? [{ ...exact.followUp }] : []),
        )
        continue
      }
      if (item.visibility !== 'portable') continue
      if (hasExactContinuation && item.kind === 'assistant_message'
        && (item.payload.incomplete === true || item.payload.continuation === true)) {
        continue
      }
      const text = portableHistoryText(item.kind, item.payload)
      const attachments = item.kind === 'user_message' ? imageAttachments(item.payload) : []
      if (text === null && attachments.length === 0) continue
      const role = item.kind === 'user_message' ? 'user' : 'assistant'
      const content = role === 'user' && attachments.length > 0
        ? portableUserContent(item.payload)
        : text as string
      if (hasExactContinuation) {
        messages.push({ role, content })
        continue
      }
      if (typeof content !== 'string') {
        messages.push({ role, content })
        continue
      }
      appendMessage(
        messages,
        role,
        content,
        aggregatePortableContinuation && role === 'assistant' ? '' : '\n\n',
      )
    }
  }
  return messages
}

function parseStoredProviderContinuation(payload: JsonObject): ProviderContinuationState | null {
  if (payload.stateVersion !== 1 || !isObject(payload.assistant)) return null
  if (!Array.isArray(payload.toolResults) || payload.toolResults.some((result) => !isObject(result))) {
    throw new Error('Stored provider continuation tool results must be structured messages')
  }
  if (payload.followUp !== undefined && !isObject(payload.followUp)) {
    throw new Error('Stored provider continuation follow-up must be a structured message')
  }
  const liveFollowUps = parseLiveFollowUps(payload.liveFollowUps)
  return {
    assistant: payload.assistant,
    toolResults: payload.toolResults,
    ...(payload.followUp === undefined ? {} : { followUp: payload.followUp }),
    ...(liveFollowUps ? { liveFollowUps } : {}),
  }
}

function appendMessage(
  messages: ProviderMessage[],
  role: 'user' | 'assistant',
  content: string,
  separator = '\n\n',
): void {
  const previous = messages.at(-1)
  if (previous?.role === role && typeof previous.content === 'string') {
    previous.content += `${separator}${content}`
  }
  else messages.push({ role, content })
}

function portableHistoryText(kind: string, payload: JsonObject): string | null {
  const text = portableText(payload)
  if (kind === 'user_message' || kind === 'assistant_message' || kind === 'summary') return text
  if (kind === 'reasoning_summary') return text === null ? null : `[Reasoning summary]\n${text}`
  if (kind === 'plan' || kind === 'task') return text === null ? null : `[Plan]\n${text}`
  return null
}

function portableText(payload: JsonObject): string | null {
  if (typeof payload.text === 'string' && payload.text.trim()) return payload.text
  if (typeof payload.content === 'string' && payload.content.trim()) return payload.content
  if (Array.isArray(payload.summary)) {
    const parts = payload.summary.filter((part): part is string => typeof part === 'string')
    if (parts.length > 0) return parts.join('\n')
  }
  if (Array.isArray(payload.plan)) return JSON.stringify(payload.plan)
  return null
}

function portableUserContent(payload: JsonObject): string | JsonObject[] {
  const text = portableText(payload)
  const attachments = imageAttachments(payload)
  if (attachments.length === 0) return text as string
  return [
    ...(text === null ? [] : [{ type: 'text', text }]),
    ...attachments.map((attachment) => ({ type: 'baton_image', artifact: attachment })),
  ]
}

function hydrateProviderMessage(
  message: ProviderMessage,
  provider: SupportedProvider,
  artifacts: ImageArtifactResolver | null,
): ProviderMessage {
  return hydrateProviderValue(message, provider, artifacts) as ProviderMessage
}

function hydrateProviderValue(
  value: unknown,
  provider: SupportedProvider,
  artifacts: ImageArtifactResolver | null,
): unknown {
  if (Array.isArray(value)) return value.map((entry) => hydrateProviderValue(entry, provider, artifacts))
  if (!isObject(value)) return value
  if (value.type === 'baton_image') {
    if (!artifacts) throw new Error(`${provider} image content requires an artifact resolver`)
    const artifact = parseImageArtifactRef(value.artifact)
    const dataUrl = artifacts.dataUrl(artifact)
    return provider === 'claude'
      ? {
          type: 'image',
          source: {
            type: 'base64',
            media_type: artifact.mediaType,
            data: dataUrl.split(',', 2)[1],
          },
        }
      : { type: 'image_url', image_url: { url: dataUrl } }
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    hydrateProviderValue(entry, provider, artifacts),
  ]))
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

function requiredPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`)
  }
  return value
}
