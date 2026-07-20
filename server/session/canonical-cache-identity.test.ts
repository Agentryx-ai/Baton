import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canonicalConversationCacheKey,
  startCanonicalResponsesBridge,
} from './canonical-cache-identity.ts'

test('canonical cache identities are stable per thread, installation-scoped, and pseudonymous', () => {
  const firstInstallation = Buffer.alloc(32, 7)
  const secondInstallation = Buffer.alloc(32, 8)
  const first = canonicalConversationCacheKey(firstInstallation, 'thread-private-alpha')

  assert.equal(first, canonicalConversationCacheKey(firstInstallation, 'thread-private-alpha'))
  assert.notEqual(first, canonicalConversationCacheKey(firstInstallation, 'thread-private-beta'))
  assert.notEqual(first, canonicalConversationCacheKey(secondInstallation, 'thread-private-alpha'))
  assert.match(first, /^baton-th-v1-[A-Za-z0-9_-]{43}$/)
  assert.doesNotMatch(first, /thread|private|alpha/)
})

test('canonical cache identity rejects weak secrets and empty thread IDs', () => {
  assert.throws(
    () => canonicalConversationCacheKey(Buffer.alloc(31), 'thread'),
    /at least 32 bytes/,
  )
  assert.throws(
    () => canonicalConversationCacheKey(Buffer.alloc(32), '  '),
    /requires a thread ID/,
  )
})

test('canonical Responses bridge authenticates locally and deterministically replaces only the cache key', async () => {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
  const bridge = await startCanonicalResponsesBridge({
    upstreamBaseUrl: 'http://127.0.0.1:8317',
    upstreamToken: 'upstream-secret',
    promptCacheKey: 'baton-th-v1-canonical-key',
    allowedToolNames: ['read_file'],
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return new Response('{"ok":true}', {
        status: 201,
        headers: { 'content-type': 'application/json', 'x-upstream': 'yes' },
      })
    },
  })
  try {
    const unauthorized = await fetch(`${bridge.baseUrl}/v1/responses`, {
      method: 'POST',
      body: '{}',
    })
    assert.equal(unauthorized.status, 401)
    assert.equal(calls.length, 0)

    const response = await fetch(`${bridge.baseUrl}/v1/responses?include=usage`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bridge.token}`,
        'content-type': 'application/json',
        'x-client-contract': 'preserved',
      },
      body: JSON.stringify({
        model: 'gpt-test',
        input: [{ role: 'user', content: 'hello' }],
        tools: [
          { type: 'function', name: 'read_file', parameters: { type: 'object' } },
          { type: 'function', name: 'spawn_agent', parameters: { type: 'object' } },
          { type: 'namespace', name: 'collaboration', tools: [] },
          { type: 'web_search' },
        ],
        prompt_cache_key: 'untrusted-native-thread-id',
      }),
    })
    assert.equal(response.status, 201)
    assert.equal(response.headers.get('x-upstream'), 'yes')
    assert.deepEqual(await response.json(), { ok: true })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, 'http://127.0.0.1:8317/v1/responses?include=usage')
    assert.equal(calls[0]?.headers.get('authorization'), 'Bearer upstream-secret')
    assert.equal(calls[0]?.headers.get('x-client-contract'), 'preserved')
    assert.deepEqual(calls[0]?.body, {
      model: 'gpt-test',
      input: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
      prompt_cache_key: 'baton-th-v1-canonical-key',
    })
  } finally {
    await bridge.close()
  }
})

test('canonical Responses bridge preserves an approved loopback proxy base path', async () => {
  let upstreamUrl = ''
  const bridge = await startCanonicalResponsesBridge({
    upstreamBaseUrl: 'http://127.0.0.1:4400/baton/inference/openai',
    upstreamToken: 'upstream-secret',
    promptCacheKey: 'baton-th-v1-native-path',
    allowedToolNames: [],
    fetchImpl: async (url) => {
      upstreamUrl = String(url)
      return Response.json({ ok: true })
    },
  })
  try {
    const response = await fetch(`${bridge.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bridge.token}` },
      body: '{}',
    })
    assert.equal(response.status, 200)
    assert.equal(upstreamUrl, 'http://127.0.0.1:4400/baton/inference/openai/v1/responses')
  } finally {
    await bridge.close()
  }
})

test('canonical Responses bridge has no alternate route or direct fallback', async () => {
  await assert.rejects(
    startCanonicalResponsesBridge({
      upstreamBaseUrl: 'https://api.openai.com',
      upstreamToken: 'must-not-be-used',
      promptCacheKey: 'baton-th-v1-canonical-key',
      allowedToolNames: [],
    }),
    /127\.0\.0\.1 HTTP upstream/,
  )
  let upstreamCalls = 0
  const bridge = await startCanonicalResponsesBridge({
    upstreamBaseUrl: 'http://127.0.0.1:8317',
    upstreamToken: 'upstream-secret',
    promptCacheKey: 'baton-th-v1-canonical-key',
    allowedToolNames: [],
    fetchImpl: async () => {
      upstreamCalls += 1
      throw new Error('proxy unavailable')
    },
  })
  try {
    const missing = await fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bridge.token}` },
      body: '{}',
    })
    assert.equal(missing.status, 404)
    assert.equal(upstreamCalls, 0)

    const failed = await fetch(`${bridge.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bridge.token}` },
      body: '{}',
    })
    assert.equal(failed.status, 502)
    assert.equal(upstreamCalls, 1)
  } finally {
    await bridge.close()
  }
})

test('canonical Responses bridge isolates concurrent turns and aborts in-flight work on close', async () => {
  const seenKeys: string[] = []
  let resolveStarted!: () => void
  const started = new Promise<void>((resolve) => { resolveStarted = resolve })
  let aborted = false
  let calls = 0
  const bridge = await startCanonicalResponsesBridge({
    upstreamBaseUrl: 'http://127.0.0.1:8317',
    upstreamToken: 'upstream-secret',
    promptCacheKey: 'baton-th-v1-shared-thread-key',
    allowedToolNames: [],
    fetchImpl: async (_url, init) => {
      calls += 1
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      seenKeys.push(String(body.prompt_cache_key))
      if (calls === 1) return new Response('{"ok":true}', { status: 200 })
      resolveStarted()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true
          reject(init.signal?.reason ?? new Error('aborted'))
        }, { once: true })
      })
    },
  })

  const completed = await fetch(`${bridge.baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bridge.token}` },
    body: '{"input":"first"}',
  })
  assert.equal(completed.status, 200)

  const inFlight = fetch(`${bridge.baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bridge.token}` },
    body: '{"input":"second"}',
  })
  await started
  await bridge.close()
  await assert.rejects(inFlight)
  assert.equal(aborted, true)
  assert.deepEqual(seenKeys, [
    'baton-th-v1-shared-thread-key',
    'baton-th-v1-shared-thread-key',
  ])
})
