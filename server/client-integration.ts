import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  readFile,
  readdir,
} from 'node:fs/promises'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import {
  loadNativeClaudeProxyConnection,
  type NativeClaudeProxyConnection,
} from './claude-native-runtime.ts'
import {
  applyRecoveryMutation,
  removeRecoveryIntegration,
  RecoveryError,
  type RecoveryFormat,
} from './client-integration-recovery.ts'
import {
  assertBootstrapReady,
  assertBootstrapUnchanged,
  withBootstrapLock,
} from './bootstrap-contract.ts'

export type ClientKind =
  | 'claude-cli'
  | 'claude-desktop'
  | 'unknown-claude'
  | 'codex-cli'
  | 'codex-desktop'
  | 'unknown-codex-desktop'

export type ClientIntegrationTarget = 'claude-cli' | 'claude-desktop' | 'codex'
export type CodexIntegrationMode = 'native-openai'
export type ClaudeProxyMode = 'native'

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
  repairable?: boolean
  codexMode?: CodexIntegrationMode
  claudeProxyMode?: ClaudeProxyMode
}

export type ClientIntegrationConfigurationState =
  | 'applied'
  | 'not-applied'
  | 'conflict'
  | 'unknown'

export interface ClientIntegrationApplyResult {
  applied: boolean
  updated: string[]
  restartRequired: boolean
  results: ClientIntegrationTargetResult[]
}

export interface ClientIntegrationRemoveResult {
  removed: boolean
  updated: string[]
  restartRequired: boolean
  results: ClientIntegrationTargetResult[]
}

