import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import type {
  CodexNativeScanFilter,
  NativeImportCommitRequest, NativeImportPreview, NativeImportPreviewCandidate, NativeImportPreviewRequest,
  NativeImportCommitState, NativeImportReceipt, NativeImportStore, NativeSessionCandidate, NativeSourceReader,
  NativeSourceClient, NativeSourceWarning,
} from './contracts.ts'
import { sha256, stableJson } from './source-utils.ts'

interface TokenPayload {
  version: 2
  nonce: string
  principalKey: string
  expiresAt: string
  sources: string[]
  codex: Required<CodexNativeScanFilter>
  candidates: Array<{
    id: string
    sourceClient: string
    parserVersion: string
    headDigest: string
    stateDigest: string
  }>
}

const MAX_PREVIEW_CANDIDATES = 10_000

export class NativeImportError extends Error {
  readonly code: 'invalid_token' | 'stale_preview' | 'invalid_request' | 'commit_in_progress'
  constructor(code: 'invalid_token' | 'stale_preview' | 'invalid_request' | 'commit_in_progress', message: string) {
    super(message)
    this.code = code
  }
}

export class NativeSessionImportService {
  readonly #store: NativeImportStore
  readonly #readers: NativeSourceReader[]
  readonly #secret: Buffer
  readonly #now: () => Date
  readonly #ttlMs: number
  readonly #activeCommits = new Set<string>()

  constructor(store: NativeImportStore, readers: NativeSourceReader[], options: {
    secret?: Buffer, now?: () => Date, ttlMs?: number,
  } = {}) {
    this.#store = store
    this.#readers = readers
    this.#secret = options.secret ?? store.getNativeImportSigningKey()
    this.#now = options.now ?? (() => new Date())
    this.#ttlMs = options.ttlMs ?? 10 * 60_000
  }

