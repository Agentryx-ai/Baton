import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeAddStatus } from '../src/api/client.ts'

test('normalizes current gateway OAuth success responses', () => {
  assert.deepEqual(normalizeAddStatus({ success: true }), { status: 'success' })
  assert.deepEqual(normalizeAddStatus({ status: 'ok' }), { status: 'success' })
})

test('preserves wait and error OAuth responses', () => {
  assert.deepEqual(normalizeAddStatus({ status: 'wait' }), { status: 'wait' })
  assert.deepEqual(normalizeAddStatus({ status: 'error', error: 'expired' }), {
    status: 'error',
    error: 'expired',
  })
})
