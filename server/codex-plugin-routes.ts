import path from 'node:path'

import { Router } from 'express'
import type { Request, Response } from 'express'

import { CodexPluginControlPlaneError } from './codex-plugin-control-plane.ts'
import {
  CodexPluginReferenceService,
  CodexPluginReferenceServiceError,
  pluginReferenceErrorStatus,
} from './codex-plugin-reference-service.ts'

const INTERACTION_HEADER = 'x-baton-interaction'
const PLUGIN_INTERACTION = 'codex-plugin-control'

function body(req: Request): Record<string, unknown> {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return {}
  try {
    const parsed = JSON.parse(req.body.toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid body')
    return parsed as Record<string, unknown>
  } catch {
    throw new CodexPluginReferenceServiceError('invalid', '요청 JSON 형식이 올바르지 않습니다.')
  }
}

function reference(value: Record<string, unknown>):
  | { mode: 'local_only'; accountId: null }
  | { mode: 'account'; accountId: string } {
  if (value.mode === 'local_only' && (value.accountId === null || value.accountId === undefined)) {
    return { mode: 'local_only', accountId: null }
  }
  if (value.mode === 'account' && typeof value.accountId === 'string' && value.accountId.length > 0) {
    return { mode: 'account', accountId: value.accountId }
  }
  throw new CodexPluginReferenceServiceError('invalid', '플러그인 기준계정 선택이 올바르지 않습니다.')
}

function cwds(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 8) {
    throw new CodexPluginReferenceServiceError('invalid', 'Plugin cwd 목록은 최대 8개여야 합니다.')
  }
  return value.map((entry) => {
    if (typeof entry !== 'string' || !path.isAbsolute(entry) || entry.length > 1_024) {
      throw new CodexPluginReferenceServiceError('invalid', 'Plugin cwd는 절대경로여야 합니다.')
    }
    return path.resolve(entry)
  })
}

function requireInteraction(req: Request): void {
  if (req.get(INTERACTION_HEADER) !== PLUGIN_INTERACTION) {
    throw new CodexPluginReferenceServiceError('invalid', '명시적인 Codex plugin 관리 interaction이 필요합니다.')
  }
}

function sendError(res: Response, error: unknown): void {
  const referenceStatus = pluginReferenceErrorStatus(error)
  if (referenceStatus !== null) {
    res.status(referenceStatus).json({
      code: error instanceof Error && 'code' in error ? String(error.code) : 'plugin_reference_error',
      error: error instanceof Error ? error.message : 'Codex plugin 기준계정 작업에 실패했습니다.',
    })
    return
  }
  if (error instanceof CodexPluginControlPlaneError) {
    const status = error.code === 'invalid' ? 400 : error.code === 'authentication' ? 401 : 502
    res.status(status).json({ code: error.code, error: error.message })
    return
  }
  res.status(500).json({ code: 'plugin_control_failed', error: 'Codex plugin 관리 작업에 실패했습니다.' })
}

export function createCodexPluginRouter(service: CodexPluginReferenceService): Router {
  const router = Router()

  router.get('/reference', async (_req, res) => {
    try {
      res.json(await service.status())
    } catch (error) {
      sendError(res, error)
    }
  })

  router.get('/catalog', async (req, res) => {
    try {
      const roots = typeof req.query.cwd === 'string' ? cwds([req.query.cwd]) : []
      res.json(await service.listCurrent(roots))
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post('/reference/preview', async (req, res) => {
    try {
      requireInteraction(req)
      const input = body(req)
      res.json(await service.preview(reference(input), cwds(input.cwds)))
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post('/reference/switch', async (req, res) => {
    try {
      requireInteraction(req)
      const input = body(req)
      const target = reference(input)
      if (!Number.isSafeInteger(input.expectedStateRevision) || Number(input.expectedStateRevision) < 0) {
        throw new CodexPluginReferenceServiceError('invalid', 'expectedStateRevision이 올바르지 않습니다.')
      }
      if (!(input.expectedTargetAccountRevision === null || (
        Number.isSafeInteger(input.expectedTargetAccountRevision) && Number(input.expectedTargetAccountRevision) >= 1
      ))) {
        throw new CodexPluginReferenceServiceError('invalid', 'expectedTargetAccountRevision이 올바르지 않습니다.')
      }
      if (typeof input.previewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.previewDigest)) {
        throw new CodexPluginReferenceServiceError('invalid', 'previewDigest가 올바르지 않습니다.')
      }
      res.json(await service.switch({
        ...target,
        expectedStateRevision: Number(input.expectedStateRevision),
        expectedTargetAccountRevision: input.expectedTargetAccountRevision as number | null,
        previewDigest: input.previewDigest,
      }, cwds(input.cwds)))
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post('/install', async (req, res) => {
    try {
      requireInteraction(req)
      const input = body(req)
      res.json(await service.install({
        ...(typeof input.marketplacePath === 'string' ? { marketplacePath: input.marketplacePath } : {}),
        ...(typeof input.remoteMarketplaceName === 'string'
          ? { remoteMarketplaceName: input.remoteMarketplaceName }
          : {}),
        pluginName: typeof input.pluginName === 'string' ? input.pluginName : '',
      }))
    } catch (error) {
      sendError(res, error)
    }
  })

  router.post('/uninstall', async (req, res) => {
    try {
      requireInteraction(req)
      const input = body(req)
      await service.uninstall(typeof input.pluginId === 'string' ? input.pluginId : '')
      res.json({ uninstalled: true })
    } catch (error) {
      sendError(res, error)
    }
  })

  return router
}
