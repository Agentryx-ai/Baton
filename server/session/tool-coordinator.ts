import { createHash } from 'node:crypto'

import type {
  AgentLoopLimits,
  AgentToolDefinition,
  AgentToolInvocation,
  AgentToolResult,
  CanonicalGoal,
  CanonicalProvider,
  GoalId,
  GoalObservation,
  NewCanonicalItem,
  ThreadId,
  TurnId,
} from './domain.ts'
import { DEFAULT_AGENT_LOOP_LIMITS } from './domain.ts'
import type {
  CreateGoalInput,
  SessionStore,
} from './store.ts'
import { GoalStoreError } from './store.ts'
import { LocalWorkspaceToolRuntime } from './tools/local-workspace-runtime.ts'
import { parseImageArtifactRef } from './image-artifacts.ts'

type JsonObject = Record<string, unknown>

export const GOAL_TOOL_DEFINITIONS: readonly AgentToolDefinition[] = Object.freeze([
  definition('get_goal', 'Read the current Baton Goal, usage, and remaining token budget.', {}),
  definition('create_goal', 'Create a Goal only when the user explicitly requested one.', {
    objective: { type: 'string', minLength: 1, maxLength: 4_000 },
    tokenBudget: { type: 'integer', minimum: 1 },
  }, ['objective']),
  definition('update_goal', 'Mark the current Goal complete after satisfying the Goal audit rules.', {
    status: { type: 'string', enum: ['complete'] },
    evidence: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['requirement', 'proof'],
        properties: {
          requirement: { type: 'string', minLength: 1, maxLength: 500 },
          proof: { type: 'string', minLength: 1, maxLength: 1_000 },
        },
      },
    },
  }, ['status', 'evidence']),
])

/** The narrow durable API needed by the coordinator, intentionally easy to fake in tests. */
export type ToolCoordinatorStore = Pick<SessionStore,
  | 'appendProviderEvent'
  | 'setTurnActivity'
  | 'listItems'
  | 'getGoal'
  | 'createGoal'
>

export interface ToolRuntime {
  readonly definitions: readonly AgentToolDefinition[]
  /** True only when abort resolution proves the child process has exited. */
  readonly abortWaitsForTermination?: boolean
  execute(invocation: AgentToolInvocation, signal?: AbortSignal): Promise<AgentToolResult>
}

export interface ToolCoordinatorOptions {
  store: ToolCoordinatorStore
  turnId: TurnId
  threadId: ThreadId
  provider: CanonicalProvider
  model: string
  effort?: string | null
  cwd?: string
  workspaceRuntime?: ToolRuntime
  limits?: Partial<AgentLoopLimits>
  initialGoalObservation: GoalObservation
  /** Flush cumulative Goal accounting before a model-owned Goal mutation. */
  flushGoalAccounting?: () => unknown | Promise<unknown>
  /** Returns durable final tokens after the accounting flush. */
  finalTokensUsed?: () => number
  /** Set only when the user or a higher-level instruction explicitly requested Goal creation. */
  goalCreationRequested?: boolean
  /** Unsafe command execution stays absent unless an abort-safe runtime is explicitly supplied. */
  allowWorkspaceCommands?: boolean
}

interface PersistedCall {
  invocation: AgentToolInvocation
  result: AgentToolResult | null
}

export type ToolTerminalFailureCode = 'tool_call_limit' | 'tool_repetition_limit'

export interface ToolTerminalFailure {
  readonly [key: string]: unknown
  readonly code: ToolTerminalFailureCode
  readonly message: string
}

export interface GoalTerminalIntent {
  readonly goalId: GoalId
  readonly expectedRevision: number
  readonly status: 'complete'
  readonly completionEvidence?: readonly GoalCompletionEvidence[]
}

export interface GoalCompletionEvidence {
  readonly requirement: string
  readonly proof: string
}

