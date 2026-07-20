/**
 * Diagnostic: using a currently-valid Claude access token, probe candidate
 * OAuth profile endpoints to find the authoritative email source. Redacts tokens.
 */
import { loadNativeClaudeAccountCredential } from '../server/claude-native-runtime.ts'
import { claudeNativeAccountVault } from '../server/claude-native-runtime.ts'

const accounts = await claudeNativeAccountVault.list()
// Pick an account whose access token is not clock-expired.
let chosen: string | undefined
for (const account of accounts) {
  const secret = await claudeNativeAccountVault.getSecret(account.id)
  if (secret.expiresAt && secret.expiresAt > Date.now() + 30_000) { chosen = account.id; break }
}
if (!chosen) { process.stdout.write('no account with a live access token\n'); process.exit(0) }

const credential = await loadNativeClaudeAccountCredential(chosen)
const token = credential.accessToken

const endpoints = [
  'https://api.anthropic.com/api/oauth/profile',
  'https://api.anthropic.com/api/oauth/userinfo',
  'https://api.anthropic.com/api/oauth/me',
  'https://api.anthropic.com/api/claude_cli/organizations',
  'https://platform.claude.com/v1/oauth/userinfo',
]

for (const url of endpoints) {
  try {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    })
    const text = await response.text()
    process.stdout.write(`\n### ${url}\nHTTP ${response.status}\n${text.slice(0, 600)}\n`)
  } catch (error) {
    process.stdout.write(`\n### ${url}\nERR ${error instanceof Error ? error.message : String(error)}\n`)
  }
}
