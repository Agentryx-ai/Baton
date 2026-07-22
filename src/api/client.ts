/**
 * Typed Baton SPA API client.
 * All requests are same-origin relative URLs:
 *   - `/baton/*` → Baton Native control and inference runtime
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
  ModelFallbackStatus,
  Provider,
  ProxyStatus,
} from './types.ts'
import { UI_PROVIDERS } from './types.ts'
import type {
  CodexPluginCatalog,
  CodexPluginInstallResult,
  CodexPluginReference,
  CodexPluginReferencePreview,
  CodexPluginReferenceStatus,
} from './codex-plugins.ts'

/** Thrown on any non-2xx API response. `status` is the HTTP status code. */
export class ApiError extends Error {
  status: number
  code: string | null
  constructor(status: number, message: string, code: string | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

type GatewayAddStatus = {
  status?: 'wait' | 'success' | 'error' | 'ok'
  success?: boolean
  error?: string
}

let clientIntegrationCapability: Promise<string> | undefined

async function integrationMutationHeaders(): Promise<Record<string, string>> {
  clientIntegrationCapability ??= fetch('/baton/client-integration/capability', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  }).then(async (response) => {
    const value = await response.json() as { capability?: unknown }
    if (!response.ok || typeof value.capability !== 'string') throw new ApiError(response.status, 'Client integration capability unavailable')
    return value.capability
  }).catch((error) => {
    clientIntegrationCapability = undefined
    throw error
  })
  return { 'X-Baton-Client-Capability': await clientIntegrationCapability }
}

async function integrationMutationRequest<T>(path: string, json: unknown): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await request<T>(path, {
        method: 'POST',
        headers: await integrationMutationHeaders(),
        json,
      })
    } catch (error) {
      if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403) || attempt > 0) throw error
      clientIntegrationCapability = undefined
    }
  }
  throw new ApiError(403, 'Client integration capability retry failed')
}

/** Normalize provider OAuth completion shapes. */
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
  options: { method?: string; json?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const { method = 'GET', json, headers } = options
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...headers },
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
    const code = parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).code === 'string'
      ? (parsed as Record<string, string>).code
      : null
    throw new ApiError(res.status, extractMessage(res.status, raw, parsed), code)
  }
  return parsed as T
}

function nativeProviderBase(provider: Provider): string {
  if (provider === 'claude') return '/baton/claude-native'
  if (provider === 'codex') return '/baton/codex-native'
  throw new ApiError(400, `Baton Native account backend is unavailable for ${provider}`)
}

