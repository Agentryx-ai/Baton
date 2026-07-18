/**
 * Visibility-aware polling primitive.
 *
 * - Fetches once on mount, then on an interval.
 * - When the tab is hidden (`document.hidden`) the interval is stopped; on
 *   returning to visible it fetches immediately once and resumes.
 * - `fn` identity changes do not thrash the interval — the latest `fn` is read
 *   through a ref, so only `intervalMs` changes restart polling.
 * - Cleans up the interval and listener on unmount.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface PollingResult<T> {
  data: T | null
  error: Error | null
  refresh: () => void
  loading: boolean
}

export function usePolling<T>(
  fn: () => Promise<T>,
  intervalMs: number,
): PollingResult<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(false)

  // Keep the latest fn without retriggering the polling effect.
  const fnRef = useRef(fn)
  fnRef.current = fn

  const refresh = useCallback(() => {
    setLoading(true)
    fnRef.current()
      .then((result) => {
        setData(result)
        setError(null)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err : new Error(String(err)))
      })
      .finally(() => {
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    let timer: number | undefined

    const stop = () => {
      if (timer !== undefined) {
        window.clearInterval(timer)
        timer = undefined
      }
    }
    const start = () => {
      stop()
      timer = window.setInterval(refresh, intervalMs)
    }
    const onVisibilityChange = () => {
      if (document.hidden) {
        stop()
      } else {
        refresh()
        start()
      }
    }

    // Initial fetch, then poll only while visible.
    refresh()
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [intervalMs, refresh])

  return { data, error, refresh, loading }
}
