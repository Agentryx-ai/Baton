import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  AgentToolDefinition,
  AgentToolInvocation,
  AgentToolResult,
  CanonicalGoal,
  CanonicalItem,
  CanonicalTurn,
  NewCanonicalItem,
} from './domain.ts'
import type {
  CreateGoalInput,
  GoalCasResult,
  UpdateGoalStatusInput,
} from './store.ts'
import {
  GOAL_TOOL_DEFINITIONS,
  ToolCoordinator,
  type ToolCoordinatorStore,
  type ToolRuntime,
} from './tool-coordinator.ts'

const READ: AgentToolDefinition = {
  name: 'read_file', description: 'read', sideEffect: 'read_only', inputSchema: {},
}
const WRITE: AgentToolDefinition = {
  name: 'write_file', description: 'write', sideEffect: 'workspace_mutation', inputSchema: {},
}
const COMMAND: AgentToolDefinition = {
  name: 'run_command', description: 'command', sideEffect: 'workspace_command', inputSchema: {},
}

test('durably appends call before execution and result before returning to running', async () => {
  const trace: string[] = []
  const store = new FakeStore(trace)
  const runtime = new FakeRuntime([READ], async () => {
    trace.push('execute')
    return ok({ text: 'done' })
  })
  const coordinator = makeCoordinator(store, runtime)

  const result = await coordinator.execute(call('call-1', 'read_file', { path: 'README.md' }))

  assert.deepEqual(result, ok({ text: 'done' }))
  assert.deepEqual(trace, ['tool_call', 'waiting_tool', 'execute', 'tool_result', 'running'])
  assert.equal(store.items[0]?.payload.providerCallId, 'provider-call-call-1')
  assert.equal(store.items[1]?.payload.providerCallId, 'provider-call-call-1')
})

test('parallelizes preceding reads while serializing mutation and later reads behind it', async () => {
  const store = new FakeStore()
  const started: string[] = []
  const gates = new Map<string, Deferred<AgentToolResult>>()
  const runtime = new FakeRuntime([READ, WRITE], async (invocation) => {
    started.push(invocation.callId)
    const gate = deferred<AgentToolResult>()
    gates.set(invocation.callId, gate)
    return gate.promise
  })
  const coordinator = makeCoordinator(store, runtime)

  const first = coordinator.execute(call('read-1', 'read_file', { path: 'a' }))
  const second = coordinator.execute(call('read-2', 'read_file', { path: 'b' }))
  const mutation = coordinator.execute(call('write-1', 'write_file', { path: 'c' }))
  const laterRead = coordinator.execute(call('read-3', 'read_file', { path: 'c' }))
  await tick()
  assert.deepEqual(started, ['read-1', 'read-2'])

  gates.get('read-1')?.resolve(ok({}))
  gates.get('read-2')?.resolve(ok({}))
  await tick()
  assert.deepEqual(started, ['read-1', 'read-2', 'write-1'])
  gates.get('write-1')?.resolve(ok({}))
  await tick()
  assert.deepEqual(started, ['read-1', 'read-2', 'write-1', 'read-3'])
  gates.get('read-3')?.resolve(ok({}))
  await Promise.all([first, second, mutation, laterRead])
})

test('records a mutating result before the next mutation begins', async () => {
  const trace: string[] = []
  const store = new FakeStore(trace)
  const firstGate = deferred<AgentToolResult>()
  const runtime = new FakeRuntime([WRITE], async (invocation) => {
    trace.push(`execute:${invocation.callId}`)
    return invocation.callId === 'write-a' ? firstGate.promise : ok({})
  })
  const coordinator = makeCoordinator(store, runtime)
  const first = coordinator.execute(call('write-a', 'write_file', {}))
  const second = coordinator.execute(call('write-b', 'write_file', {}))
  await tick()
  firstGate.resolve(ok({}))
  await Promise.all([first, second])

  const firstResult = trace.indexOf('tool_result')
  const secondExecution = trace.indexOf('execute:write-b')
  assert.ok(firstResult >= 0)
  assert.ok(secondExecution > firstResult)
})

