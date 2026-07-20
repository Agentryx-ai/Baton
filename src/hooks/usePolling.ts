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
  const requestSequence = useRef(0)

  // Keep the latest fn without retriggering the polling effect.
  const fnRef = useRef(fn)
  fnRef.current = fn

  const refresh = useCallback(() => {
    const sequence = ++requestSequence.current
    setLoading(true)
    fnRef.current()
      .then((result) => {
        if (sequence !== requestSequence.current) return
        setData(result)
        setError(null)
      })
      .catch((err: unknown) => {
        if (sequence !== requestSequence.current) return
        setError(err instanceof Error ? err : new Error(String(err)))
      })
      .finally(() => {
        if (sequence !== requestSequence.current) return
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
      requestSequence.current += 1
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [intervalMs, refresh])

  return { data, error, refresh, loading }
}
