/**
 * Main-thread side of the session host: supervises the worker thread that owns
 * the conversation runtime (and all synchronous SQLite access) and streams
 * `/baton/v1` requests to it over a private loopback HTTP hop.
 *
 * Architecture: the store's synchronous transactions are correct and must stay
 * synchronous (an async transaction would hold SQLite locks across awaits).
 * The fix for event-loop starvation is therefore isolation, not asyncification:
 * the worker's event loop may stall on the database; the main thread's never
 * does, so inference proxies, health, and the SPA stay responsive.
 */
import { Agent, request as httpRequest } from 'node:http'
import { Worker } from 'node:worker_threads'
import type { Request, RequestHandler, Response } from 'express'

import { createConversationRuntime } from './session/runtime.ts'

const RESTART_DELAYS_MS = [250, 1_000, 5_000, 15_000, 30_000]
const HEALTHY_RESET_MS = 60_000
/**
 * How long a request may wait for the worker to become ready before failing.
 * Must exceed the top restart-backoff rung (RESTART_DELAYS_MS max, 30s) plus a
 * boot margin, or a request parked at the start of an elevated-backoff window
 * 503s before the worker is even respawned; browsers treat an SSE HTTP error as
 * a permanent connection failure (no automatic retry), so holding the request
 * until the worker is back preserves live streams.
 */
const READY_WAIT_MS = 40_000
// A fresh connection per hop: reusing pooled keep-alive sockets races the
// worker server's idle timeout and surfaces spurious ECONNRESET 502s.
const hopAgent = new Agent({ keepAlive: false })

/** Hop-by-hop headers never forwarded across the internal hop (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export interface SessionHostSnapshot {
  mode: 'worker' | 'inline'
  state: 'starting' | 'ready' | 'down' | 'closed' | 'inline'
  restarts: number
  /** Worker mode, ready only: internal loopback port (token stays private). */
  port?: number
  lastError?: string
}

export interface SessionHost {
  middleware: RequestHandler
  snapshot(): SessionHostSnapshot
  close(): Promise<void>
  /** Inline mode only: run recovery synchronously; worker mode self-starts. */
  start(): number | null
  closeStreams(): void
}

export interface SessionHostTarget {
  port: number
  token: string
}

/**
 * Stream one request to the session-host upstream and its response back.
 * Preserves the original Host header (the runtime's origin/CSRF checks compare
 * against it) and passes bodies through byte-for-byte in both directions, so
 * SSE streams flow unbuffered.
 */
export function forwardToSessionHost(target: SessionHostTarget, req: Request, res: Response): void {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue
    headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  headers['x-baton-session-host'] = target.token

  const upstream = httpRequest({
    host: '127.0.0.1',
    port: target.port,
    method: req.method,
    path: req.originalUrl,
    headers,
    agent: hopAgent,
    // SSE responses idle between events; never time the socket out here.
    timeout: 0,
  })

  const abortUpstream = () => {
    if (!res.writableEnded) upstream.destroy(new Error('client disconnected'))
  }
  res.once('close', abortUpstream)

  upstream.on('response', (proxied) => {
    const responseHeaders: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(proxied.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name)) continue
      responseHeaders[name] = value
    }
    res.writeHead(proxied.statusCode ?? 502, responseHeaders)
    proxied.pipe(res)
    proxied.once('error', () => {
      res.destroy()
    })
  })
  upstream.once('error', () => {
    res.off('close', abortUpstream)
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.status(502).json({ error: { type: 'baton_session_host_unreachable' } })
  })
  req.pipe(upstream)
  req.once('error', () => upstream.destroy())
}

function unavailable(res: Response): void {
  res.status(503).json({
    error: {
      type: 'baton_session_host_unavailable',
      message: '세션 런타임이 준비 중입니다. 잠시 후 다시 시도하세요.',
    },
  })
}

