import assert from 'node:assert/strict'
import test from 'node:test'

import {
  runSessionRetentionSweep,
  SESSION_RETENTION_BATCH_SIZE,
  SESSION_TRASH_RETENTION_MS,
} from './retention.ts'

test('retention computes an exact 30-day cutoff and drains bounded batches', () => {
  const calls: Array<{ cutoff: string; batchSize: number }> = []
  const counts = [SESSION_RETENTION_BATCH_SIZE, 3]
  const store = {
    purgeExpiredSessions(cutoff: string, batchSize = 0): number {
      calls.push({ cutoff, batchSize })
      return counts.shift() ?? 0
    },
  }
  const now = Date.parse('2026-07-19T00:00:00.000Z')
  assert.equal(runSessionRetentionSweep(store, now), 103)
  assert.deepEqual(calls, [
    { cutoff: new Date(now - SESSION_TRASH_RETENTION_MS).toISOString(), batchSize: 100 },
    { cutoff: new Date(now - SESSION_TRASH_RETENTION_MS).toISOString(), batchSize: 100 },
  ])
})
