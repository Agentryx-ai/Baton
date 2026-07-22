/** Baton Native local control plane, inference proxies, and SPA host. */
import express from 'express'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { config } from './config.ts'
import { batonRouter } from './baton-routes.ts'
import { createHostRouter } from './host-routes.ts'
import { CODEX_NATIVE_PROXY_PATH } from './client-integration.ts'
import { createCodexNativeProxy } from './codex-native-proxy.ts'
import { createCodexResponsesWebSocketRoute } from './codex-native-websocket.ts'
import { createWebSocketUpgradeDispatcher } from './websocket-upgrade-dispatcher.ts'
import { createRawPassthroughBody } from './raw-passthrough-body.ts'
import { codexNativeRuntime, loadNativeCodexProxyConnection } from './codex-native-runtime.ts'
import { CodexNativeOAuthManager } from './codex-native-oauth.ts'
import { createCodexNativeAccountRouter } from './codex-native-account-routes.ts'
import { CLAUDE_NATIVE_PROXY_PATH, createClaudeNativeProxy } from './claude-native-proxy.ts'
import { createClaudeNativeAccountRouter } from './claude-native-account-routes.ts'
import {
  claudeNativeAccountVault,
  claudeNativeOAuthManager,
  ensureNativeClaudeAccounts,
  claudeQuotaPreflight,
  loadNativeClaudeAccountCredential,
  loadNativeClaudeCredentialCandidates,
  loadNativeClaudeProxyConnection,
} from './claude-native-runtime.ts'
import { createInlineSessionHost, createWorkerSessionHost } from './session-host.ts'
import { ModelFallbackRuntime, modelFallbackStatePath } from './model-fallback-runtime.ts'
import { createModelFallbackRouter } from './model-fallback-routes.ts'
import { NativeProxyHealthTracker } from './native-proxy-health.ts'
import { classifyPortConflict } from './port-guard.ts'
import { NativeAccountCooldowns } from './native-account-router.ts'
import { CodexPluginReferenceStore, codexPluginReferenceStatePath } from './codex-plugin-reference-store.ts'
import { CodexPluginReferenceService } from './codex-plugin-reference-service.ts'
import { createCodexPluginRouter } from './codex-plugin-routes.ts'

const app = express()
// The conversation runtime owns every synchronous SQLite call. By default it
// runs on a dedicated worker thread so a database stall (lock contention, WAL
// checkpoint) can never freeze the inference proxies or health endpoint.
const sessionHost = process.env.BATON_SESSION_HOST === 'inline'
  ? createInlineSessionHost({ dataDir: config.dataDir })
  : createWorkerSessionHost({
    dataDir: config.dataDir,
    onStarted: (recovered) => {
      if (recovered > 0) console.warn(`[baton] recovered ${recovered} interrupted canonical turns`)
    },
  })
const startedAt = new Date().toISOString()
const codexNativeOAuthManager = new CodexNativeOAuthManager({ vault: codexNativeRuntime.vault })
const modelFallbackRuntime = new ModelFallbackRuntime({
  filePath: modelFallbackStatePath(config.dataDir),
})
const claudeNativeHealth = new NativeProxyHealthTracker({ provider: 'claude' })
const codexNativeHealth = new NativeProxyHealthTracker({ provider: 'codex' })
const codexNativeCooldowns = new NativeAccountCooldowns()
const codexPluginReference = new CodexPluginReferenceService({
  runtime: codexNativeRuntime,
  store: new CodexPluginReferenceStore({
    filePath: codexPluginReferenceStatePath(config.dataDir),
  }),
})

// Canonical JSON routes must consume their body before the raw gateway proxy
// middleware. In worker mode this streams bodies verbatim to the session host.
app.use('/baton/v1', sessionHost.middleware)

// Codex can zstd-compress large prompts. Capture those bytes before Express's
// raw parser attempts (and fails) to decode an unsupported content encoding.
const codexNativeProxyOptions = {
  loadAccounts: () => codexNativeRuntime.loadProxyAccounts(),
  loadClientToken: async () => (await loadNativeCodexProxyConnection(false)).token,
  trustLoopbackClient: true,
  health: codexNativeHealth,
  cooldowns: codexNativeCooldowns,
}
app.use(CODEX_NATIVE_PROXY_PATH, createRawPassthroughBody(), createCodexNativeProxy(
  codexNativeProxyOptions,
))

