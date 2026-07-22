import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import test from 'node:test'

import {
  ClaudeNativeAccountVault,
  WindowsDpapiSecretProtector,
  type ClaudeNativeSecretProtector,
} from './claude-native-account-vault.ts'

class TestProtector implements ClaudeNativeSecretProtector {
  async protect(plaintext: string): Promise<string> {
    return `protected:${Buffer.from(plaintext).toString('base64')}`
  }

  async unprotect(ciphertext: string): Promise<string> {
    if (!ciphertext.startsWith('protected:')) throw new Error('invalid ciphertext')
    return Buffer.from(ciphertext.slice('protected:'.length), 'base64').toString('utf8')
  }
}

const secret = {
  accessToken: 'access-secret-value',
  refreshToken: 'refresh-secret-value',
  expiresAt: 123_000,
  scopes: ['user:inference'],
}

test('native Claude account vault persists only protected credentials and survives restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-claude-vault-'))
  const filePath = path.join(directory, 'accounts.json')
  const options = { filePath, protector: new TestProtector(), now: () => 1_000, createId: () => 'account-1' }
  const vault = new ClaudeNativeAccountVault(options)

  const account = await vault.put({ nickname: 'Primary', email: 'user@example.com', secret })
  assert.equal(account.id, 'account-1')
  assert.equal(account.source, 'oauth')
  assert.deepEqual(await vault.list(), [account])

  const raw = await readFile(filePath, 'utf8')
  assert.doesNotMatch(raw, /access-secret-value|refresh-secret-value/)
  assert.match(raw, /protectedSecret/)

  const restarted = new ClaudeNativeAccountVault(options)
  assert.deepEqual(await restarted.getSecret(account.id), secret)
  assert.equal(JSON.stringify(await restarted.list()).includes('Token'), false)
})

test('native Claude account vault imports the Claude Code account only once, including after deletion', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-claude-vault-import-'))
  let nextId = 0
  let loads = 0
  const options = {
    filePath: path.join(directory, 'accounts.json'),
    protector: new TestProtector(),
    createId: () => `account-${++nextId}`,
  }
  const vault = new ClaudeNativeAccountVault(options)
  const imported = await vault.importClaudeCodeOnce(async () => {
    loads += 1
    return { nickname: 'Claude Code', priority: 0, enabled: true, secret }
  })
  assert.equal(imported?.source, 'claude-code')
  assert.equal(loads, 1)
  assert.equal((await vault.importClaudeCodeOnce(async () => { loads += 1; return null }))?.id, imported?.id)
  assert.equal(loads, 1)

  await vault.remove(imported!.id)
  const restarted = new ClaudeNativeAccountVault(options)
  assert.equal(await restarted.importClaudeCodeOnce(async () => { loads += 1; return null }), null)
  assert.equal(loads, 1)
})

test('native Claude account vault serializes concurrent mutations and deletes credentials', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-claude-vault-race-'))
  let nextId = 0
  const vault = new ClaudeNativeAccountVault({
    filePath: path.join(directory, 'accounts.json'),
    protector: new TestProtector(),
    createId: () => `account-${++nextId}`,
  })

  const [first, second] = await Promise.all([
    vault.put({ nickname: 'First', priority: 1, secret }),
    vault.put({ nickname: 'Second', priority: 0, secret: { ...secret, accessToken: 'second-access' } }),
  ])
  assert.deepEqual((await vault.list()).map((account) => account.id), [second.id, first.id])
  assert.equal((await vault.setEnabled(first.id, false)).enabled, false)
  await vault.updateSecret(first.id, { ...secret, accessToken: 'rotated-access' })
  assert.equal((await vault.getSecret(first.id)).accessToken, 'rotated-access')
  await vault.remove(second.id)
  await assert.rejects(vault.getSecret(second.id), /찾지 못했습니다/)
  assert.deepEqual((await vault.list()).map((account) => account.id), [first.id])
})

