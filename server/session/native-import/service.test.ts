import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { SqliteSessionStore } from '../sqlite-store.ts'
import type {
  NativePortableRecord, NativeSessionCandidate, NativeSourceReader, NativeSourceScanOptions,
} from './contracts.ts'
import { NativeSessionImportService } from './service.ts'
import { contentDigest, finalizeRecords, sha256, stableJson } from './source-utils.ts'

class MutableReader implements NativeSourceReader {
  readonly sourceClient = 'codex_local' as const
  readonly sourceClients = ['codex_local', 'claude_desktop', 'claude_code'] as const
  candidate: NativeSessionCandidate
  materializeCalls = 0
  constructor(candidate: NativeSessionCandidate) { this.candidate = candidate }
  async scan(options: NativeSourceScanOptions = {}): Promise<NativeSessionCandidate[]> {
    return [options.includeRecords ? structuredClone(this.candidate) : metadataCandidate(this.candidate)]
  }
  async materialize(candidate: NativeSessionCandidate): Promise<NativeSessionCandidate> {
    this.materializeCalls += 1
    if (candidate.candidateId !== this.candidate.candidateId) throw new Error('candidate not found')
    return structuredClone(this.candidate)
  }
}

class MultiReader implements NativeSourceReader {
  readonly sourceClient = 'codex_local' as const
  readonly candidates: NativeSessionCandidate[]
  constructor(candidates: NativeSessionCandidate[]) { this.candidates = candidates }
  async scan(options: NativeSourceScanOptions = {}): Promise<NativeSessionCandidate[]> {
    return options.includeRecords ? structuredClone(this.candidates) : this.candidates.map(metadataCandidate)
  }
  async materialize(candidate: NativeSessionCandidate): Promise<NativeSessionCandidate> {
    const found = this.candidates.find((item) => item.candidateId === candidate.candidateId)
    if (!found) throw new Error('candidate not found')
    return structuredClone(found)
  }
}

test('preview scans only readers that can emit a selected source', async () => {
  const store = await newStore()
  let codexScans = 0
  let claudeScans = 0
  const claudeCandidate = candidate(['claude'])
  Object.assign(claudeCandidate, {
    candidateId: sha256('claude-only'), sourceClient: 'claude_code', provider: 'claude',
    nativeSessionId: 'claude-only', namespaceKey: 'claude-installation',
  })
  const codexReader: NativeSourceReader = {
    sourceClient: 'codex_local',
    sourceClients: ['codex_local'],
    scan: async () => { codexScans += 1; return [] },
    materialize: async (candidate) => candidate,
  }
  const claudeReader: NativeSourceReader = {
    sourceClient: 'claude_desktop',
    sourceClients: ['claude_desktop', 'claude_code'],
    scan: async () => { claudeScans += 1; return [metadataCandidate(claudeCandidate)] },
    materialize: async () => structuredClone(claudeCandidate),
  }
  const service = new NativeSessionImportService(store, [codexReader, claudeReader], { secret: Buffer.alloc(32, 5) })

  const preview = await service.preview({ sources: ['claude_code'] })
  const receipt = await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })

  assert.equal(preview.candidates.length, 1)
  assert.equal(receipt.results[0]?.status, 'imported')
  assert.equal(codexScans, 0)
  assert.equal(claudeScans, 2)
  store.close()
})