export class ToolCoordinator {
  readonly definitions: readonly AgentToolDefinition[]
  readonly #store: ToolCoordinatorStore
  readonly #turnId: TurnId
  readonly #threadId: ThreadId
  readonly #provider: CanonicalProvider
  readonly #model: string
  readonly #effort: string | null
  readonly #runtime: ToolRuntime
  readonly #limits: AgentLoopLimits
  readonly #flushGoalAccounting: () => unknown | Promise<unknown>
  readonly #finalTokensUsed: () => number
  readonly #goalCreationRequested: boolean
  readonly #definitionsByName: ReadonlyMap<string, AgentToolDefinition>
  readonly #inFlight = new Map<string, { fingerprint: string; promise: Promise<AgentToolResult> }>()
  readonly #persisted = new Map<string, PersistedCall>()
  readonly #identicalCounts = new Map<string, number>()
  readonly #scheduledReads = new Set<Promise<void>>()
  readonly #unresolvedMutations = new Set<string>()
  #exclusiveTail: Promise<void> = Promise.resolve()
  #toolCalls = 0
  #activeCalls = 0
  #goalObservation: GoalObservation
  #fatalError: unknown = null
  #terminalFailure: ToolTerminalFailure | null = null
  #goalTerminalIntent: GoalTerminalIntent | null = null