test('coalesces an identical in-flight call ID and rejects conflicting reuse', async () => {
  const store = new FakeStore()
  const gate = deferred<AgentToolResult>()
  let executions = 0
  const coordinator = makeCoordinator(store, new FakeRuntime([READ], async () => {
    executions += 1
    return gate.promise
  }))
  const invocation = call('same', 'read_file', { path: 'a' })
  const first = coordinator.execute(invocation)
  const duplicate = coordinator.execute({ ...invocation })
  const conflict = await coordinator.execute(call('same', 'read_file', { path: 'b' }))
  const foreignProviderId = await coordinator.execute({ ...invocation, providerCallId: 'foreign-provider-call' })

  assert.strictEqual(first, duplicate)
  assert.equal(conflict.success, false)
  assert.equal(conflict.error?.code, 'tool_call_id_conflict')
  assert.equal(foreignProviderId.error?.code, 'tool_call_id_conflict')
  gate.resolve(ok({}))
  await first
  assert.equal(executions, 1)
  assert.equal(store.items.filter((item) => item.kind === 'tool_call').length, 1)
})

test('never replays a durable unresolved call after process loss', async () => {
  const store = new FakeStore()
  store.seed(toolItem('tool_call', {
    callId: 'lost', providerCallId: 'provider-call-lost', name: 'write_file', input: { path: 'x' },
  }))
  let executions = 0
  const coordinator = makeCoordinator(store, new FakeRuntime([WRITE], async () => {
    executions += 1
    return ok({})
  }))

  const result = await coordinator.execute(call('lost', 'write_file', { path: 'x' }))

  assert.equal(result.success, false)
  assert.equal(result.error?.code, 'tool_call_interrupted')
  assert.equal(executions, 0)
  assert.equal(store.items.filter((item) => item.kind === 'tool_result').length, 0)
})

test('a write-before-execute storage failure latches the turn fatal before mutation', async () => {
  let executed = false
  const runtime = new FakeRuntime([WRITE], async () => {
    executed = true
    return ok({ changed: true })
  })
  const store = new FakeStore()
  store.appendError = new Error('durable call append failed')
  const coordinator = makeCoordinator(store, runtime)

  await assert.rejects(coordinator.execute(call('append-failure', 'write_file', {})), /append failed/)
  await assert.rejects(coordinator.settle(), /append failed/)
  assert.equal(executed, false)
})

test('a mutating call remains unknown until its result is durably appended', async () => {
  const store = new FakeStore()
  const coordinator = makeCoordinator(store, new FakeRuntime([WRITE], async () => ok({ changed: true })))
  store.resultAppendError = new Error('durable result append failed')

  await assert.rejects(coordinator.execute(call('result-failure', 'write_file', {})), /result append failed/)
  await assert.rejects(coordinator.settle(), /result append failed/)
  assert.equal(coordinator.hasUnknownMutationOutcome, true)
  assert.deepEqual(store.items.map((item) => item.kind), ['tool_call'])
})

test('enforces total, repetition, and output limits before returning canonical results', async () => {
  const total = makeCoordinator(new FakeStore(), new FakeRuntime([READ]), {
    maxToolCalls: 1, maxIdenticalToolCalls: 3,
  })
  assert.equal((await total.execute(call('one', 'read_file', { path: 'a' }))).success, true)
  assert.equal((await total.execute(call('two', 'read_file', { path: 'b' }))).error?.code, 'tool_call_limit')
  assert.deepEqual(total.terminalFailure, {
    code: 'tool_call_limit', message: 'Turn exceeded 1 tool calls',
  })
  assert.equal(
    (await total.execute(call('three', 'read_file', { path: 'b' }))).error?.code,
    'tool_call_limit',
    'the first terminal limit must remain authoritative',
  )

  const repetition = makeCoordinator(new FakeStore(), new FakeRuntime([READ]), {
    maxToolCalls: 10, maxIdenticalToolCalls: 1,
  })
  assert.equal((await repetition.execute(call('a', 'read_file', { path: 'a' }))).success, true)
  assert.equal((await repetition.execute(call('b', 'read_file', { path: 'a' }))).error?.code, 'tool_repetition_limit')
  assert.deepEqual(repetition.terminalFailure, {
    code: 'tool_repetition_limit', message: 'Turn exceeded 1 identical tool calls',
  })

  const output = makeCoordinator(new FakeStore(), new FakeRuntime([READ], async () => ok({ text: 'x'.repeat(500) })), {
    toolOutputBytes: 100,
  })
  assert.equal((await output.execute(call('large', 'read_file', {}))).error?.code, 'tool_output_limit')
  assert.equal(output.terminalFailure, null)
})

