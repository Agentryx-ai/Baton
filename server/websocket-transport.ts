import type { IncomingHttpHeaders } from 'node:http'

import { WebSocket } from 'ws'
import type { ClientOptions, RawData } from 'ws'

export const DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES = 128 * 1024 * 1024
const DEFAULT_MAX_QUEUED_MESSAGES = 4_096

export interface WebSocketFrame {
  data: Buffer
  binary: boolean
}

export type WebSocketPacket =
  | { kind: 'message'; frame: WebSocketFrame }
  | { kind: 'close'; code: number; reason: Buffer }
  | { kind: 'error'; error: Error }

export interface WebSocketQueueLimits {
  maxQueuedMessages?: number
  maxQueuedBytes?: number
}

export interface WebSocketTransportOptions {
  inbox?: WebSocketQueueLimits
  outbound?: WebSocketQueueLimits
}

interface PendingSend {
  frame: WebSocketFrame
  signal?: AbortSignal
  started: boolean
  aborted: boolean
  resolve(): void
  reject(error: unknown): void
  onAbort?(): void
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return Buffer.from(data)
}

export class BoundedWebSocketInbox {
  readonly #queue: WebSocketPacket[] = []
  readonly #transport: WebSocketTransport
  readonly #maxQueuedMessages: number
  readonly #maxQueuedBytes: number
  #queuedBytes = 0
  #waiter: ((packet: WebSocketPacket) => void) | undefined

  constructor(transport: WebSocketTransport, limits: WebSocketQueueLimits = {}) {
    this.#transport = transport
    this.#maxQueuedMessages = limits.maxQueuedMessages ?? DEFAULT_MAX_QUEUED_MESSAGES
    this.#maxQueuedBytes = limits.maxQueuedBytes ?? DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES
  }

