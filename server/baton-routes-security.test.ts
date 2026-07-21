import assert from 'node:assert/strict'
import express from 'express'
import { request, type Server } from 'node:http'
import test from 'node:test'

import { batonRouter } from './baton-routes.ts'

test('client integration mutations require loopback host and an unguessable same-origin capability', async (t) => {
  const app = express()
  app.use(express.raw({ type: () => true }))
  app.use(batonRouter)
  const server = await listen(app)
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`

  const missing = await fetch(`${base}/baton/client-integration/remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"targets":["codex"]}',
  })
  assert.equal(missing.status, 403)

  const capabilityResponse = await fetch(`${base}/baton/client-integration/capability`)
  assert.equal(capabilityResponse.status, 200)
  assert.equal(capabilityResponse.headers.get('cache-control'), 'no-store')
  const { capability } = await capabilityResponse.json() as { capability: string }

  const crossOrigin = await fetch(`${base}/baton/client-integration/remove`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://evil.example',
      'X-Baton-Client-Capability': capability,
    },
    body: '{"targets":["codex"]}',
  })
  assert.equal(crossOrigin.status, 403)

  assert.equal(await rawStatus(base, '/baton/client-integration/capability', 'evil.example'), 403)
})

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function rawStatus(base: string, requestPath: string, host: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const call = request(new URL(requestPath, base), { headers: { Host: host } }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode))
    })
    call.once('error', reject)
    call.end()
  })
}
