import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  ClaudeCodeCredentialManager,
  ClaudeNativeCredentialError,
  loadClaudeCodeCredential,
  loadOrCreateNativeClaudeProxyToken,
  nativeClaudeProxyStatePath,
} from './claude-native-credentials.ts'

test('loads Claude Code OAuth metadata without exposing refresh credentials', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-claude-credential-'))
  const target = path.join(directory, 'credentials.json')
  await writeFile(target, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'access-secret',
      refreshToken: 'refresh-must-not-be-returned',
      expiresAt: 2_000,
      scopes: ['user:inference'],
    },
  }))

  const result = await loadClaudeCodeCredential(target, 1_000)
  assert.deepEqual(result, {
    accountId: 'claude-code-default',
    accessToken: 'access-secret',
    expiresAt: 2_000,
    scopes: ['user:inference'],
  })
  assert.equal('refreshToken' in result, false)
})

test('rejects expired Claude Code OAuth credentials before calling upstream', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-claude-expired-'))
  const target = path.join(directory, 'credentials.json')
  await writeFile(target, JSON.stringify({
    claudeAiOauth: { accessToken: 'expired', expiresAt: 999 },
  }))

  await assert.rejects(
    loadClaudeCodeCredential(target, 1_000),
    (error: unknown) => error instanceof ClaudeNativeCredentialError && error.code === 'expired',
  )
})

test('creates and reuses a persistent local proxy token', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-native-token-'))
  const first = await loadOrCreateNativeClaudeProxyToken(directory)
  const second = await loadOrCreateNativeClaudeProxyToken(directory)
  assert.equal(first, second)
  assert.ok(first.length >= 32)

  const stored = JSON.parse(await readFile(nativeClaudeProxyStatePath(directory), 'utf8')) as {
    version: number
    clientToken: string
  }
  assert.equal(stored.version, 1)
  assert.equal(stored.clientToken, first)
})

test('refreshes an expiring Claude OAuth token once and persists rotated credentials', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-claude-refresh-'))
  const target = path.join(directory, 'credentials.json')
  await writeFile(target, JSON.stringify({
    keep: true,
    claudeAiOauth: {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: 1_050,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    },
  }))
  let refreshCalls = 0
  const manager = new ClaudeCodeCredentialManager({
    credentialsPath: target,
    tokenUrl: 'https://oauth.example/token',
    clientId: 'test-client',
    now: () => 1_000,
    fetchImpl: async (url, init) => {
      refreshCalls += 1
      assert.equal(url, 'https://oauth.example/token')
      assert.equal(init?.method, 'POST')
      assert.deepEqual(JSON.parse(String(init?.body)), {
        grant_type: 'refresh_token',
        refresh_token: 'old-refresh',
        client_id: 'test-client',
        scope: 'user:inference',
      })
      return Response.json({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3_600,
        refresh_token_expires_in: 7_200,
        scope: 'user:inference user:profile',
      })
    },
  })

  const [first, second] = await Promise.all([manager.getCredential(), manager.getCredential()])
  assert.equal(refreshCalls, 1)
  assert.equal(first.accessToken, 'new-access')
  assert.deepEqual(second, first)
  const stored = JSON.parse(await readFile(target, 'utf8')) as Record<string, any>
  assert.equal(stored.keep, true)
  assert.equal(stored.claudeAiOauth.subscriptionType, 'max')
  assert.equal(stored.claudeAiOauth.accessToken, 'new-access')
  assert.equal(stored.claudeAiOauth.refreshToken, 'new-refresh')
  assert.equal(stored.claudeAiOauth.expiresAt, 3_601_000)
  assert.equal(stored.claudeAiOauth.refreshTokenExpiresAt, 7_201_000)
  assert.deepEqual(stored.claudeAiOauth.scopes, ['user:inference', 'user:profile'])
})

test('refreshes an isolated vault-backed Claude account with its stable account id', async () => {
  let stored = {
    claudeAiOauth: {
      accessToken: 'vault-old-access',
      refreshToken: 'vault-old-refresh',
      expiresAt: 1_050,
      scopes: ['user:inference'],
    },
  }
  let writes = 0
  const manager = new ClaudeCodeCredentialManager({
    accountId: 'vault-account-a',
    credentialStore: {
      read: async () => structuredClone(stored),
      write: async (expectedRefreshToken, updated) => {
        assert.equal(expectedRefreshToken, stored.claudeAiOauth.refreshToken)
        writes += 1
        stored = structuredClone(updated) as typeof stored
        return structuredClone(stored)
      },
    },
    tokenUrl: 'https://oauth.example/token',
    now: () => 1_000,
    fetchImpl: async () => Response.json({
      access_token: 'vault-new-access',
      refresh_token: 'vault-new-refresh',
      expires_in: 3_600,
    }),
  })

  const [first, second] = await Promise.all([manager.getCredential(), manager.getCredential()])
  assert.equal(writes, 1)
  assert.equal(first.accountId, 'vault-account-a')
  assert.equal(first.accessToken, 'vault-new-access')
  assert.deepEqual(second, first)
  assert.equal(stored.claudeAiOauth.refreshToken, 'vault-new-refresh')
})