  constructor(options: ToolCoordinatorOptions) {
    if (!options.model) throw new Error('ToolCoordinator model must not be empty')
    this.#store = options.store
    this.#turnId = options.turnId
    this.#threadId = options.threadId
    this.#provider = options.provider
    this.#model = options.model
    this.#effort = options.effort ?? null
    this.#goalObservation = options.initialGoalObservation
    this.#flushGoalAccounting = options.flushGoalAccounting ?? (() => undefined)
    this.#finalTokensUsed = options.finalTokensUsed ?? (() => this.#store.getGoal(this.#threadId)?.tokensUsed ?? 0)
    this.#goalCreationRequested = options.goalCreationRequested === true
    this.#limits = validateLimits({ ...DEFAULT_AGENT_LOOP_LIMITS, ...options.limits })
    this.#runtime = options.workspaceRuntime ?? new LocalWorkspaceToolRuntime({
      cwd: options.cwd ?? missingCwd(),
      maxOutputBytes: this.#limits.toolOutputBytes,
    })
    if (options.allowWorkspaceCommands && this.#runtime.abortWaitsForTermination !== true) {
      throw new Error('Workspace commands require a runtime that proves process termination before abort resolves')
    }
    const workspace = this.#runtime.definitions.filter((tool) => (
      tool.sideEffect !== 'workspace_command' || options.allowWorkspaceCommands === true
    ))
    const reservedNames = new Set(GOAL_TOOL_DEFINITIONS.map((tool) => tool.name))
    if (workspace.some((tool) => reservedNames.has(tool.name))) {
      throw new Error('Workspace runtime cannot override a Baton Goal tool')
    }
    const goalTools = GOAL_TOOL_DEFINITIONS.filter((tool) => (
      tool.name !== 'create_goal' || this.#goalCreationRequested
    ))
    this.definitions = Object.freeze([...workspace, ...goalTools])
    this.#definitionsByName = new Map(this.definitions.map((tool) => [tool.name, tool]))
    this.#loadPersistedCalls()
  }

  execute(invocation: AgentToolInvocation, signal?: AbortSignal): Promise<AgentToolResult> {
    if (this.#fatalError !== null) return Promise.reject(this.#fatalError)
    const fingerprint = invocationFingerprint(invocation)
    const active = this.#inFlight.get(invocation.callId)
    if (active) {
      return active.fingerprint === fingerprint
        ? active.promise
        : Promise.resolve(failure('tool_call_id_conflict', 'Tool call ID was reused with different input'))
    }
    const persisted = this.#persisted.get(invocation.callId)
    if (persisted) {
      if (invocationFingerprint(persisted.invocation) !== fingerprint) {
        return Promise.resolve(failure('tool_call_id_conflict', 'Tool call ID was reused with different input'))
      }
      if (persisted.result) return Promise.resolve(persisted.result)
      return Promise.resolve(failure(
        'tool_call_interrupted',
        'A durable tool call has no result; automatic replay is forbidden',
      ))
    }

    const promise = this.#executeOnce(invocation, signal)
      .finally(() => this.#inFlight.delete(invocation.callId))
    this.#inFlight.set(invocation.callId, { fingerprint, promise })
    return promise
  }

  /** The first host-authoritative tool limit exhausted by this turn. */
  get terminalFailure(): ToolTerminalFailure | null {
    return this.#terminalFailure
  }

  /** A model-requested Goal terminal transition, committed only after a valid provider terminal. */
  get goalTerminalIntent(): GoalTerminalIntent | null {
    return this.#goalTerminalIntent
  }

  /** True when a durable workspace mutation/command call has no durable result. */
  get hasUnknownMutationOutcome(): boolean {
    return this.#unresolvedMutations.size > 0
  }

  /** Wait until every accepted call has durably settled before the owning turn becomes terminal. */
  async settle(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight.values()].map((entry) => entry.promise))
    }
    if (this.#fatalError !== null) throw this.#fatalError
  }

  async #executeOnce(
    invocation: AgentToolInvocation,
    signal?: AbortSignal,
  ): Promise<AgentToolResult> {
    const definition = this.#definitionsByName.get(invocation.name)
    const limitResult = this.#reserveLimits(invocation)
    let activityStarted = false
    try {
      this.#appendCall(invocation, definition?.sideEffect ?? null)
      this.#activeCalls += 1
      activityStarted = true
      this.#store.setTurnActivity(this.#turnId, 'waiting_tool')
      if (limitResult) return this.#persistResult(invocation, limitResult)
      if (!definition) {
        return this.#persistResult(invocation, failure('tool_not_found', `Unregistered tool: ${invocation.name}`))
      }
      return await this.#schedule(definition, invocation, async () => {
        let result: AgentToolResult
        try {
          result = await this.#executeRegistered(invocation, definition.sideEffect, signal)
        } catch (error) {
          result = failure('tool_coordinator_error', errorMessage(error))
        }
        return this.#persistResult(invocation, result)
      })
    } catch (error) {
      this.#fatalError = error
      throw error
    } finally {
      if (activityStarted) {
        this.#activeCalls -= 1
        if (this.#activeCalls === 0 && this.#fatalError === null) {
          try {
            this.#store.setTurnActivity(this.#turnId, 'running')
          } catch (error) {
            this.#fatalError = error
          }
        }
      }
    }
  }

  #reserveLimits(invocation: AgentToolInvocation): AgentToolResult | null {
    if (this.#terminalFailure !== null) {
      return failure(this.#terminalFailure.code, this.#terminalFailure.message)
    }
    this.#toolCalls += 1
    const fingerprint = repetitionFingerprint(invocation)
    const identical = (this.#identicalCounts.get(fingerprint) ?? 0) + 1
    this.#identicalCounts.set(fingerprint, identical)
    if (this.#limits.maxToolCalls !== null && this.#toolCalls > this.#limits.maxToolCalls) {
      return this.#latchTerminalFailure(
        'tool_call_limit',
        `Turn exceeded ${this.#limits.maxToolCalls} tool calls`,
      )
    }
    if (this.#limits.maxIdenticalToolCalls !== null && identical > this.#limits.maxIdenticalToolCalls) {
      return this.#latchTerminalFailure(
        'tool_repetition_limit',
        `Turn exceeded ${this.#limits.maxIdenticalToolCalls} identical tool calls`,
      )
    }
    return null
  }

  #latchTerminalFailure(code: ToolTerminalFailureCode, message: string): AgentToolResult {
    this.#terminalFailure ??= Object.freeze({ code, message })
    return failure(this.#terminalFailure.code, this.#terminalFailure.message)
  }

  #schedule(
    definition: AgentToolDefinition,
    invocation: AgentToolInvocation,
    operation: () => Promise<AgentToolResult>,
  ): Promise<AgentToolResult> {
    if (definition.sideEffect === 'read_only' || invocation.name === 'get_goal') {
      const scheduled = this.#exclusiveTail.then(operation)
      const completion = scheduled.then(() => undefined)
      this.#scheduledReads.add(completion)
      void completion.then(
        () => this.#scheduledReads.delete(completion),
        () => this.#scheduledReads.delete(completion),
      )
      return scheduled
    }

    const precedingReads = [...this.#scheduledReads]
    const scheduled = Promise.all([this.#exclusiveTail, ...precedingReads]).then(operation)
    this.#exclusiveTail = scheduled.then(() => undefined)
    void this.#exclusiveTail.catch(() => undefined)
    return scheduled
  }

  #persistResult(invocation: AgentToolInvocation, value: AgentToolResult): AgentToolResult {
    const result = capResult(value, this.#limits.toolOutputBytes)
    this.#appendResult(invocation, result)
    this.#persisted.set(invocation.callId, { invocation, result })
    this.#unresolvedMutations.delete(invocation.callId)
    return result
  }

  #executeRegistered(
    invocation: AgentToolInvocation,
    sideEffect: AgentToolDefinition['sideEffect'],
    signal?: AbortSignal,
  ): Promise<AgentToolResult> {
    if (invocation.name === 'get_goal') return this.#getGoal(invocation)
    if (invocation.name === 'create_goal') return this.#createGoal(invocation)
    if (invocation.name === 'update_goal') return this.#updateGoal(invocation)
    return executeWithTimeout(
      this.#runtime,
      invocation,
      signal,
      this.#limits.toolTimeoutMs,
      sideEffect !== 'read_only',
    )
  }

  async #getGoal(invocation: AgentToolInvocation): Promise<AgentToolResult> {
    if (!isEmptyObject(invocation.input)) return invalidInput('get_goal does not accept properties')
    const goal = this.#store.getGoal(this.#threadId)
    this.#goalObservation = goal ? observation(goal) : { kind: 'none' }
    return success({ goal, remainingTokens: remainingTokens(goal) })
  }

  async #createGoal(invocation: AgentToolInvocation): Promise<AgentToolResult> {
    const input = validateCreateGoal(invocation.input)
    if ('error' in input) return input.error
    if (!this.#goalCreationRequested) {
      return failure('goal_creation_not_requested', 'Goal creation was not explicitly requested for this turn')
    }
    await this.#flushGoalAccounting()
    try {
      const goal = this.#store.createGoal({
        threadId: this.#threadId,
        expected: this.#goalObservation,
        objective: input.objective,
        provider: this.#provider,
        model: this.#model,
        effort: this.#effort,
        ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
      } satisfies CreateGoalInput)
      this.#goalObservation = observation(goal)
      return success({ goal })
    } catch (error) {
      return goalFailure(error)
    }
  }

  async #updateGoal(invocation: AgentToolInvocation): Promise<AgentToolResult> {
    const input = validateUpdateGoal(invocation.input)
    if ('error' in input) return input.error
    await this.#flushGoalAccounting()
    const current = this.#store.getGoal(this.#threadId)
    if (this.#goalObservation.kind === 'none') {
      return failure('goal_not_found', 'No Goal was observed for this turn')
    }
    if (!current || current.id !== this.#goalObservation.goalId
      || current.revision !== this.#goalObservation.revision) {
      return failure('stale_goal_revision', 'Current Goal changed after it was observed', { goal: current })
    }
    const intent = Object.freeze({
      goalId: this.#goalObservation.goalId,
      expectedRevision: this.#goalObservation.revision,
      status: input.status,
      ...(input.status === 'complete' ? { completionEvidence: input.evidence } : {}),
    } satisfies GoalTerminalIntent)
    if (this.#goalTerminalIntent !== null
      && canonicalJson(this.#goalTerminalIntent) !== canonicalJson(intent)) {
      return failure(
        'goal_terminal_intent_conflict',
        `Goal terminal intent is already staged as ${this.#goalTerminalIntent.status}`,
      )
    }
    this.#goalTerminalIntent ??= intent
    return success({ goal: current, stagedStatus: input.status, finalTokensUsed: this.#finalTokensUsed() })
  }

  #appendCall(invocation: AgentToolInvocation, sideEffect: string | null): void {
    this.#store.appendProviderEvent({
      turnId: this.#turnId,
      eventId: `baton:tool:${invocation.callId}:call`,
      items: [toolCallItem(invocation, sideEffect)],
    })
    this.#persisted.set(invocation.callId, { invocation, result: null })
    if (sideEffect === 'workspace_mutation' || sideEffect === 'workspace_command' || sideEffect === 'host_mutation') {
      this.#unresolvedMutations.add(invocation.callId)
    }
  }

  #appendResult(invocation: AgentToolInvocation, result: AgentToolResult): void {
    this.#store.appendProviderEvent({
      turnId: this.#turnId,
      eventId: `baton:tool:${invocation.callId}:result`,
      items: [{
        kind: 'tool_result',
        visibility: 'portable',
        nativeId: invocation.providerCallId,
        payload: {
          callId: invocation.callId,
          providerCallId: invocation.providerCallId,
          toolName: invocation.name,
          result,
        },
      }],
    })
  }

  #loadPersistedCalls(): void {
    for (const item of this.#store.listItems(this.#threadId)) {
      if (item.turnId !== this.#turnId) continue
      const callId = string(item.payload.callId)
      if (!callId) continue
      if (item.kind === 'tool_call') {
        const providerCallId = string(item.payload.providerCallId)
        const name = string(item.payload.name)
        const input = object(item.payload.input)
        if (providerCallId && name && input) {
          this.#persisted.set(callId, { invocation: { callId, providerCallId, name, input }, result: null })
          if (item.payload.sideEffect === 'workspace_mutation' || item.payload.sideEffect === 'workspace_command'
            || item.payload.sideEffect === 'host_mutation') {
            this.#unresolvedMutations.add(callId)
          }
        }
      } else if (item.kind === 'tool_result') {
        const existing = this.#persisted.get(callId)
        const result = agentToolResult(item.payload.result)
        if (existing && result) {
          this.#persisted.set(callId, { ...existing, result })
          this.#unresolvedMutations.delete(callId)
        }
      }
    }
  }
}

