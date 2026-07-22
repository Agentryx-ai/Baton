import { createHash, randomBytes } from 'node:crypto'

import {
  ClaudeNativeAccountVault,
  type ClaudeNativeAccount,
  type ClaudeNativeAccountSecret,
} from './claude-native-account-vault.ts'

export const CLAUDE_NATIVE_OAUTH_CONTRACT = {
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  profileUrl: 'https://api.anthropic.com/api/oauth/profile',
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  redirectUri: 'http://localhost:54545/callback',
  scopes: [
    'user:profile',
    'user:inference',
    'user:sessions:claude_code',
    'user:mcp_servers',
    'user:file_upload',
  ],
} as const

type OAuthFlowStatus = 'wait' | 'exchanging' | 'success' | 'error'

interface OAuthFlow {
  state: string
  verifier: string
  nickname: string
  explicitNickname: boolean
  createdAt: number
  expiresAt: number
  status: OAuthFlowStatus
  account?: ClaudeNativeAccount
  error?: string
}

export interface ClaudeNativeOAuthStatus {
  status: 'wait' | 'success' | 'error'
  account?: ClaudeNativeAccount
  error?: string
}

export interface ClaudeNativeOAuthManagerOptions {
  vault: ClaudeNativeAccountVault
  fetchImpl?: typeof fetch
  now?: () => number
  random?: (size: number) => Buffer
  flowTtlMs?: number
  authorizeUrl?: string
  tokenUrl?: string
  profileUrl?: string
  redirectUri?: string
  clientId?: string
  scopes?: readonly string[]
}

export class ClaudeNativeOAuthError extends Error {
  readonly code: 'invalid' | 'expired' | 'replayed' | 'unavailable'

  constructor(code: 'invalid' | 'expired' | 'replayed' | 'unavailable', message: string) {
    super(message)
    this.name = 'ClaudeNativeOAuthError'
    this.code = code
  }
}

export class ClaudeNativeOAuthManager {
  private readonly vault: ClaudeNativeAccountVault
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly random: (size: number) => Buffer
  private readonly flowTtlMs: number
  private readonly authorizeUrl: string
  private readonly tokenUrl: string
  private readonly profileUrl: string
  private readonly redirectUri: string
  private readonly clientId: string
  private readonly scopes: readonly string[]
  private readonly flows = new Map<string, OAuthFlow>()

  constructor(options: ClaudeNativeOAuthManagerOptions) {
    this.vault = options.vault
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.random = options.random ?? randomBytes
    this.flowTtlMs = options.flowTtlMs ?? 10 * 60_000
    this.authorizeUrl = options.authorizeUrl ?? CLAUDE_NATIVE_OAUTH_CONTRACT.authorizeUrl
    this.tokenUrl = options.tokenUrl ?? CLAUDE_NATIVE_OAUTH_CONTRACT.tokenUrl
    this.profileUrl = options.profileUrl ?? CLAUDE_NATIVE_OAUTH_CONTRACT.profileUrl
    this.redirectUri = options.redirectUri ?? CLAUDE_NATIVE_OAUTH_CONTRACT.redirectUri
    this.clientId = options.clientId ?? CLAUDE_NATIVE_OAUTH_CONTRACT.clientId
    this.scopes = options.scopes ?? CLAUDE_NATIVE_OAUTH_CONTRACT.scopes
  }

