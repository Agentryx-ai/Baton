import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  CodexCredentialManager,
} from './codex-native-credentials.ts'
import type {
  CodexCredentialStore,
  CodexCredentialsFile,
  CodexNativeCredential,
} from './codex-native-credentials.ts'
import { CodexModelCatalog } from './codex-native-models.ts'
import type { CodexNativeProxyAccount } from './codex-native-proxy.ts'
import {
  NativeAccountVault,
  NativeAccountVaultError,
} from './native-account-vault.ts'

function installedCodexVersion(): string {
  const override = process.env.CODEX_CLIENT_VERSION?.trim()
  if (override) return override
  const appData = process.env.APPDATA
  if (!appData) return '0.0.0'
  try {
    const packageJson = JSON.parse(readFileSync(
      path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'package.json'),
      'utf8',
    )) as { version?: unknown }
    return typeof packageJson.version === 'string' && packageJson.version.length > 0
      ? packageJson.version
      : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function refreshToken(stored: CodexCredentialsFile): string | undefined {
  const value = stored.tokens?.refresh_token
  return typeof value === 'string' ? value : undefined
}

class CodexVaultCredentialStore implements CodexCredentialStore {
  private readonly vault: NativeAccountVault
  private readonly accountId: string

  constructor(
    vault: NativeAccountVault,
    accountId: string,
  ) {
    this.vault = vault
    this.accountId = accountId
  }

  async read(): Promise<CodexCredentialsFile> {
    return await this.vault.readCredential<CodexCredentialsFile>(this.accountId, 'codex')
  }

  async write(
    expectedRefreshToken: string,
    updated: CodexCredentialsFile,
  ): Promise<CodexCredentialsFile> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await this.vault.readAccount<CodexCredentialsFile>(this.accountId, 'codex')
      if (refreshToken(current.credential) !== expectedRefreshToken) return current.credential
      try {
        await this.vault.replaceCredential(
          this.accountId,
          updated,
          current.metadata.revision,
        )
        return updated
      } catch (error) {
        if (!(error instanceof NativeAccountVaultError) || error.code !== 'conflict' || attempt > 0) throw error
      }
    }
    throw new NativeAccountVaultError('conflict', 'Codex credential 갱신 충돌을 해결하지 못했습니다.')
  }
}

export interface CodexNativeRuntimeOptions {
  vault?: NativeAccountVault
  catalog?: CodexModelCatalog
  credentialFetchImpl?: typeof fetch
  usageFetchImpl?: typeof fetch
  usageUrl?: string
}

export class CodexNativeRuntime {
  readonly vault: NativeAccountVault
  readonly catalog: CodexModelCatalog
  private readonly credentialFetchImpl?: typeof fetch
  private readonly usageFetchImpl: typeof fetch
  private readonly usageUrl: string
  private readonly managers = new Map<string, CodexCredentialManager>()
  private readonly credentialFingerprints = new Map<string, string>()

  constructor(options: CodexNativeRuntimeOptions = {}) {
    this.vault = options.vault ?? new NativeAccountVault()
    this.catalog = options.catalog ?? new CodexModelCatalog({ clientVersion: installedCodexVersion() })
    this.credentialFetchImpl = options.credentialFetchImpl
    this.usageFetchImpl = options.usageFetchImpl ?? fetch
    this.usageUrl = options.usageUrl ?? 'https://chatgpt.com/backend-api/wham/usage'
  }

  async loadProxyAccounts(): Promise<CodexNativeProxyAccount[]> {
    const metadata = (await this.vault.list('codex')).filter((account) => account.enabled)
    const results = await Promise.allSettled(metadata.map(async (account) => {
      const credential = await this.manager(account.id).getCredential()
      await this.ensureCatalog(credential)
      return {
        id: account.id,
        priority: account.priority,
        enabled: account.enabled,
        models: this.catalog.get(account.id)?.models ?? [],
        credential,
      } satisfies CodexNativeProxyAccount
    }))
    return results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  }

