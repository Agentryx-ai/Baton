import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

export type RecoveryTarget = 'claude-cli' | 'claude-desktop' | 'codex'
export type RecoveryState = 'PREPARED' | 'APPLIED' | 'REMOVED'
export type RecoveryFormat = 'json' | 'toml'

interface RecoveryPayload {
  beforeExisted: boolean
  beforeContent: string
  appliedContent: string
  binding: string
}

export interface RecoveryReceipt {
  schemaVersion: 1
  installationId: string
  transactionId: string
  target: RecoveryTarget
  label: string
  filePath: string
  format: RecoveryFormat
  ownedFields: string[][]
  endpoint: string
  beforeHash: string
  appliedHash: string
  appliedValueDigest: string
  state: RecoveryState
  adopted: boolean
  originalValuesKnown: boolean
  tempPath: string
  pendingRemovalHash?: string
  pendingRemovalExisted?: boolean
  updatedAt: string
  protectedPayload: string
}

export interface RecoveryMutation {
  target: RecoveryTarget
  label: string
  filePath: string
  format: RecoveryFormat
  ownedFields: string[][]
  endpoint: string
  beforeExisted: boolean
  beforeContent: string
  appliedContent: string
}

export interface RecoveryStatus {
  target: RecoveryTarget
  state: RecoveryState | 'MISSING' | 'UNTRACKED' | 'CONFLICT' | 'CORRUPT' | 'BUSY'
  filePath?: string
  detail?: string
  adopted?: boolean
}

export interface PayloadProtector {
  protect(plaintext: Buffer): Promise<string>
  unprotect(ciphertext: string): Promise<Buffer>
}

export interface RecoveryOptions {
  root?: string
  protector?: PayloadProtector
  /** Test-only crash injection after the named durable boundary. */
  crashAfter?: 'PREPARED' | 'TEMP_WRITTEN' | 'FILE_REPLACED' | 'REMOVAL_PREPARED' | 'REMOVAL_FILE_REPLACED'
}

export class RecoveryError extends Error {
  public readonly code: 'busy' | 'conflict' | 'corrupt' | 'missing' | 'invalid'

  constructor(
    code: 'busy' | 'conflict' | 'corrupt' | 'missing' | 'invalid',
    message: string,
  ) {
    super(message)
    this.code = code
    this.name = 'RecoveryError'
  }
}

const RECEIPT_SCHEMA = 1 as const
const TARGETS: RecoveryTarget[] = ['claude-cli', 'claude-desktop', 'codex']

export function defaultRecoveryRoot(): string {
  if (process.env.BATON_RECOVERY_ROOT) return path.resolve(process.env.BATON_RECOVERY_ROOT)
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) throw new RecoveryError('invalid', 'LOCALAPPDATA를 찾지 못했습니다.')
  return path.join(localAppData, 'Baton', 'integration-recovery')
}

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

export class WindowsCurrentUserProtector implements PayloadProtector {
  async protect(plaintext: Buffer): Promise<string> {
    return runDpapi('Protect', plaintext.toString('base64'))
  }

  async unprotect(ciphertext: string): Promise<Buffer> {
    return Buffer.from(await runDpapi('Unprotect', ciphertext), 'base64')
  }
}

