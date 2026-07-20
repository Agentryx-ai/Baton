import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'

import express from 'express'

import { createCodexNativeProxy } from './codex-native-proxy.ts'
import type { CodexNativeProxyAccount } from './codex-native-proxy.ts'
import { NativeProxyHealthTracker } from './native-proxy-health.ts'

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
  models: string[],
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

test('Native Codex proxy retries an actual 429 on the next model-capable account', async (t) => {
  const authorizations: string[] = []
  const workspaces: string[] = []
  let body = ''
  const upstream = createServer((req, res) => {
    authorizations.push(req.headers.authorization ?? '')
    workspaces.push(String(req.headers['chatgpt-account-id'] ?? ''))
    req.setEncoding('utf8')
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      if (req.headers.authorization === 'Bearer access-a') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' })
        res.end(JSON.stringify({ error: { type: 'usage_limit_reached' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'codex-b' })
      res.end('data: {"type":"response.completed","response":{"status":"completed"}}\n\n')
    })
  })
  t.after(() => upstream.close())
  const upstreamPort = await listen(upstream)

  const accounts = [
    account('a', 10, 'access-a', ['gpt-5.6-sol']),
    account('b', 20, 'access-b', ['gpt-5.6-sol']),
  ]
  const app = express()
  app.use(express.raw({ type: () => true }))
  app.use('/native', createCodexNativeProxy({
    loadAccounts: async () => accounts,
    loadClientToken: async () => 'local-token',
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    now: () => 1_000,
  }))
  const proxy = app.listen(0, '127.0.0.1')
  t.after(() => proxy.close())
  await once(proxy, 'listening')
  const address = proxy.address()
  assert.ok(address && typeof address === 'object')

  const requestBody = JSON.stringify({ model: 'gpt-5.6-sol', input: 'Hi', stream: true })
  const response = await fetch(`http://127.0.0.1:${address.port}/native/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
    body: requestBody,
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-request-id'), 'codex-b')
  assert.match(await response.text(), /response\.completed/)
  assert.deepEqual(authorizations, ['Bearer access-a', 'Bearer access-b'])
  assert.deepEqual(workspaces, ['workspace-a', 'workspace-b'])
  assert.equal(body, requestBody + requestBody)

  const second = await fetch(`http://127.0.0.1:${address.port}/native/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
    body: requestBody,
  })
  assert.equal(second.status, 200)
  await second.text()
  assert.deepEqual(authorizations, ['Bearer access-a', 'Bearer access-b', 'Bearer access-b'])
})

test('Native Codex proxy preserves the pinned model catalog and fails clearly when unsupported', async (t) => {
  let upstreamCalls = 0
  const health = new NativeProxyHealthTracker({ provider: 'codex', minimumSamples: 1 })
  const app = express()
  app.use(express.raw({ type: () => true }))
  app.use('/native', createCodexNativeProxy({
    loadAccounts: async () => [
      account('free', 20, 'free-access', ['gpt-5.6-terra']),
      account('pro', 10, 'pro-access', ['gpt-5.6-sol', 'gpt-5.6-terra']),
    ],
    loadClientToken: async () => 'local-token',
    fetchImpl: async () => {
      upstreamCalls += 1
      return Response.json({ status: 'completed' })
    },
    health,
  }))
  const proxy = app.listen(0, '127.0.0.1')
  t.after(() => proxy.close())
  await once(proxy, 'listening')
  const address = proxy.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}/native`

  const models = await fetch(`${base}/models`, {
    headers: { authorization: 'Bearer local-token' },
  }).then(async (response) => response.json()) as { data: Array<{ id: string }> }
  assert.deepEqual(models.data.map((model) => model.id), ['gpt-5.6-sol', 'gpt-5.6-terra'])

  const unsupported = await fetch(`${base}/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-unknown' }),
  })
  assert.equal(unsupported.status, 422)
  assert.deepEqual(await unsupported.json(), {
    error: {
      type: 'baton_codex_model_unsupported',
      message: '요청 모델 gpt-unknown을 지원하는 native account가 없습니다.',
      model: 'gpt-unknown',
    },
  })
  assert.equal(upstreamCalls, 0)
  const supported = await fetch(`${base}/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'Hi' }),
  })
  assert.equal(supported.status, 200)
  await supported.text()
  assert.equal(upstreamCalls, 1)
  assert.equal(health.snapshot().sampleCount, 1)
  assert.equal(health.snapshot().errorRate, 0)
})
