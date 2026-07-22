import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface ClaudeNativeAccountSecret {
  accessToken: string
  refreshToken: string
  expiresAt?: number
  refreshTokenExpiresAt?: number
  scopes: string[]
}

export interface ClaudeNativeAccount {
  id: string
  nickname: string
  accountId?: string
  email?: string
  priority: number
  enabled: boolean
  createdAt: string
  updatedAt: string
  source: 'oauth' | 'claude-code'
}

export interface ClaudeNativeAccountInput {
  id?: string
  nickname: string
  accountId?: string
  email?: string
  priority?: number
  enabled?: boolean
  source?: 'oauth' | 'claude-code'
  secret: ClaudeNativeAccountSecret
}

export interface ClaudeNativeSecretProtector {
  protect(plaintext: string): Promise<string>
  unprotect(ciphertext: string): Promise<string>
}

interface StoredAccount extends ClaudeNativeAccount {
  protectedSecret: string
}

interface VaultFile {
  version: 1
  accounts: StoredAccount[]
  legacyImportCompleted?: boolean
}

export interface ClaudeNativeAccountVaultOptions {
  filePath: string
  protector: ClaudeNativeSecretProtector
  now?: () => number
  createId?: () => string
}

export interface ClaudeStableIdentityDuplicate {
  accountId: string
  accountIds: string[]
}

export interface ClaudeStableIdentityRepairResult {
  applied: boolean
  duplicates: ClaudeStableIdentityDuplicate[]
  removedAccountIds: string[]
  backupPath: string | null
}

export class ClaudeNativeAccountVaultError extends Error {
  readonly code: 'invalid' | 'not_found' | 'unavailable'

  constructor(
    code: 'invalid' | 'not_found' | 'unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'ClaudeNativeAccountVaultError'
    this.code = code
  }
}

export class ClaudeNativeAccountVault {
  private readonly filePath: string
  private readonly protector: ClaudeNativeSecretProtector
  private readonly now: () => number
  private readonly createId: () => string
  private pendingMutation: Promise<void> = Promise.resolve()

  constructor(options: ClaudeNativeAccountVaultOptions) {
    this.filePath = options.filePath
    this.protector = options.protector
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
  }

  async list(): Promise<ClaudeNativeAccount[]> {
    const file = await this.read()
    return file.accounts
      .map(({ protectedSecret: _protectedSecret, ...account }) => account)
      .sort((left, right) => left.priority - right.priority || left.createdAt.localeCompare(right.createdAt))
  }

  async getSecret(id: string): Promise<ClaudeNativeAccountSecret> {
    const file = await this.read()
    const account = file.accounts.find((candidate) => candidate.id === id)
    if (!account) throw new ClaudeNativeAccountVaultError('not_found', 'Claude 계정을 찾지 못했습니다.')
    let plaintext: string
    try {
      plaintext = await this.protector.unprotect(account.protectedSecret)
    } catch {
      throw new ClaudeNativeAccountVaultError('unavailable', 'Claude 계정 자격증명을 복호화하지 못했습니다.')
    }
    return parseSecret(plaintext)
  }

  async put(input: ClaudeNativeAccountInput): Promise<ClaudeNativeAccount> {
    validateInput(input)
    return this.mutate(async (file) => {
      const now = new Date(this.now()).toISOString()
      const explicit = input.id ? file.accounts.find((account) => account.id === input.id) : undefined
      if (input.id && !explicit) {
        throw new ClaudeNativeAccountVaultError('not_found', '수정할 Claude 계정을 찾지 못했습니다.')
      }
      const stableIdentity = input.accountId?.trim()
      const stableMatches = stableIdentity
        ? file.accounts.filter((account) => account.accountId === stableIdentity)
        : []
      if (stableMatches.length > 1) {
        throw new ClaudeNativeAccountVaultError(
          'invalid',
          `Claude stable identity ${stableIdentity}가 여러 vault 계정에 연결되어 있습니다. 명시적으로 복구하세요.`,
        )
      }
      if (explicit && stableMatches[0] && stableMatches[0].id !== explicit.id) {
        throw new ClaudeNativeAccountVaultError(
          'invalid',
          `Claude 불변 계정 식별자 ${stableIdentity}는 다른 vault 계정이 소유합니다.`,
        )
      }
      const existing = explicit ?? stableMatches[0]
      const protectedSecret = await this.protector.protect(JSON.stringify(input.secret))
      const accountId = stableIdentity ?? existing?.accountId
      const email = input.email === undefined ? existing?.email : input.email.trim()
      const account: StoredAccount = {
        id: existing?.id ?? this.createId(),
        nickname: input.nickname.trim(),
        ...(accountId ? { accountId } : {}),
        ...(email ? { email } : {}),
        priority: input.priority ?? existing?.priority ?? nextPriority(file.accounts),
        enabled: input.enabled ?? existing?.enabled ?? true,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        source: input.source ?? existing?.source ?? 'oauth',
        protectedSecret,
      }
      if (existing) file.accounts[file.accounts.indexOf(existing)] = account
      else file.accounts.push(account)
      const { protectedSecret: _protectedSecret, ...publicAccount } = account
      return publicAccount
    })
  }

