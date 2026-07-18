import assert from 'node:assert/strict'
import test from 'node:test'

import { buildProviderModelCatalog } from './model-catalog.ts'

test('Claude catalog follows the web product family order with friendly labels and effort', () => {
  const catalog = buildProviderModelCatalog('claude', [
    'claude-haiku-4-5-20251001',
    'claude-opus-4-7',
    'claude-opus-4-20250514',
    'claude-sonnet-5',
    'claude-fable-5',
    'claude-opus-4-8',
  ])

  assert.deepEqual(catalog.models.map((model) => model.displayName), [
    'Fable 5',
    'Opus 4.8',
    'Sonnet 5',
    'Haiku 4.5',
  ])
  assert.deepEqual(catalog.models[0]?.effortLevels, ['low', 'medium', 'high', 'max'])
  assert.equal(catalog.models.at(-1)?.defaultEffort, null)
})

test('Codex catalog is deterministic and preserves a configured default', () => {
  const catalog = buildProviderModelCatalog('codex', [
    'gpt-5.4-mini',
    'gpt-5.6-terra',
    'gpt-5.6-sol',
    'gpt-5.6-luna',
  ], 'gpt-5.6-terra')

  assert.deepEqual(catalog.models.map((model) => model.id), [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.4-mini',
  ])
  assert.deepEqual(catalog.models.map((model) => model.displayName), [
    'GPT-5.6 Sol',
    'GPT-5.6 Terra',
    'GPT-5.6 Luna',
    'GPT-5.4 Mini',
  ])
  assert.deepEqual(catalog.models.slice(0, 2).map((model) => model.description), [
    '깊은 작업',
    '균형 잡힌 기본 모델',
  ])
  assert.equal(catalog.defaultModel, 'gpt-5.6-terra')
})

test('Gemini remains supported but unavailable when authentication exposes no models', () => {
  assert.deepEqual(buildProviderModelCatalog('gemini', []).models, [])
})
