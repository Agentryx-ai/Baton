import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

export type ClientKind =
  | 'claude-cli'
  | 'claude-desktop'
  | 'unknown-claude'
  | 'codex-cli'
  | 'codex-desktop'
  | 'unknown-codex-desktop'

export type ClientIntegrationTarget = 'claude-cli' | 'claude-desktop' | 'codex'
export type CodexIntegrationMode = 'custom-provider' | 'native-openai'

export interface ClientProcess {
  pid: number
  client: ClientKind
  label: string
  executable: string
}

export interface ClientIntegrationStatus {
  supported: boolean
  certainlyStopped: boolean
  checkedAt: string
  running: ClientProcess[]
  targets: ClientIntegrationTargetStatus[]
  error?: string
}

export interface ClientIntegrationTargetStatus {
  target: ClientIntegrationTarget
  label: string
  certainlyStopped: boolean
  running: ClientProcess[]
  configuration: ClientIntegrationConfigurationState
  configurationDetail?: string
  codexMode?: CodexIntegrationMode
}

export type ClientIntegrationConfigurationState =
  | 'applied'
  | 'not-applied'
  | 'conflict'
  | 'unknown'

export interface ClientIntegrationApplyResult {
  applied: true
  updated: string[]
  restartRequired: true
}

export interface ClientIntegrationRemoveResult {
  removed: true
  updated: string[]
  restartRequired: true
}

interface ProcessRecord {
  ProcessId?: number
  Name?: string
  ExecutablePath?: string | null
  CommandLine?: string | null
}

interface PreparedFile {
  label: string
  target: string
  content: string
  existed: boolean
  temp?: string
  backup?: string
}

interface ClaudeDesktopModel {
  name: string
  anthropicFamilyTier: string
  labelOverride: string
  isFamilyDefault: true
}

export class ClientIntegrationError extends Error {
  public readonly status: number

  constructor(
    status: number,
    message: string,
  ) {
    super(message)
    this.status = status
    this.name = 'ClientIntegrationError'
  }
}

const FAMILY_ORDER = ['opus', 'sonnet', 'haiku', 'fable'] as const
const POWERSHELL = 'powershell.exe'
const DEFAULT_CODEX_MODE: CodexIntegrationMode = 'custom-provider'
export const CODEX_NATIVE_PROXY_PATH = '/baton/inference/openai/v1'
const TARGET_DEFINITIONS: ReadonlyArray<{
  target: ClientIntegrationTarget
  label: string
  clients: readonly ClientKind[]
}> = [
  { target: 'claude-cli', label: 'Claude CLI', clients: ['claude-cli', 'unknown-claude'] },
  { target: 'claude-desktop', label: 'Claude Desktop', clients: ['claude-desktop', 'unknown-claude'] },
  {
    target: 'codex',
    label: 'Codex CLI/Desktop',
    clients: ['codex-cli', 'codex-desktop', 'unknown-codex-desktop'],
  },
]

export function codexNativeProxyBaseUrl(
  port: number = Number(process.env.BATON_PORT ?? 4400),
): string {
  return `http://127.0.0.1:${port}${CODEX_NATIVE_PROXY_PATH}`
}

function executableName(record: ProcessRecord): string {
  return path.win32.basename(record.ExecutablePath ?? record.Name ?? '')
}

/** Pure classifier kept separate so the fail-closed process rules are testable. */
export function classifyProcessRecords(records: ProcessRecord[]): ClientProcess[] {
  const matches: ClientProcess[] = []

  for (const record of records) {
    const pid = Number(record.ProcessId)
    const name = (record.Name ?? '').toLowerCase()
    const evidence = `${record.ExecutablePath ?? ''}\n${record.CommandLine ?? ''}`.toLowerCase()
    let client: ClientKind | null = null
    let label = ''

    if (name === 'claude.exe') {
      if (!evidence.trim()) {
        client = 'unknown-claude'
        label = 'Claude CLI/Desktop 여부 확인 불가'
      } else {
        const desktop = evidence.includes('claude-3p') || evidence.includes('windowsapps\\claude_')
        client = desktop ? 'claude-desktop' : 'claude-cli'
        label = desktop ? 'Claude Desktop' : 'Claude CLI'
      }
    } else if (name === 'codex.exe') {
      if (!evidence.trim()) {
        client = 'unknown-codex-desktop'
        label = 'Codex CLI/Desktop 여부 확인 불가'
      } else {
        const desktop = evidence.includes('openai.codex') || evidence.includes(' app-server')
        client = desktop ? 'codex-desktop' : 'codex-cli'
        label = desktop ? 'Codex Desktop' : 'Codex CLI'
      }
    } else if (name === 'chatgpt.exe') {
      if (evidence.includes('openai.codex')) {
        client = 'codex-desktop'
        label = 'Codex Desktop'
      } else if (!record.ExecutablePath && !record.CommandLine) {
        // We cannot prove this is the separate ChatGPT app, so fail closed.
        client = 'unknown-codex-desktop'
        label = 'Codex Desktop 여부 확인 불가'
      }
    }

    if (client && Number.isInteger(pid) && pid > 0) {
      matches.push({ pid, client, label, executable: executableName(record) })
    }
  }

  return matches.sort((a, b) => a.pid - b.pid || compareText(a.client, b.client))
}

export async function getClientIntegrationStatus(): Promise<ClientIntegrationStatus> {
  const checkedAt = new Date().toISOString()
  if (process.platform !== 'win32') {
    return {
      supported: false,
      certainlyStopped: false,
      checkedAt,
      running: [],
      targets: buildTargetStatuses([], false),
      error: '현재 자동 설정은 Windows에서만 지원합니다.',
    }
  }

  let running: ClientProcess[] = []
  let processError: string | undefined
  try {
    const records = await queryProcessRecords()
    running = classifyProcessRecords(records)
  } catch (error) {
    processError = `프로세스 상태를 확실히 확인하지 못했습니다: ${compactProcessError(error)}`
  }

  let targets = buildTargetStatuses(running, processError === undefined)
  try {
    const proxy = await loadProxyConnection(false)
    const configurations = await inspectTargetConfigurations(proxy.baseUrl, proxy.token)
    targets = targets.map((target) => ({ ...target, ...configurations.get(target.target) }))
  } catch (error) {
    const detail = `실제 설정 상태를 확인하지 못했습니다: ${errorMessage(error)}`
    targets = targets.map((target) => ({
      ...target,
      configuration: 'unknown',
      configurationDetail: detail,
    }))
  }

  return {
    supported: true,
    certainlyStopped: processError === undefined
      && targets.every((target) => target.certainlyStopped),
    checkedAt,
    running,
    targets,
    ...(processError ? { error: processError } : {}),
  }
}

