import assert from 'node:assert/strict'
import test from 'node:test'

import { contextViewKey } from './context-view-contract.js'

test('context view identity follows provider and effective budget, not exact model name', () => {
  const codex258k = contextViewKey({
    provider: 'codex',
    usableInputTokens: 258_400,
    maximumSummaryTokens: 8_192,
  })
  assert.match(codex258k, /^context-view-v2:[a-f0-9]{64}$/)
  assert.equal(codex258k, contextViewKey({
    provider: 'codex',
    usableInputTokens: 258_400,
    maximumSummaryTokens: 8_192,
  }))
  assert.notEqual(codex258k, contextViewKey({
    provider: 'codex',
    usableInputTokens: 1_000_000,
    maximumSummaryTokens: 8_192,
  }))
  assert.notEqual(codex258k, contextViewKey({
    provider: 'claude',
    usableInputTokens: 258_400,
    maximumSummaryTokens: 8_192,
  }))
})
