import {
  assertCanonicalAdapterHandshake,
  type AdapterHandshake,
  type SessionProviderAdapter,
} from './adapter.ts'
import type { CanonicalProvider } from './domain.ts'

interface ReadyAdapter {
  adapter: SessionProviderAdapter
  handshake: AdapterHandshake
}

export class AdapterRegistry {
  private readonly adapters = new Map<CanonicalProvider, SessionProviderAdapter>()
  private readonly initialization = new Map<CanonicalProvider, Promise<ReadyAdapter>>()

  register(adapter: SessionProviderAdapter): void {
    if (this.adapters.has(adapter.provider)) {
      throw new Error(`Adapter already registered: ${adapter.provider}`)
    }
    this.adapters.set(adapter.provider, adapter)
  }

  has(provider: CanonicalProvider): boolean {
    return this.adapters.has(provider)
  }

  async getReady(provider: CanonicalProvider): Promise<ReadyAdapter> {
    const existing = this.initialization.get(provider)
    if (existing) return existing

    const adapter = this.adapters.get(provider)
    if (!adapter) throw new Error(`No provider adapter registered: ${provider}`)

    const pending = adapter.initialize().then((handshake) => {
      assertCanonicalAdapterHandshake(handshake)
      return { adapter, handshake }
    })
    this.initialization.set(provider, pending)
    try {
      return await pending
    } catch (error) {
      this.initialization.delete(provider)
      throw error
    }
  }

  async shutdownAll(): Promise<void> {
    const initialized = await Promise.allSettled(this.initialization.values())
    await Promise.allSettled(initialized.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value.adapter.shutdown()] : [],
    ))
    this.initialization.clear()
  }
}
