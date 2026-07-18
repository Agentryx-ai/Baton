import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight, Database, LoaderCircle, RotateCcw, Search } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

import { ConversationApiError, conversationApi } from './api'
import {
  boundedPage,
  filterNativeImportCandidates,
  isSelectableNativeCandidate,
  NATIVE_IMPORT_MAX_SELECTION,
  NATIVE_IMPORT_PAGE_SIZE,
  withNativeCandidateSelection,
} from './session-view-preferences'
import type {
  CodexNativeOrigin,
  CodexNativeScanFilter,
  NativeImportCandidateDto,
  NativeImportCandidateStatus,
  NativeImportCommitDto,
  NativeImportSourceClient,
  NativeImportPreviewDto,
} from './types'

const SOURCES: Array<{ value: NativeImportSourceClient; label: string }> = [
  { value: 'codex_local', label: 'Codex 로컬' },
  { value: 'claude_desktop', label: 'Claude Desktop' },
  { value: 'claude_code', label: 'Claude Code' },
]

const CODEX_ORIGINS: Array<{
  value: Exclude<CodexNativeOrigin, 'subagent'>
  label: string
}> = [
  { value: 'cli', label: 'CLI' },
  { value: 'ide_app', label: 'Desktop · IDE' },
  { value: 'exec', label: 'Exec' },
  { value: 'other', label: '기타' },
]

const STATUS_LABEL: Record<NativeImportCandidateStatus, string> = {
  new: '새 작업',
  existing: '가져온 기록 · 확인 필요',
  update_available: '업데이트',
  duplicate: '이미 가져옴',
  unavailable: '읽을 수 없음',
  unsupported: '지원하지 않음',
}

function messageOf(error: unknown): string {
  if (error instanceof ConversationApiError) return error.message
  return error instanceof Error ? error.message : String(error)
}

