import assert from 'node:assert/strict'
import test from 'node:test'

import { ClaudeQuotaPreflight } from './claude-native-quota.ts'

const credential = { accountId: 'account-a', accessToken: 'secret', scopes: [] }

test('maps a scoped display-name quota to a versioned model without hardcoding Fable', async () => {
  let calls = 0
  const preflight = new ClaudeQuotaPreflight({
    now: () => 1_000,
    fetchImpl: async () => {
      calls += 1
      return Response.json({
        limits: [{
          kind: 'weekly_scoped',
          percent: 100,
          resets_at: '2026-07-21T00:00:00Z',
          is_active: true,
          scope: { model: { id: null, display_name: 'Fable' } },
        }],
      })
    },
  })

  assert.deepEqual(await preflight.check('claude-fable-5', credential), {
    model: 'claude-fable-5',
    displayName: 'Fable 5',
    percent: 100,
    resetsAt: '2026-07-21T00:00:00Z',
  })
  assert.equal(await preflight.check('claude-opus-4-8', credential), null)
  assert.equal(calls, 1)
})

test('matches future scoped models by server model id', async () => {
  const preflight = new ClaudeQuotaPreflight({
    fetchImpl: async () => Response.json({
      limits: [{
        kind: 'weekly_scoped',
        percent: 100,
        is_active: true,
        scope: { model: { id: 'claude-future-7', display_name: 'Future' } },
      }],
    }),
  })
  assert.equal((await preflight.check('claude-future-7', credential))?.displayName, 'Future 7')
})

test('maps native Claude usage limits to the existing account quota UI contract', async () => {
  const preflight = new ClaudeQuotaPreflight({
    now: () => 123_000,
    fetchImpl: async () => new Response(JSON.stringify({
      limits: [
        { kind: 'five_hour', percent: 25, is_active: true, resets_at: '2026-07-20T12:00:00Z' },
        { kind: 'weekly_scoped', percent: 100, is_active: true, scope: { model: { display_name: 'Fable 5' } } },
      ],
    }), { status: 200 }),
  })
  assert.deepEqual(await preflight.accountQuota(credential), {
    success: true,
    accountId: credential.accountId,
    lastUpdated: 123_000,
    windows: [
      {
        rateLimitType: 'five_hour',
        label: 'five hour',
        status: 'active',
        utilization: 0.25,
        usedPercent: 25,
        remainingPercent: 75,
        resetAt: '2026-07-20T12:00:00Z',
      },
      {
        rateLimitType: 'weekly_scoped',
        label: 'Fable 5',
        status: 'exhausted',
        utilization: 1,
        usedPercent: 100,
        remainingPercent: 0,
        resetAt: null,
      },
    ],
  })
})
