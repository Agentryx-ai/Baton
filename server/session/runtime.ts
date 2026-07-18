import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Router } from 'express'
import { parse as parseToml } from 'smol-toml'
import { loadProxyConnection } from '../client-integration.ts'
import { AdapterRegistry } from './adapter-registry.ts'
import { CodexCanonicalAdapter } from './codex-adapter.ts'
import { ConversationEventHub } from './event-hub.ts'
import { TurnOrchestrator } from './orchestrator.ts'
import { createConversationRouter } from './router.ts'
import { SqliteSessionStore } from './sqlite-store.ts'

export interface ConversationRuntimeOptions {
  dataDir: string
  codexExecutable?: string
}

export interface ConversationRuntime {
  router: Router
  service: TurnOrchestrator
  start(): number
  closeStreams(): void
  close(): Promise<void>
}

export function createConversationRuntime(options: ConversationRuntimeOptions): ConversationRuntime {
  mkdirSync(options.dataDir, { recursive: true })
  const store = new SqliteSessionStore(path.join(options.dataDir, 'canonical-conversations.sqlite3'))
  const adapters = new AdapterRegistry()
  adapters.register(new CodexCanonicalAdapter({
    executable: options.codexExecutable,
    proxyConnection: async () => {
      const connection = await loadProxyConnection(false)
      return { baseUrl: connection.baseUrl, token: connection.token }
    },
  }))
  const events = new ConversationEventHub()
  const service = new TurnOrchestrator(store, adapters, events)
  const router = createConversationRouter(service, {
    listModels: async (provider) => {
      if (provider !== 'codex') return { models: [], defaultModel: null }
      const connection = await loadProxyConnection(true)
      const models = connection.models.filter(
        (id) => id.startsWith('gpt-') && !id.startsWith('gpt-image-'),
      )
      return { models, defaultModel: await configuredDefaultModel(models) }
    },
  })

  return {
    router,
    service,
    start: () => service.recoverInterruptedTurns(),
    closeStreams: () => router.closeStreams(),
    close: () => service.close(),
  }
}

async function configuredDefaultModel(models: string[]): Promise<string | null> {
  try {
    const content = await readFile(path.join(homedir(), '.codex', 'config.toml'), 'utf8')
    const parsed = parseToml(content) as Record<string, unknown>
    return typeof parsed.model === 'string' && models.includes(parsed.model)
      ? parsed.model
      : null
  } catch {
    return null
  }
}
