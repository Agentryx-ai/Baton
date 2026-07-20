import { createHash, randomBytes } from 'node:crypto'

import { CODEX_OAUTH_CLIENT_ID, CODEX_OAUTH_TOKEN_URL } from './codex-native-credentials.ts'
import type { CodexCredentialsFile } from './codex-native-credentials.ts'
import type { NativeAccountMetadata } from './native-account-vault.ts'
import { NativeAccountVault } from './native-account-vault.ts'

export const CODEX_NATIVE_OAUTH_CONTRACT = {
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: CODEX_OAUTH_TOKEN_URL,
  clientId: CODEX_OAUTH_CLIENT_ID,
  redirectUri: 'http://localhost:1455/auth/callback',
  scopes: [
    'openid',
    'profile',
    'email',
    'offline_access',
    'api.connectors.read',
    'api.connectors.invoke',
  ],
} as const

type OAuthFlowStatus = 'wait' | 'exchanging' | 'success' | 'error'

interface OAuthFlow {
  state: string
  verifier: string
  alias: string
  enabled: boolean
  createdAt: number
  expiresAt: number
  status: OAuthFlowStatus
  account?: NativeAccountMetadata
  error?: string
}

export interface CodexNativeOAuthStatus {
  status: 'wait' | 'success' | 'error'
  account?: NativeAccountMetadata
  error?: string
}

export interface CodexNativeOAuthManagerOptions {
  vault: NativeAccountVault
  fetchImpl?: typeof fetch
  now?: () => number
  random?: (size: number) => Buffer
  flowTtlMs?: number
  authorizeUrl?: string
  tokenUrl?: string
  redirectUri?: string
  clientId?: string
  scopes?: readonly string[]
}

export class CodexNativeOAuthError extends Error {
  readonly code: 'invalid' | 'expired' | 'replayed' | 'unavailable'

  constructor(code: CodexNativeOAuthError['code'], message: string) {
    super(message)
    this.name = 'CodexNativeOAuthError'
    this.code = code
  }
}

export class CodexNativeOAuthManager {
  private readonly vault: NativeAccountVault
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly random: (size: number) => Buffer
  private readonly flowTtlMs: number
  private readonly authorizeUrl: string
  private readonly tokenUrl: string
  private readonly redirectUri: string
  private readonly clientId: string
  private readonly scopes: readonly string[]
  private readonly flows = new Map<string, OAuthFlow>()

  constructor(options: CodexNativeOAuthManagerOptions) {
    this.vault = options.vault
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.random = options.random ?? randomBytes
    this.flowTtlMs = options.flowTtlMs ?? 10 * 60_000
    this.authorizeUrl = options.authorizeUrl ?? CODEX_NATIVE_OAUTH_CONTRACT.authorizeUrl
    this.tokenUrl = options.tokenUrl ?? CODEX_NATIVE_OAUTH_CONTRACT.tokenUrl
    this.redirectUri = options.redirectUri ?? CODEX_NATIVE_OAUTH_CONTRACT.redirectUri
    this.clientId = options.clientId ?? CODEX_NATIVE_OAUTH_CONTRACT.clientId
    this.scopes = options.scopes ?? CODEX_NATIVE_OAUTH_CONTRACT.scopes
  }