test('native Claude preferred account priority is atomic and survives restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-vault-priority-'))
  const filePath = path.join(directory, 'accounts.json')
  let id = 0
  const createVault = () => new ClaudeNativeAccountVault({
    filePath,
    protector: new TestProtector(),
    createId: () => `account-${++id}`,
  })
  const vault = createVault()
  const first = await vault.put({ nickname: 'First', secret })
  const second = await vault.put({ nickname: 'Second', secret })
  assert.deepEqual((await vault.list()).map((account) => account.id), [first.id, second.id])
  await vault.prefer(second.id)
  assert.deepEqual((await createVault().list()).map((account) => [account.id, account.priority]), [
    [second.id, 0], [first.id, 1],
  ])
})

test('separate Claude vault instances preserve an account add racing a token refresh', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-claude-vault-process-race-'))
  const filePath = path.join(directory, 'accounts.json')
  let nextId = 0
  let releaseRefresh!: () => void
  let refreshProtectStarted!: () => void
  const refreshStarted = new Promise<void>((resolve) => { refreshProtectStarted = resolve })
  let addProtectStarted!: () => void
  const addStarted = new Promise<void>((resolve) => { addProtectStarted = resolve })
  let blockRefresh = false
  let watchAdd = false
  let addFinished: Promise<unknown> = Promise.resolve()
  class RefreshBlockingProtector extends TestProtector {
    override async protect(value: string): Promise<string> {
      if (blockRefresh) {
        blockRefresh = false
        refreshProtectStarted()
        await new Promise<void>((resolve) => { releaseRefresh = resolve })
      } else if (watchAdd) {
        watchAdd = false
        addProtectStarted()
      }
      return super.protect(value)
    }
  }
  const protector = new RefreshBlockingProtector()
  const createVault = () => new ClaudeNativeAccountVault({
    filePath,
    protector,
    createId: () => `account-${++nextId}`,
  })
  const refreshVault = createVault()
  const addVault = createVault()
  const existing = await refreshVault.put({ nickname: 'Existing', secret })
  blockRefresh = true
  const refresh = refreshVault.updateSecret(existing.id, { ...secret, accessToken: 'rotated-access' })
  await refreshStarted
  watchAdd = true
  addFinished = addVault.put({ nickname: 'Added concurrently', secret: { ...secret, refreshToken: 'other-refresh' } })
  const addEnteredBeforeRelease = await Promise.race([
    addStarted.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 30)),
  ])
  if (addEnteredBeforeRelease) await addFinished
  releaseRefresh()
  await Promise.all([refresh, addFinished])

  assert.deepEqual((await createVault().list()).map((account) => account.nickname).sort(), [
    'Added concurrently', 'Existing',
  ])
  assert.equal((await createVault().getSecret(existing.id)).accessToken, 'rotated-access')
})

test('Claude vault recovers an owned lock left by a crashed process', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-claude-vault-crashed-lock-'))
  const filePath = path.join(directory, 'accounts.json')
  const lockPath = `${filePath}.lock`
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true })
  const deadPid = child.pid
  assert.ok(deadPid)
  await once(child, 'close')
  const nonce = 'a'.repeat(32)
  await mkdir(lockPath)
  await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({
    version: 1, pid: deadPid, nonce, createdAt: Date.now() - 60_000, processIdentity: 'crashed:test-process',
  }))
  await writeFile(path.join(lockPath, 'lease.json'), JSON.stringify({
    version: 1, nonce, leaseUntil: Date.now() - 30_000,
  }))
  const vault = new ClaudeNativeAccountVault({
    filePath,
    protector: new TestProtector(),
    createId: () => 'recovered-account',
  })

  assert.equal((await vault.put({ nickname: 'Recovered', secret })).id, 'recovered-account')
  await assert.rejects(stat(lockPath), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT')
})