async function queryProcessRecords(): Promise<ProcessRecord[]> {
  const records = await runPowerShell<ProcessRecord[]>(
    String.raw`$items = @(Get-Process -ErrorAction Stop | ForEach-Object {
  $filePath = $null
  try { $filePath = $_.Path } catch {}
  [pscustomobject]@{
    ProcessId = $_.Id
    Name = if ($filePath) { [System.IO.Path]::GetFileName($filePath) } else { "$($_.ProcessName).exe" }
    ExecutablePath = $filePath
    CommandLine = $null
  }
})
[Console]::Out.Write((ConvertTo-Json -InputObject $items -Compress))`,
    null,
  )
  return Array.isArray(records) ? records : []
}

function compactProcessError(error: unknown): string {
  const message = errorMessage(error)
  const line = message
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith('#< CLIXML'))
  return (line ?? '알 수 없는 프로세스 조회 오류').slice(0, 300)
}

export async function applyClientIntegration(
  inputTargets?: unknown,
  inputCodexMode?: unknown,
): Promise<ClientIntegrationApplyResult> {
  const targets = parseIntegrationTargets(inputTargets)
  const codexMode = parseCodexIntegrationMode(inputCodexMode)
  await requireTargetsStopped(targets)

  const needsClaudeModels = targets.includes('claude-desktop')
  const needsCodexEnvironment = targets.includes('codex') && codexMode === 'custom-provider'
  const proxy = await loadProxyConnection(needsClaudeModels)
  await requireConfigurationState(targets, proxy.baseUrl, proxy.token, 'applyable', codexMode)
  const models = needsClaudeModels ? selectClaudeModels(proxy.models) : []
  if (needsClaudeModels && models.length === 0) {
    throw new ClientIntegrationError(502, '프록시 모델 목록에서 Claude 모델을 찾지 못했습니다.')
  }

  const files = await prepareFiles(targets, proxy.baseUrl, proxy.token, models, codexMode)
  await assertFilesUnlocked(files)

  // Close the race window as much as possible: process state is checked again
  // after all parsing/validation and immediately before the first replacement.
  await requireTargetsStopped(targets)

  const previousEnv = needsCodexEnvironment
    ? await getUserEnvironmentVariable('BATON_PROXY_TOKEN')
    : undefined
  const committed: PreparedFile[] = []
  let preserveBackups = false
  try {
    for (const file of files) {
      await commitFile(file)
      committed.push(file)
    }
    if (needsCodexEnvironment) {
      await setUserEnvironmentVariable('BATON_PROXY_TOKEN', proxy.token)
    }
  } catch (error) {
    const rollbackErrors = await rollbackFiles(committed)
    preserveBackups = rollbackErrors.length > 0
    if (previousEnv !== undefined) {
      await setUserEnvironmentVariable('BATON_PROXY_TOKEN', previousEnv).catch(() => {})
    }
    const rollbackSuffix = rollbackErrors.length
      ? ` 롤백 오류: ${rollbackErrors.join('; ')}`
      : ''
    const outcome = rollbackErrors.length
      ? '설정 적용과 일부 파일 롤백에 실패했습니다. .baton-*.bak 파일을 보존했습니다.'
      : '설정을 적용하지 못해 기존 파일로 되돌렸습니다.'
    throw new ClientIntegrationError(500, `${outcome} ${errorMessage(error)}${rollbackSuffix}`)
  } finally {
    await Promise.all(files.map((file) => cleanupPreparedFile(file, !preserveBackups)))
  }

  return {
    applied: true,
    updated: files.map((file) => file.label),
    restartRequired: true,
  }
}

export async function removeClientIntegration(
  inputTargets?: unknown,
): Promise<ClientIntegrationRemoveResult> {
  const targets = parseIntegrationTargets(inputTargets)
  await requireTargetsStopped(targets)

  const proxy = await loadProxyConnection(false)
  const current = await inspectTargetConfigurations(proxy.baseUrl, proxy.token)
  const codexMode = targets.includes('codex')
    ? current.get('codex')?.codexMode ?? DEFAULT_CODEX_MODE
    : DEFAULT_CODEX_MODE
  await requireConfigurationState(targets, proxy.baseUrl, proxy.token, 'applied', codexMode)
  const files = await prepareRemovalFiles(targets, proxy.baseUrl, proxy.token, codexMode)
  await assertFilesUnlocked(files)
  await requireTargetsStopped(targets)

  const removeCodexEnvironment = targets.includes('codex') && codexMode === 'custom-provider'
  const previousEnv = removeCodexEnvironment
    ? await getUserEnvironmentVariable('BATON_PROXY_TOKEN')
    : undefined
  const committed: PreparedFile[] = []
  let preserveBackups = false
  try {
    for (const file of files) {
      await commitFile(file)
      committed.push(file)
    }
    if (removeCodexEnvironment) {
      await setUserEnvironmentVariable('BATON_PROXY_TOKEN', null)
    }
  } catch (error) {
    const rollbackErrors = await rollbackFiles(committed)
    preserveBackups = rollbackErrors.length > 0
    if (previousEnv !== undefined) {
      await setUserEnvironmentVariable('BATON_PROXY_TOKEN', previousEnv).catch(() => {})
    }
    const rollbackSuffix = rollbackErrors.length
      ? ` 롤백 오류: ${rollbackErrors.join('; ')}`
      : ''
    const outcome = rollbackErrors.length
      ? '설정 해제와 일부 파일 롤백에 실패했습니다. .baton-*.bak 파일을 보존했습니다.'
      : '설정을 해제하지 못해 기존 파일로 되돌렸습니다.'
    throw new ClientIntegrationError(500, `${outcome} ${errorMessage(error)}${rollbackSuffix}`)
  } finally {
    await Promise.all(files.map((file) => cleanupPreparedFile(file, !preserveBackups)))
  }

  return {
    removed: true,
    updated: files.map((file) => file.label),
    restartRequired: true,
  }
}

export function parseIntegrationTargets(input: unknown): ClientIntegrationTarget[] {
  if (input === undefined) return TARGET_DEFINITIONS.map((definition) => definition.target)
  if (!Array.isArray(input) || input.length === 0) {
    throw new ClientIntegrationError(400, '적용 대상은 하나 이상 선택해야 합니다.')
  }
  const requested = new Set<ClientIntegrationTarget>()
  for (const value of input) {
    const definition = TARGET_DEFINITIONS.find((item) => item.target === value)
    if (!definition || requested.has(definition.target)) {
      throw new ClientIntegrationError(400, `올바르지 않거나 중복된 적용 대상입니다: ${String(value)}`)
    }
    requested.add(definition.target)
  }
  return TARGET_DEFINITIONS
    .map((definition) => definition.target)
    .filter((target) => requested.has(target))
}

