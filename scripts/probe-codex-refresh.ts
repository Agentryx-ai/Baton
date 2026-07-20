/**
 * Diagnostic: for each Codex Native vault account, force an OAuth token refresh
 * (CodexCredentialManager persists rotated tokens on success) and report the
 * outcome. A failure (e.g. invalid_grant) means the account needs re-login.
 */
import { codexNativeRuntime } from '../server/codex-native-runtime.ts'

const accounts = await codexNativeRuntime.vault.list('codex')
const report: unknown[] = []

for (const account of accounts) {
  const base = {
    id: account.id,
    alias: account.alias,
    enabled: account.enabled,
    priority: account.priority,
  }
  try {
    const credential = await codexNativeRuntime.getPluginCredential(account.id, true)
    report.push({
      ...base,
      refresh: {
        ok: true,
        plan: credential.plan ?? null,
        hasAccessToken: Boolean(credential.accessToken),
        chatgptAccountId: credential.chatgptAccountId ?? null,
      },
    })
  } catch (error) {
    report.push({ ...base, refresh: { ok: false, error: error instanceof Error ? error.message : String(error) } })
  }
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
