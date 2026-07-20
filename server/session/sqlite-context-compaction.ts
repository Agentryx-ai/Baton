import { createHash, randomUUID } from 'node:crypto'

import type {
  CanonicalExecution,
  CanonicalItem,
  CanonicalProvider,
  ContextCompactionArtifact,
  ExecutionContextSourceRef,
  ThreadSnapshot,
} from './domain.js'
import { ContextPersistenceError, SqliteSessionStore } from './sqlite-store.js'
import type {
  ContextCompactionGenerationRequest,
  ContextCompactionGenerationReservation,
  ContextCompactionReservationResult,
  ContextCompactionStore,
} from './auto-compaction.js'
import type {
  ContextSummaryArtifact,
  MaterializedContext,
  MaterializedContextEntry,
} from './context-materializer.js'
import { LEGACY_CONTEXT_VIEW_KEY } from './context-view-contract.js'

export const CONTEXT_MATERIALIZER_VERSION = 'baton-context-materializer/v2'

/** Exact generation contract namespace; distinct compactor inputs never alias one durable job. */
export function contextCompactionRequestKey(sourceHash: string, summaryInputHash: string): string
export function contextCompactionRequestKey(
  viewKey: string,
  sourceHash: string,
  summaryInputHash: string,
): string
export function contextCompactionRequestKey(
  viewKeyOrSourceHash: string,
  sourceHashOrSummaryInputHash: string,
  optionalSummaryInputHash?: string,
): string {
  const viewKey = optionalSummaryInputHash === undefined
    ? LEGACY_CONTEXT_VIEW_KEY
    : viewKeyOrSourceHash
  const sourceHash = optionalSummaryInputHash === undefined
    ? viewKeyOrSourceHash
    : sourceHashOrSummaryInputHash
  const summaryInputHash = optionalSummaryInputHash ?? sourceHashOrSummaryInputHash
  if (!viewKey || viewKey.length > 120) throw new TypeError('Context view key is invalid')
  if (!/^[0-9a-f]{64}$/u.test(sourceHash) || !/^[0-9a-f]{64}$/u.test(summaryInputHash)) {
    throw new TypeError('Context compaction request hashes must be lowercase SHA-256 digests')
  }
  return `context-v3:${createHash('sha256')
    .update(`${viewKey}\0${sourceHash}\0${summaryInputHash}`)
    .digest('hex')}`
}

/** Durable adapter between the generic pre-turn engine and schema-v14 receipts. */
export class SqliteContextCompactionStore implements ContextCompactionStore {
  readonly #store: SqliteSessionStore
  readonly #provider: CanonicalProvider
  readonly #ownerId: string
  readonly #viewKey: string

  constructor(
    store: SqliteSessionStore,
    provider: CanonicalProvider,
    ownerId: string,
    viewKey = LEGACY_CONTEXT_VIEW_KEY,
  ) {
    this.#store = store
    this.#provider = provider
    this.#ownerId = ownerId
    this.#viewKey = viewKey
  }

  async listArtifacts(threadId: string): Promise<readonly ContextSummaryArtifact[]> {
    const current = this.#store.getLatestContextCompaction(threadId, this.#viewKey)
    return current ? this.#artifactChain(threadId, current.id) : []
  }

  async listArtifactsThrough(
    threadId: string,
    artifactId: string,
  ): Promise<readonly ContextSummaryArtifact[]> {
    return this.#artifactChain(threadId, artifactId)
  }

