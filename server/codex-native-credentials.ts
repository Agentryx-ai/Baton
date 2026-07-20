export const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_ACCESS_TOKEN_REFRESH_SKEW_MS = 5 * 60_000
export const CODEX_FALLBACK_REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60_000

export interface CodexCredentialsFile {
  tokens?: {
    id_token?: unknown
    access_token?: unknown
    refresh_token?: unknown
    account_id?: unknown
    [key: string]: unknown
  }
  last_refresh?: unknown
  [key: string]: unknown
}

export interface CodexCredentialStore {
  read(): Promise<CodexCredentialsFile>
  write(expectedRefreshToken: string, updated: CodexCredentialsFile): Promise<CodexCredentialsFile>
}

export interface CodexNativeCredential {
  accountId: string
  accessToken: string
  chatgptAccountId?: string
  expiresAt?: number
  plan?: string
}

export interface CodexCredentialManagerOptions {
  accountId: string
  credentialStore: CodexCredentialStore
  tokenUrl?: string
  clientId?: string
  fetchImpl?: typeof fetch
  now?: () => number
}

interface CodexRefreshResponse {
  id_token?: unknown
  access_token?: unknown
  refresh_token?: unknown
}

interface JwtPayload {
  exp?: unknown
  'https://api.openai.com/auth'?: unknown
}

export class CodexNativeCredentialError extends Error {
  readonly code: 'missing' | 'invalid' | 'expired' | 'revoked' | 'reused' | 'unavailable'

  constructor(code: CodexNativeCredentialError['code'], message: string) {
    super(message)
    this.name = 'CodexNativeCredentialError'
    this.code = code
  }
}

function decodeJwtPayload(token: string): JwtPayload {
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new CodexNativeCredentialError('invalid', 'Codex OAuth JWT 형식이 올바르지 않습니다.')
  }
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid shape')
    return parsed as JwtPayload
  } catch (error) {
    if (error instanceof CodexNativeCredentialError) throw error
    throw new CodexNativeCredentialError('invalid', 'Codex OAuth JWT payload를 읽지 못했습니다.')
  }
}

function tokenExpiration(token: string): number | undefined {
  const exp = decodeJwtPayload(token).exp
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1_000 : undefined
}

export function codexPlanFromIdToken(idToken: string): string | undefined {
  const auth = decodeJwtPayload(idToken)['https://api.openai.com/auth']
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return undefined
  const plan = (auth as Record<string, unknown>).chatgpt_plan_type
  return typeof plan === 'string' && plan.length > 0 ? plan : undefined
}

