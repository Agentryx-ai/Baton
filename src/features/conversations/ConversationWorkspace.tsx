/* oxlint-disable react/only-export-components -- colocated UI state guards are covered by UI tests */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Download,
  Folder,
  FolderOpen,
  ListFilter,
  Menu,
  MessageSquarePlus,
  RefreshCw,
  Send,
  Square,
  Trash2,
  Undo2,
} from 'lucide-react'

import { AppNavigation, type AppView } from '@/components/AppNavigation'
import type { Account, PolicyState, RoutingStrategyName } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

import { ConversationApiError, conversationApi } from './api'
import { composerKeyAction } from './composer-keyboard'
import { ConversationItem } from './ConversationItem'
import { conversationEntries, latestUsageSummary } from './conversation-presentation'
import {
  clearConversationDraft,
  applyDraftFolderSelection,
  classifyFirstTurnFailure,
  conversationRouteFromUrl,
  conversationRouteUrl,
  conversationRouteWithoutSelection,
  createConversationDraft,
  editableAfterKnownFailure,
  freezeFirstTurn,
  loadConversationDraft,
  markDeliveryUnknown,
  markInitialSessionConflict,
  resolveInitialConversationRoute,
  saveConversationDraft,
  type ConversationDraft,
} from './draft-conversation'
import {
  GOAL_OBJECTIVE_MAX_CHARS,
  limitGoalObjectiveDraft,
  parseGoalComposerCommand,
  type GoalComposerCommand,
} from './goal-command'
import { GoalControl, type GoalAction } from './GoalControl'
import { NativeImportDialog } from './NativeImportDialog'
import { ProviderAccountDisclosure } from './ProviderAccountDisclosure'
import {
  groupSessions,
  type SessionGroupMode,
  type SessionSortMode,
  type SessionViewPreferences,
} from './session-view-preferences'
import { isNearScrollBottom } from './conversation-scroll'
import type {
  CanonicalFollowUpDto,
  CanonicalGoalDto,
  CanonicalProvider,
  CanonicalSessionDto,
  CanonicalTurnDto,
  ProviderModelDescriptorDto,
  UnknownMutationResolution,
  ThreadSnapshotDto,
} from './types'
import { useConversationEvents } from './useConversationEvents'

function errorMessage(error: unknown): string {
  if (error instanceof ConversationApiError) return error.message
  return error instanceof Error ? error.message : String(error)
}

function loadDraftSafely(): ConversationDraft | null {
  try {
    return loadConversationDraft(window.sessionStorage)
  } catch {
    return null
  }
}

interface InitialConversationState {
  draft: ConversationDraft | null
  draftOpen: boolean
  selectedSessionId: string | null
  invalidDraftRoute: boolean
}

function loadInitialConversationState(): InitialConversationState {
  const draft = loadDraftSafely()
  return { draft, ...resolveInitialConversationRoute(window.location.href, draft) }
}

export function folderPickerErrorMessage(error: unknown): string {
  if (!(error instanceof ConversationApiError)) return errorMessage(error)
  if (error.code === 'unsupported_os') return '이 운영체제에서는 폴더 선택기를 사용할 수 없습니다.'
  if (error.code === 'picker_unavailable') return '폴더 선택기를 열 수 없습니다. Baton을 데스크톱 세션에서 실행해 주세요.'
  if (error.code === 'picker_timeout') return '폴더 선택 시간이 만료됐습니다. 다시 선택해 주세요.'
  if (error.code === 'invalid_picker_response') return '선택한 폴더 경로를 확인할 수 없습니다.'
  if (error.code === 'interaction_required') return '폴더는 사용자가 직접 누른 선택 버튼으로만 열 수 있습니다.'
  return error.message
}

function latestActiveTurn(turns: CanonicalTurnDto[]): CanonicalTurnDto | null {
  return [...turns]
    .reverse()
    .find((turn) => ['queued', 'running', 'waiting_tool'].includes(turn.status)) ?? null
}

const PROVIDERS: CanonicalProvider[] = ['codex', 'claude', 'gemini']
const PROVIDER_NAME: Record<CanonicalProvider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  gemini: 'Gemini',
}
const EFFORT_NAME: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
}

const SESSION_PROJECTION_POLL_MS = 10_000

interface SessionProjectionPollHost {
  setInterval(callback: () => void, delayMs: number): number
  clearInterval(handle: number): void
  addEventListener(type: 'focus', listener: () => void): void
  removeEventListener(type: 'focus', listener: () => void): void
}