export async function applyRecoveryMutation(
  mutation: RecoveryMutation,
  options: RecoveryOptions = {},
): Promise<RecoveryReceipt> {
  return withTargetLock(mutation.target, options, async (root, protector) => {
    const existing = await reconcileReceipt(mutation.target, root, protector).catch((error) => {
      if (error instanceof RecoveryError && error.code === 'missing') return null
      throw error
    })
    if (existing && existing.state !== 'REMOVED') {
      throw new RecoveryError('conflict', `${mutation.label} 복구 receipt가 이미 활성 상태입니다.`)
    }

    const current = await readOptional(mutation.filePath)
    if (current.existed !== mutation.beforeExisted || current.content !== mutation.beforeContent) {
      throw new RecoveryError('conflict', `${mutation.label} 설정이 준비 이후 변경되어 적용하지 않았습니다.`)
    }

    const payload = {
      beforeExisted: mutation.beforeExisted,
      beforeContent: mutation.beforeContent,
      appliedContent: mutation.appliedContent,
    }
    const now = new Date().toISOString()
    const transactionId = randomUUID()
    let receipt: RecoveryReceipt = {
      schemaVersion: RECEIPT_SCHEMA,
      installationId: existing?.installationId ?? randomUUID(),
      transactionId,
      target: mutation.target,
      label: mutation.label,
      filePath: path.resolve(mutation.filePath),
      format: mutation.format,
      ownedFields: mutation.ownedFields,
      endpoint: mutation.endpoint,
      beforeHash: mutation.beforeExisted ? sha256(mutation.beforeContent) : sha256(Buffer.alloc(0)),
      appliedHash: sha256(mutation.appliedContent),
      appliedValueDigest: ownedValueDigest(mutation.format, mutation.appliedContent, mutation.ownedFields),
      state: 'PREPARED',
      adopted: false,
      originalValuesKnown: true,
      tempPath: `${path.resolve(mutation.filePath)}.baton-${transactionId}.tmp`,
      updatedAt: now,
      protectedPayload: '',
    }
    await sealReceipt(receipt, payload, protector)
    await writeReceipt(receipt, root)
    if (options.crashAfter === 'PREPARED') throw new Error('simulated crash after PREPARED')

    await replaceWithCas(
      mutation.filePath,
      mutation.beforeExisted,
      mutation.beforeContent,
      mutation.appliedContent,
      true,
      receipt.tempPath,
      options.crashAfter === 'TEMP_WRITTEN',
    )
    if (options.crashAfter === 'FILE_REPLACED') throw new Error('simulated crash after file replacement')

    receipt = { ...receipt, state: 'APPLIED', updatedAt: new Date().toISOString() }
    await sealReceipt(receipt, payload, protector)
    await writeReceipt(receipt, root)
    return receipt
  })
}

export async function adoptExistingIntegration(
  mutation: RecoveryMutation,
  confirmed: boolean,
  options: RecoveryOptions = {},
): Promise<RecoveryReceipt | {
  preview: true
  target: RecoveryTarget
  filePath: string
  originalValuesKnown: false
}> {
  if (!confirmed) return {
    preview: true,
    target: mutation.target,
    filePath: mutation.filePath,
    originalValuesKnown: false,
  }
  if (mutation.beforeContent === mutation.appliedContent) {
    throw new RecoveryError('invalid', '채택 시 복구될 Baton 소유 필드 제거본이 필요합니다.')
  }
  return withTargetLock(mutation.target, options, async (root, protector) => {
    await assertConfigFileUnlocked(mutation.filePath)
    const current = await readOptional(mutation.filePath)
    if (!current.existed || current.content !== mutation.appliedContent) {
      throw new RecoveryError('conflict', `${mutation.label} 설정이 preview 이후 변경되었습니다.`)
    }
    const prior = await reconcileReceipt(mutation.target, root, protector).catch((error) => {
      if (error instanceof RecoveryError && error.code === 'missing') return null
      throw error
    })
    if (prior && prior.state !== 'REMOVED') throw new RecoveryError('conflict', '활성 receipt가 이미 있습니다.')
    const payload = {
      beforeExisted: true,
      beforeContent: mutation.beforeContent,
      appliedContent: mutation.appliedContent,
    }
    const transactionId = randomUUID()
    const receipt: RecoveryReceipt = {
      schemaVersion: RECEIPT_SCHEMA,
      installationId: prior?.installationId ?? randomUUID(),
      transactionId,
      target: mutation.target,
      label: mutation.label,
      filePath: path.resolve(mutation.filePath),
      format: mutation.format,
      ownedFields: mutation.ownedFields,
      endpoint: mutation.endpoint,
      beforeHash: sha256(mutation.beforeContent),
      appliedHash: sha256(mutation.appliedContent),
      appliedValueDigest: ownedValueDigest(mutation.format, mutation.appliedContent, mutation.ownedFields),
      state: 'APPLIED',
      adopted: true,
      originalValuesKnown: false,
      tempPath: `${path.resolve(mutation.filePath)}.baton-${transactionId}.tmp`,
      updatedAt: new Date().toISOString(),
      protectedPayload: '',
    }
    await sealReceipt(receipt, payload, protector)
    await writeReceipt(receipt, root)
    return receipt
  })
}