test('Claude vault recovers an expired lock after its PID is reused by another process instance', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-claude-vault-reused-pid-lock-'))
  const filePath = path.join(directory, 'accounts.json')
  const lockPath = `${filePath}.lock`
  const nonce = 'b'.repeat(32)
  await mkdir(lockPath)
  await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({
    version: 1,
    pid: process.pid,
    nonce,
    createdAt: Date.now() - 60_000,
    processIdentity: 'stale-process-instance',
  }))
  await writeFile(path.join(lockPath, 'lease.json'), JSON.stringify({
    version: 1, nonce, leaseUntil: Date.now() - 30_000,
  }))
  const vault = new ClaudeNativeAccountVault({
    filePath,
    protector: new TestProtector(),
    createId: () => 'pid-reuse-recovery',
  })

  assert.equal((await vault.put({ nickname: 'Recovered', secret })).id, 'pid-reuse-recovery')
  await assert.rejects(stat(lockPath), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT')
})

test('Claude vault recovers a stale anonymous lock left before owner initialization', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-claude-vault-anonymous-lock-'))
  const filePath = path.join(directory, 'accounts.json')
  const lockPath = `${filePath}.lock`
  await mkdir(lockPath)
  const stale = new Date(Date.now() - 60_000)
  await utimes(lockPath, stale, stale)
  const vault = new ClaudeNativeAccountVault({
    filePath,
    protector: new TestProtector(),
    createId: () => 'anonymous-recovery',
  })

  assert.equal((await vault.put({ nickname: 'Recovered', secret })).id, 'anonymous-recovery')
  await assert.rejects(stat(lockPath), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT')
})

test('Claude vault reports lock cleanup failure instead of silently succeeding', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-claude-vault-cleanup-failure-'))
  const filePath = path.join(directory, 'accounts.json')
  const lockPath = `${filePath}.lock`
  const unexpectedPath = path.join(lockPath, 'unexpected')
  const vault = new ClaudeNativeAccountVault({ filePath, protector: new TestProtector() })

  await assert.rejects(
    vault.withExclusiveMutation(async () => { await writeFile(unexpectedPath, 'force cleanup failure') }),
    /vault lock.*정리/i,
  )
  await unlink(unexpectedPath)
  const owner = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8')) as { nonce: string }
  await writeFile(path.join(lockPath, 'lease.json'), JSON.stringify({
    version: 1, nonce: owner.nonce, leaseUntil: Date.now() - 1,
  }))
  assert.equal((await vault.put({ nickname: 'Recovered after cleanup failure', secret })).nickname, 'Recovered after cleanup failure')
  await assert.rejects(stat(lockPath), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT')
})

test('vault put preserves omitted identity metadata and upserts one stable account identity', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-vault-stable-identity-'))
  let nextId = 0
  let now = 1_000
  const vault = new ClaudeNativeAccountVault({
    filePath: path.join(directory, 'accounts.json'),
    protector: new TestProtector(),
    createId: () => `account-${++nextId}`,
    now: () => now,
  })
  const first = await vault.put({
    nickname: 'Original',
    accountId: 'anthropic-account-1',
    email: 'user@example.com',
    priority: 3,
    enabled: false,
    source: 'claude-code',
    secret,
  })

  now = 2_000
  const metadataUpdate = await vault.put({
    id: first.id,
    nickname: 'Renamed',
    secret: { ...secret, accessToken: 'metadata-update' },
  })
  assert.deepEqual(metadataUpdate, {
    ...first,
    nickname: 'Renamed',
    updatedAt: '1970-01-01T00:00:02.000Z',
  })

  const stableUpsert = await vault.put({
    nickname: 'Rotated login',
    accountId: 'anthropic-account-1',
    email: 'rotated@example.com',
    secret: { ...secret, accessToken: 'rotated-access', refreshToken: 'rotated-refresh' },
  })
  assert.equal(stableUpsert.id, first.id)
  assert.equal((await vault.list()).length, 1)
  assert.equal((await vault.getSecret(first.id)).refreshToken, 'rotated-refresh')
})

