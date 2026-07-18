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
  private readonly initializationTimeoutMs: number
  private readonly shutdownTimeoutMs: number

  constructor(options: { initializationTimeoutMs?: number; shutdownTimeoutMs?: number } = {}) {
    this.initializationTimeoutMs = positiveTimeout(options.initializationTimeoutMs ?? 30_000)
    this.shutdownTimeoutMs = positiveTimeout(options.shutdownTimeoutMs ?? 10_000)
  }

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

    const pending = registryTimeout(
      adapter.initialize().then((handshake) => {
        assertCanonicalAdapterHandshake(handshake)
        return { adapter, handshake }
      }),
      this.initializationTimeoutMs,
      `${provider} adapter initialization`,
    )
    this.initialization.set(provider, pending)
    try {
      return await pending
    } catch (error) {
      this.initialization.delete(provider)
      throw error
    }
  }

  async shutdownAll(): Promise<void> {
    await Promise.allSettled([...this.adapters.values()].map((adapter) => registryTimeout(
      adapter.shutdown(),
      this.shutdownTimeoutMs,
      `${adapter.provider} adapter shutdown`,
    )))
    this.initialization.clear()
  }
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Adapter timeout must be a positive integer')
  return value
}

async function registryTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
