import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  ClaudeNativeAccountVault,
  type ClaudeNativeSecretProtector,
} from './claude-native-account-vault.ts'
import { migrateLegacyClaudeAccount } from './claude-native-migration.ts'

class TestProtector implements ClaudeNativeSecretProtector {
  async protect(value: string): Promise<string> { return Buffer.from(value).toString('base64') }
  async unprotect(value: string): Promise<string> { return Buffer.from(value, 'base64').toString('utf8') }
}

function jwt(payload: Record<string, unknown>): string {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

test('legacy Claude migration matches stable identity and never overwrites a rotated current secret', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-claude-migration-identity-'))
  const vault = new ClaudeNativeAccountVault({
    filePath: path.join(directory, 'accounts.json'),
    protector: new TestProtector(),
    createId: () => 'native-account',
  })
  const existing = await vault.put({
    nickname: 'Claude Code',
    accountId: 'stable-account',
    source: 'claude-code',
    secret: { accessToken: 'current-access', refreshToken: 'current-rotated-refresh', scopes: [] },
  })

  const result = await migrateLegacyClaudeAccount({
    vault,
    sourcePath: '/root/.ccs/cliproxy/auth/user.json',
    priority: 9,
    legacy: {
      email: 'User@Example.com',
      account_id: 'stable-account',
      access_token: 'stale-access',
      refresh_token: 'stale-pre-rotation-refresh',
    },
  })

  assert.deepEqual(result, { alias: 'user@example.com', status: 'matched', enabled: true })
  assert.equal((await vault.list()).length, 1)
  assert.equal((await vault.list())[0]?.id, existing.id)
  assert.equal((await vault.list())[0]?.email, 'user@example.com')
  assert.equal((await vault.getSecret(existing.id)).refreshToken, 'current-rotated-refresh')
})

test('legacy Claude migration can match stable id_token subject after refresh-token rotation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-claude-migration-sub-'))
  const vault = new ClaudeNativeAccountVault({
    filePath: path.join(directory, 'accounts.json'),
    protector: new TestProtector(),
    createId: () => 'native-account',
  })
  await vault.put({
    nickname: 'Existing',
    accountId: 'anthropic-subject',
    secret: { accessToken: 'current-access', refreshToken: 'current-refresh', scopes: [] },
  })

  const result = await migrateLegacyClaudeAccount({
    vault,
    sourcePath: '/root/.ccs/cliproxy/auth-paused/user.json',
    priority: 0,
    legacy: {
      email: 'user@example.com',
      id_token: jwt({ sub: 'anthropic-subject' }),
      access_token: 'old-access',
      refresh_token: 'old-refresh',
    },
  })

  assert.equal(result.status, 'matched')
  assert.equal((await vault.list()).length, 1)
  assert.equal((await vault.getSecret('native-account')).refreshToken, 'current-refresh')
})

test('migration and repair from separate vault instances cannot stale-overwrite each other', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-claude-migration-repair-race-'))
  const filePath = path.join(directory, 'accounts.json')
  let nextId = 0
  let blockNextProtect = false
  let releaseProtect!: () => void
  let protectStarted!: () => void
  const started = new Promise<void>((resolve) => { protectStarted = resolve })
  let repairReadStarted!: () => void
  const repairStarted = new Promise<void>((resolve) => { repairReadStarted = resolve })
  let watchRepairRead = false
  class BlockingProtector extends TestProtector {
    override async protect(value: string): Promise<string> {
      if (blockNextProtect) {
        blockNextProtect = false
        protectStarted()
        await new Promise<void>((resolve) => { releaseProtect = resolve })
      }
      return super.protect(value)
    }

    override async unprotect(value: string): Promise<string> {
      if (watchRepairRead) {
        watchRepairRead = false
        repairReadStarted()
      }
      return super.unprotect(value)
    }
  }
  const protector = new BlockingProtector()
  const createVault = () => new ClaudeNativeAccountVault({
    filePath,
    protector,
    createId: () => `account-${++nextId}`,
    now: () => 9_000,
  })
  const migrationVault = createVault()
  const repairVault = createVault()
  const target = await migrationVault.put({
    nickname: 'Migration target',
    secret: { accessToken: 'target-access', refreshToken: 'target-refresh', scopes: [] },
  })
  const remove = await migrationVault.put({
    nickname: 'Remove duplicate',
    secret: { accessToken: 'remove-access', refreshToken: 'remove-refresh', scopes: [] },
  })
  const keep = await migrationVault.put({
    nickname: 'Keep duplicate',
    secret: { accessToken: 'keep-access', refreshToken: 'keep-refresh', scopes: [] },
  })
  const seeded = JSON.parse(await readFile(filePath, 'utf8')) as { accounts: Array<Record<string, unknown>> }
  for (const account of seeded.accounts) {
    if (account.id === remove.id || account.id === keep.id) account.accountId = 'duplicate-stable'
  }
  await writeFile(filePath, `${JSON.stringify(seeded, null, 2)}\n`)

  blockNextProtect = true
  const migration = migrateLegacyClaudeAccount({
    vault: migrationVault,
    sourcePath: '/tmp/legacy/user.json',
    priority: 4,
    legacy: {
      email: 'updated@example.com',
      access_token: 'stale-access',
      refresh_token: 'target-refresh',
    },
  })
  await started
  watchRepairRead = true
  const repair = repairVault.repairStableIdentityDuplicates({
    apply: true,
    keepByAccountId: { 'duplicate-stable': keep.id },
  })
  const repairReadBeforeRelease = await Promise.race([
    repairStarted.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 30)),
  ])
  if (repairReadBeforeRelease) await repair
  releaseProtect()
  await Promise.all([migration, repair])

  const accounts = await createVault().list()
  assert.equal(accounts.some((account) => account.id === remove.id), false)
  assert.equal(accounts.find((account) => account.id === target.id)?.email, 'updated@example.com')
})
