import assert from 'node:assert/strict'
import test from 'node:test'

import { client } from '../src/api/client.ts'

test('routing settings use the installed CCS PUT contracts', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; method: string | undefined; body: unknown }> = []
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return Response.json({ success: true })
  }) as typeof fetch

  try {
    await client.setRoutingStrategy('fill-first')
    await client.setSessionAffinity(true, '2h')
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.deepEqual(calls, [
    {
      url: '/api/cliproxy/routing/strategy',
      method: 'PUT',
      body: { value: 'fill-first' },
    },
    {
      url: '/api/cliproxy/routing/session-affinity',
      method: 'PUT',
      body: { enabled: true, ttl: '2h' },
    },
  ])
})
