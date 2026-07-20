import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import express from 'express'

import { CLAUDE_NATIVE_PROXY_PATH, createClaudeNativeProxy, responseResetAt } from './claude-native-proxy.ts'
import { ModelFallbackRuntime } from './model-fallback-runtime.ts'
import { NativeProxyHealthTracker } from './native-proxy-health.ts'

const credential = {
  accountId: 'account-a',
  accessToken: 'oauth-secret',
  scopes: ['user:inference'],
}

test('Native Claude cooldown reset parser accepts epoch values, seconds, and HTTP dates', () => {
  const now = Date.parse('2026-07-20T00:00:00.000Z')
  assert.equal(responseResetAt(new Response(null, {
    headers: { 'anthropic-ratelimit-unified-reset': String((now + 10_000) / 1_000) },
  }), now), now + 10_000)
  assert.equal(responseResetAt(new Response(null, {
    headers: { 'retry-after': '15' },
  }), now), now + 15_000)
  assert.equal(responseResetAt(new Response(null, {
    headers: { 'retry-after': new Date(now + 20_000).toUTCString() },
  }), now), now + 20_000)
})

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return address.port
}

test('Native Claude proxy preserves Anthropic SSE transport and replaces client auth', async (t) => {
  const health = new NativeProxyHealthTracker({ provider: 'claude', minimumSamples: 1 })
  let observedAuthorization = ''
  let observedApiKey = ''
  let observedBeta = ''
  let observedBody = ''
  let observedUrl = ''
  const upstream = createServer((req, res) => {
    observedAuthorization = req.headers.authorization ?? ''
    observedApiKey = String(req.headers['x-api-key'] ?? '')
    observedBeta = String(req.headers['anthropic-beta'] ?? '')
    observedUrl = req.url ?? ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { observedBody += chunk })
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'request-id': 'request-native-1',
      })
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n')
      res.write('event: system\ndata: {"type":"system","subtype":"model_refusal_fallback","direction":"retry","original_model":"claude-fable-5","fallback_model":"claude-opus-4-8"}\n\n')
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    })
  })
  t.after(() => upstream.close())
  const upstreamPort = await listen(upstream)

  const app = express()
  app.use(express.raw({ type: () => true }))
  app.use(CLAUDE_NATIVE_PROXY_PATH, createClaudeNativeProxy({
    loadCredential: async () => credential,
    loadClientToken: async () => 'local-secret',
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    health,
  }))
  const proxy = app.listen(0, '127.0.0.1')
  t.after(() => proxy.close())
  await once(proxy, 'listening')
  const address = proxy.address()
  assert.ok(address && typeof address === 'object')

  const body = '{"model":"claude-fable-5","stream":true}'
  const response = await fetch(
    `http://127.0.0.1:${address.port}${CLAUDE_NATIVE_PROXY_PATH}/v1/messages?beta=true`,
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'x-api-key': 'must-not-reach-upstream',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-06-01',
        'content-type': 'application/json',
      },
      body,
    },
  )

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('request-id'), 'request-native-1')
  assert.equal(
    await response.text(),
    'event: message_start\ndata: {"type":"message_start"}\n\n'
      + 'event: system\ndata: {"type":"system","subtype":"model_refusal_fallback","direction":"retry","original_model":"claude-fable-5","fallback_model":"claude-opus-4-8"}\n\n'
      + 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  )
  assert.equal(observedAuthorization, 'Bearer oauth-secret')
  assert.equal(observedApiKey, '')
  assert.equal(observedBeta, 'server-side-fallback-2026-06-01,oauth-2025-04-20')
  assert.equal(observedBody, body)
  assert.equal(observedUrl, '/v1/messages?beta=true')
  assert.equal(health.snapshot().sampleCount, 1)
  assert.equal(health.snapshot().streamFailureRate, 0)
  assert.notEqual(health.snapshot().firstByteP95Ms, null)
})