test('metadata-only inventory materializes and commits selected sessions one at a time', async () => {
  const store = await newStore()
  const first = candidate(['one'], 'candidate-1', 'native-1')
  const second = candidate(['two'], 'candidate-2', 'native-2')
  const calls: string[] = []
  const reader: NativeSourceReader = {
    sourceClient: 'codex_local',
    sourceClients: ['codex_local'],
    scan: async (options) => {
      calls.push(`scan:${String(options?.includeRecords)}`)
      assert.equal(options?.includeRecords, false)
      return [metadataCandidate(first), metadataCandidate(second)]
    },
    materialize: async (metadata) => {
      calls.push(`materialize:${metadata.candidateId}`)
      assert.deepEqual(metadata.records, [])
      return structuredClone(metadata.candidateId === first.candidateId ? first : second)
    },
  }
  const originalCommit = store.commitNativeImport.bind(store)
  store.commitNativeImport = ((input) => {
    calls.push(`commit:${input.candidate.candidateId}`)
    return originalCommit(input)
  }) as typeof store.commitNativeImport
  const service = new NativeSessionImportService(store, [reader])

  const preview = await service.preview({ sources: ['codex_local'] })
  assert.equal(preview.candidates.every((item) => !('sourceLocator' in item) && !('records' in item)), true)
  assert.deepEqual(preview.candidates.map((item) => item.portableItemCount), [0, 0])
  assert.equal(preview.summary.analysisPending, true)
  const tokenPayload = JSON.parse(Buffer.from(preview.token.split('.')[0]!, 'base64url').toString('utf8')) as {
    candidates: Array<Record<string, unknown>>
  }
  assert.deepEqual(Object.keys(tokenPayload.candidates[0]!).sort(), [
    'headDigest', 'id', 'parserVersion', 'sourceClient', 'stateDigest',
  ])
  const receipt = await service.commit({ token: preview.token, candidateIds: preview.candidates.map((item) => item.candidateId) })

  assert.deepEqual(receipt.results.map((result) => result.status), ['imported', 'imported'])
  assert.deepEqual(calls, [
    'scan:false',
    'scan:false',
    `materialize:${first.candidateId}`,
    `commit:${first.candidateId}`,
    `materialize:${second.candidateId}`,
    `commit:${second.candidateId}`,
  ])
  store.close()
})

test('materialization accepts provider-private records without counting them as portable items', async () => {
  const store = await newStore()
  const value = candidate(['visible'])
  const records = finalizeRecords([
    ...value.records.map(({ prefixDigest: _prefixDigest, ...record }) => record),
    {
      key: 'native-checkpoint', ordinal: 2, digest: sha256('native-checkpoint'), createdAt: null,
      item: {
        kind: 'provider_event', provider: 'codex', visibility: 'provider_private',
        payload: { nativeContextCheckpoint: { version: 1, provider: 'codex' } },
      },
    },
  ])
  Object.assign(value, {
    records,
    contentDigest: contentDigest(records),
    prefixDigest: contentDigest(records),
    portableItemCount: 1,
  })
  const service = new NativeSessionImportService(store, [new MutableReader(value)])

  const preview = await service.preview({ sources: ['codex_local'] })
  const receipt = await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })

  assert.equal(receipt.results[0]?.status, 'imported')
  const snapshot = store.getSnapshot(store.listSessions()[0]!.activeThreadId)
  assert.deepEqual(snapshot?.items.map((item) => item.visibility), ['portable', 'provider_private'])
  store.close()
})

test('preview rejects an inventory above the supported cap before tokenization', async () => {
  const store = await newStore()
  const base = candidate(['one'])
  const reader: NativeSourceReader = {
    sourceClient: 'codex_local',
    sourceClients: ['codex_local'],
    scan: async () => Array.from({ length: 10_001 }, (_, index) => ({
      ...metadataCandidate(base), candidateId: sha256(`oversized-${index}`), nativeSessionId: `native-${index}`,
      identityKeys: [{ kind: 'native_session_id', value: `native-${index}` }],
    })),
    materialize: async () => { throw new Error('must not materialize an oversized preview') },
  }
  const service = new NativeSessionImportService(store, [reader])
  await assert.rejects(() => service.preview({ sources: ['codex_local'] }), (error: unknown) =>
    error instanceof Error && 'code' in error && error.code === 'invalid_request' && /10,000/.test(error.message))
  store.close()
})

test('preview rejects a reader overflow sentinel before token state lookup', async () => {
  const store = await newStore()
  let stateLookups = 0
  const getState = store.getNativeImportState.bind(store)
  store.getNativeImportState = ((identity) => {
    stateLookups += 1
    return getState(identity)
  }) as typeof store.getNativeImportState
  const value = candidate(['one'], 'overflow-sentinel', 'overflow-native')
  const reader: NativeSourceReader = {
    sourceClient: 'codex_local',
    sourceClients: ['codex_local'],
    inventoryOverflow: true,
    overflowCount: 10_001,
    scan: async () => [metadataCandidate(value)],
    materialize: async () => { throw new Error('must not materialize a truncated inventory') },
  }
  const service = new NativeSessionImportService(store, [reader])
  await assert.rejects(() => service.preview({ sources: ['codex_local'] }), (error: unknown) =>
    error instanceof Error && 'code' in error && error.code === 'invalid_request' && /10,001 reported/.test(error.message))
  assert.equal(stateLookups, 0)
  store.close()
})

