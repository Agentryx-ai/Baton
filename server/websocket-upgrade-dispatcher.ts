import { STATUS_CODES } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'

import { WebSocketServer } from 'ws'

import {
  DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES,
  WebSocketTransport,
} from './websocket-transport.ts'
import type { WebSocketTransportOptions } from './websocket-transport.ts'

const DEFAULT_ADMISSION_TIMEOUT_MS = 10_000
const DEFAULT_SHUTDOWN_GRACE_MS = 500
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000

export interface WebSocketUpgradeContext {
  request: IncomingMessage
  signal: AbortSignal
  isClosing(): boolean
  accept(options?: WebSocketTransportOptions): Promise<WebSocketTransport>
  reject(
    status: number,
    type: string,
    message: string,
    headers?: Record<string, string>,
  ): void
}

export interface WebSocketUpgradeRoute {
  path: string
  upgrade(context: WebSocketUpgradeContext): Promise<void>
}

export interface WebSocketUpgradeDispatcherOptions {
  admissionTimeoutMs?: number
  shutdownGraceMs?: number
  shutdownTimeoutMs?: number
}

export interface WebSocketUpgradeDispatcher {
  register(route: WebSocketUpgradeRoute): void
  attach(server: Server): void
  close(): Promise<void>
}

interface PendingAdmission {
  socket: Duplex
  controller: AbortController
  settle(): void
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

function rawRoutePath(target: string | undefined): string | null {
  if (!target || !target.startsWith('/') || target.startsWith('//')) return null
  const queryIndex = target.indexOf('?')
  const path = queryIndex >= 0 ? target.slice(0, queryIndex) : target
  if (!path || path.includes('#') || path.includes('%')) return null
  return path
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

export function createWebSocketUpgradeDispatcher(
  options: WebSocketUpgradeDispatcherOptions = {},
): WebSocketUpgradeDispatcher {
  const routes = new Map<string, WebSocketUpgradeRoute>()
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES,
    perMessageDeflate: true,
  })
  const pending = new Set<PendingAdmission>()
  const clients = new Set<WebSocketTransport>()
  const admissionTimeoutMs = options.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS
  const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  let attached = false
  let closing = false
  let closePromise: Promise<void> | undefined

  return {
    register(route) {
      if (attached) throw new Error('websocket routes must be registered before attach')
      if (rawRoutePath(route.path) !== route.path) {
        throw new Error(`invalid websocket route path: ${route.path}`)
      }
      if (routes.has(route.path)) throw new Error(`duplicate websocket route path: ${route.path}`)
      routes.set(route.path, route)
    },

    attach(server) {
      if (attached) throw new Error('websocket upgrade dispatcher is already attached')
      if (server.listenerCount('upgrade') !== 0) {
        throw new Error('websocket upgrade dispatcher must own the only upgrade listener')
      }
      attached = true
      server.on('upgrade', (request, socket, head) => {
        if (closing) {
          rejectUpgrade(socket, 503, 'baton_restarting', 'Baton is restarting.')
          return
        }
        const controller = new AbortController()
        let settled = false
        const timeout = setTimeout(() => {
          controller.abort(new Error('websocket admission timeout'))
          rejectUpgrade(socket, 504, 'baton_websocket_admission_timeout', 'WebSocket admission timed out.')
          settle()
        }, admissionTimeoutMs)
        timeout.unref()
        const onSocketEnd = () => {
          controller.abort(new Error('websocket client disconnected during admission'))
          settle()
        }
        const settle = () => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          socket.off('close', onSocketEnd)
          socket.off('error', onSocketEnd)
          pending.delete(admission)
        }
        const admission: PendingAdmission = { socket, controller, settle }
        pending.add(admission)
        socket.once('close', onSocketEnd)
        socket.once('error', onSocketEnd)

        const path = rawRoutePath(request.url)
        if (!path) {
          rejectUpgrade(socket, 400, 'invalid_request_error', 'Invalid websocket request target.')
          settle()
          return
        }
        const route = routes.get(path)
        if (!route) {
          rejectUpgrade(socket, 404, 'baton_proxy_route_not_found', 'Unknown websocket route.')
          settle()
          return
        }

        const context: WebSocketUpgradeContext = {
          request,
          signal: controller.signal,
          isClosing: () => closing,
          accept: (transportOptions = {}) => new Promise<WebSocketTransport>((resolve, reject) => {
            if (settled) {
              reject(controller.signal.reason ?? new Error('websocket admission already settled'))
              return
            }
            if (closing || controller.signal.aborted) {
              rejectUpgrade(socket, 503, 'baton_restarting', 'Baton is restarting.')
              settle()
              reject(controller.signal.reason ?? new Error('websocket dispatcher is closing'))
              return
            }
            try {
              websocketServer.handleUpgrade(request, socket, head, (websocket) => {
                const transport = new WebSocketTransport(websocket, transportOptions)
                clients.add(transport)
                transport.onceClose(() => clients.delete(transport))
                settle()
                resolve(transport)
              })
            } catch (error) {
              settle()
              if (!socket.destroyed) socket.destroy()
              reject(error)
            }
          }),
          reject(status, type, message, headers = {}) {
            if (settled) return
            rejectUpgrade(socket, status, type, message, headers)
            settle()
          },
        }

        void route.upgrade(context).catch(() => {
          if (settled) return
          rejectUpgrade(socket, 503, 'baton_websocket_admission_failed', 'WebSocket admission failed.')
          settle()
        })
      })
    },

    close() {
      if (closePromise) return closePromise
      closePromise = (async () => {
        closing = true
        for (const admission of [...pending]) {
          admission.controller.abort(new Error('websocket dispatcher is closing'))
          admission.socket.destroy()
          admission.settle()
        }
        for (const client of clients) client.close(1001, 'Baton is restarting')
        await Promise.race([
          Promise.all([...clients].map((client) => new Promise<void>((resolve) => {
            client.onceClose(resolve)
          }))),
          delay(shutdownGraceMs),
        ])
        for (const client of clients) client.terminate()

        const closeServer = new Promise<void>((resolve) => {
          websocketServer.close(() => resolve())
        })
        await Promise.race([closeServer, delay(shutdownTimeoutMs)])
      })()
      return closePromise
    },
  }
}
