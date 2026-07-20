/**
 * One-off repair: for Claude Native accounts with a missing email, fetch the
 * OAuth profile with the account's live access token and persist the real email,
 * stable account uuid, and (when the nickname is a placeholder) an email-derived
 * nickname. Accounts whose token can't be loaded are skipped, not failed.
 */
import {
  claudeNativeAccountVault,
  loadNativeClaudeAccountCredential,
} from '../server/claude-native-runtime.ts'
import { CLAUDE_NATIVE_OAUTH_CONTRACT } from '../server/claude-native-oauth.ts'

const PLACEHOLDER_NICKNAMES = new Set(['Claude account', 'Claude Code', ''])

async function fetchProfile(accessToken: string): Promise<{ email?: string; uuid?: string; displayName?: string }> {
  const response = await fetch(CLAUDE_NATIVE_OAUTH_CONTRACT.profileUrl, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`profile HTTP ${response.status}`)
  const body = await response.json() as { account?: Record<string, unknown> }
  const account = body.account ?? {}
  return {
    email: typeof account.email === 'string' ? account.email : undefined,
    uuid: typeof account.uuid === 'string' ? account.uuid : undefined,
    displayName: typeof account.display_name === 'string' ? account.display_name : undefined,
  }
}

const accounts = await claudeNativeAccountVault.list()
const results: unknown[] = []

for (const account of accounts) {
  if (account.email && account.email.length > 0 && account.accountId) {
    results.push({ id: account.id, status: 'already-complete', email: account.email })
    continue
  }
  try {
    const credential = await loadNativeClaudeAccountCredential(account.id)
    const profile = await fetchProfile(credential.accessToken)
    if (!profile.email) {
      results.push({ id: account.id, status: 'no-email-in-profile' })
      continue
    }
    const secret = await claudeNativeAccountVault.getSecret(account.id)
    const nickname = PLACEHOLDER_NICKNAMES.has(account.nickname)
      ? profile.email.split('@')[0] || profile.displayName || account.nickname
      : account.nickname
    await claudeNativeAccountVault.put({
      id: account.id,
      nickname,
      email: profile.email,
      ...(profile.uuid ? { accountId: profile.uuid } : {}),
      secret,
    })
    results.push({ id: account.id, status: 'updated', email: profile.email, nickname })
  } catch (error) {
    results.push({ id: account.id, status: 'skipped', error: error instanceof Error ? error.message : String(error) })
  }
}

process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
