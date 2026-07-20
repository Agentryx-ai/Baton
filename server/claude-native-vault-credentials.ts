import {
  ClaudeNativeAccountVault,
  type ClaudeNativeAccountSecret,
} from './claude-native-account-vault.ts'
import {
  ClaudeNativeCredentialError,
  type ClaudeNativeCredential,
} from './claude-native-credentials.ts'
import { CLAUDE_NATIVE_OAUTH_CONTRACT } from './claude-native-oauth.ts'

const REFRESH_SKEW_MS = 5 * 60_000

export interface ClaudeNativeVaultCredentialManagerOptions {
  vault: ClaudeNativeAccountVault
  fetchImpl?: typeof fetch
  now?: () => number
  tokenUrl?: string
  clientId?: string
}

export class ClaudeNativeVaultCredentialManager {
  private readonly vault: ClaudeNativeAccountVault
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly tokenUrl: string
  private readonly clientId: string
  private readonly pendingRefresh = new Map<string, Promise<ClaudeNativeCredential>>()

  constructor(options: ClaudeNativeVaultCredentialManagerOptions) {
    this.vault = options.vault
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.tokenUrl = options.tokenUrl ?? CLAUDE_NATIVE_OAUTH_CONTRACT.tokenUrl
    this.clientId = options.clientId ?? CLAUDE_NATIVE_OAUTH_CONTRACT.clientId
  }

  async getCredential(accountId: string): Promise<ClaudeNativeCredential> {
    const secret = await this.vault.getSecret(accountId)
    if (secret.expiresAt === undefined || secret.expiresAt > this.now() + REFRESH_SKEW_MS) {
      return credential(accountId, secret)
    }
    const existing = this.pendingRefresh.get(accountId)
    if (existing) return existing
    const pending = this.refresh(accountId, secret).finally(() => {
      this.pendingRefresh.delete(accountId)
    })
    this.pendingRefresh.set(accountId, pending)
    return pending
  }

  private async refresh(accountId: string, secret: ClaudeNativeAccountSecret): Promise<ClaudeNativeCredential> {
    if (!secret.refreshToken) {
      throw new ClaudeNativeCredentialError('expired', 'Claude OAuth refresh token이 없습니다. 계정을 다시 인증하세요.')
    }
    if (secret.refreshTokenExpiresAt !== undefined && secret.refreshTokenExpiresAt <= this.now()) {
      throw new ClaudeNativeCredentialError('expired', 'Claude OAuth refresh token이 만료되었습니다. 계정을 다시 인증하세요.')
    }
    let response: Response
    try {
      response = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: secret.refreshToken,
          client_id: this.clientId,
          scope: (secret.scopes.length > 0 ? secret.scopes : CLAUDE_NATIVE_OAUTH_CONTRACT.scopes).join(' '),
        }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new ClaudeNativeCredentialError('expired', 'Claude OAuth token 갱신 endpoint에 연결하지 못했습니다.')
    }
    if (!response.ok) {
      throw new ClaudeNativeCredentialError(
        'expired',
        `Claude OAuth token 갱신이 HTTP ${response.status}로 실패했습니다. 계정을 다시 인증하세요.`,
      )
    }
    const value = await response.json() as Record<string, unknown>
    if (
      typeof value.access_token !== 'string'
      || value.access_token.length === 0
      || typeof value.expires_in !== 'number'
      || !Number.isFinite(value.expires_in)
      || value.expires_in <= 0
    ) throw new ClaudeNativeCredentialError('invalid', 'Claude OAuth token 갱신 응답이 올바르지 않습니다.')
    const updated: ClaudeNativeAccountSecret = {
      accessToken: value.access_token,
      refreshToken: typeof value.refresh_token === 'string' && value.refresh_token.length > 0
        ? value.refresh_token
        : secret.refreshToken,
      expiresAt: this.now() + value.expires_in * 1_000,
      ...(typeof value.refresh_token_expires_in === 'number' && value.refresh_token_expires_in > 0
        ? { refreshTokenExpiresAt: this.now() + value.refresh_token_expires_in * 1_000 }
        : secret.refreshTokenExpiresAt === undefined
          ? {}
          : { refreshTokenExpiresAt: secret.refreshTokenExpiresAt }),
      scopes: typeof value.scope === 'string'
        ? value.scope.split(/\s+/).filter(Boolean)
        : secret.scopes,
    }
    await this.vault.updateSecret(accountId, updated)
    return credential(accountId, updated)
  }
}

function credential(accountId: string, secret: ClaudeNativeAccountSecret): ClaudeNativeCredential {
  return {
    accessToken: secret.accessToken,
    accountId,
    expiresAt: secret.expiresAt,
    scopes: secret.scopes,
  }
}
