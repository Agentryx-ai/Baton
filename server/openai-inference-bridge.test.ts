import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'

import express from 'express'

import { createOpenAiInferenceBridge } from './openai-inference-bridge.ts'

test('OpenAI inference bridge replaces client auth and preserves streaming transport', async (t) => {
  let observedAuthorization = ''
  let observedAccountId = ''
  let observedPath = ''
  let observedBody = ''
  const upstream = createServer((req, res) => {
    observedAuthorization = String(req.headers.authorization ?? '')
    observedAccountId = String(req.headers['chatgpt-account-id'] ?? '')
    observedPath = req.url ?? ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { observedBody += chunk })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'request-1' })
      res.write('data: first\n\n')
      res.end('data: second\n\n')
    })
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  t.after(() => upstream.close())
  const upstreamAddress = upstream.address()
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object')

  const app = express()
  app.use(express.raw({ type: () => true }))
  app.use('/baton/inference/openai/v1', createOpenAiInferenceBridge(async () => ({
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    token: 'proxy-secret',
    models: [],
  })))
  const bridge = app.listen(0, '127.0.0.1')
  await once(bridge, 'listening')
  t.after(() => bridge.close())
  const bridgeAddress = bridge.address()
  assert.ok(bridgeAddress && typeof bridgeAddress === 'object')

  const response = await fetch(
    `http://127.0.0.1:${bridgeAddress.port}/baton/inference/openai/v1/responses?stream=true`,
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer client-secret',
        'chatgpt-account-id': 'client-account',
        'content-type': 'application/json',
      },
      body: '{"model":"gpt-test"}',
    },
  )

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-request-id'), 'request-1')
  assert.equal(await response.text(), 'data: first\n\ndata: second\n\n')
  assert.equal(observedAuthorization, 'Bearer proxy-secret')
  assert.equal(observedAccountId, '')
  assert.equal(observedPath, '/v1/responses?stream=true')
  assert.equal(observedBody, '{"model":"gpt-test"}')
})
