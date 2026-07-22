import {
  ClaudeNativeCredentialError,
  type ClaudeNativeCredential,
} from './claude-native-credentials.ts'

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
const USAGE_CACHE_MS = 60_000

interface UsageLimit {
  kind?: unknown
  percent?: unknown
  resets_at?: unknown
  is_active?: unknown
  scope?: {
    model?: {
      id?: unknown
      display_name?: unknown
    } | null
  } | null
}

interface UsageResponse {
  limits?: unknown
}

export interface ClaudeModelQuotaLimit {
  model: string
  displayName: string
  percent: number
  resetsAt?: string
}

export interface ClaudeAccountQuotaWindow {
  rateLimitType: string
  label: string
  status: string
  utilization: number
  usedPercent: number
  remainingPercent: number
  resetAt: string | null
}

export interface ClaudeAccountQuota {
  success: true
  windows: ClaudeAccountQuotaWindow[]
  lastUpdated: number
  accountId: string
}

export interface ClaudeQuotaPreflightOptions {
  fetchImpl?: typeof fetch
  usageUrl?: string
  now?: () => number
  cacheMs?: number
}

interface CachedUsage {
  expiresAt: number
  limits: UsageLimit[]
}

function modelLabel(model: string): string {
  const match = /^claude-([a-z]+)-(\d+(?:-\d+)*)/i.exec(model)
  if (!match) return model
  const family = match[1][0].toUpperCase() + match[1].slice(1)
  return `${family} ${match[2].replaceAll('-', '.')}`
}

function scopedLimitMatches(limit: UsageLimit, model: string): boolean {
  const scoped = limit.scope?.model
  if (!scoped) return false
  if (typeof scoped.id === 'string' && scoped.id.length > 0) return scoped.id === model
  if (typeof scoped.display_name !== 'string' || scoped.display_name.length === 0) return false
  const family = scoped.display_name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return model.toLowerCase().includes(`-${family}-`)
}

export class ClaudeQuotaPreflight {
  private readonly fetchImpl: typeof fetch
  private readonly usageUrl: string
  private readonly now: () => number
  private readonly cacheMs: number
  private readonly cache = new Map<string, CachedUsage>()
  private readonly pending = new Map<string, Promise<UsageLimit[]>>()

  constructor(options: ClaudeQuotaPreflightOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.usageUrl = options.usageUrl ?? USAGE_ENDPOINT
    this.now = options.now ?? Date.now
    this.cacheMs = options.cacheMs ?? USAGE_CACHE_MS
  }

  async check(model: string, credential: ClaudeNativeCredential): Promise<ClaudeModelQuotaLimit | null> {
    const limits = await this.loadLimits(credential)
    const exhausted = limits.find((limit) => (
      limit.kind === 'weekly_scoped'
      && limit.is_active === true
      && typeof limit.percent === 'number'
      && limit.percent >= 100
      && scopedLimitMatches(limit, model)
    ))
    if (!exhausted) return null
    const scopedName = exhausted.scope?.model?.display_name
    return {
      model,
      displayName: modelLabel(model) || (typeof scopedName === 'string' ? scopedName : model),
      percent: exhausted.percent as number,
      ...(typeof exhausted.resets_at === 'string' ? { resetsAt: exhausted.resets_at } : {}),
    }
  }

  async accountQuota(credential: ClaudeNativeCredential): Promise<ClaudeAccountQuota> {
    const limits = await this.loadLimits(credential)
    const windows = limits.flatMap((limit): ClaudeAccountQuotaWindow[] => {
      if (typeof limit.kind !== 'string' || typeof limit.percent !== 'number' || !Number.isFinite(limit.percent)) {
        return []
      }
      const usedPercent = Math.max(0, Math.min(100, limit.percent))
      const displayName = limit.scope?.model?.display_name
      const label = typeof displayName === 'string' && displayName.length > 0
        ? displayName
        : limit.kind.replaceAll('_', ' ')
      return [{
        rateLimitType: limit.kind,
        label,
        status: usedPercent >= 100 ? 'exhausted' : limit.is_active === false ? 'inactive' : 'active',
        utilization: usedPercent / 100,
        usedPercent,
        remainingPercent: 100 - usedPercent,
        resetAt: typeof limit.resets_at === 'string' ? limit.resets_at : null,
      }]
    })
    return {
      success: true,
      windows,
      lastUpdated: this.now(),
      accountId: credential.accountId,
    }
  }

  invalidate(accountId?: string): void {
    if (accountId) this.cache.delete(accountId)
    else this.cache.clear()
  }

  private async loadLimits(credential: ClaudeNativeCredential): Promise<UsageLimit[]> {
    const cached = this.cache.get(credential.accountId)
    if (cached && cached.expiresAt > this.now()) return cached.limits
    const existing = this.pending.get(credential.accountId)
    if (existing) return existing
    const request = this.fetchLimits(credential).finally(() => {
      this.pending.delete(credential.accountId)
    })
    this.pending.set(credential.accountId, request)
    return request
  }

  private async fetchLimits(credential: ClaudeNativeCredential): Promise<UsageLimit[]> {
    const response = await this.fetchImpl(this.usageUrl, {
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 401 || response.status === 403) {
      throw new ClaudeNativeCredentialError(
        'expired',
        `Claude usage 인증이 HTTP ${response.status}로 거부되었습니다. 계정을 다시 인증하세요.`,
      )
    }
    if (!response.ok) throw new Error(`Claude usage endpoint returned HTTP ${response.status}`)
    const body = await response.json() as UsageResponse
    const limits = Array.isArray(body.limits)
      ? body.limits.filter((limit): limit is UsageLimit => Boolean(limit && typeof limit === 'object'))
      : []
    this.cache.set(credential.accountId, { expiresAt: this.now() + this.cacheMs, limits })
    return limits
  }
}
