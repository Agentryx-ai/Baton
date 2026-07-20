import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type {
  AccountQuota,
  ClientIntegrationApplyResult,
  ClientIntegrationTarget,
  ClaudeProxyMode,
  CodexIntegrationMode,
  Provider,
} from '@/api/types'
import { UI_PROVIDERS } from '@/api/types'
import { client } from '@/api/client'
import { useAccounts } from '@/hooks/useAccounts'
import { useProxyStatus } from '@/hooks/useProxyStatus'
import { usePolling } from '@/hooks/usePolling'
import { Header } from '@/components/Header'
import { ModelFallbackNotice } from '@/components/ModelFallbackNotice'
import { AppNavigation, type AppView } from '@/components/AppNavigation'
import { DashboardOverview } from '@/components/DashboardOverview'
import { ProviderSection } from '@/components/ProviderSection'
import { SettingsSection } from '@/components/SettingsSection'
import AddAccountWizard from '@/components/AddAccountWizard'
import { ConversationWorkspace } from '@/features/conversations'
import {
  loadSessionViewPreferences,
  saveSessionViewPreferences,
  type SessionViewPreferences,
} from '@/features/conversations/session-view-preferences'

/** Nested quota map: provider → accountId → quota (null = loading/failed). */
type QuotaMap = Record<string, Record<string, AccountQuota | null>>

