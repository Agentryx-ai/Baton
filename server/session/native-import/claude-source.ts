import { homedir } from 'node:os'
import path from 'node:path'
import { readdir, readFile, realpath } from 'node:fs/promises'

import type {
  NativePortableRecord, NativeSessionCandidate, NativeSourceClient, NativeSourceReader,
  NativeSourceScanOptions, NativeSourceWarning,
} from './contracts.ts'
import {
  candidateId, canonicalRoot, containedRealPath, cwdAlias, mapWithConcurrency,
  MAX_NATIVE_CANDIDATES, nativePhysicalLines, NativeRecordAccumulator, PARSER_VERSION,
  pseudonymousNamespace, readStableFile, safeAlias, sanitizeToolInput, sanitizeToolResult,
  sha256, stableJson,
} from './source-utils.ts'

interface ClaudeDesktopMetadata {
  sessionId?: unknown
  cliSessionId?: unknown
  cwd?: unknown
  title?: unknown
  titleSource?: unknown
  createdAt?: unknown
  lastActivityAt?: unknown
}

interface NativeTitle { value: string, source: 'custom-title' | 'ai-title' | 'agent-name' }
interface ParsedClaudeRecords {
  records: NativePortableRecord[]
  contentDigest: string
  portableItemCount: number
  cwd: string | null
  createdAt: string | null
  updatedAt: string | null
  skipped: number
  title: NativeTitle | null
  warnings: string[]
}

const CLAUDE_TOP_LEVEL_TYPES = new Set([
  'user', 'assistant', 'system', 'queue-operation', 'file-history-snapshot', 'file-history-delta',
  'attachment', 'last-prompt', 'mode', 'permission-mode', 'ai-title', 'custom-title', 'agent-name',
  'progress', 'agent-progress', 'bash-progress', 'hook-progress', 'summary',
  // Current Claude Code/Desktop bookkeeping records. Their framing is known, but they carry no
  // portable conversation item, so they are counted as loss below.
  'bridge-session', 'pr-link', 'started', 'result', 'frame-link',
])
const CLAUDE_BLOCK_TYPES = new Set([
  'text', 'thinking', 'redacted_thinking', 'tool_use', 'tool_result', 'fallback', 'image', 'document',
  'server_tool_use', 'web_search_tool_result',
])

export interface ClaudeSourceReaderOptions {
  desktopRoot?: string
  projectsRoot?: string
  namespaceSecret?: Buffer
  profileProvenance?: string
  concurrency?: number
}

export class ClaudeLocalSourceReader implements NativeSourceReader {
  readonly sourceClient = 'claude_desktop' as const
  readonly sourceClients = ['claude_desktop', 'claude_code'] as const
  readonly #desktopRoot: string
  readonly #projectsRoot: string
  readonly #namespaceSecret: Buffer | undefined
  readonly #profileProvenance: string
  readonly #concurrency: number
  #warnings: NativeSourceWarning[] = []
  #inventoryOverflow = false
  #overflowCount: number | undefined

  constructor(options: ClaudeSourceReaderOptions = {}) {
    this.#desktopRoot = path.resolve(options.desktopRoot ?? path.join(process.env.APPDATA ?? '', 'Claude', 'claude-code-sessions'))
    this.#projectsRoot = path.resolve(options.projectsRoot ?? path.join(homedir(), '.claude', 'projects'))
    this.#namespaceSecret = options.namespaceSecret
    this.#profileProvenance = options.profileProvenance ?? ''
    this.#concurrency = options.concurrency ?? 1
  }

