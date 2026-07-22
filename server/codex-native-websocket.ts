import { timingSafeEqual } from 'node:crypto'
import { STATUS_CODES } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'

import { WebSocket, WebSocketServer } from 'ws'
import type { RawData } from 'ws'

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

export const CODEX_RESPONSES_WEBSOCKET_VERSION = 'responses_websockets=2026-02-06'

const MAX_PAYLOAD_BYTES = 128 * 1024 * 1024
const MAX_UPSTREAM_QUEUED_MESSAGES = 4_096
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000
const DEFAULT_RETRY_DEADLINE_MS = 30_000
const TERMINAL_EVENT_TYPES = new Set([
  'error',
  'response.completed',
  'response.done',
  'response.failed',
  'response.incomplete',
])
const REQUEST_HEADER_BLOCKLIST = new Set([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
  'proxy-authorization',
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
  'transfer-encoding',
  'upgrade',
  'x-api-key',
])

interface MessagePacket {
  kind: 'message'
  data: Buffer
  binary: boolean
}

interface ClosePacket {
  kind: 'close'
  code: number
  reason: Buffer
}

interface ErrorPacket {
  kind: 'error'
  error: Error
}

type InboxPacket = MessagePacket | ClosePacket | ErrorPacket

interface UpstreamConnection {
  account: CodexNativeProxyAccount
  socket: WebSocket
  inbox: WebSocketInbox
}

interface UpstreamAttemptValue {
  connection?: UpstreamConnection
  first?: MessagePacket
  status?: number
  responseHeaders?: Record<string, string>
  error?: Error
}

interface ParsedEvent {
  type?: string
  status?: number
  headers?: Record<string, string>
  token?: string
}

export interface CodexNativeWebSocketProxy {
  attach(server: Server): void
  close(): Promise<void>
}

class WebSocketInbox {
  readonly #queue: InboxPacket[] = []
  readonly #socket: WebSocket
  readonly #maxQueuedMessages: number
  readonly #maxQueuedBytes: number
  #queuedBytes = 0
  #waiter: ((packet: InboxPacket) => void) | undefined

  constructor(socket: WebSocket, limits: {
    maxQueuedMessages?: number
    maxQueuedBytes?: number
  } = {}) {
    this.#socket = socket
    this.#maxQueuedMessages = limits.maxQueuedMessages ?? MAX_UPSTREAM_QUEUED_MESSAGES
    this.#maxQueuedBytes = limits.maxQueuedBytes ?? MAX_PAYLOAD_BYTES
    socket.on('message', (data, binary) => this.#push({
      kind: 'message',
      data: rawDataToBuffer(data),
      binary,
    }))
    socket.once('close', (code, reason) => this.#push({ kind: 'close', code, reason }))
    socket.once('error', (error) => this.#push({ kind: 'error', error }))
  }

  next(signal: AbortSignal, timeoutMs: number): Promise<InboxPacket> {
    const queued = this.#queue.shift()
    if (queued) {
      if (queued.kind === 'message') this.#queuedBytes -= queued.data.length
      return Promise.resolve(queued)
    }
    if (signal.aborted) return Promise.reject(signal.reason)
    return new Promise<InboxPacket>((resolve, reject) => {
      const timeout = setTimeout(() => finish(() => reject(new Error('websocket idle timeout'))), timeoutMs)
      timeout.unref()
      const abort = () => finish(() => reject(signal.reason))
      const finish = (complete: () => void) => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        this.#waiter = undefined
        complete()
      }
      this.#waiter = (packet) => finish(() => resolve(packet))
      signal.addEventListener('abort', abort, { once: true })
    })
  }

  #push(packet: InboxPacket): void {
    const waiter = this.#waiter
    if (waiter) {
      waiter(packet)
      return
    }
    if (packet.kind === 'message' && (
      this.#queue.length >= this.#maxQueuedMessages
      || this.#queuedBytes + packet.data.length > this.#maxQueuedBytes
    )) {
      this.#queue.length = 0
      this.#queuedBytes = 0
      this.#queue.push({ kind: 'error', error: new Error('websocket receive queue limit exceeded') })
      closeSocket(this.#socket, 1009, 'websocket receive queue limit exceeded')
      return
    }
    if (packet.kind === 'message') this.#queuedBytes += packet.data.length
    this.#queue.push(packet)
  }
}