export async function getRecoveryStatus(
  target: RecoveryTarget,
  options: RecoveryOptions = {},
): Promise<RecoveryStatus> {
  try {
    return await withTargetLock(target, options, async (root, protector) => {
      const receipt = await reconcileReceipt(target, root, protector)
      const current = await readOptional(receipt.filePath)
      const payload = await decodePayload(receipt, protector)
      const currentHash = current.existed ? sha256(current.content) : sha256(Buffer.alloc(0))
      if (receipt.state === 'APPLIED' && currentHash !== receipt.appliedHash) {
        try {
          restoreOwned(receipt, payload, current.content, false)
        } catch (error) {
          return {
            target,
            state: 'CONFLICT',
            filePath: receipt.filePath,
            detail: safeMessage(error),
            adopted: receipt.adopted,
          }
        }
      }
      return { target, state: receipt.state, filePath: receipt.filePath, adopted: receipt.adopted }
    })
  } catch (error) {
    if (error instanceof RecoveryError && error.code === 'missing') return { target, state: 'MISSING' }
    if (error instanceof RecoveryError && error.code === 'corrupt') {
      return { target, state: 'CORRUPT', detail: error.message }
    }
    if (error instanceof RecoveryError && error.code === 'busy') {
      return { target, state: 'BUSY', detail: error.message }
    }
    throw error
  }
}

export async function listRecoveryStatuses(options: RecoveryOptions = {}): Promise<RecoveryStatus[]> {
  return Promise.all(TARGETS.map((target) => getRecoveryStatus(target, options)))
}

export async function removeRecoveryIntegration(
  target: RecoveryTarget,
  options: RecoveryOptions = {},
): Promise<RecoveryReceipt> {
  return withTargetLock(target, options, async (root, protector) => {
    let receipt = await reconcileReceipt(target, root, protector)
    if (receipt.state !== 'APPLIED') {
      throw new RecoveryError('conflict', `${receipt.label} receipt가 APPLIED 상태가 아닙니다.`)
    }
    const payload = await decodePayload(receipt, protector)
    await assertConfigFileUnlocked(receipt.filePath)
    const current = await readOptional(receipt.filePath)
    if (!current.existed) throw new RecoveryError('conflict', `${receipt.label} 설정 파일이 없습니다.`)

    const currentHash = sha256(current.content)
    let nextContent: string
    let nextExisted = payload.beforeExisted
    if (currentHash === receipt.appliedHash) {
      nextContent = payload.beforeContent
    } else {
      nextContent = restoreOwned(receipt, payload, current.content, true)
      // A missing original cannot be deleted after unrelated user content appeared.
      if (!payload.beforeExisted && nextContent.trim().length > 0) nextExisted = true
    }
    receipt = {
      ...receipt,
      pendingRemovalHash: sha256(nextContent),
      pendingRemovalExisted: nextExisted,
      updatedAt: new Date().toISOString(),
    }
    await sealReceipt(receipt, payload, protector)
    await writeReceipt(receipt, root)
    if (options.crashAfter === 'REMOVAL_PREPARED') throw new Error('simulated crash after removal prepare')
    await replaceWithCas(receipt.filePath, true, current.content, nextContent, nextExisted, receipt.tempPath)
    if (options.crashAfter === 'REMOVAL_FILE_REPLACED') throw new Error('simulated crash after removal file replacement')
    receipt = { ...receipt, state: 'REMOVED', updatedAt: new Date().toISOString() }
    await sealReceipt(receipt, payload, protector)
    await writeReceipt(receipt, root)
    return receipt
  })
}

