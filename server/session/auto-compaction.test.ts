import assert from 'node:assert/strict'
import test from 'node:test'

import type { CanonicalItem, CanonicalTurn, ThreadSnapshot } from './domain.js'
import {
  AutoCompactionEngine,
  contextSummaryInputHash,
  type AutoCompactionPolicy,
  type ContextCompactionStore,
  type ContextCompactionGenerationRequest,
  type ContextCompactionGenerationReservation,
  type ContextSummaryGenerationInput,
  type ContextSummaryGenerator,
} from './auto-compaction.js'
import type { ContextSummaryArtifact } from './context-materializer.js'

const COMPACT_POLICY: AutoCompactionPolicy = {
  contextWindowTokens: 3_000,
  reservedOutputTokens: 80,
  safetyMarginTokens: 40,
  triggerRatio: 0.1,
  retainRecentTurns: 1,
  minimumSourceTokens: 1,
  maximumSummaryTokens: 40,
}

test('pre-turn engine automatically compacts a stable prefix with explicit headroom', async () => {
  const store = new MemoryArtifactStore()
  const generator = new RecordingGenerator()
  const snapshot = largeSnapshot(3)
  const engine = new AutoCompactionEngine(store, generator, COMPACT_POLICY, () => '2026-07-19T03:00:00Z')

  const result = await engine.compactBeforeTurn(snapshot)

  assert.equal(result.reason, 'compacted')
  assert.equal(result.inputBudgetTokens, 2_880)
  assert.equal(result.triggerTokens, 288)
  assert.equal(store.artifacts.length, 1)
  assert.deepEqual(store.savedExpectedIds, [null])
  assert.equal(generator.inputs.length, 1)
  assert.deepEqual(generator.inputs[0]?.sourceItemIds, [
    'user-1', 'private-1', 'assistant-1', 'user-2', 'assistant-2',
  ])
  assert.deepEqual(generator.inputs[0]?.items.map((entry) => entry.id), [
    'user-1', 'assistant-1', 'user-2', 'assistant-2',
  ])
  assert.equal(generator.inputs[0]?.previousSummary, null)
  assert.deepEqual(result.context.entries.map((entry) =>
    entry.type === 'derived_summary' ? 'summary' : entry.item.id), [
    'summary', 'user-3', 'assistant-3',
  ])
  assert.ok(result.estimatedTokensAfter < result.estimatedTokensBefore)
})

test('active turns prevent mid-tool-loop compaction even over threshold', async () => {
  const snapshot = largeSnapshot(2)
  snapshot.turns.push(turn('active', 3, 'waiting_tool'))
  snapshot.items.push(item('active-user', 'active', 99, 'user_message', longText('active')))
  const store = new MemoryArtifactStore()
  const generator = new RecordingGenerator()

  const result = await new AutoCompactionEngine(store, generator, COMPACT_POLICY)
    .compactBeforeTurn(snapshot)

  assert.equal(result.reason, 'active_turn')
  assert.equal(generator.inputs.length, 0)
  assert.equal(store.artifacts.length, 0)
})

test('below-threshold history does not invoke the summary generator', async () => {
  const store = new MemoryArtifactStore()
  const generator = new RecordingGenerator()
  const policy = { ...COMPACT_POLICY, contextWindowTokens: 100_000 }
  const result = await new AutoCompactionEngine(store, generator, policy)
    .compactBeforeTurn(largeSnapshot(2))
  assert.equal(result.reason, 'below_threshold')
  assert.equal(generator.inputs.length, 0)
})

test('private opaque state is excluded from generator input and retired with covered turns', async () => {
  const snapshot = largeSnapshot(2)
  const store = new MemoryArtifactStore()
  const generator = new RecordingGenerator()
  const policy = { ...COMPACT_POLICY, retainRecentTurns: 0 }
  const result = await new AutoCompactionEngine(store, generator, policy)
    .compactBeforeTurn(snapshot)

  assert.equal(result.reason, 'compacted')
  assert.equal(generator.inputs[0]?.items.some((entry) => entry.visibility !== 'portable'), false)
  assert.equal(generator.inputs[0]?.items.some((entry) => entry.id === 'private-1'), false)
  assert.equal(result.context.entries.some((entry) =>
    entry.type === 'canonical_item' && entry.item.id === 'private-1'), false)
  assert.equal(result.artifact?.sourceItemIds.includes('private-1'), true)
})

