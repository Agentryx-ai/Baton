import { createHash } from 'node:crypto'

import type { CanonicalProvider, ThreadSnapshot } from './domain.js'
import {
  CONTEXT_SUMMARY_PROMPT_VERSION,
  contextSummaryGenerationInput,
  contextSummaryInputHash,
  contextSummaryTurnReceipt,
  type ContextSummaryGenerationInput,
  type ContextSummaryGeneratorMetadata,
} from './context-summary-contract.js'
import {
  coverageItems,
  CONTEXT_TOKEN_ESTIMATOR_VERSION,
  estimateContextTokens,
  estimateUtf8Tokens,
  materializeContext,
  sourceHashForItems,
  stableContextPrefixes,
  summarySourceItems,
  type ContextSummaryArtifact,
  type MaterializedContext,
} from './context-materializer.js'

export interface AutoCompactionPolicy {
  /** Provider/model input+output context limit from authoritative metadata. */
  contextWindowTokens: number
  /** Output budget that must remain available to the current turn. */
  reservedOutputTokens: number
  /** Additional tokenizer/model uncertainty headroom. */
  safetyMarginTokens: number
  /** Compact when estimated input exceeds this fraction of usable input. */
  triggerRatio: number
  /** Preserve this many most-recent safe terminal turns verbatim. */
  retainRecentTurns: number
  /** Avoid low-value summaries of tiny prefixes. */
  minimumSourceTokens: number
  /** Hard rejection limit for generated summary text. */
  maximumSummaryTokens: number
}

export interface ContextSummaryGenerationResult {
  summary: string
  generator: ContextSummaryGeneratorMetadata
}

export interface AutoCompactionRequestOptions {
  /** Provider whose actual wire-visible context is being estimated. */
  provider?: CanonicalProvider
  /** Upcoming user input, developer instructions, and actual tool schemas. */
  additionalInputTokens?: number
}

export {
  CONTEXT_SUMMARY_PROMPT_VERSION,
  contextSummaryInputHash,
  contextSummaryPromptText,
} from './context-summary-contract.js'
export type {
  ContextSummaryGenerationInput,
  ContextSummaryTurnReceipt,
} from './context-summary-contract.js'

export interface ContextSummaryGenerator {
  /** Exact provider/model contract, fixed before any provider work begins. */
  metadata(): ContextSummaryGeneratorMetadata
  generate(input: ContextSummaryGenerationInput): Promise<ContextSummaryGenerationResult>
}

export interface ContextCompactionGenerationRequest {
  threadId: string
  sourceItemIds: readonly string[]
  sourceHash: string
  summaryInputHash: string
  expectedPreviousArtifactId: string | null
  generator: ContextSummaryGeneratorMetadata
}

export interface ContextCompactionGenerationReservation {
  receiptId: string
  leaseOwner: string
  threadId: string
  sourceHash: string
  summaryInputHash: string
  expectedPreviousArtifactId: string | null
  generator: ContextSummaryGeneratorMetadata
}

export type ContextCompactionReservationResult =
  | { status: 'reserved'; reservation: ContextCompactionGenerationReservation }
  | { status: 'completed' }
  | { status: 'busy' }
  | { status: 'superseded' }

export interface ContextCompactionStore {
  listArtifacts(threadId: string): Promise<readonly ContextSummaryArtifact[]>
  /** Atomically persists the exact request and leases it before provider generation. */
  reserveGeneration(request: ContextCompactionGenerationRequest): Promise<ContextCompactionReservationResult>
  completeGeneration(
    reservation: ContextCompactionGenerationReservation,
    artifact: ContextSummaryArtifact,
  ): Promise<'stored' | 'superseded'>
  failGeneration(
    reservation: ContextCompactionGenerationReservation,
    error: Record<string, unknown>,
  ): Promise<'failed' | 'superseded'>
  /** Must atomically reject a stale writer when the expected frontier changed. */
  saveArtifact?(
    artifact: ContextSummaryArtifact,
    expectedPreviousArtifactId: string | null,
  ): Promise<'stored' | 'superseded'>
}

export type AutoCompactionReason =
  | 'compacted'
  | 'below_threshold'
  | 'active_turn'
  | 'no_stable_prefix'
  | 'no_new_stable_prefix'
  | 'source_too_small'
  | 'canonical_source_invalid'
  | 'artifact_load_failed'
  | 'generator_failed'
  | 'generator_output_invalid'
  | 'store_failed'
  | 'superseded'

export interface AutoCompactionResult {
  reason: AutoCompactionReason
  /** Always usable; failures fall back to a prior valid artifact or full canonical history. */
  context: MaterializedContext
  artifact: ContextSummaryArtifact | null
  inputBudgetTokens: number
  triggerTokens: number
  estimatedTokensBefore: number
  estimatedTokensAfter: number
}

