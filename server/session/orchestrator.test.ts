import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AdapterRegistry } from './adapter-registry.ts'
import { WorkspaceRootError } from './workspace-root.ts'
import type {
  NativeProviderEvent,
  NativeTurnRequest,
  ProviderTurnExecution,
  ProviderExecutionContext,
  SessionProviderAdapter,
} from './adapter.ts'
import type { NewCanonicalItem, ThreadSnapshot } from './domain.ts'
import { ConversationEventHub } from './event-hub.ts'
import { chargeableGoalTokens, TurnOrchestrator } from './orchestrator.ts'
import { SqliteSessionStore } from './sqlite-store.ts'

function safeAdapter(
  snapshots: ThreadSnapshot[],
  nativeChildExecution: 'disabled' | 'exposed' = 'disabled',
): SessionProviderAdapter {
  return {
    provider: 'codex',
    async initialize() {
      return {
        adapterVersion: 'test/1',
        capabilities: {
          roles: ['user', 'assistant'],
          contentTypes: ['text'],
          toolCalling: false,
          parallelTools: false,
          contextWindow: 10_000,
          continuation: 'stateless',
          reasoningState: 'portable-summary',
          taskMetadata: true,
          nativeChildExecution,
        },
        exposedNativeAgentTools: nativeChildExecution === 'exposed' ? ['spawn_agent'] : [],
        enforcementEvidence: { test: true },
      }
    },
    validate(_request, snapshot) { snapshots.push(snapshot) },
    materialize(): NativeTurnRequest { return { body: {} } },
    async execute(): Promise<ProviderTurnExecution> {
      const event: NativeProviderEvent = {
        eventId: 'completed-message-1',
        type: 'item/completed',
        payload: { text: 'answer' },
        durability: 'durable',
      }
      return {
        events: (async function* () { yield event })(),
        terminal: Promise.resolve({ status: 'completed', usage: { outputTokens: 1 } }),
        async cancel() {},
        async dispose() {},
      }
    },
    normalize(event): NewCanonicalItem[] {
      return [{ kind: 'assistant_message', payload: event.payload as Record<string, unknown> }]
    },
    extractBinding() { return null },
    async shutdown() {},
  }
}

function toolCallingAdapter(
  invocation: { name: string; input: Record<string, unknown> },
  afterTool: 'completed' | 'failed' = 'completed',
): SessionProviderAdapter {
  const adapter = safeAdapter([])
  adapter.execute = async (_request, context: ProviderExecutionContext): Promise<ProviderTurnExecution> => {
    const terminal = (async () => {
      const result = await context.executeTool({
        callId: `turn-call:${invocation.name}`,
        providerCallId: `provider-call:${invocation.name}`,
        name: invocation.name,
        input: invocation.input,
      })
      return result.success && afterTool === 'completed'
        ? { status: 'completed' as const, usage: { inputTokens: 5, outputTokens: 3 } }
        : result.success
          ? { status: 'failed' as const, error: { code: 'provider_failure', message: 'provider failed after tool' } }
        : { status: 'failed' as const, error: result.error ?? undefined }
    })()
    return {
      events: (async function* () {
        await terminal
        yield {
          eventId: `completed:${invocation.name}`,
          type: 'item/completed',
          payload: { text: 'done' },
          durability: 'durable',
        }
      })(),
      terminal,
      async cancel() {},
      async dispose() {},
    }
  }
  return adapter
}

function toolLimitIgnoringAdapter(): SessionProviderAdapter {
  const adapter = safeAdapter([])
  adapter.execute = async (_request, context): Promise<ProviderTurnExecution> => {
    const terminal = (async () => {
      for (let index = 0; index < 129; index += 1) {
        await context.executeTool({
          callId: `limit-call-${index}`,
          providerCallId: `limit-provider-call-${index}`,
          name: `missing_tool_${index}`,
          input: {},
        })
      }
      return { status: 'completed' as const, usage: { outputTokens: 1 } }
    })()
    return {
      events: emptyEvents(terminal),
      terminal,
      async cancel() {},
      async dispose() {},
    }
  }
  return adapter
}

