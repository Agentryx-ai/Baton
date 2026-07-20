import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'

import {
  getClientIntegrationStatus,
  type ClientIntegrationStatus,
} from './client-integration.ts'
import { fetchGateway } from './gateway-session.ts'

export type CodexLoginKind =
  | 'chatgpt'
  | 'api-key'
  | 'access-token'
  | 'personal-access-token'
  | 'none'
  | 'unknown'

export interface BatonRuntimeStatus {
  checkedAt: string
  proxy: {
    running: boolean | null
    port: number | null
    version: string | null
    strategy: string | null
    sessionAffinity: boolean | null
  }
  codex: {
    integrationMode: 'custom-provider' | 'native-openai' | null
    configuration: string
    modelProvider: 'baton' | 'openai' | 'unknown'
    providerAuth: 'available' | 'missing-or-conflicting' | 'unknown'
    openAiLogin: {
      kind: CodexLoginKind
      label: string
    }
    remotePluginCatalog: {
      state: 'eligible' | 'unavailable' | 'unknown'
      reason: string
    }
    configuredHome: string
    notice: string
  }
  inferenceAccount: {
    label: string
    observedAt: string | null
    basis: 'most-recent-last-used' | 'unavailable'
  } | null
  warnings: string[]
}

interface GatewayResult {
  status: number
  body: Buffer
}

interface BatonStatusDependencies {
  getClientIntegrationStatus: () => Promise<ClientIntegrationStatus>
  fetchGateway: (path: string, init: { method: string }) => Promise<GatewayResult>
  inspectCodexLogin: () => Promise<{ kind: CodexLoginKind, label: string }>
  codexHome: () => string
  now: () => Date
}

const defaultDependencies: BatonStatusDependencies = {
  getClientIntegrationStatus,
  fetchGateway,
  inspectCodexLogin,
  codexHome: () => process.env.CODEX_HOME || path.join(homedir(), '.codex'),
  now: () => new Date(),
}

let cached: { expiresAt: number, value: BatonRuntimeStatus } | null = null

export async function getCachedBatonRuntimeStatus(): Promise<BatonRuntimeStatus> {
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const value = await getBatonRuntimeStatus()
  cached = { expiresAt: Date.now() + 5_000, value }
  return value
}

export async function getBatonRuntimeStatus(
  dependencies: BatonStatusDependencies = defaultDependencies,
): Promise<BatonRuntimeStatus> {
  const warnings: string[] = []
  const [integrationResult, loginResult, proxyResult, strategyResult, affinityResult, accountsResult]
    = await Promise.allSettled([
      dependencies.getClientIntegrationStatus(),
      dependencies.inspectCodexLogin(),
      readGatewayJson(dependencies.fetchGateway, '/api/cliproxy/proxy-status'),
      readGatewayJson(dependencies.fetchGateway, '/api/cliproxy/routing/strategy'),
      readGatewayJson(dependencies.fetchGateway, '/api/cliproxy/routing/session-affinity'),
      readGatewayJson(dependencies.fetchGateway, '/api/cliproxy/auth/accounts/codex'),
    ])

  const integration = settledValue(integrationResult, 'Codex 연결 상태', warnings)
  const login = settledValue(loginResult, 'Codex 로그인 상태', warnings)
    ?? { kind: 'unknown' as const, label: '확인하지 못함' }
  const proxy = settledValue(proxyResult, '프록시 상태', warnings)
  const strategy = settledValue(strategyResult, '라우팅 전략', warnings)
  const affinity = settledValue(affinityResult, '세션 고정 설정', warnings)
  const accounts = settledValue(accountsResult, 'Codex 계정 목록', warnings)

  const codexTarget = integration?.targets.find((target) => target.target === 'codex')
  const integrationMode = codexTarget?.codexMode ?? null
  const modelProvider = integrationMode === 'custom-provider'
    ? 'baton'
    : integrationMode === 'native-openai'
      ? 'openai'
      : 'unknown'
  const providerAuth = codexTarget?.configuration === 'applied'
    ? 'available'
    : codexTarget?.configuration === 'not-applied' || codexTarget?.configuration === 'conflict'
      ? 'missing-or-conflicting'
      : 'unknown'
  const remotePluginCatalog = pluginCatalogStatus(login.kind)
  const notice = integrationMode === 'custom-provider'
    ? 'Baton 모델 호출은 BATON_PROXY_TOKEN으로 인증됩니다. `codex login status`는 별도로 저장된 OpenAI/ChatGPT 로그인만 확인하므로 모델 호출이 정상이어도 Not logged in을 표시할 수 있습니다.'
    : 'OpenAI/ChatGPT 로그인과 Baton의 실제 업스트림 계정 선택은 서로 다른 상태입니다.'

  return {
    checkedAt: dependencies.now().toISOString(),
    proxy: {
      running: booleanValue(proxy?.running),
      port: integerValue(proxy?.port),
      version: stringValue(proxy?.version),
      strategy: stringValue(strategy?.strategy),
      sessionAffinity: booleanValue(affinity?.enabled),
    },
    codex: {
      integrationMode,
      configuration: codexTarget?.configuration ?? 'unknown',
      modelProvider,
      providerAuth,
      openAiLogin: login,
      remotePluginCatalog,
      configuredHome: dependencies.codexHome(),
      notice,
    },
    inferenceAccount: mostRecentlyUsedAccount(accounts),
    warnings,
  }
}

