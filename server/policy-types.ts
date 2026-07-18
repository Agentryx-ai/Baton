/**
 * Server-side copies of the policy engine API shapes.
 *
 * The server has its own tsconfig and runs via `tsx` (ESM), so it cannot import
 * from `src/`. These types MUST stay structurally identical to the matching
 * declarations in `src/api/types.ts` (the shared front-end contract). Any change
 * to the SPA contract there has to be mirrored here by hand.
 */

/** Only one policy exists in v1. */
export type PolicyId = 'reset-imminent-first'

/** Canonical policy id value (single source for the string literal). */
export const POLICY_ID: PolicyId = 'reset-imminent-first'

/** One line in the policy ring buffer — the "what & why" of every action. */
export interface SteerLogEntry {
  /** epoch ms */
  ts: number
  provider: string
  /** 'target' = calculated policy rank 1; it is not the actual request destination. */
  action: 'target' | 'pause' | 'resume' | 'info' | 'error'
  accountId?: string
  reason: string
}

/** Per-provider snapshot of the current observed policy ordering. */
export interface PolicyProviderState {
  provider: string
  /** calculated rank-1 account id (soonest reset), not an enforced destination. */
  target: string | null
  /** calculated rank-2 account id; all non-manually-paused accounts remain active. */
  reserve: string | null
  /** legacy engine-owned pauses pending crash-safe restoration. */
  enginePaused: string[]
}

/** Full engine state returned to the SPA over `/baton/policy`. */
export interface PolicyState {
  enabled: boolean
  policy: PolicyId
  /** seconds between engine ticks. */
  tickSeconds: number
  providers: PolicyProviderState[]
  log: SteerLogEntry[]
  lastTickAt: number | null
}
