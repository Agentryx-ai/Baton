import { useEffect, useState } from 'react'
import { Check, Copy, Info, RefreshCw, RotateCw, ShieldCheck, ShieldOff } from 'lucide-react'
import { toast } from 'sonner'

import type {
  ClientIntegrationApplyResult,
  ClientIntegrationRemoveResult,
  ClientIntegrationStatus,
  ClientIntegrationTarget,
  CodexIntegrationMode,
  ProxyStatus,
  RoutingStrategy,
  SessionAffinity,
} from '@/api/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { AssistantLabelMode, SessionViewPreferences } from '@/features/conversations/session-view-preferences'

interface SettingsSectionProps {
  routing: RoutingStrategy | null
  affinity: SessionAffinity | null
  proxy: ProxyStatus | null
  connectionSnippet: string
  clientIntegration: ClientIntegrationStatus | null
  clientIntegrationError: Error | null
  clientIntegrationLoading: boolean
  onSetStrategy: (s: 'round-robin' | 'fill-first') => void
  onSetAffinity: (enabled: boolean, ttl?: string) => void
  onRestartProxy: () => void
  onRefreshClientIntegration: () => void
  onApplyClientIntegration: (
    targets: ClientIntegrationTarget[],
    codexMode?: CodexIntegrationMode,
  ) => Promise<ClientIntegrationApplyResult>
  onRemoveClientIntegration: (
    targets: ClientIntegrationTarget[],
  ) => Promise<ClientIntegrationRemoveResult>
  conversationPreferences: SessionViewPreferences
  onConversationPreferencesChange: (preferences: SessionViewPreferences) => void
}

const INTEGRATION_TARGETS: ReadonlyArray<{
  target: ClientIntegrationTarget
  label: string
  description?: string
}> = [
  {
    target: 'claude-cli',
    label: 'Claude CLI',
    description: '로컬 --continue/--resume 세션은 gateway 설정과 분리되어 유지됩니다.',
  },
  {
    target: 'claude-desktop',
    label: 'Claude Desktop',
    description: 'Gateway는 별도 inference provider입니다. Claude 계정의 기존 Chat/Cowork 목록 보존은 지원되지 않습니다.',
  },
  {
    target: 'codex',
    label: 'Codex CLI/Desktop',
    description: 'CLI와 Desktop은 같은 ~/.codex/config.toml을 사용하므로 함께 종료해야 합니다.',
  },
]