export function NativeImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: () => void | Promise<void>
}) {
  const [sources, setSources] = useState<NativeImportSourceClient[]>(['codex_local', 'claude_desktop'])
  const [codexOrigins, setCodexOrigins] = useState<CodexNativeScanFilter['origins']>(['cli', 'ide_app'])
  const [includeCodexSubagents, setIncludeCodexSubagents] = useState(false)
  const [includeCodexArchived, setIncludeCodexArchived] = useState(false)
  const [preview, setPreview] = useState<NativeImportPreviewDto | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [acknowledged, setAcknowledged] = useState(false)
  const [result, setResult] = useState<NativeImportCommitDto | null>(null)
  const [scanning, setScanning] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [resultPage, setResultPage] = useState(1)
  const [confirmBulkSelection, setConfirmBulkSelection] = useState(false)

  useEffect(() => {
    if (open) return
    setPreview(null)
    setSelected(new Set())
    setAcknowledged(false)
    setResult(null)
    setError(null)
    setQuery('')
    setPage(1)
    setResultPage(1)
    setConfirmBulkSelection(false)
  }, [open])

  const filteredCandidates = useMemo(
    () => filterNativeImportCandidates(preview?.candidates ?? [], query),
    [preview, query],
  )
  const candidatePage = useMemo(
    () => boundedPage(filteredCandidates, page, NATIVE_IMPORT_PAGE_SIZE),
    [filteredCandidates, page],
  )
  const visibleSelectable = useMemo(
    () => candidatePage.items.filter(isSelectableNativeCandidate),
    [candidatePage.items],
  )
  const bulkSelectionCandidates = useMemo(
    () => (query.trim() ? filteredCandidates : preview?.candidates ?? []).filter(isSelectableNativeCandidate),
    [filteredCandidates, preview, query],
  )
  const bulkSelectionAllowed = bulkSelectionCandidates.length <= NATIVE_IMPORT_MAX_SELECTION
  const warnings = useMemo(() => preview ? [...new Set(preview.warnings)] : [], [preview])
  const candidateWarningCount = useMemo(
    () => preview?.candidates.reduce((sum, candidate) => sum + candidate.warningCount, 0) ?? 0,
    [preview],
  )
  const resultRows = useMemo(
    () => boundedPage(result?.results ?? [], resultPage, NATIVE_IMPORT_PAGE_SIZE),
    [result, resultPage],
  )
  const candidateNames = useMemo(
    () => new Map(preview?.candidates.map((candidate) => [candidate.id, candidate.sourceAlias]) ?? []),
    [preview],
  )
  const codexScopeValid = !sources.includes('codex_local') || codexOrigins.length > 0

  const scan = async () => {
    if (sources.length === 0 || !codexScopeValid) return
    setScanning(true)
    setError(null)
    setResult(null)
    setAcknowledged(false)
    try {
      const next = await conversationApi.previewNativeImport(sources, {
        origins: codexOrigins,
        includeSubagents: includeCodexSubagents,
        includeArchived: includeCodexArchived,
      })
      setPreview(next)
      setSelected(new Set())
      setQuery('')
      setPage(1)
      setResultPage(1)
      setConfirmBulkSelection(false)
    } catch (cause) {
      setPreview(null)
      setSelected(new Set())
      setError(messageOf(cause))
    } finally {
      setScanning(false)
    }
  }

  const commit = async () => {
    if (!preview || selected.size === 0 || !acknowledged) return
    setCommitting(true)
    setError(null)
    try {
      const next = await conversationApi.commitNativeImport(preview.token, [...selected])
      setResult(next)
      setResultPage(1)
      if (next.summary.imported > 0 || next.summary.updated > 0) await onImported()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setCommitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Native 작업 가져오기</DialogTitle>
          <DialogDescription>
            로컬 Codex·Claude 작업을 먼저 읽기 전용으로 검색한 뒤 선택한 복사본만 Baton에 만듭니다.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
          {!preview && !result ? (
            <section className="space-y-3" aria-label="검색할 원본">
              <p className="text-sm font-medium">검색할 원본</p>
              <div className="grid gap-2 sm:grid-cols-3">
                {SOURCES.map((source) => (
                  <label key={source.value} className="flex items-center gap-2 rounded-lg border p-3 text-sm">
                    <input
                      type="checkbox"
                      checked={sources.includes(source.value)}
                      onChange={(event) => setSources((current) => event.target.checked
                        ? [...current, source.value]
                        : current.filter((value) => value !== source.value))}
                    />
                    {source.label}
                  </label>
                ))}
              </div>
              {sources.includes('codex_local') ? (
                <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs font-medium">Codex 로컬 범위</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
                    {CODEX_ORIGINS.map((origin) => (
                      <label key={origin.value} className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={codexOrigins.includes(origin.value)}
                          onChange={(event) => setCodexOrigins((current) => event.target.checked
                            ? [...current, origin.value]
                            : current.filter((value) => value !== origin.value))}
                        />
                        {origin.label}
                      </label>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
                    <label className="flex items-center gap-1.5">
                      <input type="checkbox" checked={includeCodexSubagents}
                        onChange={(event) => setIncludeCodexSubagents(event.target.checked)} />
                      내부 subagent 포함
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input type="checkbox" checked={includeCodexArchived}
                        onChange={(event) => setIncludeCodexArchived(event.target.checked)} />
                      아카이브 포함
                    </label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    기본값은 활성 CLI와 Desktop · IDE 작업만 표시합니다. Exec, subagent, 아카이브는 필요할 때만 포함하세요.
                  </p>
                  {!codexScopeValid ? <p className="text-xs text-destructive">하나 이상의 Codex 출처를 선택하세요.</p> : null}
                </div>
              ) : null}
              <p className="text-xs leading-relaxed text-muted-foreground">
                검색은 원본 파일을 수정하지 않습니다. 원격 Claude 채팅처럼 로컬 transcript가 없는 세션은 가져올 수 없습니다.
              </p>
            </section>
          ) : null}

          {preview && !result ? (
            <>
              <section className="rounded-lg border bg-muted/20 p-3 text-sm">
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span>발견 {preview.summary.total}개</span>
                  <span>신규 {preview.summary.new}개</span>
                  {preview.summary.existing > 0 ? <span>기존 기록 {preview.summary.existing}개</span> : null}
                  <span>업데이트 {preview.summary.updateAvailable}개</span>
                  <span>중복 {preview.summary.duplicate}개</span>
                  {preview.summary.analysisPending ? <span>항목 수는 선택 후 분석</span> : (
                    <span>가져올 항목 {preview.summary.portableItems}개</span>
                  )}
                  {!preview.summary.analysisPending && preview.summary.skippedItems > 0 ? (
                    <span className="text-warn">제외 {preview.summary.skippedItems}개</span>
                  ) : null}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">미리보기 만료: {formatDate(preview.expiresAt)}</p>
              </section>

              {warnings.length > 0 || candidateWarningCount > 0 ? (
                <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm text-warn">
                  <div className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4" />주의</div>
                  {warnings.length > 0 ? (
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                      {warnings.slice(0, 20).map((warning) => <li key={warning}>{warning}</li>)}
                    </ul>
                  ) : null}
                  {warnings.length > 20 ? <p className="mt-2 text-xs">그 밖의 경고 {warnings.length - 20}개</p> : null}
                  {candidateWarningCount > 0 ? (
                    <p className="mt-2 text-xs">작업별로 제외되거나 변환되지 않은 항목 {candidateWarningCount}개가 있습니다.</p>
                  ) : null}
                </div>
              ) : null}

              <section aria-label="가져올 작업">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">작업 {preview.candidates.length}개 · 선택 {selected.size}개</p>
                  <div className="relative min-w-52 flex-1 sm:max-w-72">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <input
                      type="search"
                      value={query}
                      onChange={(event) => {
                        setQuery(event.target.value)
                        setPage(1)
                        setConfirmBulkSelection(false)
                      }}
                      placeholder="이름, 프로젝트, Provider 검색"
                      aria-label="가져올 작업 검색"
                      className="h-8 w-full rounded-md border bg-background pl-8 pr-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </div>
                </div>

                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={visibleSelectable.length === 0}
                    onClick={() => setSelected((current) => withNativeCandidateSelection(
                      current,
                      visibleSelectable,
                      true,
                      NATIVE_IMPORT_MAX_SELECTION,
                    ))}
                  >
                    현재 페이지 선택 ({visibleSelectable.length})
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={visibleSelectable.length === 0}
                    onClick={() => setSelected((current) => withNativeCandidateSelection(current, visibleSelectable, false))}
                  >
                    현재 페이지 해제
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={bulkSelectionCandidates.length === 0 || !bulkSelectionAllowed}
                    onClick={() => setConfirmBulkSelection(true)}
                  >
                    {query.trim() ? '검색 결과' : '전체'} 신규·업데이트 선택 ({bulkSelectionCandidates.length})
                  </Button>
                  {selected.size > 0 ? (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set())}>전체 해제</Button>
                  ) : null}
                </div>

                {!bulkSelectionAllowed ? (
                  <p className="mb-2 rounded-lg border border-warn/40 bg-warn/5 p-3 text-xs text-warn">
                    한 번에 최대 {NATIVE_IMPORT_MAX_SELECTION.toLocaleString()}개를 가져올 수 있습니다.
                    검색으로 범위를 줄인 뒤 검색 결과 전체 선택을 사용하세요.
                  </p>
                ) : null}

                {confirmBulkSelection ? (
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warn/40 bg-warn/5 p-3 text-xs">
                    <span>신규·업데이트 작업 {bulkSelectionCandidates.length}개를 모두 선택하시겠습니까?</span>
                    <div className="flex gap-2">
                      <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmBulkSelection(false)}>취소</Button>
                      <Button type="button" size="sm" onClick={() => {
                        setSelected(withNativeCandidateSelection(
                          new Set(),
                          bulkSelectionCandidates,
                          true,
                          NATIVE_IMPORT_MAX_SELECTION,
                        ))
                        setConfirmBulkSelection(false)
                      }}>{bulkSelectionCandidates.length}개 선택 확인</Button>
                    </div>
                  </div>
                ) : null}

                <p className="mb-2 text-xs text-muted-foreground">
                  검색 결과 {candidatePage.total}개 중 {candidatePage.from}–{candidatePage.to} 표시
                </p>
                <div className="divide-y rounded-lg border">
                  {candidatePage.items.length === 0 ? (
                    <p className="p-4 text-sm text-muted-foreground">조건에 맞는 작업이 없습니다.</p>
                  ) : candidatePage.items.map((candidate) => (
                    <CandidateRow
                      key={candidate.id}
                      candidate={candidate}
                      checked={selected.has(candidate.id)}
                      onCheckedChange={(checked) => setSelected((current) => {
                        const next = new Set(current)
                        if (checked) next.add(candidate.id)
                        else next.delete(candidate.id)
                        return next
                      })}
                    />
                  ))}
                </div>
                <Pagination
                  page={candidatePage.page}
                  pageCount={candidatePage.pageCount}
                  onPageChange={setPage}
                />
              </section>

              <label className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/5 p-3 text-xs leading-relaxed">
                <input
                  className="mt-0.5"
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>
                  원본은 수정되지 않으며 Baton에는 동기화되지 않는 독립 복사본이 생성됩니다.
                  이후 원본 변경은 자동으로 반영되지 않고, 이 가져오기는 native 작업의 실행 권한을 Baton으로 이전하지 않습니다.
                </span>
              </label>
            </>
          ) : null}

          {result ? (
            <section className="space-y-3">
              <div className="rounded-lg border bg-muted/20 p-4">
                <p className="font-medium">가져오기 완료</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  신규 {result.summary.imported}개 · 업데이트 {result.summary.updated}개 · 중복 {result.summary.duplicate}개
                  {result.summary.stale > 0 ? ` · 다시 검색 필요 ${result.summary.stale}개` : ''}
                  {result.summary.failed > 0 ? ` · 실패 ${result.summary.failed}개` : ''}
                </p>
              </div>
              <div className="divide-y rounded-lg border text-sm">
                {resultRows.items.map((item) => (
                  <div key={item.candidateId} className="flex items-start justify-between gap-3 p-3">
                    <span className="min-w-0 truncate text-sm">
                      {candidateNames.get(item.candidateId) || item.candidateId}
                    </span>
                    <div className="shrink-0 text-right">
                      <Badge variant={item.status === 'failed' ? 'destructive' : 'secondary'}>{commitLabel(item.status)}</Badge>
                      {item.error ? <p className="mt-1 max-w-72 text-xs text-destructive">{item.error}</p> : null}
                    </div>
                  </div>
                ))}
              </div>
              <Pagination page={resultRows.page} pageCount={resultRows.pageCount} onPageChange={setResultPage} />
            </section>
          ) : null}

          {error ? <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          {result ? (
            <>
              <Button type="button" variant="outline" onClick={() => void scan()} disabled={scanning}>
                <RotateCcw aria-hidden /> 다시 검색
              </Button>
              <Button type="button" onClick={() => onOpenChange(false)}>닫기</Button>
            </>
          ) : preview ? (
            <>
              <Button type="button" variant="outline" onClick={() => {
                setPreview(null)
                setSelected(new Set())
                setAcknowledged(false)
              }}>원본 변경</Button>
              <Button
                type="button"
                disabled={selected.size === 0 || !acknowledged || committing}
                onClick={() => void commit()}
              >
                {committing ? <LoaderCircle className="animate-spin" aria-hidden /> : <Database aria-hidden />}
                선택한 {selected.size}개 가져오기
              </Button>
            </>
          ) : (
            <Button type="button" disabled={sources.length === 0 || !codexScopeValid || scanning} onClick={() => void scan()}>
              {scanning ? <LoaderCircle className="animate-spin" aria-hidden /> : <Database aria-hidden />}
              로컬 작업 검색
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CandidateRow({
  candidate,
  checked,
  onCheckedChange,
}: {
  candidate: NativeImportCandidateDto
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  const enabled = isSelectableNativeCandidate(candidate)
  return (
    <label className={cn('flex items-start gap-3 p-3', !enabled && 'opacity-60')}>
      <input
        className="mt-1"
        type="checkbox"
        checked={checked}
        disabled={!enabled}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{candidate.sourceAlias || `${providerName(candidate.provider)} 작업`}</span>
          <Badge variant="outline">{STATUS_LABEL[candidate.status]}</Badge>
          <Badge variant="secondary">{sourceName(candidate.sourceClient)}</Badge>
          {candidate.nativeOrigin ? <Badge variant="outline">{originName(candidate.nativeOrigin)}</Badge> : null}
          {candidate.nativeArchived ? <Badge variant="outline">아카이브</Badge> : null}
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {candidate.projectAlias || '프로젝트 없음'}
          {candidate.updatedAt ? ` · ${formatDate(candidate.updatedAt)}` : ''}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {candidate.analysisPending
            ? '선택하면 가져오기 전에 항목을 분석합니다.'
            : `메시지 ${candidate.messageCount}개 · 가져올 항목 ${candidate.portableItemCount}개`}
          {!candidate.analysisPending && candidate.skippedItemCount > 0 ? ` · 제외 ${candidate.skippedItemCount}개` : ''}
          {candidate.warningCount > 0 ? ` · 경고 ${candidate.warningCount}개` : ''}
        </p>
      </div>
    </label>
  )
}

function Pagination({
  page,
  pageCount,
  onPageChange,
}: {
  page: number
  pageCount: number
  onPageChange: (page: number) => void
}) {
  if (pageCount <= 1) return null
  return (
    <nav className="mt-2 flex items-center justify-center gap-3" aria-label="목록 페이지">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
        aria-label="이전 페이지"
      >
        <ChevronLeft aria-hidden />
      </Button>
      <span className="text-xs tabular-nums text-muted-foreground">{page} / {pageCount}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={page >= pageCount}
        onClick={() => onPageChange(page + 1)}
        aria-label="다음 페이지"
      >
        <ChevronRight aria-hidden />
      </Button>
    </nav>
  )
}

function sourceName(source: NativeImportSourceClient): string {
  return SOURCES.find((item) => item.value === source)?.label ?? source
}

function originName(origin: CodexNativeOrigin): string {
  if (origin === 'ide_app') return 'Desktop · IDE'
  if (origin === 'subagent') return 'Subagent'
  if (origin === 'exec') return 'Exec'
  if (origin === 'cli') return 'CLI'
  return '기타'
}

function providerName(provider: string): string {
  if (provider === 'codex') return 'Codex'
  if (provider === 'claude') return 'Claude'
  if (provider === 'gemini') return 'Gemini'
  return provider
}

function commitLabel(status: NativeImportCommitDto['results'][number]['status']): string {
  if (status === 'imported') return '가져옴'
  if (status === 'updated') return '업데이트'
  if (status === 'duplicate') return '중복'
  if (status === 'stale') return '다시 검색 필요'
  return '실패'
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
