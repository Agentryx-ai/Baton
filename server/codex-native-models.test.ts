import assert from 'node:assert/strict'
import test from 'node:test'

import { CodexCredentialManager, codexPlanFromIdToken } from './codex-native-credentials.ts'
import type { CodexCredentialsFile } from './codex-native-credentials.ts'
import { CodexModelCatalog } from './codex-native-models.ts'

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

test('Codex forced refresh reproduces the observed free-to-pro model catalog transition', async () => {
  const freeAccess = jwt({ exp: 2_000 })
  const proAccess = jwt({ exp: 5_000 })
  let stored: CodexCredentialsFile = {
    tokens: {
      id_token: idToken('free'),
      access_token: freeAccess,
      refresh_token: 'refresh-token',
      account_id: 'chatgpt-workspace-a',
    },
  }
  const manager = new CodexCredentialManager({
    accountId: 'vault-account-a',
    credentialStore: {
      read: async () => structuredClone(stored),
      write: async (_expected, updated) => {
        stored = structuredClone(updated)
        return structuredClone(stored)
      },
    },
    now: () => 1_000_000,
    fetchImpl: async () => Response.json({
      id_token: idToken('pro'),
      access_token: proAccess,
    }),
  })
  const catalog = new CodexModelCatalog({
    clientVersion: '1.2.3',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input))
      assert.equal(url.searchParams.get('client_version'), '1.2.3')
      assert.equal(new Headers(init?.headers).get('chatgpt-account-id'), 'chatgpt-workspace-a')
      const authorization = new Headers(init?.headers).get('authorization')
      return Response.json({
        models: authorization === `Bearer ${proAccess}`
          ? [{ slug: 'gpt-5.6-luna' }, { slug: 'gpt-5.6-sol' }, { slug: 'gpt-5.6-terra' }]
          : [{ slug: 'gpt-5.6-luna' }, { slug: 'gpt-5.6-terra' }],
      })
    },
  })

  const before = await manager.getCredential()
  assert.equal(before.plan, 'free')
  assert.equal((await catalog.refresh(before)).models.includes('gpt-5.6-sol'), false)

  const after = await manager.getCredential({ forceRefresh: true })
  assert.equal(after.plan, 'pro')
  assert.equal(codexPlanFromIdToken(String(stored.tokens?.id_token)), 'pro')
  assert.equal((await catalog.refresh(after)).models.includes('gpt-5.6-sol'), true)
  assert.equal(catalog.supports(after.accountId, 'gpt-5.6-sol'), true)
})

test('Codex catalog union preserves a pinned model while any active account supports it', async () => {
  const catalog = new CodexModelCatalog({
    clientVersion: '1.2.3',
    fetchImpl: async (_input, init) => {
      const token = new Headers(init?.headers).get('authorization')
      return Response.json({
        models: token === 'Bearer pro-token'
          ? [{ slug: 'gpt-5.6-sol' }, { slug: 'gpt-5.6-terra' }]
          : [{ slug: 'gpt-5.6-terra' }],
      })
    },
  })
  await catalog.refresh({ accountId: 'pro', accessToken: 'pro-token', plan: 'pro' })
  await catalog.refresh({ accountId: 'free', accessToken: 'free-token', plan: 'free' })

  assert.deepEqual(catalog.allModels(), ['gpt-5.6-sol', 'gpt-5.6-terra'])
  assert.deepEqual(catalog.allModels(new Set(['free'])), ['gpt-5.6-terra'])
  assert.deepEqual(catalog.allModels(new Set(['pro'])), ['gpt-5.6-sol', 'gpt-5.6-terra'])
})
