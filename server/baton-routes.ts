/**
 * Baton-owned client integration and status routes.
 *
 * The app installs `express.raw`, so `req.body` arrives as a Buffer (or empty).
 * We parse JSON ourselves, defensively, rather than assuming a JSON body parser.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { randomBytes, timingSafeEqual } from 'node:crypto'

import {
  applyClientIntegration,
  ClientIntegrationError,
  getClientIntegrationStatus,
  removeClientIntegration,
} from './client-integration.ts'
import { getCachedBatonRuntimeStatus } from './baton-status.ts'

export const batonRouter: Router = Router()
const clientIntegrationCapability = randomBytes(32).toString('base64url')

/** Best-effort JSON parse of a raw (Buffer/string/object) express body. */
function parseBody(body: unknown): Record<string, unknown> {
  if (body == null) return {}
  if (Buffer.isBuffer(body)) {
    const text = body.toString('utf8').trim()
    if (!text) return {}
    try {
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  if (typeof body === 'string') {
    const text = body.trim()
    if (!text) return {}
    try {
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  if (typeof body === 'object') return body as Record<string, unknown>
  return {}
}

batonRouter.get('/baton/client-integration', async (_req: Request, res: Response) => {
  res.json(await getClientIntegrationStatus())
})

batonRouter.get('/baton/client-integration/capability', (req: Request, res: Response) => {
  if (!isSafeLoopbackRequest(req, false)) {
    res.status(403).json({ error: 'Loopback same-origin 요청만 허용됩니다.' })
    return
  }
  res.setHeader('Cache-Control', 'no-store')
  res.json({ capability: clientIntegrationCapability })
})

batonRouter.get('/baton/status', async (_req: Request, res: Response) => {
  res.json(await getCachedBatonRuntimeStatus())
})

batonRouter.post('/baton/client-integration/apply', async (req: Request, res: Response) => {
  try {
    requireMutationCapability(req)
    const body = parseBody(req.body)
    res.json(await applyClientIntegration(body.targets, body.codexMode, body.claudeProxyMode))
  } catch (error) {
    const status = error instanceof ClientIntegrationError ? error.status : 500
    const message = error instanceof Error ? error.message : String(error)
    res.status(status).json({ error: message })
  }
})

batonRouter.post('/baton/client-integration/remove', async (req: Request, res: Response) => {
  try {
    requireMutationCapability(req)
    const body = parseBody(req.body)
    res.json(await removeClientIntegration(body.targets))
  } catch (error) {
    const status = error instanceof ClientIntegrationError ? error.status : 500
    const message = error instanceof Error ? error.message : String(error)
    res.status(status).json({ error: message })
  }
})

function requireMutationCapability(req: Request): void {
  if (!isSafeLoopbackRequest(req, true)) {
    throw new ClientIntegrationError(403, 'Loopback same-origin capability가 없어 설정을 변경하지 않았습니다.')
  }
}

function isSafeLoopbackRequest(req: Request, requireCapability: boolean): boolean {
  const host = req.get('host')?.toLowerCase() ?? ''
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return false
  const origin = req.get('origin')
  if (origin) {
    try {
      const parsed = new URL(origin)
      if (parsed.protocol !== 'http:' || parsed.host.toLowerCase() !== host) return false
    } catch {
      return false
    }
  }
  const fetchSite = req.get('sec-fetch-site')
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false
  if (!requireCapability) return true
  const supplied = req.get('x-baton-client-capability') ?? ''
  const expected = Buffer.from(clientIntegrationCapability)
  const actual = Buffer.from(supplied)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