export interface ClientIntegrationTargetResult {
  target: ClientIntegrationTarget
  label: string
  ok: boolean
  error?: string
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
  integrationTarget: ClientIntegrationTarget
  originalContent: string
  format: RecoveryFormat
  ownedFields: string[][]
  endpoint: string
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
const DEFAULT_CODEX_MODE: CodexIntegrationMode = 'native-openai'
const DEFAULT_CLAUDE_PROXY_MODE: ClaudeProxyMode = 'native'
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

interface ProxyConnection {
  baseUrl: string
  token: string
  models: string[]
}

function asProxyConnection(connection: NativeClaudeProxyConnection): ProxyConnection {
  return connection
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
      if (evidence.includes('app-server --stdio') && evidence.includes('baton-model-catalog.json')) {
        continue
      }
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
    const configurations = await inspectTargetConfigurations(
      asProxyConnection(await loadNativeClaudeProxyConnection(false)),
    )
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
  inputClaudeProxyMode?: unknown,
): Promise<ClientIntegrationApplyResult> {
  const targets = parseIntegrationTargets(inputTargets)
  parseCodexIntegrationMode(inputCodexMode)
  parseClaudeProxyMode(inputClaudeProxyMode)
  return withBootstrapLock(async () => {
    // Hold the same OS lock used by installer activation from validation until
    // every global mutation and its post-integrity check have settled.
    const verified = await assertBootstrapReady({
      allowUnsignedDevelopment: process.env.BATON_ALLOW_UNSIGNED_BOOTSTRAP === '1',
      approvedSignerThumbprint: process.env.BATON_APPROVED_SIGNER_THUMBPRINT,
    })
    const result = await applyClientIntegrationLocked(targets)
    try {
      await assertBootstrapUnchanged(verified)
    } catch (error) {
      for (const item of result.results.filter((candidate) => candidate.ok)) {
        await removeRecoveryIntegration(item.target).catch(() => {})
      }
      throw error
    }
    return result
  })
}

async function applyClientIntegrationLocked(
  targets: ClientIntegrationTarget[],
): Promise<ClientIntegrationApplyResult> {
  const needsClaudeModels = targets.includes('claude-desktop')
  let claudeConnectionPromise: Promise<ProxyConnection> | undefined
  const loadClaudeConnection = () => {
    claudeConnectionPromise ??= loadNativeClaudeProxyConnection(needsClaudeModels).then(asProxyConnection)
    return claudeConnectionPromise
  }
  const results = await runClientIntegrationTargetOperations(targets, async (target) => {
    await requireTargetsStopped([target])
    const claudeConnection = target === 'codex' ? null : await loadClaudeConnection()
    await requireConfigurationState([target], claudeConnection, 'applyable')
    const models = target === 'claude-desktop' ? selectClaudeModels(claudeConnection?.models ?? []) : []
    if (target === 'claude-desktop' && models.length === 0) {
      throw new ClientIntegrationError(502, '프록시 모델 목록에서 Claude 모델을 찾지 못했습니다.')
    }
    const files = await prepareFiles([target], claudeConnection, models)
    await assertFilesUnlocked(files)
    await requireTargetsStopped([target])
    for (const file of files) {
      await applyRecoveryMutation({
        target: file.integrationTarget,
        label: file.label,
        filePath: file.target,
        format: file.format,
        ownedFields: file.ownedFields,
        endpoint: file.endpoint,
        beforeExisted: file.existed,
        beforeContent: file.originalContent,
        appliedContent: file.content,
      })
    }
  })
  const updated = results.filter((item) => item.ok).map((item) => item.label)
  return {
    applied: results.every((item) => item.ok),
    updated,
    restartRequired: updated.length > 0,
    results,
  }
}

export async function removeClientIntegration(
  inputTargets?: unknown,
): Promise<ClientIntegrationRemoveResult> {
  const targets = parseIntegrationTargets(inputTargets)
  const results = await runClientIntegrationTargetOperations(targets, async (target) => {
    await requireTargetsStopped([target])
    await removeRecoveryIntegration(target)
  })
  const updated = results.filter((item) => item.ok).map((item) => item.label)
  return {
    removed: results.every((item) => item.ok),
    updated,
    restartRequired: updated.length > 0,
    results,
  }
}

export async function runClientIntegrationTargetOperations(
  targets: ClientIntegrationTarget[],
  operation: (target: ClientIntegrationTarget) => Promise<void>,
): Promise<ClientIntegrationTargetResult[]> {
  const results: ClientIntegrationTargetResult[] = []
  for (const target of targets) {
    const label = targetLabel(target)
    try {
      await operation(target)
      results.push({ target, label, ok: true })
    } catch (error) {
      results.push({ target, label, ok: false, error: safeOperationError(error) })
    }
  }
  return results
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
  if (input === 'native-openai') return input
  throw new ClientIntegrationError(400, `올바르지 않은 Codex 통합 모드입니다: ${String(input)}`)
}

export function parseClaudeProxyMode(input: unknown): ClaudeProxyMode {
  if (input === undefined) return DEFAULT_CLAUDE_PROXY_MODE
  if (input === 'native') return input
  throw new ClientIntegrationError(400, `올바르지 않은 Claude 프록시 모드입니다: ${String(input)}`)
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

type ConfigurationInspection = Pick<
  ClientIntegrationTargetStatus,
  'configuration' | 'configurationDetail' | 'repairable' | 'codexMode' | 'claudeProxyMode'
>

/** Only absent settings and explicitly classified Baton-owned repairs are applyable. */
export function canApplyConfiguration(
  target: ClientIntegrationTarget,
  inspection: Pick<ClientIntegrationTargetStatus, 'configuration' | 'repairable'>,
): boolean {
  return inspection.configuration === 'not-applied'
    || (target === 'codex'
      && inspection.configuration === 'conflict'
      && inspection.repairable === true)
}

async function requireConfigurationState(
  targets: ClientIntegrationTarget[],
  claudeConnection: ProxyConnection | null,
  expected: 'applied' | 'applyable',
): Promise<void> {
  const inspections = await inspectTargetConfigurations(claudeConnection)
  const invalid = targets
    .map((target) => ({ target, inspection: inspections.get(target)! }))
    .filter(({ target, inspection }) => expected === 'applied'
      ? inspection.configuration !== 'applied'
      : !canApplyConfiguration(target, inspection))
  if (invalid.length === 0) return

  const expectedLabel = expected === 'applied' ? '적용된' : '미적용'
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
  claudeConnection: ProxyConnection | null,
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
      if (!claudeConnection) {
        return { configuration: 'unknown', configurationDetail: 'Claude 프록시 연결을 확인하지 못했습니다.' }
      }
      const source = await readOptional(claudeCli)
      return source.existed
        ? inspectClaudeCliConfig(
          source.content,
          claudeConnection.baseUrl,
          null,
        )
        : { configuration: 'not-applied', configurationDetail: '설정 파일 없음' }
    }),
    inspect('claude-desktop', async () => {
      if (!claudeConnection) {
        return { configuration: 'unknown', configurationDetail: 'Claude 프록시 연결을 확인하지 못했습니다.' }
      }
      const file = await findClaudeDesktopConfig()
      const source = await readOptional(file)
      return source.existed
        ? inspectClaudeDesktopConfig(source.content, claudeConnection.baseUrl, claudeConnection.token)
        : { configuration: 'not-applied', configurationDetail: '설정 파일 없음' }
    }),
    inspect('codex', async () => {
      const source = await readOptional(codex)
      if (!source.existed) {
        return { configuration: 'not-applied', configurationDetail: '설정 파일 없음' }
      }
      return { ...inspectCodexNativeConfig(source.content, codexNativeProxyBaseUrl()), codexMode: 'native-openai' }
    }),
  ])

  for (const target of ['claude-cli', 'claude-desktop'] as const) {
    const value = result.get(target)
    if (value) result.set(target, { ...value, claudeProxyMode: 'native' })
  }

  return result
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
  token: string | null,
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
    values.ANTHROPIC_BASE_URL === baseUrl
      && (token === null
        ? !('ANTHROPIC_AUTH_TOKEN' in values)
        : values.ANTHROPIC_AUTH_TOKEN === token),
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

