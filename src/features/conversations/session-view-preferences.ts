import type { CanonicalSessionDto, NativeImportCandidateDto } from './types.ts'

export type SessionGroupMode = 'project' | 'provider' | 'none'
export type SessionSortMode = 'recent' | 'oldest' | 'name'
export type AssistantLabelMode = 'provider' | 'assistant' | 'both'

export interface SessionViewPreferences {
  version: 1
  groupBy: SessionGroupMode
  sortBy: SessionSortMode
  assistantLabel: AssistantLabelMode
  collapsedGroups: string[]
}

export interface SessionGroup {
  id: string
  label: string
  sessions: CanonicalSessionDto[]
}

export interface BoundedPage<T> {
  items: T[]
  page: number
  pageCount: number
  total: number
  from: number
  to: number
}

export const NATIVE_IMPORT_PAGE_SIZE = 50
export const NATIVE_IMPORT_MAX_SELECTION = 10_000

export const SESSION_VIEW_PREFERENCES_KEY = 'baton.conversations.view.v1'

export const DEFAULT_SESSION_VIEW_PREFERENCES: SessionViewPreferences = {
  version: 1,
  groupBy: 'project',
  sortBy: 'recent',
  assistantLabel: 'provider',
  collapsedGroups: [],
}

export function loadSessionViewPreferences(storage: Pick<Storage, 'getItem'> | null = browserStorage()): SessionViewPreferences {
  if (!storage) return DEFAULT_SESSION_VIEW_PREFERENCES
  try {
    const raw = storage.getItem(SESSION_VIEW_PREFERENCES_KEY)
    if (!raw) return DEFAULT_SESSION_VIEW_PREFERENCES
    const parsed = JSON.parse(raw) as Partial<SessionViewPreferences>
    return {
      version: 1,
      groupBy: isGroupMode(parsed.groupBy) ? parsed.groupBy : 'project',
      sortBy: isSortMode(parsed.sortBy) ? parsed.sortBy : 'recent',
      assistantLabel: isAssistantLabelMode(parsed.assistantLabel) ? parsed.assistantLabel : 'provider',
      collapsedGroups: Array.isArray(parsed.collapsedGroups)
        ? parsed.collapsedGroups.filter((value): value is string => typeof value === 'string')
        : [],
    }
  } catch {
    return DEFAULT_SESSION_VIEW_PREFERENCES
  }
}

export function saveSessionViewPreferences(
  preferences: SessionViewPreferences,
  storage: Pick<Storage, 'setItem'> | null = browserStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(SESSION_VIEW_PREFERENCES_KEY, JSON.stringify(preferences))
  } catch {
    // View preferences must never prevent the conversation workspace from loading.
  }
}

export function groupSessions(
  sessions: CanonicalSessionDto[],
  mode: SessionGroupMode,
  sort: SessionSortMode = 'recent',
): SessionGroup[] {
  const ordered = [...sessions].sort(sessionComparator(sort))
  if (mode === 'none') {
    return [{ id: 'none:all', label: '', sessions: ordered }]
  }

  const grouped = mode === 'project'
    ? groupByProject(ordered)
    : groupByKey(ordered, providerLabel, (label) => `provider:${label.toLocaleLowerCase()}`)

  return [...grouped.values()].sort((left, right) => {
    if (sort === 'name') return left.label.localeCompare(right.label)
    const leftUpdatedAt = left.sessions[0]?.updatedAt ?? ''
    const rightUpdatedAt = right.sessions[0]?.updatedAt ?? ''
    const activityOrder = sort === 'oldest'
      ? leftUpdatedAt.localeCompare(rightUpdatedAt)
      : rightUpdatedAt.localeCompare(leftUpdatedAt)
    return activityOrder || left.label.localeCompare(right.label)
  })
}

export function projectGroupWorkspace(group: SessionGroup | undefined): string | null {
  if (!group) return null
  const workspaces = new Set(group.sessions.flatMap((session) => {
    const cwd = session.cwd?.trim() || session.source?.cwd?.trim()
    return cwd ? [cwd] : []
  }))
  return workspaces.size === 1 ? workspaces.values().next().value ?? null : null
}