  async repairStableIdentityDuplicates(input: {
    apply?: boolean
    keepByAccountId?: Record<string, string>
  } = {}): Promise<ClaudeStableIdentityRepairResult> {
    const previous = this.pendingMutation
    let release!: () => void
    this.pendingMutation = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      const file = await this.read()
      const grouped = new Map<string, StoredAccount[]>()
      for (const account of file.accounts) {
        if (!account.accountId) continue
        const group = grouped.get(account.accountId) ?? []
        group.push(account)
        grouped.set(account.accountId, group)
      }
      const duplicates = [...grouped.entries()]
        .filter(([, accounts]) => accounts.length > 1)
        .map(([accountId, accounts]) => ({ accountId, accountIds: accounts.map((account) => account.id) }))
        .sort((left, right) => left.accountId.localeCompare(right.accountId))
      if (input.apply !== true) {
        return { applied: false, duplicates, removedAccountIds: [], backupPath: null }
      }

      const keepByAccountId = input.keepByAccountId ?? {}
      const keepIds = new Set<string>()
      for (const duplicate of duplicates) {
        const keepId = keepByAccountId[duplicate.accountId]
        if (!keepId || !duplicate.accountIds.includes(keepId)) {
          throw new ClaudeNativeAccountVaultError(
            'invalid',
            `중복 stable identity ${duplicate.accountId}에서 유지할 계정 id를 명시하세요 (explicit keep id required).`,
          )
        }
        keepIds.add(keepId)
      }
      if (duplicates.length === 0) {
        return { applied: true, duplicates, removedAccountIds: [], backupPath: null }
      }

      const duplicateIds = new Set(duplicates.flatMap((duplicate) => duplicate.accountIds))
      const removedAccountIds = file.accounts
        .filter((account) => duplicateIds.has(account.id) && !keepIds.has(account.id))
        .map((account) => account.id)
      const backupPath = `${this.filePath}.backup-${this.now()}`
      try {
        await copyFile(this.filePath, backupPath, constants.COPYFILE_EXCL)
      } catch {
        throw new ClaudeNativeAccountVaultError('unavailable', 'Claude 계정 vault 백업을 만들지 못해 복구를 중단했습니다.')
      }
      file.accounts = file.accounts.filter((account) => !removedAccountIds.includes(account.id))
      await this.write(file)
      return { applied: true, duplicates, removedAccountIds, backupPath }
    } finally {
      release()
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<ClaudeNativeAccount> {
    return this.mutate(async (file) => {
      const account = file.accounts.find((candidate) => candidate.id === id)
      if (!account) throw new ClaudeNativeAccountVaultError('not_found', 'Claude 계정을 찾지 못했습니다.')
      account.enabled = enabled
      account.updatedAt = new Date(this.now()).toISOString()
      const { protectedSecret: _protectedSecret, ...publicAccount } = account
      return publicAccount
    })
  }

  async prefer(id: string): Promise<ClaudeNativeAccount> {
    return this.mutate(async (file) => {
      const preferred = file.accounts.find((candidate) => candidate.id === id)
      if (!preferred) throw new ClaudeNativeAccountVaultError('not_found', 'Claude 계정을 찾지 못했습니다.')
      const ordered = [...file.accounts].sort((left, right) => (
        left.priority - right.priority || left.id.localeCompare(right.id)
      ))
      const next = [preferred, ...ordered.filter((account) => account.id !== id)]
      const updatedAt = new Date(this.now()).toISOString()
      next.forEach((account, priority) => {
        account.priority = priority
        if (account.id === id) account.updatedAt = updatedAt
      })
      file.accounts = next
      const { protectedSecret: _protectedSecret, ...publicAccount } = preferred
      return publicAccount
    })
  }

  async updateSecret(id: string, secret: ClaudeNativeAccountSecret): Promise<ClaudeNativeAccount> {
    parseSecret(JSON.stringify(secret))
    return this.mutate(async (file) => {
      const account = file.accounts.find((candidate) => candidate.id === id)
      if (!account) throw new ClaudeNativeAccountVaultError('not_found', 'Claude 계정을 찾지 못했습니다.')
      account.protectedSecret = await this.protector.protect(JSON.stringify(secret))
      account.updatedAt = new Date(this.now()).toISOString()
      const { protectedSecret: _protectedSecret, ...publicAccount } = account
      return publicAccount
    })
  }

  async importClaudeCodeOnce(
    load: () => Promise<Omit<ClaudeNativeAccountInput, 'id' | 'source'> | null>,
  ): Promise<ClaudeNativeAccount | null> {
    return this.mutate(async (file) => {
      const existing = file.accounts.find((account) => account.source === 'claude-code')
      if (existing) {
        file.legacyImportCompleted = true
        const { protectedSecret: _protectedSecret, ...publicAccount } = existing
        return publicAccount
      }
      if (file.legacyImportCompleted) return null
      const input = await load()
      file.legacyImportCompleted = true
      if (!input) return null
      validateInput(input)
      const now = new Date(this.now()).toISOString()
      const account: StoredAccount = {
        id: this.createId(),
        nickname: input.nickname.trim(),
        ...(input.accountId ? { accountId: input.accountId } : {}),
        ...(input.email ? { email: input.email } : {}),
        priority: input.priority ?? nextPriority(file.accounts),
        enabled: input.enabled ?? true,
        createdAt: now,
        updatedAt: now,
        source: 'claude-code',
        protectedSecret: await this.protector.protect(JSON.stringify(input.secret)),
      }
      file.accounts.push(account)
      const { protectedSecret: _protectedSecret, ...publicAccount } = account
      return publicAccount
    })
  }

  async remove(id: string): Promise<void> {
    await this.mutate(async (file) => {
      const index = file.accounts.findIndex((candidate) => candidate.id === id)
      if (index < 0) throw new ClaudeNativeAccountVaultError('not_found', '삭제할 Claude 계정을 찾지 못했습니다.')
      file.accounts.splice(index, 1)
    })
  }

  private async mutate<T>(operation: (file: VaultFile) => Promise<T>): Promise<T> {
    const previous = this.pendingMutation
    let release!: () => void
    this.pendingMutation = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      const file = await this.read()
      const result = await operation(file)
      await this.write(file)
      return result
    } finally {
      release()
    }
  }

