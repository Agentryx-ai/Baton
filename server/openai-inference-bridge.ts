import { Readable } from 'node:stream'

import { Router } from 'express'
import type { Request } from 'express'

import { loadProxyConnection } from './client-integration.ts'

const REQUEST_HEADER_BLOCKLIST = new Set([
  'authorization',
  'chatgpt-account-id',
  'connection',
  'content-length',
  'cookie',
  'host',
  'proxy-authorization',
  'transfer-encoding',
])

const RESPONSE_HEADER_BLOCKLIST = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'set-cookie',
  'transfer-encoding',
])

export function buildOpenAiUpstreamHeaders(
  headers: Request['headers'],
  proxyToken: string,
): Headers {
  const result = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (REQUEST_HEADER_BLOCKLIST.has(name.toLowerCase()) || value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item)
    } else {
      result.set(name, value)
    }
  }
  result.set('authorization', `Bearer ${proxyToken}`)
  return result
}

export function createOpenAiInferenceBridge(
  loadConnection: typeof loadProxyConnection = loadProxyConnection,
): Router {
  const router = Router()

  router.use(async (req, res) => {
    const abort = new AbortController()
    const cancel = () => abort.abort()
    req.once('aborted', cancel)
    res.once('close', () => {
      if (!res.writableEnded) cancel()
    })

    try {
      const proxy = await loadConnection(false)
      const suffix = req.url.startsWith('/') ? req.url : `/${req.url}`
      const upstream = await fetch(`${proxy.baseUrl}/v1${suffix}`, {
        method: req.method,
        headers: buildOpenAiUpstreamHeaders(req.headers, proxy.token),
        body: Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined,
        signal: abort.signal,
      })

      res.status(upstream.status)
      upstream.headers.forEach((value, name) => {
        if (!RESPONSE_HEADER_BLOCKLIST.has(name.toLowerCase())) res.setHeader(name, value)
      })
      if (!upstream.body) {
        res.end()
        return
      }
      Readable.fromWeb(upstream.body).pipe(res)
    } catch (error) {
      if (abort.signal.aborted || res.headersSent) {
        res.destroy()
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[baton] OpenAI inference bridge failed: ${message}`)
      res.status(502).json({ error: 'baton-inference-bridge' })
    }
  })

  return router
}