class UpstreamHandshakeError extends Error {
  readonly status: number
  readonly responseHeaders: Record<string, string>

  constructor(
    status: number,
    responseHeaders: Record<string, string>,
  ) {
    super(`upstream websocket handshake returned ${status}`)
    this.name = 'UpstreamHandshakeError'
    this.status = status
    this.responseHeaders = responseHeaders
  }
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return Buffer.from(data)
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

function rejectUpgrade(
  socket: Duplex,
  status: number,
  type: string,
  message: string,
  headers: Record<string, string> = {},
): void {
  if (socket.destroyed) return
  const body = Buffer.from(JSON.stringify({ error: { type, message } }))
  const lines = [
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}`,
    'Connection: close',
    'Content-Type: application/json',
    `Content-Length: ${body.length}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ]
  socket.end(Buffer.concat([Buffer.from(lines.join('\r\n')), body]))
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
    if (REQUEST_HEADER_BLOCKLIST.has(name.toLowerCase()) || raw === undefined) continue
    headers[name] = Array.isArray(raw) ? raw.join(', ') : raw
  }
  headers.authorization = `Bearer ${credential.accessToken}`
  if (credential.chatgptAccountId) headers['chatgpt-account-id'] = credential.chatgptAccountId
  headers.originator = 'baton'
  return headers
}

function recordHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) result[name] = Array.isArray(value) ? value.join(', ') : value
  }
  return result
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

function parseEvent(packet: MessagePacket): ParsedEvent | null {
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
    }
  } catch {
    return null
  }
}

function parseRequest(packet: MessagePacket): { model: string } | null {
  if (packet.binary) return null
  try {
    const payload = JSON.parse(packet.data.toString('utf8')) as Record<string, unknown>
    if (payload.type !== 'response.create' || typeof payload.model !== 'string' || !payload.model) return null
    return { model: payload.model }
  } catch {
    return null
  }
}

function sendText(socket: WebSocket, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(data, { binary: false }, (error) => error ? reject(error) : resolve())
  })
}

function closeSocket(socket: WebSocket, code = 1000, reason = ''): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    try { socket.close(code, reason) } catch { socket.terminate() }
  }
}

function terminateConnection(connection: UpstreamConnection | undefined): void {
  if (connection && connection.socket.readyState !== WebSocket.CLOSED) connection.socket.terminate()
}

function openUpstream(
  url: string,
  headers: Record<string, string>,
  account: CodexNativeProxyAccount,
  signal: AbortSignal,
  handshakeTimeout: number,
): Promise<UpstreamConnection> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers,
      handshakeTimeout,
      maxPayload: MAX_PAYLOAD_BYTES,
      perMessageDeflate: true,
    })
    let settled = false
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      socket.off('error', onError)
      socket.off('unexpected-response', onUnexpectedResponse)
      complete()
    }
    const onAbort = () => finish(() => {
      socket.once('error', () => undefined)
      socket.terminate()
      reject(signal.reason)
    })
    const onError = (error: Error) => finish(() => reject(error))
    const onUnexpectedResponse = (_request: unknown, response: IncomingMessage) => {
      const status = response.statusCode ?? 502
      const responseHeaders = recordHeaders(response.headers)
      response.resume()
      finish(() => {
        socket.once('error', () => undefined)
        socket.terminate()
        reject(new UpstreamHandshakeError(status, responseHeaders))
      })
    }
    socket.once('open', () => finish(() => resolve({
      account,
      socket,
      inbox: new WebSocketInbox(socket),
    })))
    socket.once('error', onError)
    socket.once('unexpected-response', onUnexpectedResponse)
    signal.addEventListener('abort', onAbort, { once: true })
  })
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

