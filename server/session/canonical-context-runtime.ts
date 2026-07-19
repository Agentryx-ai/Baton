import type {
  AdapterHandshake,
  SessionProviderAdapter,
} from './adapter.js'
import {
  AutoCompactionEngine,
  type AutoCompactionPolicy,
  type AutoCompactionResult,
} from './auto-compaction.js'
import type {
  CanonicalExecution,
  CanonicalProvider,
  NewCanonicalItem,
  ThreadSnapshot,
} from './domain.js'
import type { AgentToolDefinition } from './domain.js'
import { estimateUtf8Tokens, materializeContext } from './context-materializer.js'
import { ProviderContextSummaryGenerator } from './provider-context-summary-generator.js'
import {
  persistExecutionContextManifest,
  snapshotWithMaterializedContext,
  SqliteContextCompactionStore,
} from './sqlite-context-compaction.js'
import { SqliteSessionStore } from './sqlite-store.js'
import { modelContextDefaults } from './model-context-window.js'
import { contextViewKey } from './context-view-contract.js'

export interface ContextTurnAdapter {
  adapter: SessionProviderAdapter
  handshake: AdapterHandshake
}

export interface CanonicalContextRuntimeContract {
  assertUpcomingInputFits(input: {
    ready: ContextTurnAdapter
    provider: CanonicalProvider
    model: string
    instructionSnapshot: Record<string, unknown>
    upcomingInput: readonly NewCanonicalItem[]
    toolDefinitions: readonly AgentToolDefinition[]
  }): { additionalInputTokens: number; inputBudgetTokens: number }
  compactBeforeTurn(input: {
    snapshot: ThreadSnapshot
    ready: ContextTurnAdapter
    provider: CanonicalProvider
    model: string
    effort: string | null
    upcomingInput: readonly NewCanonicalItem[]
    toolDefinitions: readonly AgentToolDefinition[]
  }): Promise<AutoCompactionResult | null>
  materializeForExecution(input: {
    snapshot: ThreadSnapshot
    execution: CanonicalExecution
    provider: CanonicalProvider
  }): Promise<ThreadSnapshot>
}

/** Runtime wiring for pre-turn compaction and per-execution provenance. */
export class CanonicalContextRuntime implements CanonicalContextRuntimeContract {
  readonly #store: SqliteSessionStore
  readonly #ownerId: string

  constructor(store: SqliteSessionStore, ownerId = `context-${process.pid}-${Date.now()}`) {
    this.#store = store
    this.#ownerId = ownerId
  }

  assertUpcomingInputFits(input: {
    ready: ContextTurnAdapter
    provider: CanonicalProvider
    model: string
    instructionSnapshot: Record<string, unknown>
    upcomingInput: readonly NewCanonicalItem[]
    toolDefinitions: readonly AgentToolDefinition[]
  }): { additionalInputTokens: number; inputBudgetTokens: number } {
    const policy = modelAutoCompactionPolicy(
      input.provider,
      input.model,
      input.ready.handshake.capabilities.contextWindow,
    )
    const additionalInputTokens = estimateUpcomingInputTokens(
      input.instructionSnapshot,
      input.upcomingInput,
      input.toolDefinitions,
    )
    const inputBudgetTokens = policy.contextWindowTokens
      - policy.reservedOutputTokens
      - policy.safetyMarginTokens
    if (additionalInputTokens > inputBudgetTokens) {
      throw new ContextInputTooLargeError({
        estimatedInputTokens: additionalInputTokens,
        usableInputTokens: inputBudgetTokens,
        contextWindowTokens: policy.contextWindowTokens,
        provider: input.provider,
        model: input.model,
        compactionReason: 'upcoming_input',
      })
    }
    return { additionalInputTokens, inputBudgetTokens }
  }

  async compactBeforeTurn(input: {
    snapshot: ThreadSnapshot
    ready: ContextTurnAdapter
    provider: CanonicalProvider
    model: string
    effort: string | null
    upcomingInput: readonly NewCanonicalItem[]
    toolDefinitions: readonly AgentToolDefinition[]
  }): Promise<AutoCompactionResult | null> {
    const policy = modelAutoCompactionPolicy(
      input.provider,
      input.model,
      input.ready.handshake.capabilities.contextWindow,
    )
    const { additionalInputTokens, inputBudgetTokens } = this.assertUpcomingInputFits({
      ready: input.ready,
      provider: input.provider,
      model: input.model,
      instructionSnapshot: input.snapshot.thread.instructionSnapshot,
      upcomingInput: input.upcomingInput,
      toolDefinitions: input.toolDefinitions,
    })
    let result: AutoCompactionResult | null = null
    const viewKey = contextViewKey({
      provider: input.provider,
      usableInputTokens: inputBudgetTokens,
      maximumSummaryTokens: policy.maximumSummaryTokens,
    })
    try {
      const artifactStore = new SqliteContextCompactionStore(
        this.#store,
        input.provider,
        this.#ownerId,
        viewKey,
      )
      const generator = new ProviderContextSummaryGenerator({
        adapter: input.ready.adapter,
        adapterVersion: input.ready.handshake.adapterVersion,
        provider: input.provider,
        model: input.model,
        effort: input.effort,
        snapshot: input.snapshot,
        inputBudgetTokens,
      })
      result = await new AutoCompactionEngine(
        artifactStore,
        generator,
        policy,
        undefined,
        viewKey,
      ).compactBeforeTurn(input.snapshot, {
        provider: input.provider,
        additionalInputTokens,
      })
    } catch {
      // Compaction is derived optimization. Fall back to the complete
      // canonical context, but still enforce the provider input budget below.
      result = null
    }
    const estimatedTokensAfter = result?.estimatedTokensAfter
      ?? Math.min(
        Number.MAX_SAFE_INTEGER,
        materializeContext(input.snapshot, [], input.provider).estimatedTokens + additionalInputTokens,
      )
    if (estimatedTokensAfter > inputBudgetTokens) {
      throw new ContextInputTooLargeError({
        estimatedInputTokens: estimatedTokensAfter,
        usableInputTokens: inputBudgetTokens,
        contextWindowTokens: policy.contextWindowTokens,
        provider: input.provider,
        model: input.model,
        compactionReason: result?.reason ?? 'generator_unavailable',
      })
    }
    return result
  }