test('preview token binds parser version and the lightweight source head', async () => {
  const mutations: Array<[string, (value: NativeSessionCandidate) => void]> = [
    ['parser', (value) => { value.parserVersion = 'test-v2' }],
    ['head', (value) => { value.sourceHead.mtimeMs += 1 }],
  ]
  for (const [name, mutate] of mutations) {
    const store = await newStore()
    const reader = new MutableReader(candidate(['one'], `binding-${name}`, `native-${name}`))
    const service = new NativeSessionImportService(store, [reader])
    const preview = await service.preview({ sources: ['codex_local'] })
    if (name === 'parser') {
      const [encoded, signature] = preview.token.split('.')
      const payload = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8')) as { candidates: Array<{ parserVersion: string }> }
      payload.candidates[0]!.parserVersion = 'attacker-controlled'
      const tampered = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`
      await assert.rejects(() => service.commit({ token: tampered, candidateIds: [preview.candidates[0]!.candidateId] }),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'invalid_token')
    }
    mutate(reader.candidate)
    const receipt = await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })
    assert.equal(receipt.results[0]?.status, 'stale', name)
    assert.equal(reader.materializeCalls, 0, name)
    store.close()
  }
})

test('preview and commit are idempotent and append only a valid native delta', async () => {
  const store = await newStore()
  const reader = new MutableReader(candidate(['one']))
  const service = new NativeSessionImportService(store, [reader], { secret: Buffer.alloc(32, 7) })

  const firstPreview = await service.preview()
  assert.equal(firstPreview.summary.new, 1)
  const first = await service.commit({ token: firstPreview.token, candidateIds: [firstPreview.candidates[0]!.candidateId] })
  assert.equal(first.results[0]?.status, 'imported')
  assert.equal(store.listSessions()[0]?.source?.sourceAlias, 'Imported alias')
  assert.equal(store.listSessions()[0]?.projectKey, 'project-key')
  // Imports arrive connected to the folder the native session was recorded in.
  assert.equal(store.listSessions()[0]?.cwd, 'C:\\project')
  assert.equal('cwd' in (store.getSnapshot(store.listSessions()[0]!.activeThreadId)?.thread.instructionSnapshot ?? {}), false)

  const replay = await service.commit({ token: firstPreview.token, candidateIds: [firstPreview.candidates[0]!.candidateId] })
  assert.deepEqual(replay.results, first.results)

  const duplicatePreview = await service.preview()
  assert.equal(duplicatePreview.summary.existing, 1)
  assert.equal(duplicatePreview.summary.duplicate, 0)
  const duplicate = await service.commit({ token: duplicatePreview.token, candidateIds: [duplicatePreview.candidates[0]!.candidateId] })
  assert.equal(duplicate.results[0]?.status, 'duplicate')

  reader.candidate = candidate(['one', 'two'])
  const deltaPreview = await service.preview()
  assert.equal(deltaPreview.summary.existing, 1)
  assert.equal(deltaPreview.summary.updateAvailable, 0)
  const delta = await service.commit({ token: deltaPreview.token, candidateIds: [deltaPreview.candidates[0]!.candidateId] })
  assert.equal(delta.results[0]?.status, 'updated')
  const session = store.listSessions()[0]!
  assert.deepEqual(store.getSnapshot(session.activeThreadId)?.items.map((item) => item.payload.text), ['one', 'two'])
  store.close()
})

test('native imports atomically restore unresolved Goals as paused and duplicate import backfills are idempotent', async () => {
  const store = await newStore()
  const importedWithGoal = candidate(['one'], 'goal-candidate', 'goal-native')
  importedWithGoal.goal = {
    objective: 'finish the imported work', model: 'gpt-5.6-sol', effort: 'high',
    detectedAt: '2026-07-18T00:00:00.000Z', evidence: 'slash_command',
  }
  const reader = new MutableReader(importedWithGoal)
  const service = new NativeSessionImportService(store, [reader])

  let preview = await service.preview({ sources: ['codex_local'] })
  const first = await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })
  const firstThread = store.getSession(first.results[0]!.sessionId!)!.activeThreadId
  assert.equal(store.getGoal(firstThread)?.status, 'paused')
  assert.equal(store.getGoal(firstThread)?.objective, 'finish the imported work')
  assert.equal(store.listActiveGoals().length, 0)
  assert.equal(store.listGoalEvents(firstThread).filter((event) => event.type === 'goal_created').length, 1)

  preview = await service.preview({ sources: ['codex_local'] })
  await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })
  assert.equal(store.listGoalEvents(firstThread).filter((event) => event.type === 'goal_created').length, 1)

  reader.candidate = candidate(['two'], 'late-goal-candidate', 'late-goal-native')
  preview = await service.preview({ sources: ['codex_local'] })
  const withoutGoal = await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })
  const secondThread = store.getSession(withoutGoal.results[0]!.sessionId!)!.activeThreadId
  assert.equal(store.getGoal(secondThread), null)

  reader.candidate.goal = {
    objective: 'restore this on duplicate', model: 'gpt-5.6-sol', effort: 'high',
    detectedAt: '2026-07-18T00:00:00.000Z', evidence: 'codex_goal_tool',
  }
  preview = await service.preview({ sources: ['codex_local'] })
  const backfill = await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })
  assert.equal(backfill.results[0]?.status, 'duplicate')
  assert.equal(store.getGoal(secondThread)?.status, 'paused')
  assert.equal(store.getGoal(secondThread)?.objective, 'restore this on duplicate')
  store.close()
})

test('native Goal reconciliation never overwrites a manually restored Goal', async () => {
  const store = await newStore()
  const imported = candidate(['next meal'], 'next-meal-candidate', 'next-meal-native')
  const reader = new MutableReader(imported)
  const service = new NativeSessionImportService(store, [reader])
  let preview = await service.preview({ sources: ['codex_local'] })
  const receipt = await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })
  const threadId = store.getSession(receipt.results[0]!.sessionId!)!.activeThreadId
  const manual = store.createGoal({
    threadId, objective: 'manually restored next-meal Goal', provider: 'codex',
    model: 'gpt-5.6-sol', effort: 'high', expected: { kind: 'none' },
  })

  reader.candidate.goal = {
    objective: 'native objective must not overwrite', model: 'gpt-5.6-sol', effort: 'high',
    detectedAt: null, evidence: 'slash_command',
  }
  const dryRun = store.reconcileNativeGoal(reader.candidate, false)
  assert.equal(dryRun.status, 'existing_goal')
  preview = await service.preview({ sources: ['codex_local'] })
  await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })
  assert.equal(store.getGoal(threadId)?.id, manual.id)
  assert.equal(store.getGoal(threadId)?.objective, 'manually restored next-meal Goal')
  store.close()
})

test('additive parser metadata preserves a v1 prefix and permits an append update', async () => {
  const store = await newStore()
  const legacy = candidate(['question', 'answer'])
  const reader = new MutableReader(legacy)
  const service = new NativeSessionImportService(store, [reader], { secret: Buffer.alloc(32, 6) })

  let preview = await service.preview()
  await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })
  const sessionId = store.listSessions()[0]!.id
  const before = store.getSnapshot(store.getSession(sessionId)!.activeThreadId)!.items

  const enrichedPrefix = legacy.records.map((record) => ({
    key: record.key,
    ordinal: record.ordinal,
    digest: record.digest,
    createdAt: record.createdAt,
    item: record.item.kind === 'assistant_message'
      ? { ...record.item, payload: { ...record.item.payload, requestedModel: 'gpt-5.6-sol', effort: 'high' } }
      : record.item,
  }))
  const appended = finalizeRecords([
    ...enrichedPrefix,
    {
      key: 'record-3', ordinal: 3, digest: sha256(stableJson({ text: 'follow-up' })), createdAt: null,
      item: {
        kind: 'assistant_message' as const,
        provider: 'codex' as const,
        payload: { text: 'follow-up', requestedModel: 'gpt-5.6-sol', effort: 'high' },
      },
    },
  ])
  reader.candidate = {
    ...legacy,
    parserVersion: 'test-v2',
    sourceHead: { size: 3, mtimeMs: 3, finalRecordDigest: sha256('follow-up') },
    records: appended,
    portableItemCount: appended.length,
    contentDigest: contentDigest(appended),
    prefixDigest: contentDigest(appended),
  }

  preview = await service.preview()
  const result = await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })
  assert.equal(result.results[0]?.status, 'updated')
  const after = store.getSnapshot(store.getSession(sessionId)!.activeThreadId)!.items
  assert.deepEqual(after.slice(0, 2).map((item) => item.id), before.map((item) => item.id))
  assert.equal(after[1]?.payload.requestedModel, undefined)
  assert.equal(after[2]?.payload.requestedModel, 'gpt-5.6-sol')
  store.close()
})

test('commit reports stale after source changes and safely replaces an untouched rewritten import', async () => {
  const store = await newStore()
  const reader = new MutableReader(candidate(['one']))
  const service = new NativeSessionImportService(store, [reader], { secret: Buffer.alloc(32, 9) })
  let preview = await service.preview()
  const imported = await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })
  const importedSessionId = imported.results[0]!.sessionId!
  const importedThreadId = store.listSessions()[0]!.activeThreadId
  store.createGoal({
    threadId: importedThreadId,
    expected: { kind: 'none' },
    objective: 'user resumed the imported Goal without sending chat',
    provider: 'codex',
    model: 'gpt-test',
  })

  reader.candidate = candidate(['one', 'two'])
  preview = await service.preview()
  reader.candidate = candidate(['one', 'two', 'three'])
  const stale = await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })
  assert.equal(stale.results[0]?.status, 'stale')

  reader.candidate = candidate(['rewritten', 'two'])
  preview = await service.preview()
  const rewritten = await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })
  assert.equal(rewritten.results[0]?.status, 'updated', rewritten.results[0]?.error)
  assert.equal(rewritten.results[0]?.sessionId, importedSessionId)
  assert.equal(store.listSessions().length, 1)
  const replacedSession = store.listSessions()[0]!
  assert.equal(replacedSession.id, importedSessionId)
  assert.equal(replacedSession.activeThreadId, importedThreadId)
  assert.deepEqual(
    store.getSnapshot(replacedSession.activeThreadId)?.items.map((item) => item.payload.text),
    ['rewritten', 'two'],
  )
  assert.equal(store.getGoal(replacedSession.activeThreadId), null)
  store.close()
})

test('Claude Desktop metadata discovered later reuses an imported Claude Code identity', async () => {
  const store = await newStore()
  const cli = candidate(['one'])
  Object.assign(cli, {
    candidateId: sha256('claude-code'), sourceClient: 'claude_code', provider: 'claude', nativeSessionId: 'cli-1',
    namespaceKey: 'claude-installation', titleSource: 'custom-title', cwd: 'C:\\first\\shared',
    projectAlias: 'shared', projectGroupKey: sha256('first-project'),
    identityKeys: [{ kind: 'native_session_id', value: 'cli-1', scopeNamespaceKey: 'claude-installation' },
      { kind: 'cli_session_id', value: 'cli-1', scopeNamespaceKey: 'claude-installation' }],
  })
  const reader = new MutableReader(cli)
  const service = new NativeSessionImportService(store, [reader], { secret: Buffer.alloc(32, 3) })
  let preview = await service.preview()
  const imported = await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })
  const importedSessionId = imported.results[0]!.sessionId!
  assert.equal(store.listSessions()[0]?.source?.titleSource, 'custom-title')
  assert.equal(store.getSession(importedSessionId)?.projectKey, sha256('first-project'))

  const desktop = structuredClone(cli)
  Object.assign(desktop, {
    candidateId: sha256('claude-desktop'), sourceClient: 'claude_desktop', nativeSessionId: 'desktop-1',
    namespaceKey: 'claude-desktop-profile', sourceAlias: 'Desktop title', titleSource: 'metadata:custom-title',
    cwd: 'D:\\second\\shared', projectAlias: 'shared', projectGroupKey: sha256('desktop-project'), identityKeys: [
      { kind: 'native_session_id', value: 'desktop-1', scopeNamespaceKey: 'claude-desktop-profile' },
      { kind: 'cli_session_id', value: 'cli-1', scopeNamespaceKey: 'claude-installation' },
    ],
  })
  reader.candidate = desktop
  preview = await service.preview()
  assert.equal(preview.candidates[0]?.status, 'existing')
  const receipt = await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })
  assert.equal(receipt.results[0]?.status, 'duplicate')
  assert.equal(store.listSessions().length, 1)
  assert.equal(store.listSessions()[0]?.source?.sourceClient, 'claude_desktop')
  assert.equal(store.listSessions()[0]?.source?.sourceAlias, 'Desktop title')
  assert.equal(store.listSessions()[0]?.source?.titleSource, 'metadata:custom-title')
  assert.equal(store.getSession(importedSessionId)?.projectKey, sha256('desktop-project'))
  assert.notEqual(store.getSession(importedSessionId)?.projectKey, 'shared')

  const relocated = { ...structuredClone(desktop), cwd: 'E:\\third\\shared',
    projectGroupKey: sha256('relocated-project') }
  reader.candidate = relocated
  preview = await service.preview()
  await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })
  assert.equal(store.getSession(importedSessionId)?.projectKey, sha256('relocated-project'))

  const other = { ...structuredClone(relocated), candidateId: sha256('other-desktop'), nativeSessionId: 'desktop-2',
    sourceAlias: 'Other desktop title', cwd: 'F:\\fourth\\shared', projectGroupKey: sha256('other-project'),
    identityKeys: [{ kind: 'native_session_id' as const, value: 'desktop-2', scopeNamespaceKey: 'claude-desktop-profile' },
      { kind: 'cli_session_id' as const, value: 'cli-2', scopeNamespaceKey: 'claude-installation' }] }
  reader.candidate = other
  preview = await service.preview()
  const otherReceipt = await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })
  const otherSessionId = otherReceipt.results[0]!.sessionId!
  assert.equal(store.getSession(otherSessionId)?.source?.projectAlias, 'shared')
  assert.equal(store.getSession(importedSessionId)?.source?.projectAlias, 'shared')
  assert.notEqual(store.getSession(otherSessionId)?.projectKey, store.getSession(importedSessionId)?.projectKey)
  reader.candidate = cli
  assert.equal((await service.preview()).candidates[0]?.status, 'existing')
  store.close()
})

test('path fallback aliases promote generated aliases and cannot be downgraded by them', async () => {
  const store = await newStore()
  const generated = candidate(['one'], 'alias-rank', 'alias-native')
  Object.assign(generated, { sourceAlias: 'Generated task', aliasSource: 'generated', titleSource: null })
  const reader = new MutableReader(generated)
  const service = new NativeSessionImportService(store, [reader])
  let preview = await service.preview({ sources: ['codex_local'] })
  await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })

  reader.candidate = { ...structuredClone(generated), sourceAlias: 'Project task', aliasSource: 'path_fallback' }
  preview = await service.preview({ sources: ['codex_local'] })
  await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })
  assert.equal(store.listSessions()[0]?.source?.sourceAlias, 'Project task')

  reader.candidate = { ...structuredClone(generated), sourceAlias: 'Later generated task', aliasSource: 'generated' }
  preview = await service.preview({ sources: ['codex_local'] })
  await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })
  assert.equal(store.listSessions()[0]?.source?.sourceAlias, 'Project task')
  store.close()
})

test('completed commit receipt and source identity survive a store restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-native-restart-'))
  const database = path.join(directory, 'sessions.sqlite')
  const reader = new MutableReader(candidate(['one']))
  let id = 0
  let store = new SqliteSessionStore(database, { idFactory: () => `first-${++id}` })
  let service = new NativeSessionImportService(store, [reader], { now: () => new Date('2026-07-18T00:00:00.000Z') })
  const preview = await service.preview()
  const request = { token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] }
  const first = await service.commit(request)
  store.close()

  store = new SqliteSessionStore(database, { idFactory: () => `second-${++id}` })
  service = new NativeSessionImportService(store, [reader], { now: () => new Date('2026-07-18T00:20:00.000Z') })
  const replay = await service.commit(request)
  assert.deepEqual(replay.results, first.results)
  assert.equal((await service.preview()).candidates[0]?.status, 'existing')
  store.close()
})

test('native delta is rejected after a fork even when the fork added no items', async () => {
  const store = await newStore()
  const reader = new MutableReader(candidate(['one']))
  const service = new NativeSessionImportService(store, [reader])
  let preview = await service.preview()
  await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })
  const imported = store.listSessions()[0]!
  store.forkThread({ threadId: imported.activeThreadId, forkItemId: null })
  reader.candidate = candidate(['one', 'two'])
  preview = await service.preview()
  const receipt = await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })
  assert.equal(receipt.results[0]?.status, 'failed')
  assert.match(receipt.results[0]?.error ?? '', /update_conflict_after_fork/)

  reader.candidate = candidate(['rewritten', 'two'])
  preview = await service.preview()
  const rewritten = await service.commit({ token: preview.token, candidateIds: [preview.candidates[0]!.candidateId] })
  assert.equal(rewritten.results[0]?.status, 'failed')
  assert.match(rewritten.results[0]?.error ?? '', /source_rewritten_conflict/)
  store.close()
})

test('an applying commit resumes exact durable progress after process restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-native-applying-'))
  const database = path.join(directory, 'sessions.sqlite')
  const reader = new MultiReader([candidate(['one'], 'candidate-1', 'native-1'), candidate(['two'], 'candidate-2', 'native-2')])
  let id = 0
  let store = new SqliteSessionStore(database, { idFactory: () => `first-${++id}` })
  const originalCommit = store.commitNativeImport.bind(store)
  store.commitNativeImport = ((input) => {
    const result = originalCommit(input)
    throw new Error(`simulated process crash after ${result.candidateId}`)
  }) as typeof store.commitNativeImport
  let service = new NativeSessionImportService(store, [reader], { now: () => new Date('2026-07-18T00:00:00.000Z') })
  const preview = await service.preview()
  const request = { token: preview.token, candidateIds: preview.candidates.map((item) => item.candidateId) }
  await assert.rejects(() => service.commit(request), /checkpoint is out of order/)
  store.close()

  store = new SqliteSessionStore(database, { idFactory: () => `second-${++id}` })
  service = new NativeSessionImportService(store, [reader], { now: () => new Date('2026-07-18T00:20:00.000Z') })
  const resumed = await service.commit(request)
  assert.deepEqual(resumed.results.map((result) => result.status), ['imported', 'imported'])
  assert.equal(store.listSessions().length, 2)
  assert.deepEqual((await service.commit(request)).results, resumed.results)
  store.close()
})

async function newStore(): Promise<SqliteSessionStore> {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-native-import-'))
  let id = 0
  return new SqliteSessionStore(path.join(directory, 'sessions.sqlite'), {
    idFactory: () => `id-${++id}`,
    now: () => '2026-07-18T00:00:00.000Z',
  })
}

function candidate(texts: string[], seed = 'candidate', nativeSessionId = 'native-1'): NativeSessionCandidate {
  const base: Omit<NativePortableRecord, 'prefixDigest'>[] = texts.map((text, index) => ({
    key: `record-${index + 1}`,
    ordinal: index + 1,
    digest: sha256(stableJson({ text })),
    item: { kind: index % 2 ? 'assistant_message' : 'user_message', provider: 'codex', payload: { text } },
    createdAt: null,
  }))
  const records = finalizeRecords(base)
  return {
    candidateId: sha256(seed), sourceClient: 'codex_local', provider: 'codex', namespaceKey: 'test', nativeSessionId,
    sourceAlias: 'Imported alias', aliasSource: 'native', projectAlias: 'project', projectGroupKey: 'project-key',
    cwd: 'C:\\project', createdAt: null, updatedAt: null,
    sourceHead: { size: texts.join('').length, mtimeMs: texts.length, finalRecordDigest: sha256(texts.at(-1) ?? '') },
    contentDigest: contentDigest(records), prefixDigest: contentDigest(records), records, skippedItemCount: 0,
    parserVersion: 'test-v1', warnings: [],
    portableItemCount: records.length, sourceLocator: { path: `C:\\native\\${nativeSessionId}.jsonl` },
    identityKeys: [{ kind: 'native_session_id', value: nativeSessionId }],
    materialized: true,
  }
}

function metadataCandidate(value: NativeSessionCandidate): NativeSessionCandidate {
  return {
    ...structuredClone(value), records: [], materialized: false,
    contentDigest: sha256(''), prefixDigest: sha256(''), portableItemCount: 0, skippedItemCount: 0, warnings: [],
  }
}
