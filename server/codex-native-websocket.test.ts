import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'

import express from 'express'
import { WebSocket, WebSocketServer } from 'ws'

import type { CodexNativeProxyAccount } from './codex-native-proxy.ts'
import {
  CODEX_RESPONSES_WEBSOCKET_VERSION,
  createCodexResponsesWebSocketRoute,
} from './codex-native-websocket.ts'
import { NativeAccountCooldowns } from './native-account-router.ts'
import { NativeProxyHealthTracker } from './native-proxy-health.ts'
import { createWebSocketUpgradeDispatcher } from './websocket-upgrade-dispatcher.ts'

function createCodexNativeWebSocketProxy(
  options: Parameters<typeof createCodexResponsesWebSocketRoute>[0],
) {
  const dispatcher = createWebSocketUpgradeDispatcher()
  dispatcher.register(createCodexResponsesWebSocketRoute(options))
  return dispatcher
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return address.port
}

function account(
  id: string,
  priority: number,
  accessToken: string,
  models = ['gpt-5.6-sol'],
): CodexNativeProxyAccount {
  return {
    id,
    priority,
    enabled: true,
    models,
    credential: {
      accountId: id,
      accessToken,
      chatgptAccountId: `workspace-${id}`,
    },
  }
}

function receiveUntil(socket: WebSocket, terminalType: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const messages: string[] = []
    const timeout = setTimeout(() => finish(() => reject(new Error('timed out waiting for websocket events'))), 5_000)
    const onError = (error: Error) => finish(() => reject(error))
    const onMessage = (data: Buffer) => {
      const text = data.toString('utf8')
      messages.push(text)
      const payload = JSON.parse(text) as { type?: string }
      if (payload.type === terminalType) finish(() => resolve(messages))
    }
    const finish = (complete: () => void) => {
      clearTimeout(timeout)
      socket.off('error', onError)
      socket.off('message', onMessage)
      complete()
    }
    socket.on('error', onError)
    socket.on('message', onMessage)
  })
}

test('Codex websocket proxy negotiates v2, fails over handshake 429, and reuses the selected upstream', async (t) => {
  let clock = Date.now()
  const authorizations: string[] = []
  const workspaces: string[] = []
  const requests: string[] = []
  let upstreamConnections = 0
  const upstreamServer = createServer()
  const upstreamWebSockets = new WebSocketServer({ noServer: true })
  upstreamServer.on('upgrade', (request, socket, head) => {
    const authorization = request.headers.authorization ?? ''
    authorizations.push(authorization)
    workspaces.push(String(request.headers['chatgpt-account-id'] ?? ''))
    if (authorization === 'Bearer access-a') {
      const body = '{"error":{"type":"usage_limit_reached"}}'
      socket.end([
        'HTTP/1.1 429 Too Many Requests',
        'Connection: close',
        'Content-Type: application/json',
        'Retry-After: 60',
        `Content-Length: ${Buffer.byteLength(body)}`,
        '',
        body,
      ].join('\r\n'))
      return
    }
    upstreamWebSockets.handleUpgrade(request, socket, head, (websocket) => {
      upstreamWebSockets.emit('connection', websocket, request)
    })
  })
  upstreamWebSockets.on('connection', (socket) => {
    upstreamConnections += 1
    socket.on('message', (data) => {
      const request = data.toString()
      requests.push(request)
      const number = requests.length
      socket.send(JSON.stringify({ type: 'response.created', response: { id: `resp-${number}` } }))
      socket.send(JSON.stringify({ type: 'response.output_text.delta', delta: `answer-${number}` }))
      socket.send(JSON.stringify({ type: 'response.completed', response: { id: `resp-${number}` } }))
    })
  })
  const upstreamPort = await listen(upstreamServer)

  const app = express()
  const proxyServer = createServer(app)
  const health = new NativeProxyHealthTracker({ provider: 'codex', minimumSamples: 1 })
  const websocketProxy = createCodexNativeWebSocketProxy({
    loadAccounts: async () => [
      account('a', 10, 'access-a'),
      account('b', 20, 'access-b'),
    ],
    trustLoopbackClient: true,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    cooldowns: new NativeAccountCooldowns(),
    health,
    now: () => clock,
  })
  websocketProxy.attach(proxyServer)
  const proxyPort = await listen(proxyServer)
  t.after(async () => {
    await websocketProxy.close()
    upstreamWebSockets.close()
    proxyServer.close()
    upstreamServer.close()
  })

  const client = new WebSocket(
    `ws://127.0.0.1:${proxyPort}/baton/inference/openai/v1/responses`,
    { headers: { 'OpenAI-Beta': CODEX_RESPONSES_WEBSOCKET_VERSION } },
  )
  await once(client, 'open')

  const firstRequest = JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'one' })
  const firstEvents = receiveUntil(client, 'response.completed')
  client.send(firstRequest)
  assert.deepEqual((await firstEvents).map((event) => JSON.parse(event).type), [
    'response.created',
    'response.output_text.delta',
    'response.completed',
  ])

  const secondRequest = JSON.stringify({
    type: 'response.create',
    model: 'gpt-5.6-sol',
    previous_response_id: 'resp-1',
    input: 'two',
  })
  clock += 61_000
  const secondEvents = receiveUntil(client, 'response.completed')
  client.send(secondRequest)
  await secondEvents

  assert.deepEqual(authorizations, ['Bearer access-a', 'Bearer access-b'])
  assert.deepEqual(workspaces, ['workspace-a', 'workspace-b'])
  assert.equal(upstreamConnections, 1)
  assert.deepEqual(requests, [firstRequest, secondRequest])
  assert.equal(health.snapshot().sampleCount, 2)
  assert.equal(health.snapshot().errorRate, 0)
  client.close()
})