async function readGatewayJson(
  gatewayFetch: BatonStatusDependencies['fetchGateway'],
  requestPath: string,
): Promise<Record<string, unknown>> {
  const response = await gatewayFetch(requestPath, { method: 'GET' })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}`)
  }
  const parsed = JSON.parse(response.body.toString('utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON object expected')
  }
  return parsed as Record<string, unknown>
}

function settledValue<T>(
  result: PromiseSettledResult<T>,
  label: string,
  warnings: string[],
): T | null {
  if (result.status === 'fulfilled') return result.value
  warnings.push(`${label} 확인 실패: ${errorMessage(result.reason)}`)
  return null
}

function pluginCatalogStatus(kind: CodexLoginKind): BatonRuntimeStatus['codex']['remotePluginCatalog'] {
  if (kind === 'none') {
    return {
      state: 'unavailable',
      reason: 'OpenAI/ChatGPT 로그인이 없어 계정별 원격 플러그인 카탈로그를 사용할 수 없습니다. 로컬·번들 플러그인은 별개입니다.',
    }
  }
  if (kind === 'api-key') {
    return {
      state: 'unavailable',
      reason: 'API key 로그인은 ChatGPT 계정별 원격 플러그인 카탈로그 인증으로 지원되지 않습니다.',
    }
  }
  if (kind === 'unknown') {
    return { state: 'unknown', reason: 'Codex 로그인 상태를 확인하지 못했습니다.' }
  }
  return {
    state: 'eligible',
    reason: 'ChatGPT 계정 인증이 있습니다. 실제 사용 가능 범위는 계정과 워크스페이스 권한에 따릅니다.',
  }
}

function mostRecentlyUsedAccount(
  body: Record<string, unknown> | null,
): BatonRuntimeStatus['inferenceAccount'] {
  const accounts = Array.isArray(body?.accounts) ? body.accounts : []
  const candidates = accounts
    .filter((account): account is Record<string, unknown> => (
      !!account && typeof account === 'object' && !Array.isArray(account)
    ))
    .map((account) => ({
      label: stringValue(account.nickname)
        || stringValue(account.email)
        || '이름 없는 Codex 계정',
      observedAt: stringValue(account.lastUsedAt),
    }))
    .filter((account) => account.observedAt !== null && Number.isFinite(Date.parse(account.observedAt)))
    .sort((left, right) => Date.parse(right.observedAt!) - Date.parse(left.observedAt!))
  const latest = candidates[0]
  return latest
    ? { ...latest, basis: 'most-recent-last-used' }
    : null
}

function inspectCodexLogin(): Promise<{ kind: CodexLoginKind, label: string }> {
  const executable = process.platform === 'win32' ? 'cmd.exe' : 'codex'
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'codex login status']
    : ['login', 'status']

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const append = (chunk: Buffer) => {
      if (output.length < 8_192) output += chunk.toString('utf8')
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', reject)
    const timeout = setTimeout(() => child.kill(), 5_000)
    child.once('close', () => {
      clearTimeout(timeout)
      resolve(parseCodexLoginStatus(output))
    })
  })
}

export function parseCodexLoginStatus(output: string): { kind: CodexLoginKind, label: string } {
  if (/Logged in using ChatGPT/i.test(output)) return { kind: 'chatgpt', label: 'ChatGPT 로그인됨' }
  if (/Logged in using an API key/i.test(output)) return { kind: 'api-key', label: 'OpenAI API key 로그인됨' }
  if (/Logged in using access token/i.test(output)) return { kind: 'access-token', label: 'ChatGPT access token 로그인됨' }
  if (/Logged in using personal access token/i.test(output)) {
    return { kind: 'personal-access-token', label: 'ChatGPT personal access token 로그인됨' }
  }
  if (/Not logged in/i.test(output)) return { kind: 'none', label: 'OpenAI/ChatGPT 로그인 없음' }
  return { kind: 'unknown', label: '확인하지 못함' }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function integerValue(value: unknown): number | null {
  const number = Number(value)
  return Number.isInteger(number) ? number : null
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
