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

const CONSERVATIVE_CONTEXT_WINDOW_TOKENS = 128_000

export interface ContextTurnAdapter {
  adapter: SessionProviderAdapter
  handshake: AdapterHandshake
}

export interface CanonicalContextRuntimeContract {
  assertUpcomingInputFits(input: {
    ready: ContextTurnAdapter
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
    instructionSnapshot: Record<string, unknown>
    upcomingInput: readonly NewCanonicalItem[]
    toolDefinitions: readonly AgentToolDefinition[]
  }): { additionalInputTokens: number; inputBudgetTokens: number } {
    const policy = autoCompactionPolicy(input.ready.handshake.capabilities.contextWindow)
    const additionalInputTokens = estimateUpcomingInputTokens(
      input.instructionSnapshot,
      input.upcomingInput,
      input.toolDefinitions,
    )
    const inputBudgetTokens = policy.contextWindowTokens
      - policy.reservedOutputTokens
      - policy.safetyMarginTokens
    if (additionalInputTokens > inputBudgetTokens) {
      throw new ContextInputTooLargeError(additionalInputTokens, inputBudgetTokens)
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
    const policy = autoCompactionPolicy(input.ready.handshake.capabilities.contextWindow)
    const { additionalInputTokens, inputBudgetTokens } = this.assertUpcomingInputFits({
      ready: input.ready,
      instructionSnapshot: input.snapshot.thread.instructionSnapshot,
      upcomingInput: input.upcomingInput,
      toolDefinitions: input.toolDefinitions,
    })
    let result: AutoCompactionResult | null = null
    try {
      const artifactStore = new SqliteContextCompactionStore(
        this.#store,
        input.provider,
        this.#ownerId,
      )
      const generator = new ProviderContextSummaryGenerator({
        adapter: input.ready.adapter,
        adapterVersion: input.ready.handshake.adapterVersion,
        provider: input.provider,
        model: input.model,
        effort: input.effort,
        snapshot: input.snapshot,
      })
      result = await new AutoCompactionEngine(
        artifactStore,
        generator,
        policy,
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
      throw new ContextInputTooLargeError(estimatedTokensAfter, inputBudgetTokens)
    }
    return result
  }

  async materializeForExecution(input: {
    snapshot: ThreadSnapshot
    execution: CanonicalExecution
    provider: CanonicalProvider
  }): Promise<ThreadSnapshot> {
    const artifactStore = new SqliteContextCompactionStore(
      this.#store,
      input.provider,
      this.#ownerId,
    )
    let context
    try {
      const artifacts = await artifactStore.listArtifacts(input.snapshot.thread.id)
      context = materializeContext(input.snapshot, artifacts, input.provider)
    } catch {
      // Derived state must never block a canonical user turn. The manifest
      // still records the exact full-history fallback selected here.
      context = materializeContext(input.snapshot, [], input.provider)
    }
    persistExecutionContextManifest(this.#store, input.execution, context)
    return snapshotWithMaterializedContext(input.snapshot, context)
  }
}

export class ContextInputTooLargeError extends Error {
  readonly code = 'context_input_too_large'
  readonly estimatedInputTokens: number
  readonly usableInputTokens: number

  constructor(
    estimatedInputTokens: number,
    usableInputTokens: number,
  ) {
    super(`Upcoming input requires approximately ${estimatedInputTokens} tokens; usable input budget is ${usableInputTokens}`)
    this.name = 'ContextInputTooLargeError'
    this.estimatedInputTokens = estimatedInputTokens
    this.usableInputTokens = usableInputTokens
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
    : CONSERVATIVE_CONTEXT_WINDOW_TOKENS
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