export function parseCodexIntegrationMode(input: unknown): CodexIntegrationMode {
  if (input === undefined) return DEFAULT_CODEX_MODE
  if (input === 'custom-provider' || input === 'native-openai') return input
  throw new ClientIntegrationError(400, `올바르지 않은 Codex 통합 모드입니다: ${String(input)}`)
}

export function blockedProcessesForTargets(
  running: ClientProcess[],
  targets: ClientIntegrationTarget[],
): ClientProcess[] {
  const clientKinds = new Set(
    TARGET_DEFINITIONS
      .filter((definition) => targets.includes(definition.target))
      .flatMap((definition) => definition.clients),
  )
  return running.filter((process) => clientKinds.has(process.client))
}

function buildTargetStatuses(
  running: ClientProcess[],
  processCheckSucceeded: boolean,
): ClientIntegrationTargetStatus[] {
  return TARGET_DEFINITIONS.map((definition) => {
    const targetRunning = running.filter((process) => definition.clients.includes(process.client))
    return {
      target: definition.target,
      label: definition.label,
      certainlyStopped: processCheckSucceeded && targetRunning.length === 0,
      running: targetRunning,
      configuration: 'unknown',
    }
  })
}

async function requireTargetsStopped(targets: ClientIntegrationTarget[]): Promise<void> {
  const status = await getClientIntegrationStatus()
  const blocked = blockedProcessesForTargets(status.running, targets)
  if (status.error || blocked.length > 0) {
    const detail = status.error
      ?? blocked.map((item) => `${item.label} (PID ${item.pid})`).join(', ')
    throw new ClientIntegrationError(
      409,
      `선택한 클라이언트가 모두 종료된 것이 확인되어야 합니다. ${detail}`,
    )
  }
}