/**
 * Pre-turn-only coordinator. It never mutates canonical items and intentionally
 * has no hook that can run during a provider/tool loop.
 */
export class AutoCompactionEngine {
  readonly #store: ContextCompactionStore
  readonly #generator: ContextSummaryGenerator
  readonly #policy: AutoCompactionPolicy
  readonly #now: () => string
  readonly #inputBudgetTokens: number
  readonly #triggerTokens: number

  constructor(
    store: ContextCompactionStore,
    generator: ContextSummaryGenerator,
    policy: AutoCompactionPolicy,
    now: () => string = () => new Date().toISOString(),
  ) {
    validatePolicy(policy)
    this.#store = store
    this.#generator = generator
    this.#policy = { ...policy }
    this.#now = now
    this.#inputBudgetTokens = policy.contextWindowTokens
      - policy.reservedOutputTokens
      - policy.safetyMarginTokens
    this.#triggerTokens = Math.floor(this.#inputBudgetTokens * policy.triggerRatio)
  }

  async compactBeforeTurn(
    snapshot: ThreadSnapshot,
    options: AutoCompactionRequestOptions = {},
  ): Promise<AutoCompactionResult> {
    const additionalInputTokens = options.additionalInputTokens ?? 0
    if (!Number.isSafeInteger(additionalInputTokens) || additionalInputTokens < 0) {
      throw new TypeError('additionalInputTokens must be a non-negative safe integer')
    }
    let artifacts: readonly ContextSummaryArtifact[] = []
    let current: MaterializedContext
    try {
      artifacts = await this.#store.listArtifacts(snapshot.thread.id)
      current = materializeContext(snapshot, artifacts, options.provider)
    } catch {
      const fallback = materializeContext(snapshot, [], options.provider)
      return this.#result(
        'artifact_load_failed',
        fallback,
        null,
        withAdditionalTokens(fallback.estimatedTokens, additionalInputTokens),
        additionalInputTokens,
      )
    }
    const estimatedTokensBefore = withAdditionalTokens(current.estimatedTokens, additionalInputTokens)

    // A caller invoking this after beginTurn cannot accidentally compact mid-loop.
    if (snapshot.turns.some((turn) =>
      turn.threadId === snapshot.thread.id
        && (turn.status === 'queued' || turn.status === 'running' || turn.status === 'waiting_tool'))) {
      return this.#result('active_turn', current, current.artifact, estimatedTokensBefore, additionalInputTokens)
    }
    if (estimatedTokensBefore <= this.#triggerTokens) {
      return this.#result('below_threshold', current, current.artifact, estimatedTokensBefore, additionalInputTokens)
    }

    const prefixes = stableContextPrefixes(snapshot)
    const candidateIndex = prefixes.length - 1 - this.#policy.retainRecentTurns
    if (candidateIndex < 0) {
      return this.#result('no_stable_prefix', current, current.artifact, estimatedTokensBefore, additionalInputTokens)
    }
    const candidate = prefixes[candidateIndex]!
    if (current.artifact && candidate.throughSequence <= current.artifact.throughSequence) {
      return this.#result('no_new_stable_prefix', current, current.artifact, estimatedTokensBefore, additionalInputTokens)
    }