test('default policy does not impose Baton-only total or identical tool-call ceilings', async () => {
  const coordinator = makeCoordinator(new FakeStore(), new FakeRuntime([READ]))
  for (let index = 0; index < 129; index += 1) {
    const result = await coordinator.execute(call(`default-${index}`, 'read_file', { path: 'same' }))
    assert.equal(result.success, true)
  }
  assert.equal(coordinator.terminalFailure, null)
})

test('mutation timeout waits for execution settlement before recording the failure', async () => {
  const store = new FakeStore()
  const gate = deferred<AgentToolResult>()
  const coordinator = makeCoordinator(store, new FakeRuntime([WRITE], async () => gate.promise), {
    toolTimeoutMs: 5,
  })
  let settled = false
  const resultPromise = coordinator.execute(call('slow-write', 'write_file', {})).then((result) => {
    settled = true
    return result
  })
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(settled, false)
  assert.equal(store.items.some((item) => item.kind === 'tool_result'), false)

  gate.resolve(ok({ changed: true }))
  const result = await resultPromise
  assert.equal(result.error?.code, 'tool_timeout')
  assert.equal(store.items.at(-1)?.kind, 'tool_result')
})

test('settle waits for every accepted durable tool call', async () => {
  const gate = deferred<AgentToolResult>()
  const runtime = new FakeRuntime([WRITE], async () => gate.promise)
  const store = new FakeStore()
  const coordinator = makeCoordinator(store, runtime)
  const pending = coordinator.execute(call('settle-mutation', 'write_file', {}))
  let settled = false
  const settlement = coordinator.settle().then(() => { settled = true })

  await Promise.resolve()
  assert.equal(settled, false)
  gate.resolve(ok({ changed: true }))
  await pending
  await settlement
  assert.equal(settled, true)
  assert.equal(store.items.at(-1)?.kind, 'tool_result')
})

test('workspace commands are absent by default and require termination-safe opt-in', () => {
  const runtime = new FakeRuntime([READ, COMMAND])
  const coordinator = makeCoordinator(new FakeStore(), runtime)
  assert.equal(coordinator.definitions.some((tool) => tool.name === 'run_command'), false)
  assert.throws(
    () => makeCoordinator(new FakeStore(), runtime, {}, { allowWorkspaceCommands: true }),
    /proves process termination/,
  )
  const safe = new FakeRuntime([COMMAND])
  safe.abortWaitsForTermination = true
  const enabled = makeCoordinator(new FakeStore(), safe, {}, { allowWorkspaceCommands: true })
  assert.equal(enabled.definitions.some((tool) => tool.name === 'run_command'), true)
})

