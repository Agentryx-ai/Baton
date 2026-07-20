import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
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
import type { GoalEvidenceBundle, NewCanonicalItem, ThreadSnapshot } from './domain.ts'
import {
  CanonicalContextRuntime,
  ContextInputTooLargeError,
} from './canonical-context-runtime.ts'
import { ConversationEventHub } from './event-hub.ts'
import { chargeableGoalTokens, TurnOrchestrator } from './orchestrator.ts'
import { ProviderReadinessError } from './service.ts'
import { SqliteSessionStore } from './sqlite-store.ts'
import type { GoalVerifier } from './goal-verifier.ts'
import { goalEvidenceHash } from './goal-evidence.ts'

const acceptingGoalVerifier: GoalVerifier = {
  async verify({ bundle }) {
    return {
      decision: {
        outcome: 'complete',
        reason: 'Independent test verifier accepted the frozen evidence',
        requirements: bundle.requirements.map((requirement) => ({
          requirementId: requirement.id,
          result: 'satisfied',
          evidenceIds: bundle.evidence
            .filter((entry) => entry.payload.requirementId === requirement.id)
            .map((entry) => entry.id),
          reason: 'The frozen terminal deliverable satisfies the requirement',
        })),
        missingEvidence: [],
        impossibleEvidenceIds: [],
      },
      usage: { outputTokens: 1 },
    }
  },
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

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
    if (context.toolDefinitions.length === 0) {
      const response = JSON.stringify({
        outcome: 'complete',
        reason: 'independent verifier accepted the frozen deliverable',
        requirements: [{
          requirementId: 'requirement-1',
          result: 'satisfied',
          evidenceIds: ['evidence-1-1'],
          reason: 'the terminal deliverable satisfies the requirement',
        }],
        missingEvidence: [],
        impossibleEvidenceIds: [],
      })
      return {
        events: (async function* () {
          yield {
            eventId: 'verifier-completed', type: 'item/completed',
            payload: { text: response }, durability: 'durable' as const,
          }
        })(),
        terminal: Promise.resolve({ status: 'completed', usage: { outputTokens: 1 } }),
        async cancel() {},
        async dispose() {},
      }
    }
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

function transientThenCompletingAdapter(): SessionProviderAdapter {
  const adapter = safeAdapter([])
  let executions = 0
  adapter.execute = async (_request, context): Promise<ProviderTurnExecution> => {
    executions += 1
    const terminal = executions === 1
      ? Promise.resolve({
          status: 'failed' as const,
          error: { code: 'provider_retry_exhausted', message: 'temporary upstream 503' },
        })
      : (async () => {
          const result = await context.executeTool({
            callId: 'complete-after-transient',
            providerCallId: 'provider-complete-after-transient',
            name: 'update_goal',
            input: {
              status: 'complete',
              evidence: [{ requirement: 'recover', proof: 'second automatic turn completed' }],
            },
          })
          return result.success
            ? { status: 'completed' as const, usage: { outputTokens: 1 } }
            : { status: 'failed' as const, error: result.error ?? undefined }
        })()
    return {
      events: (async function* () {
        const result = await terminal
        if (result.status === 'completed') {
          yield {
            eventId: 'transient-complete-message',
            type: 'item/completed',
            payload: { text: 'recovered and completed' },
            durability: 'durable' as const,
          }
        }
      })(), terminal,
      async cancel() {}, async dispose() {},
    }
  }
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
  // Goal active-time tests intentionally use a one-second deadline; leave
  // enough polling headroom for that real timer plus scheduler jitter.
  for (let attempt = 0; attempt < 300; attempt += 1) {
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
  registry.register(safeAdapter(snapshots, 'exposed'))
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
  assert.equal(started.execution.policySnapshot.delegationMode, 'provider-native')
  assert.equal(snapshots[0]?.items.length, 0, 'current input must not be duplicated into provider history')

  const duplicate = await orchestrator.startTurn(request)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.turn.id, started.turn.id)
  assert.equal(orchestrator.getSnapshot(session.activeThreadId)?.turns.length, 1)
})

test('orchestrator runs compaction before beginTurn and records the execution context before provider materialization', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-orchestrator-context-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  const adapterSnapshots: ThreadSnapshot[] = []
  registry.register(safeAdapter(adapterSnapshots))
  const order: string[] = []
  const contextRuntime = {
    assertUpcomingInputFits() {
      return { additionalInputTokens: 0, inputBudgetTokens: 1 }
    },
    async compactBeforeTurn({ snapshot }: { snapshot: ThreadSnapshot }) {
      order.push(`compact:${snapshot.turns.length}`)
      return null
    },
    async materializeForExecution({ snapshot }: { snapshot: ThreadSnapshot }) {
      order.push(`materialize:${snapshot.turns.at(-1)?.status}`)
      return snapshot
    },
  }
  const orchestrator = new TurnOrchestrator(
    store,
    registry,
    new ConversationEventHub(),
    10_000,
    contextRuntime,
  )
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })

  const session = orchestrator.createSession({})
  const started = await orchestrator.startTurn({
    threadId: session.activeThreadId,
    provider: 'codex',
    model: 'gpt-test',
    clientRequestId: 'context-request',
    expectedRevision: 0,
    input: [{ kind: 'user_message', payload: { text: 'question' } }],
  })
  await waitForTerminal(store, started.turn.id)

  assert.deepEqual(order, ['compact:0', 'materialize:running'])
  assert.equal(adapterSnapshots.length, 1)
  assert.equal(adapterSnapshots[0]?.items.length, 0, 'current input remains the explicit turn request')
})

