/**
 * Typed Baton SPA API client.
 * All requests are same-origin relative URLs:
 *   - `/api/*`   → the gateway (Vite dev-proxies to the BFF, which pass-throughs to the gateway)
 *   - `/baton/*` → BFF policy engine
 * On non-2xx responses an {@link ApiError} is thrown with a parsed message.
 * See docs/BUILD_DAG.md §2.2 for the frozen signatures.
 */
import type {
  BatonRuntimeStatus,
  Account,
  AccountQuota,
  AddStatus,
  ClientIntegrationApplyResult,
  ClientIntegrationRemoveResult,
  ClientIntegrationStatus,
  ClientIntegrationTarget,
  ClaudeProxyMode,
  CodexIntegrationMode,
  PolicyState,
  ModelFallbackStatus,
  Provider,
  ProxyStatus,
  RoutingStrategy,
  RoutingStrategyName,
  SessionAffinity,
} from './types.ts'
import { UI_PROVIDERS } from './types.ts'

/** Thrown on any non-2xx API response. `status` is the HTTP status code. */
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

type GatewayAddStatus = {
  status?: 'wait' | 'success' | 'error' | 'ok'
  success?: boolean
  error?: string
}

/** Normalize the gateway's legacy and current OAuth completion shapes. */
export function normalizeAddStatus(result: GatewayAddStatus): AddStatus {
  if (result.success === true || result.status === 'success' || result.status === 'ok') {
    return { status: 'success' }
  }
  if (result.success === false || result.status === 'error') {
    return { status: 'error', error: result.error }
  }
  return { status: 'wait' }
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

const nativeAccountBackends = new Map<Provider, boolean>()

function nativeBackendFromStatus(provider: Provider, status: ClientIntegrationStatus): boolean {
  if (provider === 'claude') {
    const applied = status.targets.find((target) => (
      target.target !== 'codex' && target.configuration === 'applied'
    ))
    return applied?.claudeProxyMode !== 'cliproxy'
  }
  if (provider === 'codex') {
    const applied = status.targets.find((target) => target.target === 'codex')
    return applied?.codexMode !== 'custom-provider'
  }
  return false
}

async function usesNativeAccountBackend(provider: Provider): Promise<boolean> {
  const cached = nativeAccountBackends.get(provider)
  if (cached !== undefined) return cached
  const status = await request<ClientIntegrationStatus>('/baton/client-integration')
  const native = nativeBackendFromStatus(provider, status)
  nativeAccountBackends.set(provider, native)
  return native
}

function nativeProviderBase(provider: Provider): string {
  return provider === 'claude' ? '/baton/claude-native' : '/baton/codex-native'
}

export const client = {
  // ---- 조회 (reads) -------------------------------------------------------

  /** Claude accounts come from Baton's native vault; other providers retain the CLIProxy contract. */
  getAccounts: async (): Promise<Record<Provider, Account[]>> => {
    const result = {} as Record<Provider, Account[]>
    const status = await request<ClientIntegrationStatus>('/baton/client-integration')
    await Promise.all(
      UI_PROVIDERS.map(async (provider) => {
        const native = nativeBackendFromStatus(provider, status)
        nativeAccountBackends.set(provider, native)
        const body = await request<{ provider?: string; accounts?: Account[] }>(
          native
            ? `${nativeProviderBase(provider)}/accounts`
            : `/api/cliproxy/auth/accounts/${provider}`,
        )
        result[provider] = body.accounts ?? []
      }),
    )
    return result
  },

  getQuota: async (provider: Provider, accountId: string): Promise<AccountQuota> => {
    const native = await usesNativeAccountBackend(provider)
    return await request<AccountQuota>(
      native
        ? `${nativeProviderBase(provider)}/quota/${encodeURIComponent(accountId)}`
        : `/api/cliproxy/quota/${provider}/${encodeURIComponent(accountId)}`,
    )
  },

  getProxyStatus: (): Promise<ProxyStatus> =>
    request<ProxyStatus>('/api/cliproxy/proxy-status'),

  getBatonStatus: (): Promise<BatonRuntimeStatus> =>
    request<BatonRuntimeStatus>('/baton/status'),

  getRoutingStrategy: (): Promise<RoutingStrategy> =>
    request<RoutingStrategy>('/api/cliproxy/routing/strategy'),

  getSessionAffinity: (): Promise<SessionAffinity> =>
    request<SessionAffinity>('/api/cliproxy/routing/session-affinity'),

  /** Policy state lives on the BFF, not the gateway — hits `/baton/policy`. */
  getPolicy: (): Promise<PolicyState> => request<PolicyState>('/baton/policy'),

  getModelFallback: (): Promise<ModelFallbackStatus> =>
    request<ModelFallbackStatus>('/baton/model-fallback'),

  setModelFallback: (settings: {
    enabled?: boolean
    promptDismissed?: boolean
    userMappings?: Record<string, string[]>
  }): Promise<ModelFallbackStatus> => request<ModelFallbackStatus>('/baton/model-fallback', {
    method: 'POST',
    json: settings,
  }),

  getClientIntegrationStatus: (): Promise<ClientIntegrationStatus> =>
    request<ClientIntegrationStatus>('/baton/client-integration'),

  // ---- 변경 (mutations) ---------------------------------------------------
  // Note: there is deliberately no setDefault — the CCS "default account" flag
  // does not affect CLIProxy routing (round-robin over all non-paused creds).
  // Account steering is done purely via pause/resume.

  pauseAccount: async (provider: Provider, accountId: string): Promise<void> => {
    const native = await usesNativeAccountBackend(provider)
    await request(
      native
        ? `${nativeProviderBase(provider)}/accounts/${encodeURIComponent(accountId)}/pause`
        : `/api/cliproxy/auth/accounts/${provider}/${encodeURIComponent(accountId)}/pause`,
      { method: 'POST' },
    )
  },

  resumeAccount: async (provider: Provider, accountId: string): Promise<void> => {
    const native = await usesNativeAccountBackend(provider)
    await request(
      native
        ? `${nativeProviderBase(provider)}/accounts/${encodeURIComponent(accountId)}/resume`
        : `/api/cliproxy/auth/accounts/${provider}/${encodeURIComponent(accountId)}/resume`,
      { method: 'POST' },
    )
  },

  removeAccount: async (provider: Provider, accountId: string): Promise<void> => {
    const native = await usesNativeAccountBackend(provider)
    await request(
      native
        ? `${nativeProviderBase(provider)}/accounts/${encodeURIComponent(accountId)}`
        : `/api/cliproxy/auth/accounts/${provider}/${encodeURIComponent(accountId)}`,
      { method: 'DELETE' },
    )
  },

  preferAccount: async (provider: Provider, accountId: string): Promise<void> => {
    const native = await usesNativeAccountBackend(provider)
    if (!native || provider !== 'claude') {
      throw new ApiError(409, '우선계정 지정은 Baton Native Claude에서만 지원됩니다.')
    }
    await request(
      `${nativeProviderBase(provider)}/accounts/${encodeURIComponent(accountId)}/prefer`,
      { method: 'POST' },
    )
  },

  refreshCodexEntitlements: async (accountId: string): Promise<void> => {
    await request(`/baton/codex-native/accounts/${encodeURIComponent(accountId)}/refresh-entitlements`, {
      method: 'POST',
    })
  },

  setRoutingStrategy: async (strategy: RoutingStrategyName): Promise<void> => {
    await request('/api/cliproxy/routing/strategy', {
      method: 'PUT',
      json: { value: strategy },
    })
  },

  setSessionAffinity: async (
    enabled: boolean,
    ttl?: string,
  ): Promise<void> => {
    await request('/api/cliproxy/routing/session-affinity', {
      method: 'PUT',
      json: ttl === undefined ? { enabled } : { enabled, ttl },
    })
  },

  restartProxy: async (): Promise<void> => {
    await request('/api/cliproxy/restart', { method: 'POST' })
  },

  applyClientIntegration: async (
    targets: ClientIntegrationTarget[],
    codexMode?: CodexIntegrationMode,
    claudeProxyMode?: ClaudeProxyMode,
  ): Promise<ClientIntegrationApplyResult> => {
    const result = await request<ClientIntegrationApplyResult>('/baton/client-integration/apply', {
      method: 'POST',
      json: {
        targets,
        ...(codexMode ? { codexMode } : {}),
        ...(claudeProxyMode ? { claudeProxyMode } : {}),
      },
    })
    if (targets.some((target) => target !== 'codex')) nativeAccountBackends.delete('claude')
    if (targets.includes('codex')) nativeAccountBackends.delete('codex')
    return result
  },

  removeClientIntegration: async (
    targets: ClientIntegrationTarget[],
  ): Promise<ClientIntegrationRemoveResult> => {
    const result = await request<ClientIntegrationRemoveResult>('/baton/client-integration/remove', {
      method: 'POST',
      json: { targets },
    })
    if (targets.some((target) => target !== 'codex')) nativeAccountBackends.delete('claude')
    if (targets.includes('codex')) nativeAccountBackends.delete('codex')
    return result
  },

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
    const native = await usesNativeAccountBackend(provider)
    const body = await request<{
      url?: string
      auth_url?: string
      authUrl?: string
      state?: string
    }>(native
      ? `${nativeProviderBase(provider)}/auth/start-url`
      : `/api/cliproxy/auth/${provider}/start-url`, {
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

  getAddStatus: async (provider: Provider, state: string): Promise<AddStatus> => {
    const native = await usesNativeAccountBackend(provider)
    return normalizeAddStatus(await request<GatewayAddStatus>(
      native
        ? `${nativeProviderBase(provider)}/auth/status?state=${encodeURIComponent(state)}`
        : `/api/cliproxy/auth/${provider}/status?state=${encodeURIComponent(state)}`,
    ))
  },

  submitCallback: async (
    provider: Provider,
    redirectUrl: string,
  ): Promise<AddStatus> => {
    const native = await usesNativeAccountBackend(provider)
    return request<GatewayAddStatus>(native
      ? `${nativeProviderBase(provider)}/auth/submit-callback`
      : `/api/cliproxy/auth/${provider}/submit-callback`, {
      method: 'POST',
      json: { redirectUrl },
    }).then(normalizeAddStatus)
  },

  cancelAddAccount: async (provider: Provider): Promise<void> => {
    const native = await usesNativeAccountBackend(provider)
    await request(native
      ? `${nativeProviderBase(provider)}/auth/cancel`
      : `/api/cliproxy/auth/${provider}/cancel`, { method: 'POST' })
  },
}

export type ApiClient = typeof client