  #artifactChain(threadId: string, artifactId: string): ContextSummaryArtifact[] {
    let current = this.#store.getContextCompactionArtifact(artifactId)
    if (!current) return []
    const artifacts: ContextSummaryArtifact[] = []
    const visited = new Set<string>()
    while (current !== null) {
      if (current.threadId !== threadId || current.viewKey !== this.#viewKey) {
        throw new ContextPersistenceError(
          'integrity_violation',
          'Compaction artifact belongs to a different thread or context view',
        )
      }
      if (visited.has(current.id)) {
        throw new ContextPersistenceError('integrity_violation', 'Compaction artifact chain contains a cycle')
      }
      visited.add(current.id)
      const converted = contextSummaryArtifact(current)
      if (converted === null) {
        throw new ContextPersistenceError('integrity_violation', 'Compaction artifact summary contract is invalid')
      }
      artifacts.push(converted)
      const previousId = converted.summaryInput.previousArtifactId
      if (previousId === null) break
      current = this.#store.getContextCompactionArtifact(previousId)
      if (current === null) {
        throw new ContextPersistenceError('integrity_violation', 'Compaction artifact chain is incomplete')
      }
    }
    return artifacts.reverse()
  }

  async reserveGeneration(
    request: ContextCompactionGenerationRequest,
  ): Promise<ContextCompactionReservationResult> {
    const leaseOwner = `${this.#ownerId}:${randomUUID()}`
    let created
    try {
      created = this.#store.reserveContextCompactionJob({
        threadId: request.threadId,
        viewKey: this.#viewKey,
        requestKey: contextCompactionRequestKey(
          this.#viewKey,
          request.sourceHash,
          request.summaryInputHash,
        ),
        sourceItemIds: [...request.sourceItemIds],
        summaryInputHash: request.summaryInputHash,
        expectedPreviousArtifactId: request.expectedPreviousArtifactId,
        ownerId: leaseOwner,
        leaseDurationMs: 300_000,
      })
    } catch (error) {
      if (error instanceof ContextPersistenceError
        && (error.code === 'idempotency_conflict' || error.code === 'stale_frontier')) {
        return { status: 'superseded' }
      }
      throw error
    }
    if (created.job.sourceHash !== request.sourceHash
      || created.job.summaryInputHash !== request.summaryInputHash
      || created.job.expectedPreviousArtifactId !== request.expectedPreviousArtifactId) {
      throw new ContextPersistenceError(
        'integrity_violation',
        'Reserved compaction receipt does not match the exact generation contract',
      )
    }
    if (created.job.status === 'completed') return { status: 'completed' }
    if (created.job.status !== 'running' || created.job.leaseOwner !== leaseOwner) return { status: 'busy' }
    return {
      status: 'reserved',
      reservation: {
        receiptId: created.job.id,
        leaseOwner,
        threadId: request.threadId,
        sourceHash: request.sourceHash,
        summaryInputHash: request.summaryInputHash,
        expectedPreviousArtifactId: request.expectedPreviousArtifactId,
        generator: { ...request.generator },
      },
    }
  }

  async completeGeneration(
    reservation: ContextCompactionGenerationReservation,
    artifact: ContextSummaryArtifact,
  ): Promise<'stored' | 'superseded'> {
    if (!sameReservedContract(reservation, artifact)) {
      await this.failGeneration(reservation, {
        code: 'generation_contract_mismatch',
        message: 'Generated summary does not match its durable reservation',
      })
      return 'superseded'
    }
    try {
      this.#store.completeContextCompactionJob({
        jobId: reservation.receiptId,
        ownerId: reservation.leaseOwner,
        summary: summaryReceipt(artifact),
        generatorProvider: this.#provider,
        generatorModel: reservation.generator.model as string,
        generatorVersion: reservation.generator.version,
      })
      return 'stored'
    } catch (error) {
      if (error instanceof ContextPersistenceError && error.code === 'stale_frontier') {
        await this.failGeneration(reservation, {
          code: 'stale_frontier',
          message: 'Compaction head changed before generation completed',
        })
        return 'superseded'
      }
      throw error
    }
  }

  async failGeneration(
    reservation: ContextCompactionGenerationReservation,
    error: Record<string, unknown>,
  ): Promise<'failed' | 'superseded'> {
    try {
      this.#store.failContextCompactionJob({
        jobId: reservation.receiptId,
        ownerId: reservation.leaseOwner,
        error,
      })
      return 'failed'
    } catch (failure) {
      if (failure instanceof ContextPersistenceError
        && (failure.code === 'lease_lost' || failure.code === 'stale_frontier')) {
        return 'superseded'
      }
      throw failure
    }
  }

  async heartbeatGeneration(
    reservation: ContextCompactionGenerationReservation,
  ): Promise<'extended' | 'superseded'> {
    const job = this.#store.claimContextCompactionJob({
      jobId: reservation.receiptId,
      ownerId: reservation.leaseOwner,
      leaseDurationMs: 300_000,
    })
    return job?.status === 'running' && job.leaseOwner === reservation.leaseOwner
      ? 'extended'
      : 'superseded'
  }

  async saveArtifact(
    artifact: ContextSummaryArtifact,
    expectedPreviousArtifactId: string | null,
  ): Promise<'stored' | 'superseded'> {
    if (artifact.summaryInput.previousArtifactId !== expectedPreviousArtifactId) return 'superseded'
    if (!artifact.generator.model) throw new Error('Persisted context summaries require a generator model')

    const leaseOwner = `${this.#ownerId}:${randomUUID()}`
    let created
    try {
      created = this.#store.reserveContextCompactionJob({
        threadId: artifact.threadId,
        viewKey: this.#viewKey,
        requestKey: contextCompactionRequestKey(
          this.#viewKey,
          artifact.sourceHash,
          artifact.summaryInputHash,
        ),
        sourceItemIds: [...artifact.sourceItemIds],
        summaryInputHash: artifact.summaryInputHash,
        expectedPreviousArtifactId,
        ownerId: leaseOwner,
        leaseDurationMs: 300_000,
      })
    } catch (error) {
      if (error instanceof ContextPersistenceError
        && (error.code === 'idempotency_conflict' || error.code === 'stale_frontier')) {
        return 'superseded'
      }
      throw error
    }
    if (created.job.status === 'completed') return 'stored'
    if (created.job.status !== 'running' || created.job.leaseOwner !== leaseOwner) return 'superseded'
    try {
      this.#store.completeContextCompactionJob({
        jobId: created.job.id,
        ownerId: leaseOwner,
        summary: {
          schemaVersion: artifact.schemaVersion,
          text: artifact.summary,
          throughSequence: artifact.throughSequence,
          estimatedSummaryTokens: artifact.estimatedSummaryTokens,
          generatorId: artifact.generator.id,
          generatorEffort: artifact.generator.effort,
          summaryInput: artifact.summaryInput,
          createdAt: artifact.createdAt,
        },
        generatorProvider: this.#provider,
        generatorModel: artifact.generator.model,
        generatorVersion: artifact.generator.version,
      })
      return 'stored'
    } catch (error) {
      try {
        this.#store.failContextCompactionJob({
          jobId: created.job.id,
          ownerId: leaseOwner,
          error: { message: error instanceof Error ? error.message : String(error) },
        })
      } catch {
        // Preserve the primary persistence error; lease loss is recovered by the next request.
      }
      if (error instanceof ContextPersistenceError && error.code === 'stale_frontier') {
        return 'superseded'
      }
      throw error
    }
  }
}