export async function assertConfigFileUnlocked(file: string): Promise<void> {
  if (process.platform !== 'win32') return
  try {
    await runPowerShell(String.raw`$filePath = [string]($inputObject.items[0])
if (Test-Path -LiteralPath $filePath) {
  $stream = [System.IO.File]::Open($filePath, 'Open', 'ReadWrite', 'None')
  $stream.Dispose()
}`,[file])
  } catch {
    throw new RecoveryError('busy', `${path.basename(file)} 설정 파일이 잠겨 있어 변경하지 않았습니다.`)
  }
}

export async function doctorRecovery(options: RecoveryOptions = {}): Promise<{
  ok: boolean
  statuses: RecoveryStatus[]
  root: string
}> {
  const root = options.root ?? defaultRecoveryRoot()
  const statuses = await listRecoveryStatuses(options)
  return {
    ok: statuses.every((item) => !['BUSY', 'CONFLICT', 'CORRUPT'].includes(item.state)),
    statuses,
    root,
  }
}

async function reconcileReceipt(
  target: RecoveryTarget,
  root: string,
  protector: PayloadProtector,
): Promise<RecoveryReceipt> {
  let receipt = await readReceipt(target, root)
  const payload = await decodePayload(receipt, protector)
  await cleanupReceiptTemp(receipt)
  const current = await readOptional(receipt.filePath)
  const currentHash = current.existed ? sha256(current.content) : sha256(Buffer.alloc(0))
  if (receipt.state === 'APPLIED' && receipt.pendingRemovalHash !== undefined) {
    if (
      current.existed === receipt.pendingRemovalExisted
      && currentHash === receipt.pendingRemovalHash
    ) {
      receipt = { ...receipt, state: 'REMOVED', updatedAt: new Date().toISOString() }
      await sealReceipt(receipt, payload, protector)
      await writeReceipt(receipt, root)
    }
    return receipt
  }
  if (receipt.state !== 'PREPARED') return receipt
  if (currentHash === receipt.appliedHash) {
    receipt = { ...receipt, state: 'APPLIED', updatedAt: new Date().toISOString() }
  } else if (
    current.existed === payload.beforeExisted
    && currentHash === receipt.beforeHash
  ) {
    receipt = { ...receipt, state: 'REMOVED', updatedAt: new Date().toISOString() }
  } else {
    throw new RecoveryError('conflict', `${receipt.label} PREPARED transaction의 파일 상태를 확정할 수 없습니다.`)
  }
  await sealReceipt(receipt, payload, protector)
  await writeReceipt(receipt, root)
  return receipt
}

function restoreOwned(
  receipt: RecoveryReceipt,
  payload: RecoveryPayload,
  currentContent: string,
  serialize: boolean,
): string {
  const before = parseConfig(receipt.format, payload.beforeContent || emptyDocument(receipt.format), receipt.label)
  const applied = parseConfig(receipt.format, payload.appliedContent, receipt.label)
  const current = parseConfig(receipt.format, currentContent, receipt.label)
  for (const ownedPath of receipt.ownedFields) {
    const appliedValue = lookup(applied, ownedPath)
    const currentValue = lookup(current, ownedPath)
    if (!sameLookup(appliedValue, currentValue)) {
      throw new RecoveryError('conflict', `${receipt.label} Baton 소유 값 ${ownedPath.join('.')}이 변경되었습니다.`)
    }
    const beforeValue = lookup(before, ownedPath)
    if (beforeValue.present) setPath(current, ownedPath, beforeValue.value)
    else deletePath(current, ownedPath)
  }
  if (serialize && receipt.target === 'codex') {
    return restoreCodexOwnedText(receipt, before, currentContent)
  }
  return serialize ? stringifyConfig(receipt.format, current) : currentContent
}

function restoreCodexOwnedText(
  receipt: RecoveryReceipt,
  before: Record<string, unknown>,
  content: string,
): string {
  if (lookup(before, ['openai_base_url']).present || lookup(before, ['model_providers', 'baton']).present) {
    throw new RecoveryError('conflict', 'Codex 적용 전 owned field가 있어 text-preserving 복구를 확정할 수 없습니다.')
  }
  return removeManagedCodexIntegrationText(content, receipt.endpoint)
}

