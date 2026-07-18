import { createHash } from 'node:crypto'
import { AdapterRegistry } from './adapter-registry.ts'
import type { ProviderBindingPatch } from './adapter.ts'
import type {
  BeginTurnResult,
  CanonicalItem,
  CanonicalSession,
  CanonicalStreamEvent,
  CanonicalThread,
  CanonicalTurn,
  CreateSessionInput,
  FinishTurnInput,
  SessionId,
  ThreadId,
  ThreadSnapshot,
  TurnId,
} from './domain.ts'
import { ConversationEventHub } from './event-hub.ts'
import type { ConversationService, StartTurnInput } from './service.ts'
import type { ForkThreadInput, SessionStore } from './store.ts'

interface ActiveTurn {
  controller: AbortController
  completion: Promise<void>
}

export class TurnOrchestrator implements ConversationService {
  private readonly store: SessionStore
  private readonly adapters: AdapterRegistry
  private readonly events: ConversationEventHub
  private readonly cancellationTimeoutMs: number
  private readonly active = new Map<TurnId, ActiveTurn>()
  private closed = false

  constructor(
    store: SessionStore,
    adapters: AdapterRegistry,
    events: ConversationEventHub,
    cancellationTimeoutMs = 10_000,
  ) {
    this.store = store
    this.adapters = adapters
    this.events = events
    this.cancellationTimeoutMs = cancellationTimeoutMs
  }

  createSession(input: CreateSessionInput): CanonicalSession {
    const session = this.store.createSession(input)
    this.events.publish(session.activeThreadId)
    return session
  }

  listSessions(): CanonicalSession[] { return this.store.listSessions() }
  getSession(sessionId: SessionId): CanonicalSession | null { return this.store.getSession(sessionId) }
  getSnapshot(threadId: ThreadId): ThreadSnapshot | null { return this.store.getSnapshot(threadId) }

  forkThread(input: ForkThreadInput): CanonicalThread {
    const thread = this.store.forkThread(input)
    this.events.publish(thread.id)
    return thread
  }

  listItems(threadId: ThreadId, afterSequence = 0): CanonicalItem[] {
    return this.store.listItems(threadId, afterSequence)
  }

  listEvents(threadId: ThreadId, afterSequence = 0): CanonicalStreamEvent[] {
    return this.store.listEvents(threadId, afterSequence)
  }

  subscribe(threadId: ThreadId, listener: () => void): () => void {
    return this.events.subscribe(threadId, listener)
  }

  async startTurn(input: StartTurnInput): Promise<BeginTurnResult> {
    if (this.closed) throw new Error('Canonical conversation runtime is closed')
    validateTurnInput(input)

    const ready = await this.adapters.getReady(input.provider)
    const result = this.store.beginTurn({
      threadId: input.threadId,
      provider: input.provider,
      model: input.model,
      clientRequestId: input.clientRequestId,
      requestHash: hashTurnRequest(input),
      expectedRevision: input.expectedRevision,
      input: input.input,
      adapterVersion: ready.handshake.adapterVersion,
      policySnapshot: {
        delegationMode: 'disabled',
        allowedTools: [],
        approvalPolicy: 'never',
        cwd: instructionCwd(this.store.getThread(input.threadId)?.instructionSnapshot),
        maxDepth: 0,
        capabilityGrant: null,
      },
      budget: {},
      leaseExpiresAt: null,
    })
    this.events.publish(input.threadId)
    if (result.duplicate) return result

    const controller = new AbortController()
    const completion = this.executeTurn(
      result.turn,
      input,
      ready.adapter,
      ready.handshake.capabilities,
      controller.signal,
    ).finally(() => {
      this.active.delete(result.turn.id)
    })
    this.active.set(result.turn.id, { controller, completion })
    void completion.catch(() => {})
    return result
  }

  async cancelTurn(turnId: TurnId): Promise<void> {
    const active = this.active.get(turnId)
    if (active) {
      active.controller.abort(new Error('Turn cancelled by user'))
      await withTimeout(active.completion, this.cancellationTimeoutMs, `Turn cancellation ${turnId}`)
      return
    }
    const turn = this.store.getTurn(turnId)
    if (!turn) throw new Error(`Turn not found: ${turnId}`)
    if (isTerminal(turn.status)) return
    throw new Error(`Turn ${turnId} is not owned by this runtime process`)
  }

  recoverInterruptedTurns(): number {
    return this.store.recoverInterruptedTurns()
  }

  async close(): Promise<void> {
    this.closed = true
    const active = [...this.active.values()]
    for (const turn of active) turn.controller.abort(new Error('Baton is shutting down'))
    await this.adapters.shutdownAll()
    const completions = await Promise.allSettled(active.map((turn) => withTimeout(
      turn.completion,
      this.cancellationTimeoutMs,
      'Turn shutdown',
    )))
    const timedOut = completions.find((result) => result.status === 'rejected')
    if (timedOut?.status === 'rejected') throw timedOut.reason
    this.events.clear()
    this.store.close()
  }

