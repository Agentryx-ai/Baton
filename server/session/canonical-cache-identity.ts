import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

const CACHE_KEY_PURPOSE = 'baton/canonical-conversation-cache/v1\0'
const MAX_RESPONSES_REQUEST_BYTES = 128 * 1024 * 1024

const REQUEST_HEADER_BLOCKLIST = new Set([
  'authorization',
  'chatgpt-account-id',
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

export interface CanonicalResponsesBridge {
  /** Loopback origin only. The Codex provider appends `/v1/responses`. */
  readonly baseUrl: string
  /** Per-bridge bearer credential. It is never forwarded upstream. */
  readonly token: string
  close(): Promise<void>
}

export interface CanonicalResponsesBridgeOptions {
  upstreamBaseUrl: string
  upstreamToken: string
  promptCacheKey: string
  fetchImpl?: typeof fetch
}

/**
 * Produce a provider-safe identity without disclosing Baton thread IDs.
 * The installation secret must be durable and installation-local.
 */
export function canonicalConversationCacheKey(
  installationSecret: Uint8Array,
  canonicalThreadId: string,
): string {
  if (installationSecret.byteLength < 32) {
    throw new TypeError('Canonical cache identity secret must contain at least 32 bytes')
  }
  if (canonicalThreadId.trim().length === 0) {
    throw new TypeError('Canonical cache identity requires a thread ID')
  }
  const digest = createHmac('sha256', Buffer.from(installationSecret))
    .update(CACHE_KEY_PURPOSE)
    .update(canonicalThreadId)
    .digest('base64url')
  return `baton-th-v1-${digest}`
}

/**
 * Codex app-server does not expose its internal prompt-cache-key override.
 * This canonical-only loopback bridge replaces that one Responses field and
 * forwards exclusively to Baton's configured local proxy. It has no direct
 * OpenAI fallback and is intentionally not used by native-client proxy mode.
 */
export async function startCanonicalResponsesBridge(
  options: CanonicalResponsesBridgeOptions,
): Promise<CanonicalResponsesBridge> {
  const upstreamOrigin = validatedUpstreamOrigin(options.upstreamBaseUrl)
  const bridgeToken = randomBytes(32).toString('base64url')
  const fetchImpl = options.fetchImpl ?? fetch
  const server = createServer((request, response) => {
    void handleResponsesRequest(
      request.method ?? '',
      request.url ?? '',
      request.headers,
      request,
      response,
      options,
      upstreamOrigin,
      bridgeToken,
      fetchImpl,
    )
  })
  server.on('clientError', (_error, socket) => socket.destroy())

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw new Error('Canonical Responses bridge did not bind a TCP port')
  }

  let closed = false
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: bridgeToken,
    close: async () => {
      if (closed) return
      closed = true
      server.closeIdleConnections()
      server.closeAllConnections()
      await closeServer(server)
    },
  }
}

async function handleResponsesRequest(
  method: string,
  requestUrl: string,
  headers: IncomingHttpHeaders,
  bodyStream: AsyncIterable<Uint8Array>,
  response: ServerResponse,
  options: CanonicalResponsesBridgeOptions,
  upstreamOrigin: URL,
  bridgeToken: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  try {
    if (!authorized(headers.authorization, bridgeToken)) {
      sendJson(response, 401, { error: 'canonical_cache_bridge_unauthorized' })
      return
    }
    const parsedRequestUrl = new URL(requestUrl, 'http://127.0.0.1')
    if (method !== 'POST' || parsedRequestUrl.pathname !== '/v1/responses') {
      sendJson(response, 404, { error: 'canonical_cache_bridge_route_not_found' })
      return
    }
    const body = await readBody(bodyStream, headers['content-length'])
    const parsed = JSON.parse(body.toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('Responses request body must be a JSON object')
    }
    const rewritten = Buffer.from(JSON.stringify({
      ...(parsed as Record<string, unknown>),
      prompt_cache_key: options.promptCacheKey,
    }))
    const abort = new AbortController()
    response.once('close', () => {
      if (!response.writableEnded) abort.abort()
    })
    const upstreamUrl = new URL('/v1/responses', upstreamOrigin)
    upstreamUrl.search = parsedRequestUrl.search
    const upstream = await fetchImpl(upstreamUrl, {
      method: 'POST',
      headers: upstreamHeaders(headers, options.upstreamToken),
      body: rewritten,
      signal: abort.signal,
    })
    response.statusCode = upstream.status
    upstream.headers.forEach((value, name) => {
      if (!RESPONSE_HEADER_BLOCKLIST.has(name.toLowerCase())) response.setHeader(name, value)
    })
    if (!upstream.body) {
      response.end()
      return
    }
    const readable = Readable.fromWeb(upstream.body)
    readable.once('error', () => response.destroy())
    readable.pipe(response)
  } catch (error) {
    if (response.headersSent) {
      response.destroy()
      return
    }
    const status = error instanceof RequestTooLargeError ? 413 : 502
    sendJson(response, status, {
      error: status === 413
        ? 'canonical_cache_bridge_request_too_large'
        : 'canonical_cache_bridge_upstream_failed',
    })
  }
}

function validatedUpstreamOrigin(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw new TypeError('Canonical Responses bridge requires a 127.0.0.1 HTTP upstream')
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new TypeError('Canonical Responses bridge upstream must be an origin without credentials or a query')
  }
  return url
}

function authorized(value: string | undefined, expectedToken: string): boolean {
  const actual = value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : ''
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expectedToken)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function upstreamHeaders(headers: IncomingHttpHeaders, token: string): Headers {
  const result = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (REQUEST_HEADER_BLOCKLIST.has(name.toLowerCase()) || value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item)
    } else result.set(name, value)
  }
  result.set('authorization', `Bearer ${token}`)
  result.set('content-type', 'application/json')
  return result
}

class RequestTooLargeError extends Error {}

async function readBody(
  body: AsyncIterable<Uint8Array>,
  contentLength: string | undefined,
): Promise<Buffer> {
  const declared = contentLength === undefined ? null : Number(contentLength)
  if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0
    || declared > MAX_RESPONSES_REQUEST_BYTES)) {
    throw new RequestTooLargeError()
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of body) {
    total += chunk.byteLength
    if (total > MAX_RESPONSES_REQUEST_BYTES) throw new RequestTooLargeError()
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, total)
}

function sendJson(response: ServerResponse, status: number, value: Record<string, string>): void {
  const body = JSON.stringify(value)
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.setHeader('content-length', Buffer.byteLength(body))
  response.end(body)
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}