test('Native Claude proxy keeps the deadline active for an in-progress SSE stream', async (t) => {
  let upstreamClosed: Promise<unknown[]> | undefined
  const upstream = createServer((_req, res) => {
    upstreamClosed = once(res, 'close')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n')
  })
  t.after(() => upstream.close())
  const upstreamPort = await listen(upstream)

  const app = express()
  app.use(express.raw({ type: () => true }))
  app.use(CLAUDE_NATIVE_PROXY_PATH, createClaudeNativeProxy({
    loadCredential: async () => credential,
    loadClientToken: async () => 'local-secret',
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    requestTimeoutMs: 40,
  }))
  const proxy = app.listen(0, '127.0.0.1')
  t.after(() => proxy.close())
  await once(proxy, 'listening')
  const address = proxy.address()
  assert.ok(address && typeof address === 'object')

  const response = await fetch(
    `http://127.0.0.1:${address.port}${CLAUDE_NATIVE_PROXY_PATH}/v1/messages`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: '{"model":"claude-fable-5","stream":true}',
    },
  )
  assert.equal(response.status, 200)
  await assert.rejects(response.text())
  assert.ok(upstreamClosed)
  await upstreamClosed
})

test('Native Claude proxy cancels the upstream SSE stream when the client disconnects', async (t) => {
  let upstreamClosed: Promise<unknown[]> | undefined
  const upstream = createServer((_req, res) => {
    upstreamClosed = once(res, 'close')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n')
  })
  t.after(() => upstream.close())
  const upstreamPort = await listen(upstream)

  const app = express()
  app.use(express.raw({ type: () => true }))
  app.use(CLAUDE_NATIVE_PROXY_PATH, createClaudeNativeProxy({
    loadCredential: async () => credential,
    loadClientToken: async () => 'local-secret',
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
  }))
  const proxy = app.listen(0, '127.0.0.1')
  t.after(() => proxy.close())
  await once(proxy, 'listening')
  const address = proxy.address()
  assert.ok(address && typeof address === 'object')

  const abort = new AbortController()
  const response = await fetch(
    `http://127.0.0.1:${address.port}${CLAUDE_NATIVE_PROXY_PATH}/v1/messages`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: '{"model":"claude-fable-5","stream":true}',
      signal: abort.signal,
    },
  )
  const reader = response.body?.getReader()
  assert.ok(reader)
  const first = await reader.read()
  assert.equal(first.done, false)
  abort.abort()
  await assert.rejects(reader.read())
  assert.ok(upstreamClosed)
  await upstreamClosed
})

test('Native Claude proxy returns the exact model-specific 429 once without retrying', async (t) => {
  let attempts = 0
  const errorBody = JSON.stringify({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: "You've reached your Fable 5 limit.",
      details: { model: 'claude-fable-5', limit_type: 'model' },
    },
  })
  const upstream = createServer((_req, res) => {
    attempts += 1
    res.writeHead(429, {
      'content-type': 'application/json',
      'request-id': 'request-fable-limit',
      'retry-after': '3600',
    })
    res.end(errorBody)
  })
  t.after(() => upstream.close())
  const upstreamPort = await listen(upstream)

  const app = express()
  app.use(express.raw({ type: () => true }))
  app.use(CLAUDE_NATIVE_PROXY_PATH, createClaudeNativeProxy({
    loadCredential: async () => credential,
    loadClientToken: async () => 'local-secret',
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
  }))
  const proxy = app.listen(0, '127.0.0.1')
  t.after(() => proxy.close())
  await once(proxy, 'listening')
  const address = proxy.address()
  assert.ok(address && typeof address === 'object')

  const response = await fetch(
    `http://127.0.0.1:${address.port}${CLAUDE_NATIVE_PROXY_PATH}/v1/messages`,
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
      },
      body: '{"model":"claude-fable-5"}',
    },
  )

  assert.equal(response.status, 429)
  assert.equal(response.headers.get('request-id'), 'request-fable-limit')
  assert.equal(response.headers.get('retry-after'), '3600')
  assert.equal(await response.text(), errorBody)
  assert.equal(attempts, 1)
})