function Row({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'grid gap-3 py-4 sm:grid-cols-[minmax(0,10rem)_1fr] sm:items-start sm:gap-6',
        className
      )}
    >
      <div className="pt-1 text-sm font-medium text-foreground">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export function SettingsSection({
  routing,
  affinity,
  proxy,
  connectionSnippet,
  clientIntegration,
  clientIntegrationError,
  clientIntegrationLoading,
  onSetStrategy,
  onSetAffinity,
  onRestartProxy,
  onRefreshClientIntegration,
  onApplyClientIntegration,
  onRemoveClientIntegration,
  conversationPreferences,
  onConversationPreferencesChange,
}: SettingsSectionProps) {
  const affinityManageable = affinity?.manageable ?? true

  // Local, editable TTL — seeded from props, re-synced when the server value changes.
  const [ttl, setTtl] = useState(affinity?.ttl ?? '')
  useEffect(() => {
    setTtl(affinity?.ttl ?? '')
  }, [affinity?.ttl])

  const [copied, setCopied] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [changingIntegrationTarget, setChangingIntegrationTarget] = useState<
    ClientIntegrationTarget | null
  >(null)
  const [codexMode, setCodexMode] = useState<CodexIntegrationMode>('native-openai')
  useEffect(() => {
    const appliedMode = clientIntegration?.targets.find(
      (target) => target.target === 'codex',
    )?.codexMode
    if (appliedMode) setCodexMode(appliedMode)
  }, [clientIntegration])

  const commitTtl = () => {
    if (!affinity) return
    const next = ttl.trim()
    if (!next || next === affinity.ttl) return
    onSetAffinity(affinity.enabled, next)
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(connectionSnippet)
      setCopied(true)
      toast.success('복사됨')
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('복사 실패')
    }
  }

  const handleRestart = () => {
    setRestarting(true)
    onRestartProxy()
    window.setTimeout(() => setRestarting(false), 1200)
  }

  const handleApplyIntegration = async (target: ClientIntegrationTarget) => {
    setChangingIntegrationTarget(target)
    try {
      const result = await onApplyClientIntegration(
        [target],
        target === 'codex' ? codexMode : undefined,
      )
      toast.success(`${result.updated.join(', ')} 설정을 적용했습니다. 이제 앱을 다시 실행하세요.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setChangingIntegrationTarget(null)
      onRefreshClientIntegration()
    }
  }

  const handleRemoveIntegration = async (target: ClientIntegrationTarget) => {
    setChangingIntegrationTarget(target)
    try {
      const result = await onRemoveClientIntegration([target])
      toast.success(`${result.updated.join(', ')} 설정을 해제했습니다. 이제 앱을 다시 실행하세요.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setChangingIntegrationTarget(null)
      onRefreshClientIntegration()
    }
  }

  return (
    <section aria-label="세부 설정">
      <div className="rounded-xl border bg-card px-4 text-card-foreground sm:px-6">
        {/* (a) CLIProxy strategy */}
        <Row label="CLIProxy 전략">
          <RadioGroup
            value={routing?.strategy}
            onValueChange={(v) => onSetStrategy(v as 'round-robin' | 'fill-first')}
            className="gap-2"
          >
            <div className="flex items-start gap-2">
              <RadioGroupItem value="round-robin" id="strategy-round-robin" className="mt-0.5" />
              <Label htmlFor="strategy-round-robin" className="font-normal">
                <span className="block font-medium text-foreground">round-robin</span>
                <span className="block text-xs text-muted-foreground">활성 계정에 요청을 순서대로 분산합니다.</span>
              </Label>
            </div>
            <div className="flex items-start gap-2">
              <RadioGroupItem value="fill-first" id="strategy-fill-first" className="mt-0.5" />
              <Label htmlFor="strategy-fill-first" className="font-normal">
                <span className="block font-medium text-foreground">fill-first</span>
                <span className="block text-xs text-muted-foreground">한 계정을 우선 사용하고 사용할 수 없을 때 다음 계정으로 이동합니다.</span>
              </Label>
            </div>
          </RadioGroup>
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Info className="size-3.5 shrink-0" aria-hidden />
            스마트 로테이션 ON일 땐 엔진이 우선
          </p>
        </Row>

        <Separator />

        <Row label="대화 표시">
          <RadioGroup
            value={conversationPreferences.assistantLabel}
            onValueChange={(value) => onConversationPreferencesChange({
              ...conversationPreferences,
              assistantLabel: value as AssistantLabelMode,
            })}
            className="gap-2"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="provider" id="assistant-label-provider" />
              <Label htmlFor="assistant-label-provider" className="font-normal">Provider 이름</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="assistant" id="assistant-label-assistant" />
              <Label htmlFor="assistant-label-assistant" className="font-normal">Assistant</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="both" id="assistant-label-both" />
              <Label htmlFor="assistant-label-both" className="font-normal">Assistant · Provider</Label>
            </div>
          </RadioGroup>
          <p className="mt-2 text-xs text-muted-foreground">대화에서 어시스턴트 응답 위에 표시할 이름입니다.</p>
        </Row>

        <Separator />

        {/* (b) Session affinity */}
        <Row label="세션 고정">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-center gap-2">
              <Switch
                id="affinity-enabled"
                checked={affinity?.enabled ?? false}
                disabled={!affinity || !affinityManageable}
                onCheckedChange={(checked) =>
                  onSetAffinity(checked, ttl.trim() || undefined)
                }
              />
              <Label htmlFor="affinity-enabled" className="font-normal">
                {affinity?.enabled ? 'ON' : 'OFF'}
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="affinity-ttl" className="font-normal text-muted-foreground">
                TTL
              </Label>
              <Input
                id="affinity-ttl"
                value={ttl}
                disabled={!affinity || !affinityManageable}
                onChange={(e) => setTtl(e.target.value)}
                onBlur={commitTtl}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitTtl()
                  }
                }}
                className="h-8 w-24"
                placeholder="1h"
              />
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            같은 세션의 요청을 TTL 동안 동일한 계정에 고정합니다.
          </p>
        </Row>

        <Separator />

        {/* (c) Connection info */}
        <Row label="연결 정보">
          <details className="rounded-md border bg-muted/20 px-3 py-2">
            <summary className="cursor-pointer select-none text-sm font-medium">수동 연결 정보 보기</summary>
            <div className="mt-3 flex items-start gap-2">
              <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-background px-3 py-2 text-xs">
                <code>{connectionSnippet}</code>
              </pre>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="연결 정보 복사"
                title="복사"
                onClick={handleCopy}
              >
                {copied ? <Check /> : <Copy />}
              </Button>
            </div>
          </details>
        </Row>

        <Separator />

        <Row label="클라이언트 자동 설정">
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-3">
              {INTEGRATION_TARGETS.map((option) => {
                const status = clientIntegration?.targets.find(
                  (item) => item.target === option.target,
                )
                const isApplied = status?.configuration === 'applied'
                const isNotApplied = status?.configuration === 'not-applied'
                const isConflict = status?.configuration === 'conflict'
                const actionable = Boolean(
                  status?.certainlyStopped && (isApplied || isNotApplied || isConflict),
                )
                const changingThisTarget = changingIntegrationTarget === option.target
                return (
                  <div
                    key={option.target}
                    className={cn(
                      'flex min-h-40 flex-col rounded-md border p-3',
                      isApplied && 'border-emerald-500/40 bg-emerald-500/5',
                    )}
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <span className="block text-sm font-medium">{option.label}</span>
                      <span className={cn(
                        'block text-xs font-medium',
                        status?.configuration === 'applied'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : status?.configuration === 'conflict'
                            ? 'text-destructive'
                            : 'text-muted-foreground',
                      )}>
                        {!status
                          ? '설정 확인 중'
                          : status.configuration === 'applied'
                          ? '적용됨'
                          : status.configuration === 'not-applied'
                            ? '미적용'
                            : status.configuration === 'conflict'
                              ? '설정 충돌'
                              : '설정 확인 불가'}
                      </span>
                      <span className={cn(
                        'block text-xs',
                        status?.certainlyStopped
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-muted-foreground',
                      )}>
                        {!status
                          ? '프로세스 확인 중'
                          : status.certainlyStopped
                          ? '종료됨'
                          : `실행 중 ${status.running.length}개`}
                      </span>
                      {status?.configurationDetail
                        && status.configuration !== 'applied' ? (
                          <span className="block text-xs text-muted-foreground">
                            {status.configurationDetail}
                          </span>
                        ) : null}
                      {option.description ? (
                        <span className="block text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      ) : null}
                      {option.target === 'codex' ? (
                        isApplied ? (
                          <span className="block text-xs font-medium text-emerald-600 dark:text-emerald-400">
                            {status?.codexMode === 'native-openai'
                              ? '기존 OpenAI 세션 유지 모드'
                              : 'Baton 전용 Provider · 기존 OpenAI 대화와 분리'}
                          </span>
                        ) : (
                          <RadioGroup
                            value={codexMode}
                            onValueChange={(value) => setCodexMode(value as CodexIntegrationMode)}
                            className="mt-3 gap-2 rounded-md border bg-background/70 p-2"
                          >
                            <div className="flex items-start gap-2">
                              <RadioGroupItem value="native-openai" id="codex-native-openai" className="mt-0.5" />
                              <Label htmlFor="codex-native-openai" className="space-y-0.5 font-normal">
                                <span className="block text-xs font-medium">기존 세션 유지 (권장 · Desktop)</span>
                                <span className="block text-[11px] leading-4 text-muted-foreground">
                                  model_provider=openai를 유지하고 전송 주소만 Baton으로 바꿉니다. Desktop과 CLI의 기존 OpenAI 목록을 유지합니다.
                                </span>
                              </Label>
                            </div>
                            <div className="flex items-start gap-2">
                              <RadioGroupItem value="custom-provider" id="codex-custom-provider" className="mt-0.5" />
                              <Label htmlFor="codex-custom-provider" className="space-y-0.5 font-normal">
                                <span className="block text-xs font-medium">Baton 전용 Provider (고급)</span>
                                <span className="block text-[11px] leading-4 text-muted-foreground">
                                  model_provider=baton으로 새 대화를 별도 목록에 저장합니다. 기존 OpenAI 대화와 이어지지 않으므로 Provider 격리가 필요할 때만 사용하세요.
                                </span>
                              </Label>
                            </div>
                          </RadioGroup>
                        )
                      ) : null}
                    </div>
                    <Button
                      variant={isApplied ? 'outline' : 'default'}
                      size="sm"
                      className="mt-3 w-full"
                      disabled={
                        clientIntegrationLoading
                        || changingIntegrationTarget !== null
                        || !actionable
                      }
                      onClick={() => void (
                        isApplied
                          ? handleRemoveIntegration(option.target)
                          : handleApplyIntegration(option.target)
                      )}
                    >
                      {isApplied ? <ShieldOff /> : <ShieldCheck />}
                      {changingThisTarget
                        ? isApplied ? '해제 중…' : '적용 중…'
                        : isApplied
                          ? status?.certainlyStopped ? '설정 해제' : '종료 후 해제'
                          : isNotApplied
                            ? status?.certainlyStopped ? '설정 적용' : '종료 후 적용'
                            : isConflict
                              ? status?.certainlyStopped ? '설정 복구' : '종료 후 복구'
                            : !status ? '확인 중…' : '조치 불가'}
                    </Button>
                  </div>
                )
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="클라이언트 종료 상태 새로고침"
                title="종료 상태 새로고침"
                disabled={clientIntegrationLoading || changingIntegrationTarget !== null}
                onClick={onRefreshClientIntegration}
              >
                <RefreshCw className={cn(clientIntegrationLoading && 'animate-spin')} />
              </Button>
            </div>

            {clientIntegration?.error || clientIntegrationError ? (
              <p className="text-xs text-destructive">
                {clientIntegration?.error ?? clientIntegrationError?.message}
              </p>
            ) : null}
          </div>
        </Row>

        <Separator />

        {/* (d) Proxy restart */}
        <Row label="프록시">
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              disabled={restarting}
              onClick={handleRestart}
            >
              <RotateCw className={cn(restarting && 'animate-spin')} />
              {restarting ? '재시작 중…' : '재시작'}
            </Button>
            {proxy?.running ? (
              <span className="text-xs text-muted-foreground tabular-nums">
                :{proxy.port} · pid {proxy.pid}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">정지됨</span>
            )}
          </div>
        </Row>
      </div>
    </section>
  )
}
