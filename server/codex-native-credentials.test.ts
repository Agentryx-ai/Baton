import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CODEX_OAUTH_CLIENT_ID,
  CodexCredentialManager,
  CodexNativeCredentialError,
  codexPlanFromIdToken,
} from './codex-native-credentials.ts'
import type { CodexCredentialsFile } from './codex-native-credentials.ts'

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'fixture-signature',
  ].join('.')
}

function idToken(plan: string): string {
  return jwt({
    exp: 9_999_999_999,
    'https://api.openai.com/auth': { chatgpt_plan_type: plan },
  })
}

function accessToken(expiresAtSeconds: number): string {
  return jwt({ exp: expiresAtSeconds })
}

test('Codex plan is derived from the live ID-token claim instead of a filename', () => {
  assert.equal(codexPlanFromIdToken(idToken('free')), 'free')
  assert.equal(codexPlanFromIdToken(idToken('pro')), 'pro')
})

test('Codex credential refresh changes free to pro without re-login and is single-flight', async () => {
  let stored: CodexCredentialsFile = {
    tokens: {
      id_token: idToken('free'),
      access_token: accessToken(1_100),
      refresh_token: 'refresh-free-origin',
      account_id: 'chatgpt-account-a',
    },
    last_refresh: '2026-07-01T00:00:00.000Z',
  }
  let refreshCalls = 0
  let writes = 0
  const manager = new CodexCredentialManager({
    accountId: 'vault-codex-a',
    credentialStore: {
      read: async () => structuredClone(stored),
      write: async (expectedRefreshToken, updated) => {
        assert.equal(expectedRefreshToken, 'refresh-free-origin')
        writes += 1
        stored = structuredClone(updated)
        return structuredClone(stored)
      },
    },
    now: () => 1_000_000,
    fetchImpl: async (url, init) => {
      refreshCalls += 1
      assert.equal(url, 'https://auth.openai.com/oauth/token')
      assert.deepEqual(JSON.parse(String(init?.body)), {
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: 'refresh-free-origin',
      })
      return Response.json({
        id_token: idToken('pro'),
        access_token: accessToken(4_600),
        refresh_token: 'refresh-pro-rotated',
      })
    },
  })

  const [first, second] = await Promise.all([
    manager.getCredential({ forceRefresh: true }),
    manager.getCredential({ forceRefresh: true }),
  ])
  assert.equal(refreshCalls, 1)
  assert.equal(writes, 1)
  assert.equal(first.accountId, 'vault-codex-a')
  assert.equal(first.plan, 'pro')
  assert.deepEqual(second, first)
  assert.equal(stored.tokens?.refresh_token, 'refresh-pro-rotated')
  assert.equal(codexPlanFromIdToken(String(stored.tokens?.id_token)), 'pro')
})

test('Codex credential manager refreshes an expiring access token automatically', async () => {
  let stored: CodexCredentialsFile = {
    tokens: {
      id_token: idToken('pro'),
      access_token: accessToken(1_200),
      refresh_token: 'refresh-token',
    },
  }
  let refreshCalls = 0
  const manager = new CodexCredentialManager({
    accountId: 'vault-codex-a',
    credentialStore: {
      read: async () => structuredClone(stored),
      write: async (_expected, updated) => {
        stored = structuredClone(updated)
        return structuredClone(stored)
      },
    },
    now: () => 1_000_000,
    fetchImpl: async () => {
      refreshCalls += 1
      return Response.json({ access_token: accessToken(4_600) })
    },
  })

  const credential = await manager.getCredential()
  assert.equal(refreshCalls, 1)
  assert.equal(credential.expiresAt, 4_600_000)
})

test('Codex credential manager classifies revoked refresh tokens without leaking the response', async () => {
  const manager = new CodexCredentialManager({
    accountId: 'vault-codex-a',
    credentialStore: {
      read: async () => ({
        tokens: {
          id_token: idToken('pro'),
          access_token: accessToken(1_100),
          refresh_token: 'refresh-token',
        },
      }),
      write: async () => assert.fail('must not write'),
    },
    now: () => 1_000_000,
    fetchImpl: async () => Response.json({
      error: { code: 'refresh_token_invalidated', message: 'sensitive upstream text' },
    }, { status: 401 }),
  })

  await assert.rejects(
    manager.getCredential({ forceRefresh: true }),
    (error: unknown) => error instanceof CodexNativeCredentialError
      && error.code === 'revoked'
      && !error.message.includes('sensitive upstream text'),
  )
})