function toolCallItem(invocation: AgentToolInvocation, sideEffect: string | null): NewCanonicalItem {
  return {
    kind: 'tool_call',
    visibility: 'portable',
    nativeId: invocation.providerCallId,
    payload: {
      callId: invocation.callId,
      providerCallId: invocation.providerCallId,
      name: invocation.name,
      input: invocation.input,
      sideEffect,
    },
  }
}

async function executeWithTimeout(
  runtime: ToolRuntime,
  invocation: AgentToolInvocation,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  settleBeforeReturning: boolean,
): Promise<AgentToolResult> {
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort(parentSignal?.reason)
  parentSignal?.addEventListener('abort', abort, { once: true })
  if (parentSignal?.aborted) abort()
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('tool timeout'))
  }, timeoutMs)
  const execution = runtime.execute(invocation, controller.signal)
  try {
    if (settleBeforeReturning) {
      const result = await execution
      if (timedOut) return failure('tool_timeout', 'Tool exceeded its timeout and was terminated')
      if (parentSignal?.aborted) return failure('tool_aborted', 'Tool execution was cancelled')
      return result
    }
    const interrupted = new Promise<AgentToolResult>((resolve) => {
      const resolveInterrupted = () => resolve(failure(
        timedOut ? 'tool_timeout' : 'tool_aborted',
        timedOut ? 'Tool exceeded its timeout' : 'Tool execution was cancelled',
      ))
      if (controller.signal.aborted) resolveInterrupted()
      else controller.signal.addEventListener('abort', resolveInterrupted, { once: true })
    })
    return await Promise.race([execution, interrupted])
  } finally {
    clearTimeout(timer)
    parentSignal?.removeEventListener('abort', abort)
    void execution.catch(() => undefined)
  }
}

