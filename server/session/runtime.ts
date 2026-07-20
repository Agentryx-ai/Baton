import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Router } from 'express'
import { parse as parseToml } from 'smol-toml'
import { loadProxyConnection } from '../client-integration.ts'
import { AdapterRegistry } from './adapter-registry.ts'
import { CanonicalContextRuntime } from './canonical-context-runtime.ts'
import { CodexCanonicalAdapter } from './codex-adapter.ts'
import { StatelessHttpCanonicalAdapter } from './stateless-http-adapter.ts'
import { buildProviderModelCatalog } from './model-catalog.ts'
import { ConversationEventHub } from './event-hub.ts'
import { TurnOrchestrator } from './orchestrator.ts'
import { createConversationRouter } from './router.ts'
import { SqliteSessionStore } from './sqlite-store.ts'
import { runSessionRetentionSweep, SESSION_RETENTION_INTERVAL_MS } from './retention.ts'
import { CodexLocalSourceReader } from './native-import/codex-source.ts'
import { ClaudeLocalSourceReader } from './native-import/claude-source.ts'
import { NativeSessionImportService } from './native-import/service.ts'
import { LocalImageArtifactStore } from './image-artifacts.ts'
import { discoverSkillResources } from './tools/skill-resource-runtime.ts'

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
  const imageArtifacts = new LocalImageArtifactStore(path.join(options.dataDir, 'image-artifacts'))
  const nativeNamespaceSecret = store.getNativeImportNamespaceKey()
  const adapters = new AdapterRegistry()
  adapters.register(new CodexCanonicalAdapter({
    executable: options.codexExecutable,
    cacheIdentitySecret: nativeNamespaceSecret,
    imageArtifacts,
    proxyConnection: async () => {
      const connection = await loadProxyConnection(false)
      return { baseUrl: connection.baseUrl, token: connection.token }
    },
  }))
  const statelessProxyConnection = async () => {
    const connection = await loadProxyConnection(false)
    return { baseUrl: connection.baseUrl, token: connection.token }
  }
  adapters.register(new StatelessHttpCanonicalAdapter({
    provider: 'claude',
    proxyConnection: statelessProxyConnection,
    imageArtifacts,
    skillResources: discoverSkillResources([
      path.join(homedir(), '.claude', 'skills'),
      path.join(homedir(), '.agents', 'skills'),
    ]),
  }))
  adapters.register(new StatelessHttpCanonicalAdapter({
    provider: 'gemini',
    proxyConnection: statelessProxyConnection,
    imageArtifacts,
  }))
  const events = new ConversationEventHub()
  const contextRuntime = new CanonicalContextRuntime(store)
  const service = new TurnOrchestrator(store, adapters, events, 10_000, contextRuntime, {
    artifacts: imageArtifacts,
  })
  const nativeImport = new NativeSessionImportService(store, [
    new CodexLocalSourceReader({ namespaceSecret: nativeNamespaceSecret }),
    new ClaudeLocalSourceReader({ namespaceSecret: nativeNamespaceSecret }),
  ])
  const router = createConversationRouter(service, {
    nativeImport,
    imageArtifacts,
    listModels: async (provider) => {
      const connection = await loadProxyConnection(true)
      const configuredDefault = provider === 'codex'
        ? await configuredDefaultModel(connection.models)
        : null
      const catalog = buildProviderModelCatalog(provider, connection.models, configuredDefault)
      return { models: catalog.models, defaultModel: catalog.defaultModel }
    },
  })
  let retentionTimer: ReturnType<typeof setInterval> | null = null

  const sweepTrash = (): void => {
    try {
      const purged = runSessionRetentionSweep(store)
      if (purged > 0) console.info(`[baton] permanently removed ${purged} expired conversations`)
    } catch (error) {
      console.error(`[baton] conversation retention failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    router,
    service,
    start: () => {
      const recovered = service.recoverInterruptedTurns()
      void service.startGoalRuntime().catch((error) => {
        console.error(`[baton] Goal runtime failed to start: ${error instanceof Error ? error.message : String(error)}`)
      })
      sweepTrash()
      if (!retentionTimer) {
        retentionTimer = setInterval(sweepTrash, SESSION_RETENTION_INTERVAL_MS)
        retentionTimer.unref()
      }
      return recovered
    },
    closeStreams: () => router.closeStreams(),
    close: () => {
      if (retentionTimer) clearInterval(retentionTimer)
      retentionTimer = null
      return service.close()
    },
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
