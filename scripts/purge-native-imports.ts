/**
 * Purge imported native sessions so they can be re-imported cleanly.
 *
 * Baton has no dedicated "delete all imports" command. Soft-deleting an
 * imported conversation leaves its `native_session_sources` provenance row in
 * place, so a subsequent re-import is treated as a duplicate and becomes a
 * no-op. This script removes imported sessions *and* their provenance rows by
 * reusing the store's audited `purgeExpiredSessions` deletion, which drops the
 * whole session subtree (items/threads/turns) and every `native_*` table in
 * foreign-key-safe order.
 *
 * Import-owned sessions are exactly those with a `native_session_sources` row
 * (Baton-native conversations have none). To scope the purge to only those, we
 * stamp each target session's `archived_at` with an epoch sentinel and purge
 * with a cutoff just above it; real trashed sessions carry 20xx timestamps and
 * are therefore excluded.
 *
 * Usage:
 *   tsx scripts/purge-native-imports.ts                 # dry-run: list targets
 *   tsx scripts/purge-native-imports.ts --apply         # back up + purge
 *   tsx scripts/purge-native-imports.ts --only-untouched --apply
 *   tsx scripts/purge-native-imports.ts --database <path> [...]
 *
 * The server MUST be stopped before running with --apply.
 */
import { access, copyFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { SqliteSessionStore } from '../server/session/sqlite-store.ts'

// Sentinel far below any real (20xx) archived_at, so the purge cutoff catches
// only sessions this script marked and never a genuinely trashed session.
const SENTINEL_ARCHIVED_AT = '1970-01-01T00:00:00.000Z'
const PURGE_CUTOFF = '1970-01-01T00:00:01.000Z'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const onlyUntouched = args.includes('--only-untouched')
const database = argument('--database') ?? path.join(
  process.env.BATON_DATA_DIR ?? path.join(process.env.LOCALAPPDATA ?? homedir(), 'Baton'),
  'canonical-conversations.sqlite3',
)
await access(database)

interface ImportRow {
  session_id: string
  title: string | null
  source_client: string
  native_session_id: string
  last_imported_at: string
  thread_count: number
  turn_count: number
}

const inspect = new DatabaseSync(database, { readOnly: true })
let targets: ImportRow[]
try {
  targets = inspect.prepare(`
    SELECT
      ns.session_id            AS session_id,
      s.title                  AS title,
      ns.source_client         AS source_client,
      ns.native_session_id     AS native_session_id,
      ns.last_imported_at      AS last_imported_at,
      (SELECT COUNT(*) FROM threads th WHERE th.session_id = ns.session_id) AS thread_count,
      (SELECT COUNT(*) FROM turns t
         JOIN threads th ON th.id = t.thread_id
        WHERE th.session_id = ns.session_id)                                AS turn_count
    FROM native_session_sources ns
    JOIN sessions s ON s.id = ns.session_id
    ORDER BY ns.last_imported_at
  `).all() as unknown as ImportRow[]
} finally {
  inspect.close()
}

// A session is "touched" once Baton work (a fork thread or any turn) has been
// layered onto the imported fork_copy; purging it discards that work too.
const isTouched = (row: ImportRow) => row.turn_count > 0 || row.thread_count > 1
const touched = targets.filter(isTouched)
const selected = onlyUntouched ? targets.filter((row) => !isTouched(row)) : targets

console.log(`Database: ${database}`)
console.log(`Imported sessions found: ${targets.length} (with Baton work added: ${touched.length})`)
if (onlyUntouched) {
  console.log(`--only-untouched: skipping ${touched.length} touched session(s); ${selected.length} eligible.`)
}
console.log('')
for (const row of selected) {
  const mark = isTouched(row) ? '  ⚠ has Baton work' : ''
  const title = row.title ? ` "${row.title}"` : ''
  console.log(`- [${row.source_client}] ${row.session_id}${title} (native ${row.native_session_id})${mark}`)
}
if (!onlyUntouched && touched.length > 0) {
  console.log('')
  console.log(`⚠ ${touched.length} of these have forks/turns you added after import.`)
  console.log('  Purging them discards that Baton work. Use --only-untouched to keep them.')
}

if (selected.length === 0) {
  console.log('\nNothing to purge.')
  process.exit(0)
}

if (!apply) {
  console.log(`\nDry-run. Re-run with --apply to back up and purge ${selected.length} session(s).`)
  process.exit(0)
}

await warnIfServerRunning()

// Back up the whole DB (+ WAL/SHM sidecars) before any destructive write.
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = `${database}.backup-${stamp}`
await copyFile(database, backup)
for (const suffix of ['-wal', '-shm']) {
  try {
    await copyFile(`${database}${suffix}`, `${backup}${suffix}`)
  } catch {
    /* sidecar absent when the DB is cleanly checkpointed */
  }
}
console.log(`\nBackup written: ${backup}`)

// Mark selected sessions with the sentinel via a dedicated connection.
const marker = new DatabaseSync(database)
try {
  const stmt = marker.prepare('UPDATE sessions SET archived_at = ? WHERE id = ?')
  marker.exec('BEGIN IMMEDIATE')
  try {
    for (const row of selected) stmt.run(SENTINEL_ARCHIVED_AT, row.session_id)
    marker.exec('COMMIT')
  } catch (error) {
    marker.exec('ROLLBACK')
    throw error
  }
} finally {
  marker.close()
}

// Reuse the audited purge path. Small batches keep each write transaction —
// and therefore the database write lock — short, and a WAL checkpoint between
// batches stops the log from ballooning during a large purge.
const store = new SqliteSessionStore(database)
let purged = 0
const startedAt = Date.now()
try {
  for (;;) {
    const batchStarted = Date.now()
    const count = store.purgeExpiredSessions(PURGE_CUTOFF, 25)
    if (count === 0) break
    purged += count
    store.checkpointWal()
    console.log(`  purged ${purged}/${selected.length} (batch of ${count} in ${Date.now() - batchStarted}ms)`)
  }
} finally {
  store.close()
}
console.log(`Total purge time: ${Math.round((Date.now() - startedAt) / 1000)}s`)

console.log(`\nPurged ${purged} imported session(s). Re-import from Baton to bring them back fresh.`)
console.log(JSON.stringify({ mode: 'apply', database, backup, purged }, null, 2))

function argument(name: string): string | null {
  const index = args.indexOf(name)
  if (index === -1) return null
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function warnIfServerRunning(): Promise<void> {
  const port = Number(process.env.BATON_PORT ?? 4400)
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (running: boolean) => {
      socket.destroy()
      if (running) {
        console.log(`\n⚠ A process is listening on 127.0.0.1:${port} — Baton may be running.`)
        console.log('  Stop the server before purging to avoid state divergence, then re-run.')
        process.exit(1)
      }
      resolve()
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}
