import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

import { claudeNativeAccountVault } from '../server/claude-native-runtime.ts'
import { migrateLegacyClaudeAccount } from '../server/claude-native-migration.ts'
import { codexNativeRuntime } from '../server/codex-native-runtime.ts'
import type { CodexCredentialsFile } from '../server/codex-native-credentials.ts'

const CONTAINER = process.env.BATON_LEGACY_CLIPROXY_CONTAINER?.trim() || 'ccs-ccs-1'
const ROOTS = [
  '/root/.ccs/cliproxy/auth',
  '/root/.ccs/cliproxy/auth-paused',
] as const
type LegacyCredential = Record<string, unknown>
type MigrationResult = { provider: 'claude' | 'codex'; alias: string; status: 'imported' | 'matched'; enabled: boolean }

function docker(args: string[]): Buffer {
  return execFileSync('docker', args, {
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function legacyFiles(): string[] {
  return ROOTS.flatMap((root) => {
    try {
      return docker(['exec', CONTAINER, 'find', root, '-maxdepth', '1', '-type', 'f'])
        .toString('utf8').split(/\r?\n/u).map((line) => line.trim())
        .filter((line) => line.endsWith('.json'))
    } catch {
      return []
    }
  }).sort()
}

function readLegacy(file: string): LegacyCredential {
  const raw = docker(['exec', CONTAINER, 'cat', file])
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object expected')
    return parsed as LegacyCredential
  } finally {
    raw.fill(0)
  }
}

function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Legacy credential omitted ${field}`)
  return value
}

function email(value: LegacyCredential): string {
  return required(value.email, 'email').trim().toLowerCase()
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function migrateCodex(file: string, legacy: LegacyCredential, priority: number): Promise<MigrationResult> {
  const alias = email(legacy)
  const enabled = !file.includes('/auth-paused/') && legacy.disabled !== true
  const refresh = required(legacy.refresh_token, 'refresh_token')
  const existing = await codexNativeRuntime.vault.list('codex')
  for (const account of existing) {
    const stored = await codexNativeRuntime.vault.readCredential<CodexCredentialsFile>(account.id, 'codex')
    if (typeof stored.tokens?.refresh_token === 'string'
      && fingerprint(stored.tokens.refresh_token) === fingerprint(refresh)) {
      return { provider: 'codex', alias: account.alias, status: 'matched', enabled: account.enabled }
    }
  }
  const credential: CodexCredentialsFile = {
    tokens: {
      id_token: required(legacy.id_token, 'id_token'),
      access_token: required(legacy.access_token, 'access_token'),
      refresh_token: refresh,
      ...(typeof legacy.account_id === 'string' && legacy.account_id.length > 0
        ? { account_id: legacy.account_id }
        : {}),
    },
    ...(typeof legacy.last_refresh === 'string' ? { last_refresh: legacy.last_refresh } : {}),
  }
  await codexNativeRuntime.vault.add({ provider: 'codex', alias, priority, enabled, credential })
  return { provider: 'codex', alias, status: 'imported', enabled }
}

async function migrateClaude(file: string, legacy: LegacyCredential, priority: number): Promise<MigrationResult> {
  return {
    provider: 'claude',
    ...await migrateLegacyClaudeAccount({ vault: claudeNativeAccountVault, sourcePath: file, legacy, priority }),
  }
}

async function main(): Promise<void> {
  const files = legacyFiles()
  if (files.length === 0) throw new Error('No legacy CLIProxy OAuth files were found')
  const results: MigrationResult[] = []
  let claudePriority = 0
  let codexPriority = 0
  for (const file of files) {
    const legacy = readLegacy(file)
    const type = required(legacy.type, 'type').toLowerCase()
    if (type === 'codex') results.push(await migrateCodex(file, legacy, codexPriority++))
    else if (type === 'claude') results.push(await migrateClaude(file, legacy, claudePriority++))
  }
  process.stdout.write(`${JSON.stringify({ migrated: results }, null, 2)}\n`)
}

await main()
