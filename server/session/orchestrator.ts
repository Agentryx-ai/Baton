import { createHash } from 'node:crypto'
import { AdapterRegistry } from './adapter-registry.ts'
import type { ProviderBindingPatch } from './adapter.ts'
import { DEFAULT_AGENT_LOOP_LIMITS } from './domain.ts'
import type {
  AgentToolDefinition,
  AgentToolInvocation,
  AgentToolResult,
  BeginTurnResult,
  CanonicalGoal,
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
import { GoalRuntime, type GoalContinuationRequest } from './goal-runtime.ts'
import { goalContinuationPrompt } from './goal-prompts.ts'
import type { ConversationService, StartTurnInput, UserGoalStatusInput } from './service.ts'
import type {
  ClearGoalInput,
  CreateGoalInput,
  EditGoalInput,
  ForkThreadInput,
  GoalCasResult,
  GoalTurnContext,
  SessionListScope,
  SessionStore,
} from './store.ts'
import { GoalStoreError, SessionStoreError } from './store.ts'
import { GOAL_TOOL_DEFINITIONS, ToolCoordinator, type ToolRuntime } from './tool-coordinator.ts'
import { LocalWorkspaceToolRuntime } from './tools/local-workspace-runtime.ts'

interface ActiveTurn {
  controller: AbortController
  completion: Promise<void>
}

const NO_WORKSPACE_RUNTIME: ToolRuntime = Object.freeze({
  definitions: Object.freeze([]),
  async execute(_invocation: AgentToolInvocation): Promise<AgentToolResult> {
    return {
      success: false,
      content: null,
      error: { code: 'tool_unavailable', message: 'This session has no verified workspace', retryable: false },
    }
  },
})

export class TurnOrchestrator implements ConversationService {
  private readonly store: SessionStore
  private readonly adapters: AdapterRegistry
  private readonly events: ConversationEventHub
  private readonly cancellationTimeoutMs: number
  private readonly goalRuntime: GoalRuntime
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
    this.goalRuntime = new GoalRuntime(store, {
      ownerId: `baton-${process.pid}-${Date.now()}`,
      launchContinuation: (request) => this.launchGoalContinuation(request),
    })
  }

  createSession(input: CreateSessionInput): CanonicalSession {
    const session = this.store.createSession(input)
    this.events.publish(session.activeThreadId)
    return session
  }

  listSessions(scope: SessionListScope = 'active'): CanonicalSession[] { return this.store.listSessions(scope) }
  getSession(sessionId: SessionId): CanonicalSession | null { return this.store.getSession(sessionId) }
  archiveSession(sessionId: SessionId): CanonicalSession { return this.store.archiveSession(sessionId) }
  restoreSession(sessionId: SessionId): CanonicalSession { return this.store.restoreSession(sessionId) }
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

  getGoal(threadId: ThreadId): CanonicalGoal | null { return this.store.getGoal(threadId) }

  async createGoal(input: CreateGoalInput): Promise<CanonicalGoal> {
    const goal = this.store.createGoal(input)
    this.events.publish(goal.threadId)
    void this.goalRuntime.notifyThreadIdle(goal.threadId)
    return goal
  }

  async editGoal(input: EditGoalInput): Promise<CanonicalGoal> {
    const goal = this.store.editGoal(input)
    this.events.publish(goal.threadId)
    if (goal.status === 'active') void this.goalRuntime.notifyThreadIdle(goal.threadId)
    return goal
  }

  async updateGoalStatus(input: UserGoalStatusInput): Promise<GoalCasResult> {
    const before = this.store.getGoalById(input.goalId)
    const result = this.store.updateGoalStatus({
      ...input,
      ...(input.status === 'paused' ? {
        reason: { code: 'user_paused', source: 'user' as const, message: null, at: new Date().toISOString() },
      } : {}),
    })
    const threadId = result.goal?.threadId ?? before?.threadId
    if (threadId) {
      this.events.publish(threadId)
      if (result.status === 'applied' && result.goal?.status === 'active') {
        void this.goalRuntime.notifyThreadIdle(threadId)
      } else if (result.status === 'applied' && result.goal?.status === 'paused') {
        await this.interruptGoalTurns(result.goal.id)
      }
    }
    return result
  }

  async clearGoal(input: ClearGoalInput): Promise<void> {
    const goal = this.store.getGoalById(input.goalId)
    this.store.clearGoal(input)
    if (goal) {
      this.events.publish(goal.threadId)
      await this.interruptGoalTurns(goal.id)
    }
  }

  subscribe(threadId: ThreadId, listener: () => void): () => void {
    return this.events.subscribe(threadId, listener)
  }

  async startTurn(input: StartTurnInput): Promise<BeginTurnResult> {
    return this.startTurnInternal(input, null, false)
  }

  private async startTurnInternal(
    input: StartTurnInput,
    goalContext: GoalTurnContext | null,
    automatic: boolean,
  ): Promise<BeginTurnResult> {
    if (this.closed) throw new Error('Canonical conversation runtime is closed')
    validateTurnInput(input, automatic)

    const ready = await this.adapters.getReady(input.provider)
    const workspaceRuntime = this.workspaceRuntime(input.threadId)
    const toolDefinitions: readonly AgentToolDefinition[] = [
      ...workspaceRuntime.definitions,
      ...GOAL_TOOL_DEFINITIONS,
    ]
    const result = this.store.beginTurn({
      threadId: input.threadId,
      provider: input.provider,
      model: input.model,
      effort: input.effort ?? null,
      clientRequestId: input.clientRequestId,
      requestHash: hashTurnRequest(input),
      expectedRevision: input.expectedRevision,
      input: input.input,
      adapterVersion: ready.handshake.adapterVersion,
      policySnapshot: {
        delegationMode: 'disabled',
        allowedTools: toolDefinitions.map((tool) => tool.name),
        approvalPolicy: 'never',
        cwd: this.workspaceCwd(input.threadId),
        maxDepth: 0,
        capabilityGrant: null,
      },
      budget: input.effort ? { effort: input.effort } : {},
      leaseExpiresAt: null,
      goalContext,
    })
    this.events.publish(input.threadId)
    if (result.duplicate) return result

    let latestTokensUsed = 0
    const coordinator = new ToolCoordinator({
      store: this.store,
      turnId: result.turn.id,
      threadId: input.threadId,
      provider: input.provider,
      model: input.model,
      effort: input.effort ?? null,
      workspaceRuntime,
      limits: DEFAULT_AGENT_LOOP_LIMITS,
      initialGoalObservation: result.turn.goalId === null || result.turn.goalRevision === null
        ? { kind: 'none' }
        : { kind: 'goal', goalId: result.turn.goalId, revision: result.turn.goalRevision },
      goalCreationRequested: false,
      flushGoalAccounting: () => this.checkpointGoalTurn(result.turn, latestTokensUsed),
      finalTokensUsed: () => latestTokensUsed,
    })
    const controller = new AbortController()
    const completion = this.executeTurn(
      result.turn,
      input,
      ready.adapter,
      ready.handshake.capabilities,
      controller.signal,
      coordinator,
      automatic,
      (tokens) => { latestTokensUsed = tokens },
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
      const interrupt = async () => {
        active.controller.abort(new Error('Turn cancelled by user'))
        await withTimeout(active.completion, this.cancellationTimeoutMs, `Turn cancellation ${turnId}`)
      }
      const turn = this.store.getTurn(turnId)
      const goal = turn?.goalId ? this.store.getGoalById(turn.goalId) : null
      if (turn?.goalId && turn.goalRevision !== null && goal?.status === 'active') {
        await this.goalRuntime.pauseBeforeInterrupt({
          goalId: turn.goalId,
          goalRevision: turn.goalRevision,
          interrupt,
        })
      } else {
        await interrupt()
      }
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

  async startGoalRuntime(): Promise<void> { await this.goalRuntime.start() }

  async close(): Promise<void> {
    this.closed = true
    this.goalRuntime.stop()
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
    coordinator: ToolCoordinator,
    automatic: boolean,
    onTokensUsed: (tokens: number) => void,
  ): Promise<void> {
    let terminal: FinishTurnInput = { turnId: turn.id, status: 'completed' }
    let tokensUsed = 0
    try {
      const persisted = this.store.getSnapshot(input.threadId)
      if (!persisted) throw new Error(`Thread disappeared after turn start: ${input.threadId}`)
      const snapshot = adapterSnapshot(persisted, input.provider, turn.id)
      assertNoUnresolvedToolCalls(snapshot)
      const request = {
        turnId: turn.id,
        model: input.model,
        effort: input.effort ?? null,
        input: input.input,
      }
      adapter.validate(request, snapshot)
      const nativeRequest = adapter.materialize(request, snapshot)

      const execution = await adapter.execute(nativeRequest, {
        signal,
        toolDefinitions: coordinator.definitions,
        limits: DEFAULT_AGENT_LOOP_LIMITS,
        executeTool: async (invocation) => {
          const pending = coordinator.execute(invocation, signal)
          this.events.publish(input.threadId)
          try {
            return await pending
          } finally {
            this.checkpointGoalTurn(turn, tokensUsed, true)
            this.events.publish(input.threadId)
          }
        },
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
          tokensUsed = Math.max(tokensUsed, usageTokens(event.payload))
          onTokensUsed(tokensUsed)
          this.checkpointGoalTurn(turn, tokensUsed)
          this.events.publish(input.threadId)
        }
        const result = await execution.terminal
        if (signal.aborted) throw signal.reason ?? new Error('Turn cancelled by user')
        tokensUsed = Math.max(tokensUsed, usageTokens(result.usage))
        onTokensUsed(tokensUsed)
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
    this.checkpointGoalTurn(turn, tokensUsed)
    this.store.finishTurn(terminal)
    this.events.publish(input.threadId)
    await this.finishGoalTurn(turn, terminal, tokensUsed, automatic)
  }

  private workspaceCwd(threadId: ThreadId): string | null {
    const snapshot = this.store.getSnapshot(threadId)
    if (!snapshot) return null
    const instructed = instructionCwd(snapshot.thread.instructionSnapshot)
    if (instructed) return instructed
    if (snapshot.session.cwd) return snapshot.session.cwd
    return snapshot.session.source ? null : process.cwd()
  }

  private workspaceRuntime(threadId: ThreadId): ToolRuntime {
    const cwd = this.workspaceCwd(threadId)
    return cwd ? new LocalWorkspaceToolRuntime({ cwd }) : NO_WORKSPACE_RUNTIME
  }

  private checkpointGoalTurn(turn: CanonicalTurn, tokensUsed: number, includeProgress = false): void {
    if (turn.goalId === null || turn.goalRevision === null) return
    this.store.checkpointGoalTurn({
      turnId: turn.id,
      goalId: turn.goalId,
      goalRevision: turn.goalRevision,
      tokensUsed,
      timeUsedSeconds: elapsedTurnSeconds(turn, new Date().toISOString()),
      ...(includeProgress ? {
        progressDigest: goalProgressDigest(this.store.getSnapshot(turn.threadId), turn.goalRevision, turn.id),
      } : {}),
    })
  }

  private async finishGoalTurn(
    turn: CanonicalTurn,
    terminal: FinishTurnInput,
    tokensUsed: number,
    automatic: boolean,
  ): Promise<void> {
    if (turn.goalId === null || turn.goalRevision === null) return
    const progressDigest = goalProgressDigest(this.store.getSnapshot(turn.threadId), turn.goalRevision, turn.id)
    const accounted = this.store.recordGoalTurn({
      turnId: turn.id,
      goalId: turn.goalId,
      goalRevision: turn.goalRevision,
      tokensUsed,
      timeUsedSeconds: elapsedTurnSeconds(turn, new Date().toISOString()),
      automatic,
      progressDigest,
    })
    if (accounted.status === 'stale' || !accounted.goal) return
    if (terminal.status === 'failed') {
      this.stopGoalForTerminal(accounted.goal, terminal.error)
      this.events.publish(turn.threadId)
      return
    }
    await this.goalRuntime.notifyThreadIdle(turn.threadId)
    this.events.publish(turn.threadId)
  }

  private stopGoalForTerminal(goal: CanonicalGoal, error: Record<string, unknown> | null | undefined): void {
    const code = typeof error?.code === 'string' ? error.code : 'provider_failure'
    if (code === 'provider_usage_limit') {
      this.goalRuntime.stopForProviderFailure({
        goalId: goal.id,
        goalRevision: goal.revision,
        category: 'provider_usage_limit',
        message: typeof error?.message === 'string' ? error.message : undefined,
      })
      return
    }
    const budgetReason = budgetLimitReason(code)
    if (budgetReason) {
      this.store.updateGoalStatus({
        goalId: goal.id,
        expectedRevision: goal.revision,
        status: 'budget_limited',
        reason: { code: budgetReason, source: 'host', message: null, at: new Date().toISOString() },
      })
      return
    }
    this.goalRuntime.stopForProviderFailure({
      goalId: goal.id,
      goalRevision: goal.revision,
      category: 'provider_failure',
      message: typeof error?.message === 'string' ? error.message : undefined,
    })
  }

  private async launchGoalContinuation(request: GoalContinuationRequest) {
    if (request.signal.aborted) return { status: 'not_started' as const, reason: 'cancelled' as const }
    const thread = this.store.getThread(request.goal.threadId)
    if (!thread || thread.status !== 'idle') return { status: 'not_started' as const, reason: 'busy' as const }
    try {
      const started = await this.startTurnInternal({
        threadId: request.goal.threadId,
        provider: request.goal.provider,
        model: request.goal.model,
        effort: request.goal.effort,
        clientRequestId: request.clientRequestId,
        expectedRevision: thread.revision,
        input: [{
          kind: 'user_message',
          visibility: 'baton_private',
          payload: { text: goalContinuationPrompt(request.goal), goalContinuation: true },
        }],
      }, request.goalContext, true)
      return { status: 'started' as const, turnId: started.turn.id }
    } catch (error) {
      if (error instanceof GoalStoreError && error.code === 'goal_lease_lost') {
        return { status: 'not_started' as const, reason: 'lease_lost' as const }
      }
      if (error instanceof SessionStoreError
        && (error.code === 'revision_conflict' || error.code === 'duplicate_request')) {
        return { status: 'not_started' as const, reason: 'stale' as const }
      }
      if (error instanceof SessionStoreError && error.code === 'turn_not_running') {
        return { status: 'not_started' as const, reason: 'busy' as const }
      }
      return {
        status: 'failed' as const,
        category: 'provider_failure' as const,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async interruptGoalTurns(goalId: string): Promise<void> {
    const matching = [...this.active.entries()].filter(([turnId]) => this.store.getTurn(turnId)?.goalId === goalId)
    for (const [turnId, active] of matching) {
      active.controller.abort(new Error('Goal paused by user'))
      await withTimeout(active.completion, this.cancellationTimeoutMs, `Goal pause ${turnId}`)
    }
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
    effort: input.effort ?? null,
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

function validateTurnInput(input: StartTurnInput, internalGoalTurn = false): void {
  if (!input.model.trim()) throw new Error('model is required')
  if (input.effort !== undefined && input.effort !== null && !input.effort.trim()) {
    throw new Error('effort must be null or a non-empty string')
  }
  if (!input.clientRequestId.trim()) throw new Error('clientRequestId is required')
  if (input.input.length === 0) throw new Error('at least one input item is required')
  for (const item of input.input) {
    const visibility = item.visibility ?? 'portable'
    if (item.kind !== 'user_message'
      || (visibility !== 'portable' && !(internalGoalTurn && visibility === 'baton_private'))) {
      throw new Error('turn input accepts portable user messages and internal Goal continuations only')
    }
  }
}

function usageTokens(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0
  const object = value as Record<string, unknown>
  if (object.usage && typeof object.usage === 'object') return usageTokens(object.usage)
  const input = firstFinite(object, ['inputTokens', 'input_tokens', 'input'])
  const cached = firstFinite(object, [
    'cachedInputTokens', 'cached_input_tokens', 'cacheReadInputTokens', 'cache_read_input_tokens',
  ])
  const output = firstFinite(object, ['outputTokens', 'output_tokens', 'output'])
  if (input > 0 || output > 0 || cached > 0) return Math.max(0, input - cached) + Math.max(0, output)
  return Math.max(0, firstFinite(object, ['totalTokens', 'total_tokens', 'total']))
}

function firstFinite(object: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const value = object[key]
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value))
  }
  return 0
}

function elapsedTurnSeconds(turn: CanonicalTurn, endIso: string): number {
  if (!turn.startedAt) return 0
  return Math.max(0, Math.floor((Date.parse(endIso) - Date.parse(turn.startedAt)) / 1_000))
}

function goalProgressDigest(snapshot: ThreadSnapshot | null, goalRevision: number, turnId: TurnId): string | null {
  const evidence = snapshot?.items
    .filter((item) => item.turnId === turnId && (item.kind === 'tool_result' || item.kind === 'file_change'
      || item.kind === 'plan' || item.kind === 'task'))
    .map((item) => stableProgressEvidence(item.kind, item.payload)) ?? []
  if (evidence.length === 0) return null
  return createHash('sha256').update(stableJson({
    goalRevision,
    evidence: [...new Set(evidence)].sort(),
  })).digest('hex')
}

function stableProgressEvidence(kind: string, payload: Record<string, unknown>): string {
  if (kind === 'tool_result') {
    return stableJson({
      kind,
      toolName: payload.toolName ?? null,
      result: payload.result ?? null,
    })
  }
  return stableJson({ kind, payload })
}

function budgetLimitReason(code: string): string | null {
  if (code === 'model_round_limit') return 'model_round_limit'
  if (code === 'tool_call_limit') return 'tool_call_limit'
  if (code === 'tool_repetition_limit') return 'tool_repetition_limit'
  if (code === 'turn_time_limit') return 'turn_time_limit'
  if (code === 'turn_budget_limit') return 'turn_budget_limit'
  return null
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
