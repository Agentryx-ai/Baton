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
      return { accessToken: `token-${accountId}` }
    },
  } as unknown as CodexNativeRuntime
  const control = new CodexPluginControlPlane({
    invoke: async ({ accessToken }) => rawCatalog(accessToken ? ['local', 'remote'] : ['local']),
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
    getPluginCredential: async () => ({ accessToken: 'token' }),
  } as unknown as CodexNativeRuntime
  const control = new CodexPluginControlPlane({
    invoke: async ({ accessToken }) => {
      if (accessToken && failAuthenticatedList && ++authenticatedListsAfterArming >= 2) {
        throw new Error('catalog unavailable')
      }
      return rawCatalog(accessToken ? ['remote'] : ['local'])
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
