import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CodexPluginControlPlane } from './codex-plugin-control-plane.ts'
import {
  CodexPluginReferenceService,
  CodexPluginReferenceServiceError,
} from './codex-plugin-reference-service.ts'
import { CodexPluginReferenceStore } from './codex-plugin-reference-store.ts'
import type { CodexNativeRuntime } from './codex-native-runtime.ts'

function rawCatalog(ids: string[]): Record<string, unknown> {
  return {
    marketplaces: [{
      name: 'catalog',
      path: null,
      plugins: ids.map((id) => ({
        id,
        name: id,
        remotePluginId: id,
        installed: false,
        enabled: true,
        installPolicy: 'AVAILABLE',
        authPolicy: 'ON_USE',
        availability: 'AVAILABLE',
      })),
    }],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  }
}

function accountRead(): Record<string, unknown> {
  return { account: { type: 'chatgpt', email: null, planType: 'pro' }, requiresOpenaiAuth: true }
}

test('paused Codex accounts remain eligible as plugin reference with preview, switch, and deletion guard', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-plugin-service-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const accounts = [{ id: 'paused', alias: 'Plugin Account', enabled: false, revision: 4 }]
  const credentialRequests: Array<{ accountId: string; forceRefresh: boolean }> = []
  const runtime = {
    vault: {
      list: async () => accounts,
      readAccount: async (accountId: string) => {
        const account = accounts.find((candidate) => candidate.id === accountId)
        if (!account) throw new Error('not found')
        return { metadata: account, credential: {} }
      },
    },
    getPluginCredential: async (accountId: string, forceRefresh = false) => {
      credentialRequests.push({ accountId, forceRefresh })
      return { accessToken: `token-${accountId}`, chatgptAccountId: `chatgpt-${accountId}`, plan: 'pro' }
    },
  } as unknown as CodexNativeRuntime
  const control = new CodexPluginControlPlane({
    invoke: async ({ method, credential }) => method === 'account/read'
      ? accountRead()
      : rawCatalog(credential ? ['local', 'remote'] : ['local']),
  })
  const store = new CodexPluginReferenceStore({ filePath: path.join(directory, 'reference.json') })
  const service = new CodexPluginReferenceService({ runtime, store, controlPlane: control })

  const preview = await service.preview({ mode: 'account', accountId: 'paused' })
  assert.deepEqual(preview.addedPluginIds, ['catalog/remote'])
  assert.equal(preview.targetAccountRevision, 4)
  const switched = await service.switch({
    mode: 'account',
    accountId: 'paused',
    expectedStateRevision: preview.current.state.revision,
    expectedTargetAccountRevision: preview.targetAccountRevision,
    previewDigest: preview.previewDigest,
  })
  assert.equal(switched.status.account?.enabledForModelRouting, false)
  assert.ok(credentialRequests.some((request) => request.forceRefresh))
  await assert.rejects(
    service.assertAccountRemovable('paused'),
    (error: unknown) => error instanceof CodexPluginReferenceServiceError && error.code === 'invalid',
  )
  await assert.rejects(
    service.switch({
      mode: 'local_only',
      accountId: null,
      expectedStateRevision: switched.status.state.revision,
      expectedTargetAccountRevision: null,
      previewDigest: preview.previewDigest,
    }),
    (error: unknown) => error instanceof CodexPluginReferenceServiceError && error.code === 'conflict',
  )
})

test('failed post-switch catalog confirmation restores the previous plugin reference', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-plugin-rollback-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new CodexPluginReferenceStore({ filePath: path.join(directory, 'reference.json') })
  const accounts = [{ id: 'account-1', alias: 'Account', enabled: true, revision: 1 }]
  let failAuthenticatedList = false
  let authenticatedListsAfterArming = 0
  const runtime = {
    vault: {
      list: async () => accounts,
      readAccount: async () => ({ metadata: accounts[0], credential: {} }),
    },
    getPluginCredential: async () => ({ accessToken: 'token', chatgptAccountId: 'chatgpt-account-1', plan: 'pro' }),
  } as unknown as CodexNativeRuntime
  const control = new CodexPluginControlPlane({
    invoke: async ({ method, credential }) => {
      if (method === 'account/read') return accountRead()
      if (credential && failAuthenticatedList && ++authenticatedListsAfterArming >= 2) {
        throw new Error('catalog unavailable')
      }
      return rawCatalog(credential ? ['remote'] : ['local'])
    },
  })
  const service = new CodexPluginReferenceService({ runtime, store, controlPlane: control })
  const preview = await service.preview({ mode: 'account', accountId: 'account-1' })
  failAuthenticatedList = true
  await assert.rejects(service.switch({
    mode: 'account',
    accountId: 'account-1',
    expectedStateRevision: 0,
    expectedTargetAccountRevision: 1,
    previewDigest: preview.previewDigest,
  }))
  const restored = await store.get()
  assert.equal(restored.mode, 'local_only')
  assert.equal(restored.revision, 2)
})

