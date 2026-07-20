import assert from 'node:assert/strict'
import test from 'node:test'

import { getBatonRuntimeStatus } from './baton-status.ts'

test('runtime status derives integration, plugin eligibility, and routing account from Native state', async () => {
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
        codexMode: 'native-openai',
      }],
    }),
    listCodexAccounts: async () => [
      { alias: 'reserve', enabled: true, priority: 20 },
      { alias: 'primary', enabled: true, priority: 10 },
    ],
    codexHome: () => 'C:\\Users\\test\\.codex',
    now: () => new Date('2026-07-20T01:02:03.000Z'),
  })

  assert.equal(status.proxy.strategy, 'priority-failover')
  assert.equal(status.codex.modelProvider, 'openai')
  assert.equal(status.codex.providerAuth, 'available')
  assert.equal(status.codex.openAiLogin.kind, 'native-vault')
  assert.equal(status.codex.remotePluginCatalog.state, 'eligible')
  assert.equal(status.inferenceAccount?.label, 'primary')
  assert.equal(status.inferenceAccount?.basis, 'native-priority')
})

test('runtime status reports unavailable plugin catalog when the Native vault is empty', async () => {
  const status = await getBatonRuntimeStatus({
    getClientIntegrationStatus: async () => ({
      supported: true,
      certainlyStopped: true,
      checkedAt: '2026-07-20T00:00:00.000Z',
      running: [],
      targets: [],
    }),
    listCodexAccounts: async () => [],
  })
  assert.equal(status.codex.openAiLogin.kind, 'none')
  assert.equal(status.codex.remotePluginCatalog.state, 'unavailable')
  assert.equal(status.inferenceAccount, null)
})