  start(nickname?: string): { authUrl: string; state: string } {
    this.cleanup()
    const verifier = this.random(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = this.random(24).toString('base64url')
    const createdAt = this.now()
    const trimmedNickname = nickname?.trim()
    this.flows.set(state, {
      state,
      verifier,
      nickname: trimmedNickname || 'Claude account',
      explicitNickname: Boolean(trimmedNickname),
      createdAt,
      expiresAt: createdAt + this.flowTtlMs,
      status: 'wait',
    })

    const url = new URL(this.authorizeUrl)
    url.searchParams.set('code', 'true')
    url.searchParams.set('client_id', this.clientId)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', this.redirectUri)
    url.searchParams.set('scope', this.scopes.join(' '))
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', state)
    return { authUrl: url.toString(), state }
  }

  status(state: string): ClaudeNativeOAuthStatus {
    const flow = this.requireFlow(state)
    if (flow.status === 'success') return { status: 'success', account: flow.account }
    if (flow.status === 'error') return { status: 'error', error: flow.error }
    return { status: 'wait' }
  }

  async submit(redirectUrl: string): Promise<ClaudeNativeOAuthStatus> {
    const callback = parseCallback(redirectUrl, this.redirectUri)
    const flow = this.requireFlow(callback.state)
    if (flow.status !== 'wait') {
      throw new ClaudeNativeOAuthError('replayed', '이미 사용되었거나 처리 중인 Claude OAuth callback입니다.')
    }
    flow.status = 'exchanging'
    const verifier = flow.verifier
    flow.verifier = ''

    let response: Response
    try {
      response = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: callback.code,
          state: callback.state,
          grant_type: 'authorization_code',
          client_id: this.clientId,
          redirect_uri: this.redirectUri,
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      return this.fail(flow, 'Claude OAuth token endpoint에 연결하지 못했습니다.')
    }
    if (!response.ok) {
      return this.fail(flow, `Claude OAuth token 교환이 HTTP ${response.status}로 실패했습니다.`)
    }

    let secret: ClaudeNativeAccountSecret
    try {
      secret = parseTokenResponse(await response.json(), this.now(), this.scopes)
    } catch (error) {
      return this.fail(flow, error instanceof Error ? error.message : 'Claude OAuth token 응답이 올바르지 않습니다.')
    }
    const profile = await this.fetchProfile(secret.accessToken)
    if (!profile.accountUuid) {
      return this.fail(flow, 'Claude OAuth profile에서 검증된 계정 식별자를 확인하지 못했습니다.')
    }
    const nickname = flow.explicitNickname
      ? flow.nickname
      : profile.email?.split('@')[0] || profile.displayName || flow.nickname
    try {
      const accountInput = {
        nickname,
        ...(profile.email ? { email: profile.email } : {}),
        accountId: profile.accountUuid,
        source: 'oauth',
        secret,
      } as const
      const placeholder = await this.findOwnedClaudeCodePlaceholder(profile.accountUuid)
      flow.account = placeholder
        ? await this.vault.claimClaudeCodePlaceholder({
            ...accountInput,
            placeholderId: placeholder.id,
            expectedRefreshToken: placeholder.refreshToken,
          })
        : await this.vault.put(accountInput)
    } catch {
      return this.fail(flow, 'Claude OAuth 자격증명을 보안 vault에 저장하지 못했습니다.')
    }
    flow.status = 'success'
    return { status: 'success', account: flow.account }
  }

  /** Fetch the OAuth account profile (email, display name, stable uuid). */
  private async fetchProfile(accessToken: string): Promise<{
    email?: string
    accountUuid?: string
    displayName?: string
  }> {
    try {
      const response = await this.fetchImpl(this.profileUrl, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) return {}
      const body = await response.json() as { account?: unknown }
      const account = body.account && typeof body.account === 'object' && !Array.isArray(body.account)
        ? body.account as Record<string, unknown>
        : {}
      const email = typeof account.email === 'string' && account.email.length > 0 ? account.email : undefined
      const accountUuid = typeof account.uuid === 'string' && account.uuid.length > 0 ? account.uuid : undefined
      const displayName = typeof account.display_name === 'string' && account.display_name.length > 0
        ? account.display_name
        : typeof account.full_name === 'string' && account.full_name.length > 0
          ? account.full_name
          : undefined
      return {
        ...(email ? { email } : {}),
        ...(accountUuid ? { accountUuid } : {}),
        ...(displayName ? { displayName } : {}),
      }
    } catch {
      return {}
    }
  }

  private async findOwnedClaudeCodePlaceholder(accountUuid: string): Promise<{
    id: string
    refreshToken: string
  } | null> {
    const placeholders = (await this.vault.list()).filter((account) => (
      account.source === 'claude-code' && !account.accountId
    ))
    const matches: Array<{ id: string; refreshToken: string }> = []
    for (const placeholder of placeholders) {
      const secret = await this.vault.getSecret(placeholder.id)
      const profile = await this.fetchProfile(secret.accessToken)
      if (!profile.accountUuid) {
        throw new ClaudeNativeOAuthError(
          'unavailable',
          'Claude Code placeholder identity could not be verified; refusing to guess account ownership.',
        )
      }
      if (profile.accountUuid === accountUuid) matches.push({ id: placeholder.id, refreshToken: secret.refreshToken })
    }
    if (matches.length > 1) {
      throw new ClaudeNativeOAuthError(
        'invalid',
        'Multiple Claude Code placeholders resolve to the same account; repair the vault before connecting.',
      )
    }
    return matches[0] ?? null
  }

  cancel(state?: string): void {
    if (state) this.flows.delete(state)
    else this.flows.clear()
  }

  private requireFlow(state: string): OAuthFlow {
    this.cleanup()
    const flow = this.flows.get(state)
    if (!flow) throw new ClaudeNativeOAuthError('expired', 'Claude OAuth 세션이 없거나 만료되었습니다.')
    return flow
  }

  private cleanup(): void {
    const now = this.now()
    for (const [state, flow] of this.flows) {
      if (flow.expiresAt <= now) this.flows.delete(state)
    }
  }

  private fail(flow: OAuthFlow, message: string): ClaudeNativeOAuthStatus {
    flow.status = 'error'
    flow.error = message
    return { status: 'error', error: message }
  }
}

function parseCallback(raw: string, expectedRedirectUri: string): { code: string; state: string } {
  let callback: URL
  try {
    callback = new URL(raw)
  } catch {
    throw new ClaudeNativeOAuthError('invalid', 'Claude OAuth callback URL이 올바르지 않습니다.')
  }
  const expected = new URL(expectedRedirectUri)
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname) {
    throw new ClaudeNativeOAuthError('invalid', 'Claude OAuth callback origin 또는 경로가 올바르지 않습니다.')
  }
  const code = callback.searchParams.get('code')
  const state = callback.searchParams.get('state')
  if (!code || !state) {
    throw new ClaudeNativeOAuthError('invalid', 'Claude OAuth callback에 code 또는 state가 없습니다.')
  }
  return { code, state }
}

function parseTokenResponse(
  input: unknown,
  now: number,
  defaultScopes: readonly string[],
): ClaudeNativeAccountSecret {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ClaudeNativeOAuthError('invalid', 'Claude OAuth token 응답이 객체가 아닙니다.')
  }
  const value = input as Record<string, unknown>
  if (
    typeof value.access_token !== 'string'
    || value.access_token.length === 0
    || typeof value.refresh_token !== 'string'
    || value.refresh_token.length === 0
    || typeof value.expires_in !== 'number'
    || !Number.isFinite(value.expires_in)
    || value.expires_in <= 0
  ) throw new ClaudeNativeOAuthError('invalid', 'Claude OAuth token 응답의 필수 필드가 올바르지 않습니다.')
  const scopes = typeof value.scope === 'string'
    ? value.scope.split(/\s+/).filter(Boolean)
    : [...defaultScopes]
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    expiresAt: now + value.expires_in * 1_000,
    ...(typeof value.refresh_token_expires_in === 'number' && value.refresh_token_expires_in > 0
      ? { refreshTokenExpiresAt: now + value.refresh_token_expires_in * 1_000 }
      : {}),
    scopes,
  }
}
