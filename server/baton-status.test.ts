import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getBatonRuntimeStatus,
  parseCodexLoginStatus,
} from './baton-status.ts'

const gatewayBodies: Record<string, unknown> = {
  '/api/cliproxy/proxy-status': { running: true, port: 8317, version: '7.2.86' },
  '/api/cliproxy/routing/strategy': { strategy: 'fill-first' },
  '/api/cliproxy/routing/session-affinity': { enabled: false },
  '/api/cliproxy/auth/accounts/codex': {
    accounts: [
      { nickname: 'older', lastUsedAt: '2026-07-19T00:00:00.000Z' },
      { nickname: 'latest', lastUsedAt: '2026-07-20T00:00:00.000Z' },
    ],
  },
}

test('custom-provider status separates Baton auth from OpenAI login', async () => {
  const status = await getBatonRuntimeStatus({
    getClientIntegrationStatus: async () => ({
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
        codexMode: 'custom-provider',
      }],
    }),
    fetchGateway: async (requestPath) => ({
      status: 200,
      body: Buffer.from(JSON.stringify(gatewayBodies[requestPath])),
    }),
    inspectCodexLogin: async () => ({ kind: 'none', label: 'OpenAI/ChatGPT 로그인 없음' }),
    codexHome: () => 'C:\\Users\\test\\.codex',
    now: () => new Date('2026-07-20T01:02:03.000Z'),
  })

  assert.equal(status.codex.modelProvider, 'baton')
  assert.equal(status.codex.providerAuth, 'available')
  assert.equal(status.codex.openAiLogin.kind, 'none')
  assert.equal(status.codex.remotePluginCatalog.state, 'unavailable')
  assert.match(status.codex.notice, /BATON_PROXY_TOKEN/)
  assert.equal(status.inferenceAccount?.label, 'latest')
  assert.equal(status.inferenceAccount?.basis, 'most-recent-last-used')
})

test('ChatGPT login makes the remote catalog eligible without changing model auth', async () => {
  const status = await getBatonRuntimeStatus({
    getClientIntegrationStatus: async () => ({
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
        codexMode: 'custom-provider',
      }],
    }),
    fetchGateway: async (requestPath) => ({
      status: 200,
      body: Buffer.from(JSON.stringify(gatewayBodies[requestPath])),
    }),
    inspectCodexLogin: async () => ({ kind: 'chatgpt', label: 'ChatGPT 로그인됨' }),
    codexHome: () => '/tmp/codex',
    now: () => new Date('2026-07-20T01:02:03.000Z'),
  })

  assert.equal(status.codex.providerAuth, 'available')
  assert.equal(status.codex.remotePluginCatalog.state, 'eligible')
})

test('Codex login output is classified without exposing credentials', () => {
  assert.deepEqual(parseCodexLoginStatus('Not logged in'), {
    kind: 'none',
    label: 'OpenAI/ChatGPT 로그인 없음',
  })
  assert.deepEqual(parseCodexLoginStatus('Logged in using ChatGPT'), {
    kind: 'chatgpt',
    label: 'ChatGPT 로그인됨',
  })
})
