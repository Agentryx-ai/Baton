import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type {
  AccountQuota,
  ClientIntegrationApplyResult,
  ClientIntegrationTarget,
  CodexIntegrationMode,
  PolicyProviderState,
  Provider,
  RoutingStrategy,
  SessionAffinity,
} from '@/api/types'
import { UI_PROVIDERS } from '@/api/types'
import { client } from '@/api/client'
import { useAccounts } from '@/hooks/useAccounts'
import { usePolicy } from '@/hooks/usePolicy'
import { useProxyStatus } from '@/hooks/useProxyStatus'
import { usePolling } from '@/hooks/usePolling'
import { Header } from '@/components/Header'
import { AppNavigation, type AppView } from '@/components/AppNavigation'
import { DashboardOverview } from '@/components/DashboardOverview'
import { RotationPanel } from '@/components/RotationPanel'
import { ProviderSection } from '@/components/ProviderSection'
import { SettingsSection } from '@/components/SettingsSection'
import AddAccountWizard from '@/components/AddAccountWizard'
import { ConversationWorkspace } from '@/features/conversations'

/** Nested quota map: provider → accountId → quota (null = loading/failed). */
type QuotaMap = Record<string, Record<string, AccountQuota | null>>

function viewFromHash(): AppView {
  const value = window.location.hash.replace(/^#\/?/, '')
  return value === 'conversations' || value === 'settings' ? value : 'home'
}

function App() {
  const [activeView, setActiveView] = useState<AppView>(viewFromHash)
  const { accounts, refresh: refreshAccounts } = useAccounts()
  const { state: policy, setEnabled } = usePolicy()
  const { status: proxy } = useProxyStatus()
  const [wizardOpen, setWizardOpen] = useState(false)
  const [apiKey, setApiKey] = useState<string | null>(null)

  useEffect(() => {
    const onHashChange = () => setActiveView(viewFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const navigate = (view: AppView) => {
    if (view === activeView) return
    window.location.hash = view
  }

  // Proxy auth token for the connection snippet (rarely changes — fetch once).
  useEffect(() => {
    let cancelled = false
    fetch('/api/settings/auth/tokens/raw', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.apiKey?.value) setApiKey(d.apiKey.value as string)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Quotas: one call per account. Can't loop a per-account hook, so poll them
  // together here (60s, DESIGN §6) and refresh whenever the account set changes.
  const {
    data: quotaMap,
    refresh: refreshQuotas,
  } = usePolling<QuotaMap>(
    useCallback(async () => {
      const result: QuotaMap = {}
      if (!accounts) return result
      await Promise.all(
        UI_PROVIDERS.flatMap((prov) =>
          (accounts[prov] ?? []).map(async (acc) => {
            ;(result[prov] ??= {})
            try {
              result[prov][acc.id] = await client.getQuota(prov, acc.id)
            } catch {
              result[prov][acc.id] = null
            }
          }),
        ),
      )
      return result
    }, [accounts]),
    60_000,
  )

  // When the account set first loads / changes, pull quotas immediately.
  const accountsKey = accounts
    ? UI_PROVIDERS.map((p) => (accounts[p] ?? []).map((a) => a.id).join(',')).join('|')
    : ''
  useEffect(() => {
    if (accountsKey) refreshQuotas()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountsKey])

  // Routing + session-affinity (settings).
  const { data: routing, refresh: refreshRouting } = usePolling<RoutingStrategy>(
    client.getRoutingStrategy,
    30_000,
  )
  const { data: affinity, refresh: refreshAffinity } = usePolling<SessionAffinity>(
    client.getSessionAffinity,
    30_000,
  )
  const {
    data: clientIntegration,
    error: clientIntegrationError,
    refresh: refreshClientIntegration,
    loading: clientIntegrationLoading,
  } = usePolling(client.getClientIntegrationStatus, 5_000)

  const refreshAll = useCallback(() => {
    refreshAccounts()
    refreshQuotas()
    refreshRouting()
    refreshAffinity()
    refreshClientIntegration()
  }, [
    refreshAccounts,
    refreshQuotas,
    refreshRouting,
    refreshAffinity,
    refreshClientIntegration,
  ])

  // Per-provider engine steering snapshot (target/reserve/enginePaused) for card state.
  const providerState = (prov: Provider): PolicyProviderState | null =>
    policy?.providers.find((p) => p.provider === prov) ?? null
  const engineEnabled = policy?.enabled ?? false

  // Account actions — fire the mutation then refresh the affected data.
  const onPause = (prov: Provider, id: string) =>
    void client.pauseAccount(prov, id).then(refreshAccounts)
  // "이 계정만"(solo): pause every currently-unpaused sibling so this account is
  // the only one CLIProxy rotates to. Honest "prefer this account" — enacted via
  // pause, the only real routing lever (manual mode only; see AccountCard).
  const onSolo = (prov: Provider, id: string) => {
    const siblings = (accounts?.[prov] ?? []).filter((a) => a.id !== id && !a.paused)
    if (siblings.length === 0) return
    // Always refresh (even on partial failure) so the card grid reflects the real
    // post-solo pool rather than an assumed all-or-nothing outcome.
    void Promise.all(siblings.map((a) => client.pauseAccount(prov, a.id)))
      .catch(() => toast.error('일부 계정 일시정지에 실패했습니다'))
      .finally(refreshAccounts)
  }
  const onResume = (prov: Provider, id: string) =>
    void client.resumeAccount(prov, id).then(refreshAccounts)
  const onRemove = (prov: Provider, id: string) =>
    void client.removeAccount(prov, id).then(refreshAll)
  const onAddAccount = (_prov: Provider) => setWizardOpen(true)

  // Settings actions.
  const onSetStrategy = (s: 'round-robin' | 'fill-first') =>
    void client.setRoutingStrategy(s).then(refreshRouting)
  const onSetAffinity = (enabled: boolean, ttl?: string) =>
    void client.setSessionAffinity(enabled, ttl).then(refreshAffinity)
  const onRestartProxy = () => void client.restartProxy()
  const onApplyClientIntegration = async (
    targets: ClientIntegrationTarget[],
    codexMode?: CodexIntegrationMode,
  ): Promise<ClientIntegrationApplyResult> => {
    const result = await client.applyClientIntegration(targets, codexMode)
    refreshClientIntegration()
    return result
  }
  const onRemoveClientIntegration = async (
    targets: ClientIntegrationTarget[],
  ) => {
    const result = await client.removeClientIntegration(targets)
    refreshClientIntegration()
    return result
  }

  const connectionSnippet = buildConnectionSnippet(proxy?.port ?? 8317, apiKey)
  const codexTarget = policy?.providers.find((provider) => provider.provider === 'codex')?.target
  const codexIntegration = clientIntegration?.targets.find((target) => target.target === 'codex')
  const codexTargetIsBypassed = Boolean(
    policy?.enabled
      && codexTarget
      && codexIntegration
      && codexIntegration.configuration !== 'applied',
  )

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header proxy={proxy} onRefresh={refreshAll} />

      {activeView !== 'conversations' && (
        <AppNavigation active={activeView} onNavigate={navigate} variant="mobile" />
      )}

      <div className="flex min-h-[calc(100vh-3.5rem-1px)] w-full">
        {activeView !== 'conversations' && (
          <AppNavigation active={activeView} onNavigate={navigate} variant="desktop" />
        )}

        <main className="min-w-0 flex-1">
          <section hidden={activeView !== 'home'} className="mx-auto max-w-5xl space-y-8 px-4 py-6">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">대시보드</h1>
              <p className="mt-1 text-sm text-muted-foreground">계정 사용량과 라우팅 상태</p>
            </div>

            <DashboardOverview
              accounts={accounts}
              quotas={quotaMap}
              policy={policy}
              proxy={proxy}
            />

            {codexTargetIsBypassed && (
              <div className="rounded-xl border border-danger/50 bg-danger/10 px-4 py-3 text-sm" role="alert">
                <p className="font-semibold text-danger">Codex가 Baton 프록시를 사용하지 않습니다.</p>
                <p className="mt-1 text-muted-foreground">
                  Codex CLI/Desktop을 종료한 뒤 설정에서 프록시를 적용하세요.
                </p>
              </div>
            )}

            <RotationPanel
              state={policy}
              accounts={accounts}
              onToggle={(enabled) => void setEnabled(enabled).then(refreshAccounts)}
            />

            {UI_PROVIDERS.map((prov) => (
              <ProviderSection
                key={prov}
                provider={prov}
                accounts={accounts?.[prov] ?? []}
                quotas={quotaMap?.[prov] ?? {}}
                engineEnabled={engineEnabled}
                providerState={providerState(prov)}
                onPause={onPause}
                onResume={onResume}
                onSolo={onSolo}
                onRemove={onRemove}
                onAddAccount={onAddAccount}
              />
            ))}
          </section>

          <section hidden={activeView !== 'conversations'}>
            <ConversationWorkspace
              onNavigateHome={() => navigate('home')}
              onNavigateSettings={() => navigate('settings')}
            />
          </section>

          <section hidden={activeView !== 'settings'} className="mx-auto max-w-5xl space-y-6 px-4 py-6">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">설정</h1>
              <p className="mt-1 text-sm text-muted-foreground">라우팅과 클라이언트 연결 관리</p>
            </div>
            <SettingsSection
              routing={routing}
              affinity={affinity}
              proxy={proxy}
              connectionSnippet={connectionSnippet}
              clientIntegration={clientIntegration}
              clientIntegrationError={clientIntegrationError}
              clientIntegrationLoading={clientIntegrationLoading}
              onSetStrategy={onSetStrategy}
              onSetAffinity={onSetAffinity}
              onRestartProxy={onRestartProxy}
              onRefreshClientIntegration={refreshClientIntegration}
              onApplyClientIntegration={onApplyClientIntegration}
              onRemoveClientIntegration={onRemoveClientIntegration}
            />
          </section>
        </main>
      </div>

      <AddAccountWizard open={wizardOpen} onOpenChange={setWizardOpen} onAdded={refreshAll} />
    </div>
  )
}

function buildConnectionSnippet(port: number, apiKey: string | null): string {
  const token = apiKey ?? '<발급된 토큰 로딩 중…>'
  return [
    '# Claude Code / Codex 등 클라이언트를 풀 프록시로 연결 (env 등록 필요):',
    '# 아래 토큰은 프록시 "출입 키" 1개입니다 — 계정 토큰이 아닙니다.',
    '# 계정 여러 개는 프록시 내부에서 이 키 하나 뒤로 자동 로테이션됩니다.',
    `ANTHROPIC_BASE_URL=http://127.0.0.1:${port}/api/provider/claude`,
    `ANTHROPIC_AUTH_TOKEN=${token}`,
    `# Codex는 base URL만 교체:  http://127.0.0.1:${port}/api/provider/codex`,
  ].join('\n')
}

export default App