  private async read(): Promise<VaultFile> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, accounts: [] }
      throw new ClaudeNativeAccountVaultError('unavailable', 'Claude 계정 vault를 읽지 못했습니다.')
    }
    try {
      const parsed = JSON.parse(raw) as Partial<VaultFile>
      if (parsed.version !== 1 || !Array.isArray(parsed.accounts)) throw new Error('invalid vault')
      for (const account of parsed.accounts) validateStoredAccount(account)
      return parsed as VaultFile
    } catch (error) {
      if (error instanceof ClaudeNativeAccountVaultError) throw error
      throw new ClaudeNativeAccountVaultError('invalid', 'Claude 계정 vault 형식이 올바르지 않습니다.')
    }
  }

  private async write(file: VaultFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.filePath)
    await chmod(this.filePath, 0o600).catch(() => undefined)
  }
}

export class WindowsDpapiSecretProtector implements ClaudeNativeSecretProtector {
  async protect(plaintext: string): Promise<string> {
    return runDpapi('protect', plaintext)
  }

  async unprotect(ciphertext: string): Promise<string> {
    return runDpapi('unprotect', ciphertext)
  }
}

export function nativeClaudeAccountVaultPath(dataDir: string): string {
  return path.join(dataDir, 'claude-native-accounts.v1.json')
}

