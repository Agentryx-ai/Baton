import { homedir } from 'node:os'
import path from 'node:path'

import {
  getClientIntegrationStatus,
  type ClientIntegrationStatus,
} from './client-integration.ts'
import { codexNativeRuntime } from './codex-native-runtime.ts'

export interface BatonRuntimeStatus {
  checkedAt: string
  proxy: {
    running: boolean
    port: number
    version: string
    strategy: 'priority-failover'
    sessionAffinity: false
  }
  codex: {
    integrationMode: 'native-openai' | null
    configuration: string
    modelProvider: 'openai' | 'unknown'
    providerAuth: 'available' | 'missing-or-conflicting' | 'unknown'
    openAiLogin: { kind: 'native-vault' | 'none' | 'unknown'; label: string }
    remotePluginCatalog: { state: 'eligible' | 'unavailable' | 'unknown'; reason: string }
    configuredHome: string
    notice: string
  }
  inferenceAccount: {
    label: string
    observedAt: string | null
    basis: 'native-priority' | 'unavailable'
  } | null
  warnings: string[]
}

let cached: { expiresAt: number; value: BatonRuntimeStatus } | null = null

export async function getCachedBatonRuntimeStatus(): Promise<BatonRuntimeStatus> {
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const value = await getBatonRuntimeStatus()
  cached = { expiresAt: Date.now() + 5_000, value }
  return value
}

export async function getBatonRuntimeStatus(
  dependencies: {
    getClientIntegrationStatus?: () => Promise<ClientIntegrationStatus>
    listCodexAccounts?: () => Promise<Array<{ alias: string; enabled: boolean; priority: number }>>
    now?: () => Date
    codexHome?: () => string
  } = {},
): Promise<BatonRuntimeStatus> {
  const warnings: string[] = []
  const getIntegration = dependencies.getClientIntegrationStatus ?? getClientIntegrationStatus
  const listAccounts = dependencies.listCodexAccounts ?? (() => codexNativeRuntime.vault.list('codex'))
  const [integrationResult, accountsResult] = await Promise.allSettled([getIntegration(), listAccounts()])
  const integration = integrationResult.status === 'fulfilled' ? integrationResult.value : null
  const accounts = accountsResult.status === 'fulfilled' ? accountsResult.value : []
  if (integrationResult.status === 'rejected') warnings.push('Codex 연결 상태를 확인하지 못했습니다.')
  if (accountsResult.status === 'rejected') warnings.push('Native Codex 계정을 확인하지 못했습니다.')
  const codexTarget = integration?.targets.find((target) => target.target === 'codex')
  const active = accounts.filter((account) => account.enabled).sort((a, b) => a.priority - b.priority)[0]
  const hasAccount = accounts.length > 0
  return {
    checkedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    proxy: {
      running: true,
      port: Number(process.env.BATON_PORT ?? 4400),
      version: 'baton-native',
      strategy: 'priority-failover',
      sessionAffinity: false,
    },
    codex: {
      integrationMode: codexTarget?.codexMode ?? null,
      configuration: codexTarget?.configuration ?? 'unknown',
      modelProvider: codexTarget?.codexMode === 'native-openai' ? 'openai' : 'unknown',
      providerAuth: codexTarget?.configuration === 'applied'
        ? 'available'
        : codexTarget?.configuration === 'unknown' ? 'unknown' : 'missing-or-conflicting',
      openAiLogin: hasAccount
        ? { kind: 'native-vault', label: `${accounts.length}개 Native OAuth 계정` }
        : { kind: 'none', label: 'Native OAuth 계정 없음' },
      remotePluginCatalog: hasAccount
        ? { state: 'eligible', reason: 'Baton Native OAuth 계정으로 Codex 원격 플러그인을 인증합니다.' }
        : { state: 'unavailable', reason: 'Baton Native OAuth 계정이 필요합니다.' },
      configuredHome: (dependencies.codexHome ?? (() => process.env.CODEX_HOME || path.join(homedir(), '.codex')))(),
      notice: '모델 라우팅, quota, failover, plugin 인증은 Baton Native 계정 저장소를 함께 사용합니다.',
    },
    inferenceAccount: active
      ? { label: active.alias, observedAt: null, basis: 'native-priority' }
      : null,
    warnings,
  }
}
