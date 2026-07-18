import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AdapterRegistry } from './adapter-registry.ts'
import type {
  NativeProviderEvent,
  NativeTurnRequest,
  ProviderTurnExecution,
  ProviderExecutionContext,
  SessionProviderAdapter,
} from './adapter.ts'
import type { NewCanonicalItem, ThreadSnapshot } from './domain.ts'
import { ConversationEventHub } from './event-hub.ts'
import { TurnOrchestrator } from './orchestrator.ts'
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
      return result.success
        ? { status: 'completed' as const, usage: { inputTokens: 5, outputTokens: 3 } }
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

async function waitForTerminal(store: SqliteSessionStore, turnId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = store.getTurn(turnId)?.status
    if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted') return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`turn did not finish: ${turnId}`)
}

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

test('an active Goal launches a continuation and can complete through the provider-neutral Goal tool', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-orchestrator-goal-'))
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'))
  const registry = new AdapterRegistry()
  registry.register(toolCallingAdapter({ name: 'update_goal', input: { status: 'complete' } }))
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