function capResult(result: AgentToolResult, maxBytes: number): AgentToolResult {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= maxBytes) return result
  return failure('tool_output_limit', `Tool result exceeded ${maxBytes} UTF-8 bytes`)
}

function validateCreateGoal(input: JsonObject):
  | { objective: string; tokenBudget?: number }
  | { error: AgentToolResult } {
  if (!onlyKeys(input, ['objective', 'tokenBudget'])) return { error: invalidInput('create_goal received unsupported properties') }
  if (typeof input.objective !== 'string' || input.objective.length < 1 || [...input.objective].length > 4_000) {
    return { error: invalidInput('objective must contain 1..4000 Unicode characters') }
  }
  if (input.tokenBudget !== undefined && (!Number.isSafeInteger(input.tokenBudget) || Number(input.tokenBudget) < 1)) {
    return { error: invalidInput('tokenBudget must be a positive integer') }
  }
  return {
    objective: input.objective,
    ...(input.tokenBudget === undefined ? {} : { tokenBudget: Number(input.tokenBudget) }),
  }
}

function validateUpdateGoal(input: JsonObject):
  | { status: 'complete'; evidence: readonly GoalCompletionEvidence[] }
  | { error: AgentToolResult } {
  if (!onlyKeys(input, ['status', 'evidence'])) {
    return { error: invalidInput('update_goal received unsupported properties') }
  }
  if (input.status !== 'complete') return { error: invalidInput('status must be complete') }
  if (!Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 64) {
    return { error: invalidInput('complete status requires 1..64 evidence entries') }
  }
  const evidence: GoalCompletionEvidence[] = []
  for (const entry of input.evidence) {
    const evidenceObject = object(entry)
    if (!evidenceObject || !onlyKeys(evidenceObject, ['requirement', 'proof'])
      || typeof evidenceObject.requirement !== 'string' || evidenceObject.requirement.trim().length < 1
      || [...evidenceObject.requirement].length > 500
      || typeof evidenceObject.proof !== 'string' || evidenceObject.proof.trim().length < 1
      || [...evidenceObject.proof].length > 1_000) {
      return { error: invalidInput('each completion evidence entry requires bounded requirement and proof strings') }
    }
    evidence.push(Object.freeze({ requirement: evidenceObject.requirement, proof: evidenceObject.proof }))
  }
  return { status: 'complete', evidence: Object.freeze(evidence) }
}

