import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { SqliteSessionStore } from '../server/session/sqlite-store.ts'
import { ClaudeLocalSourceReader } from '../server/session/native-import/claude-source.ts'
import { CodexLocalSourceReader } from '../server/session/native-import/codex-source.ts'
import { restoreImportedNativeGoals } from '../server/session/native-import/goal-restoration.ts'
import type { NativeSourceClient } from '../server/session/native-import/contracts.ts'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const database = argument('--database') ?? path.join(
  process.env.BATON_DATA_DIR ?? path.join(process.env.LOCALAPPDATA ?? homedir(), 'Baton'),
  'canonical-conversations.sqlite3',
)
const source = argument('--source') ?? 'all'
if (!['all', 'codex', 'claude'].includes(source)) {
  throw new Error('--source must be all, codex, or claude')
}
await access(database)

const store = new SqliteSessionStore(database)
try {
  const namespaceSecret = store.getNativeImportNamespaceKey()
  const readers = [
    new CodexLocalSourceReader({ namespaceSecret }),
    new ClaudeLocalSourceReader({ namespaceSecret }),
  ]
  const sources: NativeSourceClient[] = source === 'codex'
    ? ['codex_local']
    : source === 'claude'
      ? ['claude_desktop', 'claude_code']
      : ['codex_local', 'claude_desktop', 'claude_code']
  const results = await restoreImportedNativeGoals(store, readers, { apply, sources })
  const summary = Object.fromEntries([...new Set(results.map((item) => item.status))]
    .map((status) => [status, results.filter((item) => item.status === status).length]))
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', database, summary, results }, null, 2))
  if (results.some((item) => item.status === 'invalid_goal')) process.exitCode = 2
} finally {
  store.close()
}

function argument(name: string): string | null {
  const index = args.indexOf(name)
  if (index === -1) return null
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}
