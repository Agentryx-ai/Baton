import { Router } from 'express'
import type { Request, Response } from 'express'

import { CodexNativeOAuthError, CodexNativeOAuthManager } from './codex-native-oauth.ts'
import { CodexNativeCredentialError } from './codex-native-credentials.ts'
import { CodexModelCatalogError } from './codex-native-models.ts'
import { CodexNativeRuntime } from './codex-native-runtime.ts'
import { NativeAccountVaultError } from './native-account-vault.ts'
import {
  pluginReferenceErrorStatus,
  type CodexPluginReferenceService,
} from './codex-plugin-reference-service.ts'

export interface CodexNativeAccountRoutesOptions {
  runtime: CodexNativeRuntime
  oauth: CodexNativeOAuthManager
  pluginReference?: CodexPluginReferenceService
}

function parseBody(body: unknown): Record<string, unknown> {
  if (!Buffer.isBuffer(body) || body.length === 0) return {}
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function sendError(res: Response, error: unknown): void {
  const pluginStatus = pluginReferenceErrorStatus(error)
  if (pluginStatus !== null) {
    res.status(pluginStatus).json({
      error: error instanceof Error ? error.message : 'Codex plugin 기준계정 작업에 실패했습니다.',
      code: error instanceof Error && 'code' in error ? String(error.code) : 'plugin_reference_error',
    })
    return
  }
  if (error instanceof NativeAccountVaultError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : error.code === 'invalid' ? 400 : 503
    res.status(status).json({ error: error.message, code: error.code })
    return
  }
  if (error instanceof CodexNativeOAuthError) {
    const status = error.code === 'invalid' ? 400 : error.code === 'replayed' ? 409 : error.code === 'expired' ? 410 : 503
    res.status(status).json({ error: error.message, code: error.code })
    return
  }
  if (error instanceof CodexNativeCredentialError || error instanceof CodexModelCatalogError) {
    res.status(502).json({ error: error.message, code: error.code })
    return
  }
  res.status(500).json({ error: 'Codex Native account 작업에 실패했습니다.' })
}

export function createCodexNativeAccountRouter(options: CodexNativeAccountRoutesOptions): Router {
  const router = Router()

  router.get('/accounts', async (_req, res) => {
    try {
      const accounts = await options.runtime.vault.list('codex')
      const pluginReferenceAccountId = options.pluginReference
        ? (await options.pluginReference.status()).state.accountId
        : null
      const defaultId = accounts.find((account) => account.enabled)?.id
      res.json({
        provider: 'codex',
        accounts: accounts.map((account) => ({
          id: account.id,
          provider: 'codex',
          isDefault: account.id === defaultId,
          email: account.alias,
          nickname: account.alias,
          paused: !account.enabled,
          createdAt: account.createdAt,
          priority: account.priority,
          revision: account.revision,
          isPluginReference: account.id === pluginReferenceAccountId,
          models: options.runtime.catalog.get(account.id)?.models ?? [],
          plan: options.runtime.catalog.get(account.id)?.plan ?? null,
        })),
      })
    } catch (error) {
      sendError(res, error)
    }
  })

  router.get('/quota/:id', async (req: Request<{ id: string }>, res) => {
    try {
      res.json(await options.runtime.getQuota(req.params.id))
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post('/auth/start-url', (req, res) => {
    try {
      const body = parseBody(req.body)
      const alias = typeof body.alias === 'string'
        ? body.alias
        : typeof body.nickname === 'string'
          ? body.nickname
          : undefined
      const started = options.oauth.start(alias)
      res.json({ started: true, url: started.authUrl, state: started.state })
    } catch (error) {
      sendError(res, error)
    }
  })

  router.get('/auth/status', (req, res) => {
    try {
      res.json(options.oauth.status(String(req.query.state ?? '')))
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post('/auth/submit-callback', async (req, res) => {
    try {
      const body = parseBody(req.body)
      const url = typeof body.url === 'string'
        ? body.url
        : typeof body.redirectUrl === 'string'
          ? body.redirectUrl
          : undefined
      if (!url) throw new CodexNativeOAuthError('invalid', 'Codex OAuth callback URL이 없습니다.')
      res.json(await options.oauth.submit(url))
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post('/auth/cancel', (req, res) => {
    const body = parseBody(req.body)
    options.oauth.cancel(typeof body.state === 'string' ? body.state : undefined)
    res.json({ cancelled: true })
  })

  router.patch('/accounts/:id', async (req: Request<{ id: string }>, res) => {
    try {
      const body = parseBody(req.body)
      const expectedRevision = requireExpectedRevision(body)
      const updated = await options.runtime.vault.update(req.params.id, {
        expectedRevision,
        ...(typeof body.alias === 'string' ? { alias: body.alias } : {}),
        ...(typeof body.priority === 'number' ? { priority: body.priority } : {}),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      })
      res.json({ account: updated })
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post('/accounts/:id/pause', async (req: Request<{ id: string }>, res) => {
    try {
      const body = parseBody(req.body)
      await options.runtime.vault.update(req.params.id, {
        expectedRevision: requireExpectedRevision(body),
        enabled: false,
      })
      res.json({ paused: true })
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post('/accounts/:id/resume', async (req: Request<{ id: string }>, res) => {
    try {
      const body = parseBody(req.body)
      await options.runtime.vault.update(req.params.id, {
        expectedRevision: requireExpectedRevision(body),
        enabled: true,
      })
      res.json({ paused: false })
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post('/accounts/:id/refresh-entitlements', async (req: Request<{ id: string }>, res) => {
    try {
      res.json(await options.runtime.forceEntitlementRefresh(req.params.id))
    } catch (error) {
      sendError(res, error)
    }
  })

  router.delete('/accounts/:id', async (req: Request<{ id: string }>, res) => {
    try {
      const body = parseBody(req.body)
      await options.pluginReference?.assertAccountRemovable(req.params.id)
      await options.runtime.vault.remove(req.params.id, requireExpectedRevision(body))
      options.runtime.forget(req.params.id)
      res.json({ deleted: true })
    } catch (error) {
      sendError(res, error)
    }
  })

  return router
}

function requireExpectedRevision(body: Record<string, unknown>): number {
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) {
    throw new NativeAccountVaultError('invalid', 'expectedRevision이 올바르지 않습니다.')
  }
  return Number(body.expectedRevision)
}
