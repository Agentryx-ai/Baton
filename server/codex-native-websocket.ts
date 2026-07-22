import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

import type { CodexNativeCredential } from './codex-native-credentials.ts'
import {
  CODEX_NATIVE_UPSTREAM_BASE_URL,
} from './codex-native-proxy.ts'
import type {
  CodexNativeProxyAccount,
  CodexNativeProxyOptions,
} from './codex-native-proxy.ts'
import {
  NativeAccountCooldowns,
  NativeRouteUnavailableError,
  routeNativeRequest,
} from './native-account-router.ts'
import type {
  NativeRouteAttempt,
  NativeRouteFailure,
} from './native-account-router.ts'
import type { NativeProxyRequestHealth } from './native-proxy-health.ts'
import type {
  WebSocketUpgradeContext,
  WebSocketUpgradeRoute,
} from './websocket-upgrade-dispatcher.ts'
import {
  connectWebSocket,
  DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES,
  WebSocketHandshakeError,
  WebSocketTransport,
} from './websocket-transport.ts'
import type { WebSocketFrame } from './websocket-transport.ts'

export const CODEX_RESPONSES_WEBSOCKET_VERSION = 'responses_websockets=2026-02-06'
export const CODEX_RESPONSES_WEBSOCKET_PATH = '/baton/inference/openai/v1/responses'

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000
const DEFAULT_RETRY_DEADLINE_MS = 30_000
const MAX_CONTINUATION_AFFINITIES = 256
const TERMINAL_EVENT_TYPES = new Set([
  'error',
  'response.completed',
  'response.done',
  'response.failed',
  'response.incomplete',
])
const SAFE_FORWARDED_HEADERS = new Set([
  'accept-language',
  'user-agent',
])

interface UpstreamConnection {
  account: CodexNativeProxyAccount
  transport: WebSocketTransport
}

interface UpstreamAttemptValue {
  connection?: UpstreamConnection
  first?: WebSocketFrame
  status?: number
  responseHeaders?: Record<string, string>
  error?: Error
}

interface ParsedEvent {
  type?: string
  status?: number
  headers?: Record<string, string>
  token?: string
  responseId?: string
}

function secureEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function presentedToken(req: IncomingMessage): string | null {
  const authorization = req.headers.authorization
  if (authorization?.toLowerCase().startsWith('bearer ')) return authorization.slice(7).trim()
  const apiKey = req.headers['x-api-key']
  return typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : null
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function supportsProtocol(req: IncomingMessage): boolean {
  const beta = req.headers['openai-beta']
  const values = Array.isArray(beta) ? beta : beta ? [beta] : []
  return values.some((value) => value.split(',').map((item) => item.trim()).includes(
    CODEX_RESPONSES_WEBSOCKET_VERSION,
  ))
}

function upstreamUrl(baseUrl: string): string {
  const url = new URL(baseUrl.replace(/\/$/, '') + '/responses')
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  else throw new Error(`unsupported Codex websocket upstream protocol: ${url.protocol}`)
  return url.toString()
}

function upstreamHeaders(
  req: IncomingMessage,
  credential: CodexNativeCredential,
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, raw] of Object.entries(req.headers)) {
    if (!SAFE_FORWARDED_HEADERS.has(name.toLowerCase()) || raw === undefined) continue
    headers[name] = Array.isArray(raw) ? raw.join(', ') : raw
  }
  headers.authorization = `Bearer ${credential.accessToken}`
  if (credential.chatgptAccountId) headers['chatgpt-account-id'] = credential.chatgptAccountId
  headers['openai-beta'] = CODEX_RESPONSES_WEBSOCKET_VERSION
  headers.originator = 'baton'
  return headers
}

function resetAt(headers: Record<string, string>, now: number): number {
  const retryAfter = Number(headers['retry-after'])
  if (Number.isFinite(retryAfter) && retryAfter > 0) return now + retryAfter * 1_000
  const reset = headers['x-ratelimit-reset-requests']
  if (reset) {
    const numeric = Number(reset)
    if (Number.isFinite(numeric) && numeric > now) return numeric > 10_000_000_000 ? numeric : numeric * 1_000
    const timestamp = Date.parse(reset)
    if (Number.isFinite(timestamp) && timestamp > now) return timestamp
  }
  return now + 60_000
}

