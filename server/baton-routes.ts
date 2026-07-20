/**
 * Baton-owned client integration and status routes.
 *
 * The app installs `express.raw`, so `req.body` arrives as a Buffer (or empty).
 * We parse JSON ourselves, defensively, rather than assuming a JSON body parser.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'

import {
  applyClientIntegration,
  ClientIntegrationError,
  getClientIntegrationStatus,
  removeClientIntegration,
} from './client-integration.ts'
import { getCachedBatonRuntimeStatus } from './baton-status.ts'

export const batonRouter: Router = Router()

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

batonRouter.get('/baton/status', async (_req: Request, res: Response) => {
  res.json(await getCachedBatonRuntimeStatus())
})

batonRouter.post('/baton/client-integration/apply', async (req: Request, res: Response) => {
  try {
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
    const body = parseBody(req.body)
    res.json(await removeClientIntegration(body.targets))
  } catch (error) {
    const status = error instanceof ClientIntegrationError ? error.status : 500
    const message = error instanceof Error ? error.message : String(error)
    res.status(status).json({ error: message })
  }
})