interface SessionProjectionVisibilityHost {
  readonly visibilityState: DocumentVisibilityState
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

export function installSessionProjectionPolling(
  refresh: () => void,
  host: SessionProjectionPollHost,
  visibilityHost: SessionProjectionVisibilityHost,
  intervalMs = SESSION_PROJECTION_POLL_MS,
): () => void {
  const refreshWhenVisible = (): void => {
    if (visibilityHost.visibilityState === 'visible') refresh()
  }
  const timer = host.setInterval(refreshWhenVisible, intervalMs)
  host.addEventListener('focus', refreshWhenVisible)
  visibilityHost.addEventListener('visibilitychange', refreshWhenVisible)
  return () => {
    host.clearInterval(timer)
    host.removeEventListener('focus', refreshWhenVisible)
    visibilityHost.removeEventListener('visibilitychange', refreshWhenVisible)
  }
}

interface ModelCatalogState {
  models: ProviderModelDescriptorDto[]
  defaultModel: string | null
}

interface GoalStatusMutationResult {
  status: 'applied' | 'stale'
}

export function requireAppliedGoalStatus(result: GoalStatusMutationResult): void {
  if (result.status === 'applied') return
  throw new Error('Goal 상태가 다른 실행에서 변경되었습니다. 최신 상태를 불러왔으니 다시 확인해 주세요.')
}

export function goalEditDescription(status: CanonicalGoalDto['status']): string {
  if (status === 'active') return 'Goal 내용을 저장합니다. 현재 진행 상태와 누적 사용량은 유지됩니다.'
  if (status === 'complete') return 'Goal 내용을 저장하고 같은 Goal을 다시 시작합니다. 누적 사용량은 유지됩니다.'
  if (status === 'budget_limited') {
    return '예산 제한 상태를 유지하려면 내용을 저장할 수 없습니다. 먼저 Goal을 다시 시작한 뒤 수정해 주세요.'
  }
  return 'Goal 내용만 저장합니다. 현재 정지 상태와 누적 사용량은 유지됩니다.'
}

export interface FollowUpPresentation {
  label: string
  tone: 'muted' | 'info' | 'warning'
  cancellable: boolean
}

export function followUpPresentation(
  followUp: Pick<CanonicalFollowUpDto, 'status' | 'targetTurnId' | 'delivery'>,
  activeTurnId: string | null,
): FollowUpPresentation {
  if (followUp.status === 'delivery_unknown') {
    return { label: '전달 확인 필요', tone: 'warning', cancellable: false }
  }
  if (followUp.status === 'stale_goal') {
    return { label: 'Goal 변경으로 제외', tone: 'muted', cancellable: false }
  }
  const targetsCurrent = followUp.targetTurnId !== null && followUp.targetTurnId === activeTurnId
  if (followUp.status === 'dispatching') {
    return {
      label: targetsCurrent ? '현재 턴 전달 중' : '다음 턴 전달 중',
      tone: 'info',
      cancellable: false,
    }
  }
  if (followUp.status === 'queued' && targetsCurrent && followUp.delivery === 'steer_or_queue') {
    return { label: '현재 턴 전달 대기', tone: 'info', cancellable: true }
  }
  return { label: '다음 턴 대기', tone: 'muted', cancellable: followUp.status === 'queued' }
}

export function pendingFollowUps(followUps: readonly CanonicalFollowUpDto[]): CanonicalFollowUpDto[] {
  return followUps
    .filter((followUp) => followUp.status !== 'consumed' && followUp.status !== 'cancelled')
    .toSorted((left, right) => left.sequence - right.sequence)
}

export function followUpText(followUp: Pick<CanonicalFollowUpDto, 'input'>): string {
  const text = followUp.input[0]?.payload.text
  return typeof text === 'string' && text.trim() ? text : '추가 요청'
}

export function composerSubmissionKind(
  prompt: string,
  goalComposerMode: boolean,
  activeTurnId: string | null,
): 'goal' | 'follow_up' | 'turn' {
  if (goalComposerMode || parseGoalComposerCommand(prompt) !== null) return 'goal'
  return activeTurnId === null ? 'turn' : 'follow_up'
}

export function replaceSessionProjection(
  sessions: CanonicalSessionDto[] | null,
  projection: CanonicalSessionDto,
): CanonicalSessionDto[] | null {
  if (!sessions) return sessions
  return sessions.map((session) => session.id === projection.id ? projection : session)
}

export interface UnknownMutationCall {
  turnId: string
  callId: string
  toolName: string
  sideEffect: 'workspace_mutation' | 'workspace_command'
}

export function unresolvedUnknownMutations(snapshot: ThreadSnapshotDto | null): UnknownMutationCall[] {
  if (!snapshot) return []
  const interruptedTurns = new Set(snapshot.turns
    .filter((turn) => turn.status === 'interrupted' && turn.error?.code === 'unknown_mutation_outcome')
    .map((turn) => turn.id))
  if (interruptedTurns.size === 0) return []

  const completed = new Set(snapshot.items
    .filter((item) => item.kind === 'tool_result' && item.turnId && typeof item.payload.callId === 'string')
    .map((item) => `${item.turnId}\0${item.payload.callId as string}`))
  return snapshot.items.flatMap((item) => {
    if (item.kind !== 'tool_call' || !item.turnId || !interruptedTurns.has(item.turnId)) return []
    const callId = typeof item.payload.callId === 'string' ? item.payload.callId : null
    const toolName = typeof item.payload.name === 'string' ? item.payload.name : null
    const sideEffect = item.payload.sideEffect
    if (!callId || !toolName || completed.has(`${item.turnId}\0${callId}`)
      || (sideEffect !== 'workspace_mutation' && sideEffect !== 'workspace_command')) return []
    return [{ turnId: item.turnId, callId, toolName, sideEffect }]
  })
}

function SessionSidebar({
  sessions,
  selectedSessionId,
  loading,
  creating,
  scope,
  preferences,
  onSelect,
  onCreate,
  onRefresh,
  onPreferencesChange,
  onScopeChange,
  onArchive,
  onRestore,
  onOpenImport,
  onNavigate,
}: {
  sessions: CanonicalSessionDto[] | null
  selectedSessionId: string | null
  loading: boolean
  creating: boolean
  scope: 'active' | 'trash'
  preferences: SessionViewPreferences
  onSelect: (sessionId: string) => void
  onCreate: () => void
  onRefresh: () => void
  onPreferencesChange: (preferences: SessionViewPreferences) => void
  onScopeChange: (scope: 'active' | 'trash') => void
  onArchive: (session: CanonicalSessionDto) => void
  onRestore: (session: CanonicalSessionDto) => void
  onOpenImport: () => void
  onNavigate: (view: AppView) => void
}) {
  const groups = sessions ? groupSessions(sessions, preferences.groupBy, preferences.sortBy) : []
  const collapsed = new Set(preferences.collapsedGroups)
  const setGroupBy = (groupBy: SessionGroupMode) => onPreferencesChange({ ...preferences, groupBy })
  const setSortBy = (sortBy: SessionSortMode) => onPreferencesChange({ ...preferences, sortBy })
  const toggleGroup = (groupId: string) => onPreferencesChange({
    ...preferences,
    collapsedGroups: collapsed.has(groupId)
      ? preferences.collapsedGroups.filter((id) => id !== groupId)
      : [...preferences.collapsedGroups, groupId],
  })

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="shrink-0 border-b border-sidebar-border">
        <AppNavigation active="conversations" onNavigate={onNavigate} variant="embedded" />
      </div>

      <div className="shrink-0 p-3 pb-2">
        <Button
          type="button"
          variant="outline"
          className="w-full justify-start bg-background/60"
          disabled={creating}
          onClick={scope === 'trash' ? () => onScopeChange('active') : onCreate}
        >
          {scope === 'trash' ? <Undo2 aria-hidden /> : <MessageSquarePlus aria-hidden />}
          {scope === 'trash' ? '대화로 돌아가기' : '새 대화'}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
        <div className="flex shrink-0 items-center justify-between px-2 py-2">
          <span className="text-xs font-medium text-muted-foreground">{scope === 'trash' ? '휴지통' : '최근 대화'}</span>
          <div className="flex items-center">
            {scope === 'active' ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={onOpenImport}
                aria-label="Native 작업 가져오기"
              >
                <Download aria-hidden />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={loading}
              onClick={onRefresh}
              aria-label="대화 목록 새로고침"
            >
              <RefreshCw className={cn(loading && 'animate-spin')} aria-hidden />
            </Button>
            <details className="group relative">
              <summary className="flex size-7 cursor-pointer list-none items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden" aria-label="대화 목록 보기 설정">
                <ListFilter className="size-3.5" aria-hidden />
              </summary>
              <div className="absolute right-0 z-30 mt-1 w-56 rounded-lg border bg-popover p-2 text-popover-foreground shadow-lg">
                <fieldset className="space-y-1">
                  <legend className="px-2 pb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">보기</legend>
                  {([['active', '대화'], ['trash', '휴지통']] as const).map(([value, label]) => (
                    <label key={value} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent">
                      <input
                        type="radio"
                        name="session-list-scope"
                        checked={scope === value}
                        onChange={(event) => {
                          event.currentTarget.closest('details')?.removeAttribute('open')
                          onScopeChange(value)
                        }}
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
                <div className="my-2 border-t" />
                <fieldset className="space-y-1">
                  <legend className="px-2 pb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">그룹화</legend>
                  {([
                    ['project', '프로젝트'],
                    ['provider', 'Provider'],
                    ['none', '없음'],
                  ] as Array<[SessionGroupMode, string]>).map(([value, label]) => (
                    <label key={value} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent">
                      <input type="radio" name="session-group-mode" checked={preferences.groupBy === value} onChange={() => setGroupBy(value)} />
                      {label}
                    </label>
                  ))}
                </fieldset>
                <div className="my-2 border-t" />
                <fieldset className="space-y-1">
                  <legend className="px-2 pb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">정렬</legend>
                  {([
                    ['recent', '최근 활동순'],
                    ['oldest', '오래된 활동순'],
                    ['name', '이름순'],
                  ] as Array<[SessionSortMode, string]>).map(([value, label]) => (
                    <label key={value} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent">
                      <input type="radio" name="session-sort-mode" checked={preferences.sortBy === value} onChange={() => setSortBy(value)} />
                      {label}
                    </label>
                  ))}
                </fieldset>
              </div>
            </details>
          </div>
        </div>

        <div className={cn(
          'min-h-0 flex-1 overflow-y-auto',
          preferences.groupBy === 'none' ? 'space-y-1' : 'space-y-5',
        )}>
          {sessions === null ? (
            <p className="px-2 py-4 text-xs text-muted-foreground">불러오는 중…</p>
          ) : sessions.length === 0 ? (
            <p className="px-2 py-4 text-xs leading-relaxed text-muted-foreground">
              {scope === 'trash' ? '휴지통이 비어 있습니다.' : '아직 대화가 없습니다.'}
            </p>
          ) : (
            groups.map((group) => preferences.groupBy === 'none' ? (
              group.sessions.map((session) => (
                <SessionButton
                  key={session.id}
                  session={session}
                  selected={session.id === selectedSessionId}
                  onSelect={onSelect}
                  onAction={scope === 'trash' ? onRestore : onArchive}
                  action={scope === 'trash' ? 'restore' : 'archive'}
                />
              ))
            ) : (
              <section key={group.id}>
                <button
                  type="button"
                  className="sticky top-0 z-10 flex min-h-8 w-full items-center gap-2 rounded-lg border border-transparent bg-sidebar/95 px-2 py-1.5 text-left text-xs font-semibold text-sidebar-foreground backdrop-blur-sm hover:border-sidebar-border hover:bg-sidebar-accent"
                  aria-expanded={!collapsed.has(group.id)}
                  onClick={() => toggleGroup(group.id)}
                  title={group.label}
                >
                  {collapsed.has(group.id) ? <ChevronRight className="size-3" aria-hidden /> : <ChevronDown className="size-3" aria-hidden />}
                  {collapsed.has(group.id) ? <Folder className="size-3.5 text-muted-foreground" aria-hidden /> : <FolderOpen className="size-3.5 text-muted-foreground" aria-hidden />}
                  <span className="min-w-0 flex-1 truncate">{group.label}</span>
                  <span className="min-w-5 rounded-full bg-sidebar-accent px-1.5 py-0.5 text-center text-[0.625rem] font-medium tabular-nums text-muted-foreground">
                    {group.sessions.length}
                  </span>
                </button>
                {!collapsed.has(group.id) ? (
                  <div className="ml-3 mt-1.5 space-y-0.5 border-l border-sidebar-border pl-1.5">
                    {group.sessions.map((session) => (
                      <SessionButton
                        key={session.id}
                        session={session}
                        selected={session.id === selectedSessionId}
                        onSelect={onSelect}
                        onAction={scope === 'trash' ? onRestore : onArchive}
                        action={scope === 'trash' ? 'restore' : 'archive'}
                        nested
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function SessionButton({
  session,
  selected,
  onSelect,
  onAction,
  action,
  nested = false,
}: {
  session: CanonicalSessionDto
  selected: boolean
  onSelect: (sessionId: string) => void
  onAction: (session: CanonicalSessionDto) => void
  action: 'archive' | 'restore'
  nested?: boolean
}) {
  return (
    <div
      className={cn(
        'group/session relative flex w-full items-center text-sm transition-colors',
        nested ? 'rounded-md' : 'rounded-lg',
        selected
          ? 'bg-sidebar-accent text-sidebar-accent-foreground shadow-sm ring-1 ring-sidebar-border/70'
          : 'text-sidebar-foreground/75 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground',
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        className={cn('min-w-0 flex-1 text-left', nested ? 'px-2.5 py-2' : 'px-3 py-2.5')}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium">
            {session.title || session.source?.sourceAlias || session.preview || '새 대화'}
          </span>
          <SessionStatus status={session.workStatus} />
        </span>
        {action === 'restore' && session.archivedAt ? (
          <span className="mt-0.5 block truncate text-[0.6875rem] opacity-65">
            {trashExpiryLabel(session.archivedAt)}
          </span>
        ) : session.title && session.preview ? (
          <span className="mt-0.5 block truncate text-xs opacity-70">{session.preview}</span>
        ) : null}
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="mr-1 shrink-0 opacity-100 md:opacity-0 md:focus-visible:opacity-100 md:group-hover/session:opacity-100"
        onClick={() => onAction(session)}
        aria-label={action === 'restore' ? '대화 복원' : '대화를 휴지통으로 이동'}
        title={action === 'restore' ? '복원' : '휴지통으로 이동'}
      >
        {action === 'restore' ? <Undo2 aria-hidden /> : <Trash2 aria-hidden />}
      </Button>
    </div>
  )
}

export const SESSION_STATUS: Record<CanonicalSessionDto['workStatus'], { label: string; dot: string }> = {
  archived: { label: '휴지통', dot: 'bg-muted-foreground' },
  waiting_user: { label: '입력 대기', dot: 'bg-warning' },
  waiting_approval: { label: '승인 대기', dot: 'bg-warning' },
  waiting_tool: { label: '도구 실행', dot: 'bg-info' },
  running: { label: '진행 중', dot: 'bg-ok' },
  queued: { label: '대기 중', dot: 'bg-info' },
  usage_limited: { label: '사용량 제한', dot: 'bg-warning' },
  budget_limited: { label: '실행 제한', dot: 'bg-warning' },
  blocked: { label: '차단됨', dot: 'bg-destructive' },
  paused: { label: '일시정지', dot: 'bg-muted-foreground' },
  failed: { label: '실패', dot: 'bg-destructive' },
  interrupted: { label: '중단됨', dot: 'bg-warning' },
  cancelled: { label: '취소됨', dot: 'bg-muted-foreground' },
  complete: { label: '목표 완료', dot: 'bg-ok' },
  completed: { label: '완료', dot: 'bg-ok' },
  imported: { label: '가져옴', dot: 'bg-muted-foreground' },
  idle: { label: '준비됨', dot: 'bg-muted-foreground' },
}

export function sessionStatusPresentation(status: unknown): { label: string; dot: string } {
  return typeof status === 'string' && status in SESSION_STATUS
    ? SESSION_STATUS[status as CanonicalSessionDto['workStatus']]
    : SESSION_STATUS.idle
}

function SessionStatus({ status }: { status: CanonicalSessionDto['workStatus'] | undefined }) {
  const presentation = sessionStatusPresentation(status)
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[0.625rem] font-normal text-muted-foreground">
      <span className={cn('size-1.5 rounded-full', presentation.dot, (status === 'running' || status === 'waiting_tool') && 'animate-pulse')} aria-hidden />
      {presentation.label}
    </span>
  )
}

function trashExpiryLabel(archivedAt: string): string {
  const expires = new Date(Date.parse(archivedAt) + 30 * 24 * 60 * 60 * 1_000)
  return `${expires.toLocaleDateString('ko-KR')} 자동 삭제`
}

export function ConversationWorkspace({
  onNavigateHome,
  onNavigateSettings,
  accounts,
  policy,
  routingStrategy,
  viewPreferences,
  onViewPreferencesChange,
}: {
  onNavigateHome: () => void
  onNavigateSettings: () => void
  accounts: Record<string, Account[]> | null
  policy: PolicyState | null
  routingStrategy: RoutingStrategyName | null
  viewPreferences: SessionViewPreferences
  onViewPreferencesChange: (preferences: SessionViewPreferences) => void
}) {
  const [initialConversation] = useState(loadInitialConversationState)
  const [sessions, setSessions] = useState<CanonicalSessionDto[] | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(initialConversation.selectedSessionId)
  const [snapshot, setSnapshot] = useState<ThreadSnapshotDto | null>(null)
  const [draft, setDraft] = useState<ConversationDraft | null>(initialConversation.draft)
  const [draftOpen, setDraftOpen] = useState(initialConversation.draftOpen)
  const [provider, setProvider] = useState<CanonicalProvider>(
    initialConversation.draft?.frozenRequest?.provider ?? initialConversation.draft?.provider ?? 'codex',
  )
  const [model, setModel] = useState(
    initialConversation.draft?.frozenRequest?.model ?? initialConversation.draft?.model ?? '',
  )
  const [effort, setEffort] = useState<string | null>(
    initialConversation.draft?.frozenRequest?.effort ?? initialConversation.draft?.effort ?? 'high',
  )
  const [catalogs, setCatalogs] = useState<Record<CanonicalProvider, ModelCatalogState | null>>({
    codex: null,
    claude: null,
    gemini: null,
  })
  const [modelCatalogErrors, setModelCatalogErrors] = useState<Partial<Record<CanonicalProvider, string>>>({})
  const [prompt, setPrompt] = useState(
    initialConversation.draft?.frozenRequest?.input[0]?.payload.text as string
      ?? initialConversation.draft?.message
      ?? '',
  )
  const [error, setError] = useState<string | null>(null)
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [loadingThread, setLoadingThread] = useState(false)
  const [folderPickerBusy, setFolderPickerBusy] = useState(false)
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false)
  const [workspaceCwd, setWorkspaceCwd] = useState('')
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancellingFollowUpId, setCancellingFollowUpId] = useState<string | null>(null)
  const [goalBusyAction, setGoalBusyAction] = useState<GoalAction | 'create' | null>(null)
  const [goalDialog, setGoalDialog] = useState<'create' | 'replace' | 'edit' | 'resume' | 'clear' | null>(null)
  const [goalDraft, setGoalDraft] = useState('')
  const [goalComposerMode, setGoalComposerMode] = useState(false)
  const [goalPanelVersion, setGoalPanelVersion] = useState(0)
  const [reconcileTarget, setReconcileTarget] = useState<UnknownMutationCall | null>(null)
  const [reconcileResolution, setReconcileResolution] = useState<UnknownMutationResolution | null>(null)
  const [reconcileNote, setReconcileNote] = useState('')
  const [reconcileBusy, setReconcileBusy] = useState(false)
  const [reconcileNotice, setReconcileNotice] = useState<string | null>(null)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [nativeImportOpen, setNativeImportOpen] = useState(false)
  const [sessionScope, setSessionScope] = useState<'active' | 'trash'>('active')
  const [pendingArchive, setPendingArchive] = useState<CanonicalSessionDto | null>(null)
  const [changingSessionId, setChangingSessionId] = useState<string | null>(null)
  const threadRequest = useRef(0)
  const sessionListRequest = useRef(0)
  const sessionListBusy = useRef(false)
  const sessionsRef = useRef<CanonicalSessionDto[] | null>(sessions)
  const draftSessionIdRef = useRef<string | null>(draft?.sessionId ?? null)
  const draftRef = useRef<ConversationDraft | null>(draft)
  const draftOpenRef = useRef(draftOpen)
  const transcriptScroller = useRef<HTMLDivElement | null>(null)
  const lastPositionedThread = useRef<string | null>(null)
  const followOutput = useRef(true)

  const selectedSession = useMemo(
    () => sessions?.find((session) => session.id === selectedSessionId) ?? null,
    [selectedSessionId, sessions],
  )
  const isDraft = sessionScope === 'active' && draftOpen && draft !== null && selectedSessionId === null
  const draftSessionId = draft?.sessionId ?? null
  draftSessionIdRef.current = draftSessionId
  draftRef.current = draft
  draftOpenRef.current = draftOpen
  sessionsRef.current = sessions
  const threadId = selectedSession?.activeThreadId ?? null
  const currentCatalog = catalogs[provider]
  const models = currentCatalog?.models ?? null
  const selectedModel = models?.find((option) => option.id === model) ?? null
  const frozenDraftRequest = isDraft ? draft?.frozenRequest ?? null : null
  const frozenModelMissing = Boolean(frozenDraftRequest
    && !(catalogs[frozenDraftRequest.provider]?.models ?? []).some((option) => option.id === frozenDraftRequest.model))
  const modelDisplayNames = useMemo(() => Object.fromEntries(
    PROVIDERS.flatMap((candidate) => (catalogs[candidate]?.models ?? []).map((option) => [
      option.id,
      option.displayName,
    ])),
  ), [catalogs])
  const unknownMutations = useMemo(() => unresolvedUnknownMutations(snapshot), [snapshot])
  const activeTurn = snapshot ? latestActiveTurn(snapshot.turns) : null
  const visibleFollowUps = pendingFollowUps(snapshot?.followUps ?? [])

  const refreshSessions = useCallback(async (background = false) => {
    if (background && sessionListBusy.current) return
    const requestId = ++sessionListRequest.current
    sessionListBusy.current = true
    if (!background) setLoadingSessions(true)
    try {
      const result = await conversationApi.listSessions(sessionScope)
      if (requestId !== sessionListRequest.current) return
      setSessions(result)
      setSelectedSessionId((current) => {
        if (draftOpenRef.current && draftSessionIdRef.current && sessionScope === 'active' && current === null) return null
        if (current && result.some((session) => session.id === current)) return current
        return result[0]?.id ?? null
      })
      if (!background) setError(null)
    } catch (cause) {
      if (!background && requestId === sessionListRequest.current) setError(errorMessage(cause))
    } finally {
      if (requestId === sessionListRequest.current) {
        sessionListBusy.current = false
        if (!background) setLoadingSessions(false)
      }
    }
  }, [sessionScope])

  const refreshModels = useCallback(async () => {
    const results = await Promise.all(PROVIDERS.map(async (candidate) => {
      try {
        const catalog = await conversationApi.listModels(candidate)
        return { provider: candidate, catalog, error: null }
      } catch (cause) {
        return { provider: candidate, catalog: null, error: errorMessage(cause) }
      }
    }))
    const nextCatalogs: Record<CanonicalProvider, ModelCatalogState | null> = {
      codex: null,
      claude: null,
      gemini: null,
    }
    const nextErrors: Partial<Record<CanonicalProvider, string>> = {}
    for (const result of results) {
      nextCatalogs[result.provider] = result.catalog
        ? { models: result.catalog.models, defaultModel: result.catalog.defaultModel }
        : { models: [], defaultModel: null }
      if (result.error) nextErrors[result.provider] = result.error
    }
    setCatalogs(nextCatalogs)
    setModelCatalogErrors(nextErrors)
  }, [])

  useEffect(() => {
    if (draftOpen && draft?.frozenRequest) {
      setProvider(draft.frozenRequest.provider)
      setModel(draft.frozenRequest.model)
      setEffort(draft.frozenRequest.effort ?? null)
      const text = draft.frozenRequest.input[0]?.payload.text
      if (typeof text === 'string') setPrompt(text)
      return
    }
    if (!currentCatalog) return
    const preferredModel = draftOpen && draft ? draft.model : model
    const option = currentCatalog.models.find((candidate) => candidate.id === preferredModel)
      ?? currentCatalog.models.find((candidate) => candidate.id === currentCatalog.defaultModel)
      ?? currentCatalog.models[0]
      ?? null
    const optionEffort = draftOpen && draft && option
      && (draft.effort === null || option.effortLevels.includes(draft.effort))
      ? draft.effort
      : option?.defaultEffort ?? null
    setModel(option?.id ?? '')
    setEffort(optionEffort)
    if (draftOpen && draft && option && (draft.model !== option.id || draft.effort !== optionEffort)) {
      const next = { ...draft, model: option.id, effort: optionEffort }
      setDraft(next)
      try { saveConversationDraft(window.sessionStorage, next) } catch { /* storage unavailable */ }
    }
  }, [currentCatalog, draft, draftOpen, model, provider])

  const refreshThread = useCallback(async (): Promise<boolean> => {
    const requestId = ++threadRequest.current
    if (!threadId) {
      setSnapshot(null)
      setLoadingThread(false)
      return true
    }
    setLoadingThread(true)
    try {
      const result = await conversationApi.getThread(threadId)
      if (requestId === threadRequest.current) {
        setSnapshot(result)
        setSessions((current) => replaceSessionProjection(current, result.session))
        setError(null)
        return true
      }
      return false
    } catch (cause) {
      if (requestId === threadRequest.current) setError(errorMessage(cause))
      return false
    } finally {
      if (requestId === threadRequest.current) setLoadingThread(false)
    }
  }, [threadId])

  useEffect(() => {
    void refreshSessions()
  }, [refreshSessions])

  useEffect(() => {
    return installSessionProjectionPolling(() => { void refreshSessions(true) }, window, document)
  }, [refreshSessions])

  useEffect(() => {
    void refreshModels()
  }, [refreshModels])

  useEffect(() => {
    if (!isDraft || !draftSessionId) return
    window.history.replaceState(
      { batonConversation: { kind: 'draft', sessionId: draftSessionId } },
      '',
      conversationRouteUrl(window.location.href, { kind: 'draft', sessionId: draftSessionId }),
    )
  }, [draftSessionId, isDraft])

  useEffect(() => {
    if (!initialConversation.invalidDraftRoute) return
    window.history.replaceState(
      { batonConversation: null },
      '',
      conversationRouteWithoutSelection(window.location.href),
    )
  }, [initialConversation])

  useEffect(() => {
    const onPopState = () => {
      const route = conversationRouteFromUrl(window.location.href)
      const currentDraft = draftRef.current
      if (route.kind === 'draft' && currentDraft?.sessionId === route.sessionId) {
        const frozen = currentDraft.frozenRequest
        setDraftOpen(true)
        setSessionScope('active')
        setSelectedSessionId(null)
        setSnapshot(null)
        setProvider(frozen?.provider ?? currentDraft.provider)
        setModel(frozen?.model ?? currentDraft.model)
        setEffort(frozen?.effort ?? currentDraft.effort)
        const text = frozen?.input[0]?.payload.text
        setPrompt(typeof text === 'string' ? text : currentDraft.message)
        return
      }
      setDraftOpen(false)
      setSnapshot(null)
      setPrompt('')
      if (route.kind === 'session') {
        setSessionScope('active')
        setSelectedSessionId(route.sessionId)
        return
      }
      if (route.kind === 'draft') {
        window.history.replaceState(
          { batonConversation: null },
          '',
          conversationRouteWithoutSelection(window.location.href),
        )
      }
      setSelectedSessionId(sessionsRef.current?.[0]?.id ?? null)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    void refreshThread()
    return () => {
      threadRequest.current += 1
    }
  }, [refreshThread])

  const onStreamEvent = useCallback(() => refreshThread(), [refreshThread])
  useConversationEvents(threadId, onStreamEvent)

  const persistDraft = useCallback((next: ConversationDraft) => {
    setDraft(next)
    try {
      saveConversationDraft(window.sessionStorage, next)
    } catch {
      // The in-memory draft remains usable when browser storage is unavailable.
    }
  }, [])

  const beginDraft = () => {
    const next = draft ?? createConversationDraft({ provider, model, effort })
    persistDraft(next)
    setDraftOpen(true)
    setSessionScope('active')
    setSelectedSessionId(null)
    setSnapshot(null)
    setProvider(next.provider)
    setModel(next.model)
    setEffort(next.effort)
    setPrompt(next.message)
    setGoalComposerMode(false)
    setMobileSidebarOpen(false)
    setError(null)
    window.history.pushState(
      { batonConversation: { kind: 'draft', sessionId: next.sessionId } },
      '',
      conversationRouteUrl(window.location.href, { kind: 'draft', sessionId: next.sessionId }),
    )
  }

  const discardConflictedDraft = () => {
    if (!draft?.conflict) return
    const frozen = draft.frozenRequest
    const frozenText = frozen?.input[0]?.payload.text
    const next = {
      ...createConversationDraft({
        provider: frozen?.provider ?? draft.provider,
        model: frozen?.model ?? draft.model,
        effort: frozen?.effort ?? draft.effort,
      }),
      cwd: frozen?.cwd ?? draft.cwd,
      message: typeof frozenText === 'string' ? frozenText : draft.message,
    }
    persistDraft(next)
    setDraftOpen(true)
    setSelectedSessionId(null)
    setProvider(next.provider)
    setModel(next.model)
    setEffort(next.effort)
    setPrompt(next.message)
    setError(null)
    window.history.replaceState(
      { batonConversation: { kind: 'draft', sessionId: next.sessionId } },
      '',
      conversationRouteUrl(window.location.href, { kind: 'draft', sessionId: next.sessionId }),
    )
  }

  const updateDraft = (patch: Partial<Pick<ConversationDraft, 'cwd' | 'provider' | 'model' | 'effort' | 'message'>>) => {
    setDraft((current) => {
      if (!current || current.frozenRequest) return current
      const next = { ...current, ...patch }
      try { saveConversationDraft(window.sessionStorage, next) } catch { /* storage unavailable */ }
      return next
    })
  }

  const pickFolder = async (target: 'draft' | 'workspace') => {
    const requestedDraftSessionId = target === 'draft' ? draftRef.current?.sessionId ?? null : null
    setFolderPickerBusy(true)
    if (target === 'workspace') setWorkspaceError(null)
    else setError(null)
    try {
      const result = await conversationApi.pickNativeFolder()
      if (result.status === 'cancelled') return
      if (target === 'workspace') setWorkspaceCwd(result.cwd)
      else if (requestedDraftSessionId) {
        setDraft((current) => {
          const next = applyDraftFolderSelection(current, requestedDraftSessionId, result.cwd)
          if (next !== current && next) {
            try { saveConversationDraft(window.sessionStorage, next) } catch { /* storage unavailable */ }
          }
          return next
        })
      }
    } catch (cause) {
      const message = folderPickerErrorMessage(cause)
      if (target === 'workspace') setWorkspaceError(message)
      else setError(message)
    } finally {
      setFolderPickerBusy(false)
    }
  }

  const openWorkspaceDialog = () => {
    if (!snapshot) return
    setWorkspaceCwd(snapshot.session.cwd ?? snapshot.session.source?.cwd ?? '')
    setWorkspaceError(null)
    setWorkspaceDialogOpen(true)
  }

  const connectWorkspace = async () => {
    if (!snapshot || !workspaceCwd.trim()) return
    setWorkspaceBusy(true)
    try {
      await conversationApi.connectWorkspace(snapshot.session.id, workspaceCwd.trim(), snapshot.thread.revision)
      setWorkspaceDialogOpen(false)
      await Promise.all([refreshThread(), refreshSessions(true)])
    } catch (cause) {
      setWorkspaceError(errorMessage(cause))
    } finally {
      setWorkspaceBusy(false)
    }
  }

  const disconnectWorkspace = async () => {
    if (!snapshot) return
    setWorkspaceBusy(true)
    try {
      await conversationApi.disconnectWorkspace(snapshot.session.id, snapshot.thread.revision)
      setWorkspaceDialogOpen(false)
      await Promise.all([refreshThread(), refreshSessions(true)])
    } catch (cause) {
      setWorkspaceError(errorMessage(cause))
    } finally {
      setWorkspaceBusy(false)
    }
  }

  const saveGoalObjective = async (objective: string, replace = false): Promise<boolean> => {
    if (!snapshot || !model.trim()) return false
    const current = snapshot.goal ?? null
    setGoalBusyAction(current ? 'edit' : 'create')
    try {
      if (current && !replace) {
        await conversationApi.editGoal(current.id, {
          expectedRevision: current.revision,
          objective,
        })
      } else {
        await conversationApi.createGoal(snapshot.thread.id, {
          expected: current
            ? { kind: 'goal', goalId: current.id, revision: current.revision }
            : { kind: 'none' },
          objective,
          provider,
          model: model.trim(),
          effort,
          replaceExisting: replace || undefined,
        })
      }
      setGoalDialog(null)
      setGoalDraft('')
      setError(null)
      await refreshThread()
      return true
    } catch (cause) {
      await refreshThread()
      setError(errorMessage(cause))
      return false
    } finally {
      setGoalBusyAction(null)
    }
  }

  const applyGoalAction = async (action: GoalAction) => {
    const current = snapshot?.goal ?? null
    if (!current) {
      if (action === 'edit') {
        setGoalDraft('')
        setGoalDialog('create')
      }
      return
    }
    if (action === 'edit') {
      if (current.status === 'budget_limited') {
        setError('예산 제한 Goal은 먼저 다시 시작한 뒤 수정해 주세요.')
        return
      }
      setGoalDraft(limitGoalObjectiveDraft(current.objective))
      setGoalDialog('edit')
      return
    }
    if (action === 'clear') {
      setGoalDialog('clear')
      return
    }
    if (action === 'resume' && current.status === 'budget_limited') {
      setGoalDialog('resume')
      return
    }
    setGoalBusyAction(action)
    try {
      const result = await conversationApi.setGoalStatus(current.id, {
        expectedRevision: current.revision,
        status: action === 'pause' ? 'paused' : 'active',
      })
      requireAppliedGoalStatus(result)
      setError(null)
      await refreshThread()
    } catch (cause) {
      await refreshThread()
      setError(errorMessage(cause))
    } finally {
      setGoalBusyAction(null)
    }
  }

  const handleGoalCommand = async (command: GoalComposerCommand) => {
    const current = snapshot?.goal ?? null
    if (command.type === 'open') {
      if (current) setGoalPanelVersion((version) => version + 1)
      else {
        setGoalDraft('')
        setGoalDialog('create')
      }
      return
    }
    if (command.type === 'set') {
      if (current && current.status !== 'complete') {
        setGoalDraft(limitGoalObjectiveDraft(command.objective))
        setGoalDialog('replace')
      } else {
        return saveGoalObjective(command.objective, current !== null)
      }
      return true
    }
    if (command.type === 'edit') {
      await applyGoalAction('edit')
      return
    }
    if (!current) {
      setError('현재 대화에 설정된 Goal이 없습니다.')
      return
    }
    if (command.type === 'clear') {
      setGoalDialog('clear')
      return
    }
    await applyGoalAction(command.type)
  }

  const startTurn = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if ((!snapshot && !isDraft) || !prompt.trim()) return
    if (isDraft && draft) {
      if (!model.trim()) return
      setSubmitting(true)
      let frozen = draft
      try {
        frozen = draft.frozenRequest
          ? draft
          : freezeFirstTurn({ ...draft, provider, model, effort, message: prompt })
        persistDraft(frozen)
        const result = await conversationApi.createFirstTurn(frozen.sessionId, frozen.frozenRequest!)
        try { clearConversationDraft(window.sessionStorage) } catch { /* storage unavailable */ }
        setDraft(null)
        setDraftOpen(false)
        setPrompt('')
        setSessions((current) => [result.session, ...(current ?? []).filter((item) => item.id !== result.session.id)])
        setSelectedSessionId(result.session.id)
        setSnapshot({
          session: result.session,
          thread: result.thread,
          turns: [result.turn],
          items: result.initialItems,
          bindings: [],
          followUps: [],
          goal: null,
        })
        window.history.replaceState(
          { batonConversation: { kind: 'session', sessionId: result.session.id } },
          '',
          conversationRouteUrl(window.location.href, { kind: 'session', sessionId: result.session.id }),
        )
        setError(null)
        void refreshSessions(true)
      } catch (cause) {
        const disposition = classifyFirstTurnFailure(cause)
        const next = disposition === 'editable'
          ? editableAfterKnownFailure(frozen)
          : disposition === 'conflict'
            ? markInitialSessionConflict(frozen)
            : markDeliveryUnknown(frozen)
        persistDraft(next)
        setError(disposition === 'editable'
          ? errorMessage(cause)
          : disposition === 'conflict'
            ? '이 draft ID가 다른 첫 요청에 이미 사용됐습니다. draft를 폐기하고 새 ID로 다시 시작해야 합니다.'
            : '응답을 확인하지 못했습니다. 아래 버튼은 같은 요청 ID와 본문을 다시 전송해 중복 생성 없이 결과를 확인합니다.')
      } finally {
        setSubmitting(false)
      }
      return
    }
    if (!snapshot) return
    const submissionKind = composerSubmissionKind(prompt, goalComposerMode, activeTurn?.id ?? null)
    if (goalComposerMode) {
      const objective = prompt.trim()
      const accepted = await handleGoalCommand({ type: 'set', objective })
      if (accepted !== false) {
        setGoalComposerMode(false)
        setPrompt('')
      }
      return
    }
    const goalCommand = submissionKind === 'goal' ? parseGoalComposerCommand(prompt) : null
    if (goalCommand) {
      if (goalCommand.type === 'open') {
        setGoalComposerMode(true)
        setPrompt('')
        setError(null)
        return
      }
      await handleGoalCommand(goalCommand)
      return
    }
    setSubmitting(true)
    try {
      const input = [{
        kind: 'user_message' as const,
        visibility: 'portable' as const,
        payload: { text: prompt.trim() },
      }]
      if (submissionKind === 'follow_up' && activeTurn) {
        await conversationApi.enqueueFollowUp(snapshot.thread.id, {
          clientRequestId: crypto.randomUUID(),
          expectedTurnId: activeTurn.id,
          delivery: 'steer_or_queue',
          input,
        })
      } else {
        if (!model.trim()) return
        await conversationApi.startTurn(snapshot.thread.id, {
          provider,
          model: model.trim(),
          effort,
          clientRequestId: crypto.randomUUID(),
          expectedRevision: snapshot.thread.revision,
          input,
        })
      }
      setPrompt('')
      setError(null)
      await refreshThread()
    } catch (cause) {
      await refreshThread()
      setError(errorMessage(cause))
    } finally {
      setSubmitting(false)
    }
  }

  const latestTurn = snapshot?.turns.at(-1) ?? null
  const latestUsage = latestUsageSummary(snapshot?.turns ?? [])
  const visibleEntries = conversationEntries(snapshot?.items ?? [])
  const turnsById = useMemo(
    () => new Map((snapshot?.turns ?? []).map((turn) => [turn.id, turn] as const)),
    [snapshot?.turns],
  )
  const latestTurnError = latestTurn?.status === 'failed' && latestTurn.error
    ? typeof latestTurn.error.message === 'string'
      ? latestTurn.error.message
      : JSON.stringify(latestTurn.error)
    : null

  useLayoutEffect(() => {
    const scroller = transcriptScroller.current
    const renderedThreadId = snapshot?.thread.id ?? null
    if (!scroller || !renderedThreadId) return
    if (lastPositionedThread.current !== renderedThreadId || followOutput.current) {
      scroller.scrollTop = scroller.scrollHeight
      lastPositionedThread.current = renderedThreadId
      followOutput.current = true
    }
  }, [snapshot?.thread.id, snapshot?.thread.revision, visibleEntries.length])

  const cancelTurn = async () => {
    if (!activeTurn) return
    setCancelling(true)
    try {
      await conversationApi.cancelTurn(activeTurn.id)
      await refreshThread()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setCancelling(false)
    }
  }

  const cancelFollowUp = async (followUp: CanonicalFollowUpDto) => {
    setCancellingFollowUpId(followUp.id)
    try {
      await conversationApi.cancelFollowUp(followUp.id, followUp.revision)
      setError(null)
      await refreshThread()
    } catch (cause) {
      await refreshThread()
      setError(errorMessage(cause))
    } finally {
      setCancellingFollowUpId(null)
    }
  }

  const canSubmit = Boolean(
    prompt.trim()
      && !submitting
      && !folderPickerBusy
      && (isDraft
        ? draft && !draft.conflict && model.trim()
        : snapshot
          && !selectedSession?.archivedAt
          && (activeTurn !== null || (snapshot.thread.status === 'idle' && Boolean(model.trim())))),
  )

  const selectSession = (sessionId: string) => {
    setDraftOpen(false)
    setSelectedSessionId(sessionId)
    setPrompt('')
    setGoalPanelVersion(0)
    setGoalDialog(null)
    setGoalComposerMode(false)
    setReconcileTarget(null)
    setReconcileResolution(null)
    setReconcileNote('')
    setReconcileNotice(null)
    setMobileSidebarOpen(false)
    window.history.replaceState(
      { batonConversation: { kind: 'session', sessionId } },
      '',
      conversationRouteUrl(window.location.href, { kind: 'session', sessionId }),
    )
  }

  const changeScope = (scope: 'active' | 'trash') => {
    if (scope === sessionScope) return
    setSessionScope(scope)
    setDraftOpen(false)
    setSessions(null)
    setSelectedSessionId(null)
    setSnapshot(null)
    setGoalPanelVersion(0)
    setGoalComposerMode(false)
    setGoalDialog(null)
    setReconcileTarget(null)
    setReconcileResolution(null)
    setReconcileNote('')
    setReconcileNotice(null)
    lastPositionedThread.current = null
  }

  const archivePendingSession = async () => {
    if (!pendingArchive) return
    setChangingSessionId(pendingArchive.id)
    try {
      await conversationApi.archiveSession(pendingArchive.id)
      setPendingArchive(null)
      await refreshSessions()
      setError(null)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setChangingSessionId(null)
    }
  }

  const restoreSession = async (session: CanonicalSessionDto) => {
    setChangingSessionId(session.id)
    try {
      await conversationApi.restoreSession(session.id)
      await refreshSessions()
      setError(null)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setChangingSessionId(null)
    }
  }

  const confirmGoalDialog = async () => {
    const current = snapshot?.goal ?? null
    if (goalDialog === 'create' || goalDialog === 'replace' || goalDialog === 'edit') {
      const objective = goalDraft.trim()
      if (objective) await saveGoalObjective(objective, goalDialog === 'replace')
      return
    }
    if (!current || !goalDialog) return
    const action: GoalAction = goalDialog === 'clear' ? 'clear' : 'resume'
    setGoalBusyAction(action)
    try {
      if (goalDialog === 'clear') {
        await conversationApi.clearGoal(current.id, current.revision)
      } else {
        const result = await conversationApi.setGoalStatus(current.id, {
          expectedRevision: current.revision,
          status: 'active',
          resetLimitCounters: true,
        })
        requireAppliedGoalStatus(result)
      }
      setGoalDialog(null)
      setError(null)
      await refreshThread()
    } catch (cause) {
      await refreshThread()
      setError(errorMessage(cause))
    } finally {
      setGoalBusyAction(null)
    }
  }

  const openReconciliation = (call: UnknownMutationCall) => {
    setReconcileTarget(call)
    setReconcileResolution(null)
    setReconcileNote('')
    setReconcileNotice(null)
  }

  const confirmReconciliation = async () => {
    if (!reconcileTarget || !reconcileResolution) return
    setReconcileBusy(true)
    try {
      await conversationApi.reconcileUnknownMutation(reconcileTarget.turnId, {
        callId: reconcileTarget.callId,
        resolution: reconcileResolution,
        ...(reconcileNote.trim() ? { note: reconcileNote.trim() } : {}),
      })
      await refreshThread()
      setReconcileTarget(null)
      setReconcileResolution(null)
      setReconcileNote('')
      setReconcileNotice(snapshot?.goal
        ? '결과 확인을 기록했습니다. 작업은 재실행되지 않았으며 Goal은 계속 정지되어 있습니다. 확인 후 직접 다시 시작하세요.'
        : '결과 확인을 기록했습니다. 작업은 재실행되지 않았으며 대화도 자동으로 재개되지 않습니다.')
      setError(null)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setReconcileBusy(false)
    }
  }

  const sidebar = (
    <SessionSidebar
      sessions={sessions}
      selectedSessionId={selectedSessionId}
      loading={loadingSessions}
      creating={submitting && isDraft}
      scope={sessionScope}
      preferences={viewPreferences}
      onSelect={selectSession}
      onCreate={() => {
        beginDraft()
      }}
      onRefresh={() => void refreshSessions()}
      onPreferencesChange={onViewPreferencesChange}
      onScopeChange={changeScope}
      onArchive={setPendingArchive}
      onRestore={(session) => void restoreSession(session)}
      onOpenImport={() => {
        setMobileSidebarOpen(false)
        setNativeImportOpen(true)
      }}
      onNavigate={(view) => {
        setMobileSidebarOpen(false)
        if (view === 'home') onNavigateHome()
        if (view === 'settings') onNavigateSettings()
      }}
    />
  )

  return (
    <section
      className="flex h-[calc(100vh-3.5rem-2px)] min-h-[32rem] overflow-hidden bg-background"
      aria-label="Baton 대화"
    >
      <aside className="hidden w-72 shrink-0 border-r border-sidebar-border md:block">
        {sidebar}
      </aside>

      <Dialog open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <DialogContent
          showCloseButton={false}
          className="left-0 top-0 h-dvh w-[min(20rem,88vw)] max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-y-0 border-l-0 p-0 md:hidden"
        >
          <DialogTitle className="sr-only">대화 목록</DialogTitle>
          <DialogDescription className="sr-only">Baton 세션을 선택하거나 새 대화를 시작합니다.</DialogDescription>
          {sidebar}
        </DialogContent>
      </Dialog>

      <NativeImportDialog
        open={nativeImportOpen}
        onOpenChange={setNativeImportOpen}
        onImported={refreshSessions}
      />

      <Dialog open={workspaceDialogOpen} onOpenChange={(open) => { if (!workspaceBusy) setWorkspaceDialogOpen(open) }}>
        <DialogContent className="max-w-md">
          <DialogTitle>프로젝트 폴더 {snapshot?.session.cwd ? '변경' : '연결'}</DialogTitle>
          <DialogDescription>
            원본 대화의 폴더는 제안값일 뿐입니다. 이 경로를 직접 확인하고 연결해야 Baton 파일 도구가 접근할 수 있습니다.
          </DialogDescription>
          {workspaceError ? <p role="alert" className="text-sm text-destructive">{workspaceError}</p> : null}
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">프로젝트 폴더</span>
            <div className="flex gap-2">
              <input
                value={workspaceCwd}
                onChange={(event) => setWorkspaceCwd(event.target.value)}
                placeholder="폴더를 선택하세요"
                autoFocus
                disabled={workspaceBusy || folderPickerBusy}
                className="min-w-0 flex-1 rounded-xl border bg-background px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button
                type="button"
                variant="outline"
                disabled={workspaceBusy || folderPickerBusy}
                onClick={() => void pickFolder('workspace')}
              >
                <FolderOpen aria-hidden />
                {folderPickerBusy ? '여는 중…' : '폴더 선택'}
              </Button>
            </div>
          </label>
          <div className="flex items-center justify-end gap-2">
            {snapshot?.session.cwd ? (
              <Button type="button" variant="destructive" className="mr-auto" disabled={workspaceBusy} onClick={() => void disconnectWorkspace()}>
                연결 해제
              </Button>
            ) : null}
            <Button type="button" variant="ghost" disabled={workspaceBusy} onClick={() => setWorkspaceDialogOpen(false)}>취소</Button>
            <Button type="button" disabled={workspaceBusy || !workspaceCwd.trim()} onClick={() => void connectWorkspace()}>
              {workspaceBusy ? '적용 중…' : snapshot?.session.cwd ? '변경' : '연결'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={pendingArchive !== null} onOpenChange={(open) => { if (!open) setPendingArchive(null) }}>
        <DialogContent className="max-w-sm">
          <DialogTitle>대화를 휴지통으로 이동할까요?</DialogTitle>
          <DialogDescription>
            30일 동안 휴지통에서 읽거나 복원할 수 있으며, 이후 자동으로 영구 삭제됩니다.
          </DialogDescription>
          <div className="mt-2 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setPendingArchive(null)}>취소</Button>
            <Button
              type="button"
              variant="destructive"
              disabled={changingSessionId === pendingArchive?.id}
              onClick={() => void archivePendingSession()}
            >
              <Trash2 aria-hidden />
              {changingSessionId === pendingArchive?.id ? '이동 중…' : '휴지통으로 이동'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={goalDialog !== null} onOpenChange={(open) => { if (!open && !goalBusyAction) setGoalDialog(null) }}>
        <DialogContent className="max-w-md">
          <DialogTitle>
            {goalDialog === 'create' ? 'Goal 만들기'
              : goalDialog === 'replace' ? '현재 Goal 바꾸기'
              : goalDialog === 'edit' ? 'Goal 수정'
                : goalDialog === 'resume' ? 'Goal 다시 시작'
                  : 'Goal 지우기'}
          </DialogTitle>
          <DialogDescription>
            {goalDialog === 'create'
              ? 'Baton이 이 목표를 대화의 정본으로 저장하고, 완료되거나 안전 한도에 도달할 때까지 이어서 실행합니다.'
              : goalDialog === 'edit' && snapshot?.goal
                ? goalEditDescription(snapshot.goal.status)
              : goalDialog === 'replace'
                ? '현재 Goal을 종료하고 새 Goal ID와 새 실행 한도로 교체합니다. 대화 기록은 그대로 남습니다.'
              : goalDialog === 'resume'
                ? '자동 실행 횟수와 활성 시간 카운터를 초기화하고 다시 진행합니다.'
                : 'Goal 상태만 지웁니다. 지금까지의 대화와 작업 기록은 남습니다.'}
          </DialogDescription>
          {goalDialog === 'create' || goalDialog === 'replace' || goalDialog === 'edit' ? (
            <div>
              <textarea
                value={goalDraft}
                onChange={(event) => setGoalDraft(limitGoalObjectiveDraft(event.target.value))}
                rows={5}
                autoFocus
                aria-label="Goal 내용"
                className="w-full resize-y rounded-xl border bg-background px-3 py-2 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="완료할 목표를 구체적으로 적어 주세요"
              />
              <p className="mt-1 text-right text-xs tabular-nums text-muted-foreground">
                {Array.from(goalDraft).length}/{GOAL_OBJECTIVE_MAX_CHARS}
              </p>
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={goalBusyAction !== null} onClick={() => setGoalDialog(null)}>취소</Button>
            <Button
              type="button"
              variant={goalDialog === 'clear' ? 'destructive' : 'default'}
              disabled={goalBusyAction !== null || ((goalDialog === 'create' || goalDialog === 'replace' || goalDialog === 'edit') && !goalDraft.trim())}
              onClick={() => void confirmGoalDialog()}
            >
              {goalBusyAction ? '처리 중…' : goalDialog === 'clear' ? 'Goal 지우기' : goalDialog === 'resume' ? '다시 시작' : goalDialog === 'replace' ? '교체하고 시작' : goalDialog === 'edit' ? '변경사항 저장' : '저장하고 시작'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={reconcileTarget !== null}
        onOpenChange={(open) => {
          if (!open && !reconcileBusy) {
            setReconcileTarget(null)
            setReconcileResolution(null)
            setReconcileNote('')
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogTitle>변경 작업 결과 확인</DialogTitle>
          <DialogDescription>
            Baton이 중단되기 전 실행한 {reconcileTarget?.toolName ?? '변경 작업'}의 결과를 확인해 주세요.
            이 확인 과정에서는 해당 작업을 다시 실행하지 않습니다.
          </DialogDescription>
          <fieldset className="space-y-2" disabled={reconcileBusy}>
            <legend className="sr-only">확인한 결과</legend>
            {([
              ['succeeded', '성공함', '의도한 변경이 실제로 완료된 것을 확인했습니다.'],
              ['failed', '실패함', '변경 작업이 완료되지 않은 것을 확인했습니다.'],
              ['unknown_acknowledged', '결과를 알 수 없음', '불확실성을 인지하고 기록만 남깁니다.'],
            ] as Array<[UnknownMutationResolution, string, string]>).map(([value, label, detail]) => (
              <label key={value} className="flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 hover:bg-muted/40">
                <input
                  type="radio"
                  name="unknown-mutation-resolution"
                  value={value}
                  checked={reconcileResolution === value}
                  onChange={() => setReconcileResolution(value)}
                  className="mt-1"
                />
                <span>
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{detail}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">메모 <span className="font-normal text-muted-foreground">(선택)</span></span>
            <textarea
              value={reconcileNote}
              onChange={(event) => setReconcileNote(event.target.value)}
              maxLength={500}
              rows={3}
              disabled={reconcileBusy}
              placeholder="확인한 상태를 짧게 기록하세요"
              className="w-full resize-y rounded-xl border bg-background px-3 py-2 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <p className="text-xs leading-5 text-muted-foreground">
            {snapshot?.goal
              ? '기록 후에도 Goal은 자동으로 다시 시작되지 않습니다. 상태를 검토한 뒤 Goal의 다시 시작 버튼을 직접 눌러야 합니다.'
              : '기록 후에도 대화는 자동으로 다시 시작되지 않습니다. 상태를 검토한 뒤 다음 요청을 직접 보내야 합니다.'}
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={reconcileBusy} onClick={() => setReconcileTarget(null)}>취소</Button>
            <Button
              type="button"
              disabled={reconcileBusy || reconcileResolution === null}
              onClick={() => void confirmReconciliation()}
            >
              {reconcileBusy ? '기록 중…' : '확인 결과 기록'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-3 sm:px-5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            onClick={() => setMobileSidebarOpen(true)}
            aria-label="대화 목록 열기"
          >
            <Menu aria-hidden />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold">
              {selectedSession?.title || selectedSession?.preview || (sessionScope === 'trash' ? '휴지통' : '새 대화')}
            </h1>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {sessionScope === 'trash'
              ? <span>읽기 전용</span>
              : isDraft ? <span>저장 전</span>
                : snapshot ? <SessionStatus status={snapshot.session.workStatus} /> : <span>준비됨</span>}
            {sessionScope === 'active' ? <Badge variant="secondary" className="hidden sm:inline-flex">{PROVIDER_NAME[provider]}</Badge> : null}
            {snapshot && sessionScope === 'active' ? (
              <Button type="button" variant="ghost" size="xs" onClick={openWorkspaceDialog}>
                <FolderOpen aria-hidden />
                {snapshot.session.cwd ? '폴더 연결됨' : '폴더 연결'}
              </Button>
            ) : null}
            {isDraft ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={folderPickerBusy || Boolean(draft?.frozenRequest)}
                onClick={() => void pickFolder('draft')}
              >
                <FolderOpen aria-hidden />
                {draft?.cwd ? '폴더 연결됨' : '폴더 선택'}
              </Button>
            ) : null}
          </div>
        </header>

        <div
          ref={transcriptScroller}
          className="min-h-0 flex-1 overflow-y-auto"
          onScroll={(event) => {
            followOutput.current = isNearScrollBottom(event.currentTarget)
          }}
        >
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 pb-8 pt-8 sm:px-6 sm:pt-12">
            {(error || latestTurnError) && (
              <div className="mb-6 space-y-2" aria-live="polite">
                {error && (
                  <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    {error}
                  </p>
                )}
                {latestTurnError && (
                  <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    {latestTurnError}
                  </p>
                )}
              </div>
            )}

            {reconcileNotice ? (
              <p className="mb-6 rounded-xl border border-ok/40 bg-ok/10 px-4 py-3 text-sm text-foreground" role="status">
                {reconcileNotice}
              </p>
            ) : null}

            {snapshot?.session.source && !snapshot.session.cwd ? (
              <section className="mb-6 flex items-center gap-3 rounded-xl border bg-muted/30 px-4 py-3">
                <FolderOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">가져온 대화에는 연결된 프로젝트 폴더가 없습니다.</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {snapshot.session.source.cwd ?? '원본 폴더를 확인할 수 없습니다.'}
                  </p>
                </div>
                <Button type="button" size="sm" variant="outline" onClick={openWorkspaceDialog}>폴더 연결</Button>
              </section>
            ) : null}

            {unknownMutations.length > 0 ? (
              <section className="mb-6 rounded-xl border border-warning/50 bg-warning/10 px-4 py-3" aria-label="결과를 확인해야 하는 변경 작업">
                <h2 className="text-sm font-semibold">변경 작업의 결과를 확인해야 합니다</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  중단 전에 시작된 변경 작업의 성공 여부가 기록되지 않았습니다. Baton은 안전을 위해 이를 자동으로 재실행하지 않습니다.
                </p>
                <div className="mt-3 space-y-2">
                  {unknownMutations.map((call) => (
                    <div key={`${call.turnId}:${call.callId}`} className="flex items-center gap-3 rounded-lg border bg-background/70 px-3 py-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{call.toolName}</span>
                      <Button type="button" variant="outline" size="xs" onClick={() => openReconciliation(call)}>
                        결과 확인
                      </Button>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {loadingThread && !snapshot ? (
              <p className="m-auto text-sm text-muted-foreground">대화를 불러오는 중…</p>
            ) : !snapshot ? (
              <div className="m-auto max-w-md py-16 text-center">
                <h2 className="text-2xl font-semibold tracking-tight">{sessionScope === 'trash' ? '휴지통이 비어 있습니다' : '무엇을 도와드릴까요?'}</h2>
                <p className="mt-3 text-sm text-muted-foreground">
                  {sessionScope === 'trash'
                    ? '삭제한 대화는 30일 동안 여기에 보관됩니다.'
                    : isDraft
                      ? draft?.cwd
                        ? `${draft.cwd}에서 파일 도구를 사용합니다. 첫 메시지를 보내면 대화가 저장됩니다.`
                        : '일반 대화로 시작합니다. 파일 도구가 필요하면 폴더를 선택하세요.'
                      : '왼쪽에서 대화를 선택하거나 새 대화를 시작하세요.'}
                </p>
              </div>
            ) : visibleEntries.length === 0 ? (
              <div className="m-auto max-w-md py-16 text-center">
                <h2 className="text-2xl font-semibold tracking-tight">무엇을 도와드릴까요?</h2>
                <p className="mt-3 text-sm text-muted-foreground">메시지를 입력해 대화를 시작하세요.</p>
              </div>
            ) : (
              <div>
                {visibleEntries.map(({ item, toolResult }, index) => {
                  const compact = isCompactTranscriptItem(item)
                  const previousCompact = index > 0 && isCompactTranscriptItem(visibleEntries[index - 1]!.item)
                  return (
                    <div key={item.id} className={cn(index > 0 && (compact && previousCompact ? 'mt-2' : 'mt-7'))}>
                      <ConversationItem
                        item={item}
                        toolResult={toolResult}
                        assistantLabelMode={viewPreferences.assistantLabel}
                        modelDisplayNames={modelDisplayNames}
                        turn={item.turnId ? turnsById.get(item.turnId) ?? null : null}
                      />
                    </div>
                  )
                })}
              </div>
            )}

            {latestUsage ? (
              <details className="mt-6 self-start text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none rounded-md px-1 py-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  최근 턴 사용량
                </summary>
                <p className="mt-1 px-1 font-mono">{latestUsage}</p>
              </details>
            ) : null}
          </div>
        </div>

        {sessionScope === 'trash' ? (
          <div className="shrink-0 border-t bg-muted/20 px-4 py-3 text-center text-xs text-muted-foreground">
            {selectedSession?.archivedAt
              ? `이 대화는 읽기 전용입니다. ${trashExpiryLabel(selectedSession.archivedAt)}`
              : '삭제한 대화는 30일 동안 복원할 수 있습니다.'}
          </div>
        ) : (
        <div className="shrink-0 bg-gradient-to-t from-background via-background to-background/0 px-3 pb-4 pt-2 sm:px-6 sm:pb-6">
          {visibleFollowUps.length > 0 ? (
            <section
              className="mx-auto mb-2 w-full max-w-3xl rounded-xl border bg-background/95 px-3 py-2 shadow-sm"
              aria-label="대기 중인 추가 요청"
            >
              <div className="mb-1 flex items-center gap-2 text-xs font-medium">
                <span>추가 요청</span>
                <span className="tabular-nums text-muted-foreground">{visibleFollowUps.length}</span>
              </div>
              <div className="space-y-1">
                {visibleFollowUps.map((followUp) => {
                  const presentation = followUpPresentation(followUp, activeTurn?.id ?? null)
                  return (
                    <div key={followUp.id} className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-1 text-xs">
                      <span className="w-5 shrink-0 text-right tabular-nums text-muted-foreground">{followUp.sequence}</span>
                      <span className="min-w-0 flex-1 truncate" title={followUpText(followUp)}>{followUpText(followUp)}</span>
                      <span className={cn(
                        'shrink-0 rounded-md px-1.5 py-0.5',
                        presentation.tone === 'warning' && 'bg-warning/15 text-warning-foreground',
                        presentation.tone === 'info' && 'bg-info/10 text-info',
                        presentation.tone === 'muted' && 'bg-muted text-muted-foreground',
                      )}>
                        {presentation.label}
                      </span>
                      {presentation.cancellable ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          disabled={cancellingFollowUpId === followUp.id}
                          onClick={() => void cancelFollowUp(followUp)}
                          aria-label={`추가 요청 ${followUp.sequence} 취소`}
                        >
                          ×
                        </Button>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </section>
          ) : null}
          {snapshot?.goal ? (
            <GoalControl
              key={`${snapshot.goal.id}:${goalPanelVersion}`}
              goal={snapshot.goal}
              busyAction={goalBusyAction === 'create' ? null : goalBusyAction}
              defaultExpanded={goalPanelVersion > 0}
              className="mx-auto mb-2 w-full max-w-3xl"
              onAction={(action) => { void applyGoalAction(action) }}
            />
          ) : null}
          {isDraft && draft?.deliveryUnknown ? (
            <p className="mx-auto mb-2 w-full max-w-3xl rounded-xl border border-warning/50 bg-warning/10 px-3 py-2 text-xs leading-5" role="status">
              첫 요청의 응답을 확인하지 못했습니다. 입력값을 고정했으며 다시 보내면 같은 요청으로 결과만 확인합니다.
            </p>
          ) : null}
          {isDraft && draft?.conflict ? (
            <div className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2">
              <p className="min-w-0 flex-1 text-xs leading-5">이 draft ID는 다른 요청에 이미 사용됐습니다.</p>
              <Button type="button" size="sm" variant="outline" onClick={discardConflictedDraft}>
                draft 폐기하고 새 대화
              </Button>
            </div>
          ) : null}
          <form
            className="mx-auto w-full max-w-3xl rounded-2xl border bg-background p-2 shadow-lg shadow-black/5"
            onSubmit={(event) => void startTurn(event)}
          >
            {goalComposerMode ? (
              <div className="flex items-center gap-2 px-2 pt-1 text-xs">
                <span className="rounded-md bg-info/10 px-2 py-1 font-medium text-info">Goal</span>
                <span className="text-muted-foreground">완료할 목표를 입력하세요</span>
                <span className="tabular-nums text-muted-foreground">
                  {Array.from(prompt).length}/{GOAL_OBJECTIVE_MAX_CHARS}
                </span>
                <button
                  type="button"
                  className="ml-auto rounded px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="Goal 입력 취소"
                  onClick={() => setGoalComposerMode(false)}
                >
                  ×
                </button>
              </div>
            ) : null}
            <textarea
              value={prompt}
              onChange={(event) => {
                const value = goalComposerMode
                  ? limitGoalObjectiveDraft(event.target.value)
                  : event.target.value
                setPrompt(value)
                if (isDraft) updateDraft({ message: value })
              }}
              onKeyDown={(event) => {
                const action = composerKeyAction({
                  key: event.key,
                  shiftKey: event.shiftKey,
                  isComposing: event.nativeEvent.isComposing,
                  keyCode: event.keyCode,
                })
                if (action !== 'submit') return
                event.preventDefault()
                if (canSubmit) event.currentTarget.form?.requestSubmit()
              }}
              rows={2}
              disabled={Boolean(isDraft && draft?.frozenRequest)}
              placeholder={goalComposerMode ? 'Goal 내용 입력' : activeTurn ? '추가 요청 보내기' : '메시지 보내기'}
              aria-label="메시지"
              aria-keyshortcuts="Enter Shift+Enter"
              className="max-h-48 min-h-14 w-full resize-none bg-transparent px-2 py-2 text-[0.9375rem] leading-6 text-foreground outline-none placeholder:text-muted-foreground"
            />

            <div className="flex flex-wrap items-center gap-2 px-1 pb-1">
              {isDraft ? (
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    title={draft?.cwd ?? '파일 도구는 폴더를 선택한 대화에서만 사용할 수 있습니다.'}
                    disabled={folderPickerBusy || Boolean(draft?.frozenRequest)}
                    onClick={() => void pickFolder('draft')}
                  >
                    <FolderOpen aria-hidden />
                    {folderPickerBusy ? '여는 중…' : draft?.cwd ? '폴더 변경' : '폴더 선택'}
                  </Button>
                  {draft?.cwd ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={Boolean(draft.frozenRequest)}
                      onClick={() => updateDraft({ cwd: null })}
                    >
                      일반 대화
                    </Button>
                  ) : null}
                </div>
              ) : !snapshot?.goal && !goalComposerMode ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    setPrompt((current) => limitGoalObjectiveDraft(current))
                    setGoalComposerMode(true)
                  }}
                >
                  Goal
                </Button>
              ) : null}
              <select
                value={model ? `${provider}:${model}` : ''}
                onChange={(event) => {
                  const separator = event.target.value.indexOf(':')
                  if (separator < 0) return
                  const nextProvider = event.target.value.slice(0, separator) as CanonicalProvider
                  if (!PROVIDERS.includes(nextProvider)) return
                  const nextModel = event.target.value.slice(separator + 1)
                  const next = catalogs[nextProvider]?.models.find((option) => option.id === nextModel) ?? null
                  if (!next) return
                  setProvider(nextProvider)
                  setModel(next.id)
                  setEffort(next?.defaultEffort ?? null)
                  if (isDraft) updateDraft({
                    provider: nextProvider,
                    model: next.id,
                    effort: next.defaultEffort ?? null,
                  })
                }}
                disabled={Boolean(activeTurn) || Boolean(isDraft && draft?.frozenRequest) || PROVIDERS.every((candidate) => (catalogs[candidate]?.models.length ?? 0) === 0)}
                aria-label="모델"
                className="min-w-0 max-w-64 rounded-lg border-0 bg-muted/70 px-2 py-1.5 text-xs font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {!model ? <option value="">모델 불러오는 중…</option> : null}
                  {frozenModelMissing && frozenDraftRequest ? (
                    <option value={`${frozenDraftRequest.provider}:${frozenDraftRequest.model}`}>
                      {frozenDraftRequest.model}
                    </option>
                  ) : null}
                {PROVIDERS.map((candidate) => {
                  const catalog = catalogs[candidate]
                  const unavailable = catalog !== null && catalog.models.length === 0
                  return (
                    <optgroup
                      key={candidate}
                      label={`${PROVIDER_NAME[candidate]}${unavailable ? ' · 사용 불가' : ''}`}
                      disabled={catalog === null || unavailable}
                    >
                      {(catalog?.models ?? []).map((option) => (
                        <option key={option.id} value={`${candidate}:${option.id}`}>
                          {option.displayName}
                        </option>
                      ))}
                    </optgroup>
                  )
                })}
              </select>

              {(selectedModel && selectedModel.effortLevels.length > 0) || (frozenDraftRequest && effort) ? (
                <select
                  value={effort ?? ''}
                  onChange={(event) => {
                    const nextEffort = event.target.value || null
                    setEffort(nextEffort)
                    if (isDraft) updateDraft({ effort: nextEffort })
                  }}
                  disabled={Boolean(activeTurn) || Boolean(isDraft && draft?.frozenRequest)}
                  aria-label="Reasoning effort"
                  className="rounded-lg border-0 bg-muted/70 px-2 py-1.5 text-xs text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {(selectedModel?.effortLevels.length
                    ? selectedModel.effortLevels
                    : effort ? [effort] : []).map((level) => (
                    <option key={level} value={level}>{EFFORT_NAME[level] ?? level}</option>
                  ))}
                </select>
              ) : null}

              <ProviderAccountDisclosure
                provider={provider}
                accounts={accounts}
                policy={policy}
                strategy={routingStrategy}
              />

              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {activeTurn ? '응답 생성 중 · 추가 요청 가능' : ''}
              </span>

              <Button
                type="submit"
                size="icon-sm"
                disabled={!canSubmit}
                aria-label={isDraft && draft?.deliveryUnknown ? '같은 첫 요청 다시 확인' : activeTurn ? '추가 요청 보내기' : '메시지 보내기'}
              >
                <Send aria-hidden />
              </Button>
              {activeTurn ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="icon-sm"
                  disabled={cancelling}
                  onClick={() => void cancelTurn()}
                  aria-label="응답 중지"
                >
                  <Square className="size-3 fill-current" aria-hidden />
                </Button>
              ) : null}
            </div>
          </form>
          {modelCatalogErrors[provider] ? (
            <p className="mx-auto mt-2 max-w-3xl px-2 text-xs text-destructive">
              모델 목록을 불러오지 못했습니다: {modelCatalogErrors[provider]}
            </p>
          ) : null}
        </div>
        )}
      </div>
    </section>
  )
}

function isCompactTranscriptItem(item: { kind: string }): boolean {
  return item.kind === 'tool_call'
    || item.kind === 'tool_result'
    || item.kind === 'file_change'
    || item.kind === 'provider_event'
    || item.kind === 'reasoning_summary'
}