function viewFromHash(): AppView {
  const value = window.location.hash.replace(/^#\/?/, '')
  return value === 'conversations' || value === 'settings' ? value : 'home'
}

function App() {
  const [activeView, setActiveView] = useState<AppView>(viewFromHash)
  const { accounts, refresh: refreshAccounts } = useAccounts()
  const { status: proxy, refresh: refreshProxyStatus } = useProxyStatus()
  const [wizardOpen, setWizardOpen] = useState(false)
  const [pluginAccountRefreshKey, setPluginAccountRefreshKey] = useState(0)
  const [conversationPreferences, setConversationPreferences] = useState<SessionViewPreferences>(loadSessionViewPreferences)

  useEffect(() => {
    saveSessionViewPreferences(conversationPreferences)
  }, [conversationPreferences])

  useEffect(() => {
    const onHashChange = () => setActiveView(viewFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const navigate = (view: AppView) => {
    if (view === activeView) return
    window.location.hash = view
  }

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

  const {
    data: clientIntegration,
    error: clientIntegrationError,
    refresh: refreshClientIntegration,
    loading: clientIntegrationLoading,
  } = usePolling(client.getClientIntegrationStatus, 5_000)

  const refreshAll = useCallback(() => {
    refreshAccounts()
    refreshQuotas()
    refreshProxyStatus()
    refreshClientIntegration()
  }, [
    refreshAccounts,
    refreshQuotas,
    refreshProxyStatus,
    refreshClientIntegration,
  ])

  // Account actions — fire the mutation then refresh the affected data.
  const accountRevision = (prov: Provider, id: string) =>
    accounts?.[prov]?.find((account) => account.id === id)?.revision
  const onPause = (prov: Provider, id: string) =>
    void client.pauseAccount(prov, id, accountRevision(prov, id)).then(refreshAccounts)
  // "이 계정만" pauses every currently-unpaused sibling in the Native pool.
  const onSolo = (prov: Provider, id: string) => {
    const siblings = (accounts?.[prov] ?? []).filter((a) => a.id !== id && !a.paused)
    if (siblings.length === 0) return
    // Always refresh (even on partial failure) so the card grid reflects the real
    // post-solo pool rather than an assumed all-or-nothing outcome.
    void Promise.all(siblings.map((a) => client.pauseAccount(prov, a.id, a.revision)))
      .catch(() => toast.error('일부 계정 일시정지에 실패했습니다'))
      .finally(refreshAccounts)
  }
  const onResume = (prov: Provider, id: string) =>
    void client.resumeAccount(prov, id, accountRevision(prov, id)).then(refreshAccounts)
  const onRemove = (prov: Provider, id: string) =>
    void client.removeAccount(prov, id, accountRevision(prov, id)).then(refreshAll)
  const onReassignCodexPluginReference = async (accountId: string | null) => {
    const preview = await client.previewCodexPluginReference(accountId === null
      ? { mode: 'local_only', accountId: null }
      : { mode: 'account', accountId })
    await client.switchCodexPluginReference(preview)
    refreshAccounts()
  }
  const onAddAccount = (_prov: Provider) => {
    setWizardOpen(true)
  }

  // Settings actions.
  const onApplyClientIntegration = async (
    targets: ClientIntegrationTarget[],
    codexMode?: CodexIntegrationMode,
    claudeProxyMode?: ClaudeProxyMode,
  ): Promise<ClientIntegrationApplyResult> => {
    const result = await client.applyClientIntegration(targets, codexMode, claudeProxyMode)
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

  const codexIntegration = clientIntegration?.targets.find((target) => target.target === 'codex')
  const codexNativeApplied = codexIntegration?.configuration === 'applied'
    && codexIntegration.codexMode === 'native-openai'
  const claudeNativeApplied = clientIntegration?.targets.some((target) => (
    target.target !== 'codex'
    && target.configuration === 'applied'
    && target.claudeProxyMode === 'native'
  )) ?? false
  const onPreferClaudeAccount = (accountId: string) => {
    void client.preferAccount('claude', accountId).then(() => {
      toast.success('Claude Native 우선계정을 변경했습니다.')
      refreshAccounts()
    }).catch((error) => {
      toast.error(error instanceof Error ? error.message : String(error))
    })
  }
  const onRefreshCodexEntitlements = (accountId: string) => {
    void client.refreshCodexEntitlements(accountId).then(() => {
      toast.success('Codex OAuth와 모델 엔트리먼트를 새로고침했습니다.')
      refreshAll()
    }).catch((error) => {
      toast.error(error instanceof Error ? error.message : String(error))
    })
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header proxy={proxy} onRefresh={refreshAll} />
      <ModelFallbackNotice />

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
              proxy={proxy}
            />

            {codexIntegration && codexIntegration.configuration !== 'applied' && (
              <div className="rounded-xl border border-danger/50 bg-danger/10 px-4 py-3 text-sm" role="alert">
                <p className="font-semibold text-danger">Codex가 Baton Native를 사용하지 않습니다.</p>
                <p className="mt-1 text-muted-foreground">
                  Codex CLI/Desktop을 종료한 뒤 설정에서 Native 연결을 적용하세요.
                </p>
              </div>
            )}

            {UI_PROVIDERS.map((prov) => (
              <ProviderSection
                key={prov}
                provider={prov}
                accounts={accounts?.[prov] ?? []}
                quotas={quotaMap?.[prov] ?? {}}
                engineEnabled={false}
                providerState={null}
                onPause={onPause}
                onResume={onResume}
                onSolo={onSolo}
                onRefreshEntitlements={prov === 'codex' && codexNativeApplied
                  ? onRefreshCodexEntitlements
                  : undefined}
                onPrefer={prov === 'claude' && claudeNativeApplied
                  ? onPreferClaudeAccount
                  : undefined}
                onRemove={onRemove}
                onReassignPluginReference={prov === 'codex'
                  ? onReassignCodexPluginReference
                  : undefined}
                onAddAccount={onAddAccount}
              />
            ))}
          </section>

          <section hidden={activeView !== 'conversations'}>
            <ConversationWorkspace
              onNavigateHome={() => navigate('home')}
              onNavigateSettings={() => navigate('settings')}
              accounts={accounts}
              policy={null}
              routingStrategy="fill-first"
              viewPreferences={conversationPreferences}
              onViewPreferencesChange={setConversationPreferences}
            />
          </section>

          <section hidden={activeView !== 'settings'} className="mx-auto max-w-5xl space-y-6 px-4 py-6">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">설정</h1>
              <p className="mt-1 text-sm text-muted-foreground">라우팅과 클라이언트 연결 관리</p>
            </div>
            <SettingsSection
              clientIntegration={clientIntegration}
              clientIntegrationError={clientIntegrationError}
              clientIntegrationLoading={clientIntegrationLoading}
              onRefreshClientIntegration={refreshClientIntegration}
              onApplyClientIntegration={onApplyClientIntegration}
              onRemoveClientIntegration={onRemoveClientIntegration}
              conversationPreferences={conversationPreferences}
              onConversationPreferencesChange={setConversationPreferences}
              onPluginReferenceChanged={refreshAccounts}
              pluginAccountRefreshKey={pluginAccountRefreshKey}
            />
          </section>
        </main>
      </div>

      <AddAccountWizard
        open={wizardOpen}
        onOpenChange={(open) => {
          setWizardOpen(open)
        }}
        onAdded={() => {
          refreshAll()
          setPluginAccountRefreshKey((value) => value + 1)
        }}
      />
    </div>
  )
}

export default App
