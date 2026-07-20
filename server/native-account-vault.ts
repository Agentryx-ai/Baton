import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export type NativeAccountProvider = 'claude' | 'codex'

export interface NativeAccountMetadata {
  id: string
  provider: NativeAccountProvider
  alias: string
  priority: number
  enabled: boolean
  revision: number
  createdAt: string
  updatedAt: string
}

interface PersistedNativeAccount extends NativeAccountMetadata {
  sealedCredential: string
}

interface PersistedVault {
  version: 1
  accounts: PersistedNativeAccount[]
}

export interface NativeAccountSecretProtector {
  seal(plaintext: string): Promise<string>
  open(sealed: string): Promise<string>
}

export interface NativeAccountVaultOptions {
  vaultPath?: string
  protector?: NativeAccountSecretProtector
  now?: () => Date
  createId?: () => string
}

export interface AddNativeAccountInput {
  provider: NativeAccountProvider
  alias: string
  priority?: number
  enabled?: boolean
  credential: unknown
}

export interface NativeAccountRecord<T = unknown> {
  metadata: NativeAccountMetadata
  credential: T
}

export interface UpdateNativeAccountInput {
  alias?: string
  priority?: number
  enabled?: boolean
  expectedRevision: number
}

const DPAPI_PREFIX = 'dpapi:v1:'
const DPAPI_ENTROPY = Buffer.from('Baton Native Account Vault v1', 'utf8').toString('base64')
const MAX_POWERSHELL_OUTPUT = 2 * 1024 * 1024

export class NativeAccountVaultError extends Error {
  readonly code: 'unsupported' | 'invalid' | 'not_found' | 'conflict' | 'unavailable'

  constructor(code: NativeAccountVaultError['code'], message: string) {
    super(message)
    this.name = 'NativeAccountVaultError'
    this.code = code
  }
}

export function defaultNativeAccountVaultPath(): string {
  return path.join(homedir(), '.baton', 'native-accounts.v1.json')
}

function encodedPowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

async function runPowerShellWithInput(script: string, input: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_POWERSHELL_OUTPUT) {
        child.kill()
        reject(new NativeAccountVaultError('unavailable', 'OS credential 보호 응답이 제한을 초과했습니다.'))
        return
      }
      target.push(chunk)
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.once('error', () => {
      reject(new NativeAccountVaultError('unavailable', 'Windows credential 보호 기능을 시작하지 못했습니다.'))
    })
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new NativeAccountVaultError('unavailable', 'Windows credential 보호 기능이 실패했습니다.'))
        return
      }
      resolve(Buffer.concat(stdout).toString('utf8').trim())
    })
    child.stdin.end(input, 'utf8')
  })
}

export class WindowsDpapiSecretProtector implements NativeAccountSecretProtector {
  async seal(plaintext: string): Promise<string> {
    if (process.platform !== 'win32') {
      throw new NativeAccountVaultError('unsupported', 'Windows DPAPI는 현재 플랫폼에서 사용할 수 없습니다.')
    }
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$entropy = [Convert]::FromBase64String('${DPAPI_ENTROPY}')
$sealed = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($sealed))
`
    const sealed = await runPowerShellWithInput(script, plaintext)
    if (!sealed) throw new NativeAccountVaultError('unavailable', 'Windows DPAPI가 빈 결과를 반환했습니다.')
    return `${DPAPI_PREFIX}${sealed}`
  }

  async open(sealed: string): Promise<string> {
    if (process.platform !== 'win32') {
      throw new NativeAccountVaultError('unsupported', 'Windows DPAPI는 현재 플랫폼에서 사용할 수 없습니다.')
    }
    if (!sealed.startsWith(DPAPI_PREFIX)) {
      throw new NativeAccountVaultError('invalid', '지원하지 않는 credential 봉인 형식입니다.')
    }
    const payload = sealed.slice(DPAPI_PREFIX.length)
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$sealed = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$entropy = [Convert]::FromBase64String('${DPAPI_ENTROPY}')
$plain = [Security.Cryptography.ProtectedData]::Unprotect($sealed, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
`
    return await runPowerShellWithInput(script, payload)
  }
}

function validateProvider(value: unknown): asserts value is NativeAccountProvider {
  if (value !== 'claude' && value !== 'codex') {
    throw new NativeAccountVaultError('invalid', '지원하지 않는 native account provider입니다.')
  }
}