test('Codex websocket proxy owns upstream identity and capability headers', async (t) => {
  let observedHeaders: Record<string, string | string[] | undefined> | undefined
  const upstreamServer = createServer()
  const upstreamWebSockets = new WebSocketServer({ noServer: true })
  upstreamServer.on('upgrade', (request, socket, head) => {
    observedHeaders = request.headers
    upstreamWebSockets.handleUpgrade(request, socket, head, (websocket) => {
      upstreamWebSockets.emit('connection', websocket)
    })
  })
  upstreamWebSockets.on('connection', (socket) => {
    socket.on('message', () => {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp-header' } }))
      socket.send(JSON.stringify({ type: 'response.completed', response: { id: 'resp-header' } }))
    })
  })
  const upstreamPort = await listen(upstreamServer)
  const selected = account('selected', 10, 'server-access')
  selected.credential.chatgptAccountId = undefined

  const proxyServer = createServer(express())
  const websocketProxy = createCodexNativeWebSocketProxy({
    loadAccounts: async () => [selected],
    trustLoopbackClient: true,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
  })
  websocketProxy.attach(proxyServer)
  const proxyPort = await listen(proxyServer)
  t.after(async () => {
    await websocketProxy.close()
    upstreamWebSockets.close()
    proxyServer.close()
    upstreamServer.close()
  })

  const client = new WebSocket(
    `ws://127.0.0.1:${proxyPort}/baton/inference/openai/v1/responses`,
    {
      headers: {
        'OpenAI-Beta': `${CODEX_RESPONSES_WEBSOCKET_VERSION}, ignored-client-feature`,
        Authorization: 'Bearer client-access',
        'X-Api-Key': 'client-api-key',
        'ChatGPT-Account-Id': 'client-workspace',
        Originator: 'client-originator',
        'Accept-Language': 'ko-KR',
      },
    },
  )
  await once(client, 'open')
  const events = receiveUntil(client, 'response.completed')
  client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'headers' }))
  await events

  assert.equal(observedHeaders?.authorization, 'Bearer server-access')
  assert.equal(observedHeaders?.['chatgpt-account-id'], undefined)
  assert.equal(observedHeaders?.originator, 'baton')
  assert.equal(observedHeaders?.['openai-beta'], CODEX_RESPONSES_WEBSOCKET_VERSION)
  assert.equal(observedHeaders?.['x-api-key'], undefined)
  assert.equal(observedHeaders?.['accept-language'], 'ko-KR')
  client.close()
})

test('Codex websocket proxy never retries after the first upstream frame is committed', async (t) => {
  const authorizations: string[] = []
  const upstreamServer = createServer()
  const upstreamWebSockets = new WebSocketServer({ noServer: true })
  upstreamServer.on('upgrade', (request, socket, head) => {
    authorizations.push(request.headers.authorization ?? '')
    upstreamWebSockets.handleUpgrade(request, socket, head, (websocket) => {
      upstreamWebSockets.emit('connection', websocket, request)
    })
  })
  upstreamWebSockets.on('connection', (socket) => {
    socket.once('message', () => {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp-a' } }))
      socket.send(JSON.stringify({
        type: 'error',
        status: 429,
        error: { type: 'usage_limit_reached', message: 'limit reached' },
      }))
    })
  })
  const upstreamPort = await listen(upstreamServer)

  const proxyServer = createServer(express())
  const websocketProxy = createCodexNativeWebSocketProxy({
    loadAccounts: async () => [
      account('a', 10, 'access-a'),
      account('b', 20, 'access-b'),
    ],
    trustLoopbackClient: true,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
  })
  websocketProxy.attach(proxyServer)
  const proxyPort = await listen(proxyServer)
  t.after(async () => {
    await websocketProxy.close()
    upstreamWebSockets.close()
    proxyServer.close()
    upstreamServer.close()
  })

  const client = new WebSocket(
    `ws://127.0.0.1:${proxyPort}/baton/inference/openai/v1/responses`,
    { headers: { 'OpenAI-Beta': CODEX_RESPONSES_WEBSOCKET_VERSION } },
  )
  await once(client, 'open')
  const events = receiveUntil(client, 'error')
  client.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'one' }))

  assert.deepEqual((await events).map((event) => JSON.parse(event).type), ['response.created', 'error'])
  assert.deepEqual(authorizations, ['Bearer access-a'])
  client.close()
})

