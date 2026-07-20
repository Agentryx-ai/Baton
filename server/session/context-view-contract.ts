import { createHash } from 'node:crypto'

import type { CanonicalProvider } from './domain.js'
import { CONTEXT_SUMMARY_PROMPT_VERSION } from './context-summary-contract.js'
import { CONTEXT_TOKEN_ESTIMATOR_VERSION } from './context-materializer.js'

export const LEGACY_CONTEXT_VIEW_KEY = 'legacy-v15'
// v2 includes safe leading turnless import records in compaction coverage.
export const CONTEXT_VIEW_CONTRACT_VERSION = 'baton-context-view/v2'

/**
 * Stable identity for a reusable, provider-specific execution view. Models
 * with the same effective budget may share a derived summary; exact model and
 * generator provenance remain recorded on the immutable artifact itself.
 */
export function contextViewKey(input: {
  provider: CanonicalProvider
  usableInputTokens: number
  maximumSummaryTokens: number
}): string {
  if (!Number.isSafeInteger(input.usableInputTokens) || input.usableInputTokens < 1
    || !Number.isSafeInteger(input.maximumSummaryTokens) || input.maximumSummaryTokens < 1) {
    throw new TypeError('Context view token budgets must be positive safe integers')
  }
  const contract = JSON.stringify({
    version: CONTEXT_VIEW_CONTRACT_VERSION,
    provider: input.provider,
    usableInputTokens: input.usableInputTokens,
    maximumSummaryTokens: input.maximumSummaryTokens,
    tokenEstimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION,
    summaryPromptVersion: CONTEXT_SUMMARY_PROMPT_VERSION,
  })
  return `context-view-v2:${createHash('sha256').update(contract).digest('hex')}`
}
