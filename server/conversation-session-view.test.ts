import assert from 'node:assert/strict'
import test from 'node:test'

import { conversationApi } from '../src/features/conversations/api.ts'
import {
  boundedPage,
  filterNativeImportCandidates,
  groupSessions,
  isSelectableNativeCandidate,
  loadSessionViewPreferences,
  projectGroupWorkspace,
  withNativeCandidateSelection,
} from '../src/features/conversations/session-view-preferences.ts'
import type { CanonicalSessionDto, NativeImportCandidateDto } from '../src/features/conversations/types.ts'

function session(
  id: string,
  updatedAt: string,
  overrides: Partial<CanonicalSessionDto> = {},
): CanonicalSessionDto {
  return {
    id,
    title: id,
    preview: null,
    activeThreadId: `thread-${id}`,
    projectKey: null,
    cwd: null,
    permissions: { defaultProfile: 'workspace', override: null, effectiveProfile: 'workspace', source: 'global' },
    schemaVersion: 1,
    createdAt: updatedAt,
    updatedAt,
    archivedAt: null,
    ...overrides,
    workStatus: overrides.workStatus ?? 'idle',
  }
}

function candidate(id: string, overrides: Partial<NativeImportCandidateDto> = {}): NativeImportCandidateDto {
  return {
    id,
    sourceClient: 'codex_local',
    provider: 'codex',
    status: 'new',
    sourceAlias: `Task ${id}`,
    aliasSource: 'native',
    projectAlias: 'Baton',
    createdAt: null,
    updatedAt: null,
    messageCount: 1,
    portableItemCount: 1,
    skippedItemCount: 0,
    warningCount: 0,
    analysisPending: false,
    ...overrides,
  }
}

test('session groups prefer imported project aliases and order groups by recent activity', () => {
  const groups = groupSessions([
    session('older', '2026-07-17T00:00:00.000Z', {
      projectKey: 'fallback',
      source: {
        provider: 'claude',
        sourceClient: 'claude_desktop',
        sourceAlias: 'Claude task',
        titleSource: 'custom-title',
        projectAlias: 'Baton',
      },
    }),
    session('newer', '2026-07-18T00:00:00.000Z', { cwd: 'C:\\work\\ParetoPilot' }),
  ], 'project')

  assert.deepEqual(groups.map((group) => group.label), ['ParetoPilot', 'Baton'])
})

test('provider grouping keeps sessions without source provenance visible', () => {
  const groups = groupSessions([
    session('codex', '2026-07-18T00:00:00.000Z', {
      source: {
        provider: 'codex',
        sourceClient: 'codex_local',
        sourceAlias: null,
        titleSource: null,
        projectAlias: null,
      },
    }),
    session('local', '2026-07-17T00:00:00.000Z'),
  ], 'provider')

  assert.deepEqual(groups.map((group) => group.label), ['Codex', 'Provider 없음'])
})

test('ungrouped and grouped sessions are ordered by latest update without trusting API order', () => {
  const sessions = [
    session('older', '2026-07-17T00:00:00.000Z', { projectKey: 'Baton' }),
    session('newer', '2026-07-18T00:00:00.000Z', { projectKey: 'Baton' }),
  ]

  assert.deepEqual(groupSessions(sessions, 'none')[0]?.sessions.map((item) => item.id), ['newer', 'older'])
  assert.deepEqual(groupSessions(sessions, 'project')[0]?.sessions.map((item) => item.id), ['newer', 'older'])
  assert.deepEqual(groupSessions(sessions, 'none', 'oldest')[0]?.sessions.map((item) => item.id), ['older', 'newer'])
  assert.deepEqual(groupSessions([
    session('zebra', '2026-07-19T00:00:00.000Z'),
    session('alpha', '2026-07-18T00:00:00.000Z'),
  ], 'none', 'name')[0]?.sessions.map((item) => item.id), ['alpha', 'zebra'])
})

test('project grouping does not merge unrelated paths that share a basename', () => {
  const groups = groupSessions([
    session('one', '2026-07-18T00:00:00.000Z', { cwd: 'C:\\one\\shared' }),
    session('two', '2026-07-17T00:00:00.000Z', { cwd: 'C:\\two\\shared' }),
  ], 'project')

  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map((group) => group.label), ['shared', 'shared'])
})