    const source = coverageItems(snapshot, candidate)
    const portableSource = summarySourceItems(snapshot, candidate)
    let sourceTokens: number
    let sourceHash: string
    try {
      sourceTokens = estimateContextTokens(
        source.map((item) => ({ type: 'canonical_item' as const, item })),
        options.provider,
      )
      sourceHash = sourceHashForItems(source)
    } catch {
      return this.#result('canonical_source_invalid', current, current.artifact,
        estimatedTokensBefore, additionalInputTokens)
    }
    if (source.length === 0 || sourceTokens < this.#policy.minimumSourceTokens) {
      return this.#result('source_too_small', current, current.artifact,
        estimatedTokensBefore, additionalInputTokens)
    }
    const priorIds = new Set(current.artifact?.sourceItemIds ?? [])
    const delta = portableSource.filter((item) => !priorIds.has(item.id))
    const priorTurnIds = new Set(
      current.artifact === null
        ? []
        : stableContextPrefixes(snapshot)
          .find((prefix) => prefix.throughSequence === current.artifact?.throughSequence)
          ?.turns.map((turn) => turn.id) ?? [],
    )
    const turnReceipts = candidate.turns
      .filter((turn) => !priorTurnIds.has(turn.id))
      .map(contextSummaryTurnReceipt)
    const generationInput = contextSummaryGenerationInput({
      threadId: snapshot.thread.id,
      sourceItemIds: source.map((item) => item.id),
      sourceHash,
      throughSequence: candidate.throughSequence,
      previousSummary: current.artifact,
      turns: turnReceipts,
      items: delta,
      maximumSummaryTokens: this.#policy.maximumSummaryTokens,
    })

    let generator: ContextSummaryGeneratorMetadata
    try {
      generator = this.#generator.metadata()
    } catch {
      return this.#result('generator_output_invalid', current, current.artifact,
        estimatedTokensBefore, additionalInputTokens)
    }
    if (!validGeneratorMetadata(generator)) {
      return this.#result('generator_output_invalid', current, current.artifact,
        estimatedTokensBefore, additionalInputTokens)
    }
    const summaryInputHash = contextSummaryInputHash(generationInput, generator)
    let reservationResult: ContextCompactionReservationResult
    try {
      reservationResult = await this.#store.reserveGeneration({
        threadId: snapshot.thread.id,
        sourceItemIds: source.map((item) => item.id),
        sourceHash,
        summaryInputHash,
        expectedPreviousArtifactId: current.artifact?.id ?? null,
        generator: { ...generator },
      })
    } catch {
      return this.#result('store_failed', current, current.artifact,
        estimatedTokensBefore, additionalInputTokens)
    }
    if (reservationResult.status !== 'reserved') {
      try {
        const winning = materializeContext(
          snapshot,
          await this.#store.listArtifacts(snapshot.thread.id),
          options.provider,
        )
        const exactCompleted = reservationResult.status === 'completed'
          && winning.artifact?.sourceHash === sourceHash
          && winning.artifact.summaryInputHash === summaryInputHash
        return this.#result(exactCompleted ? 'compacted' : 'superseded', winning, winning.artifact,
          estimatedTokensBefore, additionalInputTokens)
      } catch {
        return this.#result(
          reservationResult.status === 'completed' ? 'store_failed' : 'superseded',
          current,
          current.artifact,
          estimatedTokensBefore,
          additionalInputTokens,
        )
      }
    }
    const reservation = reservationResult.reservation

    let generated: ContextSummaryGenerationResult
    try {
      generated = await this.#generator.generate(generationInput)
    } catch (error) {
      await this.#recordGenerationFailure(reservation, 'generator_failed', error)
      return this.#result('generator_failed', current, current.artifact,
        estimatedTokensBefore, additionalInputTokens)
    }

    const summary = generated.summary.trim()
    const summaryTokens = summary ? estimateUtf8Tokens(summary) : 0
    if (!summary
      || summaryTokens > this.#policy.maximumSummaryTokens
      || !sameGeneratorMetadata(generated.generator, generator)) {
      await this.#recordGenerationFailure(reservation, 'generator_output_invalid',
        new Error('Context summary output did not match the reserved generation contract'))
      return this.#result('generator_output_invalid', current, current.artifact,
        estimatedTokensBefore, additionalInputTokens)
    }

    const createdAt = this.#now()
    if (!Number.isFinite(Date.parse(createdAt))) {
      await this.#recordGenerationFailure(reservation, 'generator_output_invalid',
        new Error('Context summary timestamp is invalid'))
      return this.#result('generator_output_invalid', current, current.artifact,
        estimatedTokensBefore, additionalInputTokens)
    }
    const artifact: ContextSummaryArtifact = {
      schemaVersion: 1,
      id: artifactId(snapshot.thread.id, sourceHash, generated, createdAt),
      threadId: snapshot.thread.id,
      sourceItemIds: source.map((item) => item.id),
      sourceHash,
      summaryInputHash,
      summaryInput: {
        promptVersion: CONTEXT_SUMMARY_PROMPT_VERSION,
        previousArtifactId: current.artifact?.id ?? null,
        deltaItemIds: delta.map((item) => item.id),
        turnIds: turnReceipts.map((turn) => turn.id),
        maximumSummaryTokens: this.#policy.maximumSummaryTokens,
      },
      throughSequence: candidate.throughSequence,
      summary,
      generator: { ...generator },
      estimatedSummaryTokens: summaryTokens,
      createdAt,
    }

    let saveResult: 'stored' | 'superseded'
    try {
      saveResult = await this.#store.completeGeneration(reservation, artifact)
    } catch {
      return this.#result('store_failed', current, current.artifact,
        estimatedTokensBefore, additionalInputTokens)
    }
    if (saveResult === 'superseded') {
      try {
        const winning = materializeContext(
          snapshot,
          await this.#store.listArtifacts(snapshot.thread.id),
          options.provider,
        )
        return this.#result('superseded', winning, winning.artifact,
          estimatedTokensBefore, additionalInputTokens)
      } catch {
        return this.#result('superseded', current, current.artifact,
          estimatedTokensBefore, additionalInputTokens)
      }
    }

    // Persistence owns the durable artifact identity. Reload it instead of
    // returning the pre-save candidate: a SQLite store may assign its own ID,
    // and an idempotent duplicate may already contain the authoritative text.
    // Returning the candidate would make execution telemetry reference an
    // artifact that does not exist in the durable manifest tables.
    try {
      const persisted = materializeContext(
        snapshot,
        await this.#store.listArtifacts(snapshot.thread.id),
        options.provider,
      )
      if (persisted.artifact?.sourceHash !== artifact.sourceHash
        || persisted.artifact.summaryInputHash !== artifact.summaryInputHash) {
        return this.#result('superseded', persisted, persisted.artifact,
          estimatedTokensBefore, additionalInputTokens)
      }
      return this.#result('compacted', persisted, persisted.artifact,
        estimatedTokensBefore, additionalInputTokens)
    } catch {
      return this.#result('store_failed', current, current.artifact,
        estimatedTokensBefore, additionalInputTokens)
    }
  }

  async #recordGenerationFailure(
    reservation: ContextCompactionGenerationReservation,
    code: 'generator_failed' | 'generator_output_invalid',
    error: unknown,
  ): Promise<void> {
    try {
      await this.#store.failGeneration(reservation, {
        code,
        message: error instanceof Error ? error.message : String(error),
      })
    } catch {
      // The caller still receives a canonical-history fallback. An expired/lost
      // lease remains durably reclaimable by the exact same request.
    }
  }

  #result(
    reason: AutoCompactionReason,
    context: MaterializedContext,
    artifact: ContextSummaryArtifact | null,
    estimatedTokensBefore = context.estimatedTokens,
    additionalInputTokens = 0,
  ): AutoCompactionResult {
    return {
      reason,
      context,
      artifact,
      inputBudgetTokens: this.#inputBudgetTokens,
      triggerTokens: this.#triggerTokens,
      estimatedTokensBefore,
      estimatedTokensAfter: withAdditionalTokens(context.estimatedTokens, additionalInputTokens),
    }
  }
}

