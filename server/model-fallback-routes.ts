import { Router } from 'express'

import type { ModelFallbackRuntime } from './model-fallback-runtime.ts'

function validMappings(value: unknown): value is Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return entries.length <= 100 && entries.every(
    ([source, models]) => source.length > 0
      && source.length <= 200
      && Array.isArray(models)
      && models.length <= 10
      && models.every((model) => (
        typeof model === 'string' && model.length > 0 && model.length <= 200 && model !== source
      )),
  )
}

export function createModelFallbackRouter(runtime: ModelFallbackRuntime): Router {
  const router = Router()
  router.get('/', (_req, res) => { res.json(runtime.status()) })
  router.post('/', (req, res) => {
    let body: unknown
    try {
      body = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString('utf8')) : req.body
    } catch {
      res.status(400).json({ error: 'invalid_json' })
      return
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    const value = body as Record<string, unknown>
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled_must_be_boolean' })
      return
    }
    if (value.promptDismissed !== undefined && typeof value.promptDismissed !== 'boolean') {
      res.status(400).json({ error: 'prompt_dismissed_must_be_boolean' })
      return
    }
    if (value.userMappings !== undefined && !validMappings(value.userMappings)) {
      res.status(400).json({ error: 'invalid_user_mappings' })
      return
    }
    res.json(runtime.update({
      ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
      ...(typeof value.promptDismissed === 'boolean' ? { promptDismissed: value.promptDismissed } : {}),
      ...(validMappings(value.userMappings) ? { userMappings: value.userMappings } : {}),
    }))
  })
  return router
}
