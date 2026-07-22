import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import test from 'node:test'

import { reserveTemporaryPort } from './temporary-port-reservation.mjs'

test('temporary port stays bound until the coordinated release boundary', async () => {
  const reservation = await reserveTemporaryPort('test port', 3)
  await assert.rejects(() => listen(reservation.port), (error) => error?.code === 'EADDRINUSE')
  await reservation.release()
  const server = await listen(reservation.port)
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}
