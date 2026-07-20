import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ModelFallbackController,
  parseModelFallbackCapabilities,
  parseServerFallbackEvent,
  parseStructuredRefusal,
  resolveFallbackCapability,
} from './model-fallback.ts'

test('fallback capability resolver prefers authoritative server data and is model-generic', () => {
  const server = parseModelFallbackCapabilities({ data: [
    { id: 'model-a', allowed_fallback_models: [{ model: 'model-b' }, 'model-c', 'model-b'] },
    { id: 'server-forbids-fallback', allowed_fallback_models: [] },
  ] })
  assert.deepEqual(server.get('model-a'), ['model-b', 'model-c'])
  assert.deepEqual(resolveFallbackCapability({
    sourceModel: 'model-a', server, user: { 'model-a': ['user-model'] },
    compatibility: { 'model-a': ['compat-model'] }, reason: 'quota',
  }), {
    sourceModel: 'model-a', fallbackModels: ['model-b', 'model-c'],
    reasonCategories: ['quota'], direction: 'retry', resetHint: null, provenance: 'server',
  })
  assert.equal(resolveFallbackCapability({
    sourceModel: 'server-forbids-fallback', server,
    compatibility: { 'server-forbids-fallback': ['must-not-run'] }, reason: 'quota',
  }), null)
})

test('fallback capability resolver uses user mapping then compatibility seed only when server is silent', () => {
  const server = new Map<string, string[]>()
  assert.equal(resolveFallbackCapability({
    sourceModel: 'custom-source', server, user: { 'custom-source': ['custom-fallback'] }, reason: 'quota',
  })?.provenance, 'user')
  assert.equal(resolveFallbackCapability({
    sourceModel: 'claude-fable-5', server,
    compatibility: { 'claude-fable-5': ['claude-opus-4-8'] }, reason: 'quota',
  })?.fallbackModels[0], 'claude-opus-4-8')
})

test('quota fallback is opt-in, keeps preferred/effective models separate, probes, and recovers', () => {
  let now = 1_000
  const controller = new ModelFallbackController({
    now: () => now,
    probeIntervalMs: 60_000,
    compatibility: { 'source-model': ['fallback-model'] },
  })
  assert.equal(controller.noteExhausted('source-model')?.fallbackModels[0], 'fallback-model')
  assert.deepEqual(controller.status().active, [])
  assert.equal(controller.status().events[0]?.type, 'available')

  controller.setEnabled(true)
  controller.noteExhausted('source-model', 50_000)
  assert.deepEqual(controller.requestModel('source-model'), { model: 'fallback-model', probing: false })
  now = 2_000
  assert.deepEqual(controller.requestModel('source-model'), { model: 'fallback-model', probing: false })
  now = 50_000
  assert.deepEqual(controller.requestModel('source-model'), { model: 'source-model', probing: true })
  controller.recovered('source-model')
  assert.deepEqual(controller.requestModel('source-model'), { model: 'source-model', probing: false })
  assert.equal(controller.status().events.at(-1)?.type, 'recovered')
})

test('disabling automatic fallback clears runtime override without changing the preferred model', () => {
  const controller = new ModelFallbackController({
    enabled: true,
    compatibility: { preferred: ['effective'] },
  })
  controller.noteExhausted('preferred')
  assert.equal(controller.status().active[0]?.preferredModel, 'preferred')
  controller.setEnabled(false)
  assert.deepEqual(controller.status().active, [])
  assert.deepEqual(controller.requestModel('preferred'), { model: 'preferred', probing: false })
})

test('structured safety parsers accept only explicit provider contracts', () => {
  assert.deepEqual(parseStructuredRefusal({
    stop_reason: 'refusal', stop_details: { category: 'policy' },
  }), { category: 'policy' })
  assert.equal(parseStructuredRefusal({ message: 'looks unsafe' }), null)
  assert.deepEqual(parseServerFallbackEvent({
    type: 'system', subtype: 'model_refusal_fallback', direction: 'retry',
    original_model: 'model-a', fallback_model: 'model-b', category: 'policy',
  }), {
    direction: 'retry', preferredModel: 'model-a', effectiveModel: 'model-b', category: 'policy',
  })
  assert.equal(parseServerFallbackEvent({
    type: 'system', subtype: 'model_refusal_fallback', direction: 'unknown',
    original_model: 'model-a', fallback_model: 'model-b',
  }), null)
})
