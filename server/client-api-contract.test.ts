import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiError, client } from '../src/api/client.ts'

test('client integration API preserves explicit repair eligibility', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json({
    supported: true,
    certainlyStopped: true,
    checkedAt: '2026-07-22T00:00:00.000Z',
    running: [],
    targets: [{
      target: 'codex',
      label: 'Codex CLI/Desktop',
      certainlyStopped: true,
      running: [],
      configuration: 'conflict',
      repairable: true,
      codexMode: 'native-openai',
    }],
  })) as typeof fetch
  try {
    const status = await client.getClientIntegrationStatus()
    assert.equal(status.targets[0]?.repairable, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Baton status uses the Baton-owned diagnostic endpoint', async () => {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input) => {
    urls.push(String(input))
    return Response.json({
      checkedAt: '2026-07-20T00:00:00.000Z',
      proxy: { running: true, port: 4400, version: 'baton-native', strategy: 'priority-failover', sessionAffinity: false },
      codex: {
        integrationMode: 'native-openai',
        configuration: 'applied',
        modelProvider: 'openai',
        providerAuth: 'available',
        openAiLogin: { kind: 'native-vault', label: 'Native OAuth 계정' },
        remotePluginCatalog: { state: 'unavailable', reason: 'test' },
        configuredHome: 'test',
        notice: 'test',
      },
      inferenceAccount: null,
      warnings: [],
    })
  }) as typeof fetch

  try {
    const status = await client.getBatonStatus()
    assert.equal(status.codex.modelProvider, 'openai')
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.deepEqual(urls, ['/baton/status'])
})

test('quota API preserves the structured reauth_required code for account UI state', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json({
    error: 'Claude 계정을 다시 인증하세요.',
    code: 'reauth_required',
  }, { status: 401 })) as typeof fetch
  try {
    await assert.rejects(
      client.getQuota('claude', 'expired-account'),
      (error: unknown) => error instanceof ApiError
        && error.status === 401
        && error.code === 'reauth_required',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Claude and Codex account operations always use Baton Native routes', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; method: string | undefined; body: unknown }> = []
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    calls.push({
      url,
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    if (url === '/baton/client-integration') {
      return Response.json({
        supported: true,
        certainlyStopped: true,
        checkedAt: '2026-07-20T00:00:00.000Z',
        running: [],
        targets: [
          {
            target: 'claude-cli',
            label: 'Claude CLI',
            certainlyStopped: true,
            running: [],
            configuration: 'applied',
            claudeProxyMode: 'native',
          },
          {
            target: 'codex',
            label: 'Codex',
            certainlyStopped: true,
            running: [],
            configuration: 'applied',
            codexMode: 'native-openai',
          },
        ],
      })
    }
    if (url.endsWith('/auth/start-url')) {
      return Response.json({ url: 'https://example.test/oauth', state: 'state-1' })
    }
    if (url.includes('/auth/status?')) return Response.json({ status: 'wait' })
    if (url.endsWith('/auth/submit-callback')) return Response.json({ success: true })
    if (url.includes('/quota/')) {
      return Response.json({ success: true, windows: [], lastUpdated: 0, accountId: 'account-1' })
    }
    return Response.json({ provider: 'test', accounts: [] })
  }) as typeof fetch

  try {
    await client.getAccounts()
    await client.getQuota('claude', 'claude/account')
    await client.pauseAccount('claude', 'claude/account')
    await client.resumeAccount('claude', 'claude/account')
    await client.removeAccount('claude', 'claude/account')
    await client.preferAccount('claude', 'claude/account')
    await client.startAddAccount('claude', 'Claude Two')
    await client.getAddStatus('claude', 'state 1')
    await client.submitCallback('claude', 'http://localhost:54545/callback?code=redacted')
    await client.cancelAddAccount('claude')

    await client.getQuota('codex', 'codex/account')
    await client.pauseAccount('codex', 'codex/account')
    await client.startAddAccount('codex', 'Codex Two')
  } finally {
    globalThis.fetch = originalFetch
  }

  const urls = calls.map((call) => call.url)
  assert.ok(urls.includes('/baton/claude-native/accounts'))
  assert.ok(urls.includes('/baton/claude-native/quota/claude%2Faccount'))
  assert.ok(urls.includes('/baton/claude-native/accounts/claude%2Faccount/pause'))
  assert.ok(urls.includes('/baton/claude-native/accounts/claude%2Faccount/resume'))
  assert.ok(urls.includes('/baton/claude-native/accounts/claude%2Faccount'))
  assert.ok(urls.includes('/baton/claude-native/accounts/claude%2Faccount/prefer'))
  assert.ok(urls.includes('/baton/claude-native/auth/start-url'))
  assert.ok(urls.includes('/baton/claude-native/auth/status?state=state%201'))
  assert.ok(urls.includes('/baton/claude-native/auth/submit-callback'))
  assert.ok(urls.includes('/baton/claude-native/auth/cancel'))

  assert.ok(urls.includes('/baton/codex-native/accounts'))
  assert.ok(urls.includes('/baton/codex-native/quota/codex%2Faccount'))
  assert.ok(urls.includes('/baton/codex-native/accounts/codex%2Faccount/pause'))
  assert.ok(urls.includes('/baton/codex-native/auth/start-url'))
  assert.equal(urls.some((url) => url.startsWith('/api/')), false)
})

