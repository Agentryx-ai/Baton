import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { performance } from 'node:perf_hooks'
import { zstdCompressSync } from 'node:zlib'
import test from 'node:test'

import express from 'express'

import { createCodexNativeProxy } from './codex-native-proxy.ts'
import type { CodexNativeProxyAccount } from './codex-native-proxy.ts'
import { createRawPassthroughBody } from './raw-passthrough-body.ts'

const account: CodexNativeProxyAccount = {
  id: 'event-loop-account',
  priority: 10,
  enabled: true,
  models: ['gpt-5.6-sol'],
  credential: {
    accountId: 'event-loop-account',
    accessToken: 'test-access',
    chatgptAccountId: 'test-workspace',
  },
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return address.port
}

test('Native Codex proxy reads only the root model field', async (t) => {
  let upstreamCalls = 0
  const app = express()
  app.use('/native', createRawPassthroughBody(), createCodexNativeProxy({
    loadAccounts: async () => [account],
    trustLoopbackClient: true,
    fetchImpl: async () => {
      upstreamCalls += 1
      return Response.json({ status: 'completed' })
    },
  }))
  const proxy = app.listen(0, '127.0.0.1')
  t.after(() => proxy.close())
  await once(proxy, 'listening')
  const address = proxy.address()
  assert.ok(address && typeof address === 'object')

  const response = await fetch(`http://127.0.0.1:${address.port}/native/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ metadata: { model: 'nested-wrong-model' }, model: 'gpt-5.6-sol', input: 'Hi' }),
  })
  assert.equal(response.status, 200)
  assert.equal(upstreamCalls, 1)
})

test('large concurrent zstd requests do not starve a health handler', async (t) => {
  const concurrency = 12
  let enteredRequests = 0
  let markAllEntered: (() => void) | undefined
  const allEntered = new Promise<void>((resolve) => { markAllEntered = resolve })
  const upstream = createServer((req, res) => {
    req.resume()
    req.once('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"status":"completed"}')
    })
  })
  t.after(() => upstream.close())
  const upstreamPort = await listen(upstream)

  const app = express()
  app.get('/health', (_req, res) => res.json({ ok: true }))
  app.use('/native', createRawPassthroughBody(), createCodexNativeProxy({
    loadAccounts: async () => {
      enteredRequests += 1
      if (enteredRequests === concurrency) markAllEntered?.()
      return [account]
    },
    trustLoopbackClient: true,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
  }))
  const proxy = app.listen(0, '127.0.0.1')
  t.after(() => proxy.close())
  await once(proxy, 'listening')
  const address = proxy.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`

  const source = Buffer.from(JSON.stringify({
    model: 'gpt-5.6-sol',
    input: 'resume-context-'.repeat(350_000),
  }))
  const compressed = zstdCompressSync(source)
  const flood = Array.from({ length: concurrency }, () => fetch(`${baseUrl}/native/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-encoding': 'zstd' },
    body: compressed,
  }))

  await allEntered
  const started = performance.now()
  const health = await fetch(`${baseUrl}/health`)
  const healthLatencyMs = performance.now() - started
  t.diagnostic(`health latency under ${concurrency} concurrent ${source.length}-byte resume bodies: ${healthLatencyMs.toFixed(1)}ms`)
  assert.equal(health.status, 200)
  assert.ok(healthLatencyMs < 1_000, `health was starved for ${healthLatencyMs.toFixed(1)}ms`)

  const responses = await Promise.all(flood)
  assert.ok(responses.every((response) => response.status === 200))
})
