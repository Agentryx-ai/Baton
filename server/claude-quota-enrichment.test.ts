import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildClaudeScopedQuotaWindows,
  createClaudeQuotaEnricher,
  mergeClaudeScopedQuotaWindows,
} from './claude-quota-enrichment.ts'

const resetAt = '2026-07-24T00:00:00.000Z'

describe('Claude scoped quota enrichment', () => {
  it('normalizes current limits[] model windows and ignores aggregate entries', () => {
    const windows = buildClaudeScopedQuotaWindows([
      { kind: 'session', group: 'session', percent: 10, resets_at: resetAt, scope: {} },
      { kind: 'weekly_all', group: 'weekly', percent: 20, resets_at: resetAt, scope: {} },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 37.5,
        resets_at: resetAt,
        is_active: true,
        scope: { model: { display_name: 'Fable' } },
      },
    ])

    assert.deepEqual(windows, [{
      rateLimitType: 'seven_day_fable5',
      label: 'Fable 5',
      status: 'active',
      utilization: 0.375,
      usedPercent: 37.5,
      remainingPercent: 62.5,
      resetAt,
    }])
  })

  it('replaces an existing scoped window without disturbing aggregate windows', () => {
    const quota = {
      success: true,
      windows: [
        { rateLimitType: 'five_hour', usedPercent: 1, remainingPercent: 99, resetAt: null },
        { rateLimitType: 'seven_day_fable5', usedPercent: 2, remainingPercent: 98, resetAt: null },
      ],
    }
    const scoped = buildClaudeScopedQuotaWindows([{
      kind: 'weekly_scoped',
      percent: 40,
      resets_at: resetAt,
      scope: { model: { display_name: 'Fable 5' } },
    }])

    const merged = mergeClaudeScopedQuotaWindows(quota, scoped)
    assert.equal(merged.windows?.length, 2)
    assert.equal(merged.windows?.[0].rateLimitType, 'five_hour')
    assert.equal(merged.windows?.[1].usedPercent, 40)
  })

  it('uses the local management api without exposing its credential and caches discovery', async () => {
    const gatewayPaths: string[] = []
    const managementRequests: Array<{ url: string; authorization: string | null }> = []
    const fetchGateway = async (path: string) => {
      gatewayPaths.push(path)
      if (path.endsWith('/proxy-status')) {
        return { status: 200, body: Buffer.from(JSON.stringify({ running: true, port: 8317 })) }
      }
      return {
        status: 200,
        body: Buffer.from(JSON.stringify({
          managementSecret: { value: 'management-secret', isCustom: true },
        })),
      }
    }
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      managementRequests.push({ url, authorization: headers.get('authorization') })
      if (url.endsWith('/auth-files')) {
        return Response.json({
          files: [{ provider: 'claude', email: 'account@example.com', auth_index: 'auth-1' }],
        })
      }
      return Response.json({
        status_code: 200,
        body: JSON.stringify({
          limits: [{
            kind: 'weekly_scoped',
            percent: 55,
            resets_at: resetAt,
            scope: { model: { display_name: 'Fable' } },
          }],
        }),
      })
    }
    const enrich = createClaudeQuotaEnricher({ fetchGateway, fetchFn })
    const upstream = Buffer.from(JSON.stringify({
      success: true,
      windows: [{ rateLimitType: 'seven_day', usedPercent: 10, remainingPercent: 90, resetAt }],
    }))

    const first = JSON.parse((await enrich('account@example.com', upstream)).toString('utf8'))
    const second = JSON.parse((await enrich('account@example.com', upstream)).toString('utf8'))

    assert.equal(first.windows.length, 2)
    assert.equal(first.windows[1].rateLimitType, 'seven_day_fable5')
    assert.equal(second.windows.length, 2)
    assert.deepEqual(gatewayPaths, [
      '/api/cliproxy/proxy-status',
      '/api/settings/auth/tokens/raw',
    ])
    assert.equal(managementRequests.length, 2)
    assert.ok(managementRequests.every((request) => request.authorization === 'Bearer management-secret'))
    assert.equal(JSON.stringify(first).includes('management-secret'), false)
  })

  it('preserves upstream bytes when management discovery is unavailable', async () => {
    const upstream = Buffer.from('{"success":true,"windows":[]}')
    const enrich = createClaudeQuotaEnricher({
      fetchGateway: async () => ({ status: 503, body: Buffer.from('{}') }),
      fetchFn: async () => {
        throw new Error('must not be called')
      },
    })

    assert.equal(await enrich('account@example.com', upstream), upstream)
  })
})
