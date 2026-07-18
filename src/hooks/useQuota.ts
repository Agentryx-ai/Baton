/**
 * Quota for a single account, polled every 60s (the gateway server cache TTL is 2 min,
 * so faster is pointless — see docs/DESIGN.md §6).
 *
 * `ageSec` is derived from `quota.lastUpdated` (epoch ms) and recomputed every
 * second so the UI's "n초 전 기준" freshness label ticks smoothly between polls.
 */
import { useCallback, useEffect, useState } from 'react'
import type { AccountQuota, Provider } from '@/api/types'
import { client } from '@/api/client'
import { usePolling } from '@/hooks/usePolling'

export function useQuota(
  provider: Provider,
  accountId: string,
): { quota: AccountQuota | null; ageSec: number | null } {
  const fetchQuota = useCallback(
    () => client.getQuota(provider, accountId),
    [provider, accountId],
  )
  const { data } = usePolling(fetchQuota, 60_000)

  const [ageSec, setAgeSec] = useState<number | null>(null)
  useEffect(() => {
    if (!data) {
      setAgeSec(null)
      return
    }
    const compute = () =>
      setAgeSec(Math.max(0, Math.floor((Date.now() - data.lastUpdated) / 1000)))
    compute()
    const timer = window.setInterval(compute, 1000)
    return () => window.clearInterval(timer)
  }, [data])

  return { quota: data, ageSec }
}
