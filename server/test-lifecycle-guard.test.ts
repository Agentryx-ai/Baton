import assert from 'node:assert/strict'
import test from 'node:test'

import { assertLiveBatonUnchanged } from '../scripts/test-lifecycle-guard.mjs'

const baseline = {
  listenerPid: 123,
  health: { ok: true },
  tasks: [{ path: '\\', name: 'Baton-Worker-live', xml: '<Task />' }],
}

test('live Baton guard accepts identical PID, health, and task definitions', () => {
  assert.doesNotThrow(() => assertLiveBatonUnchanged(baseline, structuredClone(baseline)))
})

test('live Baton guard fails closed for each protected invariant', () => {
  assert.throws(
    () => assertLiveBatonUnchanged(baseline, { ...baseline, listenerPid: 456 }),
    /listener PID changed/,
  )
  assert.throws(
    () => assertLiveBatonUnchanged(baseline, { ...baseline, health: { ok: false } }),
    /health changed/,
  )
  assert.throws(
    () => assertLiveBatonUnchanged(baseline, { ...baseline, tasks: [] }),
    /Scheduled Task definitions changed/,
  )
})
