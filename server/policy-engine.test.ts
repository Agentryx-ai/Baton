import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { isSuccessfulHttpStatus, type AccountQuota, type GatewayAccount } from './gateway-client.ts'
import {
  PolicyEngine,
  selectTargetAndReserve,
  type PolicyEngineDependencies,
} from './policy-engine.ts'

function account(id: string): GatewayAccount {
  return {
    id,
    provider: 'claude',
    isDefault: false,
    email: `${id}@example.com`,
    nickname: id,
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

test('selectTargetAndReserve supports zero, one, and multiple ranked accounts', () => {
  const first = account('first')
  const second = account('second')
  const third = account('third')

  assert.deepEqual(selectTargetAndReserve([]), { target: null, reserve: null })
  assert.deepEqual(selectTargetAndReserve([first]), { target: first, reserve: null })
  assert.deepEqual(selectTargetAndReserve([first, second, third]), {
    target: first,
    reserve: second,
  })
})

test('routing acknowledgements accept only HTTP 2xx', () => {
  assert.equal(isSuccessfulHttpStatus(199), false)
  assert.equal(isSuccessfulHttpStatus(200), true)
  assert.equal(isSuccessfulHttpStatus(299), true)
  assert.equal(isSuccessfulHttpStatus(300), false)
  assert.equal(isSuccessfulHttpStatus(302), false)
  assert.equal(isSuccessfulHttpStatus(400), false)
})

function quota(accountId: string, usedPercent: number, resetAt: string): AccountQuota {
  return {
    success: true,
    accountId,
    lastUpdated: Date.now(),
    windows: [{
      rateLimitType: 'five_hour',
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      resetAt,
    }],
  }
}

test('98% and 100% accounts remain rankable and the full active pool stays available for failover', async () => {
  const first = account('first-98')
  const second = account('second-100')
  const third = account('third-20')
  const manuallyPaused = { ...account('manual'), paused: true }
  const accounts = [first, second, third, manuallyPaused]
  const quotas = new Map([
    [first.id, quota(first.id, 98, '2026-07-19T01:00:00.000Z')],
    [second.id, quota(second.id, 100, '2026-07-19T02:00:00.000Z')],
    [third.id, quota(third.id, 20, '2026-07-19T03:00:00.000Z')],
    [manuallyPaused.id, quota(manuallyPaused.id, 0, '2026-07-19T00:00:00.000Z')],
  ])
  const events: string[] = []
  const resumeCalls: string[] = []
  const dependencies: PolicyEngineDependencies = {
    ensureFillFirstRouting: async () => { events.push('fill-first') },
    getAccounts: async (provider) => {
      events.push(`accounts:${provider}`)
      return provider === 'claude' ? accounts : []
    },
    getQuota: async (_provider, accountId) => quotas.get(accountId)!,
    resumeAccount: async (_provider, accountId) => { resumeCalls.push(accountId) },
  }
  const engine = new PolicyEngine(dependencies, { statePath: null, tickMs: 60_000 })

  await engine.setEnabled(true)
  engine.stop()

  assert.equal(events[0], 'fill-first', 'routing must be established before account evaluation')
  assert.deepEqual(resumeCalls, [], 'manual pauses and active pool members must be untouched')
  assert.deepEqual(
    engine.getState().providers.find((state) => state.provider === 'claude'),
    {
      provider: 'claude',
      target: first.id,
      reserve: second.id,
      enginePaused: [],
    },
  )
  assert.ok(events.includes('accounts:codex'), 'provider evaluation still runs independently')
})

test('manual pause is never resumed or selected', async () => {
  const paused = { ...account('manual'), paused: true }
  const active = account('active')
  const resumed: string[] = []
  const dependencies: PolicyEngineDependencies = {
    ensureFillFirstRouting: async () => {},
    getAccounts: async (provider) => provider === 'claude' ? [paused, active] : [],
    getQuota: async (_provider, accountId) => quota(
      accountId,
      0,
      accountId === paused.id ? '2026-07-19T00:00:00.000Z' : '2026-07-19T01:00:00.000Z',
    ),
    resumeAccount: async (_provider, accountId) => { resumed.push(accountId) },
  }
  const engine = new PolicyEngine(dependencies, { statePath: null })

  await engine.setEnabled(true)
  engine.stop()

  assert.deepEqual(resumed, [])
  assert.equal(
    engine.getState().providers.find((state) => state.provider === 'claude')?.target,
    active.id,
  )
})

test('legacy engine pause is released without touching a manual pause, restoring third-account failover', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-policy-pool-'))
  const statePath = join(directory, 'state.json')
  const first = account('first')
  const second = account('second')
  const third = { ...account('third'), paused: true }
  const manual = { ...account('manual'), paused: true }
  writeFileSync(statePath, JSON.stringify({
    enabled: false,
    enginePaused: { claude: [third.id] },
  }), 'utf8')
  const resumed: string[] = []
  const dependencies: PolicyEngineDependencies = {
    ensureFillFirstRouting: async () => {},
    getAccounts: async (provider) => provider === 'claude' ? [first, second, third, manual] : [],
    getQuota: async (_provider, accountId) => quota(accountId, 0, '2026-07-19T01:00:00.000Z'),
    resumeAccount: async (_provider, accountId) => { resumed.push(accountId) },
  }

  try {
    const engine = new PolicyEngine(dependencies, { statePath })
    await engine.setEnabled(true)
    engine.stop()

    assert.deepEqual(resumed, [third.id])
    assert.deepEqual(
      engine.getState().providers.find((state) => state.provider === 'claude')?.enginePaused,
      [],
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('routing contract failure leaves the engine disabled and does not evaluate accounts', async () => {
  let accountReads = 0
  const contractError = new Error('routing contract unavailable')
  const dependencies: PolicyEngineDependencies = {
    ensureFillFirstRouting: async () => { throw contractError },
    getAccounts: async () => { accountReads += 1; return [] },
    getQuota: async () => { throw new Error('unreachable') },
    resumeAccount: async () => { throw new Error('unreachable') },
  }
  const engine = new PolicyEngine(dependencies, { statePath: null })

  await assert.rejects(engine.setEnabled(true), contractError)

  assert.equal(engine.getState().enabled, false)
  assert.equal(accountReads, 0)
  assert.match(engine.getState().log.at(-1)?.reason ?? '', /fill-first routing prerequisite failed/)
})

test('restored enabled state also fails closed before its startup tick', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-policy-'))
  const statePath = join(directory, 'state.json')
  writeFileSync(statePath, JSON.stringify({ enabled: true, enginePaused: {} }), 'utf8')
  let accountReads = 0
  const dependencies: PolicyEngineDependencies = {
    ensureFillFirstRouting: async () => { throw new Error('routing unavailable') },
    getAccounts: async () => { accountReads += 1; return [] },
    getQuota: async () => { throw new Error('unreachable') },
    resumeAccount: async () => { throw new Error('unreachable') },
  }

  try {
    const engine = new PolicyEngine(dependencies, { statePath })
    engine.startIfEnabled()
    await new Promise<void>((resolve) => setImmediate(resolve))

    assert.equal(engine.getState().enabled, false)
    assert.equal(accountReads, 0)
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).enabled, false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('OFF persists a recovery journal before releasing legacy engine pauses', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-policy-off-journal-'))
  const statePath = join(directory, 'state.json')
  const legacy = { ...account('legacy'), paused: true }
  writeFileSync(statePath, JSON.stringify({
    enabled: true,
    enginePaused: { claude: [legacy.id] },
  }), 'utf8')
  const resumeStarted = deferred()
  const allowResume = deferred()
  const dependencies: PolicyEngineDependencies = {
    ensureFillFirstRouting: async () => {},
    getAccounts: async (provider) => provider === 'claude' ? [legacy] : [],
    getQuota: async () => { throw new Error('unreachable') },
    resumeAccount: async () => {
      resumeStarted.resolve()
      await allowResume.promise
    },
  }

  try {
    const engine = new PolicyEngine(dependencies, { statePath })
    const disabling = engine.setEnabled(false)
    await resumeStarted.promise

    assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), {
      enabled: false,
      enginePaused: { claude: [legacy.id], codex: [] },
      recoveryPending: true,
    })

    allowResume.resolve()
    await disabling
    assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), {
      enabled: false,
      enginePaused: { claude: [], codex: [] },
      recoveryPending: false,
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('startup recovers an interrupted OFF journal even when persisted enabled is false', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-policy-off-recovery-'))
  const statePath = join(directory, 'state.json')
  const legacy = { ...account('legacy'), paused: true }
  writeFileSync(statePath, JSON.stringify({
    enabled: false,
    enginePaused: { claude: [legacy.id] },
  }), 'utf8')
  const resumed: string[] = []
  let prerequisites = 0
  const dependencies: PolicyEngineDependencies = {
    ensureFillFirstRouting: async () => { prerequisites += 1 },
    getAccounts: async (provider) => provider === 'claude' ? [legacy] : [],
    getQuota: async () => { throw new Error('unreachable') },
    resumeAccount: async (_provider, accountId) => { resumed.push(accountId) },
  }

  try {
    const engine = new PolicyEngine(dependencies, { statePath })
    engine.startIfEnabled()
    for (let attempt = 0; attempt < 100 && resumed.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }

    assert.deepEqual(resumed, [legacy.id])
    assert.equal(prerequisites, 0, 'OFF recovery must not start policy routing')
    assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), {
      enabled: false,
      enginePaused: { claude: [], codex: [] },
      recoveryPending: false,
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('overlapping enable then disable transitions preserve the last user intent', async () => {
  const gate = deferred()
  let prerequisites = 0
  const dependencies: PolicyEngineDependencies = {
    ensureFillFirstRouting: async () => {
      prerequisites += 1
      await gate.promise
    },
    getAccounts: async () => [],
    getQuota: async () => { throw new Error('unreachable') },
    resumeAccount: async () => { throw new Error('unreachable') },
  }
  const engine = new PolicyEngine(dependencies, { statePath: null, tickMs: 60_000 })

  const enabling = engine.setEnabled(true)
  for (let attempt = 0; attempt < 100 && prerequisites === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  const disabling = engine.setEnabled(false)
  gate.resolve()
  await Promise.all([enabling, disabling])

  assert.equal(prerequisites, 1)
  assert.equal(engine.getState().enabled, false)
})

test('a lost periodic fill-first prerequisite turns the policy off before account evaluation', async () => {
  let prerequisites = 0
  let accountReads = 0
  const dependencies: PolicyEngineDependencies = {
    ensureFillFirstRouting: async () => {
      prerequisites += 1
      if (prerequisites > 1) throw new Error('routing drift')
    },
    getAccounts: async () => { accountReads += 1; return [] },
    getQuota: async () => { throw new Error('unreachable') },
    resumeAccount: async () => { throw new Error('unreachable') },
  }
  const engine = new PolicyEngine(dependencies, { statePath: null, tickMs: 1 })

  await engine.setEnabled(true)
  for (let attempt = 0; attempt < 100 && engine.getState().enabled; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }

  assert.equal(engine.getState().enabled, false)
  assert.equal(accountReads, 2, 'only the initial Claude/Codex evaluation may run')
  assert.match(engine.getState().log.at(-1)?.reason ?? '', /prerequisite lost/)
})

for (const oldResult of ['resolve', 'reject'] as const) {
  test(`a stale periodic routing ${oldResult} cannot overwrite a newer OFF then ON transition`, async () => {
    const oldTick = deferred()
    const oldTickStarted = deferred()
    let prerequisites = 0
    let accountReads = 0
    const dependencies: PolicyEngineDependencies = {
      ensureFillFirstRouting: async () => {
        prerequisites += 1
        if (prerequisites === 2) {
          oldTickStarted.resolve()
          await oldTick.promise
        }
      },
      getAccounts: async () => { accountReads += 1; return [] },
      getQuota: async () => { throw new Error('unreachable') },
      resumeAccount: async () => { throw new Error('unreachable') },
    }
    const engine = new PolicyEngine(dependencies, { statePath: null, tickMs: 1 })

    await engine.setEnabled(true)
    await oldTickStarted.promise
    await engine.setEnabled(false)
    await engine.setEnabled(true)
    engine.stop()

    if (oldResult === 'resolve') oldTick.resolve()
    else oldTick.reject(new Error('stale routing failure'))
    for (let attempt = 0; attempt < 100 && prerequisites < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    await new Promise<void>((resolve) => setImmediate(resolve))

    assert.equal(prerequisites, 3)
    assert.equal(engine.getState().enabled, true)
    assert.equal(accountReads, 2, 'the stale periodic tick must not evaluate providers')
  })
}

test('a stale provider read cannot delete legacy ownership before queued OFF recovery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-policy-stale-provider-read-'))
  const statePath = join(directory, 'state.json')
  const legacy = { ...account('legacy'), paused: true }
  writeFileSync(statePath, JSON.stringify({
    enabled: false,
    enginePaused: { claude: [legacy.id] },
  }), 'utf8')
  const staleReadStarted = deferred()
  let resolveStaleRead!: (accounts: GatewayAccount[]) => void
  const staleRead = new Promise<GatewayAccount[]>((resolve) => { resolveStaleRead = resolve })
  let claudeReads = 0
  const resumed: string[] = []
  const dependencies: PolicyEngineDependencies = {
    ensureFillFirstRouting: async () => {},
    getAccounts: async (provider) => {
      if (provider !== 'claude') return []
      claudeReads += 1
      if (claudeReads === 1) throw new Error('preserve legacy ledger for periodic recovery')
      if (claudeReads === 2) {
        staleReadStarted.resolve()
        return staleRead
      }
      return [legacy]
    },
    getQuota: async (_provider, accountId) => quota(accountId, 0, '2026-07-19T01:00:00.000Z'),
    resumeAccount: async (_provider, accountId) => { resumed.push(accountId) },
  }

  try {
    const engine = new PolicyEngine(dependencies, { statePath, tickMs: 1 })
    await engine.setEnabled(true)
    await staleReadStarted.promise

    const disabling = engine.setEnabled(false)
    resolveStaleRead([])
    await disabling
    engine.stop()

    assert.deepEqual(resumed, [legacy.id])
    assert.equal(engine.getState().enabled, false)
    assert.deepEqual(
      engine.getState().providers.find((state) => state.provider === 'claude'),
      { provider: 'claude', target: null, reserve: null, enginePaused: [] },
    )
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).recoveryPending, false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a stale applyPlan resume cannot publish target state after a newer OFF then ON intent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-policy-stale-apply-'))
  const statePath = join(directory, 'state.json')
  const legacy = { ...account('legacy'), paused: true }
  const active = account('active')
  writeFileSync(statePath, JSON.stringify({
    enabled: false,
    enginePaused: { claude: [legacy.id] },
  }), 'utf8')
  const resumeStarted = deferred()
  const allowResume = deferred()
  const resumed: string[] = []
  let claudeReads = 0
  const dependencies: PolicyEngineDependencies = {
    ensureFillFirstRouting: async () => {},
    getAccounts: async (provider) => {
      if (provider !== 'claude') return []
      claudeReads += 1
      return claudeReads === 1 ? [legacy, active] : [active, legacy]
    },
    getQuota: async (_provider, accountId) => quota(
      accountId,
      0,
      accountId === active.id ? '2026-07-19T00:00:00.000Z' : '2026-07-19T01:00:00.000Z',
    ),
    resumeAccount: async (_provider, accountId) => {
      resumed.push(accountId)
      resumeStarted.resolve()
      await allowResume.promise
    },
  }

  try {
    const engine = new PolicyEngine(dependencies, { statePath, tickMs: 60_000 })
    const enabling = engine.setEnabled(true)
    await resumeStarted.promise
    const disabling = engine.setEnabled(false)
    const reenabling = engine.setEnabled(true)
    allowResume.resolve()
    await Promise.all([enabling, disabling, reenabling])
    engine.stop()

    assert.deepEqual(resumed, [legacy.id])
    assert.equal(engine.getState().enabled, true)
    assert.deepEqual(
      engine.getState().providers.find((state) => state.provider === 'claude'),
      { provider: 'claude', target: active.id, reserve: null, enginePaused: [] },
      'only the latest ON tick may publish target state after the stale resume settles',
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
