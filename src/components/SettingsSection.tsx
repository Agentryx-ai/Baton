import { useEffect, useState } from 'react'
import { Check, Copy, Info, RefreshCw, RotateCw, ShieldCheck, ShieldOff } from 'lucide-react'
import { toast } from 'sonner'

import type {
  ClientIntegrationApplyResult,
  ClientIntegrationRemoveResult,
  ClientIntegrationStatus,
  ClientIntegrationTarget,
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
  ) => Promise<ClientIntegrationApplyResult>
  onRemoveClientIntegration: (
    targets: ClientIntegrationTarget[],
  ) => Promise<ClientIntegrationRemoveResult>
}

const INTEGRATION_TARGETS: ReadonlyArray<{
  target: ClientIntegrationTarget
  label: string
  description?: string
}> = [
  { target: 'claude-cli', label: 'Claude CLI' },
  { target: 'claude-desktop', label: 'Claude Desktop' },
  {
    target: 'codex',
    label: 'Codex CLI/Desktop',
    description: '공유 설정이므로 함께 종료해야 합니다.',
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
      const result = await onApplyClientIntegration([target])
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
    <section aria-labelledby="settings-heading" className="space-y-1">
      <h2
        id="settings-heading"
        className="text-sm font-semibold tracking-wide text-muted-foreground uppercase"
      >
        설정
      </h2>

      <div className="rounded-xl border bg-card px-4 text-card-foreground sm:px-6">
        {/* (a) CLIProxy strategy */}
        <Row label="CLIProxy 전략">
          <RadioGroup
            value={routing?.strategy}
            onValueChange={(v) => onSetStrategy(v as 'round-robin' | 'fill-first')}
            className="gap-2"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="round-robin" id="strategy-round-robin" />
              <Label htmlFor="strategy-round-robin" className="font-normal">
                round-robin
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="fill-first" id="strategy-fill-first" />
              <Label htmlFor="strategy-fill-first" className="font-normal">
                fill-first
              </Label>
            </div>
          </RadioGroup>
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Info className="size-3.5 shrink-0" aria-hidden />
            스마트 로테이션 ON일 땐 엔진이 우선
          </p>
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
          {affinity?.message ? (
            <p className="mt-2 text-xs text-muted-foreground">
              저장된 세션 고정 설정입니다. 로컬 CLIProxy가 설정을 핫리로드할 수 있으나
              실시간 선택 상태는 검증되지 않습니다.
            </p>
          ) : null}
        </Row>

        <Separator />

        {/* (c) Connection info */}
        <Row label="연결 정보">
          <div className="flex items-start gap-2">
            <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted/50 px-3 py-2 text-xs">
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
                const actionable = Boolean(
                  status?.certainlyStopped && (isApplied || isNotApplied),
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
              <span className="text-xs text-muted-foreground">
                각 클라이언트에서 현재 가능한 동작만 선택할 수 있습니다.
              </span>
            </div>

            {clientIntegration?.error || clientIntegrationError ? (
              <p className="text-xs text-destructive">
                {clientIntegration?.error ?? clientIntegrationError?.message}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              동작할 대상 하나만 종료 여부와 파일 잠금을 검사합니다. 다른 앱은 실행 중이어도
              됩니다. 이미 적용된 대상은 재적용하지 않고 해제만 제공합니다.
            </p>
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
