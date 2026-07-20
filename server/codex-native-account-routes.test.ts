import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import express from 'express'

import { createCodexNativeAccountRouter } from './codex-native-account-routes.ts'
import type { CodexCredentialsFile } from './codex-native-credentials.ts'
import { CodexModelCatalog } from './codex-native-models.ts'
import { CodexNativeOAuthManager } from './codex-native-oauth.ts'
import { createCodexNativeProxy } from './codex-native-proxy.ts'
import { CodexNativeRuntime } from './codex-native-runtime.ts'
import type { NativeAccountSecretProtector } from './native-account-vault.ts'
import { NativeAccountVault } from './native-account-vault.ts'

class TestProtector implements NativeAccountSecretProtector {
  async seal(plaintext: string): Promise<string> {
    return Buffer.from(plaintext).toString('base64')
  }

  async open(sealed: string): Promise<string> {
    return Buffer.from(sealed, 'base64').toString('utf8')
  }
}

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from('{}').toString('base64url'),
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

test('Codex entitlement refresh exposes and serves an upgraded model without re-login', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-codex-native-routes-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const vault = new NativeAccountVault({
    vaultPath: path.join(directory, 'accounts.json'),
    protector: new TestProtector(),
    createId: () => 'account-1',
  })
  const credential: CodexCredentialsFile = {
    tokens: {
      id_token: idToken('free'),
      access_token: jwt({ exp: 9_999_999_999, tier: 'free' }),
      refresh_token: 'refresh-secret',
      account_id: 'workspace-1',
    },
  }
  await vault.add({ provider: 'codex', alias: 'Primary', credential })
  const proAccessToken = jwt({ exp: 9_999_999_999, token: 'pro-access' })

  const catalog = new CodexModelCatalog({
    clientVersion: '1.2.3',
    fetchImpl: async (_input, init) => {
      const authorization = new Headers(init?.headers).get('authorization')
      return Response.json({
        models: authorization === `Bearer ${proAccessToken}`
          ? [{ slug: 'gpt-5.6-sol' }, { slug: 'gpt-5.6-terra' }]
          : [{ slug: 'gpt-5.6-terra' }],
      })
    },
  })
  const runtime = new CodexNativeRuntime({
    vault,
    catalog,
    credentialFetchImpl: async () => Response.json({
      id_token: idToken('pro'),
      access_token: proAccessToken,
    }),
  })
  await runtime.loadProxyAccounts()

  let upstreamCalls = 0
  const app = express()
  app.use(express.raw({ type: () => true }))
  app.use('/baton/codex-native', createCodexNativeAccountRouter({
    runtime,
    oauth: new CodexNativeOAuthManager({ vault }),
  }))
  app.use('/v1', createCodexNativeProxy({
    loadAccounts: () => runtime.loadProxyAccounts(),
    loadClientToken: async () => 'local-token',
    fetchImpl: async () => {
      upstreamCalls += 1
      return Response.json({ status: 'completed' })
    },
  }))
  const server = app.listen(0, '127.0.0.1')
  t.after(() => server.close())
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`

  const before = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'Hi' }),
  })
  assert.equal(before.status, 422)
  assert.equal(upstreamCalls, 0)

  const refreshed = await fetch(`${baseUrl}/baton/codex-native/accounts/account-1/refresh-entitlements`, {
    method: 'POST',
  })
  assert.equal(refreshed.status, 200)
  assert.deepEqual(await refreshed.json(), {
    accountId: 'account-1',
    plan: 'pro',
    models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
  })

  const accountsText = await fetch(`${baseUrl}/baton/codex-native/accounts`).then((response) => response.text())
  assert.doesNotMatch(accountsText, /refresh-secret|access_token|id_token/)
  const accounts = JSON.parse(accountsText) as { accounts: Array<{ plan: string; models: string[] }> }
  assert.equal(accounts.accounts[0]?.plan, 'pro')
  assert.deepEqual(accounts.accounts[0]?.models, ['gpt-5.6-sol', 'gpt-5.6-terra'])

  const after = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'Hi' }),
  })
  assert.equal(after.status, 200)
  assert.deepEqual(await after.json(), { status: 'completed' })
  assert.equal(upstreamCalls, 1)
})
