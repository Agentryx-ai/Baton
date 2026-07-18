import type { GatewayResponse } from './gateway-session.ts'

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const MANAGEMENT_TIMEOUT_MS = 5_000
const DEFAULT_CACHE_TTL_MS = 120_000

interface ClaudeScopedLimit {
  kind?: unknown
  percent?: unknown
  resets_at?: unknown
  is_active?: unknown
  severity?: unknown
  scope?: unknown
}

interface QuotaWindow {
  rateLimitType?: string
  label?: string
  status?: string
  utilization?: number
  usedPercent: number
  remainingPercent: number
  resetAt: string | null
}

interface ClaudeQuotaPayload {
  windows?: QuotaWindow[]
  [key: string]: unknown
}

type GatewayFetch = (
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: Buffer },
) => Promise<Pick<GatewayResponse, 'status' | 'body'>>

export interface ClaudeQuotaEnricherOptions {
  fetchGateway: GatewayFetch
  fetchFn?: typeof fetch
  cacheTtlMs?: number
  now?: () => number
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseObject(value: Buffer | string | unknown): Record<string, unknown> | null {
  if (Buffer.isBuffer(value)) return parseObject(value.toString('utf8'))
  if (typeof value === 'string') {
    try {
      return objectValue(JSON.parse(value))
    } catch {
      return null
    }
  }
  return objectValue(value)
}

function nestedString(object: Record<string, unknown>, keys: string[]): string | null {
  let value: unknown = object
  for (const key of keys) {
    const parent = objectValue(value)
    if (!parent) return null
    value = parent[key]
  }
  return typeof value === 'string' && value.length > 0 ? value : null
}

function accountMatches(file: Record<string, unknown>, accountId: string): boolean {
  const expected = accountId.trim().toLocaleLowerCase('en-US')
  return ['id', 'email', 'account', 'label'].some((key) => {
    const value = file[key]
    return typeof value === 'string' && value.trim().toLocaleLowerCase('en-US') === expected
  })
}

function scopedModelName(limit: ClaudeScopedLimit): string | null {
  const scope = objectValue(limit.scope)
  const model = objectValue(scope?.model)
  const displayName = model?.display_name
  return typeof displayName === 'string' && displayName.trim().length > 0
    ? displayName.trim()
    : null
}

function friendlyModelName(displayName: string): string {
  return /^fable(?:\s*5)?$/i.test(displayName) ? 'Fable 5' : displayName
}

function scopedRateLimitType(displayName: string): string {
  if (/^fable(?:\s*5)?$/i.test(displayName)) return 'seven_day_fable5'
  const slug = displayName
    .normalize('NFKD')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `seven_day_${slug || 'scoped'}`
}

/** Convert Claude's current model-scoped `limits[]` contract into ordinary quota windows. */
export function buildClaudeScopedQuotaWindows(limits: unknown): QuotaWindow[] {
  if (!Array.isArray(limits)) return []
  const windows: QuotaWindow[] = []
  const seen = new Set<string>()

  for (const value of limits) {
    const limit = objectValue(value) as ClaudeScopedLimit | null
    if (!limit || limit.kind !== 'weekly_scoped') continue
    const displayName = scopedModelName(limit)
    if (!displayName || typeof limit.percent !== 'number' || !Number.isFinite(limit.percent)) continue

    const rateLimitType = scopedRateLimitType(displayName)
    if (seen.has(rateLimitType)) continue
    seen.add(rateLimitType)

    const usedPercent = Math.max(0, Math.min(100, limit.percent))
    const resetAt = typeof limit.resets_at === 'string' && !Number.isNaN(Date.parse(limit.resets_at))
      ? new Date(limit.resets_at).toISOString()
      : null
    const status = typeof limit.severity === 'string'
      ? limit.severity
      : typeof limit.is_active === 'boolean'
        ? limit.is_active ? 'active' : 'inactive'
        : 'unknown'

    windows.push({
      rateLimitType,
      label: friendlyModelName(displayName),
      status,
      utilization: usedPercent / 100,
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetAt,
    })
  }

  return windows
}

export function mergeClaudeScopedQuotaWindows(
  quota: ClaudeQuotaPayload,
  scopedWindows: QuotaWindow[],
): ClaudeQuotaPayload {
  if (scopedWindows.length === 0) return quota
  const windows = Array.isArray(quota.windows) ? quota.windows : []
  const scopedTypes = new Set(scopedWindows.map((window) => window.rateLimitType))
  return {
    ...quota,
    windows: [
      ...windows.filter((window) => !scopedTypes.has(window.rateLimitType)),
      ...scopedWindows,
    ],
  }
}

/**
 * Enrich CCS's legacy Claude quota response with the model-scoped limits understood by
 * current Claude clients. Management credentials remain inside the BFF and are never
 * included in the returned payload. Any discovery failure preserves the upstream bytes.
 */
export function createClaudeQuotaEnricher(options: ClaudeQuotaEnricherOptions) {
  const fetchFn = options.fetchFn ?? fetch
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const now = options.now ?? Date.now
  const cache = new Map<string, { expiresAt: number; windows: QuotaWindow[] }>()
  const inFlight = new Map<string, Promise<QuotaWindow[]>>()

  async function discover(accountId: string): Promise<QuotaWindow[]> {
    const cached = cache.get(accountId)
    if (cached && cached.expiresAt > now()) return cached.windows

    const pending = inFlight.get(accountId)
    if (pending) return pending

    const request = (async (): Promise<QuotaWindow[]> => {
      const [statusResponse, tokenResponse] = await Promise.all([
        options.fetchGateway('/api/cliproxy/proxy-status', { method: 'GET' }),
        options.fetchGateway('/api/settings/auth/tokens/raw', { method: 'GET' }),
      ])
      if (statusResponse.status < 200 || statusResponse.status >= 300) return []
      if (tokenResponse.status < 200 || tokenResponse.status >= 300) return []

      const status = parseObject(statusResponse.body)
      const tokens = parseObject(tokenResponse.body)
      const port = status?.port
      const managementSecret = tokens ? nestedString(tokens, ['managementSecret', 'value']) : null
      if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535) return []
      if (!managementSecret) return []

      const managementBase = `http://127.0.0.1:${port as number}/v0/management`
      const managementHeaders = {
        accept: 'application/json',
        authorization: `Bearer ${managementSecret}`,
      }
      const authResponse = await fetchFn(`${managementBase}/auth-files`, {
        headers: managementHeaders,
        signal: AbortSignal.timeout(MANAGEMENT_TIMEOUT_MS),
      })
      if (!authResponse.ok) return []
      const authPayload = objectValue(await authResponse.json())
      const files = Array.isArray(authPayload?.files) ? authPayload.files : []
      const authFile = files
        .map(objectValue)
        .find((file) => file
          && ['claude', 'anthropic'].includes(String(file.provider ?? file.type ?? '').toLowerCase())
          && accountMatches(file, accountId))
      const authIndex = authFile?.auth_index
      if (typeof authIndex !== 'string' || authIndex.length === 0) return []

      const usageResponse = await fetchFn(`${managementBase}/api-call`, {
        method: 'POST',
        headers: { ...managementHeaders, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(MANAGEMENT_TIMEOUT_MS),
        body: JSON.stringify({
          auth_index: authIndex,
          method: 'GET',
          url: CLAUDE_USAGE_URL,
          header: {
            Authorization: 'Bearer $TOKEN$',
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'anthropic-beta': 'oauth-2025-04-20',
          },
        }),
      })
      if (!usageResponse.ok) return []
      const envelope = objectValue(await usageResponse.json())
      const upstreamStatus = envelope?.status_code
      if (typeof upstreamStatus !== 'number' || upstreamStatus < 200 || upstreamStatus >= 300) return []
      const usage = parseObject(envelope?.body)
      return buildClaudeScopedQuotaWindows(usage?.limits)
    })()

    inFlight.set(accountId, request)
    try {
      const windows = await request
      cache.set(accountId, { expiresAt: now() + cacheTtlMs, windows })
      return windows
    } finally {
      inFlight.delete(accountId)
    }
  }

  return async (accountId: string, upstreamBody: Buffer): Promise<Buffer> => {
    const quota = parseObject(upstreamBody) as ClaudeQuotaPayload | null
    if (!quota || !Array.isArray(quota.windows)) return upstreamBody
    try {
      const scopedWindows = await discover(accountId)
      if (scopedWindows.length === 0) return upstreamBody
      return Buffer.from(JSON.stringify(mergeClaudeScopedQuotaWindows(quota, scopedWindows)))
    } catch {
      return upstreamBody
    }
  }
}
