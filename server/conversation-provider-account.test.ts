import assert from 'node:assert/strict'
import test from 'node:test'

import type { Account, PolicyState } from '../src/api/types.ts'
import {
  providerAccountLabel,
  summarizeProviderAccounts,
} from '../src/features/conversations/provider-account-summary.ts'

function account(id: string, overrides: Partial<Account> = {}): Account {
  return {
    id,
    provider: 'codex',
    isDefault: false,
    email: `${id}@example.com`,
    nickname: id,
    paused: false,
    ...overrides,
  }
}

const policy: PolicyState = {
  enabled: true,
  policy: 'reset-imminent-first',
  tickSeconds: 60,
  providers: [{ provider: 'codex', target: 'primary', reserve: 'reserve', enginePaused: [] }],
  log: [],
  lastTickAt: null,
}

test('provider account summary distinguishes active pool, policy priority, and recent actual use', () => {
  const summary = summarizeProviderAccounts('codex', {
    codex: [
      account('primary', { lastUsedAt: '2026-07-18T09:00:00.000Z' }),
      account('reserve', { lastUsedAt: '2026-07-18T10:00:00.000Z' }),
      account('paused', { paused: true, lastUsedAt: 'invalid' }),
    ],
  }, policy, 'round-robin')

  assert.equal(summary.triggerLabel, '계정 2개')
  assert.deepEqual(summary.activeAccounts.map((item) => item.id), ['primary', 'reserve'])
  assert.equal(summary.targetAccount?.id, 'primary')
  assert.equal(summary.reserveAccount?.id, 'reserve')
  assert.equal(summary.recentAccount?.id, 'reserve')
})

test('a sole active account is named directly and disabled policy is not presented as routing truth', () => {
  const summary = summarizeProviderAccounts('claude', {
    claude: [account('only', { provider: 'claude', nickname: '', email: 'only@example.com' })],
  }, { ...policy, enabled: false }, 'fill-first')

  assert.equal(summary.triggerLabel, 'only@example.com')
  assert.equal(summary.targetAccount, null)
  assert.equal(summary.reserveAccount, null)
  assert.equal(providerAccountLabel(summary.activeAccounts[0]), 'only@example.com')
})

test('account loading is not misreported as an empty routing pool', () => {
  const summary = summarizeProviderAccounts('gemini', null, null, null)

  assert.equal(summary.isLoading, true)
  assert.equal(summary.triggerLabel, '계정 확인 중')
})