test('project group workspace prefers connected folders and accepts an unambiguous imported folder', () => {
  const connected = groupSessions([
    session('connected', '2026-07-18T00:00:00.000Z', { projectKey: 'baton', cwd: ' C:\\work\\Baton ' }),
    session('imported', '2026-07-17T00:00:00.000Z', {
      projectKey: 'baton',
      source: {
        provider: 'codex', sourceClient: 'codex_local', sourceAlias: null, titleSource: null,
        projectAlias: 'Baton', cwd: 'C:\\work\\Baton',
      },
    }),
  ], 'project')[0]
  assert.equal(projectGroupWorkspace(connected), 'C:\\work\\Baton')

  // A project group with no connected folder (only key-only members) has no
  // workspace to open a draft in. (Two sessions that share a projectKey but sit
  // in different folders are now separate projects, so they cannot form one
  // multi-folder group; the null path is exercised via a folder-less group.)
  const noWorkspace = groupSessions([
    session('one', '2026-07-18T00:00:00.000Z', { projectKey: 'shared' }),
    session('two', '2026-07-17T00:00:00.000Z', { projectKey: 'shared' }),
  ], 'project')[0]
  assert.equal(projectGroupWorkspace(noWorkspace), null)
  assert.equal(projectGroupWorkspace(undefined), null)
})

test('project grouping merges cwd-only and projectKey-only sessions bridged by one that has both', () => {
  // Mirrors the real DaeumKkini mixed state: a native session with a cwd but no
  // projectKey, an older import with a projectKey but no cwd, and a current
  // import that carries both and bridges them into a single project group.
  const groups = groupSessions([
    session('native', '2026-07-20T00:00:00.000Z', { cwd: 'C:\\_projects\\Agentryx-ai\\DaeumKkini' }),
    session('bridge', '2026-07-19T00:00:00.000Z', {
      cwd: 'C:\\_projects\\Agentryx-ai\\DaeumKkini',
      projectKey: 'Fb3G7Z33ZVIeQ_hash',
      source: {
        provider: 'codex',
        sourceClient: 'codex_local',
        sourceAlias: 'CP-SAT',
        titleSource: null,
        projectAlias: 'DaeumKkini',
      },
    }),
    session('legacy-import', '2026-07-18T00:00:00.000Z', {
      cwd: null,
      projectKey: 'Fb3G7Z33ZVIeQ_hash',
      source: {
        provider: 'codex',
        sourceClient: 'codex_local',
        sourceAlias: 'Marketing',
        titleSource: null,
        projectAlias: 'DaeumKkini',
      },
    }),
  ], 'project')

  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.label, 'DaeumKkini')
  assert.deepEqual(groups[0]?.sessions.map((item) => item.id).sort(), ['bridge', 'legacy-import', 'native'])
})

test('project grouping keeps every identity-less session in one 프로젝트 없음 group', () => {
  const groups = groupSessions([
    session('a', '2026-07-18T00:00:00.000Z'),
    session('b', '2026-07-17T00:00:00.000Z'),
  ], 'project')

  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.label, '프로젝트 없음')
  assert.deepEqual(groups[0]?.sessions.map((item) => item.id), ['a', 'b'])
})

test('project group ids are content-stable across activity churn and sort mode', () => {
  const build = (aUpdatedAt: string, bUpdatedAt: string, sort: 'recent' | 'name') => groupSessions([
    session('a', aUpdatedAt, { cwd: 'C:\\proj\\Alpha' }),
    session('b', bUpdatedAt, { cwd: 'C:\\proj\\Beta' }),
  ], 'project', sort)
  const idOf = (groups: ReturnType<typeof groupSessions>, sessionId: string) =>
    groups.find((group) => group.sessions.some((item) => item.id === sessionId))?.id

  const before = build('2026-07-20T00:00:00.000Z', '2026-07-19T00:00:00.000Z', 'recent')
  const afterChurn = build('2026-07-20T00:00:00.000Z', '2026-07-21T00:00:00.000Z', 'recent')
  const afterSort = build('2026-07-20T00:00:00.000Z', '2026-07-19T00:00:00.000Z', 'name')

  // The group id must follow the project, not the row's position, so persisted
  // collapse state never reattaches to a different project.
  assert.equal(idOf(before, 'a'), idOf(afterChurn, 'a'))
  assert.equal(idOf(before, 'b'), idOf(afterChurn, 'b'))
  assert.equal(idOf(before, 'a'), idOf(afterSort, 'a'))
  assert.notEqual(idOf(before, 'a'), idOf(before, 'b'))
})

test('a stale projectKey left on a re-pointed folder does not fuse two projects', () => {
  // `moved` was imported into Alpha (K_A) then re-pointed to Beta; its projectKey
  // is now stale. It must not drag all of Alpha and all of Beta into one group.
  const groups = groupSessions([
    session('a1', '2026-07-20T00:00:00.000Z', { cwd: 'C:\\proj\\Alpha', projectKey: 'K_A' }),
    session('moved', '2026-07-19T00:00:00.000Z', { cwd: 'C:\\proj\\Beta', projectKey: 'K_A' }),
    session('b1', '2026-07-18T00:00:00.000Z', { cwd: 'C:\\proj\\Beta' }),
  ], 'project')

  const groupOf = (id: string) => groups.find((group) => group.sessions.some((item) => item.id === id))
  assert.notEqual(groupOf('a1')?.id, groupOf('b1')?.id)
  assert.equal(groupOf('moved')?.id, groupOf('b1')?.id)
  assert.equal(groupOf('a1')?.sessions.length, 1)
})