test('Native Claude proxy authenticates local clients and rejects unsupported routes', async (t) => {
  let upstreamCalls = 0
  const app = express()
  app.use(express.raw({ type: () => true }))
  app.use(CLAUDE_NATIVE_PROXY_PATH, createClaudeNativeProxy({
    loadCredential: async () => credential,
    loadClientToken: async () => 'local-secret',
    fetchImpl: async () => {
      upstreamCalls += 1
      return new Response('{}')
    },
  }))
  const proxy = app.listen(0, '127.0.0.1')
  t.after(() => proxy.close())
  await once(proxy, 'listening')
  const address = proxy.address()
  assert.ok(address && typeof address === 'object')
  const root = `http://127.0.0.1:${address.port}${CLAUDE_NATIVE_PROXY_PATH}`

  const unauthorized = await fetch(`${root}/v1/models`)
  assert.equal(unauthorized.status, 401)

  const unknown = await fetch(`${root}/v1/unknown`, {
    headers: { authorization: 'Bearer local-secret' },
  })
  assert.equal(unknown.status, 404)

  const wrongMethod = await fetch(`${root}/v1/models`, {
    method: 'POST',
    headers: { authorization: 'Bearer local-secret' },
  })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.get('allow'), 'GET')

  const nativeOauth = await fetch(`${root}/v1/models`, {
    headers: { authorization: 'Bearer oauth-secret' },
  })
  assert.equal(nativeOauth.status, 200)
  assert.equal(upstreamCalls, 1)
})