export const client = {
  // ---- 조회 (reads) -------------------------------------------------------

  /** Every provider account comes from Baton's Native vault. */
  getAccounts: async (): Promise<Record<Provider, Account[]>> => {
    const result = {} as Record<Provider, Account[]>
    await Promise.all(
      UI_PROVIDERS.map(async (provider) => {
        const body = await request<{ provider?: string; accounts?: Account[] }>(
          `${nativeProviderBase(provider)}/accounts`,
        )
        result[provider] = body.accounts ?? []
      }),
    )
    return result
  },

  getQuota: async (provider: Provider, accountId: string): Promise<AccountQuota> => {
    return await request<AccountQuota>(
      `${nativeProviderBase(provider)}/quota/${encodeURIComponent(accountId)}`,
    )
  },

  getProxyStatus: (): Promise<ProxyStatus> =>
    request<ProxyStatus>('/baton/proxy-status'),

  getBatonStatus: (): Promise<BatonRuntimeStatus> =>
    request<BatonRuntimeStatus>('/baton/status'),

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

  /** Plugin reference candidates always come from Baton's Native vault, independent of model integration mode. */
  getCodexPluginAccounts: async (): Promise<Account[]> => {
    const body = await request<{ accounts?: Account[] }>('/baton/codex-native/accounts')
    return body.accounts ?? []
  },

  removeCodexPluginAccount: async (accountId: string, expectedRevision: number): Promise<void> => {
    await request(`/baton/codex-native/accounts/${encodeURIComponent(accountId)}`, {
      method: 'DELETE',
      json: { expectedRevision },
    })
  },

  getCodexPluginReference: (): Promise<CodexPluginReferenceStatus> =>
    request<CodexPluginReferenceStatus>('/baton/codex-plugins/reference'),

  getCodexPluginCatalog: (): Promise<CodexPluginCatalog> =>
    request<CodexPluginCatalog>('/baton/codex-plugins/catalog'),

  previewCodexPluginReference: (target: CodexPluginReference): Promise<CodexPluginReferencePreview> =>
    request<CodexPluginReferencePreview>('/baton/codex-plugins/reference/preview', {
      method: 'POST',
      headers: { 'x-baton-interaction': 'codex-plugin-control' },
      json: target,
    }),

  switchCodexPluginReference: (preview: CodexPluginReferencePreview): Promise<{
    status: CodexPluginReferenceStatus
    catalog: CodexPluginCatalog
  }> => request('/baton/codex-plugins/reference/switch', {
    method: 'POST',
    headers: { 'x-baton-interaction': 'codex-plugin-control' },
    json: {
      ...preview.target,
      expectedStateRevision: preview.current.state.revision,
      expectedTargetAccountRevision: preview.targetAccountRevision,
      previewDigest: preview.previewDigest,
    },
  }),

  installCodexPlugin: (input: {
    marketplacePath?: string
    remoteMarketplaceName?: string
    pluginName: string
  }): Promise<CodexPluginInstallResult> => request('/baton/codex-plugins/install', {
    method: 'POST',
    headers: { 'x-baton-interaction': 'codex-plugin-control' },
    json: input,
  }),

  uninstallCodexPlugin: (pluginId: string): Promise<void> =>
    request('/baton/codex-plugins/uninstall', {
      method: 'POST',
      headers: { 'x-baton-interaction': 'codex-plugin-control' },
      json: { pluginId },
    }),

  // ---- 변경 (mutations) ---------------------------------------------------
  // Account steering is performed by Native priority plus pause/resume.

  pauseAccount: async (provider: Provider, accountId: string, expectedRevision?: number): Promise<void> => {
    await request(
      `${nativeProviderBase(provider)}/accounts/${encodeURIComponent(accountId)}/pause`,
      { method: 'POST', ...(provider === 'codex' ? { json: { expectedRevision } } : {}) },
    )
  },

  resumeAccount: async (provider: Provider, accountId: string, expectedRevision?: number): Promise<void> => {
    await request(
      `${nativeProviderBase(provider)}/accounts/${encodeURIComponent(accountId)}/resume`,
      { method: 'POST', ...(provider === 'codex' ? { json: { expectedRevision } } : {}) },
    )
  },

  removeAccount: async (provider: Provider, accountId: string, expectedRevision?: number): Promise<void> => {
    await request(
      `${nativeProviderBase(provider)}/accounts/${encodeURIComponent(accountId)}`,
      { method: 'DELETE', ...(provider === 'codex' ? { json: { expectedRevision } } : {}) },
    )
  },

  preferAccount: async (provider: Provider, accountId: string): Promise<void> => {
    if (provider !== 'claude') {
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

  applyClientIntegration: async (
    targets: ClientIntegrationTarget[],
    codexMode?: CodexIntegrationMode,
    claudeProxyMode?: ClaudeProxyMode,
  ): Promise<ClientIntegrationApplyResult> => {
    const result = await integrationMutationRequest<ClientIntegrationApplyResult>('/baton/client-integration/apply', {
      targets,
      ...(codexMode ? { codexMode } : {}),
      ...(claudeProxyMode ? { claudeProxyMode } : {}),
    })
    return result
  },

  removeClientIntegration: async (
    targets: ClientIntegrationTarget[],
  ): Promise<ClientIntegrationRemoveResult> => {
    const result = await integrationMutationRequest<ClientIntegrationRemoveResult>(
      '/baton/client-integration/remove',
      { targets },
    )
    return result
  },

  // ---- OAuth 계정 추가 (add-account flow) --------------------------------

  /**
   * Start the Native OAuth add-account flow. Providers may return the auth URL under either
   * `url` or `auth_url` — both are normalized to `{ url, state }`.
   */
  startAddAccount: async (
    provider: Provider,
    nickname?: string,
    _forceNative = false,
  ): Promise<{ url: string; state: string }> => {
    const body = await request<{
      url?: string
      auth_url?: string
      authUrl?: string
      state?: string
    }>(`${nativeProviderBase(provider)}/auth/start-url`, {
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

  getAddStatus: async (provider: Provider, state: string, _forceNative = false): Promise<AddStatus> => {
    return normalizeAddStatus(await request<GatewayAddStatus>(
      `${nativeProviderBase(provider)}/auth/status?state=${encodeURIComponent(state)}`,
    ))
  },

  submitCallback: async (
    provider: Provider,
    redirectUrl: string,
    _forceNative = false,
  ): Promise<AddStatus> => {
    return request<GatewayAddStatus>(`${nativeProviderBase(provider)}/auth/submit-callback`, {
      method: 'POST',
      json: { redirectUrl },
    }).then(normalizeAddStatus)
  },

  cancelAddAccount: async (provider: Provider, _forceNative = false): Promise<void> => {
    await request(`${nativeProviderBase(provider)}/auth/cancel`, { method: 'POST' })
  },
}

export type ApiClient = typeof client