function classifyStatus(
  status: number,
  headers: Record<string, string>,
  now: number,
): NativeRouteFailure {
  if (status === 401 || status === 403) return { kind: 'authentication', retryable: true }
  if (status === 429) {
    return { kind: 'account_quota', retryable: true, cooldownUntil: resetAt(headers, now) }
  }
  if (status >= 500 && status <= 599) return { kind: 'upstream_5xx', retryable: true }
  return { kind: 'fatal', retryable: false }
}

function parseEvent(packet: WebSocketFrame): ParsedEvent | null {
  if (packet.binary) return null
  try {
    const payload = JSON.parse(packet.data.toString('utf8')) as Record<string, unknown>
    const headers = payload.headers && typeof payload.headers === 'object'
      ? Object.fromEntries(Object.entries(payload.headers as Record<string, unknown>)
        .filter((entry): entry is [string, string | number] => (
          typeof entry[1] === 'string' || typeof entry[1] === 'number'
        ))
        .map(([name, value]) => [name.toLowerCase(), String(value)]))
      : undefined
    const delta = payload.delta
    const response = payload.response && typeof payload.response === 'object'
      ? payload.response as Record<string, unknown>
      : undefined
    const token = typeof delta === 'string'
      ? delta
      : delta && typeof delta === 'object'
        ? ((delta as Record<string, unknown>).text ?? (delta as Record<string, unknown>).thinking)
        : undefined
    return {
      type: typeof payload.type === 'string' ? payload.type : undefined,
      status: typeof payload.status === 'number' ? payload.status : undefined,
      headers,
      token: typeof token === 'string' ? token : undefined,
      responseId: typeof response?.id === 'string' && response.id ? response.id : undefined,
    }
  } catch {
    return null
  }
}

function parseRequest(packet: WebSocketFrame): { model: string; previousResponseId?: string } | null {
  if (packet.binary) return null
  try {
    const payload = JSON.parse(packet.data.toString('utf8')) as Record<string, unknown>
    if (payload.type !== 'response.create' || typeof payload.model !== 'string' || !payload.model) return null
    const previousResponseId = typeof payload.previous_response_id === 'string'
      && payload.previous_response_id
      ? payload.previous_response_id
      : undefined
    return { model: payload.model, ...(previousResponseId ? { previousResponseId } : {}) }
  } catch {
    return null
  }
}

function terminateConnection(connection: UpstreamConnection | undefined): void {
  connection?.transport.terminate()
}

function openUpstream(
  url: string,
  headers: Record<string, string>,
  account: CodexNativeProxyAccount,
  signal: AbortSignal,
  handshakeTimeout: number,
): Promise<UpstreamConnection> {
  return connectWebSocket(url, {
    headers,
    handshakeTimeout,
    maxPayload: DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES,
    perMessageDeflate: true,
    signal,
  }).then((transport) => ({ account, transport }))
}

async function authenticateUpgrade(
  req: IncomingMessage,
  options: CodexNativeProxyOptions,
): Promise<boolean> {
  if (options.trustLoopbackClient === true && isLoopback(req.socket.remoteAddress)) return true
  const accounts = await options.loadAccounts()
  const presented = presentedToken(req)
  if (!presented) return false
  let localToken: string | undefined
  try {
    localToken = await options.loadClientToken?.()
  } catch {
    // OAuth-bearing Codex clients remain independently authenticatable.
  }
  return Boolean(
    (localToken && secureEquals(presented, localToken))
    || accounts.some((account) => secureEquals(presented, account.credential.accessToken)),
  )
}

function touchAffinity(affinities: Map<string, string>, responseId: string, accountId: string): void {
  affinities.delete(responseId)
  affinities.set(responseId, accountId)
  while (affinities.size > MAX_CONTINUATION_AFFINITIES) {
    const oldest = affinities.keys().next().value as string | undefined
    if (!oldest) break
    affinities.delete(oldest)
  }
}

function affinityFor(affinities: Map<string, string>, responseId: string | undefined): string | undefined {
  if (!responseId) return undefined
  const accountId = affinities.get(responseId)
  if (!accountId) return undefined
  touchAffinity(affinities, responseId, accountId)
  return accountId
}