  get lastScanWarnings(): readonly NativeSourceWarning[] { return this.#warnings }
  get inventoryOverflow(): boolean { return this.#inventoryOverflow }
  get overflowCount(): number | undefined { return this.#overflowCount }

  async scan(options: NativeSourceScanOptions = {}): Promise<NativeSessionCandidate[]> {
    const includeRecords = options.includeRecords ?? true
    this.#warnings = []
    this.#inventoryOverflow = false
    this.#overflowCount = undefined
    let projectsRoot: string
    let transcriptNamespace: string
    try {
      projectsRoot = await canonicalRoot(this.#projectsRoot)
      transcriptNamespace = pseudonymousNamespace(
        this.#namespaceSecret as Buffer, 'claude-transcript-store', projectsRoot, this.#profileProvenance,
      )
    } catch (error) {
      const code = errorCode(error, 'claude_transcript_store_unavailable')
      this.#warn('unavailable', code, 'Claude transcript store is unavailable or its installation identity is not configured', 1, 'claude_code')
      this.#warn('unavailable', code, 'Claude transcript store is unavailable or its installation identity is not configured', 1, 'claude_desktop')
      return []
    }

    let transcriptWalk: WalkResult
    try { transcriptWalk = await walk(projectsRoot, '.jsonl', MAX_NATIVE_CANDIDATES + 1) }
    catch (error) {
      const code = errorCode(error, 'claude_transcript_scan_failed')
      this.#warn('unavailable', code, 'Claude transcript store could not be scanned safely', 1, 'claude_code')
      this.#warn('unavailable', code, 'Claude transcript store could not be scanned safely', 1, 'claude_desktop')
      return []
    }
    if (transcriptWalk.files.length > MAX_NATIVE_CANDIDATES || transcriptWalk.truncated) {
      this.#setInventoryOverflow(Math.max(1, transcriptWalk.files.length - MAX_NATIVE_CANDIDATES))
      this.#warn('unsupported', 'claude_transcript_scan_limit', 'Claude transcript inventory exceeds its safety limit', 1, 'claude_code')
      return []
    }
    this.#recordWalkWarnings('claude_transcript', transcriptWalk, 'claude_code')
    const transcripts = new Map<string, string>()
    const ambiguousTranscriptIds = new Set<string>()
    for (const file of transcriptWalk.files) {
      const id = path.basename(file, '.jsonl')
      if (transcripts.has(id) || ambiguousTranscriptIds.has(id)) {
        this.#warn('corrupt', 'claude_duplicate_cli_session_id', 'A duplicate Claude CLI session id was skipped', 1, 'claude_code')
        transcripts.delete(id)
        ambiguousTranscriptIds.add(id)
      } else transcripts.set(id, file)
    }

    let desktopRoot: string | null = null
    try { desktopRoot = await canonicalRoot(this.#desktopRoot) }
    catch { this.#warn('unavailable', 'claude_desktop_store_unavailable', 'Claude Desktop session metadata is unavailable; CLI transcripts remain importable') }
    let metadataWalk: WalkResult = { files: [], truncated: false, blockedLinks: 0 }
    if (desktopRoot) {
      try { metadataWalk = await walk(desktopRoot, '.json', MAX_NATIVE_CANDIDATES + 1) }
      catch (error) {
        this.#warn('unavailable', errorCode(error, 'claude_desktop_scan_failed'), 'Claude Desktop metadata could not be scanned safely; CLI transcripts remain importable')
      }
    }
    if (metadataWalk.files.length > MAX_NATIVE_CANDIDATES || metadataWalk.truncated) {
      this.#setInventoryOverflow(Math.max(1, metadataWalk.files.length - MAX_NATIVE_CANDIDATES))
      this.#warn('unsupported', 'claude_desktop_scan_limit', 'Claude Desktop inventory exceeds its safety limit')
      return []
    }
    this.#recordWalkWarnings('claude_desktop', metadataWalk, 'claude_desktop')

    const claimed = new Set<string>()
    const desktopCandidates = await mapWithConcurrency(metadataWalk.files, this.#concurrency, async (metadataPath) => {
      let metadata: ClaudeDesktopMetadata
      try {
        const parsed = JSON.parse(await readFile(metadataPath, 'utf8')) as unknown
        metadata = object(parsed) ?? fail('claude_metadata_framing_invalid')
      } catch (error) {
        this.#warn('corrupt', errorCode(error, 'claude_metadata_json_corrupt'), 'A corrupt Claude Desktop metadata record was skipped')
        return null
      }
      const sessionId = string(metadata.sessionId)
      const cliSessionId = string(metadata.cliSessionId)
      const transcriptPath = cliSessionId ? transcripts.get(cliSessionId) : undefined
      if (!sessionId || !cliSessionId) {
        this.#warn('unsupported', 'claude_metadata_identity_missing', 'A Claude Desktop metadata record without supported session identities was skipped')
        return null
      }
      if (!transcriptPath) {
        this.#warn('unavailable', 'claude_desktop_transcript_unavailable', 'A Claude Desktop task has no matching local CLI transcript')
        return null
      }
      if (claimed.has(cliSessionId)) {
        this.#warn('corrupt', 'claude_duplicate_desktop_binding', 'A duplicate Claude Desktop binding for one CLI transcript was skipped')
        return null
      }
      claimed.add(cliSessionId)
      try {
        const profileRoot = await desktopProfileRoot(desktopRoot as string, metadataPath)
        const namespaceKey = pseudonymousNamespace(
          this.#namespaceSecret as Buffer, 'claude-desktop-profile', profileRoot, this.#profileProvenance,
        )
        const candidate = await this.#candidate(
          'claude_desktop', sessionId, cliSessionId, transcriptPath, metadata, projectsRoot,
          namespaceKey, transcriptNamespace, includeRecords,
        )
        return candidate
      } catch (error) {
        claimed.delete(cliSessionId)
        this.#warn(warningStatus(error), errorCode(error, 'claude_desktop_candidate_corrupt'), 'A Claude Desktop task was skipped because its source was corrupt, unsupported, or escaped its configured store')
        return null
      }
    })

    const unclaimed = [...transcripts].filter(([cliSessionId]) => !claimed.has(cliSessionId))
    const cliCandidates = await mapWithConcurrency(unclaimed, this.#concurrency, async ([cliSessionId, transcriptPath]) => {
      try {
        return await this.#candidate(
          'claude_code', cliSessionId, cliSessionId, transcriptPath, {}, projectsRoot,
          transcriptNamespace, transcriptNamespace, includeRecords,
        )
      } catch (error) {
        this.#warn(warningStatus(error), errorCode(error, 'claude_cli_candidate_corrupt'), 'A Claude CLI task was skipped because its transcript was corrupt, unsupported, or escaped its configured store', 1, 'claude_code')
        return null
      }
    })
    const candidates = [...desktopCandidates, ...cliCandidates]
      .filter((candidate): candidate is NativeSessionCandidate => candidate !== null)
    if (candidates.length > MAX_NATIVE_CANDIDATES) {
      const excess = candidates.length - MAX_NATIVE_CANDIDATES
      this.#setInventoryOverflow(excess)
      this.#warn('unsupported', 'claude_candidate_scan_limit', 'Claude candidate scan reached its safety limit', excess, 'claude_code')
      this.#warn('unsupported', 'claude_candidate_scan_limit', 'Claude candidate scan reached its safety limit', excess, 'claude_desktop')
      return []
    }
    return candidates
  }

  async #candidate(
    sourceClient: Extract<NativeSourceClient, 'claude_desktop' | 'claude_code'>,
    nativeSessionId: string,
    cliSessionId: string,
    transcriptPath: string,
    metadata: ClaudeDesktopMetadata,
    projectsRoot: string,
    namespaceKey: string,
    transcriptNamespace: string,
    includeRecords: boolean,
  ): Promise<NativeSessionCandidate> {
    const canonicalTranscript = await containedRealPath(projectsRoot, transcriptPath)
    const source = await readStableFile(canonicalTranscript)
    const parsed = parseClaudeRecords(source.text, cliSessionId, sourceClient, includeRecords)
    const cwd = string(metadata.cwd) ?? parsed.cwd
    const metadataTitle = string(metadata.title)
    const fallback = cwdAlias(cwd, 'Claude task')
    const title = metadataTitle
      ? { value: metadataTitle, source: `metadata:${provenanceToken(metadata.titleSource)}` }
      : parsed.title
    const alias = title ? safeAlias(title.value, fallback) : fallback
    const nativeAlias = title !== null && alias !== fallback
    return {
      candidateId: candidateId([sourceClient, namespaceKey, nativeSessionId]),
      sourceClient,
      provider: 'claude',
      namespaceKey,
      nativeSessionId,
      sourceAlias: alias,
      aliasSource: nativeAlias ? 'native' : cwd ? 'path_fallback' : 'generated',
      titleSource: nativeAlias ? title.source : null,
      projectAlias: cwd ? cwdAlias(cwd, 'Claude') : null,
      projectGroupKey: cwd
        ? pseudonymousNamespace(this.#namespaceSecret as Buffer, 'native-project', cwd)
        : null,
      cwd,
      createdAt: string(metadata.createdAt) ?? parsed.createdAt,
      updatedAt: string(metadata.lastActivityAt) ?? parsed.updatedAt,
      sourceHead: source.head,
      contentDigest: parsed.contentDigest,
      prefixDigest: parsed.contentDigest,
      portableItemCount: parsed.portableItemCount,
      sourceLocator: { path: canonicalTranscript },
      records: parsed.records,
      skippedItemCount: parsed.skipped,
      parserVersion: PARSER_VERSION,
      warnings: parsed.warnings,
      identityKeys: [
        { kind: 'native_session_id', value: nativeSessionId, scopeNamespaceKey: namespaceKey },
        { kind: 'cli_session_id', value: cliSessionId, scopeNamespaceKey: transcriptNamespace },
      ],
    }
  }

  async materialize(candidate: NativeSessionCandidate): Promise<NativeSessionCandidate> {
    if ((candidate.sourceClient !== 'claude_desktop' && candidate.sourceClient !== 'claude_code')
      || candidate.provider !== 'claude' || !candidate.sourceLocator?.path) {
      throw new Error('claude_candidate_locator_invalid')
    }
    const projectsRoot = await canonicalRoot(this.#projectsRoot)
    const transcriptNamespace = pseudonymousNamespace(
      this.#namespaceSecret as Buffer, 'claude-transcript-store', projectsRoot, this.#profileProvenance,
    )
    const cliIdentity = candidate.identityKeys.find((key) => key.kind === 'cli_session_id')
    const nativeIdentity = candidate.identityKeys.find((key) => key.kind === 'native_session_id')
    if (!cliIdentity || cliIdentity.scopeNamespaceKey !== transcriptNamespace || !nativeIdentity
      || nativeIdentity.scopeNamespaceKey !== candidate.namespaceKey
      || (candidate.sourceClient === 'claude_code' && candidate.namespaceKey !== transcriptNamespace)
      || candidate.candidateId !== candidateId([candidate.sourceClient, candidate.namespaceKey, candidate.nativeSessionId])) {
      throw new Error('claude_candidate_identity_mismatch')
    }
    const sourcePath = await containedRealPath(projectsRoot, candidate.sourceLocator.path)
    const source = await readStableFile(sourcePath)
    const parsed = parseClaudeRecords(source.text, cliIdentity.value, candidate.sourceClient, true)
    if (stableJson(source.head) !== stableJson(candidate.sourceHead)
      || parsed.contentDigest !== candidate.contentDigest
      || parsed.contentDigest !== candidate.prefixDigest
      || parsed.portableItemCount !== candidate.portableItemCount
      || parsed.skipped !== candidate.skippedItemCount) {
      throw new Error('source_changed_after_scan')
    }
    return { ...candidate, sourceLocator: { path: sourcePath }, records: parsed.records }
  }

  #recordWalkWarnings(prefix: string, result: WalkResult, sourceClient: NativeSourceClient): void {
    if (result.truncated) this.#warn('unsupported', `${prefix}_scan_limit`, 'A native source scan reached its safety file limit', 1, sourceClient)
    if (result.blockedLinks) this.#warn('corrupt', `${prefix}_link_blocked`, 'Symbolic links or junctions inside a native source store were ignored', result.blockedLinks, sourceClient)
  }

  #setInventoryOverflow(overflowCount: number): void {
    this.#inventoryOverflow = true
    this.#overflowCount = overflowCount
  }

  #warn(
    status: NativeSourceWarning['status'], code: string, message: string, count = 1,
    sourceClient: NativeSourceClient = 'claude_desktop',
  ): void {
    const existing = this.#warnings.find((warning) => warning.sourceClient === sourceClient && warning.status === status && warning.code === code)
    if (existing) existing.count = (existing.count ?? 1) + count
    else this.#warnings.push({ sourceClient, status, code, message, count })
  }
}

function parseClaudeRecords(
  text: string, sessionId: string, sourceClient: NativeSourceClient, includeRecords: boolean,
): ParsedClaudeRecords {
  const records = new NativeRecordAccumulator(includeRecords)
  const toolNames = new Map<string, string>()
  let cwd: string | null = null
  let createdAt: string | null = null
  let updatedAt: string | null = null
  let skipped = 0
  let customTitle: NativeTitle | null = null
  let aiTitle: NativeTitle | null = null
  let agentName: NativeTitle | null = null
  for (const [lineIndex, line] of nativePhysicalLines(text)) {
    if (!line.trim()) continue
    let event: Record<string, unknown>
    try {
      const parsed = JSON.parse(line) as unknown
      event = object(parsed) ?? fail('claude_record_framing_invalid')
    } catch (error) {
      if (error instanceof Error && error.message === 'claude_record_framing_invalid') throw error
      throw new Error('claude_json_corrupt')
    }
    const eventType = string(event.type)
    if (!eventType || !CLAUDE_TOP_LEVEL_TYPES.has(eventType)) throw new Error('claude_top_level_type_unsupported')
    cwd ??= string(event.cwd)
    const timestamp = string(event.timestamp)
    createdAt ??= timestamp
    updatedAt = timestamp ?? updatedAt
    if (eventType === 'custom-title' || eventType === 'ai-title' || eventType === 'agent-name') {
      const recordSessionId = string(event.sessionId)
      const field = eventType === 'custom-title' ? 'customTitle' : eventType === 'ai-title' ? 'aiTitle' : 'agentName'
      const value = string(event[field])
      if (!recordSessionId || !value) throw new Error('claude_title_record_framing_invalid')
      if (recordSessionId !== sessionId) { skipped += 1; continue }
      const title = { value, source: eventType } as NativeTitle
      if (eventType === 'custom-title') customTitle = title
      else if (eventType === 'ai-title') aiTitle = title
      else agentName = title
      continue
    }
    if (eventType === 'file-history-delta') {
      const trackingPath = string(event.trackingPath)
      const key = string(event.messageId) ?? `${sessionId}:${lineIndex + 1}:file`
      addClaudeRecord(records, key, 'file_change', {
        operation: 'file-history-delta', path: trackingPath,
        summary: trackingPath ? `Changed ${path.basename(trackingPath)}` : 'File changed',
      }, timestamp, sourceClient)
      continue
    }
    if (eventType !== 'user' && eventType !== 'assistant') { skipped += 1; continue }
    const message = object(event.message)
    if (!message || !('content' in message)) throw new Error('claude_message_framing_invalid')
    const content = message.content
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : null
    if (!blocks) throw new Error('claude_message_content_framing_invalid')
    const baseId = string(event.uuid) ?? `${sessionId}:${lineIndex + 1}`
    const recordCountBeforeMessage = records.count
    const skippedBeforeMessage = skipped
    const textParts: string[] = []
    let textSegment = 0
    const flushText = () => {
      if (!textParts.length) return
      const kind = eventType === 'user' ? 'user_message' : 'assistant_message'
      addClaudeRecord(records, `${baseId}:text:${textSegment++}`, kind, { text: textParts.join('\n') }, timestamp, sourceClient)
      textParts.length = 0
    }
    for (const [blockIndex, rawBlock] of blocks.entries()) {
      const block = object(rawBlock)
      const blockType = block ? string(block.type) : null
      if (!block || !blockType || !CLAUDE_BLOCK_TYPES.has(blockType)) throw new Error('claude_content_block_unsupported')
      if (blockType === 'text') {
        const value = string(block.text)
        if (!value) throw new Error('claude_text_block_framing_invalid')
        textParts.push(value)
        continue
      }
      flushText()
      if (blockType === 'tool_use') {
        const rawCallId = string(block.id)
        const rawName = string(block.name)
        if (!rawCallId || !rawName) throw new Error('claude_tool_use_framing_invalid')
        const callId = safeAlias(rawCallId, `${baseId}:block:${blockIndex}`)
        const name = safeAlias(rawName, 'tool')
        toolNames.set(callId, name)
        const sanitized = sanitizeToolInput(block.input)
        skipped += sanitized.lossCount
        addClaudeRecord(records, `${baseId}:block:${blockIndex}:call`, 'tool_call', { callId, name, input: sanitized.value }, timestamp, sourceClient)
        const change = fileChangeSummary(name, block.input)
        if (change) addClaudeRecord(records, `${baseId}:block:${blockIndex}:change`, 'file_change', { ...change, callId }, timestamp, sourceClient)
        continue
      }
      if (blockType === 'tool_result') {
        const rawCallId = string(block.tool_use_id)
        if (!rawCallId) throw new Error('claude_tool_result_framing_invalid')
        const callId = safeAlias(rawCallId, `${baseId}:block:${blockIndex}`)
        const result = sanitizeToolResult(block.content)
        skipped += result.lossCount
        addClaudeRecord(records, `${baseId}:block:${blockIndex}:result`, 'tool_result', {
          callId, toolName: toolNames.get(callId) ?? null, output: result.value, isError: block.is_error === true,
        }, timestamp, sourceClient)
        continue
      }
      // Thinking (including signed/encrypted forms), images, fallback and server-only blocks are intentionally not portable.
      skipped += 1
    }
    flushText()
    if (records.count === recordCountBeforeMessage && skipped === skippedBeforeMessage) skipped += 1
  }
  return {
    records: records.records,
    contentDigest: records.contentDigest,
    portableItemCount: records.count,
    cwd, createdAt, updatedAt, skipped,
    title: customTitle ?? aiTitle ?? agentName,
    warnings: skipped ? [`${skipped} known non-portable or hidden Claude records/blocks were not imported`] : [],
  }
}

function addClaudeRecord(
  records: NativeRecordAccumulator, key: string,
  kind: NativePortableRecord['item']['kind'], payload: Record<string, unknown>, createdAt: string | null,
  sourceClient: NativeSourceClient,
): void {
  const sourcePayload = { ...payload, nativeSourceClient: sourceClient, nativeTimestamp: createdAt }
  records.add({
    key, ordinal: records.count + 1, digest: sha256(stableJson({ kind, payload: sourcePayload, key })), createdAt,
    item: { kind, visibility: 'portable', provider: 'claude', nativeId: key, payload: sourcePayload },
  })
}

function fileChangeSummary(name: string, value: unknown): Record<string, unknown> | null {
  const input = object(value)
  const normalizedName = name.toLocaleLowerCase('en-US')
  if (!input || !['write', 'edit', 'multiedit', 'notebookedit'].some((token) => normalizedName.includes(token))) return null
  const rawTarget = string(input.file_path) ?? string(input.path) ?? string(input.notebook_path)
  const target = rawTarget ? safeAlias(rawTarget, '') || null : null
  return { operation: name, path: target, summary: target ? `${name}: ${path.basename(target)}` : name }
}

interface WalkResult { files: string[], truncated: boolean, blockedLinks: number }
async function walk(root: string, extension: string, limit = 10_000): Promise<WalkResult> {
  const files: string[] = []
  const pending = [root]
  let blockedLinks = 0
  let visitedEntries = 0
  const entryLimit = limit * 20
  while (pending.length && files.length < limit && visitedEntries < entryLimit) {
    const directory = pending.pop() as string
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) }
    catch { throw new Error('native_source_directory_unreadable') }
    for (const entry of entries) {
      visitedEntries += 1
      const child = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) { blockedLinks += 1; continue }
      if (entry.isDirectory()) pending.push(await containedRealPath(root, child))
      else if (entry.isFile() && child.endsWith(extension)) files.push(await containedRealPath(root, child))
      if (files.length >= limit || visitedEntries >= entryLimit) break
    }
  }
  return { files, truncated: pending.length > 0 || visitedEntries >= entryLimit, blockedLinks }
}

async function desktopProfileRoot(desktopRoot: string, metadataPath: string): Promise<string> {
  const canonicalMetadata = await containedRealPath(desktopRoot, metadataPath)
  const segments = path.relative(desktopRoot, canonicalMetadata).split(path.sep)
  const candidate = segments.length > 1 ? path.join(desktopRoot, segments[0] as string) : path.dirname(canonicalMetadata)
  return containedRealPath(desktopRoot, await realpath(candidate))
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function string(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null }
function provenanceToken(value: unknown): string {
  const token = string(value)
  return token && /^[a-z0-9_-]{1,40}$/i.test(token) ? token : 'native'
}
function fail(message: string): never { throw new Error(message) }
function errorCode(error: unknown, fallback = 'native_source_error'): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return code.toLocaleLowerCase('en-US')
  return error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : fallback
}
function warningStatus(error: unknown): NativeSourceWarning['status'] {
  const code = errorCode(error, '')
  return code.endsWith('_limit') ? 'unsupported' : 'corrupt'
}
