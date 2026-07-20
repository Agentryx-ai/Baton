import { timingSafeEqual } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'

import { Router } from 'express'
import type { Request, Response as ExpressResponse } from 'express'

import type { ClaudeNativeCredential } from './claude-native-credentials.ts'
import { ClaudeNativeCredentialError } from './claude-native-credentials.ts'
import type { ClaudeModelQuotaLimit } from './claude-native-quota.ts'
import { NativeAccountCooldowns, NativeRouteUnavailableError, routeNativeRequest } from './native-account-router.ts'
import type { NativeRouteAttempt, NativeRouteFailure } from './native-account-router.ts'
import type { ModelFallbackRuntime } from './model-fallback-runtime.ts'
import type { NativeProxyHealthTracker } from './native-proxy-health.ts'

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
  'set-cookie',
  'transfer-encoding',
])

const ALLOWED_ENDPOINTS = new Map<string, ReadonlySet<string>>([
  ['/v1/messages', new Set(['POST'])],
  ['/v1/messages/count_tokens', new Set(['POST'])],
  ['/v1/models', new Set(['GET'])],
])
const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20'
const CLAUDE_SERVER_FALLBACK_BETA = 'server-side-fallback-2026-06-01'
const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude."

export const CLAUDE_NATIVE_PROXY_PATH = '/baton/inference/claude'

export interface ClaudeNativeCredentialCandidate {
  id: string
  nickname?: string
  credential: ClaudeNativeCredential
}

export interface ClaudeNativeProxyOptions {
  loadCredential?: () => Promise<ClaudeNativeCredential>
  loadCredentialCandidates?: () => Promise<ClaudeNativeCredentialCandidate[]>
  loadClientToken: () => Promise<string>
  upstreamBaseUrl?: string
  fetchImpl?: typeof fetch
  requestTimeoutMs?: number
  retryDeadlineMs?: number
  cooldowns?: NativeAccountCooldowns
  now?: () => number
  modelFallback?: ModelFallbackRuntime
  health?: NativeProxyHealthTracker
  checkModelQuota?: (
    model: string,
    credential: ClaudeNativeCredential,
  ) => Promise<ClaudeModelQuotaLimit | null>
}

function secureEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function presentedClientToken(req: Request): string | null {
  const authorization = req.header('authorization')
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length)
  return req.header('x-api-key') ?? null
}

export function buildClaudeUpstreamHeaders(
  headers: Request['headers'],
  credential: ClaudeNativeCredential,
  additionalBetaFeatures: readonly string[] = [],
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
  result.set('authorization', `Bearer ${credential.accessToken}`)
  const betaFeatures = new Set(
    (result.get('anthropic-beta') ?? '')
      .split(',')
      .map((feature) => feature.trim())
      .filter(Boolean),
  )
  betaFeatures.add(CLAUDE_OAUTH_BETA)
  for (const feature of additionalBetaFeatures) betaFeatures.add(feature)
  result.set('anthropic-beta', Array.from(betaFeatures).join(','))
  return result
}

function persistFallbackState(runtime: ModelFallbackRuntime): void {
  try {
    runtime.persist()
  } catch {
    // Diagnostics persistence is secondary to the provider's authoritative response.
    console.error('[baton] Native Claude fallback state persistence failed')
  }
}

function claudeCodeCompatibleRequest(
  request: Record<string, unknown>,
  model: string | null,
  safetyCapability: { fallbackModels: readonly string[] } | null,
): Record<string, unknown> {
  const system = request.system
  const blocks = typeof system === 'string'
    ? [{ type: 'text', text: system }]
    : Array.isArray(system) ? system : []
  const identified = blocks.some((block) => (
    block && typeof block === 'object' && !Array.isArray(block)
    && typeof (block as Record<string, unknown>).text === 'string'
    && String((block as Record<string, unknown>).text).includes(CLAUDE_CODE_SYSTEM_PROMPT)
  ))
  return {
    ...request,
    ...(model ? { model } : {}),
    system: identified
      ? blocks
      : [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT }, ...blocks],
    ...(safetyCapability
      ? { fallbacks: safetyCapability.fallbackModels.map((fallbackModel) => ({ model: fallbackModel })) }
      : {}),
  }
}