function sessionComparator(sort: SessionSortMode): (left: CanonicalSessionDto, right: CanonicalSessionDto) => number {
  if (sort === 'name') {
    return (left, right) => sessionLabel(left).localeCompare(sessionLabel(right))
      || right.updatedAt.localeCompare(left.updatedAt)
  }
  if (sort === 'oldest') {
    return (left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id)
  }
  return (left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
}

function sessionLabel(session: CanonicalSessionDto): string {
  return session.title || session.source?.sourceAlias || session.preview || '새 대화'
}

export function isSelectableNativeCandidate(candidate: NativeImportCandidateDto): boolean {
  return candidate.status === 'new' || candidate.status === 'existing' || candidate.status === 'update_available'
}

export function filterNativeImportCandidates(
  candidates: NativeImportCandidateDto[],
  query: string,
): NativeImportCandidateDto[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return candidates
  return candidates.filter((candidate) => [
    candidate.sourceAlias,
    candidate.projectAlias,
    candidate.provider,
    candidate.sourceClient,
    candidate.nativeOrigin,
    candidate.status,
  ].some((value) => value?.toLocaleLowerCase().includes(normalized)))
}

export function boundedPage<T>(items: T[], requestedPage: number, pageSize: number): BoundedPage<T> {
  const safePageSize = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : NATIVE_IMPORT_PAGE_SIZE
  const pageCount = Math.max(1, Math.ceil(items.length / safePageSize))
  const page = Math.min(Math.max(1, Math.trunc(requestedPage) || 1), pageCount)
  const start = (page - 1) * safePageSize
  const paged = items.slice(start, start + safePageSize)
  return {
    items: paged,
    page,
    pageCount,
    total: items.length,
    from: paged.length === 0 ? 0 : start + 1,
    to: start + paged.length,
  }
}

export function withNativeCandidateSelection(
  current: ReadonlySet<string>,
  candidates: NativeImportCandidateDto[],
  selected: boolean,
  limit = Number.POSITIVE_INFINITY,
): Set<string> {
  const next = new Set(current)
  for (const candidate of candidates) {
    if (!isSelectableNativeCandidate(candidate)) continue
    if (selected) {
      if (next.size >= limit && !next.has(candidate.id)) break
      next.add(candidate.id)
    }
    else next.delete(candidate.id)
  }
  return next
}

function groupByKey(
  ordered: CanonicalSessionDto[],
  labelOf: (session: CanonicalSessionDto) => string,
  idOf: (label: string) => string,
): Map<string, SessionGroup> {
  const grouped = new Map<string, SessionGroup>()
  for (const session of ordered) {
    const label = labelOf(session)
    const id = idOf(label)
    const group = grouped.get(id)
    if (group) group.sessions.push(session)
    else grouped.set(id, { id, label, sessions: [session] })
  }
  return grouped
}

/**
 * Group by project via connected components over shared identity, not a single
 * per-session key. A session's project identity is its normalized working
 * directory and/or its (secret-derived, opaque) projectKey. Because those two
 * signals populate inconsistently across sources — native sessions carry a cwd
 * but no projectKey, older imports carry a projectKey but no cwd, current
 * imports carry both — keying on either one alone splits one project into two
 * groups. A session that carries both bridges the cwd-only and projectKey-only
 * members into a single component, so the same project stays one group without
 * the client needing to recompute the server-side keyed hash.
 */
function groupByProject(ordered: CanonicalSessionDto[]): Map<string, SessionGroup> {
  const ambiguousKeys = ambiguousProjectKeys(ordered)
  const tokensByIndex = ordered.map((session) => projectIdentityTokens(session, ambiguousKeys))

  // Union-find over session indices, linked by any shared identity token.
  const parent = ordered.map((_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root]!
    while (parent[index] !== root) { const next = parent[index]!; parent[index] = root; index = next }
    return root
  }
  const union = (left: number, right: number): void => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent[leftRoot] = rightRoot
  }
  const tokenOwner = new Map<string, number>()
  tokensByIndex.forEach((tokens, index) => {
    for (const token of tokens) {
      const owner = tokenOwner.get(token)
      if (owner === undefined) tokenOwner.set(token, index)
      else union(index, owner)
    }
  })

  // Collect each component's members and identity tokens. The group id is the
  // smallest token in the component — a content string that is stable across
  // re-sorts and activity churn (each token belongs to exactly one component),
  // so persisted collapsedGroups keeps matching the right group. (A positional
  // id would reattach collapse state to whichever project sorted into that slot.)
  const components = new Map<number, { members: CanonicalSessionDto[]; tokens: Set<string> }>()
  ordered.forEach((session, index) => {
    const root = find(index)
    let component = components.get(root)
    if (!component) { component = { members: [], tokens: new Set() }; components.set(root, component) }
    component.members.push(session)
    for (const token of tokensByIndex[index]!) component.tokens.add(token)
  })

  const grouped = new Map<string, SessionGroup>()
  for (const { members, tokens } of components.values()) {
    const identity = [...tokens].sort()[0] ?? 'none'
    const id = `project:${identity}`
    grouped.set(id, { id, label: projectGroupLabel(members), sessions: members })
  }
  return grouped
}

