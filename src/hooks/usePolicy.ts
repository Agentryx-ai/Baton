/**
 * Policy engine state (BFF `/baton/policy`), polled every 5s.
 * `setEnabled` toggles the engine then immediately refreshes.
 */
import { useCallback } from 'react'
import type { PolicyState } from '@/api/types'
import { client } from '@/api/client'
import { usePolling } from '@/hooks/usePolling'

export function usePolicy(): {
  state: PolicyState | null
  setEnabled: (enabled: boolean) => Promise<void>
  refresh: () => void
} {
  const { data, refresh } = usePolling(client.getPolicy, 5_000)

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      await client.setPolicy(enabled)
      refresh()
    },
    [refresh],
  )

  return { state: data, setEnabled, refresh }
}
