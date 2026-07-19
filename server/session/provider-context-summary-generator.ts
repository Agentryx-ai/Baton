import type {
  NativeProviderEvent,
  ProviderExecutionContext,
  SessionProviderAdapter,
} from './adapter.js'
import type {
  AgentLoopLimits,
  CanonicalProvider,
  NewCanonicalItem,
  ThreadSnapshot,
} from './domain.js'
import { DEFAULT_AGENT_LOOP_LIMITS, uuidV7 } from './domain.js'
import type {
  ContextSummaryGenerationInput,
  ContextSummaryGenerationResult,
  ContextSummaryGenerator,
} from './auto-compaction.js'
import { contextSummaryPromptText } from './context-summary-contract.js'

const SUMMARY_GENERATOR_ID = 'baton-provider-context-summary'
const SUMMARY_GENERATOR_VERSION = '1'
const SUMMARY_TURN_LIMITS: AgentLoopLimits = Object.freeze({
  ...DEFAULT_AGENT_LOOP_LIMITS,
  maxModelRoundTrips: 2,
  maxProviderRetries: 1,
  maxToolCalls: 0,
  turnTimeoutMs: Math.min(DEFAULT_AGENT_LOOP_LIMITS.turnTimeoutMs, 120_000),
})

export interface ProviderContextSummaryGeneratorOptions {
  adapter: SessionProviderAdapter
  adapterVersion: string
  provider: CanonicalProvider
  model: string
  effort: string | null
  snapshot: ThreadSnapshot
}

/**
 * Generates a derived portable summary through the provider selected for the
 * upcoming turn. The execution is ephemeral, receives no tools or private
 * continuation state, and never writes provider events into the canonical
 * ledger. Failure is surfaced to AutoCompactionEngine, which falls back to the
 * last valid artifact or the complete canonical history.
 */
export class ProviderContextSummaryGenerator implements ContextSummaryGenerator {
  readonly #options: ProviderContextSummaryGeneratorOptions

  constructor(options: ProviderContextSummaryGeneratorOptions) {
    if (options.adapter.provider !== options.provider) {
      throw new TypeError('Context summary adapter does not match the selected provider')
    }
    this.#options = options
  }

  metadata(): ContextSummaryGenerationResult['generator'] {
    return {
      id: SUMMARY_GENERATOR_ID,
      model: this.#options.model,
      effort: this.#options.effort,
      version: `${SUMMARY_GENERATOR_VERSION}/${this.#options.adapterVersion}`,
    }
  }

  async generate(input: ContextSummaryGenerationInput): Promise<ContextSummaryGenerationResult> {
    if (input.threadId !== this.#options.snapshot.thread.id) {
      throw new TypeError('Context summary input belongs to a different thread')
    }
    const request = {
      turnId: uuidV7(),
      model: this.#options.model,
      effort: this.#options.effort,
      input: [summaryPromptItem(input)],
    }
    const snapshot = summarySnapshot(this.#options.snapshot)
    this.#options.adapter.validate(request, snapshot)
    const native = this.#options.adapter.materialize(request, snapshot)
    const controller = new AbortController()
    const context: ProviderExecutionContext = {
      signal: controller.signal,
      toolDefinitions: [],
      limits: SUMMARY_TURN_LIMITS,
      executeTool: async () => { throw new Error('Context summary execution exposes no tools') },
      denyApproval: async () => { throw new Error('Context summary execution exposes no approvals') },
      denyToolCall: async () => { throw new Error('Context summary execution exposes no native tools') },
    }
    const execution = await this.#options.adapter.execute(native, context)
    const summaries: string[] = []
    try {
      for await (const event of execution.events) collectAssistantText(this.#options.adapter, event, summaries)
      const terminal = await execution.terminal
      if (terminal.status !== 'completed') {
        const message = typeof terminal.error?.message === 'string'
          ? terminal.error.message
          : `Context summary ended as ${terminal.status}`
        throw new Error(message)
      }
    } finally {
      await execution.dispose()
    }
    const summary = summaries.at(-1)?.trim() ?? ''
    if (!summary) throw new Error('Context summary provider returned no assistant text')
    return {
      summary,
      generator: this.metadata(),
    }
  }
}

function summarySnapshot(snapshot: ThreadSnapshot): ThreadSnapshot {
  return {
    ...snapshot,
    thread: { ...snapshot.thread, instructionSnapshot: {} },
    turns: [],
    items: [],
    bindings: [],
    followUps: [],
    goal: null,
  }
}

function summaryPromptItem(input: ContextSummaryGenerationInput): NewCanonicalItem {
  return {
    kind: 'user_message',
    visibility: 'portable',
    payload: {
      text: contextSummaryPromptText(input),
    },
  }
}

function collectAssistantText(
  adapter: SessionProviderAdapter,
  event: NativeProviderEvent,
  summaries: string[],
): void {
  for (const item of adapter.normalize(event)) {
    if (item.kind !== 'assistant_message' || item.visibility !== 'portable') continue
    const text = typeof item.payload.text === 'string' ? item.payload.text.trim() : ''
    if (text) summaries.push(text)
  }
}
