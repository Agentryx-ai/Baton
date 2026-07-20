import { useEffect, useState } from 'react'
import { Check, Copy, Info, RefreshCw, RotateCw, ShieldCheck, ShieldOff, Trash2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'

import type {
  ClientIntegrationApplyResult,
  ClientIntegrationRemoveResult,
  ClientIntegrationStatus,
  ClientIntegrationTarget,
  ClaudeProxyMode,
  CodexIntegrationMode,
  ModelFallbackStatus,
  Account,
  ProxyStatus,
  RoutingStrategy,
  SessionAffinity,
} from '@/api/types'
import type { CodexPluginCatalog, CodexPluginReferencePreview } from '@/api/codex-plugins'
import { client } from '@/api/client'
import { pendingModelFallbackOffers } from '@/api/model-fallback'
import { Button } from '@/components/ui/button'
import { BatonStatusCard } from '@/components/BatonStatusCard'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { AssistantLabelMode, SessionViewPreferences } from '@/features/conversations/session-view-preferences'
import { conversationApi } from '@/features/conversations/api'
import type { PermissionProfile, PermissionSettingsDto } from '@/features/conversations/types'

interface SettingsSectionProps {
  routing: RoutingStrategy | null
  policyEnabled: boolean
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
    claudeProxyMode?: ClaudeProxyMode,
  ) => Promise<ClientIntegrationApplyResult>
  onRemoveClientIntegration: (
    targets: ClientIntegrationTarget[],
  ) => Promise<ClientIntegrationRemoveResult>
  conversationPreferences: SessionViewPreferences
  onConversationPreferencesChange: (preferences: SessionViewPreferences) => void
  onPluginReferenceChanged: () => void
  onAddCodexPluginAccount: () => void
  pluginAccountRefreshKey: number
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
  policyEnabled,
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
  onPluginReferenceChanged,
  onAddCodexPluginAccount,
  pluginAccountRefreshKey,
}: SettingsSectionProps) {
  const affinityManageable = affinity?.manageable ?? true

  // Local, editable TTL — seeded from props, re-synced when the server value changes.
  const [ttl, setTtl] = useState(affinity?.ttl ?? '')
  useEffect(() => {
    setTtl(affinity?.ttl ?? '')
  }, [affinity?.ttl])

  const [copied, setCopied] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [permissionSettings, setPermissionSettings] = useState<PermissionSettingsDto | null>(null)
  const [permissionError, setPermissionError] = useState<string | null>(null)
  const [permissionBusy, setPermissionBusy] = useState(false)
  const [changingIntegrationTarget, setChangingIntegrationTarget] = useState<
    ClientIntegrationTarget | null
  >(null)
  const [codexMode, setCodexMode] = useState<CodexIntegrationMode>('native-openai')
  const [claudeProxyMode, setClaudeProxyMode] = useState<ClaudeProxyMode>('native')
  const [modelFallback, setModelFallback] = useState<ModelFallbackStatus | null>(null)
  const [modelFallbackError, setModelFallbackError] = useState<string | null>(null)
  const [modelFallbackBusy, setModelFallbackBusy] = useState(false)
  const [pluginReferenceValue, setPluginReferenceValue] = useState('local_only')
  const [pluginReferenceLabel, setPluginReferenceLabel] = useState('local-only')
  const [pluginReferenceProblem, setPluginReferenceProblem] = useState<'selected_account_missing' | null>(null)
  const [pluginPreview, setPluginPreview] = useState<CodexPluginReferencePreview | null>(null)
  const [pluginReferenceError, setPluginReferenceError] = useState<string | null>(null)
  const [pluginReferenceBusy, setPluginReferenceBusy] = useState(false)
  const [pluginCatalog, setPluginCatalog] = useState<CodexPluginCatalog | null>(null)
  const [codexPluginAccounts, setCodexPluginAccounts] = useState<Account[]>([])
  const [pluginActionNotice, setPluginActionNotice] = useState<string | null>(null)
  const [pluginDeleteAccount, setPluginDeleteAccount] = useState<Account | null>(null)
  const [pluginDeleteReplacement, setPluginDeleteReplacement] = useState('local_only')
  const [pluginDeleteBusy, setPluginDeleteBusy] = useState(false)
  const [pluginDeleteError, setPluginDeleteError] = useState<string | null>(null)
  useEffect(() => {
    const appliedMode = clientIntegration?.targets.find(
      (target) => target.target === 'codex',
    )?.codexMode
    if (appliedMode) setCodexMode(appliedMode)
  }, [clientIntegration])
  useEffect(() => {
    const appliedMode = clientIntegration?.targets.find(
      (target) => target.target !== 'codex' && target.configuration === 'applied',
    )?.claudeProxyMode
    if (appliedMode) setClaudeProxyMode(appliedMode)
  }, [clientIntegration])

  useEffect(() => {
    let cancelled = false
    conversationApi.getPermissionSettings().then((result) => {
      if (!cancelled) setPermissionSettings(result)
    }).catch((error: unknown) => {
      if (!cancelled) setPermissionError(error instanceof Error ? error.message : String(error))
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [status, pluginAccounts] = await Promise.all([
          client.getCodexPluginReference(),
          client.getCodexPluginAccounts(),
        ])
        if (cancelled) return
        const value = status.state.mode === 'account' ? status.state.accountId : 'local_only'
        setPluginReferenceValue(value)
        setPluginReferenceProblem(status.problem)
        setPluginReferenceLabel(status.account?.alias
          ?? (status.problem === 'selected_account_missing' ? '찾을 수 없는 계정' : 'local-only'))
        setCodexPluginAccounts(pluginAccounts)
        try {
          const catalog = await client.getCodexPluginCatalog()
          if (!cancelled) {
            setPluginCatalog(catalog)
            setPluginReferenceError(null)
          }
        } catch (error) {
          if (!cancelled) {
            setPluginCatalog(null)
            setPluginReferenceError(error instanceof Error ? error.message : String(error))
          }
        }
      } catch (error) {
        if (!cancelled) setPluginReferenceError(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => { cancelled = true }
  }, [pluginAccountRefreshKey])

  const previewPluginReference = async () => {
    setPluginReferenceBusy(true)
    setPluginReferenceError(null)
    try {
      const target = pluginReferenceValue === 'local_only'
        ? { mode: 'local_only' as const, accountId: null }
        : { mode: 'account' as const, accountId: pluginReferenceValue }
      setPluginPreview(await client.previewCodexPluginReference(target))
    } catch (error) {
      setPluginReferenceError(error instanceof Error ? error.message : String(error))
    } finally {
      setPluginReferenceBusy(false)
    }
  }

  const switchPluginReference = async () => {
    if (!pluginPreview) return
    setPluginReferenceBusy(true)
    try {
      const result = await client.switchCodexPluginReference(pluginPreview)
      setPluginReferenceLabel(result.status.account?.alias ?? 'local-only')
      setPluginReferenceProblem(result.status.problem)
      setPluginCatalog(result.catalog)
      setCodexPluginAccounts(await client.getCodexPluginAccounts())
      setPluginPreview(null)
      setPluginReferenceError(null)
      onPluginReferenceChanged()
      toast.success('Codex 플러그인 기준계정을 변경했습니다')
    } catch (error) {
      setPluginReferenceError(error instanceof Error ? error.message : String(error))
    } finally {
      setPluginReferenceBusy(false)
    }
  }

  const mutatePlugin = async (operation: () => Promise<unknown>, successMessage: string) => {
    setPluginReferenceBusy(true)
    setPluginReferenceError(null)
    try {
      const result = await operation()
      const appsNeedingAuth = result && typeof result === 'object' && 'appsNeedingAuth' in result
        && Array.isArray(result.appsNeedingAuth)
        ? result.appsNeedingAuth.flatMap((app) => (
          app && typeof app === 'object' && 'name' in app && typeof app.name === 'string' ? [app.name] : []
        ))
        : []
      setPluginActionNotice(appsNeedingAuth.length > 0
        ? `${successMessage} Codex/ChatGPT에서 connector 인증 필요: ${appsNeedingAuth.join(', ')}`
        : successMessage)
      setPluginCatalog(await client.getCodexPluginCatalog())
    } catch (error) {
      setPluginReferenceError(error instanceof Error ? error.message : String(error))
    } finally {
      setPluginReferenceBusy(false)
    }
  }

  const deleteCodexPluginAccount = async () => {
    const account = pluginDeleteAccount
    if (!account || account.revision === undefined) return
    setPluginDeleteBusy(true)
    setPluginDeleteError(null)
    try {
      if (account.isPluginReference) {
        const target = pluginDeleteReplacement === 'local_only'
          ? { mode: 'local_only' as const, accountId: null }
          : { mode: 'account' as const, accountId: pluginDeleteReplacement }
        const preview = await client.previewCodexPluginReference(target)
        const switched = await client.switchCodexPluginReference(preview)
        setPluginReferenceValue(target.mode === 'account' ? target.accountId : 'local_only')
        setPluginReferenceLabel(switched.status.account?.alias ?? 'local-only')
        setPluginReferenceProblem(switched.status.problem)
        setPluginCatalog(switched.catalog)
      }
      await client.removeCodexPluginAccount(account.id, account.revision)
      setCodexPluginAccounts(await client.getCodexPluginAccounts())
      setPluginDeleteAccount(null)
      onPluginReferenceChanged()
      toast.success('Codex 플러그인 계정을 삭제했습니다')
    } catch (error) {
      setPluginDeleteError(error instanceof Error ? error.message : String(error))
    } finally {
      setPluginDeleteBusy(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    const refresh = () => client.getModelFallback().then((status) => {
      if (!cancelled) {
        setModelFallback(status)
        setModelFallbackError(null)
      }
    }).catch((error: unknown) => {
      if (!cancelled) setModelFallbackError(error instanceof Error ? error.message : String(error))
    })
    void refresh()
    const interval = window.setInterval(refresh, 10_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [])

  const updateModelFallback = async (settings: {
    enabled?: boolean
    promptDismissed?: boolean
  }) => {
    if (modelFallbackBusy) return
    setModelFallbackBusy(true)
    try {
      setModelFallback(await client.setModelFallback(settings))
      setModelFallbackError(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setModelFallbackError(message)
      toast.error(message)
    } finally {
      setModelFallbackBusy(false)
    }
  }

  const setDefaultPermissionProfile = async (profile: PermissionProfile) => {
    if (permissionBusy || permissionSettings?.defaultProfile === profile) return
    setPermissionBusy(true)
    setPermissionError(null)
    try {
      const updated = await conversationApi.updatePermissionSettings(profile)
      setPermissionSettings(updated)
      toast.success('새 권한 기본값을 저장했습니다. 다음 턴부터 적용됩니다.')
    } catch (error) {
      setPermissionError(error instanceof Error ? error.message : String(error))
    } finally {
      setPermissionBusy(false)
    }
  }

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
        target !== 'codex' ? claudeProxyMode : undefined,
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
            disabled={policyEnabled}
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
            {policyEnabled
              ? '정책 ON 동안 fill-first가 필수입니다. 전략을 바꾸려면 정책을 먼저 끄세요.'
              : 'round-robin은 균등 분산, fill-first는 계정별 순차 소진에 적합합니다.'}
          </p>
        </Row>

        <Separator />

        <Row label="대화 권한">
          <RadioGroup
            value={permissionSettings?.defaultProfile}
            onValueChange={(value) => void setDefaultPermissionProfile(value as PermissionProfile)}
            disabled={!permissionSettings || permissionBusy}
            className="gap-2"
          >
            <div className="flex items-start gap-2">
              <RadioGroupItem value="read_only" id="permission-read-only" className="mt-0.5" />
              <Label htmlFor="permission-read-only" className="font-normal">
                <span className="block font-medium">읽기 전용</span>
                <span className="block text-xs text-muted-foreground">연결한 프로젝트의 읽기·검색만 허용합니다.</span>
              </Label>
            </div>
            <div className="flex items-start gap-2">
              <RadioGroupItem value="workspace" id="permission-workspace" className="mt-0.5" />
              <Label htmlFor="permission-workspace" className="font-normal">
                <span className="block font-medium">작업공간</span>
                <span className="block text-xs text-muted-foreground">연결한 프로젝트 안에서 파일 변경과 샌드박스 명령을 허용합니다.</span>
              </Label>
            </div>
            <div className="flex items-start gap-2">
              <RadioGroupItem value="full_access" id="permission-full-access" className="mt-0.5" />
              <Label htmlFor="permission-full-access" className="font-normal">
                <span className="block font-medium">전체 액세스</span>
                <span className="block text-xs text-muted-foreground">OS 샌드박스 없이 로컬 명령과 네트워크를 사용합니다.</span>
              </Label>
            </div>
          </RadioGroup>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            전체 액세스에서는 별도 연결 없이 adb, Git, PowerShell 등 설치된 도구를 사용할 수 있습니다.
            대화별로 재정의할 수 있으며 실행 중인 턴의 권한은 바뀌지 않습니다.
          </p>
          {permissionError ? <p className="mt-2 text-xs text-destructive">{permissionError}</p> : null}
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
            <div className="rounded-md border bg-background/70 p-3">
              <span className="block text-sm font-medium">Claude 프록시 코어</span>
              <RadioGroup
                value={claudeProxyMode}
                onValueChange={(value) => setClaudeProxyMode(value as ClaudeProxyMode)}
                className="mt-2 gap-2"
              >
                <div className="flex items-start gap-2">
                  <RadioGroupItem value="native" id="claude-proxy-native" className="mt-0.5" />
                  <Label htmlFor="claude-proxy-native" className="space-y-0.5 font-normal">
                    <span className="block text-xs font-medium">Baton Native (권장)</span>
                    <span className="block text-[11px] leading-4 text-muted-foreground">
                      Baton이 Anthropic에 직접 연결합니다. OAuth 갱신과 모델별 한도 판별을 보존하며 Fable 5 소진을 구체적으로 표시합니다.
                    </span>
                  </Label>
                </div>
                <div className="flex items-start gap-2">
                  <RadioGroupItem value="cliproxy" id="claude-proxy-cliproxy" className="mt-0.5" />
                  <Label htmlFor="claude-proxy-cliproxy" className="space-y-0.5 font-normal">
                    <span className="block text-xs font-medium">CLIProxy (호환/rollback)</span>
                    <span className="block text-[11px] leading-4 text-muted-foreground">
                      기존 gateway 경로를 유지합니다. Native 전환에 문제가 있을 때만 사용하세요.
                    </span>
                  </Label>
                </div>
              </RadioGroup>
              {claudeProxyMode === 'cliproxy' ? (
                <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-800 dark:text-amber-200">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                  <p className="text-xs leading-5">
                    확인된 제한: Fable 같은 모델별 한도와 계정 전체 429를 구분하지 못하고 일반 429로 표시하거나 장시간 재시도할 수 있습니다.
                    Baton의 모델별 quota preflight와 향후 자동 모델전환도 적용되지 않습니다.
                  </p>
                </div>
              ) : null}
            </div>
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
                              ? 'Baton Native Proxy · 기존 OpenAI 세션 유지'
                              : 'CLIProxy 호환 Provider · 기존 OpenAI 대화와 분리'}
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
                                <span className="block text-xs font-medium">Baton Native Proxy · 기존 세션 유지 (권장)</span>
                                <span className="block text-[11px] leading-4 text-muted-foreground">
                                  Baton이 Codex OAuth refresh, live 모델 카탈로그, 모델-aware 계정 failover를 직접 수행합니다. Desktop과 CLI의 기존 OpenAI 목록을 유지합니다.
                                </span>
                              </Label>
                            </div>
                            <div className="flex items-start gap-2">
                              <RadioGroupItem value="custom-provider" id="codex-custom-provider" className="mt-0.5" />
                              <Label htmlFor="codex-custom-provider" className="space-y-0.5 font-normal">
                                <span className="block text-xs font-medium">CLIProxy 호환 Provider (rollback)</span>
                                <span className="block text-[11px] leading-4 text-amber-700 dark:text-amber-300">
                                  실제 usage-limit 뒤 same-request failover가 되지 않거나, stale plan 때문에 상위 모델이 사라질 수 있습니다. 플랜 변경 반영에 재로그인이 필요할 수 있습니다.
                                </span>
                              </Label>
                            </div>
                          </RadioGroup>
                        )
                      ) : isApplied ? (
                        <>
                          <span className="block text-xs font-medium text-emerald-600 dark:text-emerald-400">
                            {status?.claudeProxyMode === 'native'
                              ? 'Baton Native Proxy 적용됨'
                              : 'CLIProxy 호환 경로 적용됨'}
                          </span>
                          {status?.claudeProxyMode === 'cliproxy' ? (
                            <span className="block text-xs leading-5 text-amber-700 dark:text-amber-300">
                              모델별 429 식별과 자동전환을 사용할 수 없습니다.
                            </span>
                          ) : null}
                        </>
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

        <Row label="Codex 플러그인 기준계정">
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              현재 기준: <span className="font-medium text-foreground">{pluginReferenceLabel}</span>. 모델 요청의 pause·우선순위와 독립적으로 원격 플러그인 catalog와 connector 권한만 결정합니다.
            </p>
            <select
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={pluginReferenceValue}
              onChange={(event) => {
                setPluginReferenceValue(event.target.value)
                setPluginPreview(null)
              }}
              disabled={pluginReferenceBusy}
            >
              <option value="local_only">local-only (로컬·저장소 플러그인만)</option>
              {pluginReferenceProblem === 'selected_account_missing' ? (
                <option value={pluginReferenceValue} disabled>현재 선택 계정 · 찾을 수 없음</option>
              ) : null}
              {codexPluginAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.nickname || account.email}{account.paused ? ' · 모델 라우팅 중지됨' : ''}
                </option>
              ))}
            </select>
            <Button variant="outline" size="sm" disabled={pluginReferenceBusy} onClick={() => void previewPluginReference()}>
              {pluginReferenceBusy ? '확인 중…' : '변경 내용 미리보기'}
            </Button>
            <Button variant="outline" size="sm" disabled={pluginReferenceBusy} onClick={onAddCodexPluginAccount}>
              플러그인 계정 추가
            </Button>
            {codexPluginAccounts.length > 0 ? (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-xs font-medium">Native 기준계정 후보</p>
                {codexPluginAccounts.map((account) => (
                  <div key={account.id} className="flex items-center justify-between gap-3 text-xs">
                    <span className="min-w-0 truncate">
                      {account.nickname || account.email}
                      {account.isPluginReference ? ' · 현재 기준' : ''}
                      {account.paused ? ' · 모델 라우팅 중지' : ''}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${account.nickname || account.email} 삭제`}
                      disabled={pluginReferenceBusy}
                      onClick={() => {
                        setPluginDeleteAccount(account)
                        setPluginDeleteReplacement('local_only')
                        setPluginDeleteError(null)
                      }}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
            {pluginPreview ? (
              <div className="space-y-2 rounded-md border p-3 text-xs">
                {pluginPreview.diffAvailable ? (
                  <>
                    <p>추가 {pluginPreview.addedPluginIds.length}개 · 제거 {pluginPreview.removedPluginIds.length}개 · 유지 {pluginPreview.unchangedPluginIds.length}개</p>
                    {pluginPreview.addedPluginIds.length > 0 ? <p className="text-emerald-700 dark:text-emerald-300">추가: {pluginPreview.addedPluginIds.join(', ')}</p> : null}
                    {pluginPreview.removedPluginIds.length > 0 ? <p className="text-amber-700 dark:text-amber-300">제거: {pluginPreview.removedPluginIds.join(', ')}</p> : null}
                  </>
                ) : (
                  <p className="text-amber-700 dark:text-amber-300">{pluginPreview.currentCatalogError}</p>
                )}
                <p className="text-amber-700 dark:text-amber-300">
                  Connector 및 private workspace 권한은 계정 사이에 이전되지 않습니다. 전환 후 필요한 connector를 다시 인증해야 할 수 있습니다.
                </p>
                <Button size="sm" disabled={pluginReferenceBusy} onClick={() => void switchPluginReference()}>
                  확인하고 전환
                </Button>
              </div>
            ) : null}
            {pluginCatalog ? (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-xs font-medium">현재 catalog</p>
                {pluginCatalog.marketplaces.flatMap((marketplace) => marketplace.plugins.map((plugin) => (
                  <div key={`${marketplace.name}/${plugin.id}`} className="flex items-center justify-between gap-3 text-xs">
                    <span className="min-w-0 truncate" title={`${marketplace.name}/${plugin.id}`}>
                      {plugin.displayName ?? plugin.name}
                      <span className="ml-1 text-muted-foreground">· {marketplace.displayName ?? marketplace.name}</span>
                    </span>
                    {plugin.installed ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pluginReferenceBusy}
                        onClick={() => void mutatePlugin(
                          () => client.uninstallCodexPlugin(plugin.id),
                          '플러그인을 제거했습니다.',
                        )}
                      >
                        제거
                      </Button>
                    ) : plugin.installPolicy !== 'NOT_AVAILABLE' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pluginReferenceBusy}
                        onClick={() => void mutatePlugin(
                          () => client.installCodexPlugin({
                            ...(marketplace.path
                              ? { marketplacePath: marketplace.path }
                              : { remoteMarketplaceName: marketplace.name }),
                            pluginName: plugin.name,
                          }),
                          '플러그인을 설치했습니다.',
                        )}
                      >
                        설치
                      </Button>
                    ) : null}
                  </div>
                )))}
                {pluginCatalog.marketplaces.every((marketplace) => marketplace.plugins.length === 0) ? (
                  <p className="text-xs text-muted-foreground">표시할 플러그인이 없습니다.</p>
                ) : null}
              </div>
            ) : null}
            {pluginActionNotice ? <p className="text-xs text-muted-foreground">{pluginActionNotice}</p> : null}
            {pluginReferenceError ? <p className="text-xs text-destructive">{pluginReferenceError}</p> : null}
            <Dialog
              open={pluginDeleteAccount !== null}
              onOpenChange={(open) => { if (!open && !pluginDeleteBusy) setPluginDeleteAccount(null) }}
            >
              <DialogContent className="sm:max-w-sm">
                <DialogHeader>
                  <DialogTitle>Codex 플러그인 계정 삭제</DialogTitle>
                  <DialogDescription>
                    {pluginDeleteAccount?.nickname || pluginDeleteAccount?.email} 계정을 Native vault에서 삭제합니다.
                  </DialogDescription>
                </DialogHeader>
                {pluginDeleteAccount?.isPluginReference ? (
                  <div className="space-y-2">
                    <p className="text-sm text-amber-700 dark:text-amber-300">
                      현재 플러그인 기준계정이므로 먼저 다른 계정 또는 local-only로 전환해야 합니다.
                    </p>
                    <select
                      className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                      value={pluginDeleteReplacement}
                      onChange={(event) => setPluginDeleteReplacement(event.target.value)}
                      disabled={pluginDeleteBusy}
                    >
                      <option value="local_only">local-only</option>
                      {codexPluginAccounts.filter((account) => account.id !== pluginDeleteAccount.id).map((account) => (
                        <option key={account.id} value={account.id}>{account.nickname || account.email}</option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">
                      Connector와 private workspace 권한은 이전되지 않으며 다시 인증해야 할 수 있습니다.
                    </p>
                  </div>
                ) : null}
                {pluginDeleteError ? <p className="text-xs text-destructive">{pluginDeleteError}</p> : null}
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="outline" disabled={pluginDeleteBusy}>취소</Button>
                  </DialogClose>
                  <Button variant="destructive" disabled={pluginDeleteBusy} onClick={() => void deleteCodexPluginAccount()}>
                    <Trash2 className="size-4" aria-hidden />
                    {pluginDeleteBusy ? '처리 중…' : pluginDeleteAccount?.isPluginReference ? '전환 후 삭제' : '삭제'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </Row>

        <Separator />

        <Row label="모델 자동전환">
          <div className="space-y-3">
            {modelFallback?.active.map((active) => (
              <div
                key={active.preferredModel}
                className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
                role="status"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {active.preferredModel} → {active.effectiveModel} 자동 전환됨
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={modelFallbackBusy}
                    onClick={() => void updateModelFallback({ enabled: false })}
                  >
                    자동전환 끄기
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  선호 모델은 변경되지 않았습니다. 60초 간격의 제한된 probe에서 한도가 회복되면 자동 복귀합니다.
                  {active.accountAlias ? ` 현재 계정: ${active.accountAlias}.` : ''}
                </p>
              </div>
            ))}

            {!modelFallback?.enabled
              && !modelFallback?.promptDismissed
              && pendingModelFallbackOffers(modelFallback?.events ?? []).length > 0 ? (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                  <p className="text-sm font-medium">원 모델의 모든 계정 한도가 소진되었습니다.</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    서버 capability 또는 호환 mapping으로 허용된 모델에만 자동 전환할 수 있습니다. 더 비싼 모델 사용량이 발생할 수 있습니다.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={modelFallbackBusy}
                      onClick={() => void updateModelFallback({ enabled: true })}
                    >
                      자동전환 켜기
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={modelFallbackBusy}
                      onClick={() => void updateModelFallback({ promptDismissed: true })}
                    >
                      다시 보지 않기
                    </Button>
                  </div>
                </div>
              ) : null}

            <div className="flex items-start justify-between gap-4 rounded-md border bg-background/70 p-3">
              <div>
                <Label htmlFor="model-auto-fallback">허용된 모델로 자동전환</Label>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  기본값은 꺼짐입니다. 같은 모델의 모든 계정을 먼저 시도하며, 선호 모델 설정을 덮어쓰지 않습니다.
                </p>
              </div>
              <Switch
                id="model-auto-fallback"
                checked={modelFallback?.enabled ?? false}
                disabled={!modelFallback || modelFallbackBusy}
                onCheckedChange={(enabled) => void updateModelFallback({ enabled })}
              />
            </div>
            {modelFallbackError ? <p className="text-xs text-destructive">{modelFallbackError}</p> : null}
          </div>
        </Row>

        <Separator />

        {/* (d) Proxy restart */}
        <Row label="진단">
          <BatonStatusCard />
        </Row>

        <Separator />

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