function sameReservedContract(
  reservation: ContextCompactionGenerationReservation,
  artifact: ContextSummaryArtifact,
): boolean {
  return artifact.threadId === reservation.threadId
    && artifact.sourceHash === reservation.sourceHash
    && artifact.summaryInputHash === reservation.summaryInputHash
    && artifact.summaryInput.previousArtifactId === reservation.expectedPreviousArtifactId
    && artifact.generator.id === reservation.generator.id
    && artifact.generator.model === reservation.generator.model
    && artifact.generator.effort === reservation.generator.effort
    && artifact.generator.version === reservation.generator.version
}

function summaryReceipt(artifact: ContextSummaryArtifact): Record<string, unknown> {
  return {
    schemaVersion: artifact.schemaVersion,
    text: artifact.summary,
    throughSequence: artifact.throughSequence,
    estimatedSummaryTokens: artifact.estimatedSummaryTokens,
    generatorId: artifact.generator.id,
    generatorEffort: artifact.generator.effort,
    summaryInput: artifact.summaryInput,
    createdAt: artifact.createdAt,
  }
}

/** Convert a derived selection into the synthetic snapshot given to adapters. */
export function snapshotWithMaterializedContext(
  snapshot: ThreadSnapshot,
  context: MaterializedContext,
): ThreadSnapshot {
  return {
    ...snapshot,
    items: context.entries.map((entry) => materializedItem(snapshot, entry)),
  }
}

/** Persist the exact provider-neutral selection used by one canonical execution. */
export function persistExecutionContextManifest(
  store: SqliteSessionStore,
  execution: CanonicalExecution,
  context: MaterializedContext,
): void {
  const sources: ExecutionContextSourceRef[] = context.entries.map((entry) =>
    entry.type === 'derived_summary'
      ? { kind: 'compaction', compactionId: entry.artifact.id }
      : { kind: 'canonical_item', itemId: entry.item.id })
  store.createExecutionContextManifest({
    executionId: execution.id,
    threadId: execution.threadId,
    materializerVersion: CONTEXT_MATERIALIZER_VERSION,
    materializedContextHash: materializedContextHash(context),
    sources,
  })
}