test('vault fails closed when assigning a stable identity owned by another record', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-vault-identity-conflict-'))
  let nextId = 0
  const vault = new ClaudeNativeAccountVault({
    filePath: path.join(directory, 'accounts.json'),
    protector: new TestProtector(),
    createId: () => `account-${++nextId}`,
  })
  const owner = await vault.put({ nickname: 'Owner', accountId: 'stable-1', secret })
  const other = await vault.put({ nickname: 'Other', secret: { ...secret, accessToken: 'other' } })

  await assert.rejects(
    vault.put({ id: other.id, nickname: 'Ambiguous', accountId: 'stable-1', secret }),
    /stable identity|불변 계정 식별자/i,
  )
  assert.deepEqual((await vault.list()).map(({ id, accountId }) => ({ id, accountId })), [
    { id: owner.id, accountId: 'stable-1' },
    { id: other.id, accountId: undefined },
  ])
})

test('Claude Code placeholder claim fails closed if credential ownership changed', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-vault-placeholder-ownership-'))
  const vault = new ClaudeNativeAccountVault({
    filePath: path.join(directory, 'accounts.json'),
    protector: new TestProtector(),
    createId: () => 'placeholder',
  })
  const placeholder = await vault.importClaudeCodeOnce(async () => ({ nickname: 'Claude Code', secret }))

  await assert.rejects(
    vault.claimClaudeCodePlaceholder({
      placeholderId: placeholder!.id,
      expectedRefreshToken: 'stale-refresh-credential',
      accountId: 'verified-account',
      nickname: 'Verified',
      source: 'oauth',
      secret: { ...secret, accessToken: 'new-access', refreshToken: 'new-refresh' },
    }),
    /credential ownership changed/i,
  )
  assert.deepEqual((await vault.list()).map(({ id, accountId, source }) => ({ id, accountId, source })), [{
    id: placeholder!.id, accountId: undefined, source: 'claude-code',
  }])
  assert.equal((await vault.getSecret(placeholder!.id)).refreshToken, secret.refreshToken)
})

test('duplicate identity repair is dry-run by default and requires an explicit keep id plus backup to apply', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-vault-duplicate-repair-'))
  const filePath = path.join(directory, 'accounts.json')
  let nextId = 0
  const options = {
    filePath,
    protector: new TestProtector(),
    createId: () => `account-${++nextId}`,
    now: () => 7_000,
  }
  const vault = new ClaudeNativeAccountVault(options)
  const first = await vault.put({ nickname: 'Placeholder', secret })
  const second = await vault.put({
    nickname: 'Real account',
    email: 'user@example.com',
    secret: { ...secret, accessToken: 'current-access' },
  })
  const seeded = JSON.parse(await readFile(filePath, 'utf8')) as { accounts: Array<Record<string, unknown>> }
  seeded.accounts[0]!.accountId = 'stable-duplicate'
  seeded.accounts[1]!.accountId = 'stable-duplicate'
  await writeFile(filePath, `${JSON.stringify(seeded, null, 2)}\n`)
  const before = await readFile(filePath, 'utf8')
  const repairVault = new ClaudeNativeAccountVault(options)

  await assert.rejects(
    repairVault.put({ nickname: 'Must not guess', accountId: 'stable-duplicate', secret }),
    /several vault accounts|여러 vault 계정/i,
  )
  const preview = await repairVault.repairStableIdentityDuplicates()
  const fingerprint = createHash('sha256').update(secret.refreshToken).digest('hex')
  assert.equal(preview.applied, false)
  assert.deepEqual(preview.duplicates, [{ accountId: 'stable-duplicate', accountIds: [first.id, second.id] }])
  assert.deepEqual(preview.refreshCredentialDuplicates, [{
    refreshFingerprint: fingerprint,
    accountIds: [first.id, second.id],
    identitylessAccountIds: [],
  }])
  assert.equal(await readFile(filePath, 'utf8'), before)
  await assert.rejects(
    repairVault.repairStableIdentityDuplicates({ apply: true }),
    /explicit keep id|유지할 계정/i,
  )
  assert.equal(await readFile(filePath, 'utf8'), before)
  await assert.rejects(
    repairVault.repairStableIdentityDuplicates({
      apply: true,
      keepByAccountId: { 'stable-duplicate': second.id },
      keepByRefreshFingerprint: { [fingerprint]: first.id },
    }),
    /keeper.*충돌/i,
  )
  assert.equal(await readFile(filePath, 'utf8'), before)

  const applied = await repairVault.repairStableIdentityDuplicates({
    apply: true,
    keepByAccountId: { 'stable-duplicate': second.id },
    keepByRefreshFingerprint: { [fingerprint]: second.id },
  })
  assert.equal(applied.applied, true)
  assert.deepEqual(applied.removedAccountIds, [first.id])
  assert.ok(applied.backupPath)
  assert.equal(await readFile(applied.backupPath!, 'utf8'), before)
  assert.deepEqual((await repairVault.list()).map((account) => account.id), [second.id])
  assert.equal((await repairVault.getSecret(second.id)).refreshToken, secret.refreshToken)
})

