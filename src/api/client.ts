/**
 * Typed Baton SPA API client.
 * All requests are same-origin relative URLs:
 *   - `/api/*`   → the gateway (Vite dev-proxies to the BFF, which pass-throughs to the gateway)
 *   - `/baton/*` → BFF policy engine
 * On non-2xx responses an {@link ApiError} is thrown with a parsed message.
 * See docs/BUILD_DAG.md §2.2 for the frozen signatures.
 */
import type {
  Account,
  AccountQuota,
  AddStatus,
  ClientIntegrationApplyResult,
  ClientIntegrationRemoveResult,
  ClientIntegrationStatus,
  ClientIntegrationTarget,
  PolicyState,
  Provider,
  ProxyStatus,
  RoutingStrategy,
  RoutingStrategyName,
  SessionAffinity,
} from '@/api/types'
import { UI_PROVIDERS } from '@/api/types'

/** Thrown on any non-2xx API response. `status` is the HTTP status code. */
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** Attempt to pull a human-readable message out of an error response body. */
function extractMessage(status: number, raw: string, parsed: unknown): string {
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    const candidate = obj.error ?? obj.message
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  if (raw.length > 0 && raw.length < 500) return raw
  return `Request failed with status ${status}`
}

/**
 * Core fetch wrapper. Serializes `json` as the request body, parses the
 * response as JSON when possible, and throws {@link ApiError} on non-2xx.
 */
async function request<T>(
  path: string,
  options: { method?: string; json?: unknown } = {},
): Promise<T> {
  const { method = 'GET', json } = options
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  }
  if (json !== undefined) {
    init.headers = { ...init.headers, 'Content-Type': 'application/json' }
    init.body = JSON.stringify(json)
  }

  const res = await fetch(path, init)
  const raw = await res.text()
  let parsed: unknown = undefined
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, extractMessage(res.status, raw, parsed))
  }
  return parsed as T
}

export const client = {
  // ---- 조회 (reads) -------------------------------------------------------

  /**
   * Fan out over {@link UI_PROVIDERS}, calling `/api/cliproxy/auth/accounts/:provider`
   * for each, and return a per-provider map. The gateway wraps the list in `{accounts}`.
   */
  getAccounts: async (): Promise<Record<Provider, Account[]>> => {
    const result = {} as Record<Provider, Account[]>
    await Promise.all(
      UI_PROVIDERS.map(async (provider) => {
        const body = await request<{ provider?: string; accounts?: Account[] }>(
          `/api/cliproxy/auth/accounts/${provider}`,
        )
        result[provider] = body.accounts ?? []
      }),
    )
    return result
  },

  getQuota: (provider: Provider, accountId: string): Promise<AccountQuota> =>
    request<AccountQuota>(
      `/api/cliproxy/quota/${provider}/${encodeURIComponent(accountId)}`,
    ),

  getProxyStatus: (): Promise<ProxyStatus> =>
    request<ProxyStatus>('/api/cliproxy/proxy-status'),

  getRoutingStrategy: (): Promise<RoutingStrategy> =>
    request<RoutingStrategy>('/api/cliproxy/routing/strategy'),

  getSessionAffinity: (): Promise<SessionAffinity> =>
    request<SessionAffinity>('/api/cliproxy/routing/session-affinity'),

  /** Policy state lives on the BFF, not the gateway — hits `/baton/policy`. */
  getPolicy: (): Promise<PolicyState> => request<PolicyState>('/baton/policy'),

  getClientIntegrationStatus: (): Promise<ClientIntegrationStatus> =>
    request<ClientIntegrationStatus>('/baton/client-integration'),

  // ---- 변경 (mutations) ---------------------------------------------------
  // Note: there is deliberately no setDefault — the CCS "default account" flag
  // does not affect CLIProxy routing (round-robin over all non-paused creds).
  // Account steering is done purely via pause/resume.

  pauseAccount: async (provider: Provider, accountId: string): Promise<void> => {
    await request(
      `/api/cliproxy/auth/accounts/${provider}/${encodeURIComponent(accountId)}/pause`,
      { method: 'POST' },
    )
  },

  resumeAccount: async (provider: Provider, accountId: string): Promise<void> => {
    await request(
      `/api/cliproxy/auth/accounts/${provider}/${encodeURIComponent(accountId)}/resume`,
      { method: 'POST' },
    )
  },

  removeAccount: async (provider: Provider, accountId: string): Promise<void> => {
    await request(
      `/api/cliproxy/auth/accounts/${provider}/${encodeURIComponent(accountId)}`,
      { method: 'DELETE' },
    )
  },

  setRoutingStrategy: async (strategy: RoutingStrategyName): Promise<void> => {
    await request('/api/cliproxy/routing/strategy', {
      method: 'POST',
      json: { strategy },
    })
  },

  setSessionAffinity: async (
    enabled: boolean,
    ttl?: string,
  ): Promise<void> => {
    await request('/api/cliproxy/routing/session-affinity', {
      method: 'POST',
      json: ttl === undefined ? { enabled } : { enabled, ttl },
    })
  },

  restartProxy: async (): Promise<void> => {
    await request('/api/cliproxy/restart', { method: 'POST' })
  },

  applyClientIntegration: (
    targets: ClientIntegrationTarget[],
  ): Promise<ClientIntegrationApplyResult> =>
    request<ClientIntegrationApplyResult>('/baton/client-integration/apply', {
      method: 'POST',
      json: { targets },
    }),

  removeClientIntegration: (
    targets: ClientIntegrationTarget[],
  ): Promise<ClientIntegrationRemoveResult> =>
    request<ClientIntegrationRemoveResult>('/baton/client-integration/remove', {
      method: 'POST',
      json: { targets },
    }),

  /** Toggle / configure the policy engine on the BFF, returning fresh state. */
  setPolicy: (enabled: boolean, policy?: string): Promise<PolicyState> =>
    request<PolicyState>('/baton/policy', {
      method: 'POST',
      json: policy === undefined ? { enabled } : { enabled, policy },
    }),

  // ---- OAuth 계정 추가 (add-account flow) --------------------------------

  /**
   * Start the OAuth add-account flow. The gateway may return the auth URL under either
   * `url` or `auth_url` — both are normalized to `{ url, state }`.
   */
  startAddAccount: async (
    provider: Provider,
    nickname?: string,
  ): Promise<{ url: string; state: string }> => {
    const body = await request<{
      url?: string
      auth_url?: string
      authUrl?: string
      state?: string
    }>(`/api/cliproxy/auth/${provider}/start-url`, {
      method: 'POST',
      json: { nickname },
    })
    const url = body.authUrl ?? body.url ?? body.auth_url ?? ''
    // State may be a top-level field or only embedded in the auth URL.
    let state = body.state ?? ''
    if (!state && url) {
      try {
        state = new URL(url).searchParams.get('state') ?? ''
      } catch {
        /* leave empty */
      }
    }
    return { url, state }
  },

  getAddStatus: (provider: Provider, state: string): Promise<AddStatus> =>
    request<AddStatus>(
      `/api/cliproxy/auth/${provider}/status?state=${encodeURIComponent(state)}`,
    ),

  submitCallback: (
    provider: Provider,
    redirectUrl: string,
  ): Promise<AddStatus> =>
    request<AddStatus>(`/api/cliproxy/auth/${provider}/submit-callback`, {
      method: 'POST',
      json: { redirectUrl },
    }),

  cancelAddAccount: async (provider: Provider): Promise<void> => {
    await request(`/api/cliproxy/auth/${provider}/cancel`, { method: 'POST' })
  },
}

export type ApiClient = typeof client