// Remaining control-plane bodies are ordinary uncompressed JSON.
app.use(express.raw({ type: () => true, limit: '10mb' }))

app.get('/baton/health', (_req, res) => {
  res.json({
    ok: true,
    sessionHost: sessionHost.snapshot(),
    nativeProxy: {
      claude: claudeNativeHealth.snapshot(),
      codex: codexNativeHealth.snapshot(),
    },
  })
})
app.get('/baton/proxy-status', (_req, res) => {
  res.json({
    running: true,
    port: config.port,
    pid: process.pid,
    sessionCount: 0,
    startedAt,
    version: 'baton-native',
    target: 'Baton Native',
  })
})

app.use('/baton/codex-native', createCodexNativeAccountRouter({
  runtime: codexNativeRuntime,
  oauth: codexNativeOAuthManager,
  pluginReference: codexPluginReference,
}))
app.use('/baton/codex-plugins', createCodexPluginRouter(codexPluginReference))

// Baton-owned Claude data plane. It is always available on the loopback-only
// BFF, but Claude clients use it only after explicit integration selection.
app.use(CLAUDE_NATIVE_PROXY_PATH, createClaudeNativeProxy({
  loadCredentialCandidates: () => loadNativeClaudeCredentialCandidates(),
  loadClientToken: async () => (await loadNativeClaudeProxyConnection(false)).token,
  checkModelQuota: (model, credential) => claudeQuotaPreflight.check(model, credential),
  modelFallback: modelFallbackRuntime,
  health: claudeNativeHealth,
}))
app.use('/baton/claude-native', createClaudeNativeAccountRouter({
  vault: claudeNativeAccountVault,
  oauth: claudeNativeOAuthManager,
  ensureAccounts: ensureNativeClaudeAccounts,
  getQuota: async (accountId) => claudeQuotaPreflight.accountQuota(
    await loadNativeClaudeAccountCredential(accountId),
  ),
}))
app.use('/baton/model-fallback', createModelFallbackRouter(modelFallbackRuntime))

app.use(batonRouter)
app.use(createHostRouter())

// Production: serve the built SPA with history-API fallback.
const distDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../dist')
if (existsSync(distDir)) {
  app.use(express.static(distDir))
  app.use((_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

// Bind to loopback only — local single-user tool (DESIGN.md §7).
const server = createServer(app)
const websocketUpgradeDispatcher = createWebSocketUpgradeDispatcher()
websocketUpgradeDispatcher.register(createCodexResponsesWebSocketRoute(codexNativeProxyOptions))
websocketUpgradeDispatcher.attach(server)
// A duplicate supervisor (Task Scheduler self-heal trigger firing while a
// healthy worker already holds the port) must not crash-loop on EADDRINUSE.
// Probe the incumbent: if it is a healthy Baton, stand down cleanly (exit 0 so
// baton-worker-runner stops retrying); otherwise surface the real conflict.
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EADDRINUSE') {
    console.error('[baton] fatal server error:', error)
    process.exit(1)
    return
  }
  void classifyPortConflict(config.port).then(async (verdict) => {
    if (verdict === 'yield') {
      console.warn(`[baton] http://127.0.0.1:${config.port} already served by a healthy Baton; duplicate worker standing down`)
    } else {
      console.error(`[baton] port ${config.port} is held by a non-Baton process; refusing to start`)
    }
    await sessionHost.close().catch(() => { /* best-effort before exit */ })
    process.exit(verdict === 'yield' ? 0 : 1)
  })
})
server.listen(config.port, '127.0.0.1', () => {
  console.log(`[baton] Native runtime on http://127.0.0.1:${config.port}`)
  // Worker mode starts (and reports recovery) on its own thread; inline mode
  // runs the same recovery here.
  const recovered = sessionHost.start()
  if (recovered !== null && recovered > 0) {
    console.warn(`[baton] recovered ${recovered} interrupted canonical turns`)
  }
})

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[baton] ${signal}: shutting down`)
  await websocketUpgradeDispatcher.close()
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  sessionHost.closeStreams()
  const drained = await Promise.race([
    closed.then(() => true),
    new Promise<false>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000)
      timer.unref()
    }),
  ])
  if (!drained) {
    server.closeAllConnections()
    await closed
  }
  await sessionHost.close()
}

process.once('SIGINT', () => { void shutdown('SIGINT') })
process.once('SIGTERM', () => { void shutdown('SIGTERM') })
