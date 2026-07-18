/**
 * HTTP routes for the policy engine, mounted by server/index.ts.
 *
 *   GET  /baton/policy       -> PolicyState
 *   POST /baton/policy       -> { enabled?: boolean, policy?: string } -> PolicyState
 *   GET  /baton/policy/log   -> { log: SteerLogEntry[] }
 *
 * The app installs `express.raw`, so `req.body` arrives as a Buffer (or empty).
 * We parse JSON ourselves, defensively, rather than assuming a JSON body parser.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'

import { policyEngine } from './policy-engine.ts'
import { POLICY_ID } from './policy-types.ts'
import {
  applyClientIntegration,
  ClientIntegrationError,
  getClientIntegrationStatus,
  removeClientIntegration,
} from './client-integration.ts'

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

batonRouter.get('/baton/policy', (_req: Request, res: Response) => {
  res.json(policyEngine.getState())
})

batonRouter.post('/baton/policy', async (req: Request, res: Response) => {
  const body = parseBody(req.body)

  // Validate before mutating so a bad request changes nothing.
  const hasPolicy = 'policy' in body && body.policy !== undefined
  if (hasPolicy && body.policy !== POLICY_ID) {
    res.status(400).json({ error: `unknown policy '${String(body.policy)}'` })
    return
  }
  const hasEnabled = 'enabled' in body && body.enabled !== undefined
  if (hasEnabled && typeof body.enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean' })
    return
  }

  try {
    if (hasPolicy) await policyEngine.setPolicy(POLICY_ID)
    if (hasEnabled) await policyEngine.setEnabled(body.enabled as boolean)
    res.json(policyEngine.getState())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

batonRouter.get('/baton/policy/log', (_req: Request, res: Response) => {
  res.json({ log: policyEngine.getState().log })
})

batonRouter.get('/baton/client-integration', async (_req: Request, res: Response) => {
  res.json(await getClientIntegrationStatus())
})

batonRouter.post('/baton/client-integration/apply', async (req: Request, res: Response) => {
  try {
    const body = parseBody(req.body)
    res.json(await applyClientIntegration(body.targets, body.codexMode))
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