test('Goal active-time abort releases a continuation blocked in context preparation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-orchestrator-goal-context-abort-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  registry.register(safeAdapter([]))
  const never = new Promise<null>(() => undefined)
  const contextRuntime = {
    assertUpcomingInputFits() {
      return { additionalInputTokens: 0, inputBudgetTokens: 1 }
    },
    compactBeforeTurn() {
      return never
    },
    async materializeForExecution({ snapshot }: { snapshot: ThreadSnapshot }) {
      return snapshot
    },
  }
  const orchestrator = new TurnOrchestrator(
    store,
    registry,
    new ConversationEventHub(),
    10_000,
    contextRuntime,
  )
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })

  const session = orchestrator.createSession({})
  await orchestrator.startGoalRuntime()
  const goal = await orchestrator.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'release a blocked continuation at the active-time boundary',
    provider: 'codex',
    model: 'gpt-test',
    maxActiveSeconds: 1,
  })

  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (store.getGoalById(goal.id)?.status === 'budget_limited') break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(store.getGoalById(goal.id)?.status, 'budget_limited')
  const resumed = await orchestrator.updateGoalStatus({
    goalId: goal.id,
    expectedRevision: store.getGoalById(goal.id)?.revision ?? 0,
    status: 'active',
    resetLimitCounters: true,
  })
  assert.equal(resumed.status, 'applied')
  assert.equal(resumed.goal?.status, 'active')
})

test('first send verifies workspace, creates the canonical graph once, and replays before rechecking cwd', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-initial-session-'))
  const workspace = join(directory, 'workspace')
  const movedWorkspace = join(directory, 'workspace-moved')
  mkdirSync(workspace)
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  registry.register(safeAdapter([]))
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const request = {
    sessionId: 'client-session-first-send',
    clientRequestId: 'client-request-first-send',
    cwd: workspace,
    instructionSnapshot: { developerInstructions: 'Use the verified workspace only.' },
    provider: 'codex' as const,
    model: 'gpt-test',
    effort: 'high',
    input: [{ kind: 'user_message' as const, visibility: 'portable' as const, payload: { text: 'First request' } }],
  }

  const started = await orchestrator.startSession(request)
  await waitForTerminal(store, started.turn.id)
  assert.equal(started.duplicate, false)
  assert.equal(started.session.title, null)
  assert.equal(started.session.preview, 'First request')
  assert.equal(started.session.projectKey, null)
  assert.equal(started.session.cwd, realpathSync.native(workspace))
  assert.deepEqual(started.thread.instructionSnapshot, {
    schemaVersion: 1,
    developerInstructions: 'Use the verified workspace only.',
  })
  assert.equal(store.listSessions().length, 1)

  renameSync(workspace, movedWorkspace)
  const replay = await orchestrator.startSession(request)
  assert.equal(replay.duplicate, true)
  assert.equal(replay.turn.id, started.turn.id)
  assert.equal(store.listSessions().length, 1)

  await assert.rejects(
    orchestrator.startSession({ ...request, clientRequestId: 'different-request' }),
    (error) => error instanceof Error && /different initial request/.test(error.message),
  )
  assert.equal(store.listSessions().length, 1)
})

test('oversized first send is rejected before any canonical rows are created', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-initial-budget-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  const adapter = safeAdapter([])
  let executeCount = 0
  const execute = adapter.execute.bind(adapter)
  adapter.execute = async (request, context) => {
    executeCount += 1
    return execute(request, context)
  }
  registry.register(adapter)
  const orchestrator = new TurnOrchestrator(
    store,
    registry,
    new ConversationEventHub(),
    10_000,
    new CanonicalContextRuntime(store, 'initial-budget-test'),
  )
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })

  await assert.rejects(orchestrator.startSession({
    sessionId: 'oversized-first-session',
    clientRequestId: 'oversized-first-request',
    cwd: null,
    instructionSnapshot: { developerInstructions: 'be exact' },
    provider: 'codex',
    model: 'gpt-test',
    effort: 'high',
    input: [{ kind: 'user_message', payload: { text: 'x'.repeat(100_000) } }],
  }), (error) => error instanceof ContextInputTooLargeError
    && error.code === 'context_input_too_large')

  assert.deepEqual(store.listSessions('all'), [])
  assert.equal(executeCount, 0)
})

test('concurrent equivalent first sends normalize defaults and execute the adapter once', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-initial-concurrent-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  const adapter = safeAdapter([])
  const initialize = adapter.initialize.bind(adapter)
  const execute = adapter.execute.bind(adapter)
  let initializeCount = 0
  let executeCount = 0
  adapter.initialize = async () => { initializeCount += 1; return initialize() }
  adapter.execute = async (request, context) => { executeCount += 1; return execute(request, context) }
  registry.register(adapter)
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const base = {
    sessionId: 'concurrent-session',
    clientRequestId: 'concurrent-request',
    cwd: null,
    provider: 'codex' as const,
    model: 'gpt-test',
    effort: 'high',
  }
  const missingDefaults = {
    ...base,
    input: [{ kind: 'user_message' as const, payload: { text: 'hello', nested: { b: 2, a: 1 } } }],
  }
  const explicitDefaults = {
    ...base,
    input: [{
      kind: 'user_message' as const,
      visibility: 'portable' as const,
      payload: { nested: { a: 1, b: 2 }, text: 'hello' },
      provider: null,
      nativeId: null,
    }],
  }

  const results = await Promise.all([
    orchestrator.startSession(missingDefaults),
    orchestrator.startSession(explicitDefaults),
  ])
  assert.deepEqual(results.map((result) => result.duplicate).sort(), [false, true])
  assert.equal(results[0]?.turn.id, results[1]?.turn.id)
  await waitForTerminal(store, results[0]!.turn.id)
  assert.equal(initializeCount, 1)
  assert.equal(executeCount, 1)
  assert.equal(store.listSessions().length, 1)
  assert.deepEqual(store.getSnapshot(results[0]!.thread.id)?.items[0], {
    ...results[0]!.initialItems[0],
    visibility: 'portable',
    provider: null,
    nativeId: null,
    payload: { nested: { a: 1, b: 2 }, text: 'hello' },
  })
})