test('Goal tools have exact schemas, refresh observation, and use revision CAS', async () => {
  assert.deepEqual(GOAL_TOOL_DEFINITIONS.map((tool) => tool.name), [
    'get_goal', 'create_goal', 'propose_goal_completion', 'update_goal',
  ])
  assert.equal(GOAL_TOOL_DEFINITIONS.every((tool) => tool.inputSchema.additionalProperties === false), true)
  const updateGoalSchema = GOAL_TOOL_DEFINITIONS.find((tool) => tool.name === 'update_goal')?.inputSchema
  assert.deepEqual(updateGoalSchema?.required, ['status'])
  assert.equal('allOf' in (updateGoalSchema ?? {}), false)
  const store = new FakeStore()
  const current = goal({ revision: 3, tokenBudget: 100, tokensUsed: 40, noProgressCount: 2 })
  store.goal = current
  let flushed = 0
  const coordinator = makeCoordinator(store, new FakeRuntime([]), {}, {
    initialGoalObservation: { kind: 'goal', goalId: current.id, revision: 2 },
    flushGoalAccounting: () => { flushed += 1 },
    finalTokensUsed: () => 47,
  })

  const stale = await coordinator.execute(call('stale', 'update_goal', {
    status: 'complete', evidence: [{ requirement: 'old', proof: 'stale' }],
  }))
  assert.equal(stale.error?.code, 'stale_goal_revision')
  const read = await coordinator.execute(call('read-goal', 'get_goal', {}))
  assert.deepEqual(read.success && read.content.remainingTokens, 60)
  const complete = await coordinator.execute(call('complete', 'update_goal', {
    status: 'complete',
    evidence: [{ requirement: 'ship it', proof: 'tests passed' }],
  }))
  assert.equal(complete.success, true)
  assert.equal(complete.success && complete.content.finalTokensUsed, 47)
  assert.equal(store.lastStatusUpdate, null)
  assert.deepEqual(coordinator.goalCompletionProposalIntent, {
    goalId: current.id,
    expectedRevision: 3,
    summary: 'Legacy update_goal completion proposal',
    requirements: [{
      id: 'requirement-1',
      requirement: 'ship it',
      evidence: [{ kind: 'current_turn', reference: null, claim: 'tests passed' }],
    }],
    compatibilityAlias: true,
  })
  const conflict = await coordinator.execute(call('conflict', 'update_goal', {
    status: 'complete', evidence: [{ requirement: 'ship it', proof: 'different proof' }],
  }))
  assert.equal(conflict.error?.code, 'goal_completion_proposal_conflict')
  assert.equal(flushed, 3)

  const compatibilityStore = new FakeStore()
  compatibilityStore.goal = current
  const compatibilityCoordinator = makeCoordinator(compatibilityStore, new FakeRuntime([READ]), {}, {
    initialGoalObservation: { kind: 'goal', goalId: current.id, revision: current.revision },
  })
  await compatibilityCoordinator.execute(call('proof-read', 'read_file', { path: 'result.txt' }))
  const statusOnly = await compatibilityCoordinator.execute(call('status-only', 'update_goal', { status: 'complete' }))
  assert.equal(statusOnly.success, true)
  assert.deepEqual(compatibilityCoordinator.goalCompletionProposalIntent?.requirements, [{
    id: 'requirement-1',
    requirement: current.objective,
    evidence: [
      {
        kind: 'tool_result', reference: 'proof-read',
        claim: 'Successful read_file result from the terminal turn',
      },
      {
        kind: 'current_turn', reference: null,
        claim: 'The terminal turn contains the claimed completed deliverable',
      },
    ],
  }])
})

test('create_goal uses captured no_goal observation and rejects unknown input fields', async () => {
  const store = new FakeStore()
  const denied = makeCoordinator(store, new FakeRuntime([]), {}, {
    initialGoalObservation: { kind: 'none' },
  })
  assert.equal(denied.definitions.some((tool) => tool.name === 'create_goal'), false)
  assert.equal(
    (await denied.execute(call('denied', 'create_goal', { objective: 'ship it' }))).error?.code,
    'tool_not_found',
  )
  const coordinator = makeCoordinator(store, new FakeRuntime([]), {}, {
    initialGoalObservation: { kind: 'none' }, goalCreationRequested: true,
  })
  assert.equal(coordinator.definitions.some((tool) => tool.name === 'create_goal'), true)
  const invalid = await coordinator.execute(call('invalid', 'create_goal', { objective: 'x', surprise: true }))
  assert.equal(invalid.error?.code, 'invalid_tool_input')

  const created = await coordinator.execute(call('create', 'create_goal', { objective: 'ship it', tokenBudget: 10 }))
  assert.equal(created.success, true)
  assert.deepEqual(store.lastCreate?.expected, { kind: 'none' })
  assert.equal(store.lastCreate?.provider, 'codex')
  assert.equal(store.lastCreate?.model, 'test-model')
})

class FakeRuntime implements ToolRuntime {
  abortWaitsForTermination?: boolean
  readonly definitions: readonly AgentToolDefinition[]
  readonly handler: (invocation: AgentToolInvocation, signal?: AbortSignal) => Promise<AgentToolResult>
  constructor(
    definitions: readonly AgentToolDefinition[],
    handler: (invocation: AgentToolInvocation, signal?: AbortSignal) => Promise<AgentToolResult>
      = async () => ok({}),
  ) {
    this.definitions = definitions
    this.handler = handler
  }
  execute(invocation: AgentToolInvocation, signal?: AbortSignal): Promise<AgentToolResult> {
    return this.handler(invocation, signal)
  }
}