export function patchClaudeCliConfig(content: string, baseUrl: string, token: string | null): string {
  const config = parseJsonObject(content || '{}', 'Claude CLI 설정')
  const existingEnv = config.env
  if (existingEnv !== undefined && (!existingEnv || typeof existingEnv !== 'object' || Array.isArray(existingEnv))) {
    throw new ClientIntegrationError(422, 'Claude CLI 설정의 env 값이 객체가 아니어서 안전하게 병합할 수 없습니다.')
  }
  const values = (existingEnv ?? {}) as Record<string, unknown>
  if ('ANTHROPIC_BASE_URL' in values || 'ANTHROPIC_AUTH_TOKEN' in values) {
    throw new ClientIntegrationError(409, 'Claude CLI의 기존 Anthropic 연결 항목을 덮어쓰지 않았습니다.')
  }
  const nextEnv: Record<string, unknown> = {
    ...(existingEnv as Record<string, unknown> | undefined),
    ANTHROPIC_BASE_URL: baseUrl,
  }
  if (token === null) delete nextEnv.ANTHROPIC_AUTH_TOKEN
  else nextEnv.ANTHROPIC_AUTH_TOKEN = token
  config.env = nextEnv
  const result = `${JSON.stringify(config, null, 2)}\n`
  parseJsonObject(result, '변경된 Claude CLI 설정')
  return result
}

export function patchClaudeDesktopConfig(
  content: string,
  baseUrl: string,
  token: string,
  models: ClaudeDesktopModel[],
): string {
  const config = parseJsonObject(content, 'Claude Desktop 설정')
  if (
    config.inferenceProvider === 'gateway'
    || 'inferenceGatewayBaseUrl' in config
    || 'inferenceGatewayApiKey' in config
  ) {
    throw new ClientIntegrationError(409, 'Claude Desktop의 기존 gateway 연결 항목을 덮어쓰지 않았습니다.')
  }
  config.inferenceProvider = 'gateway'
  config.inferenceCredentialKind = 'static'
  config.inferenceGatewayBaseUrl = baseUrl
  config.inferenceGatewayApiKey = token
  config.inferenceModels = models
  const result = `${JSON.stringify(config, null, 2)}\n`
  parseJsonObject(result, '변경된 Claude Desktop 설정')
  return result
}