function errorFrame(status: number, type: string, message: string): WebSocketFrame {
  return {
    binary: false,
    data: Buffer.from(JSON.stringify({ type: 'error', status, error: { type, message } })),
  }
}

export function createCodexResponsesWebSocketRoute(
  options: CodexNativeProxyOptions,
): WebSocketUpgradeRoute {
  const baseUrl = options.upstreamBaseUrl ?? CODEX_NATIVE_UPSTREAM_BASE_URL
  const targetUrl = upstreamUrl(baseUrl)
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const retryDeadlineMs = options.retryDeadlineMs ?? DEFAULT_RETRY_DEADLINE_MS
  const cooldowns = options.cooldowns ?? new NativeAccountCooldowns()
  const now = options.now ?? Date.now

  const serve = async (client: WebSocketTransport, request: IncomingMessage): Promise<void> => {
    const abort = new AbortController()
    const affinities = new Map<string, string>()
    let active: UpstreamConnection | undefined
    let clientClosed = false
    let requestHealth: NativeProxyRequestHealth | undefined
    client.onceClose(() => {
      clientClosed = true
      abort.abort(new Error('client disconnected'))
      terminateConnection(active)
    })

    try {
      while (!abort.signal.aborted && client.isOpen) {
        const packet = await client.inbox.next(abort.signal, requestTimeoutMs)
        if (packet.kind === 'close') break
        if (packet.kind === 'error') throw packet.error
        const parsed = parseRequest(packet.frame)
        if (!parsed) {
          client.close(packet.frame.binary ? 1003 : 1007, 'expected a response.create JSON text frame')
          return
        }

        requestHealth = options.health?.begin()
        let accounts: CodexNativeProxyAccount[]
        try {
          accounts = await options.loadAccounts()
        } catch {
          requestHealth?.transportError(now())
          requestHealth = undefined
          await client.send(errorFrame(
            503,
            'baton_codex_accounts_unavailable',
            'Codex accounts are unavailable.',
          ), abort.signal)
          client.close(1011, 'Codex accounts unavailable')
          return
        }
        const byId = new Map(accounts.map((account) => [account.id, account]))
        const affinityAccountId = affinityFor(affinities, parsed.previousResponseId)
        const routingAccounts = affinityAccountId
          ? accounts.filter((account) => account.id === affinityAccountId)
          : accounts

        let routed
        try {
          routed = await routeNativeRequest<UpstreamAttemptValue>({
            accounts: routingAccounts,
            model: parsed.model,
            supportsModel: (account, model) => byId.get(account.id)?.models.includes(model) ?? false,
            attempt: async (account, signal): Promise<NativeRouteAttempt<UpstreamAttemptValue>> => {
              const selected = byId.get(account.id)
              if (!selected) throw new Error('selected Codex account disappeared')
              let connection: UpstreamConnection | undefined
              try {
                connection = active?.account.id === selected.id && active.transport.isOpen
                  ? active
                  : await openUpstream(
                    targetUrl,
                    upstreamHeaders(request, selected.credential),
                    selected,
                    signal,
                    retryDeadlineMs,
                  )
                await connection.transport.send(packet.frame, signal)
                const first = await connection.transport.inbox.next(signal, requestTimeoutMs)
                if (first.kind === 'close') {
                  return {
                    value: { connection, error: new Error(`upstream closed before first frame (${first.code})`) },
                    failure: { kind: 'transient', retryable: true },
                  }
                }
                if (first.kind === 'error') {
                  return {
                    value: { connection, error: first.error },
                    failure: { kind: 'transient', retryable: true },
                  }
                }
                const event = parseEvent(first.frame)
                const failure = event?.type === 'error' && event.status !== undefined
                  ? classifyStatus(event.status, event.headers ?? {}, now())
                  : undefined
                return { value: { connection, first: first.frame }, ...(failure ? { failure } : {}) }
              } catch (error) {
                if (error instanceof WebSocketHandshakeError) {
                  return {
                    value: {
                      status: error.status,
                      responseHeaders: error.responseHeaders,
                      error,
                    },
                    failure: classifyStatus(error.status, error.responseHeaders, now()),
                  }
                }
                return {
                  value: { connection, error: error as Error },
                  failure: { kind: 'transient', retryable: true },
                }
              }
            },
            cooldowns,
            now,
            deadlineMs: retryDeadlineMs,
            signal: abort.signal,
            disposeValue: (value) => terminateConnection(value.connection),
          })
        } catch (error) {
          if (abort.signal.aborted) {
            requestHealth?.cancelled(now())
            requestHealth = undefined
            return
          }
          const modelUnsupported = error instanceof NativeRouteUnavailableError
            && error.code === 'model_unsupported'
          if (modelUnsupported) requestHealth?.discard()
          else requestHealth?.transportError(now())
          requestHealth = undefined
          await client.send(errorFrame(
            modelUnsupported ? 422 : 503,
            modelUnsupported ? 'baton_codex_model_unsupported' : 'baton_codex_upstream_unavailable',
            error instanceof Error ? error.message : 'Codex upstream is unavailable.',
          ), abort.signal)
          client.close(1011, 'Codex upstream unavailable')
          return
        }

        const value = routed.value
        if (!value.connection || !value.first) {
          requestHealth?.transportError(now())
          requestHealth = undefined
          await client.send(errorFrame(
            value.status ?? 502,
            'baton_codex_upstream_unavailable',
            value.error?.message ?? 'Codex upstream websocket is unavailable.',
          ), abort.signal)
          terminateConnection(value.connection)
          client.close(1011, 'Codex upstream unavailable')
          return
        }

        if (active && active !== value.connection) terminateConnection(active)
        active = value.connection
        requestHealth?.headers(true)

        let responseFrame = value.first
        while (true) {
          const event = parseEvent(responseFrame)
          requestHealth?.firstByte(now())
          if (event?.token) requestHealth?.firstToken(now())
          if (event?.responseId) touchAffinity(affinities, event.responseId, active.account.id)
          await client.send(responseFrame, abort.signal)
          if (event?.type && TERMINAL_EVENT_TYPES.has(event.type)) {
            if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') {
              const clientError = event.type === 'error'
                && event.status !== undefined
                && event.status >= 400
                && event.status < 500
                && event.status !== 401
                && event.status !== 403
                && event.status !== 429
              if (clientError) requestHealth?.discard()
              else requestHealth?.streamError(now())
              terminateConnection(active)
              active = undefined
            } else {
              requestHealth?.complete(now())
            }
            requestHealth = undefined
            break
          }
          const next = await active.transport.inbox.next(abort.signal, requestTimeoutMs)
          if (next.kind === 'close') throw new Error(`upstream closed during response (${next.code})`)
          if (next.kind === 'error') throw next.error
          responseFrame = next.frame
        }
      }
    } catch {
      if (clientClosed || abort.signal.aborted) requestHealth?.cancelled(now())
      else {
        requestHealth?.streamError(now())
        client.close(1011, 'Codex websocket proxy failure')
      }
    } finally {
      affinities.clear()
      terminateConnection(active)
    }
  }

  return {
    path: CODEX_RESPONSES_WEBSOCKET_PATH,
    async upgrade(context: WebSocketUpgradeContext) {
      if (!supportsProtocol(context.request)) {
        context.reject(
          426,
          'baton_websocket_version_required',
          `Expected OpenAI-Beta: ${CODEX_RESPONSES_WEBSOCKET_VERSION}`,
          { 'OpenAI-Beta': CODEX_RESPONSES_WEBSOCKET_VERSION },
        )
        return
      }
      let authenticated: boolean
      try {
        authenticated = await authenticateUpgrade(context.request, options)
      } catch {
        context.reject(
          503,
          'baton_codex_accounts_unavailable',
          'Codex accounts are unavailable.',
        )
        return
      }
      if (context.signal.aborted || context.isClosing()) return
      if (!authenticated) {
        context.reject(401, 'authentication_error', 'Invalid Baton Codex token.')
        return
      }
      let client: WebSocketTransport
      try {
        client = await context.accept({ inbox: { maxQueuedMessages: 1 } })
      } catch {
        return
      }
      await serve(client, context.request)
    },
  }
}
