import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
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