test('direct service rejects non-JSON first-turn payloads before adapter readiness', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-initial-non-json-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  const adapter = safeAdapter([])
  let initializeCount = 0
  adapter.initialize = async () => { initializeCount += 1; throw new Error('must not initialize') }
  registry.register(adapter)
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const base = {
    clientRequestId: 'non-json-request', cwd: null, provider: 'codex' as const, model: 'gpt-test',
  }
  const payloads: Record<string, unknown>[] = [
    { text: 'hello', invalid: undefined },
    { text: 'hello', invalid: new Date('2026-07-19T00:00:00.000Z') },
  ]
  for (const [index, payload] of payloads.entries()) {
    await assert.rejects(orchestrator.startSession({
      ...base,
      sessionId: `non-json-session-${index}`,
      input: [{ kind: 'user_message', payload }],
    }), /initial input payload contains/)
  }
  assert.equal(initializeCount, 0)
  assert.deepEqual(store.listSessions('all'), [])
})

test('committed first-send replay bypasses readiness in a new runtime', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-initial-replay-runtime-'))
  const databasePath = join(directory, 'sessions.sqlite')
  const request = {
    sessionId: 'replayed-session', clientRequestId: 'replayed-request', cwd: null,
    provider: 'codex' as const, model: 'gpt-test',
    input: [{ kind: 'user_message' as const, payload: { text: 'persist once' } }],
  }
  const firstStore = new SqliteSessionStore(databasePath)
  const firstRegistry = new AdapterRegistry()
  firstRegistry.register(safeAdapter([]))
  const firstRuntime = new TurnOrchestrator(firstStore, firstRegistry, new ConversationEventHub())
  const started = await firstRuntime.startSession(request)
  await waitForTerminal(firstStore, started.turn.id)
  await firstRuntime.close()

  const replayStore = new SqliteSessionStore(databasePath)
  const replayRegistry = new AdapterRegistry()
  const unavailable = safeAdapter([])
  let getReadyCount = 0
  let executeCount = 0
  unavailable.initialize = async () => { getReadyCount += 1; throw new Error('provider offline') }
  unavailable.execute = async () => { executeCount += 1; throw new Error('must not execute') }
  replayRegistry.register(unavailable)
  const replayRuntime = new TurnOrchestrator(replayStore, replayRegistry, new ConversationEventHub())
  t.after(async () => {
    await replayRuntime.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const replay = await replayRuntime.startSession(request)
  assert.equal(replay.duplicate, true)
  assert.equal(replay.turn.id, started.turn.id)
  assert.equal(getReadyCount, 0)
  assert.equal(executeCount, 0)
})

test('invalid workspace and adapter readiness failure leave no canonical rows', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-initial-preflight-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  const unavailable = safeAdapter([])
  unavailable.initialize = async () => { throw new Error('not authenticated') }
  registry.register(unavailable)
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const base = {
    clientRequestId: 'client-request-preflight',
    instructionSnapshot: {},
    provider: 'codex' as const,
    model: 'gpt-test',
    effort: null,
    input: [{ kind: 'user_message' as const, payload: { text: 'hello' } }],
  }

  await assert.rejects(
    orchestrator.startSession({ ...base, sessionId: 'invalid-workspace', cwd: join(directory, 'missing') }),
    (error) => error instanceof WorkspaceRootError && error.code === 'invalid_workspace',
  )
  assert.deepEqual(store.listSessions('all'), [])

  await assert.rejects(
    orchestrator.startSession({ ...base, sessionId: 'adapter-unavailable', cwd: null }),
    (error) => error instanceof ProviderReadinessError && error.provider === 'codex',
  )
  assert.deepEqual(store.listSessions('all'), [])
})

test('provider failure after atomic first send leaves a failed canonical turn and session', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-initial-provider-failure-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  const failing = safeAdapter([])
  let executeCount = 0
  failing.execute = async () => { executeCount += 1; throw new Error('upstream failed after commit') }
  registry.register(failing)
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })

  const request = {
    sessionId: 'provider-failure-session',
    clientRequestId: 'provider-failure-request',
    cwd: null,
    provider: 'codex' as const,
    model: 'gpt-test',
    input: [{ kind: 'user_message' as const, payload: { text: 'persist me' } }],
  }
  const started = await orchestrator.startSession(request)
  await waitForTerminal(store, started.turn.id)
  assert.equal(store.listSessions().length, 1)
  assert.equal(store.getTurn(started.turn.id)?.status, 'failed')
  assert.match(String(store.getTurn(started.turn.id)?.error?.message), /upstream failed after commit/)

  const replay = await orchestrator.startSession(request)
  assert.equal(replay.duplicate, true)
  assert.equal(replay.turn.id, started.turn.id)
  assert.equal(replay.turn.status, 'failed')
  assert.equal(executeCount, 1)
})

