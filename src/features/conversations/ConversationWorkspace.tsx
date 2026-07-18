import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { latestUsageSummary, transcriptItems } from './conversation-presentation'
import { NativeImportDialog } from './NativeImportDialog'
import { ProviderAccountDisclosure } from './ProviderAccountDisclosure'
import {
  groupSessions,
  loadSessionViewPreferences,
  saveSessionViewPreferences,
  type AssistantLabelMode,
  type SessionGroupMode,
  type SessionViewPreferences,
} from './session-view-preferences'
import type {
  CanonicalProvider,
  CanonicalSessionDto,
  CanonicalTurnDto,
  ProviderModelDescriptorDto,
  ThreadSnapshotDto,
} from './types'
import { useConversationEvents } from './useConversationEvents'

function errorMessage(error: unknown): string {
  if (error instanceof ConversationApiError) return error.message
  return error instanceof Error ? error.message : String(error)
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

interface ModelCatalogState {
  models: ProviderModelDescriptorDto[]
  defaultModel: string | null
}

function SessionSidebar({
  sessions,
  selectedSessionId,
  loading,
  creating,
  preferences,
  onSelect,
  onCreate,
  onRefresh,
  onPreferencesChange,
  onOpenImport,
  onNavigate,
}: {
  sessions: CanonicalSessionDto[] | null
  selectedSessionId: string | null
  loading: boolean
  creating: boolean
  preferences: SessionViewPreferences
  onSelect: (sessionId: string) => void
  onCreate: () => void
  onRefresh: () => void
  onPreferencesChange: (preferences: SessionViewPreferences) => void
  onOpenImport: () => void
  onNavigate: (view: AppView) => void
}) {
  const groups = sessions ? groupSessions(sessions, preferences.groupBy) : []
  const collapsed = new Set(preferences.collapsedGroups)
  const setGroupBy = (groupBy: SessionGroupMode) => onPreferencesChange({ ...preferences, groupBy })
  const setAssistantLabel = (assistantLabel: AssistantLabelMode) => onPreferencesChange({
    ...preferences,
    assistantLabel,
  })
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
          onClick={onCreate}
        >
          <MessageSquarePlus aria-hidden />
          새 대화
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
        <div className="flex shrink-0 items-center justify-between px-2 py-2">
          <span className="text-xs font-medium text-muted-foreground">최근 대화</span>
          <div className="flex items-center">
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
                  <legend className="px-2 pb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">응답 이름</legend>
                  {([
                    ['provider', 'Provider 이름'],
                    ['assistant', 'Assistant'],
                    ['both', '둘 다'],
                  ] as Array<[AssistantLabelMode, string]>).map(([value, label]) => (
                    <label key={value} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent">
                      <input type="radio" name="assistant-label-mode" checked={preferences.assistantLabel === value} onChange={() => setAssistantLabel(value)} />
                      {label}
                    </label>
                  ))}
                </fieldset>
                <div className="my-2 border-t" />
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
                  onClick={(event) => {
                    event.currentTarget.closest('details')?.removeAttribute('open')
                    onOpenImport()
                  }}
                >
                  <Download className="size-3.5" aria-hidden />
                  Native 작업 가져오기
                </button>
              </div>
            </details>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {sessions === null ? (
            <p className="px-2 py-4 text-xs text-muted-foreground">불러오는 중…</p>
          ) : sessions.length === 0 ? (
            <p className="px-2 py-4 text-xs leading-relaxed text-muted-foreground">
              아직 대화가 없습니다.
            </p>
          ) : (
            groups.map((group) => preferences.groupBy === 'none' ? (
              group.sessions.map((session) => (
                <SessionButton key={session.id} session={session} selected={session.id === selectedSessionId} onSelect={onSelect} />
              ))
            ) : (
              <section key={group.id} className="pb-2 pt-1 first:pt-0">
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
                  <div className="ml-3 mt-0.5 space-y-0.5 border-l border-sidebar-border pl-1.5">
                    {group.sessions.map((session) => (
                      <SessionButton key={session.id} session={session} selected={session.id === selectedSessionId} onSelect={onSelect} nested />
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
  nested = false,
}: {
  session: CanonicalSessionDto
  selected: boolean
  onSelect: (sessionId: string) => void
  nested?: boolean
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(session.id)}
      className={cn(
        'w-full text-left text-sm transition-colors',
        nested ? 'rounded-md px-2.5 py-2' : 'rounded-lg px-3 py-2.5',
        selected
          ? 'bg-sidebar-accent text-sidebar-accent-foreground shadow-sm ring-1 ring-sidebar-border/70'
          : 'text-sidebar-foreground/75 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground',
      )}
    >
      <span className="block truncate font-medium">
        {session.title || session.source?.sourceAlias || session.preview || '새 대화'}
      </span>
      {session.title && session.preview ? (
        <span className="mt-0.5 block truncate text-xs opacity-70">{session.preview}</span>
      ) : null}
    </button>
  )
}

export function ConversationWorkspace({
  onNavigateHome,
  onNavigateSettings,
  accounts,
  policy,
  routingStrategy,
}: {
  onNavigateHome: () => void
  onNavigateSettings: () => void
  accounts: Record<string, Account[]> | null
  policy: PolicyState | null
  routingStrategy: RoutingStrategyName | null
}) {
  const [sessions, setSessions] = useState<CanonicalSessionDto[] | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<ThreadSnapshotDto | null>(null)
  const [provider, setProvider] = useState<CanonicalProvider>('codex')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<string | null>('high')
  const [catalogs, setCatalogs] = useState<Record<CanonicalProvider, ModelCatalogState | null>>({
    codex: null,
    claude: null,
    gemini: null,
  })
  const [modelCatalogErrors, setModelCatalogErrors] = useState<Partial<Record<CanonicalProvider, string>>>({})
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [loadingThread, setLoadingThread] = useState(false)
  const [creating, setCreating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [nativeImportOpen, setNativeImportOpen] = useState(false)
  const [viewPreferences, setViewPreferences] = useState(loadSessionViewPreferences)
  const threadRequest = useRef(0)

  const selectedSession = useMemo(
    () => sessions?.find((session) => session.id === selectedSessionId) ?? null,
    [selectedSessionId, sessions],
  )
  const threadId = selectedSession?.activeThreadId ?? null
  const currentCatalog = catalogs[provider]
  const models = currentCatalog?.models ?? null
  const selectedModel = models?.find((option) => option.id === model) ?? null

  const refreshSessions = useCallback(async () => {
    setLoadingSessions(true)
    try {
      const result = await conversationApi.listSessions()
      setSessions(result)
      setSelectedSessionId((current) => {
        if (current && result.some((session) => session.id === current)) return current
        return result[0]?.id ?? null
      })
      setError(null)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoadingSessions(false)
    }
  }, [])

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
    if (!currentCatalog) return
    const option = currentCatalog.models.find((candidate) => candidate.id === model)
      ?? currentCatalog.models.find((candidate) => candidate.id === currentCatalog.defaultModel)
      ?? currentCatalog.models[0]
      ?? null
    setModel(option?.id ?? '')
    setEffort(option?.defaultEffort ?? null)
  }, [currentCatalog, model, provider])

  const refreshThread = useCallback(async () => {
    const requestId = ++threadRequest.current
    if (!threadId) {
      setSnapshot(null)
      setLoadingThread(false)
      return
    }
    setLoadingThread(true)
    try {
      const result = await conversationApi.getThread(threadId)
      if (requestId === threadRequest.current) {
        setSnapshot(result)
        setError(null)
      }
    } catch (cause) {
      if (requestId === threadRequest.current) setError(errorMessage(cause))
    } finally {
      if (requestId === threadRequest.current) setLoadingThread(false)
    }
  }, [threadId])

  useEffect(() => {
    void refreshSessions()
  }, [refreshSessions])

  useEffect(() => {
    saveSessionViewPreferences(viewPreferences)
  }, [viewPreferences])

  useEffect(() => {
    void refreshModels()
  }, [refreshModels])

  useEffect(() => {
    void refreshThread()
    return () => {
      threadRequest.current += 1
    }
  }, [refreshThread])

  const onStreamEvent = useCallback(() => {
    void refreshThread()
  }, [refreshThread])
  useConversationEvents(threadId, onStreamEvent)

  const createSession = async () => {
    setCreating(true)
    try {
      const created = await conversationApi.createSession({ title: null })
      setSessions((current) => [created, ...(current ?? []).filter((item) => item.id !== created.id)])
      setSelectedSessionId(created.id)
      setMobileSidebarOpen(false)
      setError(null)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setCreating(false)
    }
  }

  const startTurn = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!snapshot || !prompt.trim() || !model.trim()) return
    setSubmitting(true)
    try {
      await conversationApi.startTurn(snapshot.thread.id, {
        provider,
        model: model.trim(),
        effort,
        clientRequestId: crypto.randomUUID(),
        expectedRevision: snapshot.thread.revision,
        input: [
          {
            kind: 'user_message',
            visibility: 'portable',
            payload: { text: prompt.trim() },
          },
        ],
      })
      setPrompt('')
      setError(null)
      await refreshThread()
    } catch (cause) {
      setError(errorMessage(cause))
      await refreshThread()
    } finally {
      setSubmitting(false)
    }
  }

  const activeTurn = snapshot ? latestActiveTurn(snapshot.turns) : null
  const latestTurn = snapshot?.turns.at(-1) ?? null
  const latestUsage = latestUsageSummary(snapshot?.turns ?? [])
  const visibleItems = transcriptItems(snapshot?.items ?? [])
  const latestTurnError = latestTurn?.status === 'failed' && latestTurn.error
    ? typeof latestTurn.error.message === 'string'
      ? latestTurn.error.message
      : JSON.stringify(latestTurn.error)
    : null

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

  const canSubmit = Boolean(
    snapshot
      && snapshot.thread.status === 'idle'
      && prompt.trim()
      && model.trim()
      && !submitting,
  )

  const selectSession = (sessionId: string) => {
    setSelectedSessionId(sessionId)
    setMobileSidebarOpen(false)
  }

  const sidebar = (
    <SessionSidebar
      sessions={sessions}
      selectedSessionId={selectedSessionId}
      loading={loadingSessions}
      creating={creating}
      preferences={viewPreferences}
      onSelect={selectSession}
      onCreate={() => void createSession()}
      onRefresh={() => void refreshSessions()}
      onPreferencesChange={setViewPreferences}
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
              {selectedSession?.title || selectedSession?.preview || '새 대화'}
            </h1>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span
              className={cn(
                'size-1.5 rounded-full',
                snapshot?.thread.status === 'running' ? 'animate-pulse bg-ok' : 'bg-muted-foreground/50',
              )}
              aria-hidden
            />
            <span>{snapshot?.thread.status === 'running' ? '응답 중' : '준비됨'}</span>
            <Badge variant="secondary" className="hidden sm:inline-flex">{PROVIDER_NAME[provider]}</Badge>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
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

            {loadingThread && !snapshot ? (
              <p className="m-auto text-sm text-muted-foreground">대화를 불러오는 중…</p>
            ) : !snapshot ? (
              <div className="m-auto max-w-md py-16 text-center">
                <h2 className="text-2xl font-semibold tracking-tight">무엇을 도와드릴까요?</h2>
                <p className="mt-3 text-sm text-muted-foreground">
                  왼쪽에서 대화를 선택하거나 새 대화를 시작하세요.
                </p>
              </div>
            ) : visibleItems.length === 0 ? (
              <div className="m-auto max-w-md py-16 text-center">
                <h2 className="text-2xl font-semibold tracking-tight">무엇을 도와드릴까요?</h2>
                <p className="mt-3 text-sm text-muted-foreground">메시지를 입력해 대화를 시작하세요.</p>
              </div>
            ) : (
              <div className="space-y-7">
                {visibleItems.map((item) => (
                  <ConversationItem key={item.id} item={item} assistantLabelMode={viewPreferences.assistantLabel} />
                ))}
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

        <div className="shrink-0 bg-gradient-to-t from-background via-background to-background/0 px-3 pb-4 pt-2 sm:px-6 sm:pb-6">
          <form
            className="mx-auto w-full max-w-3xl rounded-2xl border bg-background p-2 shadow-lg shadow-black/5"
            onSubmit={(event) => void startTurn(event)}
          >
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
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
              placeholder="메시지 보내기"
              aria-label="메시지"
              aria-keyshortcuts="Enter Shift+Enter"
              className="max-h-48 min-h-14 w-full resize-none bg-transparent px-2 py-2 text-[0.9375rem] leading-6 text-foreground outline-none placeholder:text-muted-foreground"
            />

            <div className="flex flex-wrap items-center gap-2 px-1 pb-1">
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
                }}
                disabled={PROVIDERS.every((candidate) => (catalogs[candidate]?.models.length ?? 0) === 0)}
                aria-label="모델"
                className="min-w-0 max-w-64 rounded-lg border-0 bg-muted/70 px-2 py-1.5 text-xs font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              >
                {!model ? <option value="">모델 불러오는 중…</option> : null}
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

              {selectedModel && selectedModel.effortLevels.length > 0 ? (
                <select
                  value={effort ?? ''}
                  onChange={(event) => setEffort(event.target.value || null)}
                  aria-label="Reasoning effort"
                  className="rounded-lg border-0 bg-muted/70 px-2 py-1.5 text-xs text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {selectedModel.effortLevels.map((level) => (
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
                {snapshot?.thread.status === 'running' ? '응답을 생성하고 있습니다' : ''}
              </span>

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
              ) : (
                <Button type="submit" size="icon-sm" disabled={!canSubmit} aria-label="메시지 보내기">
                  <Send aria-hidden />
                </Button>
              )}
            </div>
          </form>
          {modelCatalogErrors[provider] ? (
            <p className="mx-auto mt-2 max-w-3xl px-2 text-xs text-destructive">
              모델 목록을 불러오지 못했습니다: {modelCatalogErrors[provider]}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  )
}