function validateAlias(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 80) {
    throw new NativeAccountVaultError('invalid', '계정 별칭은 1~80자여야 합니다.')
  }
}

function validatePriority(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new NativeAccountVaultError('invalid', '계정 우선순위는 0 이상의 정수여야 합니다.')
  }
}

function publicMetadata(account: PersistedNativeAccount): NativeAccountMetadata {
  const { sealedCredential: _sealedCredential, ...metadata } = account
  return metadata
}

function compareAccounts(left: NativeAccountMetadata, right: NativeAccountMetadata): number {
  return left.priority - right.priority
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id)
}

function parseVault(raw: string): PersistedVault {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new NativeAccountVaultError('invalid', 'Native account vault가 올바른 JSON이 아닙니다.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NativeAccountVaultError('invalid', 'Native account vault 형식이 올바르지 않습니다.')
  }
  const candidate = parsed as Partial<PersistedVault>
  if (candidate.version !== 1 || !Array.isArray(candidate.accounts)) {
    throw new NativeAccountVaultError('invalid', '지원하지 않는 Native account vault 버전입니다.')
  }
  for (const account of candidate.accounts) {
    if (!account || typeof account !== 'object' || Array.isArray(account)) {
      throw new NativeAccountVaultError('invalid', 'Native account 항목 형식이 올바르지 않습니다.')
    }
    const item = account as Partial<PersistedNativeAccount>
    validateProvider(item.provider)
    validateAlias(item.alias)
    validatePriority(item.priority)
    if (
      typeof item.id !== 'string' || item.id.length === 0
      || typeof item.enabled !== 'boolean'
      || !Number.isSafeInteger(item.revision) || Number(item.revision) < 1
      || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))
      || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt))
      || typeof item.sealedCredential !== 'string' || item.sealedCredential.length === 0
    ) {
      throw new NativeAccountVaultError('invalid', 'Native account 항목에 필수 값이 없습니다.')
    }
  }
  const ids = new Set(candidate.accounts.map((account) => account.id))
  if (ids.size !== candidate.accounts.length) {
    throw new NativeAccountVaultError('invalid', 'Native account vault에 중복 ID가 있습니다.')
  }
  return candidate as PersistedVault
}

export class NativeAccountVault {
  private readonly vaultPath: string
  private readonly protector: NativeAccountSecretProtector
  private readonly now: () => Date
  private readonly createId: () => string
  private pendingMutation: Promise<void> = Promise.resolve()

  constructor(options: NativeAccountVaultOptions = {}) {
    this.vaultPath = options.vaultPath ?? defaultNativeAccountVaultPath()
    this.protector = options.protector ?? new WindowsDpapiSecretProtector()
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID
  }

  async list(provider?: NativeAccountProvider): Promise<NativeAccountMetadata[]> {
    if (provider !== undefined) validateProvider(provider)
    const vault = await this.load()
    return vault.accounts
      .filter((account) => provider === undefined || account.provider === provider)
      .map(publicMetadata)
      .sort(compareAccounts)
  }

  async add(input: AddNativeAccountInput): Promise<NativeAccountMetadata> {
    validateProvider(input.provider)
    validateAlias(input.alias)
    const priority = input.priority ?? 100
    validatePriority(priority)
    const credential = JSON.stringify(input.credential)
    if (credential === undefined) {
      throw new NativeAccountVaultError('invalid', '저장할 OAuth credential이 없습니다.')
    }
    const sealedCredential = await this.protector.seal(credential)
    let added: NativeAccountMetadata | undefined
    await this.mutate((vault) => {
      const timestamp = this.now().toISOString()
      const account: PersistedNativeAccount = {
        id: this.createId(),
        provider: input.provider,
        alias: input.alias.trim(),
        priority,
        enabled: input.enabled ?? true,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        sealedCredential,
      }
      if (vault.accounts.some((item) => item.id === account.id)) {
        throw new NativeAccountVaultError('conflict', '생성된 native account ID가 이미 존재합니다.')
      }
      vault.accounts.push(account)
      added = publicMetadata(account)
    })
    if (!added) throw new NativeAccountVaultError('unavailable', 'Native account를 저장하지 못했습니다.')
    return added
  }

