import type { Account, PolicyState, RoutingStrategyName } from '../../api/types.ts'
import type { CanonicalProvider } from './types.ts'

export interface ProviderAccountSummary {
  provider: CanonicalProvider
  isLoading: boolean
  activeAccounts: Account[]
  recentAccount: Account | null
  targetAccount: Account | null
  reserveAccount: Account | null
  strategy: RoutingStrategyName | null
  triggerLabel: string
}

export function providerAccountLabel(account: Account): string {
  return account.nickname.trim() || account.email.trim() || account.id
}

export function summarizeProviderAccounts(
  provider: CanonicalProvider,
  accounts: Record<string, Account[]> | null,
  policy: PolicyState | null,
  strategy: RoutingStrategyName | null,
): ProviderAccountSummary {
  const providerAccounts = accounts?.[provider] ?? []
  const activeAccounts = providerAccounts.filter((account) => !account.paused)
  const providerPolicy = policy?.providers.find((state) => state.provider === provider) ?? null
  const byId = new Map(providerAccounts.map((account) => [account.id, account]))
  const recentAccount = [...providerAccounts]
    .filter((account) => validTimestamp(account.lastUsedAt))
    .sort((left, right) => Date.parse(right.lastUsedAt as string) - Date.parse(left.lastUsedAt as string))[0]
    ?? null

  return {
    provider,
    isLoading: accounts === null,
    activeAccounts,
    recentAccount,
    targetAccount: policy?.enabled && providerPolicy?.target
      ? byId.get(providerPolicy.target) ?? null
      : null,
    reserveAccount: policy?.enabled && providerPolicy?.reserve
      ? byId.get(providerPolicy.reserve) ?? null
      : null,
    strategy,
    triggerLabel: accounts === null
      ? '계정 확인 중'
      : activeAccounts.length === 0
      ? '계정 없음'
      : activeAccounts.length === 1
        ? providerAccountLabel(activeAccounts[0])
        : `계정 ${activeAccounts.length}개`,
  }
}

function validTimestamp(value: string | undefined): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}
