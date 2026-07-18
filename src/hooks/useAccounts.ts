/** Per-provider account lists, polled every 30s. */
import type { Account, Provider } from '@/api/types'
import { client } from '@/api/client'
import { usePolling } from '@/hooks/usePolling'

export function useAccounts(): {
  accounts: Record<Provider, Account[]> | null
  refresh: () => void
  error: Error | null
} {
  const { data, refresh, error } = usePolling(client.getAccounts, 30_000)
  return { accounts: data, refresh, error }
}