  async readCredential<T>(id: string, provider?: NativeAccountProvider): Promise<T> {
    return (await this.readAccount<T>(id, provider)).credential
  }

  async readAccount<T>(id: string, provider?: NativeAccountProvider): Promise<NativeAccountRecord<T>> {
    const vault = await this.load()
    const account = vault.accounts.find((item) => item.id === id && (provider === undefined || item.provider === provider))
    if (!account) throw new NativeAccountVaultError('not_found', 'Native account를 찾지 못했습니다.')
    let parsed: unknown
    try {
      parsed = JSON.parse(await this.protector.open(account.sealedCredential))
    } catch (error) {
      if (error instanceof NativeAccountVaultError) throw error
      throw new NativeAccountVaultError('invalid', '봉인된 OAuth credential을 읽지 못했습니다.')
    }
    return { metadata: publicMetadata(account), credential: parsed as T }
  }

  async replaceCredential(
    id: string,
    credential: unknown,
    expectedRevision: number,
  ): Promise<NativeAccountMetadata> {
    const serialized = JSON.stringify(credential)
    if (serialized === undefined) throw new NativeAccountVaultError('invalid', '저장할 OAuth credential이 없습니다.')
    const sealedCredential = await this.protector.seal(serialized)
    let updated: NativeAccountMetadata | undefined
    await this.mutate((vault) => {
      const account = this.requireAccount(vault, id, expectedRevision)
      account.sealedCredential = sealedCredential
      account.revision += 1
      account.updatedAt = this.now().toISOString()
      updated = publicMetadata(account)
    })
    if (!updated) throw new NativeAccountVaultError('unavailable', 'Native account credential을 갱신하지 못했습니다.')
    return updated
  }

  async update(id: string, input: UpdateNativeAccountInput): Promise<NativeAccountMetadata> {
    if (input.alias !== undefined) validateAlias(input.alias)
    if (input.priority !== undefined) validatePriority(input.priority)
    let updated: NativeAccountMetadata | undefined
    await this.mutate((vault) => {
      const account = this.requireAccount(vault, id, input.expectedRevision)
      if (input.alias !== undefined) account.alias = input.alias.trim()
      if (input.priority !== undefined) account.priority = input.priority
      if (input.enabled !== undefined) account.enabled = input.enabled
      account.revision += 1
      account.updatedAt = this.now().toISOString()
      updated = publicMetadata(account)
    })
    if (!updated) throw new NativeAccountVaultError('unavailable', 'Native account를 갱신하지 못했습니다.')
    return updated
  }

  async remove(id: string, expectedRevision: number): Promise<void> {
    await this.mutate((vault) => {
      const account = this.requireAccount(vault, id, expectedRevision)
      vault.accounts.splice(vault.accounts.indexOf(account), 1)
    })
  }

  private requireAccount(vault: PersistedVault, id: string, expectedRevision: number): PersistedNativeAccount {
    const account = vault.accounts.find((item) => item.id === id)
    if (!account) throw new NativeAccountVaultError('not_found', 'Native account를 찾지 못했습니다.')
    if (account.revision !== expectedRevision) {
      throw new NativeAccountVaultError('conflict', 'Native account가 다른 작업에서 변경되었습니다.')
    }
    return account
  }

  private async load(): Promise<PersistedVault> {
    try {
      return parseVault(await readFile(this.vaultPath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, accounts: [] }
      throw error
    }
  }

  private async mutate(change: (vault: PersistedVault) => void): Promise<void> {
    let resolveOperation!: () => void
    let rejectOperation!: (error: unknown) => void
    const operation = new Promise<void>((resolve, reject) => {
      resolveOperation = resolve
      rejectOperation = reject
    })
    const previous = this.pendingMutation
    this.pendingMutation = operation.catch(() => undefined)
    await previous
    try {
      const vault = await this.load()
      change(vault)
      await this.save(vault)
      resolveOperation()
    } catch (error) {
      rejectOperation(error)
      throw error
    }
  }

  private async save(vault: PersistedVault): Promise<void> {
    const directory = path.dirname(this.vaultPath)
    await mkdir(directory, { recursive: true })
    const temporary = `${this.vaultPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(temporary, `${JSON.stringify(vault, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.vaultPath)
    await chmod(this.vaultPath, 0o600).catch(() => undefined)
  }
}
