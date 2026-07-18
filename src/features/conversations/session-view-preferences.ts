import type { CanonicalSessionDto, NativeImportCandidateDto } from './types.ts'

export type SessionGroupMode = 'project' | 'provider' | 'none'
export type AssistantLabelMode = 'provider' | 'assistant' | 'both'

export interface SessionViewPreferences {
  version: 1
  groupBy: SessionGroupMode
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
): SessionGroup[] {
  const ordered = [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  if (mode === 'none') {
    return [{ id: 'none:all', label: '', sessions: ordered }]
  }

  const grouped = new Map<string, SessionGroup>()
  for (const session of ordered) {
    const label = mode === 'project' ? projectLabel(session) : providerLabel(session)
    const id = mode === 'project' ? projectGroupId(session) : `provider:${label.toLocaleLowerCase()}`
    const group = grouped.get(id)
    if (group) group.sessions.push(session)
    else grouped.set(id, { id, label, sessions: [session] })
  }

  return [...grouped.values()].sort((left, right) => {
    const leftUpdatedAt = left.sessions[0]?.updatedAt ?? ''
    const rightUpdatedAt = right.sessions[0]?.updatedAt ?? ''
    return rightUpdatedAt.localeCompare(leftUpdatedAt) || left.label.localeCompare(right.label)
  })
}

export function isSelectableNativeCandidate(candidate: NativeImportCandidateDto): boolean {
  return candidate.status === 'new' || candidate.status === 'update_available'
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

function projectLabel(session: CanonicalSessionDto): string {
  const explicit = session.source?.projectAlias?.trim() || session.projectKey?.trim()
  if (explicit) return explicit
  const cwd = session.cwd?.trim().replace(/[\\/]+$/, '')
  if (!cwd) return '프로젝트 없음'
  return cwd.split(/[\\/]/).at(-1) || '프로젝트 없음'
}

function projectGroupId(session: CanonicalSessionDto): string {
  const cwd = session.cwd?.trim().replace(/[\\/]+$/, '')
  const normalizedCwd = cwd && /^[a-z]:[\\/]/i.test(cwd) ? cwd.toLocaleLowerCase() : cwd
  const identity = session.projectKey?.trim()
    || normalizedCwd
    || session.source?.projectAlias?.trim().toLocaleLowerCase()
    || 'none'
  return `project:${identity}`
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

function isAssistantLabelMode(value: unknown): value is AssistantLabelMode {
  return value === 'provider' || value === 'assistant' || value === 'both'
}
