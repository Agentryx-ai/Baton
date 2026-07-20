import assert from 'node:assert/strict'
import test from 'node:test'

import { pendingModelFallbackOffers } from '../src/api/model-fallback.ts'
import type { ModelFallbackEvent } from '../src/api/types.ts'

const event = (
  id: number,
  type: ModelFallbackEvent['type'],
  preferredModel = 'source',
): ModelFallbackEvent => ({
  id, at: id, type, preferredModel, effectiveModel: 'fallback', reason: 'quota',
})

test('fallback prompt selector hides stale offers after activation, recovery, or disable', () => {
  assert.deepEqual(pendingModelFallbackOffers([event(1, 'available')]).map(({ id }) => id), [1])
  assert.deepEqual(pendingModelFallbackOffers([event(1, 'available'), event(2, 'activated')]), [])
  assert.deepEqual(pendingModelFallbackOffers([
    event(1, 'available'), event(2, 'activated'), event(3, 'recovered'),
  ]), [])
  assert.deepEqual(pendingModelFallbackOffers([
    event(1, 'available'), event(2, 'disabled'), event(3, 'available', 'other-source'),
  ]).map(({ id }) => id), [3])
})