test('safe failed turns carry terminal status and error into the exact summary prompt', async () => {
  const snapshot = largeSnapshot(2)
  snapshot.turns[1] = {
    ...snapshot.turns[1]!,
    status: 'failed',
    error: { code: 'provider_failed', message: 'upstream stopped' },
    completedAt: '2026-07-19T00:02:00Z',
  }
  const generator = new RecordingGenerator()
  const result = await new AutoCompactionEngine(
    new MemoryArtifactStore(),
    generator,
    { ...COMPACT_POLICY, retainRecentTurns: 0 },
  ).compactBeforeTurn(snapshot)

  assert.equal(result.reason, 'compacted')
  assert.deepEqual(generator.inputs[0]?.turns.map((turn) => ({
    id: turn.id,
    status: turn.status,
    code: turn.error?.code,
  })), [
    { id: 'turn-1', status: 'completed', code: undefined },
    { id: 'turn-2', status: 'failed', code: 'provider_failed' },
  ])
  assert.match(result.artifact?.summaryInputHash ?? '', /^[a-f0-9]{64}$/)
  assert.equal(
    result.artifact?.summaryInputHash,
    contextSummaryInputHash(generator.inputs[0]!, result.artifact!.generator),
  )
  assert.notEqual(
    contextSummaryInputHash({
      ...generator.inputs[0]!,
      turns: generator.inputs[0]!.turns.map((turn) =>
        turn.id === 'turn-2' ? { ...turn, status: 'cancelled' } : turn),
    }, result.artifact!.generator),
    result.artifact?.summaryInputHash,
  )
})

test('generator failure and invalid output preserve full canonical fallback', async () => {
  const snapshot = largeSnapshot(2)
  const failed = new AutoCompactionEngine(new MemoryArtifactStore(), {
    metadata() { return { id: 'test', model: 'test-model', effort: null, version: '1' } },
    async generate() { throw new Error('offline') },
  }, { ...COMPACT_POLICY, retainRecentTurns: 0 })
  const failedResult = await failed.compactBeforeTurn(snapshot)
  assert.equal(failedResult.reason, 'generator_failed')
  assert.equal(failedResult.context.artifact, null)
  assert.equal(failedResult.context.entries.length, snapshot.items.length)

  const invalid = new AutoCompactionEngine(new MemoryArtifactStore(), {
    metadata() { return { id: 'test', model: 'test-model', effort: null, version: '1' } },
    async generate() {
      return { summary: 'x'.repeat(500), generator: this.metadata() }
    },
  }, { ...COMPACT_POLICY, retainRecentTurns: 0, maximumSummaryTokens: 2 })
  const invalidResult = await invalid.compactBeforeTurn(snapshot)
  assert.equal(invalidResult.reason, 'generator_output_invalid')
  assert.equal(invalidResult.context.artifact, null)
})

test('non-JSON canonical source refuses compaction and keeps full history', async () => {
  const snapshot = largeSnapshot(2)
  snapshot.items[0]!.payload = { invalid: undefined }
  const generator = new RecordingGenerator()
  const result = await new AutoCompactionEngine(
    new MemoryArtifactStore(),
    generator,
    { ...COMPACT_POLICY, retainRecentTurns: 0 },
  ).compactBeforeTurn(snapshot)
  assert.equal(result.reason, 'canonical_source_invalid')
  assert.equal(result.context.artifact, null)
  assert.equal(result.context.entries.length, snapshot.items.length)
  assert.equal(generator.inputs.length, 0)
})

test('incremental compaction folds a valid prior summary and only sends uncovered items', async () => {
  const snapshot = largeSnapshot(3)
  const firstStore = new MemoryArtifactStore()
  const firstGenerator = new RecordingGenerator()
  const first = await new AutoCompactionEngine(
    firstStore,
    firstGenerator,
    { ...COMPACT_POLICY, retainRecentTurns: 2 },
    () => '2026-07-19T03:00:00Z',
  ).compactBeforeTurn(snapshot)
  assert.equal(first.reason, 'compacted')

  const store = new MemoryArtifactStore([first.artifact!])
  const generator = new RecordingGenerator()
  const next = await new AutoCompactionEngine(
    store,
    generator,
    { ...COMPACT_POLICY, retainRecentTurns: 1 },
    () => '2026-07-19T04:00:00Z',
  ).compactBeforeTurn(snapshot)

  assert.equal(next.reason, 'compacted')
  assert.equal(generator.inputs[0]?.previousSummary?.id, first.artifact?.id)
  assert.deepEqual(generator.inputs[0]?.items.map((entry) => entry.id), ['user-2', 'assistant-2'])
  assert.deepEqual(store.savedExpectedIds, [first.artifact?.id])
})

