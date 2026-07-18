import { Activity, RotateCw, TriangleAlert, Users } from 'lucide-react'

import type { Account, AccountQuota, PolicyState, Provider, ProxyStatus } from '@/api/types'

const PROVIDERS: Provider[] = ['claude', 'codex']

function Metric({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Activity
  label: string
  value: string
  detail: string
}) {
  return (
    <div className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className="size-4" aria-hidden />
        {label}
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  )
}

export function DashboardOverview({
  accounts,
  quotas,
  policy,
  proxy,
}: {
  accounts: Record<string, Account[]> | null
  quotas: Record<string, Record<string, AccountQuota | null>> | null
  policy: PolicyState | null
  proxy: ProxyStatus | null
}) {
  const allAccounts = PROVIDERS.flatMap((provider) => accounts?.[provider] ?? [])
  const activeAccounts = allAccounts.filter((account) => !account.paused).length
  const highUsageWindows = PROVIDERS.flatMap((provider) => (
    Object.values(quotas?.[provider] ?? {}).flatMap((quota) => quota?.windows ?? [])
  )).filter((window) => window.usedPercent >= 85).length
  const targetedProviders = policy?.providers.filter((provider) => provider.target).length ?? 0

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric
        icon={Activity}
        label="프록시"
        value={proxy?.running ? '정상' : '정지'}
        detail={proxy?.running ? `127.0.0.1:${proxy.port}` : '요청을 전달하지 않습니다'}
      />
      <Metric
        icon={Users}
        label="활성 계정"
        value={`${activeAccounts} / ${allAccounts.length}`}
        detail={`${allAccounts.length - activeAccounts}개 일시정지`}
      />
      <Metric
        icon={RotateCw}
        label="스마트 로테이션"
        value={policy?.enabled ? 'ON' : 'OFF'}
        detail={policy?.enabled ? `${targetedProviders}개 provider 조향 중` : 'CLIProxy 기본 전략 사용'}
      />
      <Metric
        icon={TriangleAlert}
        label="높은 사용량"
        value={`${highUsageWindows}`}
        detail="85% 이상인 quota 구간"
      />
    </div>
  )
}