function goalFailure(error: unknown): AgentToolResult {
  if (error instanceof GoalStoreError) return failure(error.code, error.message)
  return failure('goal_store_error', errorMessage(error))
}

function observation(goal: CanonicalGoal): GoalObservation {
  return { kind: 'goal', goalId: goal.id, revision: goal.revision }
}

function remainingTokens(goal: CanonicalGoal | null): number | null {
  return goal?.tokenBudget === null || !goal ? null : Math.max(0, goal.tokenBudget - goal.tokensUsed)
}

function invocationFingerprint(invocation: AgentToolInvocation): string {
  return createHash('sha256').update(canonicalJson({
    providerCallId: invocation.providerCallId,
    name: invocation.name,
    input: invocation.input,
  })).digest('hex')
}

function repetitionFingerprint(invocation: AgentToolInvocation): string {
  return createHash('sha256').update(canonicalJson({
    name: invocation.name,
    input: invocation.input,
  })).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as JsonObject).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function definition(
  name: string,
  description: string,
  properties: JsonObject,
  required: string[] = [],
  schemaExtras: JsonObject = {},
): AgentToolDefinition {
  return {
    name,
    description,
    sideEffect: 'goal',
    inputSchema: { type: 'object', properties, required, additionalProperties: false, ...schemaExtras },
  }
}

function validateLimits(limits: AgentLoopLimits): AgentLoopLimits {
  for (const [name, value] of Object.entries(limits)) {
    if (value === null) continue
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  }
  return Object.freeze({ ...limits })
}

function success(content: JsonObject): AgentToolResult {
  return { success: true, content, error: null }
}

function invalidInput(message: string): AgentToolResult {
  return failure('invalid_tool_input', message)
}

function failure(code: string, message: string, metadata?: JsonObject): AgentToolResult {
  return {
    success: false,
    content: null,
    ...(metadata ? { metadata } : {}),
    error: { code, message, retryable: false },
  }
}

function isEmptyObject(value: JsonObject): boolean { return Object.keys(value).length === 0 }
function onlyKeys(value: JsonObject, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}
function string(value: unknown): string | null { return typeof value === 'string' ? value : null }
function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function missingCwd(): never { throw new Error('ToolCoordinator requires an absolute cwd or workspaceRuntime') }

function agentToolResult(value: unknown): AgentToolResult | null {
  const candidate = object(value)
  if (!candidate || typeof candidate.success !== 'boolean') return null
  if (candidate.success === true && object(candidate.content) && candidate.error === null) {
    let images
    try {
      images = candidate.images === undefined
        ? undefined
        : Array.isArray(candidate.images) ? candidate.images.map(parseImageArtifactRef) : null
    } catch {
      return null
    }
    if (images === null) return null
    return {
      success: true,
      content: candidate.content as JsonObject,
      ...(images ? { images } : {}),
      ...(object(candidate.metadata) ? { metadata: candidate.metadata as JsonObject } : {}),
      error: null,
    }
  }
  const error = object(candidate.error)
  if (candidate.success === false && candidate.content === null && error
    && typeof error.code === 'string' && typeof error.message === 'string'
    && typeof error.retryable === 'boolean') {
    return {
      success: false,
      content: null,
      ...(object(candidate.metadata) ? { metadata: candidate.metadata as JsonObject } : {}),
      error: { code: error.code, message: error.message, retryable: error.retryable },
    }
  }
  return null
}