// projectKeys that the server left pointing at more than one working directory —
// e.g. a session re-pointed to a new folder via "폴더 변경" keeps its old, now
// stale projectKey. Such a key must not bridge two folders into one project, so
// it is dropped as a bridge for any session that also has an authoritative cwd.
function ambiguousProjectKeys(sessions: CanonicalSessionDto[]): Set<string> {
  const keyCwds = new Map<string, Set<string>>()
  for (const session of sessions) {
    const key = session.projectKey?.trim()
    const cwd = normalizedProjectCwd(session)
    if (!key || !cwd) continue
    const cwds = keyCwds.get(key) ?? new Set<string>()
    cwds.add(cwd)
    keyCwds.set(key, cwds)
  }
  return new Set([...keyCwds].filter(([, cwds]) => cwds.size > 1).map(([key]) => key))
}

function normalizedProjectCwd(session: CanonicalSessionDto): string | null {
  let cwd = (session.cwd?.trim() || session.source?.cwd?.trim() || '').replace(/[\\/]+$/, '')
  if (!cwd) return null
  // Windows drive paths: unify separators and casing so the same folder read from
  // different sources (native `\`, imported `/`) resolves to one identity.
  if (/^[a-z]:[\\/]/i.test(cwd)) cwd = cwd.replace(/\//g, '\\').replace(/\\+/g, '\\').toLocaleLowerCase()
  return cwd
}

// A session's project identity tokens. cwd and projectKey are strong identities,
// so a session may contribute both — that is what bridges otherwise-disjoint
// members. A projectKey that the server left mapped to multiple cwds is dropped
// as a bridge for cwd-bearing sessions (cwd is authoritative), so a stale key can
// no longer fuse two folders. projectAlias is only a fallback identity when
// neither exists, so alias collisions across different cwds never merge.
function projectIdentityTokens(session: CanonicalSessionDto, ambiguousKeys: ReadonlySet<string>): string[] {
  const tokens: string[] = []
  const cwd = normalizedProjectCwd(session)
  if (cwd) tokens.push(`cwd:${cwd}`)
  const projectKey = session.projectKey?.trim()
  if (projectKey && !(cwd && ambiguousKeys.has(projectKey))) tokens.push(`key:${projectKey}`)
  if (tokens.length === 0) {
    const alias = session.source?.projectAlias?.trim()
    // Alias-only sessions keep their own named group (prior behavior); sessions
    // with no identity at all share one "프로젝트 없음" group via a sentinel.
    tokens.push(alias ? `alias:${alias.toLocaleLowerCase()}` : 'none')
  }
  return tokens
}

// Label a component deterministically so it does not flip when a different member
// becomes most recent (which would also reorder groups under the name sort). Within
// each identity tier the most common value wins, tie-broken lexicographically.
function projectGroupLabel(members: CanonicalSessionDto[]): string {
  const aliases = members.flatMap((session) => {
    const alias = session.source?.projectAlias?.trim()
    return alias ? [alias] : []
  })
  const mostCommonAlias = mostCommon(aliases)
  if (mostCommonAlias) return mostCommonAlias
  const basenames = members.flatMap((session) => {
    // Use the original (non-normalized) cwd so the folder name keeps its casing.
    const cwd = (session.cwd?.trim() || session.source?.cwd?.trim() || '').replace(/[\\/]+$/, '')
    const basename = cwd.split(/[\\/]/).at(-1)
    return basename ? [basename] : []
  })
  const mostCommonBasename = mostCommon(basenames)
  if (mostCommonBasename) return mostCommonBasename
  const keys = members.flatMap((session) => {
    const projectKey = session.projectKey?.trim()
    return projectKey ? [projectKey] : []
  })
  return mostCommon(keys) ?? '프로젝트 없음'
}

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best: string | null = null
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && (best === null || value < best))) {
      best = value
      bestCount = count
    }
  }
  return best
}

function providerLabel(session: CanonicalSessionDto): string {
  const provider = session.source?.provider
  if (provider === 'codex') return 'Codex'
  if (provider === 'claude') return 'Claude'
  if (provider === 'gemini') return 'Gemini'
  return 'Provider 없음'
}

function browserStorage(): Storage | null {
  try {
    return (globalThis as typeof globalThis & { localStorage?: Storage }).localStorage ?? null
  } catch {
    return null
  }
}

function isGroupMode(value: unknown): value is SessionGroupMode {
  return value === 'project' || value === 'provider' || value === 'none'
}

function isSortMode(value: unknown): value is SessionSortMode {
  return value === 'recent' || value === 'oldest' || value === 'name'
}

function isAssistantLabelMode(value: unknown): value is AssistantLabelMode {
  return value === 'provider' || value === 'assistant' || value === 'both'
}
