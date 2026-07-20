import { Activity, TriangleAlert, Users } from 'lucide-react'

import type { Account, AccountQuota, Provider, ProxyStatus } from '@/api/types'

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
  proxy,
}: {
  accounts: Record<string, Account[]> | null
  quotas: Record<string, Record<string, AccountQuota | null>> | null
  proxy: ProxyStatus | null
}) {
  const allAccounts = PROVIDERS.flatMap((provider) => accounts?.[provider] ?? [])
  const activeAccounts = allAccounts.filter((account) => !account.paused).length
  const highUsageWindows = PROVIDERS.flatMap((provider) => (
    Object.values(quotas?.[provider] ?? {}).flatMap((quota) => quota?.windows ?? [])
  )).filter((window) => window.usedPercent >= 85).length

  return (
    <div className="grid gap-3 sm:grid-cols-3">
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
        icon={TriangleAlert}
        label="높은 사용량"
        value={`${highUsageWindows}`}
        detail="85% 이상인 quota 구간"
      />
    </div>
  )
}
