import { Check, CircleUserRound, Clock3, Route } from 'lucide-react'

import type { Account, PolicyState, RoutingStrategyName } from '@/api/types'
import { cn } from '@/lib/utils'

import {
  providerAccountLabel,
  summarizeProviderAccounts,
} from './provider-account-summary'
import type { CanonicalProvider } from './types'

const PROVIDER_NAME: Record<CanonicalProvider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  gemini: 'Gemini',
}

export function ProviderAccountDisclosure({
  provider,
  accounts,
  policy,
  strategy,
}: {
  provider: CanonicalProvider
  accounts: Record<string, Account[]> | null
  policy: PolicyState | null
  strategy: RoutingStrategyName | null
}) {
  const summary = summarizeProviderAccounts(provider, accounts, policy, strategy)

  return (
    <details className="group relative">
      <summary
        className={cn(
          'flex h-7 max-w-36 cursor-pointer list-none items-center gap-1.5 rounded-lg bg-muted/70 px-2 text-xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden',
          !summary.isLoading && summary.activeAccounts.length === 0 && 'text-destructive',
        )}
        title={`${PROVIDER_NAME[provider]} 라우팅 계정 보기`}
        aria-label={`${PROVIDER_NAME[provider]} 라우팅 계정: ${summary.triggerLabel}`}
      >
        <CircleUserRound className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{summary.triggerLabel}</span>
      </summary>

      <div className="absolute bottom-full left-0 z-40 mb-2 w-[min(18rem,calc(100vw-2rem))] rounded-xl border bg-popover p-3 text-popover-foreground shadow-xl">
        <p className="text-xs font-semibold">{PROVIDER_NAME[provider]} 계정 라우팅</p>

        <dl className="mt-2 space-y-2 text-xs">
          {summary.targetAccount ? (
            <AccountRow icon={Route} label="정책 1순위" account={summary.targetAccount} />
          ) : null}
          {summary.reserveAccount ? (
            <AccountRow icon={Check} label="예비" account={summary.reserveAccount} />
          ) : null}
          {summary.recentAccount ? (
            <AccountRow icon={Clock3} label="최근 실제 사용" account={summary.recentAccount} />
          ) : null}
          <div className="grid grid-cols-[6.5rem_1fr] gap-2">
            <dt className="text-muted-foreground">활성 풀</dt>
            <dd className="min-w-0">
              {summary.isLoading
                ? '확인 중…'
                : summary.activeAccounts.length > 0
                ? summary.activeAccounts.map(providerAccountLabel).join(', ')
                : '사용 가능한 계정 없음'}
            </dd>
          </div>
        </dl>

        {summary.activeAccounts.length > 1 ? (
          <p className="mt-3 border-t pt-2 text-[0.6875rem] leading-4 text-muted-foreground">
            {summary.strategy === 'fill-first'
              ? '첫 계정을 우선 사용하고 실패하면 다음 계정으로 이동합니다.'
              : '요청은 활성 계정 사이에서 순환하므로 다음 계정은 미리 확정되지 않습니다.'}
          </p>
        ) : null}
      </div>
    </details>
  )
}

function AccountRow({
  icon: Icon,
  label,
  account,
}: {
  icon: typeof Route
  label: string
  account: Account
}) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-2">
      <dt className="flex items-center gap-1 whitespace-nowrap text-muted-foreground">
        <Icon className="size-3" aria-hidden />
        {label}
      </dt>
      <dd className="min-w-0 truncate" title={account.email || account.id}>
        {providerAccountLabel(account)}
      </dd>
    </div>
  )
}