export async function loadProxyConnection(includeModels: boolean): Promise<{
  baseUrl: string
  token: string
  models: string[]
}> {
  const { fetchGateway } = await import('./gateway-session.ts')
  const [statusResponse, tokenResponse] = await Promise.all([
    fetchGateway('/api/cliproxy/proxy-status', { method: 'GET' }),
    fetchGateway('/api/settings/auth/tokens/raw', { method: 'GET' }),
  ])
  const status = parseGatewayJson(statusResponse.status, statusResponse.body, '프록시 상태')
  const tokenBody = parseGatewayJson(tokenResponse.status, tokenResponse.body, '프록시 토큰')
  const port = Number(status.port)
  const token = nestedString(tokenBody, ['apiKey', 'value'])

  if (status.running !== true || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ClientIntegrationError(502, '실행 중인 로컬 프록시의 포트를 확인하지 못했습니다.')
  }
  if (!token) {
    throw new ClientIntegrationError(502, '게이트웨이에서 프록시 토큰을 읽지 못했습니다.')
  }

  const baseUrl = `http://127.0.0.1:${port}`
  if (!includeModels) return { baseUrl, token, models: [] }
  let response: Response
  try {
    response = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    })
  } catch (error) {
    throw new ClientIntegrationError(502, `프록시 모델 목록 요청에 실패했습니다: ${errorMessage(error)}`)
  }
  if (!response.ok) {
    throw new ClientIntegrationError(502, `프록시 모델 목록 요청이 HTTP ${response.status}로 실패했습니다.`)
  }
  const body = await response.json() as { data?: Array<{ id?: unknown }> }
  const models = Array.from(new Set(
    (Array.isArray(body.data) ? body.data : [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )).sort(compareText)
  return { baseUrl, token, models }
}

function parseGatewayJson(status: number, body: Buffer, label: string): Record<string, unknown> {
  if (status < 200 || status >= 300) {
    throw new ClientIntegrationError(502, `${label} 조회가 HTTP ${status}로 실패했습니다.`)
  }
  try {
    const parsed = JSON.parse(body.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object expected')
    return parsed as Record<string, unknown>
  } catch {
    throw new ClientIntegrationError(502, `${label} 응답이 올바른 JSON 객체가 아닙니다.`)
  }
}

function nestedString(object: Record<string, unknown>, keys: string[]): string | null {
  let value: unknown = object
  for (const key of keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    value = (value as Record<string, unknown>)[key]
  }
  return typeof value === 'string' && value.length > 0 ? value : null
}

type ConfigurationInspection = Pick<
  ClientIntegrationTargetStatus,
  'configuration' | 'configurationDetail' | 'codexMode'
>

/** Applying is a deterministic repair for partial/stale Baton-owned fields. */
export function canApplyConfiguration(
  state: ClientIntegrationConfigurationState,
): boolean {
  return state === 'not-applied' || state === 'conflict'
}

async function requireConfigurationState(
  targets: ClientIntegrationTarget[],
  baseUrl: string,
  token: string,
  expected: 'applied' | 'applyable',
  codexMode?: CodexIntegrationMode,
): Promise<void> {
  const inspections = await inspectTargetConfigurations(baseUrl, token, codexMode)
  const invalid = targets
    .map((target) => ({ target, inspection: inspections.get(target)! }))
    .filter(({ target, inspection }) => expected === 'applied'
      ? inspection.configuration !== 'applied'
      : codexMode === 'native-openai' && target === 'codex'
        ? inspection.configuration !== 'not-applied'
        : !canApplyConfiguration(inspection.configuration))
  if (invalid.length === 0) return

  const expectedLabel = expected === 'applied' ? '적용된' : '미적용 또는 복구 가능한 충돌'
  const detail = invalid.map(({ target, inspection }) => {
    const label = TARGET_DEFINITIONS.find((item) => item.target === target)?.label ?? target
    return `${label}: ${inspection.configurationDetail ?? inspection.configuration}`
  }).join('; ')
  throw new ClientIntegrationError(
    409,
    `선택 대상이 모두 ${expectedLabel} 상태여야 합니다. ${detail}`,
  )
}

async function inspectTargetConfigurations(
  baseUrl: string,
  token: string,
  codexMode?: CodexIntegrationMode,
): Promise<Map<ClientIntegrationTarget, ConfigurationInspection>> {
  const home = homedir()
  const claudeCli = path.join(home, '.claude', 'settings.json')
  const codex = path.join(home, '.codex', 'config.toml')
  const result = new Map<ClientIntegrationTarget, ConfigurationInspection>()

  const inspect = async (
    target: ClientIntegrationTarget,
    operation: () => Promise<ConfigurationInspection>,
  ) => {
    try {
      result.set(target, await operation())
    } catch (error) {
      result.set(target, {
        configuration: 'unknown',
        configurationDetail: errorMessage(error),
      })
    }
  }

  await Promise.all([
    inspect('claude-cli', async () => {
      const source = await readOptional(claudeCli)
      return source.existed
        ? inspectClaudeCliConfig(source.content, baseUrl, token)
        : { configuration: 'not-applied', configurationDetail: '설정 파일 없음' }
    }),
    inspect('claude-desktop', async () => {
      const file = await findClaudeDesktopConfig()
      const source = await readOptional(file)
      return source.existed
        ? inspectClaudeDesktopConfig(source.content, baseUrl, token)
        : { configuration: 'not-applied', configurationDetail: '설정 파일 없음' }
    }),
    inspect('codex', async () => {
      const source = await readOptional(codex)
      if (!source.existed) {
        return { configuration: 'not-applied', configurationDetail: '설정 파일 없음' }
      }
      const environmentToken = await getUserEnvironmentVariable('BATON_PROXY_TOKEN')
      return inspectCodexIntegration(
        source.content,
        `${baseUrl}/v1`,
        token,
        environmentToken,
        codexNativeProxyBaseUrl(),
        codexMode,
      )
    }),
  ])

  return result
}

function inspectCodexIntegration(
  content: string,
  customBaseUrl: string,
  token: string,
  environmentToken: string | null,
  nativeBaseUrl: string,
  desiredMode?: CodexIntegrationMode,
): ConfigurationInspection {
  const custom = inspectCodexConfig(content, customBaseUrl, token, environmentToken)
  const native = inspectCodexNativeConfig(content, nativeBaseUrl)

  if (desiredMode === 'custom-provider') {
    if (native.configuration === 'applied') {
      return {
        configuration: 'conflict',
        configurationDetail: 'Codex 네이티브 OpenAI 모드가 이미 적용되어 있습니다. 먼저 해제하세요.',
        codexMode: 'native-openai',
      }
    }
    return custom
  }

  if (desiredMode === 'native-openai') {
    if (custom.configuration !== 'not-applied') {
      return {
        configuration: 'conflict',
        configurationDetail: 'Baton custom provider 모드가 남아 있습니다. 먼저 해당 모드를 해제하세요.',
        codexMode: 'custom-provider',
      }
    }
    if (native.configuration !== 'not-applied') return native
    try {
      const parsed = parseToml(content) as Record<string, unknown>
      if (parsed.model_provider !== undefined && parsed.model_provider !== 'openai') {
        return {
          configuration: 'conflict',
          configurationDetail: '기존 model_provider가 openai가 아니어서 네이티브 모드를 적용할 수 없습니다.',
        }
      }
      if (parsed.openai_base_url !== undefined) {
        return {
          configuration: 'conflict',
          configurationDetail: '사용자가 설정한 openai_base_url이 있어 덮어쓰지 않습니다.',
        }
      }
    } catch (error) {
      return { configuration: 'unknown', configurationDetail: `TOML 파싱 실패: ${errorMessage(error)}` }
    }
    return native
  }

  if (native.configuration === 'applied') return native
  if (custom.configuration !== 'not-applied') return custom
  if (native.configuration === 'conflict' && native.codexMode) return native
  return { configuration: 'not-applied' }
}

function inspection(
  ownedValuesPresent: boolean,
  exact: boolean,
  conflictDetail: string,
): ConfigurationInspection {
  if (!ownedValuesPresent) return { configuration: 'not-applied' }
  if (exact) return { configuration: 'applied', configurationDetail: '적용됨' }
  return { configuration: 'conflict', configurationDetail: conflictDetail }
}

export function inspectClaudeCliConfig(
  content: string,
  baseUrl: string,
  token: string,
): ConfigurationInspection {
  const config = parseJsonObject(content, 'Claude CLI 설정')
  const env = config.env
  if (env !== undefined && (!env || typeof env !== 'object' || Array.isArray(env))) {
    return { configuration: 'conflict', configurationDetail: 'env가 객체가 아닙니다.' }
  }
  const values = (env ?? {}) as Record<string, unknown>
  const present = 'ANTHROPIC_BASE_URL' in values || 'ANTHROPIC_AUTH_TOKEN' in values
  return inspection(
    present,
    values.ANTHROPIC_BASE_URL === baseUrl && values.ANTHROPIC_AUTH_TOKEN === token,
    'Baton 소유 항목이 부분 적용되었거나 현재 프록시와 다릅니다.',
  )
}

export function inspectClaudeDesktopConfig(
  content: string,
  baseUrl: string,
  token: string,
): ConfigurationInspection {
  const config = parseJsonObject(content, 'Claude Desktop 설정')
  // `inferenceProvider`/`inferenceModels` can exist in a normal Desktop config.
  // Treat only gateway-specific values as evidence of a Baton application.
  const present = config.inferenceProvider === 'gateway'
    || 'inferenceGatewayBaseUrl' in config
    || 'inferenceGatewayApiKey' in config
  return inspection(
    present,
    config.inferenceProvider === 'gateway'
      && config.inferenceCredentialKind === 'static'
      && config.inferenceGatewayBaseUrl === baseUrl
      && config.inferenceGatewayApiKey === token
      && Array.isArray(config.inferenceModels),
    'Baton 소유 항목이 부분 적용되었거나 현재 프록시와 다릅니다.',
  )
}

export function inspectCodexConfig(
  content: string,
  baseUrl: string,
  token: string,
  environmentToken: string | null,
): ConfigurationInspection {
  let parsed: Record<string, unknown>
  try {
    parsed = parseToml(content) as Record<string, unknown>
  } catch (error) {
    return { configuration: 'unknown', configurationDetail: `TOML 파싱 실패: ${errorMessage(error)}` }
  }
  const providers = parsed.model_providers
  const baton = providers && typeof providers === 'object' && !Array.isArray(providers)
    ? (providers as Record<string, unknown>).baton
    : undefined
  const provider = baton && typeof baton === 'object' && !Array.isArray(baton)
    ? baton as Record<string, unknown>
    : undefined
  const present = parsed.model_provider === 'baton' || provider !== undefined
  const result = inspection(
    present,
    parsed.model_provider === 'baton'
      && provider?.base_url === baseUrl
      && provider?.env_key === 'BATON_PROXY_TOKEN'
      && provider?.wire_api === 'responses'
      && environmentToken === token,
    'Baton provider 항목이 부분 적용되었거나 현재 프록시/토큰과 다릅니다.',
  )
  return present ? { ...result, codexMode: 'custom-provider' } : result
}

export function inspectCodexNativeConfig(
  content: string,
  baseUrl: string,
): ConfigurationInspection {
  let parsed: Record<string, unknown>
  try {
    parsed = parseToml(content) as Record<string, unknown>
  } catch (error) {
    return { configuration: 'unknown', configurationDetail: `TOML 파싱 실패: ${errorMessage(error)}` }
  }

  const configuredBaseUrl = parsed.openai_base_url
  const provider = parsed.model_provider
  if (configuredBaseUrl === baseUrl && (provider === undefined || provider === 'openai')) {
    return {
      configuration: 'applied',
      configurationDetail: '적용됨 · 기존 OpenAI 세션 목록 유지',
      codexMode: 'native-openai',
    }
  }
  if (configuredBaseUrl === baseUrl) {
    return {
      configuration: 'conflict',
      configurationDetail: 'Baton openai_base_url이 있으나 model_provider가 openai가 아닙니다.',
      codexMode: 'native-openai',
    }
  }
  return { configuration: 'not-applied' }
}

/** Select exactly one newest model per supported family, independent of API order. */
export function selectClaudeModels(modelIds: string[]): ClaudeDesktopModel[] {
  const unique = Array.from(new Set(modelIds.filter((id) => id.startsWith('claude-'))))
  return FAMILY_ORDER.flatMap((family) => {
    const candidates = unique.filter((id) => id.includes(`-${family}-`))
    candidates.sort((a, b) => compareModelVersion(b, a) || compareText(a, b))
    const name = candidates[0]
    if (!name) return []
    const version = modelVersion(name).filter((part) => part < 10_000).join('.')
    return [{
      name,
      anthropicFamilyTier: family,
      labelOverride: `${family[0].toUpperCase()}${family.slice(1)}${version ? ` ${version}` : ''}`,
      isFamilyDefault: true as const,
    }]
  })
}

function modelVersion(model: string): number[] {
  const family = FAMILY_ORDER.find((item) => model.includes(`-${item}-`))
  const tail = family ? model.split(`-${family}-`, 2)[1] : model
  return (tail.match(/\d+/g) ?? []).map(Number)
}

function compareModelVersion(a: string, b: string): number {
  const left = modelVersion(a)
  const right = modelVersion(b)
  const count = Math.max(left.length, right.length)
  for (let index = 0; index < count; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

async function prepareFiles(
  targets: ClientIntegrationTarget[],
  baseUrl: string,
  token: string,
  models: ClaudeDesktopModel[],
  codexMode: CodexIntegrationMode,
): Promise<PreparedFile[]> {
  const home = homedir()
  const claudeCli = path.join(home, '.claude', 'settings.json')
  const codex = path.join(home, '.codex', 'config.toml')
  const files: PreparedFile[] = []

  if (targets.includes('claude-cli')) {
    const claudeSource = await readOptional(claudeCli)
    const claudeConfig = parseJsonObject(claudeSource.content || '{}', 'Claude CLI 설정')
    const existingEnv = claudeConfig.env
    if (existingEnv !== undefined && (!existingEnv || typeof existingEnv !== 'object' || Array.isArray(existingEnv))) {
      throw new ClientIntegrationError(422, 'Claude CLI 설정의 env 값이 객체가 아니어서 안전하게 병합할 수 없습니다.')
    }
    claudeConfig.env = {
      ...(existingEnv as Record<string, unknown> | undefined),
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: token,
    }
    const content = `${JSON.stringify(claudeConfig, null, 2)}\n`
    parseJsonObject(content, '변경된 Claude CLI 설정')
    files.push({
      label: 'Claude CLI',
      target: claudeCli,
      content,
      existed: claudeSource.existed,
    })
  }

  if (targets.includes('claude-desktop')) {
    const claudeDesktop = await findClaudeDesktopConfig()
    const desktopSource = await readOptional(claudeDesktop)
    if (!desktopSource.existed) {
      throw new ClientIntegrationError(422, 'Claude Desktop의 적용 대상 설정 파일이 사라졌습니다.')
    }
    const desktopConfig = parseJsonObject(desktopSource.content, 'Claude Desktop 설정')
    desktopConfig.inferenceProvider = 'gateway'
    desktopConfig.inferenceCredentialKind = 'static'
    desktopConfig.inferenceGatewayBaseUrl = baseUrl
    desktopConfig.inferenceGatewayApiKey = token
    desktopConfig.inferenceModels = models
    const content = `${JSON.stringify(desktopConfig, null, 2)}\n`
    parseJsonObject(content, '변경된 Claude Desktop 설정')
    files.push({
      label: 'Claude Desktop',
      target: claudeDesktop,
      content,
      existed: true,
    })
  }

  if (targets.includes('codex')) {
    const codexSource = await readOptional(codex)
    const content = codexMode === 'native-openai'
      ? patchCodexNativeConfig(codexSource.content, codexNativeProxyBaseUrl())
      : patchCodexConfig(codexSource.content, `${baseUrl}/v1`)
    parseToml(content)
    files.push({
      label: 'Codex CLI/Desktop',
      target: codex,
      content,
      existed: codexSource.existed,
    })
  }

  return files
}

async function prepareRemovalFiles(
  targets: ClientIntegrationTarget[],
  baseUrl: string,
  token: string,
  codexMode: CodexIntegrationMode,
): Promise<PreparedFile[]> {
  const home = homedir()
  const claudeCli = path.join(home, '.claude', 'settings.json')
  const codex = path.join(home, '.codex', 'config.toml')
  const files: PreparedFile[] = []

  if (targets.includes('claude-cli')) {
    const source = await readOptional(claudeCli)
    if (!source.existed) throw new ClientIntegrationError(409, 'Claude CLI 설정이 이미 없습니다.')
    files.push({
      label: 'Claude CLI',
      target: claudeCli,
      content: removeClaudeCliConfig(source.content, baseUrl, token),
      existed: true,
    })
  }

  if (targets.includes('claude-desktop')) {
    const file = await findClaudeDesktopConfig()
    const source = await readOptional(file)
    if (!source.existed) throw new ClientIntegrationError(409, 'Claude Desktop 설정이 이미 없습니다.')
    files.push({
      label: 'Claude Desktop',
      target: file,
      content: removeClaudeDesktopConfig(source.content, baseUrl, token),
      existed: true,
    })
  }

  if (targets.includes('codex')) {
    const source = await readOptional(codex)
    if (!source.existed) throw new ClientIntegrationError(409, 'Codex 설정이 이미 없습니다.')
    files.push({
      label: 'Codex CLI/Desktop',
      target: codex,
      content: codexMode === 'native-openai'
        ? unpatchCodexNativeConfig(source.content, codexNativeProxyBaseUrl())
        : unpatchCodexConfig(source.content, `${baseUrl}/v1`),
      existed: true,
    })
  }

  return files
}

export function removeClaudeCliConfig(content: string, baseUrl: string, token: string): string {
  const config = parseJsonObject(content, 'Claude CLI 설정')
  const current = inspectClaudeCliConfig(content, baseUrl, token)
  if (current.configuration !== 'applied') {
    throw new ClientIntegrationError(409, `Claude CLI 설정을 안전하게 해제할 수 없습니다: ${current.configurationDetail ?? current.configuration}`)
  }
  const env = config.env as Record<string, unknown>
  delete env.ANTHROPIC_BASE_URL
  delete env.ANTHROPIC_AUTH_TOKEN
  if (Object.keys(env).length === 0) delete config.env
  const result = `${JSON.stringify(config, null, 2)}\n`
  parseJsonObject(result, '변경된 Claude CLI 설정')
  return result
}

export function removeClaudeDesktopConfig(content: string, baseUrl: string, token: string): string {
  const config = parseJsonObject(content, 'Claude Desktop 설정')
  const current = inspectClaudeDesktopConfig(content, baseUrl, token)
  if (current.configuration !== 'applied') {
    throw new ClientIntegrationError(409, `Claude Desktop 설정을 안전하게 해제할 수 없습니다: ${current.configurationDetail ?? current.configuration}`)
  }
  delete config.inferenceProvider
  delete config.inferenceCredentialKind
  delete config.inferenceGatewayBaseUrl
  delete config.inferenceGatewayApiKey
  delete config.inferenceModels
  const result = `${JSON.stringify(config, null, 2)}\n`
  parseJsonObject(result, '변경된 Claude Desktop 설정')
  return result
}

async function findClaudeDesktopConfig(): Promise<string> {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) {
    throw new ClientIntegrationError(422, 'LOCALAPPDATA를 찾지 못해 Claude Desktop 설정을 확정할 수 없습니다.')
  }
  const directory = path.join(localAppData, 'Claude-3p', 'configLibrary')
  let names: string[]
  try {
    names = (await readdir(directory)).filter((name) => name.toLowerCase().endsWith('.json')).sort(compareText)
  } catch (error) {
    throw new ClientIntegrationError(422, `Claude Desktop 설정 폴더를 읽지 못했습니다: ${errorMessage(error)}`)
  }

  const metaPath = path.join(directory, '_meta.json')
  const metaSource = await readOptional(metaPath)
  if (metaSource.existed) {
    const meta = parseJsonObject(metaSource.content, 'Claude Desktop 메타 설정')
    if (typeof meta.appliedId === 'string' && /^[0-9a-z-]+$/i.test(meta.appliedId)) {
      const expected = `${meta.appliedId}.json`
      if (!names.includes(expected)) {
        throw new ClientIntegrationError(422, `Claude Desktop 활성 설정 ${expected}을 찾지 못했습니다.`)
      }
      return path.join(directory, expected)
    }
  }

  const candidates: string[] = []
  for (const name of names.filter((item) => item !== '_meta.json')) {
    const candidate = path.join(directory, name)
    const parsed = parseJsonObject((await readFile(candidate, 'utf8')), `Claude Desktop 설정 ${name}`)
    if ('inferenceProvider' in parsed || 'inferenceGatewayBaseUrl' in parsed) candidates.push(candidate)
  }
  if (candidates.length !== 1) {
    throw new ClientIntegrationError(
      422,
      `Claude Desktop 적용 대상을 하나로 확정하지 못했습니다(후보 ${candidates.length}개).`,
    )
  }
  return candidates[0]
}

function parseJsonObject(content: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object expected')
    return parsed as Record<string, unknown>
  } catch (error) {
    throw new ClientIntegrationError(422, `${label} JSON을 안전하게 파싱하지 못했습니다: ${errorMessage(error)}`)
  }
}

/**
 * Preserve all unrelated TOML bytes/comments. We only accept Codex's canonical
 * spelling for an existing owned key/table; unusual equivalent spellings fail
 * instead of risking a duplicate or editing the wrong range.
 */
export function patchCodexConfig(content: string, baseUrl: string): string {
  let parsed: Record<string, unknown>
  try {
    parsed = parseToml(content) as Record<string, unknown>
  } catch (error) {
    throw new ClientIntegrationError(422, `Codex 설정 TOML을 안전하게 파싱하지 못했습니다: ${errorMessage(error)}`)
  }

  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const endedWithNewline = content.endsWith('\n')
  const lines = content.length ? content.replace(/\r\n/g, '\n').split('\n') : []
  if (endedWithNewline) lines.pop()

  const firstTable = lines.findIndex((line) => isTableHeader(line))
  const preambleEnd = firstTable === -1 ? lines.length : firstTable
  const rootMatches = lines
    .slice(0, preambleEnd)
    .map((line, index) => canonicalRootModelProvider(line) ? index : -1)
    .filter((index) => index >= 0)
  if ('model_provider' in parsed && rootMatches.length !== 1) {
    throw new ClientIntegrationError(422, 'Codex의 기존 model_provider가 비표준 표기라 안전하게 교체할 수 없습니다.')
  }
  if (rootMatches.length > 1) {
    throw new ClientIntegrationError(422, 'Codex 설정에 model_provider가 중복되어 있습니다.')
  }

  const providers = parsed.model_providers
  const hasBatonProvider = Boolean(
    providers && typeof providers === 'object' && !Array.isArray(providers) && 'baton' in providers,
  )
  const ownedHeaders = lines.filter((line) => isOwnedProviderHeader(line)).length
  if (hasBatonProvider && ownedHeaders === 0) {
    throw new ClientIntegrationError(422, '기존 model_providers.baton이 비표준 표기라 안전하게 교체할 수 없습니다.')
  }

  const output: string[] = []
  let skipOwnedTable = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (index < preambleEnd && canonicalRootModelProvider(line)) {
      output.push('model_provider = "baton"')
      continue
    }
    if (isTableHeader(line)) skipOwnedTable = isOwnedProviderHeader(line)
    if (!skipOwnedTable) output.push(line)
  }

  if (rootMatches.length === 0) {
    const insertion = output.findIndex((line) => isTableHeader(line))
    const at = insertion === -1 ? output.length : insertion
    const prefix = at > 0 && output[at - 1].trim() !== '' ? [''] : []
    output.splice(at, 0, ...prefix, 'model_provider = "baton"', '')
  }

  while (output.length > 0 && output[output.length - 1].trim() === '') output.pop()
  const providerBlock = stringifyToml({
    model_providers: {
      baton: {
        name: 'Baton CLIProxy',
        base_url: baseUrl,
        env_key: 'BATON_PROXY_TOKEN',
        wire_api: 'responses',
      },
    },
  }).trimEnd().split('\n')
  output.push('', ...providerBlock)

  const result = `${output.join(newline)}${newline}`
  const next = parseToml(result) as Record<string, unknown>
  const nextProviders = next.model_providers as Record<string, unknown> | undefined
  const baton = nextProviders?.baton as Record<string, unknown> | undefined
  if (
    next.model_provider !== 'baton'
    || baton?.base_url !== baseUrl
    || baton?.env_key !== 'BATON_PROXY_TOKEN'
    || baton?.wire_api !== 'responses'
  ) {
    throw new ClientIntegrationError(422, '변경된 Codex 설정의 검증 결과가 예상과 다릅니다.')
  }
  return result
}

/**
 * Keep Codex's reserved built-in `openai` provider identity and change only its
 * transport URL. Existing user/provider values are never overwritten.
 */
export function patchCodexNativeConfig(content: string, baseUrl: string): string {
  let parsed: Record<string, unknown>
  try {
    parsed = parseToml(content) as Record<string, unknown>
  } catch (error) {
    throw new ClientIntegrationError(422, `Codex 설정 TOML을 안전하게 파싱하지 못했습니다: ${errorMessage(error)}`)
  }

  if (parsed.model_provider !== undefined && parsed.model_provider !== 'openai') {
    throw new ClientIntegrationError(409, '기존 model_provider가 openai가 아니므로 네이티브 모드를 적용하지 않았습니다.')
  }
  if (parsed.openai_base_url !== undefined && parsed.openai_base_url !== baseUrl) {
    throw new ClientIntegrationError(409, '사용자가 설정한 openai_base_url이 있어 덮어쓰지 않았습니다.')
  }

  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const endedWithNewline = content.endsWith('\n')
  const lines = content.length ? content.replace(/\r\n/g, '\n').split('\n') : []
  if (endedWithNewline) lines.pop()
  const firstTable = lines.findIndex((line) => isTableHeader(line))
  const preambleEnd = firstTable === -1 ? lines.length : firstTable
  const matches = lines
    .slice(0, preambleEnd)
    .filter((line) => canonicalRootOpenAiBaseUrl(line)).length
  if (parsed.openai_base_url !== undefined && matches !== 1) {
    throw new ClientIntegrationError(422, '기존 openai_base_url이 비표준 표기라 안전하게 관리할 수 없습니다.')
  }
  if (matches > 1) {
    throw new ClientIntegrationError(422, 'Codex 설정의 openai_base_url이 중복되어 있습니다.')
  }
  if (matches === 1) return content

  const insertion = firstTable === -1 ? lines.length : firstTable
  const setting = stringifyToml({ openai_base_url: baseUrl }).trimEnd()
  lines.splice(insertion, 0, setting)
  const result = `${lines.join(newline)}${endedWithNewline ? newline : ''}`
  const next = parseToml(result) as Record<string, unknown>
  if (
    next.openai_base_url !== baseUrl
    || (next.model_provider !== undefined && next.model_provider !== 'openai')
  ) {
    throw new ClientIntegrationError(422, '변경된 Codex 네이티브 설정의 검증 결과가 예상과 다릅니다.')
  }
  return result
}

/** Remove only the exact Baton-owned native transport URL. */
export function unpatchCodexNativeConfig(content: string, baseUrl: string): string {
  let parsed: Record<string, unknown>
  try {
    parsed = parseToml(content) as Record<string, unknown>
  } catch (error) {
    throw new ClientIntegrationError(422, `Codex 설정 TOML을 안전하게 파싱하지 못했습니다: ${errorMessage(error)}`)
  }
  if (
    parsed.openai_base_url !== baseUrl
    || (parsed.model_provider !== undefined && parsed.model_provider !== 'openai')
  ) {
    throw new ClientIntegrationError(409, 'Codex 네이티브 Baton 설정이 현재 값과 달라 안전하게 해제할 수 없습니다.')
  }

  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const endedWithNewline = content.endsWith('\n')
  const lines = content.length ? content.replace(/\r\n/g, '\n').split('\n') : []
  if (endedWithNewline) lines.pop()
  const firstTable = lines.findIndex((line) => isTableHeader(line))
  const preambleEnd = firstTable === -1 ? lines.length : firstTable
  const matches = lines
    .slice(0, preambleEnd)
    .filter((line) => canonicalRootOpenAiBaseUrl(line)).length
  if (matches !== 1) {
    throw new ClientIntegrationError(422, 'Codex openai_base_url이 비표준 또는 중복 표기라 안전하게 해제할 수 없습니다.')
  }

  const output = lines.filter((line, index) => (
    index >= preambleEnd || !canonicalRootOpenAiBaseUrl(line)
  ))
  const result = output.length > 0
    ? `${output.join(newline)}${endedWithNewline ? newline : ''}`
    : ''
  const next = parseToml(result) as Record<string, unknown>
  if (next.openai_base_url !== undefined) {
    throw new ClientIntegrationError(422, '해제된 Codex 네이티브 설정의 검증 결과가 예상과 다릅니다.')
  }
  return result
}

/** Remove only Baton's canonical Codex root key and provider table. */
export function unpatchCodexConfig(content: string, baseUrl: string): string {
  let parsed: Record<string, unknown>
  try {
    parsed = parseToml(content) as Record<string, unknown>
  } catch (error) {
    throw new ClientIntegrationError(422, `Codex 설정 TOML을 안전하게 파싱하지 못했습니다: ${errorMessage(error)}`)
  }
  const providers = parsed.model_providers
  const baton = providers && typeof providers === 'object' && !Array.isArray(providers)
    ? (providers as Record<string, unknown>).baton
    : undefined
  const provider = baton && typeof baton === 'object' && !Array.isArray(baton)
    ? baton as Record<string, unknown>
    : undefined
  if (
    parsed.model_provider !== 'baton'
    || provider?.base_url !== baseUrl
    || provider?.env_key !== 'BATON_PROXY_TOKEN'
    || provider?.wire_api !== 'responses'
  ) {
    throw new ClientIntegrationError(409, 'Codex Baton 설정이 부분 적용되었거나 현재 프록시와 달라 안전하게 해제할 수 없습니다.')
  }

  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const endedWithNewline = content.endsWith('\n')
  const lines = content.length ? content.replace(/\r\n/g, '\n').split('\n') : []
  if (endedWithNewline) lines.pop()
  const firstTable = lines.findIndex((line) => isTableHeader(line))
  const preambleEnd = firstTable === -1 ? lines.length : firstTable
  const rootMatches = lines
    .slice(0, preambleEnd)
    .filter((line) => canonicalRootModelProvider(line)).length
  const ownedHeaders = lines.filter((line) => isOwnedProviderHeader(line)).length
  if (rootMatches !== 1 || ownedHeaders === 0) {
    throw new ClientIntegrationError(422, 'Codex Baton 설정이 비표준 표기라 안전하게 해제할 수 없습니다.')
  }

  const output: string[] = []
  let skipOwnedTable = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (index < preambleEnd && canonicalRootModelProvider(line)) continue
    if (isTableHeader(line)) skipOwnedTable = isOwnedProviderHeader(line)
    if (!skipOwnedTable) output.push(line)
  }
  while (output.length > 0 && output[output.length - 1].trim() === '') output.pop()
  const result = output.length > 0 ? `${output.join(newline)}${newline}` : ''
  const next = parseToml(result) as Record<string, unknown>
  const nextProviders = next.model_providers as Record<string, unknown> | undefined
  if (next.model_provider === 'baton' || nextProviders?.baton !== undefined) {
    throw new ClientIntegrationError(422, '해제한 Codex 설정의 검증 결과가 예상과 다릅니다.')
  }
  return result
}

