import { Router, type Request, type Response } from 'express'

import {
  ClaudeNativeAccountVault,
  ClaudeNativeAccountVaultError,
} from './claude-native-account-vault.ts'
import {
  ClaudeNativeOAuthError,
  ClaudeNativeOAuthManager,
} from './claude-native-oauth.ts'
import type { ClaudeAccountQuota } from './claude-native-quota.ts'
import { ClaudeNativeCredentialError } from './claude-native-credentials.ts'

export interface ClaudeNativeAccountRoutesOptions {
  vault: ClaudeNativeAccountVault
  oauth: ClaudeNativeOAuthManager
  ensureAccounts?: () => Promise<void>
  getQuota?: (accountId: string) => Promise<ClaudeAccountQuota>
}

export function createClaudeNativeAccountRouter(options: ClaudeNativeAccountRoutesOptions): Router {
  const router = Router()

  router.get('/accounts', async (_req, res) => {
    try {
      await options.ensureAccounts?.()
      const accounts = await options.vault.list()
      const defaultId = accounts.find((account) => account.enabled)?.id
      res.json({
        provider: 'claude',
        accounts: accounts.map((account) => ({
          id: account.id,
          provider: 'claude',
          isDefault: account.id === defaultId,
          email: account.email ?? account.accountId ?? account.id,
          nickname: account.nickname,
          paused: !account.enabled,
          priority: account.priority,
          createdAt: account.createdAt,
        })),
      })
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post('/accounts/:id/pause', async (req, res) => {
    try {
      await options.ensureAccounts?.()
      await options.vault.setEnabled(req.params.id, false)
      res.json({ paused: true })
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post('/accounts/:id/resume', async (req, res) => {
    try {
      await options.ensureAccounts?.()
      await options.vault.setEnabled(req.params.id, true)
      res.json({ paused: false })
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post('/accounts/:id/prefer', async (req, res) => {
    try {
      await options.ensureAccounts?.()
      const account = await options.vault.prefer(req.params.id)
      res.json({ preferred: true, accountId: account.id })
    } catch (error) {
      sendError(res, error)
    }
  })

  router.delete('/accounts/:id', async (req, res) => {
    try {
      await options.ensureAccounts?.()
      await options.vault.remove(req.params.id)
      res.json({ deleted: true })
    } catch (error) {
      sendError(res, error)
    }
  })

  router.get('/quota/:id', async (req, res) => {
    try {
      await options.ensureAccounts?.()
      if (!options.getQuota) {
        throw new ClaudeNativeAccountVaultError('unavailable', 'Claude quota 조회가 준비되지 않았습니다.')
      }
      res.json(await options.getQuota(req.params.id))
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post('/auth/start-url', (req, res) => {
    try {
      const body = parseBody(req)
      const nickname = typeof body.nickname === 'string' ? body.nickname : undefined
      const started = options.oauth.start(nickname)
      res.json({ ...started, url: started.authUrl })
    } catch (error) {
      sendError(res, error)
    }
  })

  router.get('/auth/status', (req, res) => {
    try {
      const state = typeof req.query.state === 'string' ? req.query.state : ''
      if (!state) throw new ClaudeNativeOAuthError('invalid', 'Claude OAuth state가 없습니다.')
      res.json(options.oauth.status(state))
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post('/auth/submit-callback', async (req, res) => {
    try {
      const body = parseBody(req)
      if (typeof body.redirectUrl !== 'string' || !body.redirectUrl) {
        throw new ClaudeNativeOAuthError('invalid', 'Claude OAuth callback URL이 없습니다.')
      }
      res.json(await options.oauth.submit(body.redirectUrl))
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post('/auth/cancel', (req, res) => {
    try {
      const body = parseBody(req)
      options.oauth.cancel(typeof body.state === 'string' ? body.state : undefined)
      res.json({ cancelled: true })
    } catch (error) {
      sendError(res, error)
    }
  })

  return router
}

function parseBody(req: Request): Record<string, unknown> {
  const value = Buffer.isBuffer(req.body)
    ? JSON.parse(req.body.toString('utf8') || '{}') as unknown
    : req.body
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClaudeNativeOAuthError('invalid', '요청 본문이 JSON 객체가 아닙니다.')
  }
  return value as Record<string, unknown>
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof ClaudeNativeCredentialError) {
    res.status(401).json({ error: error.message, code: 'reauth_required' })
    return
  }
  if (error instanceof ClaudeNativeAccountVaultError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'invalid' ? 400 : 503
    res.status(status).json({ error: error.message, code: error.code })
    return
  }
  if (error instanceof ClaudeNativeOAuthError) {
    const status = error.code === 'unavailable' ? 503 : error.code === 'replayed' ? 409 : 400
    res.status(status).json({ error: error.message, code: error.code })
    return
  }
  res.status(500).json({ error: 'Native Claude 계정 작업에 실패했습니다.' })
}