test('follow-up pump consumes accepted steer and drains closed steer before Goal continuation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-follow-up-pump-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  const controls: Array<{ resolve: (status: 'completed' | 'cancelled') => void }> = []
  let firstSteer = true
  const adapter = safeAdapter([])
  adapter.execute = async (): Promise<ProviderTurnExecution> => {
    let resolve!: (value: { status: 'completed' | 'cancelled' }) => void
    const terminal = new Promise<{ status: 'completed' | 'cancelled' }>((done) => { resolve = done })
    controls.push({ resolve: (status) => resolve({ status }) })
    return {
      events: emptyEvents(terminal), terminal,
      async steer(request) {
        if (request.text === 'unsupported live') return { status: 'unsupported' }
        if (firstSteer) { firstSteer = false; return { status: 'closed' } }
        return { status: 'accepted' }
      },
      async cancel() { resolve({ status: 'cancelled' }) }, async dispose() {},
    }
  }
  registry.register(adapter)
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => { await orchestrator.close(); rmSync(directory, { recursive: true, force: true }) })
  const session = orchestrator.createSession({})
  const goal = await orchestrator.createGoal({
    threadId: session.activeThreadId, expected: { kind: 'none' }, objective: 'keep ownership',
    provider: 'codex', model: 'gpt-test',
  })
  const started = await orchestrator.startTurn({
    threadId: session.activeThreadId, provider: 'codex', model: 'gpt-test', clientRequestId: 'turn',
    expectedRevision: 0, input: [{ kind: 'user_message', payload: { text: 'start' } }],
  })
  while (controls.length < 1) await new Promise((resolve) => setTimeout(resolve, 1))
  const submitted = await orchestrator.submitFollowUp({
    threadId: session.activeThreadId, clientRequestId: 'follow', expectedTurnId: started.turn.id,
    delivery: 'steer_or_queue', input: [{ kind: 'user_message', payload: { text: 'continue' } }],
  })
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (store.listFollowUps(session.activeThreadId)[0]?.targetTurnId === null) break
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  controls[0]!.resolve('completed')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controls.length >= 2) break
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.equal(controls.length, 2)
  assert.equal(store.getGoalById(goal.id)?.status, 'active')
  assert.equal(store.getGoalById(goal.id)?.revision, goal.revision)
  assert.equal(store.listFollowUps(session.activeThreadId)[0]?.status, 'consumed')
  assert.equal(store.listFollowUps(session.activeThreadId)[0]?.id, submitted.followUp.id)
  const secondTurn = store.getSnapshot(session.activeThreadId)!.turns.at(-1)!
  const unsupported = await orchestrator.submitFollowUp({
    threadId: session.activeThreadId, clientRequestId: 'unsupported', expectedTurnId: secondTurn.id,
    delivery: 'steer_or_queue', input: [{ kind: 'user_message', payload: { text: 'unsupported live' } }],
  })
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (store.listFollowUps(session.activeThreadId).find((item) => item.id === unsupported.followUp.id)?.targetTurnId === null) break
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  controls[1]!.resolve('completed')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controls.length >= 3) break
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.equal(store.listFollowUps(session.activeThreadId).find((item) => item.id === unsupported.followUp.id)?.status, 'consumed')
  const thirdTurn = store.getSnapshot(session.activeThreadId)!.turns.at(-1)!
  const accepted = await orchestrator.submitFollowUp({
    threadId: session.activeThreadId, clientRequestId: 'accepted', expectedTurnId: thirdTurn.id,
    delivery: 'steer_or_queue', input: [{ kind: 'user_message', payload: { text: 'accepted live' } }],
  })
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (store.listFollowUps(session.activeThreadId).find((item) => item.id === accepted.followUp.id)?.status === 'consumed') break
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.equal(store.listFollowUps(session.activeThreadId).find((item) => item.id === accepted.followUp.id)?.status, 'consumed')
  controls[2]!.resolve('completed')
  await waitForTerminal(store, thirdTurn.id)
})

