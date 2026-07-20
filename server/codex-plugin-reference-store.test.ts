import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CodexPluginReferenceStore,
  CodexPluginReferenceStoreError,
} from './codex-plugin-reference-store.ts'

test('Codex plugin reference store is durable, revision fenced, and fails closed on malformed state', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-plugin-reference-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'reference.json')
  const store = new CodexPluginReferenceStore({
    filePath,
    now: () => new Date('2026-07-20T00:00:00.000Z'),
  })

  assert.deepEqual(await store.get(), {
    version: 1,
    mode: 'local_only',
    accountId: null,
    revision: 0,
    updatedAt: new Date(0).toISOString(),
  })
  const saved = await store.set({ mode: 'account', accountId: 'account-1' }, 0)
  assert.equal(saved.revision, 1)
  assert.deepEqual(await new CodexPluginReferenceStore({ filePath }).get(), saved)
  await assert.rejects(
    store.set({ mode: 'local_only', accountId: null }, 0),
    (error: unknown) => error instanceof CodexPluginReferenceStoreError && error.code === 'conflict',
  )

  await writeFile(filePath, '{bad-json', 'utf8')
  await assert.rejects(
    store.get(),
    (error: unknown) => error instanceof CodexPluginReferenceStoreError && error.code === 'invalid',
  )
})
