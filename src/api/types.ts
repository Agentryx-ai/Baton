/**
 * Shared API contract types for Baton SPA.
 * Sourced from live gateway responses — see docs/DESIGN.md §2.4.
 * OWNED BY FOUNDATION. Do not edit in parallel tasks (read-only).
 */

export type Provider = 'claude' | 'codex' | 'gemini' | 'ghcp'

/** Providers Baton's UI surfaces in v1 (order = display order). */
export const UI_PROVIDERS: Provider[] = ['claude', 'codex']

export interface Account {
  id: string
  provider: string
  isDefault: boolean
  email: string
  nickname: string
  /** Paused = excluded from CLIProxy rotation (manual or by policy engine). */
  paused?: boolean
  createdAt?: string
  lastUsedAt?: string
}

export type RateLimitType = 'five_hour' | 'seven_day' | string

export interface QuotaWindow {
  rateLimitType: RateLimitType
  label: string
  status: string
  /** 0..1 */
  utilization?: number
  usedPercent: number
  remainingPercent: number
  /** ISO timestamp, or null when unknown. */
  resetAt: string | null
  overageResetsAt?: string | null
}

export interface AccountQuota {
  success: boolean
  /** Empty array = provider exposes no limit info for this account (a first-class state). */
  windows: QuotaWindow[]
  /** epoch ms when the gateway fetched this (server cache TTL is 2 min). */
  lastUpdated: number
  accountId: string
}

export interface ProxyStatus {
  running: boolean
  port: number
  pid: number
  sessionCount: number
  startedAt: string
  version: string
  target?: string
}

export type RoutingStrategyName = 'round-robin' | 'fill-first'

export interface RoutingStrategy {
  strategy: RoutingStrategyName
  source?: string
  target?: string
  reachable?: boolean
}

export interface SessionAffinity {
  enabled: boolean
  ttl: string
  manageable?: boolean
  message?: string
}

export type ClientKind =
  | 'claude-cli'
  | 'claude-desktop'
  | 'codex-cli'
  | 'codex-desktop'
  | 'unknown-codex-desktop'

export type ClientIntegrationTarget = 'claude-cli' | 'claude-desktop' | 'codex'

export interface ClientProcess {
  pid: number
  client: ClientKind
  label: string
  executable: string
}

export interface ClientIntegrationStatus {
  supported: boolean
  certainlyStopped: boolean
  checkedAt: string
  running: ClientProcess[]
  targets: ClientIntegrationTargetStatus[]
  error?: string
}

export interface ClientIntegrationTargetStatus {
  target: ClientIntegrationTarget
  label: string
  certainlyStopped: boolean
  running: ClientProcess[]
  configuration: ClientIntegrationConfigurationState
  configurationDetail?: string
}

export type ClientIntegrationConfigurationState =
  | 'applied'
  | 'not-applied'
  | 'conflict'
  | 'unknown'

export interface ClientIntegrationApplyResult {
  applied: true
  updated: string[]
  restartRequired: true
}

export interface ClientIntegrationRemoveResult {
  removed: true
  updated: string[]
  restartRequired: true
}

/** OAuth add-account progress. */
export interface AddStatus {
  status: 'wait' | 'success' | 'error'
  error?: string
}

export interface AddStart {
  url: string
  state: string
}

// ---- Policy engine (BFF /baton/*) ----

export type PolicyId = 'reset-imminent-first'

export interface SteerLogEntry {
  /** epoch ms */
  ts: number
  provider: string
  /** 'target' = engine picked this account to spend first (enacted via pause/resume; no default routing lever). */
  action: 'target' | 'pause' | 'resume' | 'info' | 'error'
  accountId?: string
  reason: string
}

export interface PolicyProviderState {
  provider: string
  /** account id the engine spends first (soonest reset), or null when not steering. */
  target: string | null
  /** account id kept active as failover reserve. */
  reserve: string | null
  /** account ids the ENGINE paused this tick (vs. user-paused) — drives card state badges. */
  enginePaused: string[]
}

export interface PolicyState {
  enabled: boolean
  policy: PolicyId
  /** seconds between engine ticks. */
  tickSeconds: number
  providers: PolicyProviderState[]
  log: SteerLogEntry[]
  lastTickAt: number | null
}