export function inspectCodexNativeConfig(
  content: string,
  baseUrl: string,
): ConfigurationInspection {
  let parsed: Record<string, unknown>
  try {
    parsed = parseToml(content) as Record<string, unknown>
  } catch {
    return { configuration: 'unknown', configurationDetail: 'Codex TOML 설정 문법이 올바르지 않습니다.' }
  }

  const configuredBaseUrl = parsed.openai_base_url
  const provider = parsed.model_provider
  const batonProvider = codexProvider(parsed, 'baton')
  const managedCompat = isManagedBatonCompatProvider(batonProvider, baseUrl)
  const migratesLegacyBaton = isMigratableLegacyBatonProvider(batonProvider, baseUrl)
  if (
    configuredBaseUrl === baseUrl
    && (provider === undefined || provider === 'openai')
    && managedCompat
  ) {
    return {
      configuration: 'applied',
      configurationDetail: '적용됨 · OpenAI identity 및 기존 Baton 세션 resume 호환 유지',
      codexMode: 'native-openai',
    }
  }
  if (configuredBaseUrl === baseUrl) {
    const repairable = isRepairableCodexNativeConfig(content, baseUrl)
    return {
      configuration: 'conflict',
      configurationDetail: provider !== undefined && provider !== 'openai'
        ? 'Baton openai_base_url이 있으나 model_provider가 openai가 아닙니다.'
        : 'Baton openai_base_url이 있으나 기존 Baton 세션 resume 호환 provider가 없습니다.',
      ...(repairable ? { repairable: true } : {}),
      codexMode: 'native-openai',
    }
  }
  if (
    configuredBaseUrl === undefined
    && provider === 'baton'
    && migratesLegacyBaton
  ) {
    const repairable = isRepairableCodexNativeConfig(content, baseUrl)
    return {
      configuration: 'conflict',
      configurationDetail: '기존 Baton provider를 Native resume 호환 설정으로 복구해야 합니다.',
      ...(repairable ? { repairable: true } : {}),
      codexMode: 'native-openai',
    }
  }
  if (configuredBaseUrl !== undefined || batonProvider !== undefined || provider === 'baton') {
    return {
      configuration: 'conflict',
      configurationDetail: '기존 provider 또는 openai_base_url이 있어 기본 적용으로 덮어쓰지 않습니다.',
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
  claudeConnection: ProxyConnection | null,
  models: ClaudeDesktopModel[],
): Promise<PreparedFile[]> {
  const home = homedir()
  const claudeCli = path.join(home, '.claude', 'settings.json')
  const codex = path.join(home, '.codex', 'config.toml')
  const files: PreparedFile[] = []

  if (targets.includes('claude-cli')) {
    if (!claudeConnection) throw new ClientIntegrationError(502, 'Claude 프록시 연결이 없습니다.')
    const claudeSource = await readOptional(claudeCli)
    const content = patchClaudeCliConfig(
      claudeSource.content,
      claudeConnection.baseUrl,
      null,
    )
    files.push({
      label: 'Claude CLI',
      target: claudeCli,
      content,
      existed: claudeSource.existed,
      integrationTarget: 'claude-cli',
      originalContent: claudeSource.content,
      format: 'json',
      ownedFields: [['env', 'ANTHROPIC_BASE_URL'], ['env', 'ANTHROPIC_AUTH_TOKEN']],
      endpoint: claudeConnection.baseUrl,
    })
  }

  if (targets.includes('claude-desktop')) {
    if (!claudeConnection) throw new ClientIntegrationError(502, 'Claude 프록시 연결이 없습니다.')
    const claudeDesktop = await findClaudeDesktopConfig()
    const desktopSource = await readOptional(claudeDesktop)
    if (!desktopSource.existed) {
      throw new ClientIntegrationError(422, 'Claude Desktop의 적용 대상 설정 파일이 사라졌습니다.')
    }
    const content = patchClaudeDesktopConfig(
      desktopSource.content,
      claudeConnection.baseUrl,
      claudeConnection.token,
      models,
    )
    files.push({
      label: 'Claude Desktop',
      target: claudeDesktop,
      content,
      existed: true,
      integrationTarget: 'claude-desktop',
      originalContent: desktopSource.content,
      format: 'json',
      ownedFields: [
        ['inferenceProvider'], ['inferenceCredentialKind'], ['inferenceGatewayBaseUrl'],
        ['inferenceGatewayApiKey'], ['inferenceModels'],
      ],
      endpoint: claudeConnection.baseUrl,
    })
  }

  if (targets.includes('codex')) {
    const codexSource = await readOptional(codex)
    const content = patchCodexNativeConfig(codexSource.content, codexNativeProxyBaseUrl())
    parseToml(content)
    files.push({
      label: 'Codex CLI/Desktop',
      target: codex,
      content,
      existed: codexSource.existed,
      integrationTarget: 'codex',
      originalContent: codexSource.content,
      format: 'toml',
      ownedFields: [['openai_base_url'], ['model_providers', 'baton']],
      endpoint: codexNativeProxyBaseUrl(),
    })
  }

  return files
}

export function removeClaudeCliConfig(content: string, baseUrl: string, token: string | null): string {
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
  } catch {
    throw new ClientIntegrationError(422, `${label} JSON 문법이 올바르지 않습니다.`)
  }
}

/**
 * Keep Codex's reserved built-in `openai` provider identity, change its
 * transport URL, and retain a Baton-owned alias for resuming legacy threads
 * whose session metadata pins `model_provider = "baton"`.
 */
export function patchCodexNativeConfig(content: string, baseUrl: string): string {
  let parsed: Record<string, unknown>
  try {
    parsed = parseToml(content) as Record<string, unknown>
  } catch {
    throw new ClientIntegrationError(422, 'Codex 설정 TOML 문법이 올바르지 않습니다.')
  }

  const batonProvider = codexProvider(parsed, 'baton')
  const managedCompat = isManagedBatonCompatProvider(batonProvider, baseUrl)
  const migratesLegacyBaton = isMigratableLegacyBatonProvider(batonProvider, baseUrl)
  if (batonProvider !== undefined && !managedCompat && !migratesLegacyBaton) {
    throw new ClientIntegrationError(409, '사용자가 정의한 model_providers.baton이 있어 Baton Native 설정을 적용하지 않았습니다.')
  }
  if (
    parsed.model_provider !== undefined
    && parsed.model_provider !== 'openai'
    && !(parsed.model_provider === 'baton' && (managedCompat || migratesLegacyBaton))
  ) {
    throw new ClientIntegrationError(409, '사용자가 지정한 model_provider가 있어 Baton Native 설정을 적용하지 않았습니다.')
  }
  if (parsed.openai_base_url !== undefined && parsed.openai_base_url !== baseUrl) {
    throw new ClientIntegrationError(409, '사용자가 설정한 openai_base_url이 있어 덮어쓰지 않았습니다.')
  }

  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const endedWithNewline = content.endsWith('\n')
  const lines = content.length ? content.replace(/\r\n/g, '\n').split('\n') : []
  if (endedWithNewline) lines.pop()
  const legacyRootMatches = lines.filter((line) => canonicalRootModelProvider(line)).length
  const legacyTableMatches = lines.filter((line) => isOwnedProviderHeader(line)).length
  if (
    parsed.model_provider === 'baton'
    && (legacyRootMatches !== 1 || legacyTableMatches < 1)
  ) {
    throw new ClientIntegrationError(422, '기존 Baton provider가 비표준 표기라 안전하게 Native 설정으로 이전할 수 없습니다.')
  }
  const migratedLines: string[] = []
  let skipLegacyTable = false
  for (const line of lines) {
    if (parsed.model_provider === 'baton' && canonicalRootModelProvider(line)) continue
    if (isTableHeader(line)) skipLegacyTable = (managedCompat || migratesLegacyBaton) && isOwnedProviderHeader(line)
    if (!skipLegacyTable) migratedLines.push(line)
  }
  lines.splice(0, lines.length, ...migratedLines)
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
  if (matches === 1 && managedCompat && parsed.model_provider !== 'baton') return content

  if (matches === 0) {
    const insertion = firstTable === -1 ? lines.length : firstTable
    const setting = stringifyToml({ openai_base_url: baseUrl }).trimEnd()
    lines.splice(insertion, 0, setting)
  }
  while (lines.length > 0 && lines.at(-1) === '') lines.pop()
  if (lines.length > 0) lines.push('')
  lines.push(...managedBatonCompatProviderLines(baseUrl))
  const result = `${lines.join(newline)}${endedWithNewline ? newline : ''}`
  const next = parseToml(result) as Record<string, unknown>
  if (
    next.openai_base_url !== baseUrl
    || (next.model_provider !== undefined && next.model_provider !== 'openai')
    || !isManagedBatonCompatProvider(codexProvider(next, 'baton'), baseUrl)
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
  } catch {
    throw new ClientIntegrationError(422, 'Codex 설정 TOML 문법이 올바르지 않습니다.')
  }
  if (
    parsed.openai_base_url !== baseUrl
    || (parsed.model_provider !== undefined && parsed.model_provider !== 'openai')
    || !isManagedBatonCompatProvider(codexProvider(parsed, 'baton'), baseUrl)
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

  const output: string[] = []
  let skipCompatTable = false
  for (const [index, line] of lines.entries()) {
    if (isTableHeader(line)) skipCompatTable = isOwnedProviderHeader(line)
    if (skipCompatTable || (index < preambleEnd && canonicalRootOpenAiBaseUrl(line))) continue
    output.push(line)
  }
  while (output.length > 0 && output.at(-1) === '') output.pop()
  const result = output.length > 0
    ? `${output.join(newline)}${endedWithNewline ? newline : ''}`
    : ''
  const next = parseToml(result) as Record<string, unknown>
  if (next.openai_base_url !== undefined || codexProvider(next, 'baton') !== undefined) {
    throw new ClientIntegrationError(422, '해제된 Codex 네이티브 설정의 검증 결과가 예상과 다릅니다.')
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

function codexProvider(parsed: Record<string, unknown>, id: string): Record<string, unknown> | undefined {
  const providers = parsed.model_providers
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return undefined
  const provider = (providers as Record<string, unknown>)[id]
  return provider && typeof provider === 'object' && !Array.isArray(provider)
    ? provider as Record<string, unknown>
    : undefined
}

function isManagedBatonCompatProvider(
  provider: Record<string, unknown> | undefined,
  baseUrl: string,
): boolean {
  return hasExactKeys(provider, [
    'name', 'base_url', 'wire_api', 'request_max_retries', 'stream_max_retries',
  ])
    && provider?.name === 'Baton Native (resume compatibility)'
    && provider.base_url === baseUrl
    && provider.wire_api === 'responses'
    && provider.request_max_retries === 0
    && provider.stream_max_retries === 0
}

function isMigratableLegacyBatonProvider(
  provider: Record<string, unknown> | undefined,
  baseUrl: string,
): boolean {
  if (!hasExactKeys(provider, ['name', 'base_url', 'env_key', 'wire_api'])) return false
  return (provider?.name === 'Baton CLIProxy'
      || (provider?.name === 'Baton Native' && provider.base_url === baseUrl))
    && provider.env_key === 'BATON_PROXY_TOKEN'
    && provider.wire_api === 'responses'
    && typeof provider.base_url === 'string'
}

function hasExactKeys(
  value: Record<string, unknown> | undefined,
  expected: readonly string[],
): boolean {
  if (!value) return false
  const keys = Object.keys(value).sort()
  return keys.length === expected.length
    && [...expected].sort().every((key, index) => keys[index] === key)
}

function isRepairableCodexNativeConfig(content: string, baseUrl: string): boolean {
  try {
    return patchCodexNativeConfig(content, baseUrl) !== content
  } catch {
    return false
  }
}

function managedBatonCompatProviderLines(baseUrl: string): string[] {
  return stringifyToml({
    model_providers: {
      baton: {
        name: 'Baton Native (resume compatibility)',
        base_url: baseUrl,
        wire_api: 'responses',
        request_max_retries: 0,
        stream_max_retries: 0,
      },
    },
  }).trimEnd().split('\n')
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

function targetLabel(target: ClientIntegrationTarget): string {
  return TARGET_DEFINITIONS.find((item) => item.target === target)?.label ?? target
}

function safeOperationError(error: unknown): string {
  if (error instanceof ClientIntegrationError || error instanceof RecoveryError) return error.message
  return '예상하지 못한 로컬 설정 오류가 발생했습니다.'
}