  async preview(request: NativeImportPreviewRequest = {}, principalKey = 'local'): Promise<NativeImportPreview & { summary: PreviewSummary }> {
    if (typeof principalKey !== 'string' || principalKey.length === 0 || principalKey.length > 256) {
      throw new NativeImportError('invalid_request', 'principal is invalid')
    }
    const sources = [...new Set(request.sources ?? ['codex_local', 'claude_desktop', 'claude_code'])]
    if (sources.length === 0 || sources.some((source) => source !== 'codex_local'
      && source !== 'claude_desktop' && source !== 'claude_code')) {
      throw new NativeImportError('invalid_request', 'sources contains an unsupported native source')
    }
    const codex = normalizeCodexFilter(request.codex)
    const scan = await this.#scan(sources, { includeRecords: false, codex })
    if (scan.inventoryOverflow) {
      const detail = scan.overflowCount == null ? '' : ` (${scan.overflowCount.toLocaleString('en-US')} reported)`
      throw new NativeImportError('invalid_request',
        `native import inventory exceeds the supported maximum of 10,000 candidates${detail}`)
    }
    const scanned = scan.candidates
    const preferred = preferDesktopIdentity(scanned)
    if (preferred.length > MAX_PREVIEW_CANDIDATES) {
      throw new NativeImportError('invalid_request',
        'native import inventory exceeds the supported maximum of 10,000 candidates')
    }
    const candidates = preferred.map((candidate) => this.#previewCandidate(candidate))
    const expiresAt = new Date(this.#now().getTime() + this.#ttlMs).toISOString()
    const payload: TokenPayload = {
      version: 2,
      nonce: randomBytes(18).toString('base64url'),
      principalKey,
      expiresAt,
      sources,
      codex,
      candidates: candidates.map((candidate) => ({
        id: candidate.candidateId,
        sourceClient: candidate.sourceClient,
        parserVersion: candidate.parserVersion,
        headDigest: headDigest(candidate.sourceHead),
        stateDigest: stateDigest(this.#store.getNativeImportState(candidate)),
      })),
    }
    return {
      token: this.#sign(payload), expiresAt, candidates,
      warnings: scan.warnings.map((warning) => warning.message), summary: previewSummary(candidates, scan.warnings),
    }
  }

  async commit(request: NativeImportCommitRequest, principalKey = 'local'): Promise<NativeImportReceipt & { summary: CommitSummary }> {
    if (typeof principalKey !== 'string' || principalKey.length === 0 || principalKey.length > 256) {
      throw new NativeImportError('invalid_request', 'principal is invalid')
    }
    if (!Array.isArray(request.candidateIds) || request.candidateIds.length === 0 || request.candidateIds.length > 10_000
      || request.candidateIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 256)) {
      throw new NativeImportError('invalid_request', 'candidateIds must contain at least one candidate')
    }
    const selected = [...new Set(request.candidateIds)]
    const token = this.#verify(request.token, principalKey)
    const allowed = new Map(token.candidates.map((candidate) => [candidate.id, candidate]))
    if (selected.some((id) => !allowed.has(id))) throw new NativeImportError('invalid_request', 'candidate is not in preview')
    const requestDigest = sha256(stableJson({ token: request.token, candidateIds: selected.slice().sort() }))
    const nonceHmac = this.#hmac(token.nonce)
    if (this.#activeCommits.has(nonceHmac)) {
      throw new NativeImportError('commit_in_progress', 'native import commit is already applying')
    }
    this.#activeCommits.add(nonceHmac)
    try {
      let state: NativeImportCommitState
      try {
        state = this.#store.beginNativeImportCommit(nonceHmac, principalKey, requestDigest,
          Date.parse(token.expiresAt) > this.#now().getTime())
      } catch (error) {
        if (error instanceof Error && error.message === 'native import token has no durable commit') {
          throw new NativeImportError('invalid_token', 'preview token expired')
        }
        throw error
      }
      if (state.status === 'completed') return { ...state.receipt, summary: commitSummary(state.receipt.results) }
      const results = [...state.receipt.results]
      if (results.some((result, index) => result.candidateId !== selected[index])) {
        throw new NativeImportError('invalid_request', 'durable commit progress does not match this request')
      }
      const selectedSources = [...new Set(selected.map((id) => (allowed.get(id) as TokenPayload['candidates'][number]).sourceClient))]
      const scan = await this.#scan(selectedSources, { includeRecords: false, codex: token.codex })
      const rescanned = preferDesktopIdentity(scan.candidates)
      const byId = new Map(rescanned.map((candidate) => [candidate.candidateId, candidate]))
      for (let index = results.length; index < selected.length; index += 1) {
        const id = selected[index] as string
        const expected = allowed.get(id) as TokenPayload['candidates'][number]
        const candidate = byId.get(id)
        const reader = scan.readersByCandidateId.get(id)
        const checkpoint = { tokenNonceHmac: nonceHmac, principalKey, requestDigest, candidateOrdinal: index }
        if (!candidate || !reader || !matchesTokenCandidate(candidate, expected)) {
          const result = { candidateId: id, status: 'stale' as const, error: 'source changed after preview' }
          this.#store.recordNativeImportCommitResult(checkpoint, result)
          results.push(result)
          continue
        }
        const current = this.#store.getNativeImportState(candidate)
        if (stateDigest(current) !== expected.stateDigest) {
          const result = { candidateId: id, status: 'stale' as const, error: 'Baton import state changed after preview' }
          this.#store.recordNativeImportCommitResult(checkpoint, result)
          results.push(result)
          continue
        }
        try {
          const materialized = await reader.materialize(candidate)
          if (!matchesTokenCandidate(materialized, expected)
            || !materialized.materialized
            || materialized.records.filter((record) => (record.item.visibility ?? 'portable') === 'portable').length
              !== materialized.portableItemCount
            || materialized.contentDigest !== materialized.prefixDigest
            || (materialized.records.at(-1)?.prefixDigest ?? sha256('')) !== materialized.prefixDigest) {
            const result = { candidateId: id, status: 'stale' as const, error: 'source changed during materialization' }
            this.#store.recordNativeImportCommitResult(checkpoint, result)
            results.push(result)
            continue
          }
          const latestState = this.#store.getNativeImportState(materialized)
          if (stateDigest(latestState) !== expected.stateDigest) {
            const result = { candidateId: id, status: 'stale' as const, error: 'Baton import state changed during materialization' }
            this.#store.recordNativeImportCommitResult(checkpoint, result)
            results.push(result)
            continue
          }
          const result = this.#store.commitNativeImport({ candidate: materialized, previewedState: latestState,
            commitCheckpoint: checkpoint })
          results.push(result)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const result = message === 'source_changed_after_scan'
            ? { candidateId: id, status: 'stale' as const, error: 'source changed during materialization' }
            : { candidateId: id, status: 'failed' as const, error: message }
          this.#store.recordNativeImportCommitResult(checkpoint, result)
          results.push(result)
        }
      }
      const completed = { results }
      this.#store.finishNativeImportCommit(nonceHmac, completed)
      return { ...completed, summary: commitSummary(results) }
    } finally {
      this.#activeCommits.delete(nonceHmac)
    }
  }

