import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  NativeProviderEvent,
  NativeTurnRequest,
  ProviderTurnExecution,
  SessionProviderAdapter,
} from './adapter.ts'
import { AdapterRegistry } from './adapter-registry.ts'
import type { NewCanonicalItem } from './domain.ts'

function adapter(nativeChildExecution: 'disabled' | 'exposed'): SessionProviderAdapter {
  return {
    provider: 'codex',
    async initialize() {
      return {
        adapterVersion: 'test',
        capabilities: {
          roles: ['user', 'assistant'],
          contentTypes: ['text'],
          toolCalling: true,
          parallelTools: false,
          contextWindow: null,
          continuation: 'native',
          reasoningState: 'opaque',
          taskMetadata: true,
          nativeChildExecution,
        },
        exposedNativeAgentTools: nativeChildExecution === 'exposed' ? ['spawn_agent'] : [],
        enforcementEvidence: {},
      }
    },
    validate() {},
    materialize(): NativeTurnRequest { return { body: {} } },
    async execute(): Promise<ProviderTurnExecution> {
      return {
        events: (async function* (): AsyncIterable<NativeProviderEvent> {})(),
        terminal: Promise.resolve({ status: 'completed' }),
        async cancel() {},
        async dispose() {},
      }
    },
    normalize(): NewCanonicalItem[] { return [] },
    extractBinding() { return null },
    async shutdown() {},
  }
}

test('AdapterRegistry rejects native child execution before a turn can start', async () => {
  const registry = new AdapterRegistry()
  registry.register(adapter('exposed'))
  await assert.rejects(registry.getReady('codex'), /native child execution/)
})

test('AdapterRegistry returns a canonical-safe adapter', async () => {
  const registry = new AdapterRegistry()
  registry.register(adapter('disabled'))
  const ready = await registry.getReady('codex')
  assert.equal(ready.adapter.provider, 'codex')
  assert.equal(ready.handshake.capabilities.nativeChildExecution, 'disabled')
})

test('AdapterRegistry bounds readiness and never waits for a hung initialization during shutdown', async () => {
  const hanging = adapter('disabled')
  let shutdownCalled = false
  hanging.initialize = async () => new Promise(() => undefined)
  hanging.shutdown = async () => { shutdownCalled = true }
  const registry = new AdapterRegistry({ initializationTimeoutMs: 5, shutdownTimeoutMs: 5 })
  registry.register(hanging)

  await assert.rejects(registry.getReady('codex'), /initialization timed out after 5ms/)
  await registry.shutdownAll()
  assert.equal(shutdownCalled, true)
})
