import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import net from 'node:net'
import test from 'node:test'

import { WebSocket } from 'ws'

import { createWebSocketUpgradeDispatcher } from './websocket-upgrade-dispatcher.ts'

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return address.port
}

function rawUpgrade(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('timed out waiting for upgrade response'))
    }, 2_000)
    socket.once('connect', () => socket.write([
      `GET ${target} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      '',
      '',
    ].join('\r\n')))
    socket.once('data', (data) => {
      clearTimeout(timeout)
      resolve(data.toString('utf8'))
      socket.destroy()
    })
    socket.once('error', reject)
  })
}

test('websocket dispatcher owns one listener and routes exact paths with query compatibility', async (t) => {
  const server = createServer()
  const dispatcher = createWebSocketUpgradeDispatcher()
  dispatcher.register({
    path: '/registered',
    async upgrade(context) {
      const transport = await context.accept()
      transport.close()
    },
  })
  assert.throws(() => dispatcher.register({ path: '/registered', async upgrade() {} }), /duplicate/)
  dispatcher.attach(server)
  assert.equal(server.listenerCount('upgrade'), 1)
  const port = await listen(server)
  t.after(async () => {
    await dispatcher.close()
    server.close()
  })

  const client = new WebSocket(`ws://127.0.0.1:${port}/registered?trace=1`)
  await once(client, 'open')
  await once(client, 'close')

  assert.match(await rawUpgrade(port, '/unknown'), /^HTTP\/1\.1 404 /)
  assert.match(await rawUpgrade(port, '/registered%2Fchild'), /^HTTP\/1\.1 400 /)
  assert.match(await rawUpgrade(port, '//registered'), /^HTTP\/1\.1 400 /)
})

test('websocket dispatcher refuses competing upgrade listeners', () => {
  const server = createServer()
  server.on('upgrade', () => undefined)
  const dispatcher = createWebSocketUpgradeDispatcher()
  assert.throws(() => dispatcher.attach(server), /only upgrade listener/)
})

test('websocket dispatcher aborts pending admission and close is idempotent', async () => {
  const server = createServer()
  const dispatcher = createWebSocketUpgradeDispatcher({ admissionTimeoutMs: 30_000 })
  let admissionStarted!: () => void
  const started = new Promise<void>((resolve) => { admissionStarted = resolve })
  let admissionAborted = false
  dispatcher.register({
    path: '/pending',
    async upgrade(context) {
      admissionStarted()
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) resolve()
        else context.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      admissionAborted = true
    },
  })
  dispatcher.attach(server)
  const port = await listen(server)
  const client = new WebSocket(`ws://127.0.0.1:${port}/pending`)
  client.on('error', () => undefined)
  await started

  const firstClose = dispatcher.close()
  const secondClose = dispatcher.close()
  assert.equal(firstClose, secondClose)
  let closeTimeout: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      firstClose,
      new Promise<never>((_resolve, reject) => {
        closeTimeout = setTimeout(() => reject(new Error('dispatcher close timed out')), 5_000)
      }),
    ])
  } finally {
    if (closeTimeout) clearTimeout(closeTimeout)
  }
  assert.equal(admissionAborted, true)
  assert.notEqual(client.readyState, WebSocket.OPEN)
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
