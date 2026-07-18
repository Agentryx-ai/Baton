import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Router } from 'express'
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
  adapters.register(new CodexCanonicalAdapter({ executable: options.codexExecutable }))
  const events = new ConversationEventHub()
  const service = new TurnOrchestrator(store, adapters, events)
  const router = createConversationRouter(service)

  return {
    router,
    service,
    start: () => service.recoverInterruptedTurns(),
    closeStreams: () => router.closeStreams(),
    close: () => service.close(),
  }
}