function interruptedAdapter(): SessionProviderAdapter {
  const adapter = safeAdapter([])
  adapter.execute = async (): Promise<ProviderTurnExecution> => ({
    events: emptyEvents(),
    terminal: Promise.resolve({ status: 'interrupted' }),
    async cancel() {},
    async dispose() {},
  })
  return adapter
}

function usageLimitedAdapter(): SessionProviderAdapter {
  const adapter = safeAdapter([])
  adapter.execute = async (): Promise<ProviderTurnExecution> => ({
    events: emptyEvents(),
    terminal: Promise.resolve({
      status: 'failed',
      error: { code: 'provider_usage_limit', message: 'quota exhausted' },
    }),
    async cancel() {},
    async dispose() {},
  })
  return adapter
}

function silentUntilCancelledAdapter(): SessionProviderAdapter {
  const adapter = safeAdapter([])
  adapter.execute = async (): Promise<ProviderTurnExecution> => {
    let resolveTerminal!: (result: { status: 'cancelled' }) => void
    const terminal = new Promise<{ status: 'cancelled' }>((resolve) => { resolveTerminal = resolve })
    return {
      events: emptyEvents(terminal),
      terminal,
      async cancel() { resolveTerminal({ status: 'cancelled' }) },
      async dispose() {},
    }
  }
  return adapter
}

function cancellableAdapter(): SessionProviderAdapter {
  const adapter = safeAdapter([])
  adapter.execute = async (): Promise<ProviderTurnExecution> => {
    let resolveTerminal!: (result: { status: 'cancelled' }) => void
    const terminal = new Promise<{ status: 'cancelled' }>((resolve) => { resolveTerminal = resolve })
    return {
      events: emptyEvents(terminal),
      terminal,
      async cancel() { resolveTerminal({ status: 'cancelled' }) },
      async dispose() {},
    }
  }
  return adapter
}

function cancellingWithPendingMutationAdapter(): SessionProviderAdapter {
  const adapter = safeAdapter([])
  adapter.execute = async (_request, context): Promise<ProviderTurnExecution> => {
    void context.executeTool({
      callId: 'pending-mutation',
      providerCallId: 'provider-pending-mutation',
      name: 'write_file',
      input: { path: 'settled-before-terminal.txt', content: 'durable', expectedSha256: null },
    })
    return {
      events: emptyEvents(),
      terminal: Promise.resolve({ status: 'cancelled' }),
      async cancel() {},
      async dispose() {},
    }
  }
  return adapter
}

function emptyEvents(after: Promise<unknown> = Promise.resolve()): AsyncIterable<NativeProviderEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<NativeProviderEvent> {
      return {
        async next() {
          await after
          return { done: true, value: undefined }
        },
      }
    },
  }
}

async function waitForTerminal(store: SqliteSessionStore, turnId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = store.getTurn(turnId)?.status
    if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted') return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`turn did not finish: ${turnId}`)
}

test('Goal token accounting excludes cached reads without subtracting Claude uncached input', () => {
  assert.equal(chargeableGoalTokens({ inputTokens: 100, cachedInputTokens: 60, outputTokens: 10 }), 50)
  assert.equal(chargeableGoalTokens({
    input_tokens: 40,
    cache_creation_input_tokens: 5,
    cache_read_input_tokens: 60,
    output_tokens: 10,
  }), 55)
})