test('project grouping unifies Windows path separators and casing across sources', () => {
  const groups = groupSessions([
    session('native', '2026-07-20T00:00:00.000Z', { cwd: 'C:\\_projects\\App' }),
    session('import', '2026-07-19T00:00:00.000Z', {
      cwd: null,
      source: {
        provider: 'codex', sourceClient: 'codex_local', sourceAlias: 'x', titleSource: null,
        projectAlias: null, cwd: 'C:/_projects/App',
      },
    }),
  ], 'project')

  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0]?.sessions.map((item) => item.id).sort(), ['import', 'native'])
})

test('invalid persisted view preferences fail closed to documented defaults', () => {
  const preferences = loadSessionViewPreferences({ getItem: () => '{bad json' })

  assert.equal(preferences.groupBy, 'project')
  assert.equal(preferences.sortBy, 'recent')
  assert.equal(preferences.assistantLabel, 'provider')
  assert.deepEqual(preferences.collapsedGroups, [])
})

test('native import paging bounds a 4,741 candidate inventory to 50 rendered rows', () => {
  const candidates = Array.from({ length: 4_741 }, (_, index) => candidate(String(index + 1)))
  const first = boundedPage(candidates, 1, 50)
  const last = boundedPage(candidates, 999, 50)

  assert.equal(first.items.length, 50)
  assert.equal(first.pageCount, 95)
  assert.deepEqual([first.from, first.to], [1, 50])
  assert.equal(last.page, 95)
  assert.equal(last.items.length, 41)
  assert.deepEqual([last.from, last.to], [4_701, 4_741])
})

test('native import filtering searches only bounded display metadata', () => {
  const candidates = [
    candidate('1', { sourceAlias: 'Pareto Playwright', projectAlias: 'OSINT' }),
    candidate('2', { sourceAlias: 'Marketing', provider: 'claude', sourceClient: 'claude_desktop' }),
  ]

  assert.deepEqual(filterNativeImportCandidates(candidates, 'playwright').map((item) => item.id), ['1'])
  assert.deepEqual(filterNativeImportCandidates(candidates, 'claude').map((item) => item.id), ['2'])
})

test('native import selection helpers preserve prior pages and exclude duplicates', () => {
  const candidates = [
    candidate('new'),
    candidate('update', { status: 'update_available' }),
    candidate('duplicate', { status: 'duplicate' }),
  ]
  const selected = withNativeCandidateSelection(new Set(['prior']), candidates, true)

  assert.deepEqual([...selected].sort(), ['new', 'prior', 'update'])
  assert.equal(isSelectableNativeCandidate(candidates[2]!), false)
  assert.deepEqual([...withNativeCandidateSelection(selected, [candidates[0]!], false)].sort(), ['prior', 'update'])
  assert.deepEqual(
    [...withNativeCandidateSelection(new Set(), [candidate('1'), candidate('2')], true, 1)],
    ['1'],
  )
})

test('native import API bootstraps CSRF and refreshes it once after a rejected token', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string, method: string, csrf: string | null }> = []
  let bootstrapCount = 0
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const csrf = new Headers(init?.headers).get('X-Baton-CSRF-Token')
    calls.push({ url, method, csrf })
    if (url.endsWith('/native-import/csrf')) {
      bootstrapCount += 1
      return Response.json({ token: `token-${bootstrapCount}` })
    }
    if (csrf === 'token-1') {
      return Response.json({ code: 'invalid_csrf', error: 'invalid token' }, { status: 403 })
    }
    return Response.json({
      token: 'preview-token',
      expiresAt: '2026-07-18T12:00:00.000Z',
      summary: {
        total: 0,
        new: 0,
        updateAvailable: 0,
        duplicate: 0,
        unavailable: 0,
        unsupported: 0,
        portableItems: 0,
        skippedItems: 0,
      },
      candidates: [],
      warnings: [],
    })
  }) as typeof fetch

  try {
    await conversationApi.previewNativeImport(['codex_local'])
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.deepEqual(calls.map((call) => [call.method, call.csrf]), [
    ['GET', null],
    ['POST', 'token-1'],
    ['GET', null],
    ['POST', 'token-2'],
  ])
})
