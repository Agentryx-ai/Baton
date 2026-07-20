import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'

import {
  CodexJsonlRpcClient,
  resolveCodexInvocation,
  type CodexAppServerProcess,
} from './session/codex-adapter.ts'

export type CodexPluginMarketplaceKind =
  | 'local'
  | 'vertical'
  | 'workspace-directory'
  | 'shared-with-me'
  | 'created-by-me-remote'

export interface CodexPluginSummary {
  id: string
  remotePluginId: string | null
  name: string
  installed: boolean
  enabled: boolean
  installPolicy: 'NOT_AVAILABLE' | 'AVAILABLE' | 'INSTALLED_BY_DEFAULT'
  authPolicy: 'ON_INSTALL' | 'ON_USE'
  availability: 'AVAILABLE' | 'DISABLED_BY_ADMIN'
  displayName: string | null
  shortDescription: string | null
}

export interface CodexPluginMarketplace {
  name: string
  path: string | null
  displayName: string | null
  plugins: CodexPluginSummary[]
}

export interface CodexPluginCatalogSnapshot {
  accountId: string | null
  mode: 'account' | 'local_only'
  fetchedAt: string
  marketplaces: CodexPluginMarketplace[]
  loadErrors: Array<{ path: string; message: string }>
  featuredPluginIds: string[]
}

export interface CodexPluginListInput {
  accountId: string | null
  accessToken?: string
  cwds?: string[]
  marketplaceKinds?: CodexPluginMarketplaceKind[]
}

export interface CodexPluginInstallInput {
  accessToken?: string
  marketplacePath?: string
  remoteMarketplaceName?: string
  pluginName: string
}

export interface CodexPluginInstallResult {
  authPolicy: 'ON_INSTALL' | 'ON_USE'
  appsNeedingAuth: Array<{ id: string; name: string }>
}

export interface CodexPluginControlPlaneOptions {
  executable?: string
  codexHome?: string
  timeoutMs?: number
  invoke?: (input: {
    method: string
    params: unknown
    accessToken?: string
  }) => Promise<unknown>
  now?: () => Date
}

const SECRET_ENV_PREFIXES = ['BATON_', 'GATEWAY_']

export class CodexPluginControlPlaneError extends Error {
  readonly code: 'invalid' | 'authentication' | 'unavailable' | 'protocol'

  constructor(code: CodexPluginControlPlaneError['code'], message: string) {
    super(message)
    this.name = 'CodexPluginControlPlaneError'
    this.code = code
  }
}

export class CodexPluginControlPlane {
  private readonly executable: string
  private readonly codexHome: string
  private readonly timeoutMs: number
  private readonly invokeOverride?: CodexPluginControlPlaneOptions['invoke']
  private readonly now: () => Date

  constructor(options: CodexPluginControlPlaneOptions = {}) {
    this.executable = options.executable ?? (process.platform === 'win32' ? 'codex.cmd' : 'codex')
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(homedir(), '.codex')
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.invokeOverride = options.invoke
    this.now = options.now ?? (() => new Date())
  }

  async list(input: CodexPluginListInput): Promise<CodexPluginCatalogSnapshot> {
    if (input.accountId !== null && !input.accessToken) {
      throw new CodexPluginControlPlaneError('authentication', '플러그인 기준계정 access token이 없습니다.')
    }
    if (input.accessToken) await this.verifyAccessToken(input.accessToken)
    const marketplaceKinds = input.marketplaceKinds ?? (input.accountId === null
      ? ['local']
      : ['local', 'vertical', 'workspace-directory', 'shared-with-me', 'created-by-me-remote'])
    const raw = await this.invoke('plugin/list', {
      cwds: input.cwds ?? [],
      marketplaceKinds,
    }, input.accessToken)
    return normalizeCatalog(raw, input.accountId, this.now().toISOString())
  }

