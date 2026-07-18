import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, RefreshCw, Send, Square } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'

import { ConversationApiError, conversationApi } from './api'
import { composerKeyAction } from './composer-keyboard'
import { ConversationItem } from './ConversationItem'
import type {
  CanonicalProvider,
  CanonicalSessionDto,
  CanonicalTurnDto,
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

export function ConversationWorkspace() {
  const [sessions, setSessions] = useState<CanonicalSessionDto[] | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<ThreadSnapshotDto | null>(null)
  const [title, setTitle] = useState('')
  const provider: CanonicalProvider = 'codex'
  const [model, setModel] = useState('')
  const [models, setModels] = useState<string[] | null>(null)
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [loadingThread, setLoadingThread] = useState(false)
  const [creating, setCreating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const threadRequest = useRef(0)

  const selectedSession = useMemo(
    () => sessions?.find((session) => session.id === selectedSessionId) ?? null,
    [selectedSessionId, sessions],
  )
  const threadId = selectedSession?.activeThreadId ?? null

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
    try {
      const catalog = await conversationApi.listModels(provider)
      setModels(catalog.models)
      setModel((current) => {
        if (catalog.models.includes(current)) return current
        return catalog.defaultModel ?? catalog.models[0] ?? ''
      })
      setModelCatalogError(null)
    } catch (cause) {
      setModels([])
      setModelCatalogError(errorMessage(cause))
    }
  }, [provider])

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
  const stream = useConversationEvents(threadId, onStreamEvent)

  const createSession = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setCreating(true)
    try {
      const created = await conversationApi.createSession({ title: title.trim() || null })
      setSessions((current) => [created, ...(current ?? []).filter((item) => item.id !== created.id)])
      setSelectedSessionId(created.id)
      setTitle('')
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
    snapshot &&
      snapshot.thread.status === 'idle' &&
      prompt.trim() &&
      model.trim() &&
      !submitting,
  )

  return (
    <section className="space-y-3" aria-labelledby="canonical-runtime-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 id="canonical-runtime-title" className="text-sm font-semibold text-foreground">
              Canonical conversation runtime
            </h2>
            <Badge variant="outline">Preview</Badge>
          </div>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            대화의 정본은 Baton이 보관하며, 선택한 provider는 현재 턴만 실행합니다.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loadingSessions}
          onClick={() => void refreshSessions()}
        >
          <RefreshCw className={loadingSessions ? 'animate-spin' : ''} aria-hidden />
          새로고침
        </Button>
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {latestTurnError && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          마지막 턴 실패: {latestTurnError}
        </p>
      )}

      <div className="grid gap-4 min-[800px]:grid-cols-[15rem_minmax(0,1fr)]">
        <Card className="gap-4 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">Baton 세션</CardTitle>
            <CardDescription>Provider와 무관한 대화 목록</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 px-4">
            <form className="flex gap-2" onSubmit={(event) => void createSession(event)}>
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="새 세션 제목"
                aria-label="새 세션 제목"
              />
              <Button type="submit" size="icon-sm" disabled={creating} aria-label="세션 만들기">
                <Plus aria-hidden />
              </Button>
            </form>

            <div className="space-y-1">
              {sessions === null ? (
                <p className="py-4 text-center text-xs text-muted-foreground">세션을 불러오는 중입니다.</p>
              ) : sessions.length === 0 ? (
                <p className="rounded-md border border-dashed px-2 py-4 text-center text-xs text-muted-foreground">
                  아직 Baton 세션이 없습니다.
                </p>
              ) : (
                sessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => setSelectedSessionId(session.id)}
                    className={`w-full rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                      session.id === selectedSessionId
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-transparent text-muted-foreground hover:border-border hover:bg-accent'
                    }`}
                  >
                    <span className="block truncate font-medium">
                      {session.title || session.preview || '제목 없는 세션'}
                    </span>
                    <span className="block truncate text-xs opacity-70">{session.id}</span>
                  </button>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0 gap-4 py-4">
          <CardHeader className="px-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <CardTitle className="text-sm">
                  {selectedSession?.title || selectedSession?.preview || '대화를 선택하세요'}
                </CardTitle>
                <CardDescription className="mt-1">
                  {snapshot
                    ? `정본 revision ${snapshot.thread.revision} · ${snapshot.thread.status}`
                    : '세션의 active thread를 불러옵니다.'}
                </CardDescription>
              </div>
              <Badge variant={stream.status === 'open' ? 'secondary' : 'outline'}>
                SSE {stream.status} · cursor {stream.lastSequence}
              </Badge>
            </div>
          </CardHeader>

          <CardContent className="space-y-4 px-4">
            <div className="max-h-96 space-y-2 overflow-y-auto rounded-md border bg-muted/20 p-3">
              {loadingThread && !snapshot ? (
                <p className="py-8 text-center text-sm text-muted-foreground">정본 기록을 재생하는 중입니다.</p>
              ) : !snapshot ? (
                <p className="py-8 text-center text-sm text-muted-foreground">표시할 대화를 선택하세요.</p>
              ) : snapshot.items.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">첫 메시지를 입력해 대화를 시작하세요.</p>
              ) : (
                snapshot.items.map((item) => <ConversationItem key={item.id} item={item} />)
              )}
            </div>

            <form className="space-y-3" onSubmit={(event) => void startTurn(event)}>
              <div className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
                <label className="space-y-1 text-xs text-muted-foreground">
                  Provider
                  <select
                    value={provider}
                    disabled
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    <option value="codex">Codex</option>
                  </select>
                  <span className="block">Claude·Gemini adapter는 준비 중입니다.</span>
                </label>
                <label className="space-y-1 text-xs text-muted-foreground">
                  Model
                  <select
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    disabled={models === null || models.length === 0}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    {models === null ? (
                      <option value="">모델 목록을 불러오는 중…</option>
                    ) : models.length === 0 ? (
                      <option value="">사용 가능한 모델 없음</option>
                    ) : (
                      models.map((modelId) => <option key={modelId} value={modelId}>{modelId}</option>)
                    )}
                  </select>
                  <span className="block">
                    {modelCatalogError
                      ? `목록 조회 실패: ${modelCatalogError}`
                      : '현재 CLIProxy가 제공하는 Codex 모델입니다.'}
                  </span>
                </label>
              </div>

              <label className="block space-y-1 text-xs text-muted-foreground">
                현재 턴 입력
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
                  rows={4}
                  placeholder="Baton 정본에 추가하고 선택한 provider로 실행할 메시지"
                  aria-keyshortcuts="Enter Shift+Enter"
                  className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
                <span className="block">Enter 전송 · Shift+Enter 줄바꿈</span>
              </label>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  {snapshot?.thread.status === 'running'
                    ? '현재 턴이 끝난 뒤 다음 provider를 선택할 수 있습니다.'
                    : 'Provider 선택은 세션 소유권을 바꾸지 않습니다.'}
                </p>
                <div className="flex gap-2">
                  {activeTurn && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={cancelling}
                      onClick={() => void cancelTurn()}
                    >
                      <Square aria-hidden />
                      턴 취소
                    </Button>
                  )}
                  <Button type="submit" size="sm" disabled={!canSubmit}>
                    <Send aria-hidden />
                    {submitting ? '시작 중' : '턴 실행'}
                  </Button>
                </div>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </section>
  )
}
