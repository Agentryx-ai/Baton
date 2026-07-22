import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import express from 'express'

import {
  ClaudeNativeAccountVault,
  type ClaudeNativeSecretProtector,
} from './claude-native-account-vault.ts'
import { createClaudeNativeAccountRouter } from './claude-native-account-routes.ts'
import { ClaudeNativeOAuthManager } from './claude-native-oauth.ts'
import { ClaudeNativeCredentialError } from './claude-native-credentials.ts'

class TestProtector implements ClaudeNativeSecretProtector {
  async protect(value: string): Promise<string> { return Buffer.from(value).toString('base64') }
  async unprotect(value: string): Promise<string> { return Buffer.from(value, 'base64').toString('utf8') }
}

test('native Claude account routes preserve the existing account UI contract without exposing tokens', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-account-routes-'))
  let nextAccountId = 0
  const vault = new ClaudeNativeAccountVault({
    filePath: path.join(directory, 'accounts.json'),
    protector: new TestProtector(),
    createId: () => `account-${++nextAccountId}`,
    now: () => 1_000,
  })
  await vault.put({
    nickname: 'Primary',
    email: 'user@example.com',
    secret: { accessToken: 'access-secret', refreshToken: 'refresh-secret', scopes: ['user:inference'] },
  })
  const oauth = new ClaudeNativeOAuthManager({ vault, random: (size) => Buffer.alloc(size, 1) })
  const app = express()
  app.use(express.raw({ type: () => true }))
  app.use('/baton/claude-native', createClaudeNativeAccountRouter({
    vault,
    oauth,
    getQuota: async (accountId) => ({ success: true, windows: [], lastUpdated: 1_000, accountId }),
  }))
  const server = app.listen(0, '127.0.0.1')
  t.after(() => server.close())
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}/baton/claude-native`

  const accountsResponse = await fetch(`${baseUrl}/accounts`)
  assert.equal(accountsResponse.status, 200)
  const accountsText = await accountsResponse.text()
  assert.doesNotMatch(accountsText, /access-secret|refresh-secret|protectedSecret/)
  assert.deepEqual(JSON.parse(accountsText), {
    provider: 'claude',
    accounts: [{
      id: 'account-1',
      provider: 'claude',
      isDefault: true,
      email: 'user@example.com',
      nickname: 'Primary',
      paused: false,
      priority: 0,
      createdAt: '1970-01-01T00:00:01.000Z',
    }],
  })

  assert.equal((await fetch(`${baseUrl}/accounts/account-1/pause`, { method: 'POST' })).status, 200)
  assert.equal((await vault.list())[0]?.enabled, false)
  assert.equal((await fetch(`${baseUrl}/accounts/account-1/resume`, { method: 'POST' })).status, 200)
  assert.equal((await vault.list())[0]?.enabled, true)
  const quota = await fetch(`${baseUrl}/quota/account-1`)
  assert.deepEqual(await quota.json(), {
    success: true,
    windows: [],
    lastUpdated: 1_000,
    accountId: 'account-1',
  })

  const start = await fetch(`${baseUrl}/auth/start-url`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname: 'Second' }),
  })
  const started = await start.json() as { authUrl: string; url: string; state: string }
  assert.equal(start.status, 200)
  assert.equal(started.url, started.authUrl)
  assert.ok(started.state)
  const status = await fetch(`${baseUrl}/auth/status?state=${encodeURIComponent(started.state)}`)
  assert.deepEqual(await status.json(), { status: 'wait' })

  await vault.put({
    nickname: 'Second',
    secret: { accessToken: 'second-access', refreshToken: 'second-refresh', scopes: [] },
  })
  assert.equal((await fetch(`${baseUrl}/accounts/account-2/prefer`, { method: 'POST' })).status, 200)
  const preferredAccounts = await (await fetch(`${baseUrl}/accounts`)).json() as {
    accounts: Array<{ id: string; isDefault: boolean; priority: number }>
  }
  assert.deepEqual(preferredAccounts.accounts.map(({ id, isDefault, priority }) => ({ id, isDefault, priority })), [
    { id: 'account-2', isDefault: true, priority: 0 },
    { id: 'account-1', isDefault: false, priority: 1 },
  ])

  assert.equal((await fetch(`${baseUrl}/accounts/account-1`, { method: 'DELETE' })).status, 200)
  assert.equal((await fetch(`${baseUrl}/accounts/account-2`, { method: 'DELETE' })).status, 200)
  assert.deepEqual(await vault.list(), [])
})

test('quota exposes invalid or rotated credentials as structured reauth_required', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-account-reauth-route-'))
  const vault = new ClaudeNativeAccountVault({
    filePath: path.join(directory, 'accounts.json'),
    protector: new TestProtector(),
    createId: () => 'placeholder-account',
  })
  await vault.put({
    nickname: 'Claude Code',
    accountId: 'stable-account-label',
    secret: { accessToken: 'expired', refreshToken: 'rotated-away', expiresAt: 1, scopes: [] },
  })
  const app = express()
  app.use('/baton/claude-native', createClaudeNativeAccountRouter({
    vault,
    oauth: new ClaudeNativeOAuthManager({ vault }),
    getQuota: async () => {
      throw new ClaudeNativeCredentialError('expired', 'Claude OAuth token 갱신이 실패했습니다.')
    },
  }))
  const server = app.listen(0, '127.0.0.1')
  t.after(() => server.close())
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}/baton/claude-native`

  const accounts = await (await fetch(`${baseUrl}/accounts`)).json() as { accounts: Array<{ email: string }> }
  assert.equal(accounts.accounts[0]?.email, 'stable-account-label')
  const response = await fetch(`${baseUrl}/quota/placeholder-account`)
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), {
    error: 'Claude OAuth token 갱신이 실패했습니다.',
    code: 'reauth_required',
  })
})
