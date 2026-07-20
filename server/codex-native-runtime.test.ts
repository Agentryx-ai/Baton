import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { NativeAccountSecretProtector } from './native-account-vault.ts'
import { NativeAccountVault } from './native-account-vault.ts'
import { CodexModelCatalog } from './codex-native-models.ts'
import { CodexNativeRuntime } from './codex-native-runtime.ts'

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

function credentials(plan: string, accessToken: string): Record<string, unknown> {
  return {
    tokens: {
      id_token: jwt({
        exp: 9_999_999_999,
        'https://api.openai.com/auth': { chatgpt_plan_type: plan },
      }),
      access_token: accessToken,
      refresh_token: `refresh-${plan}`,
      account_id: `workspace-${plan}`,
    },
  }
}

test('Codex native runtime composes enabled vault accounts with live per-account catalogs', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-codex-runtime-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const vault = new NativeAccountVault({
    vaultPath: path.join(directory, 'accounts.json'),
    protector: new TestProtector(),
  })
  const free = await vault.add({
    provider: 'codex',
    alias: 'Free',
    priority: 20,
    credential: credentials('free', jwt({ exp: 9_999_999_999, tier: 'free' })),
  })
  const pro = await vault.add({
    provider: 'codex',
    alias: 'Pro',
    priority: 10,
    credential: credentials('pro', jwt({ exp: 9_999_999_999, tier: 'pro' })),
  })
  await vault.add({
    provider: 'codex',
    alias: 'Paused',
    priority: 1,
    enabled: false,
    credential: credentials('pro', jwt({ exp: 9_999_999_999, tier: 'paused' })),
  })
  const catalog = new CodexModelCatalog({
    clientVersion: 'test',
    fetchImpl: async (_input, init) => {
      const authorization = new Headers(init?.headers).get('authorization') ?? ''
      const payload = JSON.parse(Buffer.from(authorization.split('.')[1] ?? '', 'base64url').toString()) as {
        tier: string
      }
      return Response.json({
        models: payload.tier === 'pro'
          ? [{ slug: 'gpt-5.6-sol' }, { slug: 'gpt-5.6-terra' }]
          : [{ slug: 'gpt-5.6-terra' }],
      })
    },
  })
  const runtime = new CodexNativeRuntime({ vault, catalog })

  const accounts = await runtime.loadProxyAccounts()
  assert.deepEqual(accounts.map((account) => account.id), [pro.id, free.id])
  assert.deepEqual(accounts[0]?.models, ['gpt-5.6-sol', 'gpt-5.6-terra'])
  assert.deepEqual(accounts[1]?.models, ['gpt-5.6-terra'])
})

test('Codex native runtime normalizes live wham usage windows and sends account-scoped auth', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-codex-quota-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const vault = new NativeAccountVault({
    vaultPath: path.join(directory, 'accounts.json'),
    protector: new TestProtector(),
    createId: () => 'account-1',
  })
  const accessToken = jwt({ exp: 9_999_999_999 })
  await vault.add({
    provider: 'codex',
    alias: 'Primary',
    credential: credentials('pro', accessToken),
  })
  let observedHeaders: Headers | undefined
  const runtime = new CodexNativeRuntime({
    vault,
    usageUrl: 'https://usage.example.test/wham/usage',
    usageFetchImpl: async (input, init) => {
      assert.equal(String(input), 'https://usage.example.test/wham/usage')
      observedHeaders = new Headers(init?.headers)
      return Response.json({
        rate_limit: {
          primary_window: { used_percent: 110, reset_at: 2_000 },
          secondary_window: { used_percent: -5 },
        },
        additional_rate_limits: [{
          limit_name: 'gpt-5.6-sol',
          rate_limit: { primary_window: { used_percent: 37.5, reset_at: 3_000 } },
        }],
      })
    },
  })

  const quota = await runtime.getQuota('account-1')
  assert.equal(observedHeaders?.get('authorization'), `Bearer ${accessToken}`)
  assert.equal(observedHeaders?.get('chatgpt-account-id'), 'workspace-pro')
  assert.deepEqual(quota.windows, [
    {
      rateLimitType: 'primary',
      label: 'Codex primary',
      status: 'exhausted',
      usedPercent: 100,
      remainingPercent: 0,
      resetAt: '1970-01-01T00:33:20.000Z',
    },
    {
      rateLimitType: 'secondary',
      label: 'Codex secondary',
      status: 'available',
      usedPercent: 0,
      remainingPercent: 100,
      resetAt: null,
    },
    {
      rateLimitType: 'gpt-5.6-sol',
      label: 'gpt-5.6-sol',
      status: 'available',
      usedPercent: 37.5,
      remainingPercent: 62.5,
      resetAt: '1970-01-01T00:50:00.000Z',
    },
  ])
})