export function removeManagedCodexIntegrationText(content: string, endpoint: string): string {
  const current = parseConfig('toml', content, 'Codex')
  const providers = lookup(current, ['model_providers'])
  const batonValue = providers.present && providers.value && typeof providers.value === 'object'
    ? (providers.value as Record<string, unknown>).baton
    : undefined
  if (!batonValue || typeof batonValue !== 'object' || Array.isArray(batonValue)) {
    throw new RecoveryError('conflict', 'Codex Baton provider가 exact managed 형태가 아닙니다.')
  }
  const baton = batonValue as Record<string, unknown>
  const keys = Object.keys(baton).sort()
  const expectedKeys = ['base_url', 'name', 'request_max_retries', 'stream_max_retries', 'wire_api']
  if (
    current.openai_base_url !== endpoint
    || (current.model_provider !== undefined && current.model_provider !== 'openai')
    || JSON.stringify(keys) !== JSON.stringify(expectedKeys)
    || baton.name !== 'Baton Native (resume compatibility)'
    || baton.base_url !== endpoint
    || baton.wire_api !== 'responses'
    || baton.request_max_retries !== 0
    || baton.stream_max_retries !== 0
  ) {
    throw new RecoveryError('conflict', 'Codex Baton provider가 exact managed 형태가 아닙니다.')
  }
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const endedWithNewline = content.endsWith('\n')
  const lines = content.length ? content.replace(/\r\n/g, '\n').split('\n') : []
  if (endedWithNewline) lines.pop()
  const firstTable = lines.findIndex((line) => isTomlTableHeader(line))
  const preambleEnd = firstTable === -1 ? lines.length : firstTable
  let baseUrlCount = 0
  let batonHeaderCount = 0
  const output: string[] = []
  let skipBatonProvider = false
  for (const [index, line] of lines.entries()) {
    if (isTomlTableHeader(line)) {
      const batonHeader = isBatonProviderHeader(line)
      if (batonHeader) batonHeaderCount += 1
      if (batonHeader && !isCanonicalBatonProviderHeader(line)) {
        throw new RecoveryError('conflict', 'Codex Baton provider에 중첩 또는 비표준 table이 있습니다.')
      }
      skipBatonProvider = batonHeader
      if (skipBatonProvider) continue
    }
    if (skipBatonProvider) {
      if (/^\s*(?:#.*)?$/.test(line)) {
        output.push(line)
        continue
      }
      if (/^\s*(?:name|base_url|wire_api|request_max_retries|stream_max_retries)\s*=/.test(line)) continue
      throw new RecoveryError('conflict', 'Codex Baton provider table에 알 수 없는 사용자 항목이 있습니다.')
    }
    if (index < preambleEnd && /^\s*openai_base_url\s*=/.test(line)) {
      baseUrlCount += 1
      continue
    }
    output.push(line)
  }
  if (baseUrlCount !== 1 || batonHeaderCount !== 1) {
    throw new RecoveryError('conflict', 'Codex managed field 표기를 안전하게 제거할 수 없습니다.')
  }
  while (output.length > 0 && output.at(-1) === '') output.pop()
  const result = output.length > 0 ? `${output.join(newline)}${endedWithNewline ? newline : ''}` : ''
  const parsed = parseConfig('toml', result, 'Codex')
  if (lookup(parsed, ['openai_base_url']).present || lookup(parsed, ['model_providers', 'baton']).present) {
    throw new RecoveryError('corrupt', 'Codex owned field 제거 검증에 실패했습니다.')
  }
  return result
}

function isTomlTableHeader(line: string): boolean {
  return /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line)
}

function isBatonProviderHeader(line: string): boolean {
  return /^\s*\[\s*model_providers\s*\.\s*baton(?:\s*\.[^\]]+)?\s*\]\s*(?:#.*)?$/.test(line)
}

