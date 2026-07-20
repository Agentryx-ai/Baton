/** Baton Native local control plane, inference proxies, and SPA host. */
import express from 'express'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { config } from './config.ts'
import { batonRouter } from './baton-routes.ts'
import { createHostRouter } from './host-routes.ts'
import { CODEX_NATIVE_PROXY_PATH } from './client-integration.ts'
import { createCodexNativeProxy } from './codex-native-proxy.ts'
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
import { createConversationRuntime } from './session/runtime.ts'
import { ModelFallbackRuntime, modelFallbackStatePath } from './model-fallback-runtime.ts'
import { createModelFallbackRouter } from './model-fallback-routes.ts'
import { NativeProxyHealthTracker } from './native-proxy-health.ts'
import { CodexPluginReferenceStore, codexPluginReferenceStatePath } from './codex-plugin-reference-store.ts'
import { CodexPluginReferenceService } from './codex-plugin-reference-service.ts'
import { createCodexPluginRouter } from './codex-plugin-routes.ts'

const app = express()
const conversationRuntime = createConversationRuntime({ dataDir: config.dataDir })
const startedAt = new Date().toISOString()
const codexNativeOAuthManager = new CodexNativeOAuthManager({ vault: codexNativeRuntime.vault })
const modelFallbackRuntime = new ModelFallbackRuntime({
  filePath: modelFallbackStatePath(config.dataDir),
})
const claudeNativeHealth = new NativeProxyHealthTracker({ provider: 'claude' })
const codexNativeHealth = new NativeProxyHealthTracker({ provider: 'codex' })
const codexPluginReference = new CodexPluginReferenceService({
  runtime: codexNativeRuntime,
  store: new CodexPluginReferenceStore({
    filePath: codexPluginReferenceStatePath(config.dataDir),
  }),
})

// Canonical JSON routes must consume their body before the raw gateway proxy middleware.
app.use('/baton/v1', conversationRuntime.router)

// Raw passthrough: bodies forwarded byte-for-byte (JSON stays JSON).
app.use(express.raw({ type: () => true, limit: '10mb' }))

app.get('/baton/health', (_req, res) => {
  res.json({
    ok: true,
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

// Baton-owned Codex data plane.
app.use(CODEX_NATIVE_PROXY_PATH, createCodexNativeProxy({
  loadAccounts: () => codexNativeRuntime.loadProxyAccounts(),
  loadClientToken: async () => (await loadNativeCodexProxyConnection(false)).token,
  health: codexNativeHealth,
}))
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
const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`[baton] Native runtime on http://127.0.0.1:${config.port}`)
  const recovered = conversationRuntime.start()
  if (recovered > 0) console.warn(`[baton] recovered ${recovered} interrupted canonical turns`)
})

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[baton] ${signal}: shutting down`)
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  conversationRuntime.closeStreams()
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
  await conversationRuntime.close()
}

process.once('SIGINT', () => { void shutdown('SIGINT') })
process.once('SIGTERM', () => { void shutdown('SIGTERM') })
