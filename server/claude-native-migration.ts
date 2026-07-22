import { createHash } from 'node:crypto'

import {
  ClaudeNativeAccountVault,
  ClaudeNativeAccountVaultError,
  type ClaudeNativeAccountSecret,
} from './claude-native-account-vault.ts'

const CLAUDE_DEFAULT_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
]

export type LegacyClaudeCredential = Record<string, unknown>

export interface LegacyClaudeMigrationResult {
  alias: string
  status: 'imported' | 'matched'
  enabled: boolean
}

export async function migrateLegacyClaudeAccount(input: {
  vault: ClaudeNativeAccountVault
  sourcePath: string
  legacy: LegacyClaudeCredential
  priority: number
}): Promise<LegacyClaudeMigrationResult> {
  return input.vault.withExclusiveMutation(async () => {
  const alias = required(input.legacy.email, 'email').trim().toLowerCase()
  const enabled = !input.sourcePath.includes('/auth-paused/') && input.legacy.disabled !== true
  const refreshToken = required(input.legacy.refresh_token, 'refresh_token')
  const stableIdentity = legacyClaudeStableIdentity(input.legacy)
  const accounts = await input.vault.list()

  const identityMatches = stableIdentity
    ? accounts.filter((account) => account.accountId === stableIdentity)
    : []
  if (identityMatches.length > 1) {
    throw new ClaudeNativeAccountVaultError(
      'invalid',
      `Claude stable identity ${stableIdentity} has duplicate vault accounts; repair it before migration.`,
    )
  }

  let matched = identityMatches[0]
  let matchedSecret: ClaudeNativeAccountSecret | undefined
  if (!matched) {
    const refreshFingerprint = fingerprint(refreshToken)
    for (const account of accounts) {
      const secret = await input.vault.getSecret(account.id)
      if (fingerprint(secret.refreshToken) !== refreshFingerprint) continue
      if (matched) {
        throw new ClaudeNativeAccountVaultError(
          'invalid',
          'Claude refresh credential matches multiple vault accounts; repair duplicates before migration.',
        )
      }
      matched = account
      matchedSecret = secret
    }
  }

  if (matched) {
    if (stableIdentity && matched.accountId && matched.accountId !== stableIdentity) {
      throw new ClaudeNativeAccountVaultError('invalid', 'Claude stable identity conflicts with the matched vault account.')
    }
    const secret = matchedSecret ?? await input.vault.getSecret(matched.id)
    await input.vault.put({
      id: matched.id,
      nickname: alias.split('@')[0] || alias,
      ...(stableIdentity ? { accountId: stableIdentity } : {}),
      email: alias,
      secret,
    })
    return { alias, status: 'matched', enabled: matched.enabled }
  }

  const expiresAt = expiration(input.legacy.expired)
  await input.vault.put({
    nickname: alias.split('@')[0] || alias,
    ...(stableIdentity ? { accountId: stableIdentity } : {}),
    email: alias,
    priority: input.priority,
    enabled,
    source: 'oauth',
    secret: {
      accessToken: required(input.legacy.access_token, 'access_token'),
      refreshToken,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      scopes: CLAUDE_DEFAULT_SCOPES,
    },
  })
  return { alias, status: 'imported', enabled }
  })
}

export function legacyClaudeStableIdentity(legacy: LegacyClaudeCredential): string | undefined {
  for (const key of ['account_id', 'account_uuid']) {
    const candidate = legacy[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  const idToken = legacy.id_token
  if (typeof idToken !== 'string') return undefined
  const payload = idToken.split('.')[1]
  if (!payload) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    return typeof parsed.sub === 'string' && parsed.sub.trim() ? parsed.sub.trim() : undefined
  } catch {
    return undefined
  }
}

function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Legacy credential omitted ${field}`)
  return value
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function expiration(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