export function createCodexNativeWebSocketProxy(
  options: CodexNativeProxyOptions,
): CodexNativeWebSocketProxy {
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: true,
  })
  const baseUrl = options.upstreamBaseUrl ?? CODEX_NATIVE_UPSTREAM_BASE_URL
  const targetUrl = upstreamUrl(baseUrl)
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const retryDeadlineMs = options.retryDeadlineMs ?? DEFAULT_RETRY_DEADLINE_MS
  const cooldowns = options.cooldowns ?? new NativeAccountCooldowns()
  const now = options.now ?? Date.now
  let attached = false
  let closing = false

  const serve = async (client: WebSocket, request: IncomingMessage): Promise<void> => {
    const clientInbox = new WebSocketInbox(client, { maxQueuedMessages: 1 })
    const abort = new AbortController()
    let active: UpstreamConnection | undefined
    let clientClosed = false
    let requestHealth: NativeProxyRequestHealth | undefined
    client.once('close', () => {
      clientClosed = true
      abort.abort(new Error('client disconnected'))
      terminateConnection(active)
    })

    try {
      while (!abort.signal.aborted && client.readyState === WebSocket.OPEN) {
        const packet = await clientInbox.next(abort.signal, requestTimeoutMs)
        if (packet.kind === 'close') break
        if (packet.kind === 'error') throw packet.error
        const parsed = parseRequest(packet)
        if (!parsed) {
          closeSocket(client, packet.binary ? 1003 : 1007, 'expected a response.create JSON text frame')
          return
        }

        requestHealth = options.health?.begin()
        let accounts: CodexNativeProxyAccount[]
        try {
          accounts = await options.loadAccounts()
        } catch {
          requestHealth?.transportError(now())
          requestHealth = undefined
          await sendText(client, Buffer.from(JSON.stringify({
            type: 'error',
            status: 503,
            error: { type: 'baton_codex_accounts_unavailable', message: 'Codex accounts are unavailable.' },
          })))
          closeSocket(client, 1011, 'Codex accounts unavailable')
          return
        }
        const byId = new Map(accounts.map((account) => [account.id, account]))

        let routed
        try {
          routed = await routeNativeRequest<UpstreamAttemptValue>({
            accounts,
            model: parsed.model,
            supportsModel: (account, model) => byId.get(account.id)?.models.includes(model) ?? false,
            attempt: async (account, signal): Promise<NativeRouteAttempt<UpstreamAttemptValue>> => {
              const selected = byId.get(account.id)
              if (!selected) throw new Error('selected Codex account disappeared')
              let connection: UpstreamConnection | undefined
              try {
                connection = active?.account.id === selected.id && active.socket.readyState === WebSocket.OPEN
                  ? active
                  : await openUpstream(
                    targetUrl,
                    upstreamHeaders(request, selected.credential),
                    selected,
                    signal,
                    retryDeadlineMs,
                  )
                await sendText(connection.socket, packet.data)
                const first = await connection.inbox.next(signal, requestTimeoutMs)
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
                const event = parseEvent(first)
                const failure = event?.type === 'error' && event.status !== undefined
                  ? classifyStatus(event.status, event.headers ?? {}, now())
                  : undefined
                return { value: { connection, first }, ...(failure ? { failure } : {}) }
              } catch (error) {
                if (error instanceof UpstreamHandshakeError) {
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
          await sendText(client, Buffer.from(JSON.stringify({
            type: 'error',
            status: modelUnsupported ? 422 : 503,
            error: {
              type: modelUnsupported ? 'baton_codex_model_unsupported' : 'baton_codex_upstream_unavailable',
              message: error instanceof Error ? error.message : 'Codex upstream is unavailable.',
            },
          })))
          closeSocket(client, 1011, 'Codex upstream unavailable')
          return
        }

        const value = routed.value
        if (!value.connection || !value.first) {
          requestHealth?.transportError(now())
          requestHealth = undefined
          await sendText(client, Buffer.from(JSON.stringify({
            type: 'error',
            status: value.status ?? 502,
            error: {
              type: 'baton_codex_upstream_unavailable',
              message: value.error?.message ?? 'Codex upstream websocket is unavailable.',
            },
          })))
          terminateConnection(value.connection)
          closeSocket(client, 1011, 'Codex upstream unavailable')
          return
        }

        if (active && active !== value.connection) terminateConnection(active)
        active = value.connection
        requestHealth?.headers(true)

        let responsePacket: InboxPacket = value.first
        while (true) {
          if (responsePacket.kind === 'close') throw new Error(`upstream closed during response (${responsePacket.code})`)
          if (responsePacket.kind === 'error') throw responsePacket.error
          if (responsePacket.binary) throw new Error('upstream sent an unsupported binary frame')
          const event = parseEvent(responsePacket)
          requestHealth?.firstByte(now())
          if (event?.token) requestHealth?.firstToken(now())
          await sendText(client, responsePacket.data)
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
          responsePacket = await active.inbox.next(abort.signal, requestTimeoutMs)
        }
      }
    } catch {
      if (clientClosed || abort.signal.aborted) requestHealth?.cancelled(now())
      else {
        requestHealth?.streamError(now())
        closeSocket(client, 1011, 'Codex websocket proxy failure')
      }
    } finally {
      terminateConnection(active)
    }
  }

  return {
    attach(server) {
      if (attached) throw new Error('Codex websocket proxy is already attached')
      attached = true
      server.on('upgrade', (request, socket, head) => {
        let pathname: string
        try {
          pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
        } catch {
          rejectUpgrade(socket, 400, 'invalid_request_error', 'Invalid websocket request URL.')
          return
        }
        if (pathname !== '/baton/inference/openai/v1/responses') {
          rejectUpgrade(socket, 404, 'baton_proxy_route_not_found', 'Unknown websocket route.')
          return
        }
        if (closing) {
          rejectUpgrade(socket, 503, 'baton_restarting', 'Baton is restarting.')
          return
        }
        if (!supportsProtocol(request)) {
          rejectUpgrade(
            socket,
            426,
            'baton_websocket_version_required',
            `Expected OpenAI-Beta: ${CODEX_RESPONSES_WEBSOCKET_VERSION}`,
            { 'OpenAI-Beta': CODEX_RESPONSES_WEBSOCKET_VERSION },
          )
          return
        }
        void authenticateUpgrade(request, options).then((authenticated) => {
          if (closing) {
            rejectUpgrade(socket, 503, 'baton_restarting', 'Baton is restarting.')
            return
          }
          if (!authenticated) {
            rejectUpgrade(socket, 401, 'authentication_error', 'Invalid Baton Codex token.')
            return
          }
          websocketServer.handleUpgrade(request, socket, head, (client) => {
            websocketServer.emit('connection', client, request)
          })
        }).catch(() => {
          rejectUpgrade(socket, 503, 'baton_codex_accounts_unavailable', 'Codex accounts are unavailable.')
        })
      })
      websocketServer.on('connection', (client, request) => {
        void serve(client, request)
      })
    },
    async close() {
      closing = true
      const clients = Array.from(websocketServer.clients)
      const gracefulClose = Promise.all(clients.map((client) => new Promise<void>((resolve) => {
        if (client.readyState === WebSocket.CLOSED) {
          resolve()
          return
        }
        client.once('close', () => resolve())
        closeSocket(client, 1001, 'Baton restarting')
      })))
      if (clients.length > 0) await Promise.race([
        gracefulClose,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 500)
          timer.unref()
        }),
      ])
      for (const client of clients) {
        if (client.readyState !== WebSocket.CLOSED) client.terminate()
      }
      await new Promise<void>((resolve) => websocketServer.close(() => resolve()))
    },
  }
}