function fallbackEventObserver(runtime: ModelFallbackRuntime): Transform {
  let pending = ''
  const decoder = new StringDecoder('utf8')
  const inspect = (block: string) => {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data || data === '[DONE]') return
    try {
      if (runtime.controller.observeServerEvent(JSON.parse(data))) persistFallbackState(runtime)
    } catch { /* malformed provider events remain byte-for-byte passthrough */ }
  }
  return new Transform({
    transform(chunk, _encoding, callback) {
      const text = pending + decoder.write(Buffer.from(chunk))
      const blocks = text.split(/\r?\n\r?\n/)
      pending = blocks.pop() ?? ''
      for (const block of blocks) inspect(block)
      callback(null, chunk)
    },
    flush(callback) {
      pending += decoder.end()
      if (pending) inspect(pending)
      callback()
    },
  })
}

function credentialFailure(error: ClaudeNativeCredentialError): { status: number; body: object } {
  return {
    status: error.code === 'expired' ? 401 : 503,
    body: {
      type: 'error',
      error: {
        type: `baton_claude_auth_${error.code}`,
        message: error.message,
      },
    },
  }
}

function claudeRateLimitClaim(displayName: string): string | null {
  const normalized = displayName.trim().toLowerCase()
  if (normalized.startsWith('fable')) return 'seven_day_overage_included'
  if (normalized.startsWith('opus')) return 'seven_day_opus'
  if (normalized.startsWith('sonnet')) return 'seven_day_sonnet'
  return null
}

async function loadCandidates(options: ClaudeNativeProxyOptions): Promise<ClaudeNativeCredentialCandidate[]> {
  const candidates = options.loadCredentialCandidates
    ? await options.loadCredentialCandidates()
    : options.loadCredential
      ? [{ id: 'default', credential: await options.loadCredential() }]
      : []
  if (candidates.length === 0) {
    throw new ClaudeNativeCredentialError('expired', '사용 가능한 Claude OAuth 계정이 없습니다.')
  }
  return candidates
}

function setUpstreamHeaders(res: ExpressResponse, status: number, headers: Headers): void {
  res.status(status)
  headers.forEach((value, name) => {
    if (!RESPONSE_HEADER_BLOCKLIST.has(name.toLowerCase())) res.setHeader(name, value)
  })
}

function modelQuotaResponse(exhausted: ClaudeModelQuotaLimit, now: number): Response {
  const headers = new Headers({ 'content-type': 'application/json' })
  const representativeClaim = claudeRateLimitClaim(exhausted.displayName)
  if (representativeClaim) {
    headers.set('anthropic-ratelimit-unified-representative-claim', representativeClaim)
  }
  if (exhausted.resetsAt) {
    const retryAfter = Math.max(1, Math.ceil((Date.parse(exhausted.resetsAt) - now) / 1_000))
    if (Number.isFinite(retryAfter)) headers.set('retry-after', String(retryAfter))
    const resetEpochSeconds = Math.floor(Date.parse(exhausted.resetsAt) / 1_000)
    if (Number.isFinite(resetEpochSeconds)) {
      headers.set('anthropic-ratelimit-unified-reset', String(resetEpochSeconds))
    }
  }
  return Response.json({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: `You've reached your ${exhausted.displayName} limit.`,
      details: {
        limit_type: 'model',
        model: exhausted.model,
        display_name: exhausted.displayName,
        percent: exhausted.percent,
        resets_at: exhausted.resetsAt ?? null,
        source: 'baton_usage_preflight',
      },
    },
  }, { status: 429, headers })
}

export function responseResetAt(response: Response, now: number): number {
  const resetValue = response.headers.get('anthropic-ratelimit-unified-reset')
  const reset = Number(resetValue)
  if (Number.isFinite(reset) && reset > 0) {
    const milliseconds = reset > 10_000_000_000 ? reset : reset * 1_000
    if (milliseconds > now) return milliseconds
  }
  const resetDate = resetValue ? Date.parse(resetValue) : Number.NaN
  if (Number.isFinite(resetDate) && resetDate > now) return resetDate
  const retryAfterValue = response.headers.get('retry-after')
  const retryAfter = Number(retryAfterValue)
  if (Number.isFinite(retryAfter) && retryAfter > 0) return now + retryAfter * 1_000
  const retryAfterDate = retryAfterValue ? Date.parse(retryAfterValue) : Number.NaN
  if (Number.isFinite(retryAfterDate) && retryAfterDate > now) return retryAfterDate
  return now + 60_000
}