function canonicalRootModelProvider(line: string): boolean {
  return /^\s*model_provider\s*=/.test(line)
}

function canonicalRootOpenAiBaseUrl(line: string): boolean {
  return /^\s*openai_base_url\s*=/.test(line)
}

function isTableHeader(line: string): boolean {
  return /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line)
}

function isOwnedProviderHeader(line: string): boolean {
  return /^\s*\[\s*model_providers\s*\.\s*baton(?:\s*\.[^\]]+)?\s*\]\s*(?:#.*)?$/.test(line)
}

async function assertFilesUnlocked(files: PreparedFile[]): Promise<void> {
  const existing = files.filter((file) => file.existed).map((file) => file.target)
  const results = await runPowerShell<Array<{ path: string; ok: boolean; error?: string }>>(
    String.raw`$inputObject = [Console]::In.ReadToEnd() | ConvertFrom-Json
$results = @($inputObject.paths | ForEach-Object {
  $filePath = [string]$_
  try {
    $stream = [System.IO.File]::Open($filePath, 'Open', 'ReadWrite', 'None')
    $stream.Dispose()
    [pscustomobject]@{ path = $filePath; ok = $true }
  } catch {
    [pscustomobject]@{ path = $filePath; ok = $false; error = $_.Exception.Message }
  }
})
[Console]::Out.Write((ConvertTo-Json -InputObject $results -Compress))`,
    { paths: existing },
  )
  const locked = results.find((result) => !result.ok)
  if (locked) {
    const label = files.find((file) => file.target === locked.path)?.label ?? locked.path
    throw new ClientIntegrationError(
      423,
      `${label} 설정 파일이 잠겨 있습니다. 앱이 꺼져 있어도 잠금이 남아 있으므로 수정하지 않았습니다: ${locked.error ?? '잠금 확인 실패'}`,
    )
  }
}