test('queued user intent survives a transient drain failure before Goal terminal mutation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-follow-up-goal-retry-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  let executionCount = 0
  let resolveFirst!: (result: { status: 'failed'; error: { code: string } }) => void
  let resolveSecond!: (result: { status: 'cancelled' }) => void
  let markIntentStaged!: () => void
  const intentStaged = new Promise<void>((resolve) => { markIntentStaged = resolve })
  const adapter = safeAdapter([])
  adapter.execute = async (_request, context): Promise<ProviderTurnExecution> => {
    executionCount += 1
    if (executionCount === 1) {
      const released = new Promise<{ status: 'failed'; error: { code: string } }>((resolve) => { resolveFirst = resolve })
      const terminal = (async () => {
        const result = await context.executeTool({
          callId: 'stage-complete', providerCallId: 'provider-stage-complete', name: 'update_goal',
          input: { status: 'complete', evidence: [{ requirement: 'preserve intent', proof: 'queued user input wins' }] },
        })
        assert.equal(result.success, true)
        markIntentStaged()
        return released
      })().then((result) => result)
      return {
        events: emptyEvents(terminal), terminal,
        async steer() { return { status: 'closed' } },
        async cancel() { resolveFirst({ status: 'failed', error: { code: 'cancelled' } }) },
        async dispose() {},
      }
    }
    const terminal = new Promise<{ status: 'cancelled' }>((resolve) => { resolveSecond = resolve })
    return {
      events: emptyEvents(terminal), terminal,
      async cancel() { resolveSecond({ status: 'cancelled' }) }, async dispose() {},
    }
  }
  registry.register(adapter)
  const originalGetReady = registry.getReady.bind(registry)
  let failNextReady = false
  let failedReadyCalls = 0
  registry.getReady = async (provider) => {
    if (failNextReady) {
      failNextReady = false
      failedReadyCalls += 1
      throw new Error('transient adapter readiness failure')
    }
    return originalGetReady(provider)
  }
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => { await orchestrator.close(); rmSync(directory, { recursive: true, force: true }) })
  const session = orchestrator.createSession({})
  const goal = await orchestrator.createGoal({
    threadId: session.activeThreadId, expected: { kind: 'none' }, objective: 'keep user ownership',
    provider: 'codex', model: 'gpt-test',
  })
  const started = await orchestrator.startTurn({
    threadId: session.activeThreadId, provider: 'codex', model: 'gpt-test', clientRequestId: 'goal-turn',
    expectedRevision: store.getThread(session.activeThreadId)?.revision ?? 0,
    input: [{ kind: 'user_message', payload: { text: 'start' } }],
  })
  await intentStaged
  const submitted = await orchestrator.submitFollowUp({
    threadId: session.activeThreadId, clientRequestId: 'queued-after-close', expectedTurnId: started.turn.id,
    delivery: 'steer_or_queue', input: [{ kind: 'user_message', payload: { text: 'user correction' } }],
  })
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (store.listFollowUps(session.activeThreadId)[0]?.targetTurnId === null) break
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  failNextReady = true
  resolveFirst({ status: 'failed', error: { code: 'provider_failure' } })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (failedReadyCalls === 1 && store.listFollowUps(session.activeThreadId)[0]?.status === 'queued') break
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.equal(failedReadyCalls, 1)
  assert.equal(store.getGoalById(goal.id)?.status, 'active')
  assert.equal(store.getGoalById(goal.id)?.revision, goal.revision)
  assert.equal(store.listFollowUps(session.activeThreadId)[0]?.status, 'queued')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (executionCount === 2) break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(executionCount, 2)
  assert.equal(store.listFollowUps(session.activeThreadId)[0]?.id, submitted.followUp.id)
  assert.equal(store.listFollowUps(session.activeThreadId)[0]?.status, 'consumed')
  const retryTurn = store.getSnapshot(session.activeThreadId)!.turns.at(-1)!
  assert.equal(retryTurn.goalId, goal.id)
  assert.equal(retryTurn.goalRevision, goal.revision)
  assert.equal(store.getGoalById(goal.id)?.status, 'active')
  assert.equal(store.getGoalById(goal.id)?.revision, goal.revision)
})

test('closing the orchestrator cancels a scheduled follow-up drain retry', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-follow-up-close-retry-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  let resolveTurn!: (result: { status: 'completed' }) => void
  const adapter = safeAdapter([])
  adapter.execute = async (): Promise<ProviderTurnExecution> => {
    const terminal = new Promise<{ status: 'completed' }>((resolve) => { resolveTurn = resolve })
    return {
      events: emptyEvents(terminal), terminal,
      async steer() { return { status: 'closed' } },
      async cancel() { resolveTurn({ status: 'completed' }) }, async dispose() {},
    }
  }
  registry.register(adapter)
  const originalGetReady = registry.getReady.bind(registry)
  let failNextReady = false
  let trackDrainReady = false
  let drainReadyCalls = 0
  registry.getReady = async (provider) => {
    if (trackDrainReady) drainReadyCalls += 1
    if (failNextReady) {
      failNextReady = false
      throw new Error('transient adapter readiness failure')
    }
    return originalGetReady(provider)
  }
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })
  const session = orchestrator.createSession({})
  const started = await orchestrator.startTurn({
    threadId: session.activeThreadId, provider: 'codex', model: 'gpt-test', clientRequestId: 'turn-before-close',
    expectedRevision: 0, input: [{ kind: 'user_message', payload: { text: 'start' } }],
  })
  await orchestrator.submitFollowUp({
    threadId: session.activeThreadId, clientRequestId: 'retry-after-close', expectedTurnId: started.turn.id,
    delivery: 'steer_or_queue', input: [{ kind: 'user_message', payload: { text: 'queued' } }],
  })
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (store.listFollowUps(session.activeThreadId)[0]?.targetTurnId === null) break
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  trackDrainReady = true
  failNextReady = true
  resolveTurn({ status: 'completed' })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (drainReadyCalls === 1 && store.listFollowUps(session.activeThreadId)[0]?.status === 'queued') break
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.equal(drainReadyCalls, 1)
  await orchestrator.close()
  await new Promise((resolve) => setTimeout(resolve, 350))
  assert.equal(drainReadyCalls, 1)
})

