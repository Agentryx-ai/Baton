import assert from 'node:assert/strict'
import test from 'node:test'

import { modelContextDefaults, modelContextWindowTokens } from './model-context-window.ts'

test('model context defaults match current Codex and Claude contracts', () => {
  for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4']) {
    assert.equal(modelContextWindowTokens('codex', model, null), 272_000)
  }
  for (const model of ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5']) {
    assert.equal(modelContextWindowTokens('claude', model, null), 1_000_000)
  }
  assert.equal(modelContextWindowTokens('claude', 'claude-haiku-4-5-20251001', null), 200_000)
})

test('advertised context wins and unknown models fail closed to conservative defaults', () => {
  assert.equal(modelContextWindowTokens('codex', 'gpt-unknown', 400_000), 400_000)
  assert.equal(modelContextWindowTokens('codex', 'gpt-unknown', null), 128_000)
  assert.equal(modelContextWindowTokens('gemini', 'gemini-unknown', null), 128_000)
  assert.equal(modelContextWindowTokens('claude', 'claude-unknown', null), 200_000)
})

test('Codex defaults preserve the native 95 percent input and 90 percent compaction contracts', () => {
  assert.deepEqual(modelContextDefaults('codex', 'gpt-5.6-sol', null), {
    contextWindowTokens: 272_000,
    usableInputTokens: 258_400,
    autoCompactTokens: 244_800,
  })
  assert.deepEqual(modelContextDefaults('claude', 'claude-fable-5', null), {
    contextWindowTokens: 1_000_000,
    usableInputTokens: null,
    autoCompactTokens: null,
  })
})
