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
import { policyEngine } from './policy-engine.ts'

const app = express()

// Raw passthrough: bodies forwarded byte-for-byte (JSON stays JSON).
app.use(express.raw({ type: () => true, limit: '10mb' }))

app.get('/baton/health', (_req, res) => {
  res.json({ ok: true, gateway: config.gatewayUrl, session: sessionStatus() })
})

// Policy engine control plane (/baton/policy ...).
app.use(batonRouter)

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
    res.status(upstream.status)
    const contentType = upstream.headers.get('content-type')
    if (contentType) res.setHeader('content-type', contentType)
    res.send(upstream.body)
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
app.listen(config.port, '127.0.0.1', () => {
  console.log(`[baton] BFF on http://127.0.0.1:${config.port} → gateway ${config.gatewayUrl}`)
  policyEngine.startIfEnabled()
})
