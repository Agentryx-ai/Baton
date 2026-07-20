import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ModelFallbackRuntime } from './model-fallback-runtime.ts'

test('model fallback opt-in and active override survive restart without changing preferred model', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'baton-model-fallback-'))
  const filePath = path.join(directory, 'state.json')
  const first = new ModelFallbackRuntime({ filePath, now: () => 1_000 })
  assert.equal(first.status().enabled, false)
  first.update({ enabled: true, userMappings: { preferred: ['effective'] } })
  first.controller.noteExhausted('preferred')
  first.persist()

  const restarted = new ModelFallbackRuntime({ filePath, now: () => 2_000 })
  assert.equal(restarted.status().enabled, true)
  assert.equal(restarted.status().active[0]?.preferredModel, 'preferred')
  assert.equal(restarted.status().active[0]?.effectiveModel, 'effective')
  assert.doesNotMatch(readFileSync(filePath, 'utf8'), /access[_-]?token|refresh[_-]?token/i)

  restarted.update({ enabled: false })
  assert.deepEqual(new ModelFallbackRuntime({ filePath }).status().active, [])
})

test('model fallback restart rejects malformed persisted shapes and fails closed', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'baton-model-fallback-corrupt-'))
  const filePath = path.join(directory, 'state.json')
  writeFileSync(filePath, JSON.stringify({
    version: 1,
    enabled: 'yes',
    promptDismissed: true,
    userMappings: { valid: ['fallback'], invalid: [42] },
    active: { preferredModel: 'not-an-array' },
    events: [
      { id: 'bad', at: 1, type: 'activated' },
      {
        id: 2,
        at: 1_000,
        type: 'recovered',
        preferredModel: 'valid',
        effectiveModel: 'valid',
        reason: 'quota',
      },
    ],
  }))

  const status = new ModelFallbackRuntime({ filePath }).status()
  assert.equal(status.enabled, false)
  assert.equal(status.promptDismissed, true)
  assert.deepEqual(status.userMappings, { valid: ['fallback'] })
  assert.deepEqual(status.active, [])
  assert.equal(status.events.length, 1)
  assert.equal(status.events[0]?.type, 'recovered')
})
