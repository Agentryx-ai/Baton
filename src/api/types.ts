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
  /** Paused = excluded from the provider's account rotation. */
  paused?: boolean
  /** Lower values are attempted first by Baton Native account routing. */
  priority?: number
  revision?: number
  /** This Codex account supplies remote plugin catalog and connector authorization. */
  isPluginReference?: boolean
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

export interface BatonRuntimeStatus {
  checkedAt: string
  proxy: {
    running: boolean | null
    port: number | null
    version: string | null
    strategy: string | null
    sessionAffinity: boolean | null
  }
  codex: {
    integrationMode: CodexIntegrationMode | null
    configuration: string
    modelProvider: 'baton' | 'openai' | 'unknown'
    providerAuth: 'available' | 'missing-or-conflicting' | 'unknown'
    openAiLogin: {
      kind: 'chatgpt' | 'api-key' | 'access-token' | 'personal-access-token' | 'none' | 'unknown'
      label: string
    }
    remotePluginCatalog: {
      state: 'eligible' | 'unavailable' | 'unknown'
      reason: string
    }
    configuredHome: string
    notice: string
  }
  inferenceAccount: {
    label: string
    observedAt: string | null
    basis: 'most-recent-last-used' | 'unavailable'
  } | null
  warnings: string[]
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
export type CodexIntegrationMode = 'custom-provider' | 'native-openai'
export type ClaudeProxyMode = 'native' | 'cliproxy'

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
  codexMode?: CodexIntegrationMode
  claudeProxyMode?: ClaudeProxyMode
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

export interface ActiveModelFallback {
  preferredModel: string
  effectiveModel: string
  reason: 'quota' | 'safety_refusal'
  activatedAt: number
  resetHint: number | null
  lastProbeAt: number | null
  accountAlias?: string
}

export interface ModelFallbackEvent {
  id: number
  at: number
  type: 'available' | 'activated' | 'recovered' | 'disabled' | 'failed' | 'server_event'
  preferredModel: string
  effectiveModel: string
  reason: 'quota' | 'safety_refusal'
  direction?: 'retry' | 'revert' | 'sticky'
  category?: string
  accountId?: string
}

export interface ModelFallbackStatus {
  enabled: boolean
  promptDismissed: boolean
  userMappings: Record<string, string[]>
  active: ActiveModelFallback[]
  events: ModelFallbackEvent[]
}

// ---- Policy engine (BFF /baton/*) ----

export type PolicyId = 'reset-imminent-first'

export interface SteerLogEntry {
  /** epoch ms */
  ts: number
  provider: string
  /** 'target' = calculated policy rank 1; it does not assert the actual request destination. */
  action: 'target' | 'pause' | 'resume' | 'info' | 'error'
  accountId?: string
  reason: string
}

export interface PolicyProviderState {
  provider: string
  /** calculated rank-1 account id (soonest reset), not an enforced request destination. */
  target: string | null
  /** calculated rank-2 account id; every non-manually-paused account remains in the failover pool. */
  reserve: string | null
  /** legacy engine-owned pauses pending restoration; new policy ticks do not add ids. */
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