class FakeStore implements ToolCoordinatorStore {
  readonly items: CanonicalItem[] = []
  goal: CanonicalGoal | null = null
  lastCreate: CreateGoalInput | null = null
  lastStatusUpdate: UpdateGoalStatusInput | null = null
  appendError: Error | null = null
  resultAppendError: Error | null = null
  readonly trace: string[]
  #sequence = 0
  constructor(trace: string[] = []) { this.trace = trace }

  appendProviderEvent(input: { turnId: string; eventId: string; items: NewCanonicalItem[] }): CanonicalItem[] {
    if (this.appendError) throw this.appendError
    if (this.resultAppendError && input.items.some((item) => item.kind === 'tool_result')) {
      throw this.resultAppendError
    }
    const appended = input.items.map((item) => {
      this.trace.push(item.kind)
      return this.seed(item)
    })
    return appended
  }
  setTurnActivity(_turnId: string, status: 'running' | 'waiting_tool'): CanonicalTurn {
    this.trace.push(status)
    return {} as CanonicalTurn
  }
  listItems(): CanonicalItem[] { return [...this.items] }
  getGoal(): CanonicalGoal | null { return this.goal }
  createGoal(input: CreateGoalInput): CanonicalGoal {
    this.lastCreate = input
    this.goal = goal({
      id: 'created-goal', objective: input.objective, tokenBudget: input.tokenBudget ?? null,
      provider: input.provider, model: input.model, effort: input.effort ?? null,
    })
    return this.goal
  }
  updateGoalStatus(input: UpdateGoalStatusInput): GoalCasResult {
    this.lastStatusUpdate = input
    if (!this.goal || this.goal.id !== input.goalId || this.goal.revision !== input.expectedRevision) {
      return { status: 'stale', goal: this.goal }
    }
    this.goal = { ...this.goal, status: input.status, revision: this.goal.revision + 1 }
    return { status: 'applied', goal: this.goal }
  }
  seed(item: NewCanonicalItem): CanonicalItem {
    const canonical: CanonicalItem = {
      id: `item-${++this.#sequence}`,
      sessionId: 'session', threadId: 'thread', turnId: 'turn', sequence: this.#sequence,
      kind: item.kind, visibility: item.visibility ?? 'portable', payload: item.payload,
      provider: item.provider ?? 'codex', nativeId: item.nativeId ?? null, createdAt: new Date(0).toISOString(),
    }
    this.items.push(canonical)
    return canonical
  }
}

function makeCoordinator(
  store: FakeStore,
  runtime: ToolRuntime,
  limits: Record<string, number> = {},
  overrides: Partial<ConstructorParameters<typeof ToolCoordinator>[0]> = {},
): ToolCoordinator {
  return new ToolCoordinator({
    store,
    turnId: 'turn',
    threadId: 'thread',
    provider: 'codex',
    model: 'test-model',
    workspaceRuntime: runtime,
    initialGoalObservation: { kind: 'none' },
    limits,
    ...overrides,
  })
}

function call(callId: string, name: string, input: Record<string, unknown>): AgentToolInvocation {
  return { callId, providerCallId: `provider-call-${callId}`, name, input }
}

function toolItem(kind: 'tool_call' | 'tool_result', payload: Record<string, unknown>): NewCanonicalItem {
  return { kind, payload, visibility: 'portable' }
}

function ok(content: Record<string, unknown>): AgentToolResult {
  return { success: true, content, error: null }
}

function goal(overrides: Partial<CanonicalGoal> = {}): CanonicalGoal {
  return {
    id: 'goal', threadId: 'thread', objective: 'objective', status: 'active', statusReason: null,
    revision: 1, provider: 'codex', model: 'test-model', effort: null, tokenBudget: null,
    tokensUsed: 0, timeUsedSeconds: 0, maxAutomaticTurns: 24, automaticTurnsUsed: 0,
    maxActiveSeconds: 7_200, noProgressCount: 0, lastProgressDigest: null,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(), completedAt: null,
    verificationProposalId: null, latestCompletionReceiptId: null, latestStopReceiptId: null,
    ...overrides,
  }
}

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function tick(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)) }
