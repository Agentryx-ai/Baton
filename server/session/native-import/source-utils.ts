import { createHash, createHmac } from 'node:crypto'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

import type { NativePortableRecord, NativeSourceHead } from './contracts.ts'

export const PARSER_VERSION = 'native-session-v1'
/** Above the largest observed live transcript (~248 MiB), while still bounding a single read. */
export const MAX_NATIVE_FILE_BYTES = 256 * 1024 * 1024
/** Observed live maxima are 14,169 Codex and 78,101 Claude lines. */
export const MAX_NATIVE_PHYSICAL_LINES = 250_000
export const MAX_NATIVE_PORTABLE_RECORDS = 250_000
export const MAX_NATIVE_CANDIDATES = 10_000
const MAX_TOOL_STRING_BYTES = 512
const MAX_TOOL_JSON_BYTES = 8 * 1024
const MAX_TOOL_COLLECTION_ENTRIES = 64
const MAX_TOOL_DEPTH = 6
const MAX_REASONING_SUMMARY_BYTES = 16 * 1024

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
}

export function candidateId(parts: string[]): string {
  return sha256(parts.join('\0'))
}

export function pseudonymousNamespace(secret: Buffer, purpose: string, canonicalRootPath: string, provenance = ''): string {
  if (!Buffer.isBuffer(secret) || secret.byteLength < 32) throw new Error('native_import_namespace_secret_invalid')
  return createHmac('sha256', secret)
    .update(stableJson({ version: 1, purpose, canonicalRoot: normalizePath(canonicalRootPath), provenance }))
    .digest('base64url')
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

export async function canonicalRoot(root: string): Promise<string> {
  const value = await realpath(root)
  const metadata = await stat(value)
  if (!metadata.isDirectory()) throw new Error('native_source_root_not_directory')
  return value
}

export async function containedRealPath(root: string, child: string): Promise<string> {
  const canonicalChild = await realpath(child)
  const relative = path.relative(root, canonicalChild)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('native_source_path_escape')
  }
  return canonicalChild
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[], concurrency: number, mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency))
  const results = new Array<R>(values.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= values.length) return
      results[index] = await mapper(values[index] as T, index)
    }
  })
  await Promise.all(workers)
  return results
}

export function safeAlias(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const normalized = [...value.normalize('NFC')]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0
      return code < 32 || code === 127 ? ' ' : character
    })
    .join('').replace(/\s+/g, ' ').trim()
  if (!normalized || secretLike(normalized)) return fallback
  return normalized.slice(0, 160)
}

export function cwdAlias(cwd: string | null, fallback: string): string {
  return cwd ? safeAlias(path.basename(cwd), fallback) : fallback
}

export async function readStableFile(filePath: string): Promise<{ text: string, head: NativeSourceHead }> {
  const before = await stat(filePath)
  if (before.size > MAX_NATIVE_FILE_BYTES) throw new Error('native_source_file_size_limit')
  const content = await readFile(filePath)
  const after = await stat(filePath)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('source_changed_during_scan')
  if (after.size > MAX_NATIVE_FILE_BYTES) throw new Error('native_source_file_size_limit')
  return {
    text: content.toString('utf8'),
    head: { size: after.size, mtimeMs: after.mtimeMs, finalRecordDigest: sha256(content.subarray(Math.max(0, content.length - 4096))) },
  }
}

/**
 * Inventories a transcript without loading it. The bounded tail digest detects replacement while
 * keeping preview work independent of lifetime transcript size.
 */
export async function inspectStableFile(filePath: string): Promise<NativeSourceHead> {
  const before = await stat(filePath)
  if (!before.isFile()) throw new Error('native_source_not_file')
  if (before.size > MAX_NATIVE_FILE_BYTES) throw new Error('native_source_file_size_limit')
  const length = Math.min(4096, before.size)
  const tail = Buffer.alloc(length)
  const handle = await open(filePath, 'r')
  try {
    if (length > 0) {
      const { bytesRead } = await handle.read(tail, 0, length, before.size - length)
      if (bytesRead !== length) throw new Error('source_changed_during_scan')
    }
  } finally {
    await handle.close()
  }
  const after = await stat(filePath)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('source_changed_during_scan')
  return { size: after.size, mtimeMs: after.mtimeMs, finalRecordDigest: sha256(tail) }
}

