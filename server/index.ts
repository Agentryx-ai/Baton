/**
 * Baton BFF — thin proxy in front of the gateway management API + host of the policy engine.
 *
 * Responsibilities (DESIGN.md §3.1, ADR-2):
 *  - hold the gateway dashboard session (SPA has no login screen)
 *  - forward /api/* to the gateway, re-authenticating on 401
 *  - mount /baton/* (policy engine control) via batonRouter
 *  - run the smart-rotation policy engine daemon
 *  - serve the built SPA in production (dist/)
 */
import express from 'express'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { config } from './config.ts'
import { fetchGateway, sessionStatus } from './gateway-session.ts'
import { batonRouter } from './baton-routes.ts'
import { createHostRouter } from './host-routes.ts'
import { CODEX_NATIVE_PROXY_PATH } from './client-integration.ts'
import { createCodexNativeProxy } from './codex-native-proxy.ts'
import { codexNativeRuntime } from './codex-native-runtime.ts'
import { CodexNativeOAuthManager } from './codex-native-oauth.ts'
import { createCodexNativeAccountRouter } from './codex-native-account-routes.ts'
import { createClaudeQuotaEnricher } from './claude-quota-enrichment.ts'
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
import { policyEngine } from './policy-engine.ts'
import { createConversationRuntime } from './session/runtime.ts'
import { ModelFallbackRuntime, modelFallbackStatePath } from './model-fallback-runtime.ts'
import { createModelFallbackRouter } from './model-fallback-routes.ts'
import { NativeProxyHealthTracker } from './native-proxy-health.ts'
import { CodexPluginReferenceStore, codexPluginReferenceStatePath } from './codex-plugin-reference-store.ts'
import { CodexPluginReferenceService } from './codex-plugin-reference-service.ts'
import { createCodexPluginRouter } from './codex-plugin-routes.ts'

const app = express()
const conversationRuntime = createConversationRuntime({ dataDir: config.dataDir })
const enrichClaudeQuota = createClaudeQuotaEnricher({ fetchGateway })
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
    gateway: config.gatewayUrl,
    session: sessionStatus(),
    nativeProxy: {
      claude: claudeNativeHealth.snapshot(),
      codex: codexNativeHealth.snapshot(),
    },
  })
})

// Baton-owned Codex data plane. The legacy custom-provider mode still routes
// directly to CLIProxy; only the explicit native-openai mode uses this path.
app.use(CODEX_NATIVE_PROXY_PATH, createCodexNativeProxy({
  loadAccounts: () => codexNativeRuntime.loadProxyAccounts(),
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

// Policy engine control plane (/baton/policy ...).
app.use(batonRouter)
app.use(createHostRouter())

// Proxy every /api/* call to the gateway with the held session cookie.
app.use('/api', async (req, res) => {
  const targetPath = `/api${req.url}`
  try {
    const upstream = await fetchGateway(targetPath, {
      method: req.method,
      headers: {
        ...(req.headers['content-type']
          ? { 'content-type': String(req.headers['content-type']) }
          : {}),
        accept: 'application/json',
      },
      body: Buffer.isBuffer(req.body) ? req.body : undefined,
    })
    const claudeQuotaMatch = req.method === 'GET'
      ? /^\/api\/cliproxy\/quota\/claude\/([^/?]+)(?:\?.*)?$/.exec(targetPath)
      : null
    const responseBody = claudeQuotaMatch && upstream.status >= 200 && upstream.status < 300
      ? await enrichClaudeQuota(decodeURIComponent(claudeQuotaMatch[1]), upstream.body)
      : upstream.body
    res.status(upstream.status)
    const contentType = upstream.headers.get('content-type')
    if (contentType) res.setHeader('content-type', contentType)
    res.send(responseBody)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[baton] proxy error ${req.method} ${targetPath}: ${message}`)
    res.status(502).json({ error: 'baton-proxy', message })
  }
})

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
  console.log(`[baton] BFF on http://127.0.0.1:${config.port} → gateway ${config.gatewayUrl}`)
  const recovered = conversationRuntime.start()
  if (recovered > 0) console.warn(`[baton] recovered ${recovered} interrupted canonical turns`)
  policyEngine.startIfEnabled()
})

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[baton] ${signal}: shutting down`)
  policyEngine.stop()
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