test('an over-budget preferred suffix adaptively retains fewer turns at the first fitting frontier', async () => {
  const generator = new RecordingGenerator()
  const result = await new AutoCompactionEngine(
    new MemoryArtifactStore(),
    generator,
    { ...COMPACT_POLICY, retainRecentTurns: 2 },
  ).compactBeforeTurn(largeSnapshot(3), { additionalInputTokens: 1_800 })

  assert.equal(result.reason, 'compacted')
  assert.deepEqual(generator.inputs[0]?.sourceItemIds, [
    'user-1', 'private-1', 'assistant-1', 'user-2', 'assistant-2',
  ])
  assert.deepEqual(result.context.entries.map((entry) =>
    entry.type === 'derived_summary' ? 'summary' : entry.item.id), [
    'summary', 'user-3', 'assistant-3',
  ])
})

test('an over-budget existing view incrementally extends beyond its preferred frontier', async () => {
  const snapshot = largeSnapshot(3)
  const first = await new AutoCompactionEngine(
    new MemoryArtifactStore(),
    new RecordingGenerator(),
    { ...COMPACT_POLICY, retainRecentTurns: 2 },
    () => '2026-07-19T03:00:00Z',
  ).compactBeforeTurn(snapshot)
  assert.equal(first.reason, 'compacted')

  const generator = new RecordingGenerator()
  const next = await new AutoCompactionEngine(
    new MemoryArtifactStore([first.artifact!]),
    generator,
    { ...COMPACT_POLICY, retainRecentTurns: 2 },
    () => '2026-07-19T04:00:00Z',
  ).compactBeforeTurn(snapshot, { additionalInputTokens: 1_800 })

  assert.equal(next.reason, 'compacted')
  assert.equal(generator.inputs[0]?.previousSummary?.id, first.artifact?.id)
  assert.deepEqual(generator.inputs[0]?.items.map((entry) => entry.id), [
    'user-2', 'assistant-2',
  ])
  assert.deepEqual(next.context.entries.map((entry) =>
    entry.type === 'derived_summary' ? 'summary' : entry.item.id), [
    'summary', 'user-3', 'assistant-3',
  ])
})

test('superseded writer reloads the winning artifact without corrupting context', async () => {
  const snapshot = largeSnapshot(2)
  const store = new MemoryArtifactStore()
  store.supersede = true
  const result = await new AutoCompactionEngine(
    store,
    new RecordingGenerator(),
    { ...COMPACT_POLICY, retainRecentTurns: 0 },
  ).compactBeforeTurn(snapshot)
  assert.equal(result.reason, 'superseded')
  assert.equal(result.context.artifact, null)
  assert.equal(result.context.entries.length, snapshot.items.length)
})

test('stored compaction reloads the durable artifact identity before reporting success', async () => {
  const snapshot = largeSnapshot(2)
  const store = new MemoryArtifactStore()
  store.persistedId = 'sqlite-assigned-artifact-id'
  const result = await new AutoCompactionEngine(
    store,
    new RecordingGenerator(),
    { ...COMPACT_POLICY, retainRecentTurns: 0 },
  ).compactBeforeTurn(snapshot)

  assert.equal(result.reason, 'compacted')
  assert.equal(result.artifact?.id, 'sqlite-assigned-artifact-id')
  assert.equal(result.context.artifact?.id, 'sqlite-assigned-artifact-id')
})

test('upcoming input overhead can trigger compaction before the canonical snapshot alone would', async () => {
  const snapshot = largeSnapshot(2)
  const store = new MemoryArtifactStore()
  const generator = new RecordingGenerator()
  const policy = {
    ...COMPACT_POLICY,
    contextWindowTokens: 10_000,
    triggerRatio: 0.9,
    retainRecentTurns: 0,
  }
  const withoutInput = await new AutoCompactionEngine(store, generator, policy)
    .compactBeforeTurn(snapshot)
  assert.equal(withoutInput.reason, 'below_threshold')

  const withInput = await new AutoCompactionEngine(new MemoryArtifactStore(), new RecordingGenerator(), policy)
    .compactBeforeTurn(snapshot, { provider: 'codex', additionalInputTokens: 8_000 })
  assert.equal(withInput.reason, 'compacted')
  assert.ok(withInput.estimatedTokensBefore > withoutInput.estimatedTokensBefore)
})

