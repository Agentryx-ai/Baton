/**
 * Session-host worker: runs the canonical conversation runtime — and with it
 * every synchronous SQLite call — on a dedicated worker thread with its own
 * event loop. The main thread only ever talks to it over a loopback HTTP hop,
 * so a database stall (lock contention, WAL checkpoint, large transaction) can
 * delay session APIs but can no longer freeze the inference proxies, health
 * endpoint, or SPA served by the main thread.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { parentPort, workerData } from 'node:worker_threads'

import express from 'express'

import { createConversationRuntime } from './session/runtime.ts'

interface SessionHostWorkerData {
  dataDir: string
}

if (!parentPort) throw new Error('session-host-worker must run as a worker thread')
const port = parentPort

const { dataDir } = workerData as SessionHostWorkerData
if (typeof dataDir !== 'string' || dataDir.length === 0) {
  throw new Error('session-host-worker requires workerData.dataDir')
}

const token = randomBytes(32).toString('base64url')
const tokenBytes = Buffer.from(token)

const runtime = createConversationRuntime({ dataDir })
const app = express()

// Defense in depth: only the parent process knows this per-boot token, so no
// other loopback client can bypass the main thread and reach the runtime.
app.use((req, res, next) => {
  const presented = req.get('x-baton-session-host')
  const presentedBytes = presented ? Buffer.from(presented) : Buffer.alloc(0)
  if (presentedBytes.length !== tokenBytes.length || !timingSafeEqual(presentedBytes, tokenBytes)) {
    res.status(403).json({ error: { type: 'baton_session_host_forbidden' } })
    return
  }
  next()
})

// Same mount path as the public server so req.originalUrl forwards verbatim.
app.use('/baton/v1', runtime.router)

const server = createServer(app)
// Session streams (SSE) stay open far longer than the default 5-minute cap.
server.requestTimeout = 0
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (!address || typeof address !== 'object') {
    port.postMessage({ type: 'fatal', message: 'session-host worker bound no address' })
    process.exit(1)
  }
  port.postMessage({ type: 'listening', port: address.port, token })
  try {
    const recovered = runtime.start()
    port.postMessage({ type: 'started', recovered })
  } catch (error) {
    port.postMessage({
      type: 'fatal',
      message: `session runtime failed to start: ${error instanceof Error ? error.message : String(error)}`,
    })
    process.exit(1)
  }
})
server.on('error', (error) => {
  port.postMessage({ type: 'fatal', message: `session-host listen failed: ${error.message}` })
  process.exit(1)
})

let shuttingDown = false
port.on('message', (message: unknown) => {
  const type = message && typeof message === 'object' ? (message as { type?: unknown }).type : undefined
  if (type === 'close-streams') {
    // End SSE responses so the parent's connection drain is not stuck behind
    // long-lived streams (mirrors the pre-isolation shutdown order).
    runtime.closeStreams()
    return
  }
  if (type !== 'shutdown') return
  if (shuttingDown) return
  shuttingDown = true
  void (async () => {
    runtime.closeStreams()
    const closed = new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    const drained = await Promise.race([
      closed.then(() => true),
      new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), 3_000)
        timer.unref()
      }),
    ])
    if (!drained) {
      server.closeAllConnections()
      await closed
    }
    await runtime.close()
    process.exit(0)
  })()
})
