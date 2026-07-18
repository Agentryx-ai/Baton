import { useEffect, useState } from 'react'
import { Check, Copy, Info, RefreshCw, RotateCw, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'

import type {
  ClientIntegrationApplyResult,
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
}: SettingsSectionProps) {
  const affinityManageable = affinity?.manageable ?? true

  // Local, editable TTL — seeded from props, re-synced when the server value changes.
  const [ttl, setTtl] = useState(affinity?.ttl ?? '')
  useEffect(() => {
    setTtl(affinity?.ttl ?? '')
  }, [affinity?.ttl])

  const [copied, setCopied] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [applyingIntegration, setApplyingIntegration] = useState(false)
  const [selectedIntegrationTargets, setSelectedIntegrationTargets] = useState<
    ClientIntegrationTarget[]
  >(INTEGRATION_TARGETS.map((item) => item.target))

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

  const handleApplyIntegration = async () => {
    setApplyingIntegration(true)
    try {
      const result = await onApplyClientIntegration(selectedIntegrationTargets)
      toast.success(`${result.updated.join(', ')} 설정을 적용했습니다. 이제 앱을 다시 실행하세요.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setApplyingIntegration(false)
      onRefreshClientIntegration()
    }
  }

  const selectedStatuses = clientIntegration?.targets.filter((status) =>
    selectedIntegrationTargets.includes(status.target)
  ) ?? []
  const selectedTargetsReady = selectedIntegrationTargets.length > 0
    && selectedStatuses.length === selectedIntegrationTargets.length
    && selectedStatuses.every((status) => status.certainlyStopped)

  const toggleIntegrationTarget = (
    target: ClientIntegrationTarget,
    checked: boolean,
  ) => {
    setSelectedIntegrationTargets((current) => {
      const next = new Set(current)
      if (checked) next.add(target)
      else next.delete(target)
      return INTEGRATION_TARGETS
        .map((item) => item.target)
        .filter((item) => next.has(item))
    })
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
                return (
                  <label
                    key={option.target}
                    className="flex cursor-pointer items-start gap-2 rounded-md border p-3"
                  >
                    <input
                      type="checkbox"
                      checked={selectedIntegrationTargets.includes(option.target)}
                      disabled={applyingIntegration}
                      onChange={(event) =>
                        toggleIntegrationTarget(option.target, event.target.checked)
                      }
                      className="mt-0.5 size-4 accent-primary"
                    />
                    <span className="min-w-0 space-y-0.5">
                      <span className="block text-sm font-medium">{option.label}</span>
                      <span
                        className={cn(
                          'block text-xs',
                          status?.certainlyStopped
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-muted-foreground',
                        )}
                      >
                        {status?.certainlyStopped
                          ? '종료됨 · 적용 가능'
                          : status
                            ? `실행 중 ${status.running.length}개`
                            : '상태 확인 중'}
                      </span>
                      {option.description ? (
                        <span className="block text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                  </label>
                )
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={
                  applyingIntegration
                  || clientIntegrationLoading
                  || !selectedTargetsReady
                }
                onClick={() => void handleApplyIntegration()}
              >
                <ShieldCheck />
                {applyingIntegration ? '적용 중…' : '선택 설정 적용'}
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="클라이언트 종료 상태 새로고침"
                title="종료 상태 새로고침"
                disabled={clientIntegrationLoading || applyingIntegration}
                onClick={onRefreshClientIntegration}
              >
                <RefreshCw className={cn(clientIntegrationLoading && 'animate-spin')} />
              </Button>
              {selectedTargetsReady ? (
                <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  선택 대상 종료됨 · 적용 가능
                </span>
              ) : (
                <span className="text-xs font-medium text-destructive">
                  선택 대상이 실행 중이거나 선택되지 않음
                </span>
              )}
            </div>

            {clientIntegration?.error || clientIntegrationError ? (
              <p className="text-xs text-destructive">
                {clientIntegration?.error ?? clientIntegrationError?.message}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              선택한 대상만 종료 여부와 파일 잠금을 검사해 적용합니다. 선택하지 않은 앱은
              실행 중이어도 됩니다.
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
