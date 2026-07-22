import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
    secret: { ...secret, accessToken: 'current-access', refreshToken: 'current-refresh' },
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
  assert.equal(preview.applied, false)
  assert.deepEqual(preview.duplicates, [{ accountId: 'stable-duplicate', accountIds: [first.id, second.id] }])
  assert.equal(await readFile(filePath, 'utf8'), before)
  await assert.rejects(
    repairVault.repairStableIdentityDuplicates({ apply: true }),
    /explicit keep id|유지할 계정/i,
  )
  assert.equal(await readFile(filePath, 'utf8'), before)

  const applied = await repairVault.repairStableIdentityDuplicates({
    apply: true,
    keepByAccountId: { 'stable-duplicate': second.id },
  })
  assert.equal(applied.applied, true)
  assert.deepEqual(applied.removedAccountIds, [first.id])
  assert.ok(applied.backupPath)
  assert.equal(await readFile(applied.backupPath!, 'utf8'), before)
  assert.deepEqual((await repairVault.list()).map((account) => account.id), [second.id])
  assert.equal((await repairVault.getSecret(second.id)).refreshToken, 'current-refresh')
})

test('Windows DPAPI protector round-trips without exposing plaintext as ciphertext', {
  skip: process.platform !== 'win32',
}, async () => {
  const protector = new WindowsDpapiSecretProtector()
  const ciphertext = await protector.protect('dpapi-canary-secret')
  assert.notEqual(ciphertext, 'dpapi-canary-secret')
  assert.equal(await protector.unprotect(ciphertext), 'dpapi-canary-secret')
})
