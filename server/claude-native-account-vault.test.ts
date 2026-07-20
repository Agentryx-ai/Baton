import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
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

test('Windows DPAPI protector round-trips without exposing plaintext as ciphertext', {
  skip: process.platform !== 'win32',
}, async () => {
  const protector = new WindowsDpapiSecretProtector()
  const ciphertext = await protector.protect('dpapi-canary-secret')
  assert.notEqual(ciphertext, 'dpapi-canary-secret')
  assert.equal(await protector.unprotect(ciphertext), 'dpapi-canary-secret')
})
