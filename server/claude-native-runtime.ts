import { config } from './config.ts'
import {
  ClaudeCodeCredentialManager,
  loadClaudeCodeOAuthAccountSnapshot,
  loadOrCreateNativeClaudeProxyToken,
} from './claude-native-credentials.ts'
import {
  ClaudeNativeAccountVault,
  ClaudeNativeAccountVaultError,
  WindowsDpapiSecretProtector,
  nativeClaudeAccountVaultPath,
} from './claude-native-account-vault.ts'
import { ClaudeNativeOAuthManager } from './claude-native-oauth.ts'
import { ClaudeNativeVaultCredentialManager } from './claude-native-vault-credentials.ts'
import type { ClaudeNativeCredentialCandidate } from './claude-native-proxy.ts'
import type { ClaudeNativeCredential } from './claude-native-credentials.ts'
import { CLAUDE_NATIVE_PROXY_PATH } from './claude-native-proxy.ts'
import { ClaudeQuotaPreflight } from './claude-native-quota.ts'

export interface NativeClaudeProxyConnection {
  baseUrl: string
  token: string
  models: string[]
}

export const claudeCredentialManager = new ClaudeCodeCredentialManager()
export const claudeQuotaPreflight = new ClaudeQuotaPreflight()
export const claudeNativeAccountVault = new ClaudeNativeAccountVault({
  filePath: nativeClaudeAccountVaultPath(config.dataDir),
  protector: new WindowsDpapiSecretProtector(),
})
export const claudeNativeOAuthManager = new ClaudeNativeOAuthManager({ vault: claudeNativeAccountVault })
export const claudeNativeVaultCredentialManager = new ClaudeNativeVaultCredentialManager({
  vault: claudeNativeAccountVault,
})
let pendingClaudeCodeImport: Promise<void> | null = null

export async function ensureNativeClaudeAccounts(): Promise<void> {
  pendingClaudeCodeImport ??= claudeNativeAccountVault.importClaudeCodeOnce(async () => {
    try {
      const snapshot = await loadClaudeCodeOAuthAccountSnapshot()
      return { ...snapshot, priority: 0, enabled: true }
    } catch {
      return null
    }
  }).then(() => undefined)
  return pendingClaudeCodeImport
}

export async function loadNativeClaudeCredentialCandidates(): Promise<ClaudeNativeCredentialCandidate[]> {
  await ensureNativeClaudeAccounts()
  const accounts = (await claudeNativeAccountVault.list()).filter((account) => account.enabled)
  const settled = await Promise.allSettled(accounts.map(async (account) => {
    const credential = account.source === 'claude-code'
      ? await claudeCredentialManager.getCredential()
      : await claudeNativeVaultCredentialManager.getCredential(account.id)
    return { id: account.id, nickname: account.nickname, credential: { ...credential, accountId: account.id } }
  }))
  const seenTokens = new Set<string>()
  const candidates: ClaudeNativeCredentialCandidate[] = []
  for (const result of settled) {
    if (result.status !== 'fulfilled' || seenTokens.has(result.value.credential.accessToken)) continue
    seenTokens.add(result.value.credential.accessToken)
    candidates.push(result.value)
  }
  return candidates
}

export async function loadNativeClaudeAccountCredential(accountId: string): Promise<ClaudeNativeCredential> {
  await ensureNativeClaudeAccounts()
  const account = (await claudeNativeAccountVault.list()).find((candidate) => candidate.id === accountId)
  if (!account) throw new ClaudeNativeAccountVaultError('not_found', 'Claude 계정을 찾지 못했습니다.')
  const credential = account.source === 'claude-code'
    ? await claudeCredentialManager.getCredential()
    : await claudeNativeVaultCredentialManager.getCredential(account.id)
  return { ...credential, accountId: account.id }
}

export function claudeNativeProxyBaseUrl(
  port: number = Number(process.env.BATON_PORT ?? 4400),
): string {
  return `http://127.0.0.1:${port}${CLAUDE_NATIVE_PROXY_PATH}`
}

export async function loadNativeClaudeProxyConnection(
  includeModels: boolean,
): Promise<NativeClaudeProxyConnection> {
  const baseUrl = claudeNativeProxyBaseUrl()
  const token = await loadOrCreateNativeClaudeProxyToken(config.dataDir)
  if (!includeModels) return { baseUrl, token, models: [] }

  let response: Response
  try {
    response = await fetch(`${baseUrl}/v1/models`, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Baton Native Claude 모델 목록 요청에 실패했습니다: ${message}`)
  }
  if (!response.ok) {
    throw new Error(`Baton Native Claude 모델 목록 요청이 HTTP ${response.status}로 실패했습니다.`)
  }
  const body = await response.json() as { data?: Array<{ id?: unknown }> }
  const models = Array.from(new Set(
    (Array.isArray(body.data) ? body.data : [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )).sort((left, right) => left.localeCompare(right, 'en'))
  return { baseUrl, token, models }
}
