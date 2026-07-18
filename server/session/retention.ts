import type { SessionStore } from './store.ts'

export const SESSION_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
export const SESSION_RETENTION_INTERVAL_MS = 60 * 60 * 1_000
export const SESSION_RETENTION_BATCH_SIZE = 100
const MAX_BATCHES_PER_SWEEP = 5

export function runSessionRetentionSweep(
  store: Pick<SessionStore, 'purgeExpiredSessions'>,
  now = Date.now(),
): number {
  const cutoff = new Date(now - SESSION_TRASH_RETENTION_MS).toISOString()
  let purged = 0
  for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch += 1) {
    const count = store.purgeExpiredSessions(cutoff, SESSION_RETENTION_BATCH_SIZE)
    purged += count
    if (count < SESSION_RETENTION_BATCH_SIZE) break
  }
  return purged
}
