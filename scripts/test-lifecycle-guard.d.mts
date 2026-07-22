export interface LiveBatonSnapshot {
  listenerPid: number | null
  health: unknown
  tasks: Array<{ path: string; name: string; xml: string }>
}

export function assertLiveBatonUnchanged(
  before: LiveBatonSnapshot,
  after: LiveBatonSnapshot,
): void

export function snapshotLiveBaton(): Promise<LiveBatonSnapshot>

export function liveSnapshotScript(): string
