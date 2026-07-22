/** Single-instance guard for the loopback control port. */

export type PortConflictVerdict = 'yield' | 'foreign'

export interface PortConflictOptions {
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch
  /** Bound the probe so a hung incumbent cannot stall startup. */
  timeoutMs?: number
}

/**
 * Decide what a freshly started worker should do when its loopback control port
 * is already bound (EADDRINUSE). If the incumbent answers `/baton/health` as a
 * healthy Baton, this process is a duplicate supervisor firing from Task
 * Scheduler and must stand down cleanly ('yield') rather than crash-loop against
 * the healthy instance. Any other outcome — non-Baton listener, error response,
 * refused connection, or timeout — is a real fault ('foreign') the runner should
 * surface and retry.
 */
export async function classifyPortConflict(
  port: number,
  host = '127.0.0.1',
  options: PortConflictOptions = {},
): Promise<PortConflictVerdict> {
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 2_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await doFetch(`http://${host}:${port}/baton/health`, {
      signal: controller.signal,
    })
    if (!response.ok) return 'foreign'
    const body = await response.json() as { ok?: unknown }
    return body?.ok === true ? 'yield' : 'foreign'
  } catch {
    return 'foreign'
  } finally {
    clearTimeout(timer)
  }
}
