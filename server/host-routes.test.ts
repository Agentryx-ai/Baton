import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import test from 'node:test'

import express from 'express'

import { createHostRouter } from './host-routes.ts'
import { NativeFolderPickerError } from './session/native-folder-picker.ts'

test('native folder route requires an explicit non-simple interaction header', async (t) => {
  let calls = 0
  const baseUrl = await start(t, async () => {
    calls += 1
    return 'C:\\workspace'
  })

  const denied = await fetch(`${baseUrl}/baton/host/folders/pick`, { method: 'POST' })
  assert.equal(denied.status, 403)
  assert.equal(calls, 0)

  const selected = await fetch(`${baseUrl}/baton/host/folders/pick`, {
    method: 'POST',
    headers: { 'X-Baton-Interaction': 'native-folder-picker' },
  })
  assert.equal(selected.status, 200)
  assert.deepEqual(await selected.json(), { status: 'selected', cwd: 'C:\\workspace' })
  assert.equal(calls, 1)
})

test('native folder route distinguishes cancellation and typed safe failures', async (t) => {
  const cancelledUrl = await start(t, async () => null)
  const cancelled = await post(cancelledUrl)
  assert.deepEqual(await cancelled.json(), { status: 'cancelled' })

  const unavailableUrl = await start(t, async () => {
    throw new NativeFolderPickerError('picker_unavailable', 'The native folder picker is unavailable')
  })
  const unavailable = await post(unavailableUrl)
  assert.equal(unavailable.status, 503)
  assert.deepEqual(await unavailable.json(), {
    code: 'picker_unavailable',
    error: 'The native folder picker is unavailable',
  })

  const failedUrl = await start(t, async () => { throw new Error('sensitive process detail') })
  const failed = await post(failedUrl)
  assert.equal(failed.status, 500)
  assert.deepEqual(await failed.json(), { code: 'picker_failed', error: 'The native folder picker failed' })
})

test('native folder route forwards an advisory initial directory only from a well-formed body', async (t) => {
  const seen: Array<string | null> = []
  const app = express()
  // Mirror production: bodies arrive as raw Buffers (server/index.ts express.raw).
  app.use(express.raw({ type: () => true, limit: '10mb' }))
  app.use(createHostRouter({ pickFolder: async (initialDirectory) => {
    seen.push(initialDirectory ?? null)
    return 'C:\\workspace'
  } }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  }))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const send = (body?: string) => fetch(`${baseUrl}/baton/host/folders/pick`, {
    method: 'POST',
    headers: {
      'X-Baton-Interaction': 'native-folder-picker',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body }),
  })
  assert.equal((await send(JSON.stringify({ cwd: 'C:\\projects\\demo' }))).status, 200)
  assert.equal((await send()).status, 200)
  assert.equal((await send('not-json')).status, 200)
  assert.equal((await send(JSON.stringify({ cwd: 42 }))).status, 200)
  assert.deepEqual(seen, ['C:\\projects\\demo', null, null, null])
})

async function post(baseUrl: string): Promise<Response> {
  return fetch(`${baseUrl}/baton/host/folders/pick`, {
    method: 'POST',
    headers: { 'X-Baton-Interaction': 'native-folder-picker' },
  })
}

async function start(t: test.TestContext, pickFolder: () => Promise<string | null>): Promise<string> {
  const app = express()
  app.use(createHostRouter({ pickFolder }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  }))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}