  async forceEntitlementRefresh(accountId: string): Promise<{
    accountId: string
    plan?: string
    models: string[]
  }> {
    const account = await this.vault.readAccount<CodexCredentialsFile>(accountId, 'codex')
    if (!account.metadata.enabled) {
      throw new NativeAccountVaultError('invalid', '중지된 Codex 계정은 entitlement를 갱신할 수 없습니다.')
    }
    const credential = await this.manager(accountId).getCredential({ forceRefresh: true })
    const models = await this.catalog.refresh(credential)
    this.credentialFingerprints.set(accountId, this.fingerprint(credential))
    return {
      accountId,
      ...(credential.plan ? { plan: credential.plan } : {}),
      models: models.models,
    }
  }

  async getQuota(accountId: string): Promise<{
    success: boolean
    windows: Array<{
      rateLimitType: string
      label: string
      status: string
      usedPercent: number
      remainingPercent: number
      resetAt: string | null
    }>
    lastUpdated: number
    accountId: string
  }> {
    const credential = await this.manager(accountId).getCredential()
    const response = await this.usageFetchImpl(this.usageUrl, {
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        ...(credential.chatgptAccountId ? { 'chatgpt-account-id': credential.chatgptAccountId } : {}),
        accept: 'application/json',
        originator: 'baton',
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`Codex usage endpoint returned HTTP ${response.status}`)
    const body = await response.json() as Record<string, unknown>
    return {
      success: true,
      windows: codexQuotaWindows(body),
      lastUpdated: Date.now(),
      accountId,
    }
  }

  forget(accountId: string): void {
    this.managers.delete(accountId)
    this.credentialFingerprints.delete(accountId)
    this.catalog.remove(accountId)
  }

  private manager(accountId: string): CodexCredentialManager {
    let manager = this.managers.get(accountId)
    if (!manager) {
      manager = new CodexCredentialManager({
        accountId,
        credentialStore: new CodexVaultCredentialStore(this.vault, accountId),
        ...(this.credentialFetchImpl ? { fetchImpl: this.credentialFetchImpl } : {}),
      })
      this.managers.set(accountId, manager)
    }
    return manager
  }

  private async ensureCatalog(credential: CodexNativeCredential): Promise<void> {
    const fingerprint = this.fingerprint(credential)
    if (
      this.credentialFingerprints.get(credential.accountId) === fingerprint
      && this.catalog.get(credential.accountId)
    ) return
    await this.catalog.refresh(credential)
    this.credentialFingerprints.set(credential.accountId, fingerprint)
  }

  private fingerprint(credential: CodexNativeCredential): string {
    return createHash('sha256').update(credential.accessToken).digest('hex')
  }
}

export const codexNativeRuntime = new CodexNativeRuntime()

function codexQuotaWindows(body: Record<string, unknown>): Array<{
  rateLimitType: string
  label: string
  status: string
  usedPercent: number
  remainingPercent: number
  resetAt: string | null
}> {
  const windows: Array<{
    rateLimitType: string
    label: string
    status: string
    usedPercent: number
    remainingPercent: number
    resetAt: string | null
  }> = []
  const add = (value: unknown, rateLimitType: string, label: string) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const window = value as Record<string, unknown>
    if (typeof window.used_percent !== 'number' || !Number.isFinite(window.used_percent)) return
    const usedPercent = Math.max(0, Math.min(100, window.used_percent))
    const resetSeconds = typeof window.reset_at === 'number' && Number.isFinite(window.reset_at)
      ? window.reset_at
      : undefined
    windows.push({
      rateLimitType,
      label,
      status: usedPercent >= 100 ? 'exhausted' : 'available',
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetAt: resetSeconds === undefined ? null : new Date(resetSeconds * 1_000).toISOString(),
    })
  }
  const rateLimit = body.rate_limit && typeof body.rate_limit === 'object' && !Array.isArray(body.rate_limit)
    ? body.rate_limit as Record<string, unknown>
    : undefined
  add(rateLimit?.primary_window, 'primary', 'Codex primary')
  add(rateLimit?.secondary_window, 'secondary', 'Codex secondary')
  if (Array.isArray(body.additional_rate_limits)) {
    for (const [index, item] of body.additional_rate_limits.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const additional = item as Record<string, unknown>
      const details = additional.rate_limit && typeof additional.rate_limit === 'object'
        ? additional.rate_limit as Record<string, unknown>
        : undefined
      const name = typeof additional.limit_name === 'string' ? additional.limit_name : `additional-${index + 1}`
      add(details?.primary_window, name, name)
    }
  }
  return windows
}
