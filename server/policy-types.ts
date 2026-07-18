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

/** One line in the steering ring buffer — the "what & why" of every action. */
export interface SteerLogEntry {
  /** epoch ms */
  ts: number
  provider: string
  /**
   * 'target' = engine picked this account as the one to spend first. Steering is
   * enacted purely via pause/resume (removing others from CLIProxy rotation) —
   * there is no "default account" routing lever (CLIProxy round-robins all
   * non-paused credentials; the CCS `default` flag does not affect routing).
   */
  action: 'target' | 'pause' | 'resume' | 'info' | 'error'
  accountId?: string
  reason: string
}

/** Per-provider snapshot of the current steering decision. */
export interface PolicyProviderState {
  provider: string
  /** account id the engine spends first (soonest reset), or null when not steering. */
  target: string | null
  /** account id kept active as 429 failover reserve, or null. */
  reserve: string | null
  /** account ids the ENGINE paused this tick (distinguishes engine-pause from user-pause in the UI). */
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