test('TurnOrchestrator durably executes one canonical turn and deduplicates retries', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-orchestrator-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  const snapshots: ThreadSnapshot[] = []
  registry.register(safeAdapter(snapshots))
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })

  const session = orchestrator.createSession({ title: 'Canonical' })
  const request = {
    threadId: session.activeThreadId,
    provider: 'codex' as const,
    model: 'gpt-test',
    clientRequestId: 'request-1',
    expectedRevision: 0,
    input: [{ kind: 'user_message' as const, payload: { text: 'question' } }],
  }
  const started = await orchestrator.startTurn(request)
  await waitForTerminal(store, started.turn.id)

  const snapshot = orchestrator.getSnapshot(session.activeThreadId)
  assert.deepEqual(snapshot?.items.map((item) => item.kind), ['user_message', 'assistant_message'])
  assert.equal(snapshot?.turns[0]?.status, 'completed')
  assert.equal(snapshots[0]?.items.length, 0, 'current input must not be duplicated into provider history')

  const duplicate = await orchestrator.startTurn(request)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.turn.id, started.turn.id)
  assert.equal(orchestrator.getSnapshot(session.activeThreadId)?.turns.length, 1)
})

test('TurnOrchestrator rejects an adapter that exposes native child execution before persistence', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-orchestrator-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  registry.register(safeAdapter([], 'exposed'))
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })

  const session = orchestrator.createSession({})
  await assert.rejects(orchestrator.startTurn({
    threadId: session.activeThreadId,
    provider: 'codex',
    model: 'gpt-test',
    clientRequestId: 'unsafe',
    expectedRevision: 0,
    input: [{ kind: 'user_message', payload: { text: 'hello' } }],
  }), /native child execution/)
  assert.equal(orchestrator.getSnapshot(session.activeThreadId)?.turns.length, 0)
})

test('TurnOrchestrator connects provider calls to durable workspace tools', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-orchestrator-tools-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  registry.register(toolCallingAdapter({
    name: 'write_file',
    input: { path: 'result.txt', content: 'written through coordinator', expectedSha256: null },
  }))
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = orchestrator.createSession({ cwd: directory })
  const started = await orchestrator.startTurn({
    threadId: session.activeThreadId,
    provider: 'codex',
    model: 'gpt-test',
    clientRequestId: 'tool-turn',
    expectedRevision: 0,
    input: [{ kind: 'user_message', payload: { text: 'write the file' } }],
  })
  await waitForTerminal(store, started.turn.id)

  assert.equal(readFileSync(join(directory, 'result.txt'), 'utf8'), 'written through coordinator')
  assert.deepEqual(
    store.listItems(session.activeThreadId).map((item) => item.kind),
    ['user_message', 'tool_call', 'tool_result', 'assistant_message'],
  )
})

test('workspace replacement fails before a turn or tool call is persisted', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-orchestrator-workspace-drift-'))
  const workspace = join(directory, 'workspace')
  const moved = join(directory, 'workspace-moved')
  const replacement = join(directory, 'replacement')
  mkdirSync(workspace)
  mkdirSync(replacement)
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  registry.register(toolCallingAdapter({
    name: 'write_file',
    input: { path: 'must-not-exist.txt', content: 'unsafe', expectedSha256: null },
  }))
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = orchestrator.createSession({ cwd: workspace })
  renameSync(workspace, moved)
  symlinkSync(replacement, workspace, process.platform === 'win32' ? 'junction' : 'dir')

  await assert.rejects(orchestrator.startTurn({
    threadId: session.activeThreadId,
    provider: 'codex',
    model: 'gpt-test',
    clientRequestId: 'workspace-drift',
    expectedRevision: 0,
    input: [{ kind: 'user_message', payload: { text: 'write a file' } }],
  }), (error: unknown) => error instanceof WorkspaceRootError && error.code === 'workspace_disconnected')
  assert.deepEqual(store.getSnapshot(session.activeThreadId)?.turns, [])
  assert.equal(existsSync(join(replacement, 'must-not-exist.txt')), false)
  assert.equal(store.listItems(session.activeThreadId).length, 0)
})