test('closing waits for an already-fired follow-up drain without launching after shutdown', async (t) => {
  for (const outcome of ['resolve', 'reject'] as const) {
    await t.test(outcome, async () => {
      const directory = mkdtempSync(join(tmpdir(), `baton-follow-up-close-inflight-${outcome}-`))
      const database = join(directory, 'sessions.sqlite')
      const store = new SqliteSessionStore(database)
      const registry = new AdapterRegistry()
      let resolveTurn!: (result: { status: 'completed' }) => void
      const adapter = safeAdapter([])
      adapter.execute = async (): Promise<ProviderTurnExecution> => {
        const terminal = new Promise<{ status: 'completed' }>((resolve) => { resolveTurn = resolve })
        return {
          events: emptyEvents(terminal), terminal,
          async steer() { return { status: 'closed' } },
          async cancel() { resolveTurn({ status: 'completed' }) }, async dispose() {},
        }
      }
      registry.register(adapter)
      const originalGetReady = registry.getReady.bind(registry)
      const ready = await originalGetReady('codex')
      const pendingReady = deferred<typeof ready>()
      const drainEntered = deferred<void>()
      let deferDrain = false
      registry.getReady = async (provider) => {
        if (!deferDrain) return originalGetReady(provider)
        drainEntered.resolve()
        return pendingReady.promise
      }
      const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
      t.after(() => { rmSync(directory, { recursive: true, force: true }) })

      const session = orchestrator.createSession({})
      const started = await orchestrator.startTurn({
        threadId: session.activeThreadId, provider: 'codex', model: 'gpt-test', clientRequestId: 'turn-before-inflight-close',
        expectedRevision: 0, input: [{ kind: 'user_message', payload: { text: 'start' } }],
      })
      await orchestrator.submitFollowUp({
        threadId: session.activeThreadId, clientRequestId: 'retry-inflight-close', expectedTurnId: started.turn.id,
        delivery: 'steer_or_queue', input: [{ kind: 'user_message', payload: { text: 'queued' } }],
      })
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (store.listFollowUps(session.activeThreadId)[0]?.targetTurnId === null) break
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      deferDrain = true
      resolveTurn({ status: 'completed' })
      await drainEntered.promise

      const closeResult = await Promise.race([
        orchestrator.close().then(() => 'closed' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1_000)),
      ])
      assert.equal(closeResult, 'closed')
      if (outcome === 'resolve') pendingReady.resolve(ready)
      else pendingReady.reject(new Error('late readiness failure'))
      await new Promise((resolve) => setTimeout(resolve, 10))

      const reopened = new SqliteSessionStore(database)
      try {
        const snapshot = reopened.getSnapshot(session.activeThreadId)
        assert.equal(snapshot?.turns.length, 1)
        assert.equal(snapshot?.turns.some((turn) => turn.status === 'running' || turn.status === 'queued'), false)
        assert.equal(reopened.listFollowUps(session.activeThreadId)[0]?.status, 'queued')
      } finally {
        reopened.close()
      }
    })
  }
})

test('rejected steer becomes delivery_unknown and cancels the owning turn', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-follow-up-unknown-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  const adapter = safeAdapter([])
  adapter.execute = async (): Promise<ProviderTurnExecution> => {
    let resolve!: (value: { status: 'cancelled' }) => void
    const terminal = new Promise<{ status: 'cancelled' }>((done) => { resolve = done })
    return {
      events: emptyEvents(terminal), terminal,
      async steer() { throw new Error('transport outcome unknown') },
      async cancel() { resolve({ status: 'cancelled' }) }, async dispose() {},
    }
  }
  registry.register(adapter)
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => { await orchestrator.close(); rmSync(directory, { recursive: true, force: true }) })
  const session = orchestrator.createSession({})
  const started = await orchestrator.startTurn({
    threadId: session.activeThreadId, provider: 'codex', model: 'gpt-test', clientRequestId: 'turn',
    expectedRevision: 0, input: [{ kind: 'user_message', payload: { text: 'start' } }],
  })
  await orchestrator.submitFollowUp({
    threadId: session.activeThreadId, clientRequestId: 'unknown', expectedTurnId: started.turn.id,
    delivery: 'steer_or_queue', input: [{ kind: 'user_message', payload: { text: 'maybe' } }],
  })
  await waitForTerminal(store, started.turn.id)
  assert.equal(store.listFollowUps(session.activeThreadId)[0]?.status, 'delivery_unknown')
  assert.equal(store.getTurn(started.turn.id)?.status, 'cancelled')
})

test('startup drains pending user follow-up before Goal automatic continuation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-follow-up-startup-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const session = store.createSession({})
  const goal = store.createGoal({
    threadId: session.activeThreadId, expected: { kind: 'none' }, objective: 'continue later',
    provider: 'codex', model: 'gpt-test',
  })
  const prior = store.beginTurn({
    threadId: session.activeThreadId, provider: 'codex', model: 'gpt-test', clientRequestId: 'prior',
    requestHash: 'prior-hash', expectedRevision: 0, input: [{ kind: 'user_message', payload: { text: 'prior' } }],
    adapterVersion: 'test/1', policySnapshot: { delegationMode: 'disabled', allowedTools: [], approvalPolicy: 'never', cwd: null, maxDepth: 0, capabilityGrant: null },
  })
  store.enqueueFollowUp({
    threadId: session.activeThreadId, clientRequestId: 'pending-user', requestHash: 'pending-hash',
    delivery: 'next_turn', targetTurnId: null, scope: { kind: 'goal', goalId: goal.id, revision: goal.revision },
    input: [{ kind: 'user_message', payload: { text: 'user wins' } }],
  })
  store.finishTurn({ turnId: prior.turn.id, status: 'completed' })
  const registry = new AdapterRegistry(); registry.register(safeAdapter([]))
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => { await orchestrator.close(); rmSync(directory, { recursive: true, force: true }) })
  await orchestrator.startGoalRuntime()
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((store.getSnapshot(session.activeThreadId)?.turns.length ?? 0) >= 2) break
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  const second = store.getSnapshot(session.activeThreadId)!.turns[1]!
  const secondInput = store.getSnapshot(session.activeThreadId)!.items.find((item) => item.turnId === second.id && item.kind === 'user_message')
  assert.equal(secondInput?.payload.text, 'user wins')
  assert.match(second.clientRequestId, /^follow-up:/)
})