async function commitFile(file: PreparedFile): Promise<void> {
  await mkdir(path.dirname(file.target), { recursive: true })
  const suffix = `.baton-${randomUUID()}`
  file.temp = `${file.target}${suffix}.tmp`
  file.backup = file.existed ? `${file.target}${suffix}.bak` : undefined
  await writeFile(file.temp, file.content, 'utf8')
  await runPowerShell(
    String.raw`$item = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($item.existed) {
  [System.IO.File]::Replace([string]$item.temp, [string]$item.target, [string]$item.backup, $true)
} else {
  [System.IO.File]::Move([string]$item.temp, [string]$item.target)
}
[Console]::Out.Write('{}')`,
    { target: file.target, temp: file.temp, backup: file.backup, existed: file.existed },
  )
}

async function rollbackFiles(files: PreparedFile[]): Promise<string[]> {
  const errors: string[] = []
  for (const file of [...files].reverse()) {
    try {
      if (file.existed && file.backup) {
        await runPowerShell(
          String.raw`$item = [Console]::In.ReadToEnd() | ConvertFrom-Json
[System.IO.File]::Replace([string]$item.backup, [string]$item.target, $null, $true)
[Console]::Out.Write('{}')`,
          { target: file.target, backup: file.backup },
        )
      } else {
        await rm(file.target, { force: true })
      }
    } catch (error) {
      errors.push(`${file.label}: ${errorMessage(error)}`)
    }
  }
  return errors
}

