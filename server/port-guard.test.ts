import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'

import { classifyPortConflict } from './port-guard.ts'

async function withServer(
  handler: (url: string, res: import('node:http').ServerResponse) => void,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => handler(req.url ?? '', res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    await run(port)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('yields to a healthy Baton incumbent on /baton/health', async () => {
  await withServer((url, res) => {
    assert.equal(url, '/baton/health')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, sessionHost: { state: 'ready' } }))
  }, async (port) => {
    assert.equal(await classifyPortConflict(port), 'yield')
  })
})

test('treats an impostor returning bare {ok:true} without a Baton marker as foreign', async () => {
  await withServer((_url, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  }, async (port) => {
    assert.equal(await classifyPortConflict(port), 'foreign')
  })
})

test('treats an unhealthy Baton body as foreign', async () => {
  await withServer((_url, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false }))
  }, async (port) => {
    assert.equal(await classifyPortConflict(port), 'foreign')
  })
})

test('treats a non-200 response as foreign', async () => {
  await withServer((_url, res) => {
    res.writeHead(503)
    res.end('unavailable')
  }, async (port) => {
    assert.equal(await classifyPortConflict(port), 'foreign')
  })
})

test('treats a refused connection as foreign', async () => {
  // Port 1 is reserved and never listening on loopback.
  assert.equal(await classifyPortConflict(1, '127.0.0.1', { timeoutMs: 500 }), 'foreign')
})

test('treats a hung incumbent as foreign once the probe times out', async () => {
  await withServer((_url, _res) => {
    // Never respond; the probe must abort and classify as foreign.
  }, async (port) => {
    assert.equal(await classifyPortConflict(port, '127.0.0.1', { timeoutMs: 150 }), 'foreign')
  })
})