test('policy rejects missing context headroom deterministically', () => {
  assert.throws(() => new AutoCompactionEngine(
    new MemoryArtifactStore(),
    new RecordingGenerator(),
    { ...COMPACT_POLICY, contextWindowTokens: 100, reservedOutputTokens: 80, safetyMarginTokens: 20 },
  ), /exhaust the context window/)
})

test('durable reservation permits only one concurrent provider generation', async () => {
  const store = new MemoryArtifactStore()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const generator = new RecordingGenerator(gate)
  const policy = { ...COMPACT_POLICY, retainRecentTurns: 0 }
  const first = new AutoCompactionEngine(store, generator, policy)
    .compactBeforeTurn(largeSnapshot(2))
  await store.reserved
  const second = await new AutoCompactionEngine(store, generator, policy)
    .compactBeforeTurn(largeSnapshot(2))

  assert.equal(second.reason, 'superseded')
  assert.equal(generator.inputs.length, 1)
  release()
  assert.equal((await first).reason, 'compacted')
})

test('generator failure is recorded against the same durable receipt', async () => {
  const store = new MemoryArtifactStore()
  const generator: ContextSummaryGenerator = {
    metadata: () => ({ id: 'failed-generator', model: 'test-model', effort: 'high', version: '1' }),
    async generate() { throw new Error('provider offline') },
  }
  const result = await new AutoCompactionEngine(
    store,
    generator,
    { ...COMPACT_POLICY, retainRecentTurns: 0 },
  ).compactBeforeTurn(largeSnapshot(2))

  assert.equal(result.reason, 'generator_failed')
  assert.equal(store.failures.length, 1)
  assert.equal(store.failures[0]?.reservation.receiptId, store.reservations[0]?.receiptId)
  assert.equal(store.failures[0]?.error.code, 'generator_failed')
})

test('generator metadata drift is rejected and durably failed', async () => {
  const store = new MemoryArtifactStore()
  const generator: ContextSummaryGenerator = {
    metadata: () => ({ id: 'fixed', model: 'model-a', effort: null, version: '1' }),
    async generate() {
      return {
        summary: 'valid summary text',
        generator: { id: 'fixed', model: 'model-b', effort: null, version: '1' },
      }
    },
  }
  const result = await new AutoCompactionEngine(
    store,
    generator,
    { ...COMPACT_POLICY, retainRecentTurns: 0 },
  ).compactBeforeTurn(largeSnapshot(2))

  assert.equal(result.reason, 'generator_output_invalid')
  assert.equal(store.artifacts.length, 0)
  assert.equal(store.failures[0]?.error.code, 'generator_output_invalid')
})

class MemoryArtifactStore implements ContextCompactionStore {
  artifacts: ContextSummaryArtifact[]
  savedExpectedIds: Array<string | null> = []
  supersede = false
  persistedId: string | null = null
  active: ContextCompactionGenerationReservation | null = null
  reservations: ContextCompactionGenerationReservation[] = []
  failures: Array<{
    reservation: ContextCompactionGenerationReservation
    error: Record<string, unknown>
  }> = []
  reserved: Promise<void>
  #notifyReserved!: () => void

