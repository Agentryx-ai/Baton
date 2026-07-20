import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NativeAccountCooldowns,
  NativeRouteUnavailableError,
  routeNativeRequest,
} from './native-account-router.ts'

const accounts = [
  { id: 'account-a', priority: 10, enabled: true },
  { id: 'account-b', priority: 20, enabled: true },
  { id: 'account-c', priority: 30, enabled: false },
]

test('native account router retries a quota failure on the next model-capable account', async () => {
  const attempted: string[] = []
  const result = await routeNativeRequest({
    accounts,
    model: 'model-m',
    supportsModel: () => true,
    attempt: async (account) => {
      attempted.push(account.id)
      if (account.id === 'account-a') {
        return {
          value: 'quota-a',
          failure: { kind: 'account_quota', retryable: true, cooldownUntil: 2_000 },
        }
      }
      return { value: 'success-b' }
    },
    now: () => 1_000,
  })

  assert.equal(result.value, 'success-b')
  assert.equal(result.accountId, 'account-b')
  assert.equal(result.exhausted, false)
  assert.deepEqual(attempted, ['account-a', 'account-b'])
})

test('native account router is model-aware and returns a specific unsupported error', async () => {
  const result = await routeNativeRequest({
    accounts,
    model: 'model-m',
    supportsModel: (account) => account.id === 'account-b',
    attempt: async (account) => ({ value: account.id }),
  })
  assert.equal(result.accountId, 'account-b')

  await assert.rejects(
    routeNativeRequest({
      accounts,
      model: 'model-x',
      supportsModel: () => false,
      attempt: async () => ({ value: 'unreachable' }),
    }),
    (error: unknown) => error instanceof NativeRouteUnavailableError
      && error.code === 'model_unsupported'
      && error.message.includes('model-x'),
  )
})

test('native account router preserves the most specific failure after retry exhaustion', async () => {
  const result = await routeNativeRequest({
    accounts,
    model: 'model-m',
    supportsModel: () => true,
    attempt: async (account) => account.id === 'account-a'
      ? { value: 'specific-model-quota', failure: { kind: 'model_quota', retryable: true } }
      : { value: 'generic-5xx', failure: { kind: 'upstream_5xx', retryable: true } },
  })

  assert.equal(result.value, 'specific-model-quota')
  assert.equal(result.accountId, 'account-a')
  assert.equal(result.exhausted, true)
  assert.equal(result.attempts.length, 2)
})

test('native account cooldown excludes only its scope and automatically expires', async () => {
  const cooldowns = new NativeAccountCooldowns()
  cooldowns.mark('account-a', 2_000, 'model-m')
  let now = 1_000
  const route = () => routeNativeRequest({
    accounts,
    model: 'model-m',
    supportsModel: () => true,
    attempt: async (account) => ({ value: account.id }),
    cooldowns,
    now: () => now,
  })

  assert.equal((await route()).accountId, 'account-b')
  now = 2_000
  assert.equal((await route()).accountId, 'account-a')
  assert.equal(cooldowns.isCooling('account-a', 'other-model', 1_000), false)
})

test('native account router never retries a non-retryable failure', async () => {
  let attempts = 0
  const result = await routeNativeRequest({
    accounts,
    model: 'model-m',
    supportsModel: () => true,
    attempt: async () => {
      attempts += 1
      return { value: 'bad-request', failure: { kind: 'fatal', retryable: false } }
    },
  })
  assert.equal(attempts, 1)
  assert.equal(result.value, 'bad-request')
  assert.equal(result.exhausted, true)
})

test('native account router enforces one deadline across all attempts', async () => {
  const keepAlive = setTimeout(() => undefined, 1_000)
  try {
    await assert.rejects(
      routeNativeRequest({
        accounts,
        model: 'model-m',
        supportsModel: () => true,
        deadlineMs: 20,
        attempt: async (_account, signal) => await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
      }),
      (error: unknown) => error instanceof NativeRouteUnavailableError
        && error.code === 'deadline_exceeded',
    )
  } finally {
    clearTimeout(keepAlive)
  }
})

test('native account router selects the lowest-priority enabled account deterministically', async () => {
  const attempted: string[] = []
  const result = await routeNativeRequest({
    accounts: [
      { id: 'later', priority: 20, enabled: true },
      { id: 'disabled-preferred', priority: 0, enabled: false },
      { id: 'preferred', priority: 10, enabled: true },
    ],
    model: 'model-m',
    supportsModel: () => true,
    attempt: async (account) => {
      attempted.push(account.id)
      return { value: account.id }
    },
  })

  assert.equal(result.accountId, 'preferred')
  assert.deepEqual(attempted, ['preferred'])
})

test('native account router reports all accounts disabled without attempting a request', async () => {
  let attempts = 0
  await assert.rejects(routeNativeRequest({
    accounts: [{ id: 'paused', priority: 0, enabled: false }],
    model: 'model-m',
    supportsModel: () => true,
    attempt: async () => {
      attempts += 1
      return { value: 'unreachable' }
    },
  }), (error: unknown) => error instanceof NativeRouteUnavailableError && error.code === 'no_accounts')
  assert.equal(attempts, 0)
})

test('native account router disposes only failed values that are no longer authoritative', async () => {
  const disposed: string[] = []
  const result = await routeNativeRequest({
    accounts,
    model: 'model-m',
    supportsModel: () => true,
    attempt: async (account) => account.id === 'account-a'
      ? { value: 'discarded-429', failure: { kind: 'account_quota', retryable: true } }
      : { value: 'success-b' },
    disposeValue: async (value) => { disposed.push(value) },
  })

  assert.equal(result.value, 'success-b')
  assert.deepEqual(disposed, ['discarded-429'])
})