function contextSummaryArtifact(artifact: ContextCompactionArtifact): ContextSummaryArtifact | null {
  const summary = artifact.summary
  const text = typeof summary.text === 'string' ? summary.text : null
  const throughSequence = Number(summary.throughSequence)
  const estimatedSummaryTokens = Number(summary.estimatedSummaryTokens)
  const generatorId = typeof summary.generatorId === 'string' ? summary.generatorId : null
  const generatorEffort = typeof summary.generatorEffort === 'string' ? summary.generatorEffort : null
  const summaryInput = contextSummaryInput(summary.summaryInput)
  const createdAt = typeof summary.createdAt === 'string' ? summary.createdAt : artifact.createdAt
  if (summary.schemaVersion !== 1 || !text?.trim() || !generatorId?.trim() || summaryInput === null
    || !Number.isSafeInteger(throughSequence) || throughSequence < 1
    || !Number.isSafeInteger(estimatedSummaryTokens) || estimatedSummaryTokens < 1
    || !Number.isFinite(Date.parse(createdAt))) return null
  return {
    schemaVersion: 1,
    id: artifact.id,
    threadId: artifact.threadId,
    sourceItemIds: artifact.sourceItems.map((item) => item.itemId),
    sourceHash: artifact.sourceHash,
    summaryInputHash: artifact.summaryInputHash,
    summaryInput,
    throughSequence,
    summary: text,
    generator: {
      id: generatorId,
      model: artifact.generatorModel,
      effort: generatorEffort,
      version: artifact.generatorVersion,
    },
    estimatedSummaryTokens,
    createdAt,
  }
}

function contextSummaryInput(value: unknown): ContextSummaryArtifact['summaryInput'] | null {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  if (typeof input.promptVersion !== 'string' || !input.promptVersion
    || !(input.previousArtifactId === null || typeof input.previousArtifactId === 'string')
    || !Array.isArray(input.deltaItemIds) || input.deltaItemIds.some((id) => typeof id !== 'string' || !id)
    || !Array.isArray(input.turnIds) || input.turnIds.some((id) => typeof id !== 'string' || !id)
    || !Number.isSafeInteger(input.maximumSummaryTokens) || Number(input.maximumSummaryTokens) < 1) return null
  return {
    promptVersion: input.promptVersion,
    previousArtifactId: input.previousArtifactId,
    deltaItemIds: input.deltaItemIds,
    turnIds: input.turnIds,
    maximumSummaryTokens: Number(input.maximumSummaryTokens),
  } as ContextSummaryArtifact['summaryInput']
}

function materializedItem(snapshot: ThreadSnapshot, entry: MaterializedContextEntry): CanonicalItem {
  if (entry.type === 'canonical_item') return entry.item
  return {
    id: `derived-summary:${entry.artifact.id}`,
    sessionId: snapshot.session.id,
    threadId: snapshot.thread.id,
    turnId: null,
    sequence: 0,
    kind: 'summary',
    visibility: 'portable',
    payload: {
      text: entry.artifact.summary,
      derived: true,
      compactionId: entry.artifact.id,
      throughSequence: entry.artifact.throughSequence,
    },
    provider: null,
    nativeId: null,
    createdAt: entry.artifact.createdAt,
  }
}

function materializedContextHash(context: MaterializedContext): string {
  return createHash('sha256').update(canonicalJson(context.entries.map((entry) =>
    entry.type === 'derived_summary'
      ? { type: 'compaction', id: entry.artifact.id, sourceHash: entry.artifact.sourceHash,
          summaryInputHash: entry.artifact.summaryInputHash, summary: entry.artifact.summary }
      : { type: 'canonical_item', id: entry.item.id, sourceHash: canonicalItemHash(entry.item) },
  ))).digest('hex')
}

function canonicalItemHash(item: CanonicalItem): string {
  return createHash('sha256').update(canonicalJson({
    id: item.id, sessionId: item.sessionId, threadId: item.threadId, turnId: item.turnId,
    sequence: item.sequence, kind: item.kind, visibility: item.visibility, payload: item.payload,
    provider: item.provider, nativeId: item.nativeId, createdAt: item.createdAt,
  })).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Context manifest contains a non-finite number')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value !== 'object') throw new TypeError('Context manifest must be JSON-compatible')
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}
