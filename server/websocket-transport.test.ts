import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'

import { WebSocket, WebSocketServer } from 'ws'

import { WebSocketTransport } from './websocket-transport.ts'
import type { WebSocketTransportOptions } from './websocket-transport.ts'

async function createPair(options: WebSocketTransportOptions = {}): Promise<{
  client: WebSocket
  server: ReturnType<typeof createServer>
  webSockets: WebSocketServer
  transport: WebSocketTransport
}> {
  const server = createServer()
  const webSockets = new WebSocketServer({ noServer: true })
  let acceptTransport!: (transport: WebSocketTransport) => void
  const accepted = new Promise<WebSocketTransport>((resolve) => { acceptTransport = resolve })
  server.on('upgrade', (request, socket, head) => {
    webSockets.handleUpgrade(request, socket, head, (websocket) => {
      acceptTransport(new WebSocketTransport(websocket, options))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`)
  await once(client, 'open')
  return { client, server, webSockets, transport: await accepted }
}

function closePair(pair: Awaited<ReturnType<typeof createPair>>): void {
  pair.transport.terminate()
  pair.client.terminate()
  pair.webSockets.close()
  pair.server.close()
}

test('websocket transport preserves text and binary frame bytes in both directions', async (t) => {
  const pair = await createPair()
  t.after(() => closePair(pair))
  const abort = new AbortController()

  pair.client.send(Buffer.from('client-text'), { binary: false })
  pair.client.send(Buffer.from([0, 1, 2, 255]), { binary: true })
  const first = await pair.transport.inbox.next(abort.signal, 2_000)
  const second = await pair.transport.inbox.next(abort.signal, 2_000)
  assert.equal(first.kind, 'message')
  assert.equal(second.kind, 'message')
  if (first.kind !== 'message' || second.kind !== 'message') return
  assert.equal(first.frame.binary, false)
  assert.equal(first.frame.data.toString(), 'client-text')
  assert.equal(second.frame.binary, true)
  assert.deepEqual([...second.frame.data], [0, 1, 2, 255])

  const received: Array<{ data: Buffer; binary: boolean }> = []
  const complete = new Promise<void>((resolve) => {
    pair.client.on('message', (data, binary) => {
      received.push({ data: Buffer.from(data as Buffer), binary })
      if (received.length === 2) resolve()
    })
  })
  await Promise.all([
    pair.transport.send({ data: Buffer.from('server-text'), binary: false }),
    pair.transport.send({ data: Buffer.from([9, 8, 7]), binary: true }),
  ])
  await complete
  assert.equal(received[0]?.binary, false)
  assert.equal(received[0]?.data.toString(), 'server-text')
  assert.equal(received[1]?.binary, true)
  assert.deepEqual([...(received[1]?.data ?? [])], [9, 8, 7])
})

test('websocket transport rejects concurrent inbox readers without losing the first reader', async (t) => {
  const pair = await createPair()
  t.after(() => closePair(pair))
  const abort = new AbortController()
  const first = pair.transport.inbox.next(abort.signal, 2_000)
  await assert.rejects(
    pair.transport.inbox.next(abort.signal, 2_000),
    /already has a pending reader/,
  )
  pair.client.send('first-reader')
  const packet = await first
  assert.equal(packet.kind, 'message')
  if (packet.kind === 'message') assert.equal(packet.frame.data.toString(), 'first-reader')
})

test('websocket transport does not double-count the active outbound frame', async (t) => {
  const oneMiB = 1024 * 1024
  const pair = await createPair({
    outbound: { maxQueuedMessages: 2, maxQueuedBytes: oneMiB * 2 },
  })
  t.after(() => closePair(pair))
  const rawSocket = (pair.client as unknown as { _socket: { pause(): void; resume(): void } })._socket
  rawSocket.pause()
  const first = pair.transport.send({ data: Buffer.alloc(oneMiB, 1), binary: true })
  const second = pair.transport.send({ data: Buffer.alloc(oneMiB, 2), binary: true })
  rawSocket.resume()
  await Promise.all([first, second])
  assert.equal(pair.transport.isOpen, true)
})

test('websocket transport enforces inbound queue bounds', async (t) => {
  const pair = await createPair({ inbox: { maxQueuedMessages: 1, maxQueuedBytes: 16 } })
  t.after(() => closePair(pair))
  const closed = once(pair.client, 'close')
  pair.client.send('one')
  pair.client.send('two')
  const [code] = await closed
  assert.equal(code, 1009)
  const packet = await pair.transport.inbox.next(new AbortController().signal, 2_000)
  assert.equal(packet.kind, 'error')
})

test('websocket transport rejects outbound queue overflow', async (t) => {
  const pair = await createPair({ outbound: { maxQueuedMessages: 0, maxQueuedBytes: 16 } })
  t.after(() => closePair(pair))
  const closed = once(pair.client, 'close')
  await assert.rejects(
    pair.transport.send({ data: Buffer.from('overflow'), binary: false }),
    /send queue limit exceeded/,
  )
  const [code] = await closed
  assert.equal(code, 1009)
})