function validGeneratorMetadata(value: ContextSummaryGeneratorMetadata): boolean {
  return typeof value.id === 'string' && Boolean(value.id.trim())
    && typeof value.model === 'string' && Boolean(value.model.trim())
    && (value.effort === null || typeof value.effort === 'string')
    && typeof value.version === 'string' && Boolean(value.version.trim())
}

function sameGeneratorMetadata(
  actual: ContextSummaryGeneratorMetadata,
  expected: ContextSummaryGeneratorMetadata,
): boolean {
  return validGeneratorMetadata(actual)
    && actual.id === expected.id
    && actual.model === expected.model
    && actual.effort === expected.effort
    && actual.version === expected.version
}

function withAdditionalTokens(base: number, additional: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, base + additional)
}

function validatePolicy(policy: AutoCompactionPolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isFinite(value)) throw new Error(`${name} must be finite`)
  }
  if (!Number.isSafeInteger(policy.contextWindowTokens) || policy.contextWindowTokens < 1) {
    throw new Error('contextWindowTokens must be a positive safe integer')
  }
  for (const name of [
    'reservedOutputTokens', 'safetyMarginTokens', 'retainRecentTurns',
    'minimumSourceTokens', 'maximumSummaryTokens',
  ] as const) {
    if (!Number.isSafeInteger(policy[name]) || policy[name] < 0) {
      throw new Error(`${name} must be a non-negative safe integer`)
    }
  }
  const inputBudget = policy.contextWindowTokens - policy.reservedOutputTokens - policy.safetyMarginTokens
  if (inputBudget < 1) throw new Error('output reserve and safety margin exhaust the context window')
  if (policy.triggerRatio <= 0 || policy.triggerRatio > 1) {
    throw new Error('triggerRatio must be greater than zero and at most one')
  }
  if (policy.maximumSummaryTokens < 1) throw new Error('maximumSummaryTokens must be positive')
  if (Math.floor(inputBudget * policy.triggerRatio) < 1) throw new Error('trigger threshold must be positive')
}

function artifactId(
  threadId: string,
  sourceHash: string,
  result: ContextSummaryGenerationResult,
  createdAt: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({
      estimator: CONTEXT_TOKEN_ESTIMATOR_VERSION,
      threadId,
      sourceHash,
      summary: result.summary.trim(),
      generator: {
        id: result.generator.id,
        model: result.generator.model,
        effort: result.generator.effort,
        version: result.generator.version,
      },
      createdAt,
    }))
    .digest('hex')
  return `ctx_${digest}`
}