  private async executeTurn(
    turn: CanonicalTurn,
    input: StartTurnInput,
    adapter: Awaited<ReturnType<AdapterRegistry['getReady']>>['adapter'],
    capabilities: Awaited<ReturnType<AdapterRegistry['getReady']>>['handshake']['capabilities'],
    signal: AbortSignal,
  ): Promise<void> {
    let terminal: FinishTurnInput = { turnId: turn.id, status: 'completed' }
    try {
      const persisted = this.store.getSnapshot(input.threadId)
      if (!persisted) throw new Error(`Thread disappeared after turn start: ${input.threadId}`)
      const snapshot = adapterSnapshot(persisted, input.provider, turn.id)
      assertNoUnresolvedToolCalls(snapshot)
      const request = { turnId: turn.id, model: input.model, input: input.input }
      adapter.validate(request, snapshot)
      const nativeRequest = adapter.materialize(request, snapshot)

      const execution = await adapter.execute(nativeRequest, {
        signal,
        async denyApproval() { throw new Error('Provider approval requests are disabled in canonical MVP') },
        async denyToolCall() { throw new Error('Provider tool calls are disabled in canonical MVP') },
      })
      const cancelOnAbort = () => { void execution.cancel().catch(() => undefined) }
      signal.addEventListener('abort', cancelOnAbort, { once: true })
      try {
        for await (const event of execution.events) {
          const items = adapter.normalize(event)
          if (items.length > 0) {
            if (event.durability !== 'durable' || !event.eventId) {
              throw new Error(`Adapter produced canonical items from non-durable event: ${event.type}`)
            }
            this.store.appendProviderEvent({ turnId: turn.id, eventId: event.eventId, items })
          }
          const patch = adapter.extractBinding(event)
          if (patch) this.persistBinding(input, capabilities, patch)
          this.events.publish(input.threadId)
        }
        const result = await execution.terminal
        terminal = {
          turnId: turn.id,
          status: result.status,
          usage: result.usage,
          error: result.error,
        }
      } finally {
        signal.removeEventListener('abort', cancelOnAbort)
        await execution.dispose()
      }
    } catch (error) {
      terminal = signal.aborted
        ? { turnId: turn.id, status: 'cancelled' }
        : {
            turnId: turn.id,
            status: 'failed',
            error: { message: error instanceof Error ? error.message : String(error) },
          }
    }
    this.store.finishTurn(terminal)
    this.events.publish(input.threadId)
  }

  private persistBinding(
    input: StartTurnInput,
    capabilities: Awaited<ReturnType<AdapterRegistry['getReady']>>['handshake']['capabilities'],
    patch: ProviderBindingPatch,
  ): void {
    if (patch.opaqueState && patch.opaqueState.byteLength > 0) {
      throw new Error('Opaque provider state cannot be persisted before encryption is configured')
    }
    this.store.upsertProviderBinding({
      threadId: input.threadId,
      provider: input.provider,
      modelFamily: patch.modelFamily ?? input.model,
      nativeThreadId: patch.nativeThreadId,
      nativeResponseId: patch.nativeResponseId,
      opaqueStateEncrypted: null,
      capabilities,
      syncedRevision: this.store.getThread(input.threadId)?.revision ?? input.expectedRevision,
      contextDigest: hashSnapshot(this.store.getSnapshot(input.threadId)),
    })
  }
}

export function hashTurnRequest(input: StartTurnInput): string {
  return createHash('sha256').update(stableJson({
    threadId: input.threadId,
    provider: input.provider,
    model: input.model,
    clientRequestId: input.clientRequestId,
    input: input.input,
  })).digest('hex')
}

function hashSnapshot(snapshot: ThreadSnapshot | null): string {
  if (!snapshot) throw new Error('Cannot bind a missing canonical thread')
  return createHash('sha256').update(stableJson({
    threadId: snapshot.thread.id,
    revision: snapshot.thread.revision,
    items: snapshot.items.map((item) => ({ id: item.id, sequence: item.sequence })),
  })).digest('hex')
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
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

function instructionCwd(snapshot: Record<string, unknown> | undefined): string | null {
  return typeof snapshot?.cwd === 'string' ? snapshot.cwd : null
}

function validateTurnInput(input: StartTurnInput): void {
  if (!input.model.trim()) throw new Error('model is required')
  if (!input.clientRequestId.trim()) throw new Error('clientRequestId is required')
  if (input.input.length === 0) throw new Error('at least one input item is required')
  for (const item of input.input) {
    if (item.kind !== 'user_message' || (item.visibility ?? 'portable') !== 'portable') {
      throw new Error('turn input accepts portable user_message items only')
    }
  }
}

function adapterSnapshot(
  snapshot: ThreadSnapshot,
  provider: StartTurnInput['provider'],
  currentTurnId: TurnId,
): ThreadSnapshot {
  return {
    ...snapshot,
    items: snapshot.items.filter((item) =>
      item.turnId !== currentTurnId
      && (item.visibility === 'portable'
        || (item.visibility === 'provider_private' && item.provider === provider)),
    ),
    bindings: snapshot.bindings.filter((binding) => binding.provider === provider),
  }
}

function assertNoUnresolvedToolCalls(snapshot: ThreadSnapshot): void {
  const open = new Set<string>()
  for (const item of snapshot.items) {
    const callId = typeof item.payload.callId === 'string' ? item.payload.callId : null
    if (!callId) continue
    if (item.kind === 'tool_call') open.add(callId)
    if (item.kind === 'tool_result') open.delete(callId)
  }
  if (open.size > 0) throw new Error(`Provider switch blocked by unresolved tool calls: ${[...open].join(', ')}`)
}

function isTerminal(status: CanonicalTurn['status']): boolean {
  return status === 'completed'
    || status === 'cancelled'
    || status === 'failed'
    || status === 'interrupted'
}