function parseLastRefresh(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function nativeCredential(
  accountId: string,
  stored: CodexCredentialsFile,
  now: number,
  allowExpired: boolean,
): CodexNativeCredential {
  const tokens = stored.tokens
  if (!tokens || typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    throw new CodexNativeCredentialError('missing', 'Codex OAuth access token이 없습니다.')
  }
  const expiresAt = tokenExpiration(tokens.access_token)
  if (!allowExpired && expiresAt !== undefined && expiresAt <= now) {
    throw new CodexNativeCredentialError('expired', 'Codex OAuth access token이 만료되었습니다.')
  }
  const plan = typeof tokens.id_token === 'string'
    ? codexPlanFromIdToken(tokens.id_token)
    : undefined
  const chatgptAccountId = typeof tokens.account_id === 'string' && tokens.account_id.length > 0
    ? tokens.account_id
    : undefined
  return {
    accountId,
    accessToken: tokens.access_token,
    ...(chatgptAccountId === undefined ? {} : { chatgptAccountId }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(plan === undefined ? {} : { plan }),
  }
}

function refreshErrorCode(body: string): CodexNativeCredentialError['code'] {
  try {
    const parsed = JSON.parse(body) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'expired'
    const root = parsed as Record<string, unknown>
    const nested = root.error && typeof root.error === 'object' && !Array.isArray(root.error)
      ? root.error as Record<string, unknown>
      : root
    const code = typeof nested.code === 'string' ? nested.code.toLowerCase() : ''
    if (code === 'refresh_token_reused') return 'reused'
    if (code === 'refresh_token_invalidated') return 'revoked'
    if (code === 'refresh_token_expired') return 'expired'
  } catch {
    // Preserve a redacted, stable category below.
  }
  return 'expired'
}

export class CodexCredentialManager {
  private readonly accountId: string
  private readonly credentialStore: CodexCredentialStore
  private readonly tokenUrl: string
  private readonly clientId: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private pendingRefresh: Promise<CodexNativeCredential> | null = null

  constructor(options: CodexCredentialManagerOptions) {
    this.accountId = options.accountId
    this.credentialStore = options.credentialStore
    this.tokenUrl = options.tokenUrl ?? process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE ?? CODEX_OAUTH_TOKEN_URL
    this.clientId = options.clientId ?? process.env.CODEX_APP_SERVER_LOGIN_CLIENT_ID ?? CODEX_OAUTH_CLIENT_ID
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
  }

  async getCredential(options: { forceRefresh?: boolean } = {}): Promise<CodexNativeCredential> {
    const stored = await this.credentialStore.read()
    const credential = nativeCredential(this.accountId, stored, this.now(), true)
    const lastRefresh = parseLastRefresh(stored.last_refresh)
    const expiring = credential.expiresAt !== undefined
      ? credential.expiresAt <= this.now() + CODEX_ACCESS_TOKEN_REFRESH_SKEW_MS
      : lastRefresh !== undefined && lastRefresh <= this.now() - CODEX_FALLBACK_REFRESH_INTERVAL_MS
    if (!options.forceRefresh && !expiring) return credential
    if (!this.pendingRefresh) {
      this.pendingRefresh = this.refresh(stored).finally(() => {
        this.pendingRefresh = null
      })
    }
    return await this.pendingRefresh
  }

  private async refresh(original: CodexCredentialsFile): Promise<CodexNativeCredential> {
    const refreshToken = original.tokens?.refresh_token
    if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
      throw new CodexNativeCredentialError('expired', 'Codex OAuth refresh token이 없습니다. 다시 로그인하세요.')
    }
    let response: Response
    try {
      response = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: this.clientId,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new CodexNativeCredentialError('unavailable', 'Codex OAuth refresh endpoint에 연결하지 못했습니다.')
    }
    if (!response.ok) {
      const code = refreshErrorCode(await response.text())
      throw new CodexNativeCredentialError(code, 'Codex OAuth token을 갱신하지 못했습니다. 다시 로그인하세요.')
    }
    const result = await response.json() as CodexRefreshResponse
    if (
      typeof result.id_token !== 'string'
      && typeof result.access_token !== 'string'
      && typeof result.refresh_token !== 'string'
    ) {
      throw new CodexNativeCredentialError('invalid', 'Codex OAuth refresh 응답에 token이 없습니다.')
    }
    if (typeof result.id_token === 'string') codexPlanFromIdToken(result.id_token)
    if (typeof result.access_token === 'string') tokenExpiration(result.access_token)

    const latest = await this.credentialStore.read()
    if (latest.tokens?.refresh_token !== refreshToken) {
      return nativeCredential(this.accountId, latest, this.now(), false)
    }
    const updated: CodexCredentialsFile = {
      ...latest,
      tokens: {
        ...latest.tokens,
        ...(typeof result.id_token === 'string' ? { id_token: result.id_token } : {}),
        ...(typeof result.access_token === 'string' ? { access_token: result.access_token } : {}),
        ...(typeof result.refresh_token === 'string' ? { refresh_token: result.refresh_token } : {}),
      },
      last_refresh: new Date(this.now()).toISOString(),
    }
    const persisted = await this.credentialStore.write(refreshToken, updated)
    return nativeCredential(this.accountId, persisted, this.now(), false)
  }
}