  #previewCandidate(candidate: NativeSessionCandidate): NativeImportPreviewCandidate {
    const state = this.#store.getNativeImportState(candidate)
    const status = !state ? 'new' : candidate.materialized
      ? state.contentDigest === candidate.contentDigest ? 'duplicate' : 'update_available'
      : 'existing'
    const { records: _records, sourceLocator: _sourceLocator, ...metadata } = candidate
    return { ...metadata, status }
  }

  async #scan(sources: string[], options: Parameters<NativeSourceReader['scan']>[0]): Promise<{
    candidates: NativeSessionCandidate[]
    warnings: NativeSourceWarning[]
    readersByCandidateId: Map<string, NativeSourceReader>
    inventoryOverflow: boolean
    overflowCount: number | null
  }> {
    const readers = this.#readers.filter((reader) =>
      (reader.sourceClients ?? [reader.sourceClient]).some((source) => sources.includes(source)))
    const settled = await Promise.all(readers.map(async (reader) => {
      try {
        const candidates = await reader.scan({ ...options, sources: sources as NativeSourceClient[] })
        const overflowCount = Number.isSafeInteger(reader.overflowCount) && (reader.overflowCount as number) >= 0
          ? reader.overflowCount as number : null
        return { candidates, warnings: [...(reader.lastScanWarnings ?? [])], reader,
          inventoryOverflow: reader.inventoryOverflow === true, overflowCount }
      }
      catch {
        return { candidates: [] as NativeSessionCandidate[], warnings: [{
          sourceClient: reader.sourceClient, status: 'unavailable' as const, code: 'reader_failed',
          message: `${reader.sourceClient} source could not be read`,
        }], reader, inventoryOverflow: false, overflowCount: null }
      }
    }))
    const supported = settled.flatMap((result) => result.candidates.map((candidate) => ({ candidate, reader: result.reader })))
      .filter(({ candidate }) => sources.includes(candidate.sourceClient))
    return {
      candidates: supported.map(({ candidate }) => candidate),
      readersByCandidateId: new Map(supported.map(({ candidate, reader }) => [candidate.candidateId, reader])),
      inventoryOverflow: settled.some((result) => result.inventoryOverflow),
      overflowCount: settled.reduce<number | null>((total, result) => result.overflowCount == null
        ? total : (total ?? 0) + result.overflowCount, null),
      warnings: settled.flatMap((result) => result.warnings).filter((warning) => sources.includes(warning.sourceClient)
        || (warning.sourceClient === 'claude_desktop' && sources.includes('claude_code'))),
    }
  }

  #sign(payload: TokenPayload): string {
    const encoded = Buffer.from(stableJson(payload)).toString('base64url')
    return `${encoded}.${this.#hmac(encoded)}`
  }

  #verify(token: string, principalKey: string): TokenPayload {
    const [encoded, signature, extra] = token.split('.')
    if (!encoded || !signature || extra || !safeEqual(signature, this.#hmac(encoded))) {
      throw new NativeImportError('invalid_token', 'preview token is invalid')
    }
    let payload: TokenPayload
    try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TokenPayload }
    catch { throw new NativeImportError('invalid_token', 'preview token is invalid') }
    if (!validTokenPayload(payload) || payload.principalKey !== principalKey) {
      throw new NativeImportError('invalid_token', 'preview token is invalid or belongs to another principal')
    }
    return payload
  }

  #hmac(value: string): string { return createHmac('sha256', this.#secret).update(value).digest('base64url') }
}

function validTokenPayload(payload: TokenPayload): boolean {
  return payload?.version === 2 && typeof payload.nonce === 'string' && payload.nonce.length >= 16
    && typeof payload.principalKey === 'string' && typeof payload.expiresAt === 'string'
    && Array.isArray(payload.sources) && payload.sources.every((source) => typeof source === 'string')
    && Array.isArray(payload.candidates) && payload.candidates.every((candidate) => candidate !== null
      && typeof candidate === 'object' && typeof candidate.id === 'string' && typeof candidate.parserVersion === 'string'
      && (candidate.sourceClient === 'codex_local' || candidate.sourceClient === 'claude_desktop'
        || candidate.sourceClient === 'claude_code')
      && typeof candidate.headDigest === 'string' && typeof candidate.stateDigest === 'string')
    && validCodexFilter(payload.codex)
}