async function cleanupPreparedFile(file: PreparedFile, removeBackup: boolean): Promise<void> {
  await Promise.all([
    file.temp ? rm(file.temp, { force: true }).catch(() => {}) : Promise.resolve(),
    removeBackup && file.backup
      ? rm(file.backup, { force: true }).catch(() => {})
      : Promise.resolve(),
  ])
}

async function getUserEnvironmentVariable(name: string): Promise<string | null> {
  const result = await runPowerShell<{ exists: boolean; value: string | null }>(
    String.raw`$item = [Console]::In.ReadToEnd() | ConvertFrom-Json
$value = [Environment]::GetEnvironmentVariable([string]$item.name, 'User')
[Console]::Out.Write((ConvertTo-Json -Compress @{ exists = ($null -ne $value); value = $value }))`,
    { name },
  )
  return result.exists ? result.value ?? '' : null
}

async function setUserEnvironmentVariable(name: string, value: string | null): Promise<void> {
  await runPowerShell(
    String.raw`$item = [Console]::In.ReadToEnd() | ConvertFrom-Json
[Environment]::SetEnvironmentVariable([string]$item.name, $item.value, 'User')
try {
  Add-Type -Namespace Baton -Name NativeMethods -MemberDefinition @'
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
      IntPtr hWnd, uint msg, UIntPtr wParam, string lParam,
      uint flags, uint timeout, out UIntPtr result);
'@
  $broadcastResult = [UIntPtr]::Zero
  [Baton.NativeMethods]::SendMessageTimeout(
    [IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 0x0002, 5000,
    [ref]$broadcastResult
  ) | Out-Null
} catch {
  # Registry update already succeeded. The clients are required to be relaunched.
}
[Console]::Out.Write('{}')`,
    { name, value },
  )
}

async function readOptional(file: string): Promise<{ existed: boolean; content: string }> {
  try {
    return { existed: true, content: await readFile(file, 'utf8') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { existed: false, content: '' }
    throw error
  }
}

function runPowerShell<T>(script: string, input: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const encodedScript = Buffer.from(
      `$ErrorActionPreference = 'Stop'\n${script}`,
      'utf16le',
    ).toString('base64')
    const child = spawn(POWERSHELL, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodedScript,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout || `PowerShell exited with ${code}`).trim()))
        return
      }
      try {
        resolve((stdout.trim() ? JSON.parse(stdout) : undefined) as T)
      } catch (error) {
        reject(new Error(`PowerShell 응답 JSON 파싱 실패: ${errorMessage(error)}`))
      }
    })
    child.stdin.end(input === null ? '' : JSON.stringify(input))
  })
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