function isCanonicalBatonProviderHeader(line: string): boolean {
  return /^\s*\[\s*model_providers\s*\.\s*baton\s*\]\s*(?:#.*)?$/.test(line)
}

function parseConfig(format: RecoveryFormat, content: string, label: string): Record<string, unknown> {
  try {
    const parsed = format === 'json' ? JSON.parse(content) : parseToml(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object expected')
    return parsed as Record<string, unknown>
  } catch {
    throw new RecoveryError('corrupt', `${label} 설정 문법이 올바르지 않습니다.`)
  }
}

function stringifyConfig(format: RecoveryFormat, value: Record<string, unknown>): string {
  return format === 'json'
    ? `${JSON.stringify(value, null, 2)}\n`
    : (Object.keys(value).length === 0 ? '' : `${stringifyToml(value).trimEnd()}\n`)
}

function emptyDocument(format: RecoveryFormat): string {
  return format === 'json' ? '{}' : ''
}

function lookup(root: Record<string, unknown>, fields: string[]): { present: boolean; value?: unknown } {
  let value: unknown = root
  for (const field of fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !(field in value)) return { present: false }
    value = (value as Record<string, unknown>)[field]
  }
  return { present: true, value }
}

function sameLookup(left: { present: boolean; value?: unknown }, right: { present: boolean; value?: unknown }): boolean {
  return left.present === right.present && (!left.present || JSON.stringify(left.value) === JSON.stringify(right.value))
}

function setPath(root: Record<string, unknown>, fields: string[], value: unknown): void {
  let parent = root
  for (const field of fields.slice(0, -1)) {
    const existing = parent[field]
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) parent[field] = {}
    parent = parent[field] as Record<string, unknown>
  }
  parent[fields.at(-1)!] = value
}

function deletePath(root: Record<string, unknown>, fields: string[]): void {
  const parents: Array<[Record<string, unknown>, string]> = []
  let parent = root
  for (const field of fields.slice(0, -1)) {
    const value = parent[field]
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    parents.push([parent, field])
    parent = value as Record<string, unknown>
  }
  delete parent[fields.at(-1)!]
  for (const [owner, field] of parents.reverse()) {
    const value = owner[field]
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) delete owner[field]
    else break
  }
}

function ownedValueDigest(format: RecoveryFormat, content: string, fields: string[][]): string {
  const parsed = parseConfig(format, content, '적용 설정')
  return sha256(JSON.stringify(fields.map((item) => lookup(parsed, item))))
}

async function withTargetLock<T>(
  target: RecoveryTarget,
  options: RecoveryOptions,
  action: (root: string, protector: PayloadProtector) => Promise<T>,
): Promise<T> {
  const root = options.root ?? defaultRecoveryRoot()
  const protector = options.protector ?? new WindowsCurrentUserProtector()
  await mkdir(path.join(root, 'locks'), { recursive: true })
  const release = process.platform === 'win32'
    ? await acquireWindowsFileLock(path.join(root, 'locks', `${target}.lock`), target)
    : await acquireDirectoryLock(path.join(root, 'locks', `${target}.lock`), target)
  try {
    return await action(root, protector)
  } finally {
    await release()
  }
}

async function acquireWindowsFileLock(file: string, target: RecoveryTarget): Promise<() => Promise<void>> {
  const script = Buffer.from(String.raw`$ErrorActionPreference = 'Stop'
$filePath = [Console]::In.ReadLine()
try {
  $stream = [System.IO.File]::Open($filePath, 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
  [Console]::Error.Write('BUSY')
  exit 3
}
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
[Console]::In.ReadToEnd() | Out-Null
$stream.Dispose()`, 'utf16le').toString('base64')
  const child = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', script,
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.write(`${file}\n`)
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (value: string) => { stderr += value })
  await new Promise<void>((resolve, reject) => {
    let stdout = ''
    const onData = (value: string) => {
      stdout += value
      if (stdout.includes('READY')) {
        child.stdout.off('data', onData)
        resolve()
      }
    }
    child.stdout.setEncoding('utf8').on('data', onData)
    child.once('error', reject)
    child.once('close', (code) => {
      if (!stdout.includes('READY')) {
        reject(code === 3
          ? new RecoveryError('busy', `${target} 복구 작업이 다른 프로세스에서 진행 중입니다.`)
          : new Error(stderr || `lock helper exited ${code}`))
      }
    })
  })
  return async () => {
    child.stdin.end()
    await new Promise<void>((resolve) => child.once('close', () => resolve()))
  }
}