test('a cancelled provider turn waits for an accepted mutation to settle durably', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-orchestrator-cancel-mutation-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  registry.register(cancellingWithPendingMutationAdapter())
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = orchestrator.createSession({ cwd: directory })
  const started = await orchestrator.startTurn({
    threadId: session.activeThreadId,
    provider: 'codex',
    model: 'gpt-test',
    clientRequestId: 'cancel-with-mutation',
    expectedRevision: 0,
    input: [{ kind: 'user_message', payload: { text: 'mutate then cancel' } }],
  })
  await waitForTerminal(store, started.turn.id)

  assert.equal(store.getTurn(started.turn.id)?.status, 'cancelled')
  assert.equal(readFileSync(join(directory, 'settled-before-terminal.txt'), 'utf8'), 'durable')
  assert.deepEqual(store.listItems(session.activeThreadId).map((item) => item.kind), [
    'user_message', 'tool_call', 'tool_result',
  ])
})

test('a missing durable mutation result overrides cancellation and remains reconcilable', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-orchestrator-unknown-mutation-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const appendProviderEvent = store.appendProviderEvent.bind(store)
  store.appendProviderEvent = (input) => {
    if (input.items.some((item) => item.kind === 'tool_result')) {
      throw new Error('simulated result durability failure')
    }
    return appendProviderEvent(input)
  }
  const registry = new AdapterRegistry()
  registry.register(cancellingWithPendingMutationAdapter())
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = orchestrator.createSession({ cwd: directory })
  const goal = await orchestrator.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'preserve unknown mutation precedence',
    provider: 'codex',
    model: 'gpt-test',
    maxActiveSeconds: 1,
  })
  const started = await orchestrator.startTurn({
    threadId: session.activeThreadId,
    provider: 'codex',
    model: 'gpt-test',
    clientRequestId: 'unknown-mutation-result',
    expectedRevision: store.getThread(session.activeThreadId)?.revision ?? 0,
    input: [{ kind: 'user_message', payload: { text: 'mutate then cancel' } }],
  })
  await waitForTerminal(store, started.turn.id)

  assert.equal(readFileSync(join(directory, 'settled-before-terminal.txt'), 'utf8'), 'durable')
  assert.equal(store.getTurn(started.turn.id)?.status, 'interrupted')
  assert.equal(store.getTurn(started.turn.id)?.error?.code, 'unknown_mutation_outcome')
  assert.equal(store.getGoalById(goal.id)?.status, 'blocked')
  assert.equal(store.getGoalById(goal.id)?.statusReason?.code, 'unknown_mutation_outcome')
  assert.deepEqual(store.listItems(session.activeThreadId).map((item) => item.kind), [
    'user_message', 'tool_call',
  ])
  assert.equal(store.reconcileTool({
    turnId: started.turn.id,
    callId: 'pending-mutation',
    resolution: 'succeeded',
  }).item.kind, 'tool_result')
})

test('a session without a verified cwd receives no workspace mutation tools', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-orchestrator-no-workspace-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  registry.register(toolCallingAdapter({
    name: 'write_file',
    input: { path: 'must-not-exist.txt', content: 'unsafe default', expectedSha256: null },
  }))
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = orchestrator.createSession({})
  const started = await orchestrator.startTurn({
    threadId: session.activeThreadId,
    provider: 'codex',
    model: 'gpt-test',
    clientRequestId: 'no-implicit-workspace',
    expectedRevision: 0,
    input: [{ kind: 'user_message', payload: { text: 'write a file' } }],
  })
  await waitForTerminal(store, started.turn.id)

  assert.equal(store.getTurn(started.turn.id)?.status, 'failed')
  const toolResult = store.listItems(session.activeThreadId).find((item) => item.kind === 'tool_result')
  assert.equal((toolResult?.payload.result as { error?: { code?: string } } | undefined)?.error?.code, 'tool_not_found')
})

