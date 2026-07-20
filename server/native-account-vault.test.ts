import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'

import {
  NativeAccountVault,
  NativeAccountVaultError,
  WindowsDpapiSecretProtector,
} from './native-account-vault.ts'
import type { NativeAccountSecretProtector } from './native-account-vault.ts'

class TestProtector implements NativeAccountSecretProtector {
  async seal(plaintext: string): Promise<string> {
    return `test:v1:${Buffer.from(plaintext, 'utf8').toString('base64')}`
  }

  async open(sealed: string): Promise<string> {
    assert.match(sealed, /^test:v1:/)
    return Buffer.from(sealed.slice('test:v1:'.length), 'base64').toString('utf8')
  }
}

async function createVault(t: TestContext): Promise<{
  vault: NativeAccountVault
  vaultPath: string
}> {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-native-vault-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const vaultPath = path.join(directory, 'accounts.json')
  let nextId = 0
  let nextTime = 0
  return {
    vaultPath,
    vault: new NativeAccountVault({
      vaultPath,
      protector: new TestProtector(),
      createId: () => `account-${++nextId}`,
      now: () => new Date(Date.UTC(2026, 6, 20, 0, 0, nextTime++)),
    }),
  }
}

test('Native account vault seals credentials and exposes only ordered metadata', async (t) => {
  const { vault, vaultPath } = await createVault(t)
  const claude = await vault.add({
    provider: 'claude',
    alias: 'Claude primary',
    priority: 20,
    credential: { accessToken: 'claude-access-secret', refreshToken: 'claude-refresh-secret' },
  })
  const codex = await vault.add({
    provider: 'codex',
    alias: 'Codex primary',
    priority: 10,
    credential: { access_token: 'codex-access-secret', refresh_token: 'codex-refresh-secret' },
  })

  assert.deepEqual((await vault.list()).map((account) => account.id), [codex.id, claude.id])
  assert.deepEqual((await vault.list('claude')).map((account) => account.id), [claude.id])
  const raw = await readFile(vaultPath, 'utf8')
  assert.doesNotMatch(raw, /claude-access-secret|claude-refresh-secret|codex-access-secret|codex-refresh-secret/)
  assert.doesNotMatch(JSON.stringify(await vault.list()), /accessToken|refreshToken|access_token|refresh_token/)
  assert.deepEqual(await vault.readCredential(codex.id, 'codex'), {
    access_token: 'codex-access-secret',
    refresh_token: 'codex-refresh-secret',
  })
})

test('Native account vault serializes concurrent writes and enforces revision CAS', async (t) => {
  const { vault } = await createVault(t)
  const [first, second] = await Promise.all([
    vault.add({ provider: 'claude', alias: 'First', credential: { token: 'one' } }),
    vault.add({ provider: 'claude', alias: 'Second', credential: { token: 'two' } }),
  ])
  assert.equal((await vault.list('claude')).length, 2)

  const disabled = await vault.update(first.id, {
    enabled: false,
    priority: 5,
    expectedRevision: first.revision,
  })
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.priority, 5)
  assert.equal(disabled.revision, 2)

  await assert.rejects(
    vault.update(first.id, { alias: 'stale', expectedRevision: first.revision }),
    (error: unknown) => error instanceof NativeAccountVaultError && error.code === 'conflict',
  )
  const replaced = await vault.replaceCredential(first.id, { token: 'rotated' }, disabled.revision)
  assert.equal(replaced.revision, 3)
  assert.deepEqual(await vault.readCredential(first.id), { token: 'rotated' })

  await vault.remove(second.id, second.revision)
  assert.deepEqual((await vault.list()).map((account) => account.id), [first.id])
})

test('Windows DPAPI protector round-trips without returning plaintext ciphertext', {
  skip: process.platform !== 'win32',
}, async () => {
  const protector = new WindowsDpapiSecretProtector()
  const plaintext = 'oauth-secret-for-dpapi-roundtrip'
  const sealed = await protector.seal(plaintext)
  assert.match(sealed, /^dpapi:v1:/)
  assert.doesNotMatch(sealed, new RegExp(plaintext))
  assert.equal(await protector.open(sealed), plaintext)
})