function validateInput(input: ClaudeNativeAccountInput): void {
  if (!input.nickname.trim()) throw new ClaudeNativeAccountVaultError('invalid', 'Claude 계정 별칭이 비어 있습니다.')
  if (input.accountId !== undefined && !input.accountId.trim()) {
    throw new ClaudeNativeAccountVaultError('invalid', 'Claude 불변 계정 식별자가 비어 있습니다.')
  }
  if (!Number.isInteger(input.priority ?? 0) || (input.priority ?? 0) < 0) {
    throw new ClaudeNativeAccountVaultError('invalid', 'Claude 계정 우선순위가 올바르지 않습니다.')
  }
  parseSecret(JSON.stringify(input.secret))
}

function parseSecret(raw: string): ClaudeNativeAccountSecret {
  try {
    const value = JSON.parse(raw) as Partial<ClaudeNativeAccountSecret>
    if (
      typeof value.accessToken !== 'string'
      || value.accessToken.length === 0
      || typeof value.refreshToken !== 'string'
      || value.refreshToken.length === 0
      || !Array.isArray(value.scopes)
      || !value.scopes.every((scope) => typeof scope === 'string')
    ) throw new Error('invalid secret')
    return value as ClaudeNativeAccountSecret
  } catch {
    throw new ClaudeNativeAccountVaultError('invalid', 'Claude OAuth 자격증명 형식이 올바르지 않습니다.')
  }
}

function validateStoredAccount(value: unknown): asserts value is StoredAccount {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClaudeNativeAccountVaultError('invalid', 'Claude 계정 vault 항목이 올바르지 않습니다.')
  }
  const account = value as Partial<StoredAccount>
  if (
    typeof account.id !== 'string'
    || typeof account.nickname !== 'string'
    || typeof account.priority !== 'number'
    || typeof account.enabled !== 'boolean'
    || typeof account.createdAt !== 'string'
    || typeof account.updatedAt !== 'string'
    || (account.source !== undefined && account.source !== 'oauth' && account.source !== 'claude-code')
    || typeof account.protectedSecret !== 'string'
    || account.protectedSecret.length === 0
  ) throw new ClaudeNativeAccountVaultError('invalid', 'Claude 계정 vault 항목이 올바르지 않습니다.')
  if (account.source === undefined) account.source = 'oauth'
}

function nextPriority(accounts: StoredAccount[]): number {
  return accounts.reduce((highest, account) => Math.max(highest, account.priority), -1) + 1
}

const DPAPI_SCRIPT = {
  protect: "Add-Type -AssemblyName System.Security;$inputValue=[Console]::In.ReadToEnd();$bytes=[Text.Encoding]::UTF8.GetBytes($inputValue);$result=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($result))",
  unprotect: "Add-Type -AssemblyName System.Security;$inputValue=[Console]::In.ReadToEnd();$bytes=[Convert]::FromBase64String($inputValue);$result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($result))",
} as const

async function runDpapi(mode: keyof typeof DPAPI_SCRIPT, input: string): Promise<string> {
  if (process.platform !== 'win32') {
    throw new ClaudeNativeAccountVaultError('unavailable', 'Windows DPAPI는 Windows에서만 사용할 수 있습니다.')
  }
  return new Promise<string>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT[mode]], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => child.kill(), 30_000)
    timeout.unref()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length + chunk.length <= 1_048_576) stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length + chunk.length <= 8_192) stderr += chunk
    })
    child.once('error', () => {
      clearTimeout(timeout)
      reject(new ClaudeNativeAccountVaultError('unavailable', 'Windows DPAPI 프로세스를 시작하지 못했습니다.'))
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0 || !stdout) {
        reject(new ClaudeNativeAccountVaultError(
          'unavailable',
          `Windows DPAPI 작업이 실패했습니다${stderr ? `: ${stderr.trim()}` : '.'}`,
        ))
        return
      }
      resolve(stdout)
    })
    child.stdin.end(input)
  })
}