test('model fallback settings use the Baton-owned control plane', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; method: string | undefined; body: unknown }> = []
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return Response.json({ enabled: false, promptDismissed: false, userMappings: {}, active: [], events: [] })
  }) as typeof fetch
  try {
    await client.getModelFallback()
    await client.setModelFallback({ enabled: true })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(calls, [
    { url: '/baton/model-fallback', method: 'GET', body: null },
    { url: '/baton/model-fallback', method: 'POST', body: { enabled: true } },
  ])
})

test('Codex plugin reference mutations use the explicit interaction contract', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; method: string | undefined; interaction: string | null; body: unknown }> = []
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      interaction: new Headers(init?.headers).get('x-baton-interaction'),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    if (String(input).endsWith('/preview')) {
      return Response.json({
        current: { state: { revision: 2 } },
        target: { mode: 'local_only', accountId: null },
        targetAccountRevision: null,
        previewDigest: 'a'.repeat(64),
      })
    }
    return Response.json({})
  }) as typeof fetch
  try {
    const preview = await client.previewCodexPluginReference({ mode: 'local_only', accountId: null })
    await client.switchCodexPluginReference(preview)
    await client.installCodexPlugin({ marketplacePath: 'C:\\market', pluginName: 'plugin-a' })
    await client.uninstallCodexPlugin('plugin-a')
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(calls.map((call) => ({
    url: call.url,
    method: call.method,
    interaction: call.interaction,
  })), [
    { url: '/baton/codex-plugins/reference/preview', method: 'POST', interaction: 'codex-plugin-control' },
    { url: '/baton/codex-plugins/reference/switch', method: 'POST', interaction: 'codex-plugin-control' },
    { url: '/baton/codex-plugins/install', method: 'POST', interaction: 'codex-plugin-control' },
    { url: '/baton/codex-plugins/uninstall', method: 'POST', interaction: 'codex-plugin-control' },
  ])
  assert.deepEqual(calls[1]?.body, {
    mode: 'local_only',
    accountId: null,
    expectedStateRevision: 2,
    expectedTargetAccountRevision: null,
    previewDigest: 'a'.repeat(64),
  })
})

test('Codex plugin reference candidates always use the Native vault endpoint', async () => {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input) => {
    urls.push(String(input))
    return Response.json({ accounts: [{ id: 'native-account' }] })
  }) as typeof fetch
  try {
    assert.deepEqual(await client.getCodexPluginAccounts(), [{ id: 'native-account' }])
    await client.removeCodexPluginAccount('native-account', 7)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(urls, [
    '/baton/codex-native/accounts',
    '/baton/codex-native/accounts/native-account',
  ])
})