test('Codex websocket proxy rejects an unsupported protocol version with 426 before upgrade', async (t) => {
  const proxyServer = createServer(express())
  const websocketProxy = createCodexNativeWebSocketProxy({
    loadAccounts: async () => [account('a', 10, 'access-a')],
    trustLoopbackClient: true,
  })
  websocketProxy.attach(proxyServer)
  const proxyPort = await listen(proxyServer)
  t.after(async () => {
    await websocketProxy.close()
    proxyServer.close()
  })

  const status = await new Promise<number>((resolve, reject) => {
    const client = new WebSocket(
      `ws://127.0.0.1:${proxyPort}/baton/inference/openai/v1/responses`,
      { headers: { 'OpenAI-Beta': 'responses_websockets=1900-01-01' } },
    )
    client.once('open', () => reject(new Error('unexpected websocket upgrade')))
    client.once('error', () => undefined)
    client.once('unexpected-response', (_request, response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
  })
  assert.equal(status, 426)
})

test('Codex websocket proxy rejects upgrades that race with shutdown and closes cleanly', async (t) => {
  const proxyServer = createServer(express())
  const websocketProxy = createCodexNativeWebSocketProxy({
    loadAccounts: async () => [account('a', 10, 'access-a')],
    trustLoopbackClient: true,
  })
  websocketProxy.attach(proxyServer)
  const proxyPort = await listen(proxyServer)
  t.after(() => proxyServer.close())

  const existing = new WebSocket(
    `ws://127.0.0.1:${proxyPort}/baton/inference/openai/v1/responses`,
    { headers: { 'OpenAI-Beta': CODEX_RESPONSES_WEBSOCKET_VERSION } },
  )
  await once(existing, 'open')
  const closing = websocketProxy.close()

  const status = await new Promise<number>((resolve, reject) => {
    const racing = new WebSocket(
      `ws://127.0.0.1:${proxyPort}/baton/inference/openai/v1/responses`,
      { headers: { 'OpenAI-Beta': CODEX_RESPONSES_WEBSOCKET_VERSION } },
    )
    racing.once('open', () => reject(new Error('shutdown race unexpectedly upgraded')))
    racing.once('error', () => undefined)
    racing.once('unexpected-response', (_request, response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
  })

  assert.equal(status, 503)
  await closing
})

test('Codex websocket proxy bounds queued client requests while a response is in flight', async (t) => {
  let firstRequestReceived: (() => void) | undefined
  const receivedFirstRequest = new Promise<void>((resolve) => { firstRequestReceived = resolve })
  const upstreamServer = createServer()
  const upstreamWebSockets = new WebSocketServer({ noServer: true })
  upstreamServer.on('upgrade', (request, socket, head) => {
    upstreamWebSockets.handleUpgrade(request, socket, head, (websocket) => {
      upstreamWebSockets.emit('connection', websocket, request)
    })
  })
  upstreamWebSockets.on('connection', (socket) => {
    socket.once('message', () => firstRequestReceived?.())
  })
  const upstreamPort = await listen(upstreamServer)

  const proxyServer = createServer(express())
  const websocketProxy = createCodexNativeWebSocketProxy({
    loadAccounts: async () => [account('a', 10, 'access-a')],
    trustLoopbackClient: true,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
  })
  websocketProxy.attach(proxyServer)
  const proxyPort = await listen(proxyServer)
  t.after(async () => {
    await websocketProxy.close()
    upstreamWebSockets.close()
    proxyServer.close()
    upstreamServer.close()
  })

  const client = new WebSocket(
    `ws://127.0.0.1:${proxyPort}/baton/inference/openai/v1/responses`,
    { headers: { 'OpenAI-Beta': CODEX_RESPONSES_WEBSOCKET_VERSION } },
  )
  await once(client, 'open')
  const request = JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input: 'one' })
  client.send(request)
  await receivedFirstRequest
  const closed = once(client, 'close') as Promise<[number, Buffer]>
  client.send(request)
  client.send(request)
  const [code] = await closed

  assert.equal(code, 1009)
})