test('repair surfaces identity-less refresh credential duplicates and requires an explicit keeper', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-vault-refresh-duplicate-repair-'))
  const filePath = path.join(directory, 'accounts.json')
  let nextId = 0
  const vault = new ClaudeNativeAccountVault({
    filePath,
    protector: new TestProtector(),
    createId: () => `account-${++nextId}`,
    now: () => 8_000,
  })
  const placeholder = await vault.importClaudeCodeOnce(async () => ({ nickname: 'Claude Code', secret }))
  const identified = await vault.put({
    nickname: 'Identified',
    accountId: 'stable-account',
    secret: { ...secret, accessToken: 'other-access' },
  })
  const fingerprint = createHash('sha256').update(secret.refreshToken).digest('hex')

  const preview = await vault.repairStableIdentityDuplicates()
  assert.deepEqual(preview.refreshCredentialDuplicates, [{
    refreshFingerprint: fingerprint,
    accountIds: [placeholder!.id, identified.id],
    identitylessAccountIds: [placeholder!.id],
  }])
  await assert.rejects(
    vault.repairStableIdentityDuplicates({ apply: true }),
    /refresh credential|explicit keep id/i,
  )
  const applied = await vault.repairStableIdentityDuplicates({
    apply: true,
    keepByRefreshFingerprint: { [fingerprint]: identified.id },
  })
  assert.deepEqual(applied.removedAccountIds, [placeholder!.id])
  assert.deepEqual((await vault.list()).map((account) => account.id), [identified.id])
})

test('repair allows an overlapping refresh group to disappear under an explicit stable-identity keeper', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-vault-overlapping-duplicate-repair-'))
  const filePath = path.join(directory, 'accounts.json')
  let nextId = 0
  const vault = new ClaudeNativeAccountVault({
    filePath,
    protector: new TestProtector(),
    createId: () => `account-${++nextId}`,
    now: () => 10_000,
  })
  const first = await vault.put({ nickname: 'Old first', secret })
  const second = await vault.put({ nickname: 'Old second', secret: { ...secret, accessToken: 'second' } })
  const keeper = await vault.put({
    nickname: 'Current keeper',
    secret: { ...secret, accessToken: 'keeper', refreshToken: 'current-refresh' },
  })
  const seeded = JSON.parse(await readFile(filePath, 'utf8')) as { accounts: Array<Record<string, unknown>> }
  for (const account of seeded.accounts) account.accountId = 'stable-overlap'
  await writeFile(filePath, `${JSON.stringify(seeded, null, 2)}\n`)
  const fingerprint = createHash('sha256').update(secret.refreshToken).digest('hex')

  const applied = await vault.repairStableIdentityDuplicates({
    apply: true,
    keepByAccountId: { 'stable-overlap': keeper.id },
    keepByRefreshFingerprint: { [fingerprint]: first.id },
  })

  assert.deepEqual(applied.removedAccountIds, [first.id, second.id])
  assert.deepEqual((await vault.list()).map((account) => account.id), [keeper.id])
})

test('Windows DPAPI protector round-trips without exposing plaintext as ciphertext', {
  skip: process.platform !== 'win32',
}, async () => {
  const protector = new WindowsDpapiSecretProtector()
  const ciphertext = await protector.protect('dpapi-canary-secret')
  assert.notEqual(ciphertext, 'dpapi-canary-secret')
  assert.equal(await protector.unprotect(ciphertext), 'dpapi-canary-secret')
})