test('a Goal created after turn start forces follow-up to the next turn without steering stale ownership', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-follow-up-goal-race-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry(); registry.register(cancellableAdapter())
  const orchestrator = new TurnOrchestrator(store, registry, new ConversationEventHub())
  t.after(async () => { await orchestrator.close(); rmSync(directory, { recursive: true, force: true }) })
  const session = orchestrator.createSession({})
  const started = await orchestrator.startTurn({
    threadId: session.activeThreadId, provider: 'codex', model: 'gpt-test', clientRequestId: 'ordinary',
    expectedRevision: 0, input: [{ kind: 'user_message', payload: { text: 'ordinary' } }],
  })
  const goal = await orchestrator.createGoal({
    threadId: session.activeThreadId, expected: { kind: 'none' }, objective: 'new Goal', provider: 'codex', model: 'gpt-test',
  })
  const submitted = await orchestrator.submitFollowUp({
    threadId: session.activeThreadId, clientRequestId: 'goal-race', expectedTurnId: started.turn.id,
    delivery: 'steer_or_queue', input: [{ kind: 'user_message', payload: { text: 'belongs to new Goal' } }],
  })
  assert.equal(submitted.followUp.targetTurnId, null)
  assert.deepEqual(submitted.followUp.scope, { kind: 'goal', goalId: goal.id, revision: goal.revision })
  await orchestrator.cancelTurn(started.turn.id)
  const followUp = store.listFollowUps(session.activeThreadId)[0]
  const retryTurn = store.getSnapshot(session.activeThreadId)!.turns.at(-1)!
  assert.equal(followUp?.status, 'consumed')
  assert.equal(retryTurn.goalId, goal.id)
  assert.equal(retryTurn.goalRevision, goal.revision)
  assert.equal(store.getGoalById(goal.id)?.status, 'active')
  assert.equal(store.getGoalById(goal.id)?.revision, goal.revision)
})