function matchesTokenCandidate(candidate: NativeSessionCandidate, expected: TokenPayload['candidates'][number]): boolean {
  return candidate.candidateId === expected.id && candidate.sourceClient === expected.sourceClient
    && candidate.parserVersion === expected.parserVersion
    && headDigest(candidate.sourceHead) === expected.headDigest
}

function preferDesktopIdentity(candidates: NativeSessionCandidate[]): NativeSessionCandidate[] {
  const desktopCliIds = new Set(candidates.filter((candidate) => candidate.sourceClient === 'claude_desktop')
    .flatMap((candidate) => candidate.identityKeys.filter((key) => key.kind === 'cli_session_id').map((key) => key.value)))
  return candidates.filter((candidate) => candidate.sourceClient !== 'claude_code'
    || !candidate.identityKeys.some((key) => key.kind === 'cli_session_id' && desktopCliIds.has(key.value)))
}

function headDigest(head: NativeSessionCandidate['sourceHead']): string { return sha256(stableJson(head)) }
function stateDigest(state: ReturnType<NativeImportStore['getNativeImportState']>): string { return sha256(stableJson(state)) }
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface PreviewSummary { total: number, new: number, existing: number, updateAvailable: number, duplicate: number, unavailable: number, unsupported: number, portableItems: number, skippedItems: number, analysisPending: boolean }
function previewSummary(candidates: NativeImportPreviewCandidate[], warnings: NativeSourceWarning[] = []): PreviewSummary {
  return {
    total: candidates.length,
    new: candidates.filter((item) => item.status === 'new').length,
    existing: candidates.filter((item) => item.status === 'existing').length,
    updateAvailable: candidates.filter((item) => item.status === 'update_available').length,
    duplicate: candidates.filter((item) => item.status === 'duplicate').length,
    unavailable: warnings.filter((warning) => warning.status === 'unavailable')
      .reduce((sum, warning) => sum + (warning.count ?? 1), 0),
    unsupported: warnings.filter((warning) => warning.status === 'unsupported' || warning.status === 'corrupt')
      .reduce((sum, warning) => sum + (warning.count ?? 1), 0),
    portableItems: candidates.reduce((sum, item) => sum + item.portableItemCount, 0),
    skippedItems: candidates.reduce((sum, item) => sum + item.skippedItemCount, 0),
    analysisPending: candidates.some((item) => !item.materialized),
  }
}

const CODEX_ORIGINS = ['cli', 'ide_app', 'exec', 'other'] as const
const CODEX_ORIGIN_SET = new Set<string>(CODEX_ORIGINS)
function normalizeCodexFilter(filter: CodexNativeScanFilter | undefined): Required<CodexNativeScanFilter> {
  const origins: Required<CodexNativeScanFilter>['origins'] = [...new Set<Required<CodexNativeScanFilter>['origins'][number]>(
    filter?.origins ?? ['cli', 'ide_app'],
  )]
  if (origins.length === 0 || origins.some((origin) => !CODEX_ORIGIN_SET.has(origin))) {
    throw new NativeImportError('invalid_request', 'codex.origins contains an unsupported origin')
  }
  if ((filter?.includeSubagents !== undefined && typeof filter.includeSubagents !== 'boolean')
    || (filter?.includeArchived !== undefined && typeof filter.includeArchived !== 'boolean')) {
    throw new NativeImportError('invalid_request', 'codex filter flags must be boolean')
  }
  return { origins, includeSubagents: filter?.includeSubagents === true, includeArchived: filter?.includeArchived === true }
}

function validCodexFilter(filter: Required<CodexNativeScanFilter>): boolean {
  return filter !== null && typeof filter === 'object' && Array.isArray(filter.origins) && filter.origins.length > 0
    && filter.origins.every((origin) => CODEX_ORIGIN_SET.has(origin))
    && typeof filter.includeSubagents === 'boolean' && typeof filter.includeArchived === 'boolean'
}
export interface CommitSummary { total: number, imported: number, updated: number, duplicate: number, stale: number, failed: number }
function commitSummary(results: NativeImportReceipt['results']): CommitSummary {
  return {
    total: results.length,
    imported: results.filter((item) => item.status === 'imported').length,
    updated: results.filter((item) => item.status === 'updated').length,
    duplicate: results.filter((item) => item.status === 'duplicate').length,
    stale: results.filter((item) => item.status === 'stale').length,
    failed: results.filter((item) => item.status === 'failed').length,
  }
}