test('an active Goal launches a continuation and can complete through the provider-neutral Goal tool', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-orchestrator-goal-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  registry.register(toolCallingAdapter({
    name: 'update_goal',
    input: { status: 'complete', evidence: [{ requirement: 'finish', proof: 'verified provider result' }] },
  }))
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = orchestrator.createSession({ cwd: directory })
  await orchestrator.startGoalRuntime()
  const goal = await orchestrator.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'finish through a continuation',
    provider: 'codex',
    model: 'gpt-test',
  })

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (store.getGoalById(goal.id)?.status === 'complete') break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(store.getGoalById(goal.id)?.status, 'complete')
  assert.equal(store.getSnapshot(session.activeThreadId)?.turns.length, 1)
  assert.equal(store.listItems(session.activeThreadId).some((item) => item.kind === 'tool_result'), true)
})

test('a staged Goal completion is discarded when the provider later fails', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-orchestrator-goal-stage-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  registry.register(toolCallingAdapter({
    name: 'update_goal',
    input: { status: 'complete', evidence: [{ requirement: 'finish', proof: 'provider later fails' }] },
  }, 'failed'))
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = orchestrator.createSession({ cwd: directory })
  await orchestrator.startGoalRuntime()
  const goal = await orchestrator.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'do not complete after a provider failure',
    provider: 'codex',
    model: 'gpt-test',
  })

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (store.getGoalById(goal.id)?.status !== 'active') break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(store.getGoalById(goal.id)?.status, 'blocked')
  assert.equal(store.getGoalById(goal.id)?.statusReason?.code, 'provider_failure')
})

test('replacing an active Goal flushes and interrupts the old revision before the new Goal waits', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-orchestrator-goal-replace-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  registry.register(cancellableAdapter())
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = orchestrator.createSession({})
  const first = await orchestrator.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'old objective',
    provider: 'codex',
    model: 'gpt-test',
  })
  const started = await orchestrator.startTurn({
    threadId: session.activeThreadId,
    provider: 'codex',
    model: 'gpt-test',
    clientRequestId: 'old-goal-turn',
    expectedRevision: store.getThread(session.activeThreadId)?.revision ?? -1,
    input: [{ kind: 'user_message', payload: { text: 'start old work' } }],
  })
  const replacement = await orchestrator.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'goal', goalId: first.id, revision: first.revision },
    objective: 'new objective',
    provider: 'codex',
    model: 'gpt-test',
    replaceExisting: true,
  })
  await waitForTerminal(store, started.turn.id)

  assert.notEqual(replacement.id, first.id)
  assert.equal(store.getGoal(session.activeThreadId)?.id, replacement.id)
  assert.equal(store.getGoal(session.activeThreadId)?.status, 'active')
  assert.equal(store.getThread(session.activeThreadId)?.status, 'idle')
  assert.equal(store.getTurn(started.turn.id)?.status, 'cancelled')
})

test('a provider cannot turn the host tool-call limit into a successful Goal turn', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-orchestrator-tool-limit-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  registry.register(toolLimitIgnoringAdapter())
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = orchestrator.createSession({})
  await orchestrator.startGoalRuntime()
  const goal = await orchestrator.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'respect the host tool boundary',
    provider: 'codex',
    model: 'gpt-test',
  })

  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (store.getGoalById(goal.id)?.status === 'budget_limited') break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const turn = store.getSnapshot(session.activeThreadId)?.turns[0]
  assert.equal(turn?.status, 'failed')
  assert.equal(turn?.error?.code, 'tool_call_limit')
  assert.equal(store.getGoalById(goal.id)?.status, 'budget_limited')
  assert.equal(store.getGoalById(goal.id)?.statusReason?.code, 'tool_call_limit')
})

test('a Goal that reaches its token budget during a turn stops as budget_limited', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-orchestrator-goal-budget-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  registry.register(safeAdapter([]))
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = orchestrator.createSession({ cwd: directory })
  await orchestrator.startGoalRuntime()
  const goal = await orchestrator.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'stop at the configured token boundary',
    provider: 'codex',
    model: 'gpt-test',
    tokenBudget: 1,
  })

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (store.getGoalById(goal.id)?.status === 'budget_limited') break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(store.getGoalById(goal.id)?.status, 'budget_limited')
  assert.equal(store.getGoalById(goal.id)?.statusReason?.code, 'goal_token_limit')
  assert.equal(store.getSnapshot(session.activeThreadId)?.turns.length, 1)
})

