import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
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

export interface ClaudeRefreshCredentialDuplicate {
  refreshFingerprint: string
  accountIds: string[]
  identitylessAccountIds: string[]
}

export interface ClaudeStableIdentityRepairResult {
  applied: boolean
  duplicates: ClaudeStableIdentityDuplicate[]
  refreshCredentialDuplicates: ClaudeRefreshCredentialDuplicate[]
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
  private readonly mutationContext = new AsyncLocalStorage<boolean>()
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
    keepByRefreshFingerprint?: Record<string, string>
  } = {}): Promise<ClaudeStableIdentityRepairResult> {
    return this.withExclusiveMutation(async () => {
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
      const refreshGrouped = new Map<string, StoredAccount[]>()
      for (const account of file.accounts) {
        const fingerprint = credentialFingerprint((await this.openSecret(account)).refreshToken)
        const group = refreshGrouped.get(fingerprint) ?? []
        group.push(account)
        refreshGrouped.set(fingerprint, group)
      }
      const refreshCredentialDuplicates = [...refreshGrouped.entries()]
        .filter(([, accounts]) => accounts.length > 1)
        .map(([refreshFingerprint, accounts]) => ({
          refreshFingerprint,
          accountIds: accounts.map((account) => account.id),
          identitylessAccountIds: accounts.filter((account) => !account.accountId).map((account) => account.id),
        }))
        .sort((left, right) => left.refreshFingerprint.localeCompare(right.refreshFingerprint))
      if (input.apply !== true) {
        return { applied: false, duplicates, refreshCredentialDuplicates, removedAccountIds: [], backupPath: null }
      }

      const keepByAccountId = input.keepByAccountId ?? {}
      const keepByRefreshFingerprint = input.keepByRefreshFingerprint ?? {}
      const decisions = new Map<string, 'keep' | 'remove'>()
      const requireKeeper = (accountIds: string[], keepId: string | undefined, description: string): string => {
        if (!keepId || !accountIds.includes(keepId)) {
          throw new ClaudeNativeAccountVaultError(
            'invalid',
            `${description}에서 유지할 계정 id를 명시하세요 (explicit keep id required).`,
          )
        }
        return keepId
      }
      const applyKeeper = (accountIds: string[], keepId: string): void => {
        for (const accountId of accountIds) {
          const decision = accountId === keepId ? 'keep' : 'remove'
          const previous = decisions.get(accountId)
          if (previous && previous !== decision) {
            throw new ClaudeNativeAccountVaultError('invalid', '중복 그룹의 keeper 선택이 서로 충돌합니다.')
          }
          decisions.set(accountId, decision)
        }
      }
      for (const duplicate of duplicates) {
        const keepId = requireKeeper(
          duplicate.accountIds,
          keepByAccountId[duplicate.accountId],
          `중복 stable identity ${duplicate.accountId}`,
        )
        applyKeeper(duplicate.accountIds, keepId)
      }
      for (const duplicate of refreshCredentialDuplicates) {
        const keepId = requireKeeper(
          duplicate.accountIds,
          keepByRefreshFingerprint[duplicate.refreshFingerprint],
          `중복 refresh credential ${duplicate.refreshFingerprint}`,
        )
        const survivors = duplicate.accountIds.filter((accountId) => decisions.get(accountId) !== 'remove')
        if (survivors.length === 0) continue
        if (!survivors.includes(keepId)) {
          throw new ClaudeNativeAccountVaultError('invalid', '중복 그룹의 keeper 선택이 서로 충돌합니다.')
        }
        applyKeeper(survivors, keepId)
      }
      if (duplicates.length === 0 && refreshCredentialDuplicates.length === 0) {
        return { applied: true, duplicates, refreshCredentialDuplicates, removedAccountIds: [], backupPath: null }
      }

      const removedAccountIds = file.accounts
        .filter((account) => decisions.get(account.id) === 'remove')
        .map((account) => account.id)
      const backupPath = `${this.filePath}.backup-${this.now()}`
      try {
        await copyFile(this.filePath, backupPath, constants.COPYFILE_EXCL)
      } catch {
        throw new ClaudeNativeAccountVaultError('unavailable', 'Claude 계정 vault 백업을 만들지 못해 복구를 중단했습니다.')
      }
      file.accounts = file.accounts.filter((account) => !removedAccountIds.includes(account.id))
      await this.write(file)
      return { applied: true, duplicates, refreshCredentialDuplicates, removedAccountIds, backupPath }
    })
  }

  async claimClaudeCodePlaceholder(input: Omit<ClaudeNativeAccountInput, 'id' | 'accountId'> & {
    accountId: string
    placeholderId: string
    expectedRefreshToken: string
  }): Promise<ClaudeNativeAccount> {
    validateInput(input)
    return this.mutate(async (file) => {
      const placeholder = file.accounts.find((account) => account.id === input.placeholderId)
      if (!placeholder || placeholder.source !== 'claude-code' || placeholder.accountId) {
        throw new ClaudeNativeAccountVaultError('invalid', 'Claude Code placeholder ownership changed before it could be claimed.')
      }
      if (file.accounts.some((account) => account.accountId === input.accountId)) {
        throw new ClaudeNativeAccountVaultError(
          'invalid',
          `Claude stable identity ${input.accountId} is already owned by another vault account.`,
        )
      }
      const currentSecret = await this.openSecret(placeholder)
      if (currentSecret.refreshToken !== input.expectedRefreshToken) {
        throw new ClaudeNativeAccountVaultError(
          'invalid',
          'Claude Code placeholder credential ownership changed before it could be claimed.',
        )
      }
      const account: StoredAccount = {
        id: placeholder.id,
        nickname: input.nickname.trim(),
        accountId: input.accountId.trim(),
        ...(input.email?.trim() ? { email: input.email.trim() } : {}),
        priority: input.priority ?? placeholder.priority,
        enabled: input.enabled ?? placeholder.enabled,
        createdAt: placeholder.createdAt,
        updatedAt: new Date(this.now()).toISOString(),
        source: input.source ?? 'oauth',
        protectedSecret: await this.protector.protect(JSON.stringify(input.secret)),
      }
      file.accounts[file.accounts.indexOf(placeholder)] = account
      const { protectedSecret: _protectedSecret, ...publicAccount } = account
      return publicAccount
    })
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
    return this.withExclusiveMutation(async () => {
      const file = await this.read()
      const result = await operation(file)
      await this.write(file)
      return result
    })
  }

  async withExclusiveMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.mutationContext.getStore()) return operation()
    const previous = this.pendingMutation
    let release!: () => void
    this.pendingMutation = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await withVaultFileLock(this.filePath, () => this.mutationContext.run(true, operation))
    } finally {
      release()
    }
  }

  private async openSecret(account: StoredAccount): Promise<ClaudeNativeAccountSecret> {
    let plaintext: string
    try {
      plaintext = await this.protector.unprotect(account.protectedSecret)
    } catch {
      throw new ClaudeNativeAccountVaultError('unavailable', 'Claude 계정 자격증명을 복호화하지 못했습니다.')
    }
    return parseSecret(plaintext)
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

interface VaultLockOwner {
  version: 1
  pid: number
  nonce: string
  createdAt: number
  processIdentity: string
}

interface VaultLockLease {
  version: 1
  nonce: string
  leaseUntil: number
}

const VAULT_LOCK_TIMEOUT_MS = 10_000
const VAULT_LOCK_INITIALIZATION_GRACE_MS = 30_000
const VAULT_LOCK_LEASE_MS = 30_000
const VAULT_LOCK_HEARTBEAT_MS = 5_000
const VAULT_LOCK_OWNER_FILE = 'owner.json'
const VAULT_LOCK_LEASE_FILE = 'lease.json'
const FALLBACK_PROCESS_IDENTITY = `fallback:${process.pid}:${randomBytes(16).toString('hex')}`
const activeVaultLockNonces = new Set<string>()
let currentProcessIdentityPromise: Promise<string> | undefined

async function withVaultFileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`
  const owner = await acquireVaultFileLock(lockPath)
  const leasePath = path.join(lockPath, VAULT_LOCK_LEASE_FILE)
  let heartbeatError: unknown
  let heartbeat = Promise.resolve()
  const heartbeatTimer = setInterval(() => {
    heartbeat = heartbeat
      .then(() => writeVaultLockLease(leasePath, owner.nonce))
      .catch((error: unknown) => { heartbeatError ??= error })
  }, VAULT_LOCK_HEARTBEAT_MS)
  heartbeatTimer.unref()

  let result!: T
  let operationError: unknown
  let operationFailed = false
  try {
    result = await operation()
  } catch (error) {
    operationFailed = true
    operationError = error
  }
  clearInterval(heartbeatTimer)
  await heartbeat

  let cleanupError: unknown
  try {
    await releaseVaultFileLock(lockPath, owner)
  } catch (error) {
    cleanupError = error
  } finally {
    activeVaultLockNonces.delete(owner.nonce)
  }
  if (heartbeatError || cleanupError) {
    const lockError = new ClaudeNativeAccountVaultError(
      'unavailable',
      'Claude 계정 vault lock을 안전하게 정리하지 못했습니다.',
    )
    if (operationFailed) {
      throw new AggregateError([operationError, heartbeatError, cleanupError].filter(Boolean), lockError.message)
    }
    throw lockError
  }
  if (operationFailed) throw operationError
  return result
}

async function acquireVaultFileLock(lockPath: string): Promise<VaultLockOwner> {
  await mkdir(path.dirname(lockPath), { recursive: true })
  const deadline = Date.now() + VAULT_LOCK_TIMEOUT_MS
  const processIdentity = await currentProcessIdentity()
  while (true) {
    const owner: VaultLockOwner = {
      version: 1,
      pid: process.pid,
      nonce: randomBytes(16).toString('hex'),
      createdAt: Date.now(),
      processIdentity,
    }
    try {
      await mkdir(lockPath)
      try {
        await writeFile(path.join(lockPath, VAULT_LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        })
        await writeVaultLockLease(path.join(lockPath, VAULT_LOCK_LEASE_FILE), owner.nonce)
        activeVaultLockNonces.add(owner.nonce)
        return owner
      } catch (error) {
        try {
          await removeKnownLockDirectory(lockPath)
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Claude 계정 vault lock 초기화를 정리하지 못했습니다.')
        }
        throw error
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        if (error instanceof AggregateError) throw error
        throw new ClaudeNativeAccountVaultError('unavailable', 'Claude 계정 vault lock을 획득하지 못했습니다.')
      }
      if (await recoverAbandonedVaultFileLock(lockPath)) continue
      if (Date.now() >= deadline) {
        throw new ClaudeNativeAccountVaultError('unavailable', 'Claude 계정 vault가 다른 프로세스에서 변경 중입니다.')
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

async function recoverAbandonedVaultFileLock(lockPath: string): Promise<boolean> {
  let entries
  try {
    entries = await readdir(lockPath, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw new ClaudeNativeAccountVaultError('unavailable', 'Claude 계정 vault lock을 검사하지 못했습니다.')
  }
  if (entries.some((entry) => (
    !entry.isFile() || (entry.name !== VAULT_LOCK_OWNER_FILE && entry.name !== VAULT_LOCK_LEASE_FILE)
  ))) return false

  const ownerPath = path.join(lockPath, VAULT_LOCK_OWNER_FILE)
  let owner: VaultLockOwner | null = null
  try {
    owner = parseVaultLockOwner(await readFile(ownerPath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ClaudeNativeAccountVaultError('unavailable', 'Claude 계정 vault lock owner를 읽지 못했습니다.')
    }
  }
  let lease: VaultLockLease | null = null
  try {
    lease = parseVaultLockLease(await readFile(path.join(lockPath, VAULT_LOCK_LEASE_FILE), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ClaudeNativeAccountVaultError('unavailable', 'Claude 계정 vault lock lease를 읽지 못했습니다.')
    }
  }
  if (owner && isProcessAlive(owner.pid)) {
    if (!lease || lease.nonce !== owner.nonce || lease.leaseUntil >= Date.now()) return false
    const liveIdentity = await processStartIdentity(owner.pid)
    if (liveIdentity === undefined) return false
    if (liveIdentity === owner.processIdentity) {
      if (owner.pid !== process.pid || activeVaultLockNonces.has(owner.nonce)) return false
    }
  }
  if (!owner) {
    const target = entries.some((entry) => entry.name === VAULT_LOCK_OWNER_FILE) ? ownerPath : lockPath
    let age: number
    try {
      age = Date.now() - (await stat(target)).mtimeMs
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      throw new ClaudeNativeAccountVaultError('unavailable', 'Claude 계정 vault lock을 검사하지 못했습니다.')
    }
    if (age < VAULT_LOCK_INITIALIZATION_GRACE_MS) return false
  }

  const quarantinePath = `${lockPath}.abandoned-${randomBytes(12).toString('hex')}`
  try {
    await rename(lockPath, quarantinePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    return false
  }
  try {
    await removeKnownLockDirectory(quarantinePath)
  } catch {
    throw new ClaudeNativeAccountVaultError('unavailable', '폐기된 Claude 계정 vault lock을 정리하지 못했습니다.')
  }
  return true
}

async function releaseVaultFileLock(lockPath: string, expectedOwner: VaultLockOwner): Promise<void> {
  const owner = parseVaultLockOwner(await readFile(path.join(lockPath, VAULT_LOCK_OWNER_FILE), 'utf8'))
  const lease = parseVaultLockLease(await readFile(path.join(lockPath, VAULT_LOCK_LEASE_FILE), 'utf8'))
  if (!owner || owner.nonce !== expectedOwner.nonce || !lease || lease.nonce !== expectedOwner.nonce) {
    throw new Error('Claude account vault lock ownership changed before cleanup.')
  }
  await removeKnownLockDirectory(lockPath)
}

async function removeKnownLockDirectory(lockPath: string): Promise<void> {
  const entries = await readdir(lockPath, { withFileTypes: true })
  if (entries.some((entry) => (
    !entry.isFile() || (entry.name !== VAULT_LOCK_OWNER_FILE && entry.name !== VAULT_LOCK_LEASE_FILE)
  ))) throw new Error('Claude account vault lock contains unexpected entries.')
  for (const entry of entries) await unlink(path.join(lockPath, entry.name))
  await rmdir(lockPath)
}

async function writeVaultLockLease(leasePath: string, nonce: string): Promise<void> {
  const lease: VaultLockLease = { version: 1, nonce, leaseUntil: Date.now() + VAULT_LOCK_LEASE_MS }
  await writeFile(leasePath, `${JSON.stringify(lease)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function parseVaultLockOwner(raw: string): VaultLockOwner | null {
  try {
    const value = JSON.parse(raw) as Partial<VaultLockOwner>
    return value.version === 1
      && Number.isSafeInteger(value.pid) && Number(value.pid) > 0
      && typeof value.nonce === 'string' && /^[a-f0-9]{32}$/.test(value.nonce)
      && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
      && typeof value.processIdentity === 'string' && value.processIdentity.length > 0 && value.processIdentity.length <= 200
      ? value as VaultLockOwner
      : null
  } catch {
    return null
  }
}

function parseVaultLockLease(raw: string): VaultLockLease | null {
  try {
    const value = JSON.parse(raw) as Partial<VaultLockLease>
    return value.version === 1
      && typeof value.nonce === 'string' && /^[a-f0-9]{32}$/.test(value.nonce)
      && typeof value.leaseUntil === 'number' && Number.isFinite(value.leaseUntil)
      ? value as VaultLockLease
      : null
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    return true
  }
}

function currentProcessIdentity(): Promise<string> {
  currentProcessIdentityPromise ??= processStartIdentity(process.pid).then((identity) => {
    if (identity === null) throw new ClaudeNativeAccountVaultError('unavailable', '현재 vault lock process identity를 확인하지 못했습니다.')
    return identity ?? FALLBACK_PROCESS_IDENTITY
  })
  return currentProcessIdentityPromise
}

async function processStartIdentity(pid: number): Promise<string | null | undefined> {
  if (process.platform === 'win32') return windowsProcessStartIdentity(pid)
  if (process.platform === 'linux') {
    try {
      const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
      const closing = raw.lastIndexOf(')')
      const fields = closing >= 0 ? raw.slice(closing + 1).trim().split(/\s+/) : []
      return fields[19] ? `linux:${fields[19]}` : undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      return undefined
    }
  }
  return pid === process.pid ? FALLBACK_PROCESS_IDENTITY : undefined
}

async function windowsProcessStartIdentity(pid: number): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    const script = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($null -eq $p){exit 3};[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)`
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let stdout = ''
    const timeout = setTimeout(() => child.kill(), 5_000)
    timeout.unref()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length + chunk.length <= 200) stdout += chunk
    })
    child.once('error', () => {
      clearTimeout(timeout)
      resolve(undefined)
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      if (code === 3) resolve(null)
      else if (code === 0 && /^\d+$/.test(stdout.trim())) resolve(`windows:${stdout.trim()}`)
      else resolve(undefined)
    })
  })
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

function credentialFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex')
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