  constructor(artifacts: ContextSummaryArtifact[] = []) {
    this.artifacts = [...artifacts]
    this.reserved = new Promise<void>((resolve) => { this.#notifyReserved = resolve })
  }

  async listArtifacts(): Promise<readonly ContextSummaryArtifact[]> {
    return this.artifacts
  }

  async reserveGeneration(request: ContextCompactionGenerationRequest) {
    if (this.supersede) return { status: 'superseded' as const }
    if (this.active) return { status: 'busy' as const }
    const reservation: ContextCompactionGenerationReservation = {
      receiptId: `receipt-${this.reservations.length + 1}`,
      leaseOwner: `lease-${this.reservations.length + 1}`,
      threadId: request.threadId,
      sourceHash: request.sourceHash,
      summaryInputHash: request.summaryInputHash,
      expectedPreviousArtifactId: request.expectedPreviousArtifactId,
      generator: { ...request.generator },
    }
    this.active = reservation
    this.reservations.push(reservation)
    this.savedExpectedIds.push(request.expectedPreviousArtifactId)
    this.#notifyReserved()
    return { status: 'reserved' as const, reservation }
  }

  async completeGeneration(
    reservation: ContextCompactionGenerationReservation,
    artifact: ContextSummaryArtifact,
  ) {
    if (this.active?.receiptId !== reservation.receiptId) return 'superseded' as const
    this.artifacts.push(this.persistedId === null ? artifact : { ...artifact, id: this.persistedId })
    this.active = null
    return 'stored' as const
  }

  async failGeneration(
    reservation: ContextCompactionGenerationReservation,
    error: Record<string, unknown>,
  ) {
    if (this.active?.receiptId !== reservation.receiptId) return 'superseded' as const
    this.failures.push({ reservation, error })
    this.active = null
    return 'failed' as const
  }

  async saveArtifact(artifact: ContextSummaryArtifact, expectedPreviousArtifactId: string | null) {
    this.savedExpectedIds.push(expectedPreviousArtifactId)
    if (this.supersede) return 'superseded' as const
    this.artifacts.push(this.persistedId === null ? artifact : { ...artifact, id: this.persistedId })
    return 'stored' as const
  }
}

class RecordingGenerator implements ContextSummaryGenerator {
  inputs: ContextSummaryGenerationInput[] = []
  readonly gate: Promise<void> | null

  constructor(gate: Promise<void> | null = null) {
    this.gate = gate
  }

  metadata() {
    return { id: 'test-generator', model: 'test-model', effort: null, version: '1' }
  }

  async generate(input: ContextSummaryGenerationInput) {
    this.inputs.push(input)
    if (this.gate) await this.gate
    return {
      summary: input.previousSummary
        ? `${input.previousSummary.summary}\nplus ${input.items.length} items`
        : `summary of ${input.items.length} items`,
      generator: this.metadata(),
    }
  }
}

function largeSnapshot(completedTurns: number): ThreadSnapshot {
  const turns: CanonicalTurn[] = []
  const items: CanonicalItem[] = []
  let sequence = 1
  for (let index = 1; index <= completedTurns; index += 1) {
    const turnId = `turn-${index}`
    turns.push(turn(turnId, index, 'completed'))
    items.push(item(`user-${index}`, turnId, sequence++, 'user_message', longText(`user ${index}`)))
    if (index === 1) {
      items.push(item('private-1', turnId, sequence++, 'provider_event', { opaque: 'x'.repeat(200) }, 'provider_private'))
    }
    items.push(item(`assistant-${index}`, turnId, sequence++, 'assistant_message', longText(`assistant ${index}`)))
  }
  return makeSnapshot(turns, items)
}

function longText(prefix: string): Record<string, unknown> {
  return { text: `${prefix} ${'context '.repeat(100)}` }
}

function makeSnapshot(turns: CanonicalTurn[], items: CanonicalItem[]): ThreadSnapshot {
  return {
    session: {
      id: 'session-1', title: null, preview: null, activeThreadId: 'thread-1', projectKey: null,
      cwd: null, schemaVersion: 1, createdAt: '2026-07-19T00:00:00Z',
      updatedAt: '2026-07-19T00:00:00Z', archivedAt: null, workStatus: 'idle',
    },
    thread: {
      id: 'thread-1', sessionId: 'session-1', parentThreadId: null, forkTurnId: null, forkItemId: null,
      revision: 1, status: 'idle', instructionSnapshot: {}, createdAt: '2026-07-19T00:00:00Z',
      updatedAt: '2026-07-19T00:00:00Z',
    },
    turns, items, bindings: [],
  }
}

function turn(id: string, sequence: number, status: CanonicalTurn['status']): CanonicalTurn {
  return {
    id, threadId: 'thread-1', goalId: null, goalRevision: null, sequence, provider: 'codex',
    model: 'test', effort: null, status, clientRequestId: `request-${sequence}`,
    startedAt: '2026-07-19T00:00:00Z', completedAt: status === 'completed' ? '2026-07-19T00:01:00Z' : null,
    usage: null, error: null,
  }
}

function item(
  id: string,
  turnId: string,
  sequence: number,
  kind: CanonicalItem['kind'],
  payload: Record<string, unknown>,
  visibility: CanonicalItem['visibility'] = 'portable',
): CanonicalItem {
  return {
    id, sessionId: 'session-1', threadId: 'thread-1', turnId, sequence, kind, visibility, payload,
    provider: visibility === 'provider_private' ? 'codex' : null, nativeId: null,
    createdAt: '2026-07-19T01:00:00Z',
  }
}