async function acquireDirectoryLock(directory: string, target: RecoveryTarget): Promise<() => Promise<void>> {
  try {
    await mkdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new RecoveryError('busy', `${target} 복구 작업이 다른 프로세스에서 진행 중입니다.`)
    }
    throw error
  }
  return () => rm(directory, { recursive: true, force: true })
}

async function readReceipt(target: RecoveryTarget, root: string): Promise<RecoveryReceipt> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(receiptPath(root, target), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RecoveryError('missing', `${target} receipt가 없습니다.`)
    throw new RecoveryError('corrupt', `${target} receipt를 읽지 못했습니다.`)
  }
  if (!isReceipt(value, target)) throw new RecoveryError('corrupt', `${target} receipt schema가 올바르지 않습니다.`)
  return value
}

function isReceipt(value: unknown, target: RecoveryTarget): value is RecoveryReceipt {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<RecoveryReceipt>
  return item.schemaVersion === RECEIPT_SCHEMA
    && item.target === target
    && typeof item.filePath === 'string'
    && typeof item.protectedPayload === 'string'
    && typeof item.beforeHash === 'string'
    && typeof item.appliedHash === 'string'
    && typeof item.originalValuesKnown === 'boolean'
    && typeof item.tempPath === 'string'
    && (item.pendingRemovalHash === undefined || typeof item.pendingRemovalHash === 'string')
    && (item.pendingRemovalExisted === undefined || typeof item.pendingRemovalExisted === 'boolean')
    && Array.isArray(item.ownedFields)
    && (item.state === 'PREPARED' || item.state === 'APPLIED' || item.state === 'REMOVED')
    && (item.format === 'json' || item.format === 'toml')
}

async function decodePayload(receipt: RecoveryReceipt, protector: PayloadProtector): Promise<RecoveryPayload> {
  try {
    const parsed = JSON.parse((await protector.unprotect(receipt.protectedPayload)).toString('utf8')) as Partial<RecoveryPayload>
    if (typeof parsed.beforeExisted !== 'boolean' || typeof parsed.beforeContent !== 'string' || typeof parsed.appliedContent !== 'string') {
      throw new Error('invalid payload')
    }
    if (parsed.binding !== receiptBinding(receipt)) throw new Error('receipt metadata mismatch')
    if (sha256(parsed.appliedContent) !== receipt.appliedHash) throw new Error('applied digest mismatch')
    if (ownedValueDigest(receipt.format, parsed.appliedContent, receipt.ownedFields) !== receipt.appliedValueDigest) {
      throw new Error('owned digest mismatch')
    }
    return parsed as RecoveryPayload
  } catch {
    throw new RecoveryError('corrupt', `${receipt.label} receipt payload가 손상되었거나 다른 사용자에게 속합니다.`)
  }
}

function receiptBinding(receipt: RecoveryReceipt): string {
  return sha256(JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    installationId: receipt.installationId,
    transactionId: receipt.transactionId,
    target: receipt.target,
    label: receipt.label,
    filePath: receipt.filePath,
    format: receipt.format,
    ownedFields: receipt.ownedFields,
    endpoint: receipt.endpoint,
    beforeHash: receipt.beforeHash,
    appliedHash: receipt.appliedHash,
    appliedValueDigest: receipt.appliedValueDigest,
    adopted: receipt.adopted,
    originalValuesKnown: receipt.originalValuesKnown,
    pendingRemovalHash: receipt.pendingRemovalHash,
    pendingRemovalExisted: receipt.pendingRemovalExisted,
    tempPath: receipt.tempPath,
    state: receipt.state,
    updatedAt: receipt.updatedAt,
  }))
}

