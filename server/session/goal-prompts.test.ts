import assert from 'node:assert/strict'
import test from 'node:test'

import type { CanonicalGoal } from './domain.ts'
import {
  goalBudgetLimitPrompt,
  goalContinuationPrompt,
  goalObjectiveUpdatedPrompt,
} from './goal-prompts.ts'

function goal(overrides: Partial<CanonicalGoal> = {}): CanonicalGoal {
  return {
    id: 'goal-1', threadId: 'thread-1', objective: 'ship <all> & verify', status: 'active',
    statusReason: null, revision: 2, provider: 'claude', model: 'model', effort: 'high',
    tokenBudget: 100, tokensUsed: 40, timeUsedSeconds: 50, maxAutomaticTurns: 24,
    automaticTurnsUsed: 3, maxActiveSeconds: 7_200, noProgressCount: 0,
    lastProgressDigest: null, createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z', startedAt: '2026-07-19T00:00:00.000Z',
    completedAt: null, verificationProposalId: null, latestCompletionReceiptId: null, latestStopReceiptId: null, ...overrides,
  }
}

test('continuation prompt preserves scope, escapes objective data, and reports every budget', () => {
  const prompt = goalContinuationPrompt(goal())
  assert.match(prompt, /ship &lt;all&gt; &amp; verify/)
  assert.match(prompt, /Tokens remaining: 60/)
  assert.match(prompt, /Automatic turns used: 3\/24/)
  assert.match(prompt, /Active time used: 50\/7200 seconds/)
  assert.match(prompt, /every requirement is proven/i)
  assert.doesNotMatch(prompt, /Codex|Claude|Gemini/)
})

test('updated and limited prompts retain revision and use unbounded token wording', () => {
  const unbounded = goal({ tokenBudget: null })
  assert.match(goalObjectiveUpdatedPrompt(unbounded), /Goal revision: 2/)
  assert.match(goalObjectiveUpdatedPrompt(unbounded), /Tokens remaining: unbounded/)
  assert.match(goalBudgetLimitPrompt(unbounded), /Do not start new substantive work/)
})
