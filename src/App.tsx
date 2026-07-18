import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type {
  AccountQuota,
  ClientIntegrationApplyResult,
  ClientIntegrationTarget,
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
import { RotationPanel } from '@/components/RotationPanel'
import { ProviderSection } from '@/components/ProviderSection'
import { SettingsSection } from '@/components/SettingsSection'
import AddAccountWizard from '@/components/AddAccountWizard'

/** Nested quota map: provider → accountId → quota (null = loading/failed). */
type QuotaMap = Record<string, Record<string, AccountQuota | null>>

function App() {
  const { accounts, refresh: refreshAccounts } = useAccounts()
  const { state: policy, setEnabled } = usePolicy()
  const { status: proxy } = useProxyStatus()
  const [wizardOpen, setWizardOpen] = useState(false)
  const [apiKey, setApiKey] = useState<string | null>(null)

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
  ): Promise<ClientIntegrationApplyResult> => {
    const result = await client.applyClientIntegration(targets)
    refreshClientIntegration()
    return result
  }

  const connectionSnippet = buildConnectionSnippet(proxy?.port ?? 8317, apiKey)

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header proxy={proxy} onRefresh={refreshAll} />

      <main className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-6">
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
        />
      </main>

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