  next(signal: AbortSignal, timeoutMs: number): Promise<WebSocketPacket> {
    const queued = this.#queue.shift()
    if (queued) {
      if (queued.kind === 'message') this.#queuedBytes -= queued.frame.data.length
      return Promise.resolve(queued)
    }
    if (signal.aborted) return Promise.reject(signal.reason)
    if (this.#waiter) return Promise.reject(new Error('websocket inbox already has a pending reader'))
    return new Promise<WebSocketPacket>((resolve, reject) => {
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

  push(packet: WebSocketPacket): void {
    const waiter = this.#waiter
    if (waiter) {
      waiter(packet)
      return
    }
    if (packet.kind === 'message' && (
      this.#queue.length >= this.#maxQueuedMessages
      || this.#queuedBytes + packet.frame.data.length > this.#maxQueuedBytes
    )) {
      this.#queue.length = 0
      this.#queuedBytes = 0
      this.#queue.push({ kind: 'error', error: new Error('websocket receive queue limit exceeded') })
      this.#transport.close(1009, 'websocket receive queue limit exceeded')
      return
    }
    if (packet.kind === 'message') this.#queuedBytes += packet.frame.data.length
    this.#queue.push(packet)
  }
}

export class WebSocketTransport {
  readonly inbox: BoundedWebSocketInbox
  readonly #socket: WebSocket
  readonly #maxQueuedMessages: number
  readonly #maxQueuedBytes: number
  readonly #sendQueue: PendingSend[] = []
  #reservedBytes = 0
  #activeSend: PendingSend | undefined
  #closedError: Error | undefined

  constructor(socket: WebSocket, options: WebSocketTransportOptions = {}) {
    this.#socket = socket
    this.#maxQueuedMessages = options.outbound?.maxQueuedMessages ?? DEFAULT_MAX_QUEUED_MESSAGES
    this.#maxQueuedBytes = options.outbound?.maxQueuedBytes ?? DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES
    this.inbox = new BoundedWebSocketInbox(this, options.inbox)
    socket.on('message', (data, binary) => this.inbox.push({
      kind: 'message',
      frame: { data: rawDataToBuffer(data), binary },
    }))
    socket.once('close', (code, reason) => {
      this.#failQueued(new Error(`websocket closed (${code})`))
      this.inbox.push({ kind: 'close', code, reason })
    })
    socket.once('error', (error) => {
      this.#failQueued(error)
      this.inbox.push({ kind: 'error', error })
    })
  }

  get isOpen(): boolean {
    return this.#socket.readyState === WebSocket.OPEN
  }

  send(frame: WebSocketFrame, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (!this.isOpen || this.#closedError) {
      return Promise.reject(this.#closedError ?? new Error('websocket is not open'))
    }
    const pendingCount = this.#sendQueue.length + (this.#activeSend ? 1 : 0)
    if (
      pendingCount >= this.#maxQueuedMessages
      || this.#reservedBytes + this.#socket.bufferedAmount + frame.data.length > this.#maxQueuedBytes
    ) {
      const error = new Error('websocket send queue limit exceeded')
      this.close(1009, error.message)
      return Promise.reject(error)
    }

    return new Promise<void>((resolve, reject) => {
      const pending: PendingSend = {
        frame: { data: Buffer.from(frame.data), binary: frame.binary },
        signal,
        started: false,
        aborted: false,
        resolve,
        reject,
      }
      if (signal) {
        pending.onAbort = () => {
          pending.aborted = true
          if (pending.started) return
          const index = this.#sendQueue.indexOf(pending)
          if (index >= 0) {
            this.#sendQueue.splice(index, 1)
            this.#reservedBytes -= pending.frame.data.length
            reject(signal.reason)
          }
        }
        signal.addEventListener('abort', pending.onAbort, { once: true })
      }
      this.#reservedBytes += pending.frame.data.length
      this.#sendQueue.push(pending)
      this.#drainSendQueue()
    })
  }

  close(code = 1000, reason = ''): void {
    if (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING) {
      try { this.#socket.close(code, reason) } catch { this.#socket.terminate() }
    }
  }

  terminate(): void {
    if (this.#socket.readyState !== WebSocket.CLOSED) this.#socket.terminate()
  }

  onceClose(listener: () => void): void {
    this.#socket.once('close', listener)
  }

  #drainSendQueue(): void {
    if (this.#activeSend || this.#closedError) return
    const pending = this.#sendQueue.shift()
    if (!pending) return
    this.#reservedBytes -= pending.frame.data.length
    pending.started = true
    this.#activeSend = pending
    this.#socket.send(pending.frame.data, { binary: pending.frame.binary }, (error) => {
      this.#activeSend = undefined
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener('abort', pending.onAbort)
      }
      if (pending.aborted) pending.reject(pending.signal?.reason ?? new Error('websocket send aborted'))
      else if (error) pending.reject(error)
      else pending.resolve()
      this.#drainSendQueue()
    })
  }

  #failQueued(error: Error): void {
    if (this.#closedError) return
    this.#closedError = error
    for (const pending of this.#sendQueue.splice(0)) {
      this.#reservedBytes -= pending.frame.data.length
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener('abort', pending.onAbort)
      }
      pending.reject(error)
    }
  }
}

export class WebSocketHandshakeError extends Error {
  readonly status: number
  readonly responseHeaders: Record<string, string>

  constructor(status: number, responseHeaders: Record<string, string>) {
    super(`upstream websocket handshake returned ${status}`)
    this.name = 'WebSocketHandshakeError'
    this.status = status
    this.responseHeaders = responseHeaders
  }
}

function recordHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) result[name] = Array.isArray(value) ? value.join(', ') : value
  }
  return result
}

export function connectWebSocket(
  url: string,
  options: ClientOptions & {
    signal: AbortSignal
    transport?: WebSocketTransportOptions
  },
): Promise<WebSocketTransport> {
  const { signal, transport, ...clientOptions } = options
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, clientOptions)
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
    const onUnexpectedResponse = (_request: unknown, response: import('node:http').IncomingMessage) => {
      const status = response.statusCode ?? 502
      const responseHeaders = recordHeaders(response.headers)
      response.resume()
      finish(() => {
        socket.once('error', () => undefined)
        socket.terminate()
        reject(new WebSocketHandshakeError(status, responseHeaders))
      })
    }
    socket.once('open', () => finish(() => resolve(new WebSocketTransport(socket, transport))))
    socket.once('error', onError)
    socket.once('unexpected-response', onUnexpectedResponse)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