test('a silent provider is cancelled at the Goal active-time deadline', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-orchestrator-goal-deadline-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  registry.register(silentUntilCancelledAdapter())
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = orchestrator.createSession({})
  const goal = await orchestrator.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'stop a silent provider at the active-time boundary',
    provider: 'codex',
    model: 'gpt-test',
    maxActiveSeconds: 1,
  })
  const started = await orchestrator.startTurn({
    threadId: session.activeThreadId,
    provider: 'codex',
    model: 'gpt-test',
    clientRequestId: 'silent-goal-deadline',
    expectedRevision: store.getThread(session.activeThreadId)?.revision ?? 0,
    input: [{ kind: 'user_message', payload: { text: 'finish within the Goal budget' } }],
  })
  await waitForTerminal(store, started.turn.id)

  assert.equal(store.getTurn(started.turn.id)?.status, 'failed')
  assert.equal(store.getTurn(started.turn.id)?.error?.code, 'goal_time_limit')
  assert.equal(store.getGoalById(goal.id)?.status, 'budget_limited')
  assert.equal(store.getGoalById(goal.id)?.statusReason?.code, 'goal_time_limit')
})

test('a canonical provider usage limit stops an active Goal as usage_limited', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-orchestrator-usage-limit-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  registry.register(usageLimitedAdapter())
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = orchestrator.createSession({})
  const goal = await orchestrator.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'stop on a hard account quota',
    provider: 'codex',
    model: 'gpt-test',
  })
  const started = await orchestrator.startTurn({
    threadId: session.activeThreadId,
    provider: 'codex',
    model: 'gpt-test',
    clientRequestId: 'provider-usage-limit',
    expectedRevision: store.getThread(session.activeThreadId)?.revision ?? 0,
    input: [{ kind: 'user_message', payload: { text: 'continue' } }],
  })
  await waitForTerminal(store, started.turn.id)

  assert.equal(store.getGoalById(goal.id)?.status, 'usage_limited')
  assert.equal(store.getGoalById(goal.id)?.statusReason?.code, 'provider_usage_limit')
})

test('an interrupted provider turn blocks its Goal instead of auto-restarting', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-orchestrator-interrupted-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  registry.register(interruptedAdapter())
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = orchestrator.createSession({})
  await orchestrator.startGoalRuntime()
  const goal = await orchestrator.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'fail closed on runtime interruption',
    provider: 'codex',
    model: 'gpt-test',
  })

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (store.getGoalById(goal.id)?.status === 'blocked') break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(store.getGoalById(goal.id)?.statusReason?.code, 'runtime_interrupted')
  assert.equal(store.getSnapshot(session.activeThreadId)?.turns.length, 1)
})

test('a Goal with no canonical progress stops after exactly three automatic turns', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-orchestrator-no-progress-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  registry.register(toolCallingAdapter({ name: 'get_goal', input: {} }))
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = orchestrator.createSession({ cwd: directory })
  await orchestrator.startGoalRuntime()
  const goal = await orchestrator.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'stop if only Goal introspection occurs',
    provider: 'codex',
    model: 'gpt-test',
  })

  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (store.getGoalById(goal.id)?.status === 'blocked') break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const blocked = store.getGoalById(goal.id)
  assert.equal(blocked?.status, 'blocked')
  assert.equal(blocked?.statusReason?.code, 'no_progress')
  assert.equal(blocked?.automaticTurnsUsed, 3)
  assert.ok((blocked?.timeUsedSeconds ?? 0) >= 3, 'sub-second turns must not disappear from active-time accounting')
  assert.equal(store.getSnapshot(session.activeThreadId)?.turns.length, 3)
})