test('TurnOrchestrator persists provider-native delegation declared by the adapter', async (t) => {
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
  const started = await orchestrator.startTurn({
    threadId: session.activeThreadId,
    provider: 'codex',
    model: 'gpt-test',
    clientRequestId: 'unsafe',
    expectedRevision: 0,
    input: [{ kind: 'user_message', payload: { text: 'hello' } }],
  })
  await waitForTerminal(store, started.turn.id)
  assert.equal(started.execution.policySnapshot.delegationMode, 'provider-native')
  assert.equal(orchestrator.getSnapshot(session.activeThreadId)?.turns.length, 1)
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

test('full access snapshots host command permission and works without a connected workspace', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-orchestrator-full-access-'))
  const output = join(directory, 'host-command.txt')
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  store.updateDefaultPermissionProfile('full_access')
  const registry = new AdapterRegistry()
  registry.register(toolCallingAdapter({
    name: 'run_command',
    input: {
      argv: [process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], 'full-access')", output],
    },
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
    clientRequestId: 'full-access-no-workspace',
    expectedRevision: 0,
    input: [{ kind: 'user_message', payload: { text: 'run the host command' } }],
  })
  await waitForTerminal(store, started.turn.id)

  assert.equal(store.getTurn(started.turn.id)?.status, 'completed', JSON.stringify(store.listItems(session.activeThreadId)))
  assert.equal(readFileSync(output, 'utf8'), 'full-access')
  assert.equal(started.execution.policySnapshot.permissionProfile, 'full_access')
  assert.equal(started.execution.policySnapshot.permissionProfileSource, 'global')
  assert.equal(started.execution.policySnapshot.allowedTools.includes('run_command'), true)
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
  assert.equal(store.getGoalVerificationHistory(goal.id).attempts.length, 1)
  assert.equal(store.getGoalVerificationHistory(goal.id).receipts.length, 1)
})

test('startup retries an unexpired verifier lease and recovers the durable pending Goal verification', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-orchestrator-goal-verification-recovery-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const session = store.createSession({})
  const goal = store.createGoal({
    threadId: session.activeThreadId, expected: { kind: 'none' }, objective: 'recover verified completion',
    provider: 'codex', model: 'gpt-test',
  })
  const started = store.beginTurn({
    threadId: session.activeThreadId, provider: 'codex', model: 'gpt-test',
    clientRequestId: 'verification-recovery-turn', requestHash: 'verification-recovery-hash', expectedRevision: 0,
    input: [{ kind: 'user_message', payload: { text: 'finish' } }], adapterVersion: 'test/1',
    policySnapshot: {
      delegationMode: 'disabled', allowedTools: [], approvalPolicy: 'never', cwd: null,
      maxDepth: 0, capabilityGrant: null,
    },
  })
  store.appendProviderEvent({
    turnId: started.turn.id, eventId: 'verification-recovery-answer',
    items: [{ kind: 'assistant_message', payload: { text: 'finished deliverable' } }],
  })
  store.finishTurn({ turnId: started.turn.id, status: 'completed' })
  store.recordGoalTurn({
    turnId: started.turn.id, goalId: goal.id, goalRevision: goal.revision,
    tokensUsed: 1, timeUsedSeconds: 1, automatic: true, progressDigest: 'delivered',
  })
  const requirements = [{
    id: 'requirement-1', requirement: goal.objective,
    evidence: [{ kind: 'current_turn' as const, reference: null, claim: 'terminal deliverable' }],
  }]
  const content = {
    goalId: goal.id, goalRevision: goal.revision, objective: goal.objective,
    proposalSummary: 'deliverable finished', requirements,
    evidence: [{
      id: 'evidence-1-1', kind: 'current_turn' as const, reference: started.turn.id,
      claim: 'terminal deliverable', authoritative: true,
      payload: { requirementId: 'requirement-1', terminalStatus: 'completed' },
    }],
    terminalTurn: {
      id: started.turn.id, status: 'completed' as const, provider: 'codex' as const, model: 'gpt-test',
    },
    omissions: [] as string[],
  }
  const evidenceBundle: GoalEvidenceBundle = { ...content, hash: goalEvidenceHash(content) }
  const proposal = store.beginGoalVerification({
    goalId: goal.id, goalRevision: goal.revision, turnId: started.turn.id,
    summary: content.proposalSummary, requirements, evidenceBundle,
  })
  assert.ok(proposal)
  assert.equal(store.getGoalById(goal.id)?.status, 'verifying')
  assert.ok(store.claimGoalVerifierLease({
    proposalId: proposal.id, goalId: goal.id, goalRevision: goal.revision,
    ownerId: 'crashed-verifier', leaseDurationMs: 20,
  }))

  const registry = new AdapterRegistry()
  registry.register(safeAdapter([]))
  const orchestrator = new TurnOrchestrator(
    store, registry, new ConversationEventHub(), 10_000, null, null, acceptingGoalVerifier, 5,
  )
  t.after(async () => { await orchestrator.close(); rmSync(directory, { recursive: true, force: true }) })
  await orchestrator.startGoalRuntime()

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (store.getGoalById(goal.id)?.status === 'complete') break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(store.getGoalById(goal.id)?.status, 'complete')
  assert.equal(store.getGoalVerificationHistory(goal.id).attempts.length, 1)
  assert.equal(store.getGoalVerificationHistory(goal.id).receipts.length, 1)
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

test('an incomplete independent verification feeds back into exactly one continued Goal turn', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-orchestrator-goal-incomplete-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  registry.register(toolCallingAdapter({
    name: 'propose_goal_completion',
    input: {
      summary: 'deliverable produced',
      requirements: [{
        requirement: 'finish',
        evidence: [{ kind: 'current_turn', claim: 'the current turn contains the deliverable' }],
      }],
    },
  }))
  let checks = 0
  const verifier: GoalVerifier = {
    async verify(input) {
      checks += 1
      if (checks === 1) {
        return {
          decision: {
            outcome: 'incomplete',
            reason: 'one more independent pass is required',
            requirements: [{
              requirementId: 'requirement-1', result: 'unproven', evidenceIds: [], reason: 'not proven yet',
            }],
            missingEvidence: ['a second confirmed deliverable'],
            impossibleEvidenceIds: [],
          },
          usage: null,
        }
      }
      return acceptingGoalVerifier.verify(input)
    },
  }
  const orchestrator = new TurnOrchestrator(
    store, registry, new ConversationEventHub(), 10_000, null, null, verifier,
  )
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = orchestrator.createSession({ cwd: directory })
  await orchestrator.startGoalRuntime()
  const goal = await orchestrator.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'finish after independent verification',
    provider: 'codex',
    model: 'gpt-test',
  })
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (store.getGoalById(goal.id)?.status === 'complete') break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(store.getGoalById(goal.id)?.status, 'complete')
  assert.equal(store.getSnapshot(session.activeThreadId)?.turns.length, 2)
  const history = store.getGoalVerificationHistory(goal.id)
  assert.deepEqual(history.attempts.map((attempt) => attempt.outcome), ['incomplete', 'complete'])
  assert.equal(history.receipts.length, 1)
})

test('an automatic Goal retries an exhausted transient provider failure within its Goal limits', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-orchestrator-transient-retry-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  registry.register(transientThenCompletingAdapter())
  const orchestrator = new TurnOrchestrator(
    store, registry, new ConversationEventHub(), 10_000, null, null, acceptingGoalVerifier,
  )
  t.after(async () => {
    await orchestrator.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = orchestrator.createSession({ cwd: directory })
  await orchestrator.startGoalRuntime()
  const goal = await orchestrator.createGoal({
    threadId: session.activeThreadId,
    expected: { kind: 'none' },
    objective: 'recover from one transient provider failure',
    provider: 'codex',
    model: 'gpt-test',
  })

  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (store.getGoalById(goal.id)?.status === 'complete') break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const turns = store.getSnapshot(session.activeThreadId)?.turns ?? []
  assert.equal(turns.length, 2)
  assert.equal(turns[0]?.error?.code, 'provider_retry_exhausted')
  assert.equal(turns[1]?.status, 'completed')
  assert.equal(store.getGoalById(goal.id)?.status, 'complete')
  assert.equal(store.getGoalById(goal.id)?.automaticTurnsUsed, 2)
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
