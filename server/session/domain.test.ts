import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_AGENT_LOOP_LIMITS } from './domain.ts'

test('default agent loop has no Baton-only aggregate execution ceilings', () => {
  assert.equal(DEFAULT_AGENT_LOOP_LIMITS.maxModelRoundTrips, null)
  assert.equal(DEFAULT_AGENT_LOOP_LIMITS.maxToolCalls, null)
  assert.equal(DEFAULT_AGENT_LOOP_LIMITS.maxIdenticalToolCalls, null)
  assert.equal(DEFAULT_AGENT_LOOP_LIMITS.turnTimeoutMs, null)
})
