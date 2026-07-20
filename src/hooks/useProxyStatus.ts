/** CLIProxy status, polled every 10s (lightweight; detects restarts). */
import type { ProxyStatus } from '@/api/types'
import { client } from '@/api/client'
import { usePolling } from '@/hooks/usePolling'

export function useProxyStatus(): { status: ProxyStatus | null; refresh: () => void } {
  const { data, refresh } = usePolling(client.getProxyStatus, 10_000)
  return { status: data, refresh }
}