test('a missing or revoked current account can recover to local-only with an explicit degraded preview', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-plugin-recovery-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new CodexPluginReferenceStore({ filePath: path.join(directory, 'reference.json') })
  await store.set({ mode: 'account', accountId: 'missing-account' }, 0)
  const runtime = {
    vault: {
      list: async () => [],
      readAccount: async () => { throw new Error('missing') },
    },
    getPluginCredential: async () => { throw new Error('credential revoked') },
  } as unknown as CodexNativeRuntime
  const control = new CodexPluginControlPlane({
    invoke: async () => rawCatalog(['local']),
  })
  const service = new CodexPluginReferenceService({ runtime, store, controlPlane: control })

  const status = await service.status()
  assert.equal(status.problem, 'selected_account_missing')
  const preview = await service.preview({ mode: 'local_only', accountId: null })
  assert.equal(preview.diffAvailable, false)
  assert.equal(preview.currentCatalog, null)
  assert.match(preview.currentCatalogError ?? '', /정확한 변경 차이/)
  const switched = await service.switch({
    mode: 'local_only',
    accountId: null,
    expectedStateRevision: preview.current.state.revision,
    expectedTargetAccountRevision: null,
    previewDigest: preview.previewDigest,
  })
  assert.equal(switched.status.state.mode, 'local_only')
  assert.equal(switched.status.problem, null)
})

test('account deletion and reference switching share one mutation boundary', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-plugin-delete-race-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const accounts = [{ id: 'account-1', alias: 'Account', enabled: true, revision: 1 }]
  let releaseRemoval!: () => void
  let removalEntered!: () => void
  const removalGate = new Promise<void>((resolve) => { releaseRemoval = resolve })
  const entered = new Promise<void>((resolve) => { removalEntered = resolve })
  const runtime = {
    vault: {
      list: async () => accounts,
      readAccount: async (accountId: string) => {
        const account = accounts.find((candidate) => candidate.id === accountId)
        if (!account) throw new Error('not found')
        return { metadata: account, credential: {} }
      },
      remove: async () => {
        removalEntered()
        await removalGate
        accounts.splice(0, accounts.length)
      },
    },
    getPluginCredential: async () => ({ accessToken: 'token', chatgptAccountId: 'chatgpt-account-1', plan: 'pro' }),
    forget: () => undefined,
  } as unknown as CodexNativeRuntime
  const control = new CodexPluginControlPlane({
    invoke: async ({ method, credential }) => method === 'account/read'
      ? accountRead()
      : rawCatalog(credential ? ['remote'] : ['local']),
  })
  const store = new CodexPluginReferenceStore({ filePath: path.join(directory, 'reference.json') })
  const service = new CodexPluginReferenceService({ runtime, store, controlPlane: control })
  const preview = await service.preview({ mode: 'account', accountId: 'account-1' })

  const removal = service.removeAccount('account-1', 1)
  await entered
  const switching = service.switch({
    mode: 'account',
    accountId: 'account-1',
    expectedStateRevision: preview.current.state.revision,
    expectedTargetAccountRevision: preview.targetAccountRevision,
    previewDigest: preview.previewDigest,
  })
  releaseRemoval()
  await removal
  await assert.rejects(switching)
  assert.equal((await store.get()).mode, 'local_only')
})

test('target catalog marketplace load errors fail closed before reference mutation', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-plugin-load-errors-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const accounts = [{ id: 'account-1', alias: 'Account', enabled: true, revision: 1 }]
  const runtime = {
    vault: {
      list: async () => accounts,
      readAccount: async () => ({ metadata: accounts[0], credential: {} }),
    },
    getPluginCredential: async () => ({ accessToken: 'token', chatgptAccountId: 'chatgpt-account-1', plan: 'pro' }),
  } as unknown as CodexNativeRuntime
  const control = new CodexPluginControlPlane({
    invoke: async ({ method, credential }) => method === 'account/read'
      ? accountRead()
      : ({
        ...rawCatalog(credential ? ['remote'] : ['local']),
        marketplaceLoadErrors: credential
          ? [{ marketplacePath: 'remote', message: 'unauthorized' }]
          : [],
      }),
  })
  const store = new CodexPluginReferenceStore({ filePath: path.join(directory, 'reference.json') })
  const service = new CodexPluginReferenceService({ runtime, store, controlPlane: control })
  await assert.rejects(
    service.preview({ mode: 'account', accountId: 'account-1' }),
    (error: unknown) => error instanceof CodexPluginReferenceServiceError
      && error.code === 'verification_failed',
  )
  assert.equal((await store.get()).mode, 'local_only')
})
