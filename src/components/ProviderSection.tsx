import { Plus } from 'lucide-react'

import type { Account, AccountQuota, PolicyProviderState, Provider } from '@/api/types'
import { Button } from '@/components/ui/button'
import { AccountCard, type AccountStatus } from '@/components/AccountCard'

/** Display name per provider. */
const PROVIDER_LABEL: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  ghcp: 'GitHub Copilot',
}

/**
 * Derive an account's honest display state. A paused account reads as paused
 * regardless of any engine role (a paused target isn't serving), so the paused
 * check comes first.
 */
function statusOf(
  account: Account,
  engineEnabled: boolean,
  ps: PolicyProviderState | null,
): AccountStatus {
  if (engineEnabled && ps) {
    // enginePaused is the crash-recovery ledger for pauses owned by an older
    // policy version. It remains authoritative until the accounts poll reflects
    // restoration, so the UI does not silently reclassify ownership.
    const enginePaused = ps.enginePaused.includes(account.id)
    if (account.paused || enginePaused) return enginePaused ? 'engine-paused' : 'user-paused'
    if (account.id === ps.target) return 'target'
    if (account.id === ps.reserve) return 'reserve'
    return 'active'
  }
  return account.paused ? 'user-paused' : 'active'
}

export interface ProviderSectionProps {
  provider: Provider
  accounts: Account[]
  /** Keyed by account id; value null = quota still loading for that account. */
  quotas: Record<string, AccountQuota | null>
  /** Smart-rotation engine on? Gates manual controls in the cards. */
  engineEnabled: boolean
  /** This provider's policy ordering and legacy pause-recovery snapshot, or null. */
  providerState: PolicyProviderState | null
  onPause: (provider: Provider, accountId: string) => void
  onResume: (provider: Provider, accountId: string) => void
  onSolo: (provider: Provider, accountId: string) => void
  onRefreshEntitlements?: (accountId: string) => void
  onPrefer?: (accountId: string) => void
  onRemove: (provider: Provider, accountId: string) => void
  onReassignPluginReference?: (accountId: string | null) => Promise<void>
  onAddAccount: (provider: Provider) => void
}

export function ProviderSection({
  provider,
  accounts,
  quotas,
  engineEnabled,
  providerState,
  onPause,
  onResume,
  onSolo,
  onRefreshEntitlements,
  onPrefer,
  onRemove,
  onReassignPluginReference,
  onAddAccount,
}: ProviderSectionProps) {
  // A sibling exists to "solo against" when ≥1 other account is currently unpaused.
  const unpausedCount = accounts.filter((a) => !a.paused).length

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-baseline gap-1.5 text-sm font-semibold text-foreground">
          {PROVIDER_LABEL[provider]}
          <span className="text-xs font-normal text-muted-foreground tabular-nums">
            ({accounts.length})
          </span>
        </h2>
        <Button variant="outline" size="sm" onClick={() => onAddAccount(provider)}>
          <Plus className="size-4" aria-hidden />
          계정 추가
        </Button>
      </div>

      {accounts.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          등록된 계정이 없습니다.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 min-[900px]:grid-cols-2">
          {accounts.map((account) => {
            const status = statusOf(account, engineEnabled, providerState)
            // Solo makes sense only when this account is active and there is a
            // sibling to exclude (unpaused count > 1 including this one).
            const canSolo = status === 'active' && unpausedCount > 1
            return (
              <AccountCard
                key={account.id}
                account={account}
                quota={quotas[account.id] ?? null}
                status={status}
                engineEnabled={engineEnabled}
                canSolo={canSolo}
                onPause={() => onPause(provider, account.id)}
                onResume={() => onResume(provider, account.id)}
                onSolo={() => onSolo(provider, account.id)}
                onRefreshEntitlements={provider === 'codex' && onRefreshEntitlements
                  ? () => onRefreshEntitlements(account.id)
                  : undefined}
                onPrefer={provider === 'claude' && onPrefer
                  ? () => onPrefer(account.id)
                  : undefined}
                onRemove={() => onRemove(provider, account.id)}
                pluginReferenceAlternatives={provider === 'codex'
                  ? accounts.filter((candidate) => candidate.id !== account.id)
                  : undefined}
                onReassignPluginReference={provider === 'codex'
                  ? onReassignPluginReference
                  : undefined}
              />
            )
          })}
        </div>
      )}
    </section>
  )
}