  async install(input: CodexPluginInstallInput): Promise<CodexPluginInstallResult> {
    if ((input.marketplacePath ? 1 : 0) + (input.remoteMarketplaceName ? 1 : 0) !== 1) {
      throw new CodexPluginControlPlaneError(
        'invalid',
        'plugin install은 marketplacePath와 remoteMarketplaceName 중 하나만 요구합니다.',
      )
    }
    if (input.remoteMarketplaceName && !input.accessToken) {
      throw new CodexPluginControlPlaneError('authentication', '원격 plugin 설치에는 플러그인 기준계정이 필요합니다.')
    }
    if (input.remoteMarketplaceName && input.accessToken) {
      await this.verifyAccessToken(input.accessToken)
    }
    const raw = object(await this.invoke('plugin/install', {
      marketplacePath: input.marketplacePath ?? null,
      remoteMarketplaceName: input.remoteMarketplaceName ?? null,
      pluginName: requiredText(input.pluginName, 'pluginName'),
    }, input.accessToken), 'plugin/install response')
    const authPolicy = enumValue(raw.authPolicy, ['ON_INSTALL', 'ON_USE'] as const, 'authPolicy')
    return {
      authPolicy,
      appsNeedingAuth: Array.isArray(raw.appsNeedingAuth)
        ? raw.appsNeedingAuth.flatMap((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return []
          const app = value as Record<string, unknown>
          if (typeof app.id !== 'string' || typeof app.name !== 'string') return []
          return [{ id: app.id, name: app.name }]
        })
        : [],
    }
  }

  async uninstall(pluginId: string, accessToken?: string): Promise<void> {
    if (accessToken) await this.verifyAccessToken(accessToken)
    await this.invoke('plugin/uninstall', { pluginId: requiredText(pluginId, 'pluginId') }, accessToken)
  }

  private async verifyAccessToken(accessToken: string): Promise<void> {
    const raw = object(await this.invoke('account/read', { refreshToken: false }, accessToken), 'account/read response')
    const account = optionalObject(raw.account)
    if (account?.type !== 'chatgpt') {
      throw new CodexPluginControlPlaneError(
        'authentication',
        '선택한 credential을 Codex app-server의 ChatGPT 계정으로 확인하지 못했습니다.',
      )
    }
  }

  private async invoke(method: string, params: unknown, accessToken?: string): Promise<unknown> {
    if (this.invokeOverride) return await this.invokeOverride({ method, params, accessToken })
    return await invokeAppServer({
      executable: this.executable,
      codexHome: this.codexHome,
      timeoutMs: this.timeoutMs,
      method,
      params,
      accessToken,
    })
  }
}

async function invokeAppServer(input: {
  executable: string
  codexHome: string
  timeoutMs: number
  method: string
  params: unknown
  accessToken?: string
}): Promise<unknown> {
  const processHandle = spawnPluginAppServer(input.executable, input.codexHome, input.accessToken)
  const client = new CodexJsonlRpcClient(processHandle)
  try {
    await deadline(client.request('initialize', {
      clientInfo: { name: 'baton-plugin-control', title: 'Baton Plugin Control', version: '0.1.0' },
      capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: false },
    }), input.timeoutMs, 'Codex plugin app-server initialize')
    await client.notify('initialized')
    return await deadline(client.request(input.method, input.params), input.timeoutMs, `Codex ${input.method}`)
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    const code = /auth|required|unauthorized|forbidden|401|403/i.test(text)
      ? 'authentication'
      : /protocol|json-rpc|response/i.test(text)
        ? 'protocol'
        : 'unavailable'
    throw new CodexPluginControlPlaneError(code, `Codex plugin control plane 실패: ${text}`)
  } finally {
    await processHandle.closeInput().catch(() => undefined)
    const exited = await Promise.race([
      processHandle.exited.then(() => true, () => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ])
    if (!exited) await processHandle.kill().catch(() => undefined)
  }
}

function spawnPluginAppServer(
  executable: string,
  codexHome: string,
  accessToken?: string,
): CodexAppServerProcess {
  const args = [
    '--config', 'features.plugins=true',
    '--config', 'features.remote_plugin=true',
    'app-server', '--stdio',
  ]
  const invocation = resolveCodexInvocation(executable, args)
  const environment = codexPluginChildEnvironment()
  environment.CODEX_HOME = codexHome
  if (accessToken) environment.CODEX_ACCESS_TOKEN = accessToken
  const child = spawn(invocation.executable, invocation.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    env: environment,
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr?: string }>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal, stderr: stderr.trim() }))
  })
  return {
    stdout: child.stdout,
    exited,
    write: (line) => new Promise<void>((resolve, reject) => {
      child.stdin.write(line, (error) => error ? reject(error) : resolve())
    }),
    closeInput: () => new Promise<void>((resolve) => child.stdin.end(resolve)),
    kill: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill()
    },
  }
}