test('Native Claude proxy explains an exhausted model before the generic messages 429', async (t) => {
  let upstreamCalls = 0
  const app = express()
  app.use(express.raw({ type: () => true }))
  app.use(CLAUDE_NATIVE_PROXY_PATH, createClaudeNativeProxy({
    loadCredential: async () => credential,
    loadClientToken: async () => 'local-secret',
    checkModelQuota: async (model) => ({
      model,
      displayName: 'Fable 5',
      percent: 100,
      resetsAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    fetchImpl: async () => {
      upstreamCalls += 1
      return Response.json({}, { status: 429 })
    },
  }))
  const proxy = app.listen(0, '127.0.0.1')
  t.after(() => proxy.close())
  await once(proxy, 'listening')
  const address = proxy.address()
  assert.ok(address && typeof address === 'object')

  const response = await fetch(
    `http://127.0.0.1:${address.port}${CLAUDE_NATIVE_PROXY_PATH}/v1/messages`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: '{"model":"claude-fable-5"}',
    },
  )
  const body = await response.json() as Record<string, any>
  assert.equal(response.status, 429)
  assert.equal(
    response.headers.get('anthropic-ratelimit-unified-representative-claim'),
    'seven_day_overage_included',
  )
  assert.match(body.error.message, /Fable 5 limit/)
  assert.equal(body.error.details.model, 'claude-fable-5')
  assert.equal(body.error.details.limit_type, 'model')
  assert.equal(body.error.details.source, 'baton_usage_preflight')
  assert.equal(upstreamCalls, 0)
})

test('Native Claude proxy preserves non-stream JSON, refusal, auth, and upstream failures', async (t) => {
  const cases = [
    {
      name: 'count tokens',
      path: '/v1/messages/count_tokens',
      method: 'POST',
      upstreamStatus: 200,
      upstreamBody: '{"input_tokens":42}',
    },
    {
      name: 'structured refusal',
      path: '/v1/messages',
      method: 'POST',
      upstreamStatus: 200,
      upstreamBody: JSON.stringify({
        type: 'message',
        stop_reason: 'refusal',
        stop_details: { category: 'policy' },
      }),
    },
    {
      name: 'unauthorized upstream',
      path: '/v1/messages',
      method: 'POST',
      upstreamStatus: 401,
      upstreamBody: '{"type":"error","error":{"type":"authentication_error"}}',
    },
    {
      name: 'forbidden upstream',
      path: '/v1/messages',
      method: 'POST',
      upstreamStatus: 403,
      upstreamBody: '{"type":"error","error":{"type":"permission_error"}}',
    },
    {
      name: 'upstream failure',
      path: '/v1/messages',
      method: 'POST',
      upstreamStatus: 500,
      upstreamBody: '{"type":"error","error":{"type":"api_error"}}',
    },
  ] as const
  let current: (typeof cases)[number] = cases[0]
  const app = express()
  app.use(express.raw({ type: () => true }))
  app.use(CLAUDE_NATIVE_PROXY_PATH, createClaudeNativeProxy({
    loadCredential: async () => credential,
    loadClientToken: async () => 'local-secret',
    fetchImpl: async () => new Response(current.upstreamBody, {
      status: current.upstreamStatus,
      headers: { 'content-type': 'application/json', 'request-id': `request-${current.upstreamStatus}` },
    }),
  }))
  const proxy = app.listen(0, '127.0.0.1')
  t.after(() => proxy.close())
  await once(proxy, 'listening')
  const address = proxy.address()
  assert.ok(address && typeof address === 'object')

  for (const scenario of cases) {
    current = scenario
    const response = await fetch(
      `http://127.0.0.1:${address.port}${CLAUDE_NATIVE_PROXY_PATH}${scenario.path}`,
      {
        method: scenario.method,
        headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
        body: '{}',
      },
    )
    assert.equal(response.status, scenario.upstreamStatus, scenario.name)
    assert.equal(response.headers.get('request-id'), `request-${scenario.upstreamStatus}`, scenario.name)
    assert.equal(await response.text(), scenario.upstreamBody, scenario.name)
  }
})

test('Native Claude proxy keeps the requested model and fails over to the next eligible account', async (t) => {
  const attempts: string[] = []
  const app = express()
  app.use(express.raw({ type: () => true }))
  app.use(CLAUDE_NATIVE_PROXY_PATH, createClaudeNativeProxy({
    loadCredentialCandidates: async () => [
      { id: 'account-a', credential },
      { id: 'account-b', credential: { ...credential, accountId: 'account-b', accessToken: 'oauth-second' } },
    ],
    loadClientToken: async () => 'local-secret',
    checkModelQuota: async (_model, candidate) => candidate.accountId === 'account-a'
      ? { model: 'claude-fable-5', displayName: 'Fable 5', percent: 100 }
      : null,
    fetchImpl: async (_input, init) => {
      attempts.push(new Headers(init?.headers).get('authorization') ?? '')
      return new Response('{"type":"message","model":"claude-fable-5"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  }))
  const proxy = app.listen(0, '127.0.0.1')
  t.after(() => proxy.close())
  await once(proxy, 'listening')
  const address = proxy.address()
  assert.ok(address && typeof address === 'object')

  const response = await fetch(`http://127.0.0.1:${address.port}${CLAUDE_NATIVE_PROXY_PATH}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
    body: '{"model":"claude-fable-5","max_tokens":1,"messages":[]}',
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json() as { model: string }).model, 'claude-fable-5')
  assert.deepEqual(attempts, ['Bearer oauth-second'])
})

test('Native Claude proxy retries a pre-stream generic 429 on the next account', async (t) => {
  const attempts: string[] = []
  const app = express()
  app.use(express.raw({ type: () => true }))
  app.use(CLAUDE_NATIVE_PROXY_PATH, createClaudeNativeProxy({
    loadCredentialCandidates: async () => [
      { id: 'account-a', credential },
      { id: 'account-b', credential: { ...credential, accountId: 'account-b', accessToken: 'oauth-second' } },
    ],
    loadClientToken: async () => 'local-secret',
    fetchImpl: async (_input, init) => {
      const authorization = new Headers(init?.headers).get('authorization') ?? ''
      attempts.push(authorization)
      return authorization === 'Bearer oauth-secret'
        ? new Response('{"type":"error","error":{"type":"rate_limit_error","message":"generic"}}', {
            status: 429,
            headers: { 'content-type': 'application/json' },
          })
        : new Response('{"type":"message"}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }))
  const proxy = app.listen(0, '127.0.0.1')
  t.after(() => proxy.close())
  await once(proxy, 'listening')
  const address = proxy.address()
  assert.ok(address && typeof address === 'object')

  const response = await fetch(`http://127.0.0.1:${address.port}${CLAUDE_NATIVE_PROXY_PATH}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
    body: '{"model":"claude-fable-5"}',
  })
  assert.equal(response.status, 200)
  assert.deepEqual(attempts, ['Bearer oauth-secret', 'Bearer oauth-second'])
})

test('Native Claude proxy preserves the most specific model quota after all accounts fail', async (t) => {
  let attempts = 0
  const app = express()
  app.use(express.raw({ type: () => true }))
  app.use(CLAUDE_NATIVE_PROXY_PATH, createClaudeNativeProxy({
    loadCredentialCandidates: async () => [
      { id: 'account-a', credential },
      { id: 'account-b', credential: { ...credential, accountId: 'account-b', accessToken: 'oauth-second' } },
    ],
    loadClientToken: async () => 'local-secret',
    checkModelQuota: async (_model, candidate) => candidate.accountId === 'account-a'
      ? { model: 'claude-fable-5', displayName: 'Fable 5', percent: 100 }
      : null,
    fetchImpl: async () => {
      attempts += 1
      return new Response('{"type":"error","error":{"type":"rate_limit_error","message":"generic"}}', {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
    },
  }))
  const proxy = app.listen(0, '127.0.0.1')
  t.after(() => proxy.close())
  await once(proxy, 'listening')
  const address = proxy.address()
  assert.ok(address && typeof address === 'object')

  const response = await fetch(`http://127.0.0.1:${address.port}${CLAUDE_NATIVE_PROXY_PATH}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
    body: '{"model":"claude-fable-5"}',
  })
  assert.equal(response.status, 429)
  assert.equal((await response.json() as { error: { details: { source: string } } }).error.details.source, 'baton_usage_preflight')
  assert.equal(attempts, 1)
})

test('Native Claude proxy fails over after a pre-stream network error', async (t) => {
  let attempts = 0
  const app = express()
  app.use(express.raw({ type: () => true }))
  app.use(CLAUDE_NATIVE_PROXY_PATH, createClaudeNativeProxy({
    loadCredentialCandidates: async () => [
      { id: 'account-a', credential },
      { id: 'account-b', credential: { ...credential, accountId: 'account-b', accessToken: 'oauth-second' } },
    ],
    loadClientToken: async () => 'local-secret',
    fetchImpl: async () => {
      attempts += 1
      if (attempts === 1) throw new TypeError('simulated network failure containing private detail')
      return Response.json({ type: 'message' })
    },
  }))
  const proxy = app.listen(0, '127.0.0.1')
  t.after(() => proxy.close())
  await once(proxy, 'listening')
  const address = proxy.address()
  assert.ok(address && typeof address === 'object')

  const response = await fetch(`http://127.0.0.1:${address.port}${CLAUDE_NATIVE_PROXY_PATH}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
    body: '{"model":"claude-fable-5"}',
  })
  assert.equal(response.status, 200)
  assert.equal(attempts, 2)
  assert.doesNotMatch(await response.text(), /private detail/)
})

test('Native Claude proxy applies the router retry deadline to an in-flight fetch', async (t) => {
  const app = express()
  app.use(express.raw({ type: () => true }))
  app.use(CLAUDE_NATIVE_PROXY_PATH, createClaudeNativeProxy({
    loadCredential: async () => credential,
    loadClientToken: async () => 'local-secret',
    retryDeadlineMs: 20,
    requestTimeoutMs: 1_000,
    fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }),
  }))
  const proxy = app.listen(0, '127.0.0.1')
  t.after(() => proxy.close())
  await once(proxy, 'listening')
  const address = proxy.address()
  assert.ok(address && typeof address === 'object')

  const startedAt = Date.now()
  const response = await fetch(`http://127.0.0.1:${address.port}${CLAUDE_NATIVE_PROXY_PATH}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
    body: '{"model":"claude-fable-5"}',
  })
  assert.equal(response.status, 503)
  assert.equal((await response.json() as { error: { type: string } }).error.type, 'baton_claude_deadline_exceeded')
  assert.ok(Date.now() - startedAt < 500)
})

test('Native Claude proxy falls back only after every source-model account is exhausted and auto-recovers', async (t) => {
  let now = 1_000
  let sourceExhausted = true
  const observedModels: string[] = []
  const runtime = new ModelFallbackRuntime({
    filePath: path.join(mkdtempSync(path.join(tmpdir(), 'baton-proxy-fallback-')), 'state.json'),
    now: () => now,
    probeIntervalMs: 60_000,
  })
  const app = express()
  app.use(express.raw({ type: () => true }))
  app.use(CLAUDE_NATIVE_PROXY_PATH, createClaudeNativeProxy({
    loadCredentialCandidates: async () => [
      { id: 'account-a', credential },
      { id: 'account-b', credential: { ...credential, accountId: 'account-b', accessToken: 'oauth-second' } },
    ],
    loadClientToken: async () => 'local-secret',
    modelFallback: runtime,
    now: () => now,
    checkModelQuota: async (requestedModel) => (
      requestedModel === 'claude-fable-5' && sourceExhausted
        ? { model: requestedModel, displayName: 'Fable 5', percent: 100 }
        : null
    ),
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string }
      observedModels.push(body.model)
      return Response.json({ type: 'message', model: body.model })
    },
  }))
  const proxy = app.listen(0, '127.0.0.1')
  t.after(() => proxy.close())
  await once(proxy, 'listening')
  const address = proxy.address()
  assert.ok(address && typeof address === 'object')
  const send = () => fetch(`http://127.0.0.1:${address.port}${CLAUDE_NATIVE_PROXY_PATH}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
    body: '{"model":"claude-fable-5","messages":[]}',
  })

  const disabled = await send()
  assert.equal(disabled.status, 429)
  assert.deepEqual(observedModels, [], 'OFF must not spend fallback-model quota')
  assert.equal(runtime.status().events.at(-1)?.type, 'available')

  runtime.update({ enabled: true })
  const switched = await send()
  assert.equal(switched.status, 200)
  assert.equal((await switched.json() as { model: string }).model, 'claude-opus-4-8')
  assert.deepEqual(observedModels, ['claude-opus-4-8'])
  assert.deepEqual(runtime.status().active.map(({ preferredModel, effectiveModel }) => ({
    preferredModel, effectiveModel,
  })), [{ preferredModel: 'claude-fable-5', effectiveModel: 'claude-opus-4-8' }])
  assert.equal(runtime.status().active[0]?.accountAlias, 'account-a')

  now += 1_000
  const sticky = await send()
  assert.equal(sticky.status, 200)
  assert.deepEqual(observedModels, ['claude-opus-4-8', 'claude-opus-4-8'])

  sourceExhausted = false
  now += 60_000
  const recovered = await send()
  assert.equal(recovered.status, 200)
  assert.equal((await recovered.json() as { model: string }).model, 'claude-fable-5')
  assert.equal(runtime.status().active.length, 0)
  assert.equal(runtime.status().events.at(-1)?.type, 'recovered')
})

test('Native Claude proxy delegates safety fallback once to the server and preserves its SSE event', async (t) => {
  let observedBody: unknown
  let observedBeta = ''
  const runtime = new ModelFallbackRuntime({
    filePath: path.join(mkdtempSync(path.join(tmpdir(), 'baton-safety-fallback-')), 'state.json'),
  })
  runtime.update({ enabled: true })
  const event = 'event: system\ndata: {"type":"system","subtype":"model_refusal_fallback","direction":"retry","original_model":"claude-fable-5","fallback_model":"claude-opus-4-8","category":"policy"}\n\n'
  const app = express()
  app.use(express.raw({ type: () => true }))
  app.use(CLAUDE_NATIVE_PROXY_PATH, createClaudeNativeProxy({
    loadCredential: async () => credential,
    loadClientToken: async () => 'local-secret',
    modelFallback: runtime,
    fetchImpl: async (_input, init) => {
      observedBody = JSON.parse(String(init?.body))
      observedBeta = new Headers(init?.headers).get('anthropic-beta') ?? ''
      return new Response(event, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  }))
  const proxy = app.listen(0, '127.0.0.1')
  t.after(() => proxy.close())
  await once(proxy, 'listening')
  const address = proxy.address()
  assert.ok(address && typeof address === 'object')

  const response = await fetch(`http://127.0.0.1:${address.port}${CLAUDE_NATIVE_PROXY_PATH}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
    body: '{"model":"claude-fable-5","stream":true}',
  })
  assert.equal(await response.text(), event)
  assert.deepEqual(observedBody, {
    model: 'claude-fable-5',
    stream: true,
    fallbacks: [{ model: 'claude-opus-4-8' }],
  })
  assert.match(observedBeta, /server-side-fallback-2026-06-01/)
  const recorded = runtime.status().events.at(-1)
  assert.equal(recorded?.type, 'server_event')
  assert.equal(recorded?.direction, 'retry')
  assert.equal(recorded?.category, 'policy')
})
