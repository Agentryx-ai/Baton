/**
 * Diagnostic: for each Claude Native vault account, report token expiry and
 * attempt an OAuth refresh. On success the rotated tokens are persisted back to
 * the vault (never discarded — discarding would invalidate a working account).
 * Read-only-ish: a failed refresh changes nothing; a successful one heals the account.
 */
import { claudeNativeAccountVault } from '../server/claude-native-runtime.ts'
import { CLAUDE_NATIVE_OAUTH_CONTRACT } from '../server/claude-native-oauth.ts'

const now = Date.now()
const accounts = await claudeNativeAccountVault.list()
const report: unknown[] = []

for (const account of accounts) {
  const secret = await claudeNativeAccountVault.getSecret(account.id)
  const base = {
    id: account.id,
    email: account.email,
    nickname: account.nickname,
    source: account.source,
    enabled: account.enabled,
    accessTokenExpiresInSec: secret.expiresAt ? Math.round((secret.expiresAt - now) / 1000) : null,
    hasRefreshToken: Boolean(secret.refreshToken),
    refreshTokenExpiresInSec: secret.refreshTokenExpiresAt
      ? Math.round((secret.refreshTokenExpiresAt - now) / 1000)
      : null,
  }

  if (account.source === 'claude-code') {
    report.push({ ...base, refresh: 'skipped (source=claude-code; owned by ~/.claude)' })
    continue
  }
  if (!secret.refreshToken) {
    report.push({ ...base, refresh: 'no refresh token' })
    continue
  }

  try {
    const response = await fetch(CLAUDE_NATIVE_OAUTH_CONTRACT.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: secret.refreshToken,
        client_id: CLAUDE_NATIVE_OAUTH_CONTRACT.clientId,
        scope: (secret.scopes.length > 0 ? secret.scopes : CLAUDE_NATIVE_OAUTH_CONTRACT.scopes).join(' '),
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    if (!response.ok) {
      report.push({ ...base, refresh: { ok: false, status: response.status, body: text.slice(0, 300) } })
      continue
    }
    // Success: persist the rotated tokens so we never lose the rotation.
    const value = JSON.parse(text) as Record<string, unknown>
    const newAccess = typeof value.access_token === 'string' ? value.access_token : ''
    const expiresIn = typeof value.expires_in === 'number' ? value.expires_in : 0
    if (newAccess && expiresIn > 0) {
      await claudeNativeAccountVault.updateSecret(account.id, {
        accessToken: newAccess,
        refreshToken: typeof value.refresh_token === 'string' && value.refresh_token.length > 0
          ? value.refresh_token
          : secret.refreshToken,
        expiresAt: now + expiresIn * 1000,
        ...(typeof value.refresh_token_expires_in === 'number' && value.refresh_token_expires_in > 0
          ? { refreshTokenExpiresAt: now + value.refresh_token_expires_in * 1000 }
          : secret.refreshTokenExpiresAt === undefined ? {} : { refreshTokenExpiresAt: secret.refreshTokenExpiresAt }),
        scopes: typeof value.scope === 'string' ? value.scope.split(/\s+/).filter(Boolean) : secret.scopes,
      })
      report.push({ ...base, refresh: { ok: true, status: response.status, persisted: true } })
    } else {
      report.push({ ...base, refresh: { ok: false, status: response.status, body: 'malformed token response', raw: text.slice(0, 200) } })
    }
  } catch (error) {
    report.push({ ...base, refresh: { error: error instanceof Error ? error.message : String(error) } })
  }
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