  start(alias?: string, enabled = true): { authUrl: string, state: string } {
    this.cleanup()
    const verifier = this.random(32).toString('base64url')
    const state = this.random(24).toString('base64url')
    const createdAt = this.now()
    this.flows.set(state, {
      state,
      verifier,
      alias: alias?.trim() || 'Codex account',
      enabled,
      createdAt,
      expiresAt: createdAt + this.flowTtlMs,
      status: 'wait',
    })
    const url = new URL(this.authorizeUrl)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.clientId)
    url.searchParams.set('redirect_uri', this.redirectUri)
    url.searchParams.set('scope', this.scopes.join(' '))
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'))
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('id_token_add_organizations', 'true')
    url.searchParams.set('codex_cli_simplified_flow', 'true')
    url.searchParams.set('state', state)
    url.searchParams.set('originator', 'codex_cli_rs')
    return { authUrl: url.toString(), state }
  }

  status(state: string): CodexNativeOAuthStatus {
    const flow = this.requireFlow(state)
    if (flow.status === 'success') return { status: 'success', account: flow.account }
    if (flow.status === 'error') return { status: 'error', error: flow.error }
    return { status: 'wait' }
  }

  async submit(redirectUrl: string): Promise<CodexNativeOAuthStatus> {
    const callback = parseCallback(redirectUrl, this.redirectUri)
    const flow = this.requireFlow(callback.state)
    if (flow.status !== 'wait') {
      throw new CodexNativeOAuthError('replayed', '이미 사용되었거나 처리 중인 Codex OAuth callback입니다.')
    }
    flow.status = 'exchanging'
    const verifier = flow.verifier
    flow.verifier = ''
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: callback.code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      code_verifier: verifier,
    })
    let response: Response
    try {
      response = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      return this.fail(flow, 'Codex OAuth token endpoint에 연결하지 못했습니다.')
    }
    if (!response.ok) return this.fail(flow, `Codex OAuth token 교환이 HTTP ${response.status}로 실패했습니다.`)

    let credential: CodexCredentialsFile
    try {
      credential = parseTokenResponse(await response.json(), this.now())
    } catch (error) {
      return this.fail(flow, error instanceof Error ? error.message : 'Codex OAuth token 응답이 올바르지 않습니다.')
    }
    try {
      flow.account = await this.vault.add({
        provider: 'codex',
        alias: flow.alias,
        enabled: flow.enabled,
        credential,
      })
    } catch {
      return this.fail(flow, 'Codex OAuth 자격증명을 보안 vault에 저장하지 못했습니다.')
    }
    flow.status = 'success'
    return { status: 'success', account: flow.account }
  }

  cancel(state?: string): void {
    if (state) this.flows.delete(state)
    else this.flows.clear()
  }

  private requireFlow(state: string): OAuthFlow {
    this.cleanup()
    const flow = this.flows.get(state)
    if (!flow) throw new CodexNativeOAuthError('expired', 'Codex OAuth 세션이 없거나 만료되었습니다.')
    return flow
  }

  private cleanup(): void {
    const now = this.now()
    for (const [state, flow] of this.flows) {
      if (flow.expiresAt <= now) this.flows.delete(state)
    }
  }

  private fail(flow: OAuthFlow, message: string): CodexNativeOAuthStatus {
    flow.status = 'error'
    flow.error = message
    return { status: 'error', error: message }
  }
}

function parseCallback(raw: string, expectedRedirectUri: string): { code: string, state: string } {
  let callback: URL
  try {
    callback = new URL(raw)
  } catch {
    throw new CodexNativeOAuthError('invalid', 'Codex OAuth callback URL이 올바르지 않습니다.')
  }
  const expected = new URL(expectedRedirectUri)
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname) {
    throw new CodexNativeOAuthError('invalid', 'Codex OAuth callback origin 또는 경로가 올바르지 않습니다.')
  }
  const code = callback.searchParams.get('code')
  const state = callback.searchParams.get('state')
  if (!code || !state) throw new CodexNativeOAuthError('invalid', 'Codex OAuth callback에 code 또는 state가 없습니다.')
  return { code, state }
}

function parseTokenResponse(input: unknown, now: number): CodexCredentialsFile {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CodexNativeOAuthError('invalid', 'Codex OAuth token 응답이 객체가 아닙니다.')
  }
  const value = input as Record<string, unknown>
  if (
    typeof value.id_token !== 'string' || value.id_token.length === 0
    || typeof value.access_token !== 'string' || value.access_token.length === 0
    || typeof value.refresh_token !== 'string' || value.refresh_token.length === 0
  ) throw new CodexNativeOAuthError('invalid', 'Codex OAuth token 응답의 필수 필드가 올바르지 않습니다.')
  const accountId = chatgptAccountId(value.id_token)
  return {
    auth_mode: 'chatgpt',
    tokens: {
      id_token: value.id_token,
      access_token: value.access_token,
      refresh_token: value.refresh_token,
      ...(accountId ? { account_id: accountId } : {}),
    },
    last_refresh: new Date(now).toISOString(),
  }
}

function chatgptAccountId(idToken: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString()) as {
      'https://api.openai.com/auth'?: { chatgpt_account_id?: unknown }
    }
    const value = payload['https://api.openai.com/auth']?.chatgpt_account_id
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}