  async materializeForExecution(input: {
    snapshot: ThreadSnapshot
    execution: CanonicalExecution
    provider: CanonicalProvider
  }): Promise<ThreadSnapshot> {
    const selection = contextSelection(input.execution.budget)
    if (selection === null || selection.artifactId === null) {
      const context = materializeContext(input.snapshot, [], input.provider)
      persistExecutionContextManifest(this.#store, input.execution, context)
      return snapshotWithMaterializedContext(input.snapshot, context)
    }
    const artifactStore = new SqliteContextCompactionStore(
      this.#store,
      input.provider,
      this.#ownerId,
      selection.viewKey,
    )
    let context
    try {
      const artifacts = await artifactStore.listArtifactsThrough(
        input.snapshot.thread.id,
        selection.artifactId,
      )
      context = materializeContext(input.snapshot, artifacts, input.provider)
      if (context.artifact?.id !== selection.artifactId) {
        throw new Error('Persisted context selection did not materialize the selected artifact')
      }
    } catch (error) {
      // Once a derived selection is frozen in the execution receipt, silently
      // replacing it with a potentially over-budget full ledger would violate
      // both replay identity and the provider limit checked before beginTurn.
      throw new Error('Selected execution context artifact is unavailable or invalid', { cause: error })
    }
    persistExecutionContextManifest(this.#store, input.execution, context)
    return snapshotWithMaterializedContext(input.snapshot, context)
  }
}

function contextSelection(budget: Record<string, unknown>): {
  viewKey: string
  artifactId: string | null
} | null {
  const value = budget.contextCompaction
  if (value === null || Array.isArray(value) || typeof value !== 'object') return null
  const selection = value as Record<string, unknown>
  if (typeof selection.viewKey !== 'string' || !selection.viewKey
    || !(selection.artifactId === null || typeof selection.artifactId === 'string')) return null
  return { viewKey: selection.viewKey, artifactId: selection.artifactId }
}

export class ContextInputTooLargeError extends Error {
  readonly code = 'context_input_too_large'
  readonly estimatedInputTokens: number
  readonly usableInputTokens: number
  readonly contextWindowTokens: number
  readonly provider: CanonicalProvider
  readonly model: string
  readonly compactionReason: string

  constructor(input: {
    estimatedInputTokens: number
    usableInputTokens: number
    contextWindowTokens: number
    provider: CanonicalProvider
    model: string
    compactionReason: string
  }) {
    super(`Upcoming input requires approximately ${input.estimatedInputTokens} tokens; usable input budget is ${input.usableInputTokens} for ${input.model} (${input.contextWindowTokens} context tokens); compaction=${input.compactionReason}`)
    this.name = 'ContextInputTooLargeError'
    this.estimatedInputTokens = input.estimatedInputTokens
    this.usableInputTokens = input.usableInputTokens
    this.contextWindowTokens = input.contextWindowTokens
    this.provider = input.provider
    this.model = input.model
    this.compactionReason = input.compactionReason
  }
}

function estimateUpcomingInputTokens(
  instructionSnapshot: Record<string, unknown>,
  upcomingInput: readonly NewCanonicalItem[],
  toolDefinitions: readonly AgentToolDefinition[],
): number {
  try {
    return 64 + estimateUtf8Tokens(JSON.stringify({
      developerInstructions: instructionSnapshot,
      upcomingInput,
      toolDefinitions,
    }))
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

export function autoCompactionPolicy(contextWindow: number | null): AutoCompactionPolicy {
  const contextWindowTokens = contextWindow && Number.isSafeInteger(contextWindow) && contextWindow > 0
    ? contextWindow
    : 128_000
  const reservedOutputTokens = Math.min(16_384, Math.max(2_048, Math.floor(contextWindowTokens / 8)))
  const safetyMarginTokens = Math.min(8_192, Math.max(1_024, Math.floor(contextWindowTokens / 16)))
  const usable = contextWindowTokens - reservedOutputTokens - safetyMarginTokens
  return {
    contextWindowTokens,
    reservedOutputTokens,
    safetyMarginTokens,
    triggerRatio: 0.8,
    retainRecentTurns: 2,
    minimumSourceTokens: Math.min(4_096, Math.max(256, Math.floor(usable / 32))),
    maximumSummaryTokens: Math.min(8_192, Math.max(1_024, Math.floor(usable / 16))),
  }
}

export function modelAutoCompactionPolicy(
  provider: CanonicalProvider,
  model: string,
  advertisedContextWindow: number | null,
): AutoCompactionPolicy {
  const defaults = modelContextDefaults(provider, model, advertisedContextWindow)
  const policy = autoCompactionPolicy(defaults.contextWindowTokens)
  if (defaults.usableInputTokens === null || defaults.autoCompactTokens === null) return policy
  return {
    ...policy,
    reservedOutputTokens: defaults.contextWindowTokens - defaults.usableInputTokens,
    safetyMarginTokens: 0,
    triggerRatio: defaults.autoCompactTokens / defaults.usableInputTokens,
  }
}