export interface WorkerSessionHostOptions {
  dataDir: string
  workerUrl?: URL
  onStarted?: (recovered: number) => void
  onExit?: (info: { code: number; restarting: boolean }) => void
}

export function createWorkerSessionHost(options: WorkerSessionHostOptions): SessionHost {
  const workerUrl = options.workerUrl ?? new URL('./session-host-worker-bootstrap.mjs', import.meta.url)
  let state: SessionHostSnapshot['state'] = 'starting'
  let target: SessionHostTarget | null = null
  let worker: Worker | null = null
  let restarts = 0
  let attempt = 0
  let lastError: string | undefined
  let startedAt = 0
  // Closure is tracked separately from `state`: worker messages (`listening`)
  // arrive asynchronously and must never be able to overwrite a closed host
  // back to ready — that would flush requests into a dying worker and make the
  // exit handler respawn a zombie nothing will ever stop.
  let closed = false
  // Worker mode spawns lazily on start() (called from the server.listen success
  // callback), not at construction: a duplicate process that loses the :4400
  // race and stands down must never open the shared SQLite DB or run
  // destructive interrupted-turn recovery against the healthy incumbent.
  let started = false
  let respawnTimer: ReturnType<typeof setTimeout> | null = null
  const closeResolvers: (() => void)[] = []

  interface Waiter {
    req: Request
    res: Response
    timer: ReturnType<typeof setTimeout>
    onAbort: () => void
  }
  const waiters: Waiter[] = []

  const dropWaiter = (waiter: Waiter): void => {
    clearTimeout(waiter.timer)
    waiter.res.off('close', waiter.onAbort)
    const index = waiters.indexOf(waiter)
    if (index >= 0) waiters.splice(index, 1)
  }

  const flushWaiters = (): void => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.res.off('close', waiter.onAbort)
      if (waiter.res.writableEnded || waiter.res.destroyed) continue
      if (target) forwardToSessionHost(target, waiter.req, waiter.res)
      else unavailable(waiter.res)
    }
  }

  const failWaiters = (): void => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.res.off('close', waiter.onAbort)
      if (!waiter.res.writableEnded && !waiter.res.destroyed) unavailable(waiter.res)
    }
  }

  const spawn = (): void => {
    if (closed) return
    state = 'starting'
    target = null
    let spawned: Worker
    try {
      spawned = new Worker(workerUrl, {
        workerData: { dataDir: options.dataDir },
        env: { ...process.env, BATON_DATA_DIR: options.dataDir },
      })
    } catch (error) {
      // `new Worker()` throws synchronously (ERR_WORKER_INIT_FAILED) when a
      // thread/isolate cannot be allocated under memory/handle pressure. This
      // runs from the respawn setTimeout, so an uncaught throw would escape the
      // timer and crash the main :4400 process (inference proxies included).
      // Treat it as a failed attempt and back off, exactly like an early exit —
      // no exit event fires here, so self-reschedule.
      worker = null
      state = 'down'
      lastError = error instanceof Error ? error.message : String(error)
      const delay = RESTART_DELAYS_MS[Math.min(attempt, RESTART_DELAYS_MS.length - 1)]
      attempt += 1
      restarts += 1
      console.error(`[baton] session host worker failed to spawn: ${lastError}; retrying in ${delay}ms`)
      respawnTimer = setTimeout(spawn, delay)
      respawnTimer.unref()
      return
    }
    worker = spawned
    startedAt = Date.now()
    spawned.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return
      const value = message as { type?: unknown; port?: unknown; token?: unknown; recovered?: unknown; message?: unknown }
      if (closed) return
      if (value.type === 'listening' && typeof value.port === 'number' && typeof value.token === 'string') {
        target = { port: value.port, token: value.token }
        state = 'ready'
        lastError = undefined
        flushWaiters()
        return
      }
      if (value.type === 'started' && typeof value.recovered === 'number') {
        options.onStarted?.(value.recovered)
        return
      }
      if (value.type === 'fatal') {
        lastError = typeof value.message === 'string' ? value.message : 'session host failed'
        console.error(`[baton] session host fatal: ${lastError}`)
      }
    })
    spawned.on('error', (error) => {
      lastError = error.message
      // Full stack: a supervisor that logs only the message turns every worker
      // failure into an unattributable one-liner.
      console.error(`[baton] session host worker error: ${error.stack ?? error.message}`)
    })
    spawned.once('exit', (code) => {
      if (worker === spawned) worker = null
      target = null
      if (closed) {
        state = 'closed'
        for (const resolve of closeResolvers.splice(0)) resolve()
        return
      }
      state = 'down'
      // A worker that stayed healthy long enough earns a fresh backoff ladder.
      if (Date.now() - startedAt >= HEALTHY_RESET_MS) attempt = 0
      const delay = RESTART_DELAYS_MS[Math.min(attempt, RESTART_DELAYS_MS.length - 1)]
      attempt += 1
      restarts += 1
      options.onExit?.({ code, restarting: true })
      console.error(`[baton] session host exited (code ${code}); restarting in ${delay}ms`)
      respawnTimer = setTimeout(spawn, delay)
      respawnTimer.unref()
    })
  }

  return {
    middleware: (req, res) => {
      if (state === 'ready' && target) {
        forwardToSessionHost(target, req, res)
        return
      }
      if (state === 'closed') {
        unavailable(res)
        return
      }
      // Boot window or restart backoff: hold the request until the worker is
      // back. An immediate 503 would permanently fail browser EventSources
      // (SSE HTTP errors never auto-retry), turning a transient restart into
      // a dead live view.
      const waiter: Waiter = {
        req,
        res,
        timer: setTimeout(() => {
          dropWaiter(waiter)
          if (!res.writableEnded && !res.destroyed) unavailable(res)
        }, READY_WAIT_MS),
        onAbort: () => dropWaiter(waiter),
      }
      waiter.timer.unref()
      res.once('close', waiter.onAbort)
      waiters.push(waiter)
    },
    snapshot: () => ({
      mode: 'worker',
      state,
      restarts,
      ...(state === 'ready' && target ? { port: target.port } : {}),
      ...(lastError ? { lastError } : {}),
    }),
    start: () => {
      // Spawn the worker only now that this process has won :4400 (start() is
      // called from the server.listen success callback). A yielding/foreign
      // duplicate never reaches this, so it never opens the shared DB.
      if (!started && !closed) {
        started = true
        spawn()
      }
      return null
    },
    closeStreams: () => {
      // Mirror the old inline semantics: end worker-held SSE streams now so
      // the main server's connection drain is not stuck behind them — and
      // release parked requests too, or their headerless responses would pin
      // the drain for its full timeout.
      failWaiters()
      worker?.postMessage({ type: 'close-streams' })
    },
    close: async () => {
      closed = true
      state = 'closed'
      if (respawnTimer) clearTimeout(respawnTimer)
      respawnTimer = null
      failWaiters()
      const active = worker
      if (!active) return
      const exited = new Promise<void>((resolve) => closeResolvers.push(resolve))
      active.postMessage({ type: 'shutdown' })
      const graceful = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolve) => {
          const timer = setTimeout(() => resolve(false), 5_000)
          timer.unref()
        }),
      ])
      if (!graceful) await active.terminate()
    },
  }
}

/**
 * Escape hatch (`BATON_SESSION_HOST=inline`): run the runtime on the main
 * thread exactly as before the isolation change — for debugging, or if the
 * worker loader is unavailable in some environment.
 */
export function createInlineSessionHost(options: { dataDir: string }): SessionHost {
  const runtime = createConversationRuntime({ dataDir: options.dataDir })
  return {
    middleware: runtime.router,
    snapshot: () => ({ mode: 'inline', state: 'inline', restarts: 0 }),
    start: () => runtime.start(),
    closeStreams: () => runtime.closeStreams(),
    close: () => runtime.close(),
  }
}