async function sealReceipt(
  receipt: RecoveryReceipt,
  payload: Omit<RecoveryPayload, 'binding'> | RecoveryPayload,
  protector: PayloadProtector,
): Promise<void> {
  receipt.protectedPayload = await protector.protect(Buffer.from(JSON.stringify({
    beforeExisted: payload.beforeExisted,
    beforeContent: payload.beforeContent,
    appliedContent: payload.appliedContent,
    binding: receiptBinding(receipt),
  }), 'utf8'))
}

async function cleanupReceiptTemp(receipt: RecoveryReceipt): Promise<void> {
  const expected = `${path.resolve(receipt.filePath)}.baton-${receipt.transactionId}.tmp`
  if (path.resolve(receipt.tempPath) !== expected) {
    throw new RecoveryError('corrupt', `${receipt.label} receipt temp 경로가 올바르지 않습니다.`)
  }
  await rm(expected, { force: true })
}

async function writeReceipt(receipt: RecoveryReceipt, root: string): Promise<void> {
  const directory = path.join(root, 'receipts')
  await mkdir(directory, { recursive: true })
  const target = receiptPath(root, receipt.target)
  const temp = `${target}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flush: true,
  })
  await rename(temp, target)
}

function receiptPath(root: string, target: RecoveryTarget): string {
  return path.join(root, 'receipts', `${target}.json`)
}

async function replaceWithCas(
  file: string,
  expectedExisted: boolean,
  expectedContent: string,
  nextContent: string,
  nextExisted = true,
  temp = `${file}.baton-${randomUUID()}.tmp`,
  leaveTempAfterWrite = false,
): Promise<void> {
  const expectedHash = expectedExisted ? sha256(expectedContent) : sha256(Buffer.alloc(0))
  await mkdir(path.dirname(file), { recursive: true })
  if (!nextExisted) {
    const current = await readOptional(file)
    assertCas(file, current, expectedExisted, expectedHash)
    await rm(file, { force: true })
    return
  }
  await writeFile(temp, nextContent, { encoding: 'utf8', mode: 0o600, flush: true })
  if (leaveTempAfterWrite) throw new Error('simulated crash after plaintext temp write')
  try {
    // Re-read immediately before the atomic replacement. Preparing and
    // flushing the temporary file therefore cannot widen the CAS race.
    const current = await readOptional(file)
    assertCas(file, current, expectedExisted, expectedHash)
    // libuv implements rename as an atomic replace on the same volume,
    // including MOVEFILE_REPLACE_EXISTING on Windows.
    await rename(temp, file)
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
}

function assertCas(
  file: string,
  current: { existed: boolean; content: string },
  expectedExisted: boolean,
  expectedHash: string,
): void {
  const currentHash = current.existed ? sha256(current.content) : sha256(Buffer.alloc(0))
  if (current.existed !== expectedExisted || !safeHashEqual(currentHash, expectedHash)) {
    throw new RecoveryError('conflict', `${path.basename(file)}이 다른 프로세스에서 변경되어 쓰지 않았습니다.`)
  }
}

function safeHashEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

async function readOptional(file: string): Promise<{ existed: boolean; content: string }> {
  try {
    return { existed: true, content: await readFile(file, 'utf8') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { existed: false, content: '' }
    if (['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw new RecoveryError('busy', `${path.basename(file)} 설정 파일이 잠겨 있어 읽거나 변경하지 않았습니다.`)
    }
    throw error
  }
}

async function runDpapi(operation: 'Protect' | 'Unprotect', input: string): Promise<string> {
  const script = operation === 'Protect'
    ? `Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([string]($inputObject.items[0])); $out=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($out))`
    : `Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([string]($inputObject.items[0])); $out=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($out))`
  return runPowerShell(script, [input])
}

function runPowerShell(script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(
      `$ErrorActionPreference = 'Stop'\n$inputObject = [Console]::In.ReadToEnd() | ConvertFrom-Json\n${script}`,
      'utf16le',
    ).toString('base64')
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `PowerShell exited ${code}`)))
    child.stdin.end(JSON.stringify({ items: args }))
  })
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
