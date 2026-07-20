import { timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { Router } from 'express'
import type { Request } from 'express'

import type { CodexNativeCredential } from './codex-native-credentials.ts'
import {
  NativeAccountCooldowns,
  NativeRouteUnavailableError,
  routeNativeRequest,
} from './native-account-router.ts'
import type {
  NativeRouteAttempt,
  NativeRouteFailure,
} from './native-account-router.ts'
import type { NativeProxyHealthTracker } from './native-proxy-health.ts'

export const CODEX_NATIVE_UPSTREAM_BASE_URL = 'https://chatgpt.com/backend-api/codex'

const ALLOWED_ENDPOINTS = new Map<string, ReadonlySet<string>>([
  ['/responses', new Set(['POST'])],
  ['/responses/compact', new Set(['POST'])],
  ['/models', new Set(['GET'])],
])

const REQUEST_HEADER_BLOCKLIST = new Set([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
  'proxy-authorization',
  'transfer-encoding',
  'x-api-key',
])

const RESPONSE_HEADER_BLOCKLIST = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export interface CodexNativeProxyAccount {
  id: string
  priority: number
  enabled: boolean
  models: readonly string[]
  credential: CodexNativeCredential
}

export interface CodexNativeProxyOptions {
  loadAccounts(): Promise<CodexNativeProxyAccount[]>
  loadClientToken?: () => Promise<string>
  fetchImpl?: typeof fetch
  upstreamBaseUrl?: string
  requestTimeoutMs?: number
  retryDeadlineMs?: number
  cooldowns?: NativeAccountCooldowns
  now?: () => number
  health?: NativeProxyHealthTracker
}

function secureEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function presentedToken(req: Request): string | null {
  const authorization = req.get('authorization')
  if (authorization?.toLowerCase().startsWith('bearer ')) return authorization.slice(7).trim()
  const apiKey = req.get('x-api-key')
  return apiKey?.trim() || null
}

function upstreamHeaders(req: Request, credential: CodexNativeCredential): Headers {
  const headers = new Headers()
  for (const [name, raw] of Object.entries(req.headers)) {
    if (REQUEST_HEADER_BLOCKLIST.has(name.toLowerCase()) || raw === undefined) continue
    headers.set(name, Array.isArray(raw) ? raw.join(', ') : raw)
  }
  headers.set('authorization', `Bearer ${credential.accessToken}`)
  if (credential.chatgptAccountId) headers.set('chatgpt-account-id', credential.chatgptAccountId)
  headers.set('originator', 'baton')
  return headers
}

function requestedModel(req: Request): string | null {
  if (!Buffer.isBuffer(req.body)) return null
  try {
    const parsed = JSON.parse(req.body.toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const model = (parsed as Record<string, unknown>).model
    return typeof model === 'string' && model.length > 0 ? model : null
  } catch {
    return null
  }
}

function resetAt(response: Response, now: number): number {
  const retryAfter = Number(response.headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return now + retryAfter * 1_000
  const reset = response.headers.get('x-ratelimit-reset-requests')
  if (reset) {
    const numeric = Number(reset)
    if (Number.isFinite(numeric) && numeric > now) return numeric > 10_000_000_000 ? numeric : numeric * 1_000
    const timestamp = Date.parse(reset)
    if (Number.isFinite(timestamp) && timestamp > now) return timestamp
  }
  return now + 60_000
}

function classifyResponse(response: Response, now: number): NativeRouteFailure | undefined {
  if (response.status === 401 || response.status === 403) {
    return { kind: 'authentication', retryable: true }
  }
  if (response.status === 429) {
    return { kind: 'account_quota', retryable: true, cooldownUntil: resetAt(response, now) }
  }
  if (response.status >= 500 && response.status <= 599) {
    return { kind: 'upstream_5xx', retryable: true }
  }
  if (!response.ok) return { kind: 'fatal', retryable: false }
  return undefined
}

function modelList(accounts: readonly CodexNativeProxyAccount[]): string[] {
  return Array.from(new Set(
    accounts.filter((account) => account.enabled).flatMap((account) => account.models),
  )).sort((left, right) => left.localeCompare(right, 'en'))
}

export function createCodexNativeProxy(options: CodexNativeProxyOptions): Router {
  const router = Router()
  const fetchImpl = options.fetchImpl ?? fetch
  const upstreamBaseUrl = (options.upstreamBaseUrl ?? CODEX_NATIVE_UPSTREAM_BASE_URL).replace(/\/$/, '')
  const requestTimeoutMs = options.requestTimeoutMs ?? 10 * 60_000
  const retryDeadlineMs = options.retryDeadlineMs ?? 30_000
  const cooldowns = options.cooldowns ?? new NativeAccountCooldowns()
  const now = options.now ?? Date.now

  router.use(async (req, res) => {
    const methods = ALLOWED_ENDPOINTS.get(req.path)
    if (!methods) {
      res.status(404).json({ error: { type: 'baton_proxy_route_not_found', path: req.path } })
      return
    }
    if (!methods.has(req.method)) {
      res.setHeader('allow', Array.from(methods).join(', '))
      res.status(405).json({ error: { type: 'baton_proxy_method_not_allowed' } })
      return
    }

    let accounts: CodexNativeProxyAccount[]
    try {
      accounts = await options.loadAccounts()
    } catch {
      res.status(503).json({ error: { type: 'baton_codex_accounts_unavailable' } })
      return
    }
    const presented = presentedToken(req)
    let localToken: string | undefined
    try {
      localToken = await options.loadClientToken?.()
    } catch {
      // OAuth-bearing Codex clients remain independently authenticatable.
    }
    const authenticated = Boolean(presented && (
      (localToken && secureEquals(presented, localToken))
      || accounts.some((account) => secureEquals(presented, account.credential.accessToken))
    ))
    if (!authenticated) {
      res.status(401).json({ error: { type: 'authentication_error', message: '유효하지 않은 Baton Codex token입니다.' } })
      return
    }

    if (req.path === '/models') {
      res.json({
        object: 'list',
        data: modelList(accounts).map((id) => ({ id, object: 'model', owned_by: 'openai' })),
      })
      return
    }

    const model = requestedModel(req)
    if (!model) {
      res.status(400).json({ error: { type: 'invalid_request_error', message: '요청 model이 없습니다.' } })
      return
    }
    const byId = new Map(accounts.map((account) => [account.id, account]))
    const abort = new AbortController()
    const requestHealth = options.health?.begin()
    const timeout = setTimeout(() => abort.abort(new Error('request timeout')), requestTimeoutMs)
    timeout.unref()
    const cancel = () => abort.abort(new Error('client disconnected'))
    const cancelOnClose = () => {
      if (!res.writableEnded) cancel()
    }
    req.once('aborted', cancel)
    res.once('close', cancelOnClose)

    try {
      const routed = await routeNativeRequest<Response>({
        accounts,
        model,
        supportsModel: (account, requested) => byId.get(account.id)?.models.includes(requested) ?? false,
        attempt: async (account, _signal): Promise<NativeRouteAttempt<Response>> => {
          const selected = byId.get(account.id)
          if (!selected) throw new Error('selected Codex account disappeared')
          const upstream = await fetchImpl(`${upstreamBaseUrl}${req.path}`, {
            method: req.method,
            headers: upstreamHeaders(req, selected.credential),
            body: Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined,
            signal: abort.signal,
          })
          const failure = classifyResponse(upstream, now())
          return { value: upstream, ...(failure ? { failure } : {}) }
        },
        cooldowns,
        now,
        deadlineMs: retryDeadlineMs,
        signal: abort.signal,
      })
      const upstream = routed.value
      const streaming = (upstream.headers.get('content-type') ?? '').includes('text/event-stream')
      requestHealth?.headers(streaming)
      res.status(upstream.status)
      upstream.headers.forEach((value, name) => {
        if (!RESPONSE_HEADER_BLOCKLIST.has(name.toLowerCase())) res.setHeader(name, value)
      })
      if (!upstream.body) {
        requestHealth?.complete(now())
        res.end()
        return
      }
      const source = Readable.fromWeb(upstream.body)
      const observer = requestHealth?.streamObserver(now)
      if (observer) await pipeline(source, observer, res)
      else await pipeline(source, res)
      requestHealth?.complete(now())
    } catch (error) {
      if (abort.signal.aborted) {
        requestHealth?.cancelled(now())
        res.destroy()
        return
      }
      if (res.headersSent) {
        requestHealth?.streamError(now())
        res.destroy()
        return
      }
      if (error instanceof NativeRouteUnavailableError && error.code === 'model_unsupported') {
        requestHealth?.discard()
      } else {
        requestHealth?.transportError(now())
      }
      if (error instanceof NativeRouteUnavailableError) {
        const status = error.code === 'model_unsupported' ? 422 : 503
        res.status(status).json({
          error: {
            type: `baton_codex_${error.code}`,
            message: error.message,
            model,
          },
        })
        return
      }
      console.error('[baton] Native Codex upstream failed')
      res.status(502).json({ error: { type: 'baton_codex_upstream_unavailable' } })
    } finally {
      clearTimeout(timeout)
      req.off('aborted', cancel)
      res.off('close', cancelOnClose)
    }
  })

  return router
}