test('Codex OAuth creates one unified Native account for model and plugin use', async () => {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  let startBody: unknown = null
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    urls.push(url)
    if (url.endsWith('/auth/start-url')) {
      startBody = init?.body ? JSON.parse(String(init.body)) : null
      return Response.json({ url: 'https://auth.openai.com/oauth/authorize', state: 'plugin-state' })
    }
    if (url.includes('/auth/status?')) return Response.json({ status: 'wait' })
    return Response.json({ success: true })
  }) as typeof fetch
  try {
    await client.startAddAccount('codex', 'Plugin Account', true)
    await client.getAddStatus('codex', 'plugin-state', true)
    await client.submitCallback('codex', 'http://localhost:1455/auth/callback?code=x&state=plugin-state', true)
    await client.cancelAddAccount('codex', true)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(urls, [
    '/baton/codex-native/auth/start-url',
    '/baton/codex-native/auth/status?state=plugin-state',
    '/baton/codex-native/auth/submit-callback',
    '/baton/codex-native/auth/cancel',
  ])
  assert.deepEqual(startBody, { nickname: 'Plugin Account' })
})

test('native-openai Codex account operations stay on Baton-owned routes', async () => {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input) => {
    const url = String(input)
    urls.push(url)
    if (url === '/baton/client-integration') {
      return Response.json({
        supported: true,
        certainlyStopped: true,
        checkedAt: '2026-07-20T00:00:00.000Z',
        running: [],
        targets: [{
          target: 'codex',
          label: 'Codex',
          certainlyStopped: true,
          running: [],
          configuration: 'applied',
          codexMode: 'native-openai',
        }],
      })
    }
    if (url.endsWith('/auth/start-url')) return Response.json({ url: 'https://auth.openai.com/oauth/authorize', state: 'state' })
    if (url.includes('/quota/')) return Response.json({ success: true, windows: [], lastUpdated: 0, accountId: 'codex/account' })
    return Response.json({ provider: 'codex', accounts: [] })
  }) as typeof fetch

  try {
    await client.getAccounts()
    await client.getQuota('codex', 'codex/account')
    await client.pauseAccount('codex', 'codex/account')
    await client.resumeAccount('codex', 'codex/account')
    await client.removeAccount('codex', 'codex/account')
    await client.startAddAccount('codex', 'Codex Native')
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.ok(urls.includes('/baton/codex-native/accounts'))
  assert.ok(urls.includes('/baton/codex-native/quota/codex%2Faccount'))
  assert.ok(urls.includes('/baton/codex-native/accounts/codex%2Faccount/pause'))
  assert.ok(urls.includes('/baton/codex-native/accounts/codex%2Faccount/resume'))
  assert.ok(urls.includes('/baton/codex-native/accounts/codex%2Faccount'))
  assert.ok(urls.includes('/baton/codex-native/auth/start-url'))
  assert.equal(urls.some((url) => url.startsWith('/api/')), false)
})

test('client integration mutation refreshes a rejected capability exactly once', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; capability?: string }> = []
  let capabilityCount = 0
  let mutationCount = 0
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    calls.push({ url, capability: headers.get('X-Baton-Client-Capability') ?? undefined })
    if (url.endsWith('/capability')) {
      capabilityCount += 1
      return Response.json({ capability: `cap-${capabilityCount}` })
    }
    mutationCount += 1
    if (mutationCount === 1) return Response.json({ error: 'expired' }, { status: 403 })
    return Response.json({
      applied: true,
      updated: ['Codex CLI/Desktop'],
      restartRequired: true,
      results: [{ target: 'codex', label: 'Codex CLI/Desktop', ok: true }],
    })
  }) as typeof fetch
  try {
    const result = await client.applyClientIntegration(['codex'])
    assert.equal(result.applied, true)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(calls, [
    { url: '/baton/client-integration/capability', capability: undefined },
    { url: '/baton/client-integration/apply', capability: 'cap-1' },
    { url: '/baton/client-integration/capability', capability: undefined },
    { url: '/baton/client-integration/apply', capability: 'cap-2' },
  ])
})
