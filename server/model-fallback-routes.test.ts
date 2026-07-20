import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import express from 'express'

import { createModelFallbackRouter } from './model-fallback-routes.ts'
import { ModelFallbackRuntime } from './model-fallback-runtime.ts'

test('model fallback control plane is opt-in, persists dismissal, and clears overrides on disable', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-fallback-routes-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const runtime = new ModelFallbackRuntime({
    filePath: path.join(directory, 'state.json'),
    now: () => 1_000,
  })
  const app = express()
  app.use(express.raw({ type: () => true }))
  app.use('/baton/model-fallback', createModelFallbackRouter(runtime))
  const server = app.listen(0, '127.0.0.1')
  t.after(() => server.close())
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}/baton/model-fallback`

  const initial = await fetch(url).then((response) => response.json()) as { enabled: boolean }
  assert.equal(initial.enabled, false)

  const invalid = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userMappings: { source: [42] } }),
  })
  assert.equal(invalid.status, 400)
  const oversized = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      userMappings: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`source-${index}`, ['fallback']])),
    }),
  })
  assert.equal(oversized.status, 400)

  const enabled = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enabled: true,
      promptDismissed: false,
      userMappings: { source: ['fallback'] },
    }),
  }).then((response) => response.json()) as { enabled: boolean; promptDismissed: boolean }
  assert.equal(enabled.enabled, true)
  assert.equal(enabled.promptDismissed, false)

  runtime.controller.noteExhausted('source')
  runtime.persist()
  assert.deepEqual(runtime.controller.requestModel('source'), { model: 'fallback', probing: false })

  const disabled = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false, promptDismissed: true }),
  }).then((response) => response.json()) as {
    enabled: boolean
    promptDismissed: boolean
    active: unknown[]
    events: Array<{ type: string }>
  }
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.promptDismissed, true)
  assert.deepEqual(disabled.active, [])
  assert.equal(disabled.events.at(-1)?.type, 'disabled')
  assert.deepEqual(runtime.controller.requestModel('source'), { model: 'source', probing: false })

  const restarted = new ModelFallbackRuntime({ filePath: path.join(directory, 'state.json') })
  assert.equal(restarted.status().promptDismissed, true)
  assert.deepEqual(restarted.status().active, [])
})