export function codexPluginChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name]) => (
    name !== 'OPENAI_API_KEY'
    && name !== 'CODEX_API_KEY'
    && name !== 'CODEX_ACCESS_TOKEN'
    && !SECRET_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  )))
}

async function deadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function normalizeCatalog(raw: unknown, accountId: string | null, fetchedAt: string): CodexPluginCatalogSnapshot {
  const response = object(raw, 'plugin/list response')
  if (!Array.isArray(response.marketplaces)) {
    throw new CodexPluginControlPlaneError('protocol', 'plugin/list response에 marketplaces가 없습니다.')
  }
  return {
    accountId,
    mode: accountId === null ? 'local_only' : 'account',
    fetchedAt,
    marketplaces: response.marketplaces.map(normalizeMarketplace),
    loadErrors: Array.isArray(response.marketplaceLoadErrors)
      ? response.marketplaceLoadErrors.flatMap((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return []
        const error = value as Record<string, unknown>
        return typeof error.marketplacePath === 'string' && typeof error.message === 'string'
          ? [{ path: error.marketplacePath, message: error.message }]
          : []
      })
      : [],
    featuredPluginIds: Array.isArray(response.featuredPluginIds)
      ? response.featuredPluginIds.filter((value): value is string => typeof value === 'string')
      : [],
  }
}

function normalizeMarketplace(value: unknown): CodexPluginMarketplace {
  const marketplace = object(value, 'plugin marketplace')
  if (!Array.isArray(marketplace.plugins)) {
    throw new CodexPluginControlPlaneError('protocol', 'plugin marketplace에 plugins가 없습니다.')
  }
  const interfaceValue = optionalObject(marketplace.interface)
  return {
    name: requiredText(marketplace.name, 'marketplace.name'),
    path: typeof marketplace.path === 'string' ? marketplace.path : null,
    displayName: typeof interfaceValue?.displayName === 'string' ? interfaceValue.displayName : null,
    plugins: marketplace.plugins.map(normalizePlugin),
  }
}

function normalizePlugin(value: unknown): CodexPluginSummary {
  const plugin = object(value, 'plugin summary')
  const interfaceValue = optionalObject(plugin.interface)
  return {
    id: requiredText(plugin.id, 'plugin.id'),
    remotePluginId: typeof plugin.remotePluginId === 'string' ? plugin.remotePluginId : null,
    name: requiredText(plugin.name, 'plugin.name'),
    installed: plugin.installed === true,
    enabled: plugin.enabled === true,
    installPolicy: enumValue(plugin.installPolicy, ['NOT_AVAILABLE', 'AVAILABLE', 'INSTALLED_BY_DEFAULT'] as const, 'installPolicy'),
    authPolicy: enumValue(plugin.authPolicy, ['ON_INSTALL', 'ON_USE'] as const, 'authPolicy'),
    availability: enumValue(plugin.availability ?? 'AVAILABLE', ['AVAILABLE', 'DISABLED_BY_ADMIN'] as const, 'availability'),
    displayName: typeof interfaceValue?.displayName === 'string' ? interfaceValue.displayName : null,
    shortDescription: typeof interfaceValue?.shortDescription === 'string' ? interfaceValue.shortDescription : null,
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CodexPluginControlPlaneError('protocol', `${label} 형식이 올바르지 않습니다.`)
  }
  return value as Record<string, unknown>
}

function optionalObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CodexPluginControlPlaneError('invalid', `${label} 값이 없습니다.`)
  }
  return value.trim()
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new CodexPluginControlPlaneError('protocol', `${label} 값이 올바르지 않습니다.`)
  }
  return value as T[number]
}
