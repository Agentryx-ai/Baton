import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  ClaudeNativeAccountVault,
  type ClaudeNativeSecretProtector,
} from './claude-native-account-vault.ts'
import { ClaudeNativeVaultCredentialManager } from './claude-native-vault-credentials.ts'

class TestProtector implements ClaudeNativeSecretProtector {
  async protect(value: string): Promise<string> { return Buffer.from(value).toString('base64') }
  async unprotect(value: string): Promise<string> { return Buffer.from(value, 'base64').toString('utf8') }
}

test('vault credential refresh is single-flight per account and persists rotated tokens', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-vault-refresh-'))
  const vault = new ClaudeNativeAccountVault({
    filePath: path.join(directory, 'accounts.json'),
    protector: new TestProtector(),
    createId: () => 'account-1',
    now: () => 1_000,
  })
  await vault.put({
    nickname: 'Primary',
    secret: {
      accessToken: 'expired-access',
      refreshToken: 'refresh-one',
      expiresAt: 1_000,
      scopes: ['user:inference'],
    },
  })
  let refreshes = 0
  const manager = new ClaudeNativeVaultCredentialManager({
    vault,
    now: () => 2_000,
    fetchImpl: async (_input, init) => {
      refreshes += 1
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      assert.equal(body.refresh_token, 'refresh-one')
      return new Response(JSON.stringify({
        access_token: 'rotated-access',
        refresh_token: 'refresh-two',
        expires_in: 3_600,
        scope: 'user:inference user:profile',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  const [first, second] = await Promise.all([
    manager.getCredential('account-1'),
    manager.getCredential('account-1'),
  ])
  assert.equal(refreshes, 1)
  assert.deepEqual(first, second)
  assert.equal(first.accessToken, 'rotated-access')
  assert.deepEqual(await vault.getSecret('account-1'), {
    accessToken: 'rotated-access',
    refreshToken: 'refresh-two',
    expiresAt: 3_602_000,
    scopes: ['user:inference', 'user:profile'],
  })
})

test('one vault account refresh failure does not damage another account', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-vault-refresh-isolation-'))
  let id = 0
  const vault = new ClaudeNativeAccountVault({
    filePath: path.join(directory, 'accounts.json'),
    protector: new TestProtector(),
    createId: () => `account-${++id}`,
  })
  const first = await vault.put({
    nickname: 'Expired',
    secret: { accessToken: 'first-access', refreshToken: 'first-refresh', expiresAt: 1, scopes: [] },
  })
  const second = await vault.put({
    nickname: 'Healthy',
    secret: { accessToken: 'second-access', refreshToken: 'second-refresh', expiresAt: 999_999_999, scopes: [] },
  })
  const manager = new ClaudeNativeVaultCredentialManager({
    vault,
    now: () => 10_000,
    fetchImpl: async () => new Response('{}', { status: 401 }),
  })

  await assert.rejects(manager.getCredential(first.id), /HTTP 401/)
  assert.equal((await manager.getCredential(second.id)).accessToken, 'second-access')
  assert.equal((await vault.getSecret(second.id)).refreshToken, 'second-refresh')
})