export function finalizeRecords(records: Omit<NativePortableRecord, 'prefixDigest'>[]): NativePortableRecord[] {
  let prefix = sha256('')
  return records.map((record) => {
    prefix = sha256(`${prefix}\0${record.digest}`)
    return { ...record, prefixDigest: prefix }
  })
}

export class NativeRecordAccumulator {
  readonly #includeRecords: boolean
  readonly #records: NativePortableRecord[] = []
  #prefixDigest = sha256('')
  #count = 0
  #portableCount = 0

  constructor(includeRecords: boolean) { this.#includeRecords = includeRecords }

  get count(): number { return this.#count }
  get portableCount(): number { return this.#portableCount }
  get contentDigest(): string { return this.#prefixDigest }
  get records(): NativePortableRecord[] { return this.#records }

  add(record: Omit<NativePortableRecord, 'prefixDigest'>): void {
    if (this.#count >= MAX_NATIVE_PORTABLE_RECORDS) throw new Error('native_source_portable_record_limit')
    this.#prefixDigest = sha256(`${this.#prefixDigest}\0${record.digest}`)
    this.#count += 1
    if (record.item.visibility === 'portable') this.#portableCount += 1
    if (this.#includeRecords) this.#records.push({ ...record, prefixDigest: this.#prefixDigest })
  }
}

export function* nativePhysicalLines(text: string): IterableIterator<[number, string]> {
  let start = 0
  let count = 0
  while (start <= text.length) {
    count += 1
    if (count > MAX_NATIVE_PHYSICAL_LINES) throw new Error('native_source_physical_line_limit')
    const newline = text.indexOf('\n', start)
    if (newline < 0) { yield [count - 1, text.slice(start)]; return }
    const end = newline > start && text.charCodeAt(newline - 1) === 13 ? newline - 1 : newline
    yield [count - 1, text.slice(start, end)]
    start = newline + 1
  }
}

export interface SanitizedToolValue { value: unknown, lossCount: number }

/**
 * Tool inputs retain only bounded non-content metadata. File bodies, commands, credentials,
 * environment data and unknown strings are omitted deliberately.
 */
export function sanitizeToolInput(value: unknown): SanitizedToolValue {
  return sanitizeToolValue(value, 'input')
}

/** Tool outputs never retain raw string/array bodies; structured status metadata is allowlisted. */
export function sanitizeToolResult(value: unknown): SanitizedToolValue {
  return sanitizeToolValue(value, 'result')
}

export function sanitizeReasoningSummary(value: string): { value: string | null, lossCount: number } {
  let lossCount = 0
  let sanitized = value
  const patterns = [
    /\b(?:access_token|refresh_token|auth_token|api[_-]?key|password|passwd|secret)\s*[:=]\s*[^\s&;,]+/gi,
    /\bbearer\s+[a-z0-9._-]{12,}/gi,
    /\bsk-[a-z0-9_-]{12,}/gi,
    /\beyJ[a-z0-9_-]{20,}\.[a-z0-9_-]{10,}(?:\.[a-z0-9_-]{10,})?/gi,
    /[a-z0-9+/]{96,}={0,2}/gi,
  ]
  if (/-----BEGIN [A-Z ]+PRIVATE KEY-----/i.test(sanitized)) return { value: null, lossCount: 1 }
  for (const pattern of patterns) sanitized = sanitized.replace(pattern, () => {
    lossCount += 1
    return '[redacted]'
  })
  sanitized = sanitized.replace(/([?&](?:access_token|refresh_token|auth_token|token|api_key|password)=)[^&#\s]+/gi, (_match, prefix: string) => {
    lossCount += 1
    return `${prefix}[redacted]`
  })
  if (Buffer.byteLength(sanitized, 'utf8') > MAX_REASONING_SUMMARY_BYTES) {
    lossCount += 1
    sanitized = `${Buffer.from(sanitized).subarray(0, MAX_REASONING_SUMMARY_BYTES).toString('utf8')}…[truncated]`
  }
  return { value: sanitized.trim() || null, lossCount }
}

function sanitizeToolValue(value: unknown, mode: 'input' | 'result'): SanitizedToolValue {
  if (mode === 'result' && (typeof value === 'string' || Array.isArray(value))) {
    return { value: omittedSummary(value, 'Tool output omitted'), lossCount: Array.isArray(value) ? Math.max(1, value.length) : 1 }
  }
  const state = { lossCount: 0 }
  const sanitized = sanitizeNode(value, null, 0, state)
  let result: unknown = sanitized ?? { summary: 'Sensitive or content-bearing tool data omitted' }
  if (Buffer.byteLength(stableJson(result), 'utf8') > MAX_TOOL_JSON_BYTES) {
    state.lossCount += 1
    result = { summary: 'Tool metadata exceeded the portable size limit' }
  }
  return { value: result, lossCount: state.lossCount }
}

function sanitizeNode(
  value: unknown, key: string | null, depth: number, state: { lossCount: number },
): unknown {
  if (depth > MAX_TOOL_DEPTH || (key !== null && deniedToolKey(key))) { state.lossCount += 1; return undefined }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') {
    if (key === null || !safeStringMetadataKey(key)) { state.lossCount += 1; return undefined }
    if (secretLike(value)) { state.lossCount += 1; return '[redacted]' }
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes <= MAX_TOOL_STRING_BYTES) return value
    state.lossCount += 1
    return `${Buffer.from(value).subarray(0, MAX_TOOL_STRING_BYTES).toString('utf8')}…[truncated]`
  }
  if (Array.isArray(value)) {
    if (key === null || !safeCollectionMetadataKey(key)) { state.lossCount += Math.max(1, value.length); return undefined }
    const retained = value.slice(0, MAX_TOOL_COLLECTION_ENTRIES)
      .map((child) => sanitizeNode(child, key, depth + 1, state)).filter((child) => child !== undefined)
    if (value.length > retained.length) state.lossCount += value.length - retained.length
    return retained
  }
  if (!value || typeof value !== 'object') { state.lossCount += 1; return undefined }
  const entries = Object.entries(value as Record<string, unknown>)
  const retained: Array<[string, unknown]> = []
  for (const [childKey, child] of entries.slice(0, MAX_TOOL_COLLECTION_ENTRIES)) {
    const sanitized = sanitizeNode(child, childKey, depth + 1, state)
    if (sanitized !== undefined) retained.push([childKey, sanitized])
  }
  if (entries.length > MAX_TOOL_COLLECTION_ENTRIES) state.lossCount += entries.length - MAX_TOOL_COLLECTION_ENTRIES
  return retained.length ? Object.fromEntries(retained) : undefined
}

function deniedToolKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLocaleLowerCase('en-US')
  return /(?:content|body|blob|bytes|base64|authorization|cookie|token|password|passwd|secret|apikey|credential|environment|env|header|command|script|query|prompt|patch|diff|oldstring|newstring|stdout|stderr|output|response|request)/.test(normalized)
}

function safeStringMetadataKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLocaleLowerCase('en-US')
  return /(?:path|filepath|notebookpath|cwd|workingdirectory|name|id|status|type|operation|mode|language|encoding|reason|code|method|host|url)$/.test(normalized)
}

function safeCollectionMetadataKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLocaleLowerCase('en-US')
  return /(?:paths|files|ids|statuses|types|operations|modes|languages)$/.test(normalized)
}

function secretLike(value: string): boolean {
  return /(?:sk-[a-z0-9_-]{12,}|bearer\s+[a-z0-9._-]{12,}|(?:access_token|refresh_token|auth_token|api[_-]?key|password|passwd|secret)\s*[:=]|[?&](?:access_token|refresh_token|auth_token|token|api_key|password)=|-----BEGIN [A-Z ]+PRIVATE KEY-----|eyJ[a-z0-9_-]{20,}\.[a-z0-9_-]{10,}\.|[a-z0-9+/]{96,}={0,2})/i.test(value)
}

function omittedSummary(value: string | unknown[], summary: string): Record<string, unknown> {
  return { summary, originalBytes: estimateValueBytes(value) }
}

function estimateValueBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8')
  if (value === null) return 4
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).length
  if (Array.isArray(value)) return value.reduce((sum, child) => sum + estimateValueBytes(child) + 1, 2)
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .reduce((sum, [key, child]) => sum + Buffer.byteLength(key, 'utf8') + estimateValueBytes(child) + 4, 2)
  }
  return 0
}

export function contentDigest(records: NativePortableRecord[]): string {
  return records.at(-1)?.prefixDigest ?? sha256('')
}

export function messageText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return null
  const parts = value.flatMap((part) => {
    if (typeof part === 'string') return [part]
    if (!part || typeof part !== 'object') return []
    const object = part as Record<string, unknown>
    return typeof object.text === 'string' ? [object.text] : []
  })
  return parts.length ? parts.join('\n') : null
}