async function classifyUpstreamResponse(
  response: Response,
  now: number,
): Promise<NativeRouteFailure | undefined> {
  if (response.status === 401 || response.status === 403) {
    return { kind: 'authentication', retryable: true }
  }
  if (response.status === 429) {
    let modelScoped = false
    try {
      const body = await response.clone().json() as {
        error?: { details?: { limit_type?: unknown, model?: unknown } }
      }
      modelScoped = body.error?.details?.limit_type === 'model'
        || typeof body.error?.details?.model === 'string'
    } catch {
      // Unknown 429s remain account-scoped; never infer from localized text.
    }
    return {
      kind: modelScoped ? 'model_quota' : 'account_quota',
      retryable: true,
      cooldownUntil: responseResetAt(response, now),
    }
  }
  if (response.status >= 500 && response.status <= 599) {
    return { kind: 'upstream_5xx', retryable: true }
  }
  if (!response.ok) return { kind: 'fatal', retryable: false }
  return undefined
}

export function createClaudeNativeProxy(options: ClaudeNativeProxyOptions): Router {
  const router = Router()
  const upstreamBaseUrl = (options.upstreamBaseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')
  const fetchImpl = options.fetchImpl ?? fetch
  const requestTimeoutMs = options.requestTimeoutMs ?? 10 * 60_000
  const retryDeadlineMs = options.retryDeadlineMs ?? 30_000
  const cooldowns = options.cooldowns ?? new NativeAccountCooldowns()
  const now = options.now ?? Date.now

  router.use(async (req, res) => {
    const pathname = req.path
    const methods = ALLOWED_ENDPOINTS.get(pathname)
    if (!methods) {
      res.status(404).json({
        type: 'error',
        error: { type: 'baton_proxy_route_not_found', message: `지원하지 않는 Claude endpoint: ${pathname}` },
      })
      return
    }
    if (!methods.has(req.method)) {
      res.setHeader('allow', Array.from(methods).join(', '))
      res.status(405).json({
        type: 'error',
        error: { type: 'baton_proxy_method_not_allowed', message: `${req.method} ${pathname}` },
      })
      return
    }

    let candidates: ClaudeNativeCredentialCandidate[]
    try {
      candidates = await loadCandidates(options)
    } catch (error) {
      if (error instanceof ClaudeNativeCredentialError) {
        const failure = credentialFailure(error)
        res.status(failure.status).json(failure.body)
        return
      }
      console.error('[baton] Native Claude credential load failed')
      res.status(503).json({
        type: 'error',
        error: { type: 'baton_claude_auth_unavailable', message: 'Claude 자격증명을 불러오지 못했습니다.' },
      })
      return
    }

    let expectedClientToken: string
    try {
      expectedClientToken = await options.loadClientToken()
    } catch {
      res.status(503).json({
        type: 'error',
        error: { type: 'baton_proxy_not_ready', message: 'Baton Native Claude Proxy token을 준비하지 못했습니다.' },
      })
      return
    }
    const presented = presentedClientToken(req)
    const authenticated = Boolean(presented && (
      secureEquals(presented, expectedClientToken)
      || candidates.some((candidate) => secureEquals(presented, candidate.credential.accessToken))
    ))
    if (!authenticated) {
      res.status(401).json({
        type: 'error',
        error: { type: 'authentication_error', message: '유효하지 않은 Baton Native Proxy token입니다.' },
      })
      return
    }

    let model: string | null = null
    let parsedRequest: Record<string, unknown> | null = null
    if (pathname === '/v1/messages') {
      try {
        const body = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString('utf8')) as unknown : null
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          parsedRequest = body as Record<string, unknown>
          const value = parsedRequest.model
          if (typeof value === 'string' && value.length > 0) model = value
        }
      } catch {
        // Let Anthropic return its canonical malformed-request response.
      }
    }

    const abort = new AbortController()
    const requestHealth = options.health?.begin()
    const timeout = setTimeout(() => abort.abort(new Error('upstream timeout')), requestTimeoutMs)
    timeout.unref()
    const cancel = () => abort.abort(new Error('client disconnected'))
    const cancelOnClose = () => {
      if (!res.writableEnded) cancel()
    }
    req.once('aborted', cancel)
    res.once('close', cancelOnClose)

    let lastPreflight = new Map<string, ClaudeModelQuotaLimit>()
    try {
      const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))
      const runRoute = async (targetModel: string | null) => {
        const preflight = new Map<string, ClaudeModelQuotaLimit>()
        lastPreflight = preflight
        if (targetModel && options.checkModelQuota) {
          await Promise.all(candidates.map(async (candidate) => {
            // Usage preflight is fresher than a prior cooldown and permits early reset.
            cooldowns.clear(candidate.id, targetModel)
            try {
              const exhausted = await options.checkModelQuota!(targetModel, candidate.credential)
              if (exhausted) preflight.set(candidate.id, exhausted)
            } catch {
              // Usage telemetry is advisory. The messages API remains authoritative.
            }
          }))
        }
        const safetyCapability = targetModel
          && options.modelFallback?.status().enabled
          && parsedRequest?.fallbacks === undefined
          ? options.modelFallback.controller.capability(targetModel, 'safety_refusal')
          : null
        const requestBody = parsedRequest
          ? Buffer.from(JSON.stringify(claudeCodeCompatibleRequest(parsedRequest, targetModel, safetyCapability)))
          : Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined
        return await routeNativeRequest<Response>({
          accounts: candidates.map((candidate, index) => ({
            id: candidate.id,
            priority: index,
            enabled: true,
          })),
          model: targetModel ?? '*',
          supportsModel: () => true,
          attempt: async (account, signal): Promise<NativeRouteAttempt<Response>> => {
          const candidate = byId.get(account.id)
          if (!candidate) throw new Error('selected Claude account disappeared')
          const exhausted = preflight.get(account.id)
          if (exhausted) {
            const response = modelQuotaResponse(exhausted, now())
            return {
              value: response,
              failure: {
                kind: 'model_quota',
                retryable: true,
                cooldownUntil: responseResetAt(response, now()),
              },
            }
          }
          let upstream: Response
          const attemptAbort = new AbortController()
          const abortAttempt = () => attemptAbort.abort(signal.reason)
          if (signal.aborted) abortAttempt()
          else signal.addEventListener('abort', abortAttempt, { once: true })
          try {
            upstream = await fetchImpl(
              `${upstreamBaseUrl}${req.originalUrl.slice(req.baseUrl.length)}`,
              {
                method: req.method,
                headers: buildClaudeUpstreamHeaders(
                  req.headers,
                  candidate.credential,
                  safetyCapability ? [CLAUDE_SERVER_FALLBACK_BETA] : [],
                ),
                body: requestBody,
                // Retry deadline governs connection/headers. The outer request signal
                // remains attached for the full response stream lifetime.
                signal: AbortSignal.any([abort.signal, attemptAbort.signal]),
              },
            )
          } catch (error) {
            if (signal.aborted) throw error
            upstream = Response.json({
              type: 'error',
              error: {
                type: 'baton_upstream_unavailable',
                message: 'Anthropic upstream에 연결하지 못했습니다.',
              },
            }, { status: 502 })
            return { value: upstream, failure: { kind: 'transient', retryable: true } }
          } finally {
            signal.removeEventListener('abort', abortAttempt)
          }
            const failure = pathname === '/v1/messages'
              ? await classifyUpstreamResponse(upstream, now())
              : undefined
            return { value: upstream, ...(failure ? { failure } : {}) }
          },
          cooldowns,
          now,
          deadlineMs: retryDeadlineMs,
          signal: abort.signal,
          disposeValue: async (response) => {
            if (response.body && !response.bodyUsed) await response.body.cancel()
          },
        })
      }

      const selection = model && options.modelFallback
        ? options.modelFallback.controller.requestModel(model)
        : { model: model ?? '*', probing: false }
      const selectedModel = model ? selection.model : null
      let routed = await runRoute(selectedModel)
      let upstream = routed.value
      const allModelQuota = routed.exhausted
        && routed.attempts.length === candidates.length
        && routed.attempts.every((attempt) => attempt.failure?.kind === 'model_quota')

      if (model && options.modelFallback) {
        if (selectedModel === model && !routed.exhausted && selection.probing) {
          options.modelFallback.controller.recovered(model)
          persistFallbackState(options.modelFallback)
        } else if (selectedModel === model && allModelQuota) {
          const capability = options.modelFallback.controller.noteExhausted(
            model,
            responseResetAt(upstream, now()),
          )
          persistFallbackState(options.modelFallback)
          if (capability && options.modelFallback.status().enabled) {
            const fallbackModel = capability.fallbackModels[0]
            const fallback = await runRoute(fallbackModel)
            if (!fallback.exhausted) {
              if (upstream.body && !upstream.bodyUsed) await upstream.body.cancel()
              routed = fallback
              upstream = fallback.value
              options.modelFallback.controller.recordAccount(
                model,
                byId.get(fallback.accountId)?.nickname ?? fallback.accountId,
              )
              persistFallbackState(options.modelFallback)
            } else {
              options.modelFallback.controller.failed(model, fallbackModel)
              persistFallbackState(options.modelFallback)
              if (fallback.value.body && !fallback.value.bodyUsed) await fallback.value.body.cancel()
            }
          }
        } else if (selectedModel !== model && routed.exhausted) {
          options.modelFallback.controller.failed(model, selectedModel ?? model)
          persistFallbackState(options.modelFallback)
        } else if (selectedModel !== model) {
          options.modelFallback.controller.recordAccount(
            model,
            byId.get(routed.accountId)?.nickname ?? routed.accountId,
          )
          persistFallbackState(options.modelFallback)
        }
      }

      if (pathname === '/v1/models' && upstream.ok && options.modelFallback) {
        try { options.modelFallback.controller.observeModels(await upstream.clone().json()) } catch { /* pass through */ }
      }
      if (pathname === '/v1/messages' && model && options.modelFallback) {
        const contentType = upstream.headers.get('content-type') ?? ''
        if (!contentType.includes('text/event-stream')) {
          try {
            const payload = await upstream.clone().json()
            if (
              options.modelFallback.controller.observeServerEvent(payload)
              || options.modelFallback.controller.observeRefusal(payload, model)
            ) persistFallbackState(options.modelFallback)
          } catch { /* pass through provider JSON unchanged */ }
        }
      }
      const streaming = (upstream.headers.get('content-type') ?? '').includes('text/event-stream')
      requestHealth?.headers(streaming)
      setUpstreamHeaders(res, upstream.status, upstream.headers)
      if (!upstream.body) {
        requestHealth?.complete(now())
        res.end()
        return
      }
      const source = Readable.fromWeb(upstream.body)
      const observer = requestHealth?.streamObserver(now)
      if (options.modelFallback && streaming) {
        if (observer) await pipeline(source, observer, fallbackEventObserver(options.modelFallback), res)
        else await pipeline(source, fallbackEventObserver(options.modelFallback), res)
      } else {
        if (observer) await pipeline(source, observer, res)
        else await pipeline(source, res)
      }
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
      requestHealth?.transportError(now())
      if (
        error instanceof NativeRouteUnavailableError
        && candidates.length > 0
        && lastPreflight.size === candidates.length
      ) {
        const exhausted = lastPreflight.get(candidates[0].id)
        if (exhausted) {
          const response = modelQuotaResponse(exhausted, now())
          setUpstreamHeaders(res, response.status, response.headers)
          res.end(Buffer.from(await response.arrayBuffer()))
          return
        }
      }
      if (error instanceof NativeRouteUnavailableError) {
        res.status(503).json({
          type: 'error',
          error: { type: `baton_claude_${error.code}`, message: error.message },
        })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[baton] Native Claude upstream failed: ${message}`)
      res.status(502).json({
        type: 'error',
        error: { type: 'baton_upstream_unavailable', message: 'Anthropic upstream에 연결하지 못했습니다.' },
      })
    } finally {
      clearTimeout(timeout)
      req.off('aborted', cancel)
      res.off('close', cancelOnClose)
    }
  })

  return router
}
