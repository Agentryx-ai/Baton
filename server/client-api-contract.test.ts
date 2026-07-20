import assert from 'node:assert/strict'
import test from 'node:test'

import { client } from '../src/api/client.ts'

test('Baton status uses the Baton-owned diagnostic endpoint', async () => {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input) => {
    urls.push(String(input))
    return Response.json({
      checkedAt: '2026-07-20T00:00:00.000Z',
      proxy: { running: true, port: 8317, version: 'test', strategy: 'fill-first', sessionAffinity: false },
      codex: {
        integrationMode: 'custom-provider',
        configuration: 'applied',
        modelProvider: 'baton',
        providerAuth: 'available',
        openAiLogin: { kind: 'none', label: 'OpenAI/ChatGPT 로그인 없음' },
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
    assert.equal(status.codex.modelProvider, 'baton')
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.deepEqual(urls, ['/baton/status'])
})

test('routing settings use the installed CCS PUT contracts', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; method: string | undefined; body: unknown }> = []
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return Response.json({ success: true })
  }) as typeof fetch

  try {
    await client.setRoutingStrategy('fill-first')
    await client.setSessionAffinity(true, '2h')
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.deepEqual(calls, [
    {
      url: '/api/cliproxy/routing/strategy',
      method: 'PUT',
      body: { value: 'fill-first' },
    },
    {
      url: '/api/cliproxy/routing/session-affinity',
      method: 'PUT',
      body: { enabled: true, ttl: '2h' },
    },
  ])
})

test('Claude account operations use Native routes while a custom-provider Codex stays on CLIProxy', async () => {
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
            codexMode: 'custom-provider',
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

  assert.ok(urls.includes('/api/cliproxy/auth/accounts/codex'))
  assert.ok(urls.includes('/api/cliproxy/quota/codex/codex%2Faccount'))
  assert.ok(urls.includes('/api/cliproxy/auth/accounts/codex/codex%2Faccount/pause'))
  assert.ok(urls.includes('/api/cliproxy/auth/codex/start-url'))
  assert.equal(urls.some((url) => url.startsWith('/api/cliproxy/') && url.includes('claude')), false)
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

test('native-openai Codex account operations never call CLIProxy', async () => {
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
  assert.equal(urls.some((url) => url.startsWith('/api/cliproxy/') && url.includes('codex')), false)
})
