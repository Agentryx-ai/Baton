import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CodexPluginControlPlane,
  CodexPluginControlPlaneError,
  type CodexPluginCredential,
  codexPluginChildEnvironment,
  codexPluginLoginParams,
} from './codex-plugin-control-plane.ts'

const credential = {
  accessToken: 'secret',
  chatgptAccountId: 'chatgpt-account-1',
  plan: 'pro',
}

function catalog(pluginId = 'plugin-a'): Record<string, unknown> {
  return {
    marketplaces: [{
      name: 'market',
      path: null,
      interface: { displayName: 'Market' },
      plugins: [{
        id: pluginId,
        remotePluginId: `remote-${pluginId}`,
        name: pluginId,
        installed: false,
        enabled: true,
        installPolicy: 'AVAILABLE',
        authPolicy: 'ON_USE',
        availability: 'AVAILABLE',
        interface: { displayName: 'Plugin A', shortDescription: 'Fixture' },
      }],
    }],
    marketplaceLoadErrors: [],
    featuredPluginIds: [pluginId],
  }
}

test('Codex plugin catalog is normalized and account mode requests every supported marketplace kind', async () => {
  const calls: Array<{ method: string; params: unknown; credential?: CodexPluginCredential }> = []
  const control = new CodexPluginControlPlane({
    now: () => new Date('2026-07-20T00:00:00.000Z'),
    invoke: async (input) => {
      calls.push(input)
      return catalog()
    },
  })

  const result = await control.list({ accountId: 'account-1', credential, cwds: ['C:\\repo'] })
  assert.equal(result.accountId, 'account-1')
  assert.equal(result.marketplaces[0]?.plugins[0]?.displayName, 'Plugin A')
  assert.deepEqual(calls, [
    {
      method: 'plugin/list',
      params: {
        cwds: ['C:\\repo'],
        marketplaceKinds: ['local', 'vertical', 'workspace-directory', 'shared-with-me', 'created-by-me-remote'],
      },
      credential,
    },
  ])
})

test('Codex plugin account mode rejects incomplete ChatGPT credentials', async () => {
  const control = new CodexPluginControlPlane({
    invoke: async () => catalog(),
  })
  await assert.rejects(
    control.list({ accountId: 'account-1', credential: { accessToken: 'token' } }),
    (error: unknown) => error instanceof CodexPluginControlPlaneError && error.code === 'invalid',
  )
})

test('Codex plugin child environment removes Baton, gateway, and inherited API credentials', () => {
  assert.deepEqual(codexPluginChildEnvironment({
    PATH: 'safe',
    BATON_PROXY_TOKEN: 'baton-secret',
    GATEWAY_PASS: 'gateway-secret',
    OPENAI_API_KEY: 'openai-secret',
    CODEX_API_KEY: 'codex-secret',
    CODEX_ACCESS_TOKEN: 'old-token',
    CODEX_HOME: 'keep-home',
  }), { PATH: 'safe', CODEX_HOME: 'keep-home' })
})

test('Codex plugin account auth uses the app-server ChatGPT token contract', () => {
  assert.deepEqual(codexPluginLoginParams(credential), {
    type: 'chatgptAuthTokens',
    accessToken: 'secret',
    chatgptAccountId: 'chatgpt-account-1',
    chatgptPlanType: 'pro',
  })
  assert.throws(
    () => codexPluginLoginParams({ accessToken: 'secret' }),
    (error: unknown) => error instanceof CodexPluginControlPlaneError && error.code === 'invalid',
  )
})

test('Codex plugin install enforces the marketplace XOR and remote authentication contract', async () => {
  const control = new CodexPluginControlPlane({
    invoke: async () => ({ authPolicy: 'ON_INSTALL', appsNeedingAuth: [] }),
  })
  await assert.rejects(
    control.install({ pluginName: 'plugin-a' }),
    (error: unknown) => error instanceof CodexPluginControlPlaneError && error.code === 'invalid',
  )
  await assert.rejects(
    control.install({ marketplacePath: 'C:\\market', remoteMarketplaceName: 'remote', pluginName: 'plugin-a' }),
    (error: unknown) => error instanceof CodexPluginControlPlaneError && error.code === 'invalid',
  )
  await assert.rejects(
    control.install({ remoteMarketplaceName: 'remote', pluginName: 'plugin-a' }),
    (error: unknown) => error instanceof CodexPluginControlPlaneError && error.code === 'authentication',
  )
  assert.deepEqual(await control.install({ marketplacePath: 'C:\\market', pluginName: 'plugin-a' }), {
    authPolicy: 'ON_INSTALL',
    appsNeedingAuth: [],
  })
})
