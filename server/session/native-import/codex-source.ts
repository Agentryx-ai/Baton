import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import path from 'node:path'

import type {
  CodexNativeOrigin, NativePortableRecord, NativeSessionCandidate, NativeSourceReader, NativeSourceScanOptions,
  NativeSourceWarning,
} from './contracts.ts'
import {
  candidateId, canonicalRoot, containedRealPath, cwdAlias, inspectStableFile, mapWithConcurrency, messageText,
  MAX_NATIVE_CANDIDATES, nativePhysicalLines, NativeRecordAccumulator, normalizeNativeCwd, PARSER_VERSION,
  pseudonymousNamespace, readStableFile, safeAlias, sanitizeToolInput, sanitizeToolResult,
  sanitizeReasoningSummary, sha256, stableJson,
} from './source-utils.ts'
import {
  applyGoalCommand, codexToolCallSucceeded, NativeGoalReconstructor,
  parseCodexGoalToolAction, parseExplicitGoalCommand,
  type CodexGoalToolAction,
} from './goal-reconstruction.ts'
import { nativeContextCheckpointPayload } from '../native-context-checkpoint.ts'
import {
  parseCodexTaskNotification,
  taskNotificationPayload,
} from '../../../src/lib/native-task-notification.ts'
import {
  codexEnvelopePayload,
  parseCodexEnvelope,
} from '../../../src/lib/native-codex-envelope.ts'

export interface CodexSourceReaderOptions {
  codexHome?: string
  namespaceSecret?: Buffer
  profileProvenance?: string
  concurrency?: number
}

interface ParsedCodexRecords {
  records: NativePortableRecord[]
  contentDigest: string
  portableItemCount: number
  skipped: number
  warnings: string[]
  goal: NativeSessionCandidate['goal']
}

const CODEX_TOP_LEVEL_TYPES = new Set([
  'session_meta', 'response_item', 'event_msg', 'turn_context',
  // Current Codex bookkeeping records. Valid replacement history is retained only as a
  // provider-private execution checkpoint; other private bookkeeping remains loss.
  'world_state', 'compacted', 'inter_agent_communication', 'inter_agent_communication_metadata',
])
const CODEX_PARSER_VERSION = `${PARSER_VERSION}-codex-native-compact-v6`

export class CodexLocalSourceReader implements NativeSourceReader {
  readonly sourceClient = 'codex_local' as const
  readonly sourceClients = ['codex_local'] as const
  readonly #home: string
  readonly #namespaceSecret: Buffer | undefined
  readonly #profileProvenance: string
  readonly #concurrency: number
  #warnings: NativeSourceWarning[] = []
  #inventoryOverflow = false
  #overflowCount: number | undefined

  constructor(options: CodexSourceReaderOptions = {}) {
    this.#home = path.resolve(options.codexHome ?? path.join(homedir(), '.codex'))
    this.#namespaceSecret = options.namespaceSecret
    this.#profileProvenance = options.profileProvenance ?? ''
    this.#concurrency = options.concurrency ?? 16
  }

  get lastScanWarnings(): readonly NativeSourceWarning[] { return this.#warnings }
  get inventoryOverflow(): boolean { return this.#inventoryOverflow }
  get overflowCount(): number | undefined { return this.#overflowCount }

  async scan(options: NativeSourceScanOptions = {}): Promise<NativeSessionCandidate[]> {
    const includeRecords = options.includeRecords ?? true
    const scanConcurrency = includeRecords ? 1 : this.#concurrency
    const filter = normalizeCodexFilter(options)
    this.#warnings = []
    this.#inventoryOverflow = false
    this.#overflowCount = undefined
    let canonicalHomePath: string
    let namespaceKey: string
    try {
      canonicalHomePath = await canonicalRoot(this.#home)
      namespaceKey = pseudonymousNamespace(
        this.#namespaceSecret as Buffer, 'codex-home-provider', canonicalHomePath, this.#profileProvenance,
      )
    } catch (error) {
      this.#warn('unavailable', errorCode(error, 'codex_source_unavailable'), 'Codex source is unavailable or its installation identity is not configured')
      return []
    }

    let databasePath: string
    try { databasePath = await containedRealPath(canonicalHomePath, path.join(canonicalHomePath, 'state_5.sqlite')) }
    catch (error) {
      this.#warn('unavailable', errorCode(error, 'codex_database_unavailable'), 'Codex state database is unavailable or outside its configured home')
      return []
    }

    let database: DatabaseSync
    try { database = new DatabaseSync(databasePath, { readOnly: true }) }
    catch {
      this.#warn('unavailable', 'codex_database_unreadable', 'Codex state database could not be opened read-only')
      return []
    }
    try {
      let rows: Array<Record<string, unknown>>
      try {
        const columns = new Set((database.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>)
          .map((column) => column.name))
        const predicates = ['rollout_path IS NOT NULL']
        if (columns.has('archived') && !filter.includeArchived) predicates.push('archived = 0')
        if (columns.has('source')) {
          const origins: string[] = []
          if (filter.origins.has('cli')) origins.push("source = 'cli'")
          if (filter.origins.has('ide_app')) origins.push("source = 'vscode'")
          if (filter.origins.has('exec')) origins.push("source = 'exec'")
          if (filter.includeSubagents) origins.push("source LIKE '{\"subagent\"%'")
          if (filter.origins.has('other')) origins.push("(source NOT IN ('cli','vscode','exec') AND source NOT LIKE '{\"subagent\"%')")
          predicates.push(`(${origins.length > 0 ? origins.join(' OR ') : '0'})`)
        } else if (!filter.origins.has('cli')) predicates.push('0')
        const where = predicates.join(' AND ')
        const totalRow = database.prepare(`
          SELECT COUNT(*) AS count FROM threads WHERE ${where}
        `).get() as Record<string, unknown>
        const total = typeof totalRow.count === 'number' ? totalRow.count : Number(totalRow.count)
        if (!Number.isSafeInteger(total) || total < 0) throw new Error('codex_database_count_invalid')
        if (total > MAX_NATIVE_CANDIDATES) {
          this.#inventoryOverflow = true
          this.#overflowCount = total - MAX_NATIVE_CANDIDATES
          this.#warn('unsupported', 'codex_candidate_scan_limit', 'Codex candidate inventory exceeds its safety limit')
          return []
        }
        rows = database.prepare(`
          SELECT id, rollout_path, created_at, updated_at, cwd, title, first_user_message,
            ${columns.has('source') ? 'source' : "'cli'"} AS source,
            ${columns.has('archived') ? 'archived' : '0'} AS archived
          FROM threads WHERE ${where}
          ORDER BY updated_at DESC LIMIT ?
        `).all(MAX_NATIVE_CANDIDATES) as Array<Record<string, unknown>>
      } catch {
        this.#warn('unsupported', 'codex_database_schema_unsupported', 'Codex state database schema is not supported')
        return []
      }
      const candidates = await mapWithConcurrency(rows, scanConcurrency, async (row) => {
        try { return await this.#candidate(row, canonicalHomePath, namespaceKey, includeRecords) }
        catch (error) {
          this.#warn(warningStatus(error), errorCode(error, 'codex_candidate_corrupt'), 'A Codex task was skipped because its source was corrupt, unsupported, or escaped the configured home')
          return null
        }
      })
      return candidates.filter((candidate): candidate is NativeSessionCandidate => candidate !== null)
    } finally { database.close() }
  }

  async #candidate(
    row: Record<string, unknown>, canonicalHomePath: string, namespaceKey: string, includeRecords: boolean,
  ): Promise<NativeSessionCandidate> {
    const nativeSessionId = string(row.id)
    const rolloutPath = string(row.rollout_path)
    if (!nativeSessionId || !rolloutPath) throw new Error('codex_thread_framing_invalid')
    const requestedRolloutPath = path.isAbsolute(rolloutPath) ? rolloutPath : path.resolve(canonicalHomePath, rolloutPath)
    const canonicalRolloutPath = await containedRealPath(canonicalHomePath, requestedRolloutPath)
    const source = includeRecords ? await readStableFile(canonicalRolloutPath) : null
    const sourceHead = source?.head ?? await inspectStableFile(canonicalRolloutPath)
    const parsed = source ? parseCodexRecords(source.text, nativeSessionId, true) : null
    const cwd = normalizeNativeCwd(string(row.cwd))
    const explicitTitle = string(row.title)
    const fallback = cwdAlias(cwd, 'Codex task')
    const alias = explicitTitle ? safeAlias(explicitTitle, fallback) : fallback
    return {
      candidateId: candidateId([this.sourceClient, namespaceKey, nativeSessionId]),
      sourceClient: this.sourceClient,
      provider: 'codex',
      namespaceKey,
      nativeSessionId,
      sourceAlias: alias,
      aliasSource: explicitTitle && alias !== fallback ? 'native' : cwd ? 'path_fallback' : 'generated',
      titleSource: explicitTitle && alias !== fallback ? 'threads.title' : null,
      projectAlias: cwd ? cwdAlias(cwd, 'Codex') : null,
      projectGroupKey: cwd
        ? pseudonymousNamespace(this.#namespaceSecret as Buffer, 'native-project', cwd)
        : null,
      cwd,
      createdAt: asIso(row.created_at),
      updatedAt: asIso(row.updated_at),
      nativeOrigin: codexOrigin(row.source),
      nativeArchived: row.archived === 1 || row.archived === true,
      sourceHead,
      contentDigest: parsed?.contentDigest ?? sha256(''),
      prefixDigest: parsed?.contentDigest ?? sha256(''),
      portableItemCount: parsed?.portableItemCount ?? 0,
      sourceLocator: { path: canonicalRolloutPath },
      records: parsed?.records ?? [],
      goal: parsed?.goal,
      skippedItemCount: parsed?.skipped ?? 0,
      parserVersion: CODEX_PARSER_VERSION,
      warnings: parsed?.warnings ?? [],
      identityKeys: [{ kind: 'native_session_id', value: nativeSessionId, scopeNamespaceKey: namespaceKey }],
      materialized: parsed !== null,
    }
  }

  async materialize(candidate: NativeSessionCandidate): Promise<NativeSessionCandidate> {
    if (candidate.sourceClient !== this.sourceClient || !candidate.sourceLocator?.path) {
      throw new Error('codex_candidate_locator_invalid')
    }
    const canonicalHomePath = await canonicalRoot(this.#home)
    const namespaceKey = pseudonymousNamespace(
      this.#namespaceSecret as Buffer, 'codex-home-provider', canonicalHomePath, this.#profileProvenance,
    )
    if (candidate.namespaceKey !== namespaceKey
      || candidate.candidateId !== candidateId([this.sourceClient, namespaceKey, candidate.nativeSessionId])) {
      throw new Error('codex_candidate_identity_mismatch')
    }
    const sourcePath = await containedRealPath(canonicalHomePath, candidate.sourceLocator.path)
    const source = await readStableFile(sourcePath)
    const parsed = parseCodexRecords(source.text, candidate.nativeSessionId, true)
    if (stableJson(source.head) !== stableJson(candidate.sourceHead)
      || (candidate.materialized && (parsed.contentDigest !== candidate.contentDigest
        || parsed.contentDigest !== candidate.prefixDigest
        || parsed.portableItemCount !== candidate.portableItemCount
        || parsed.skipped !== candidate.skippedItemCount))) {
      throw new Error('source_changed_after_scan')
    }
    return {
      ...candidate, sourceHead: source.head, contentDigest: parsed.contentDigest, prefixDigest: parsed.contentDigest,
      portableItemCount: parsed.portableItemCount, skippedItemCount: parsed.skipped, warnings: parsed.warnings,
      sourceLocator: { path: sourcePath }, records: parsed.records, materialized: true,
      goal: parsed.goal,
    }
  }

  #warn(status: NativeSourceWarning['status'], code: string, message: string): void {
    const existing = this.#warnings.find((warning) => warning.status === status && warning.code === code)
    if (existing) existing.count = (existing.count ?? 1) + 1
    else this.#warnings.push({ sourceClient: this.sourceClient, status, code, message, count: 1 })
  }
}

function normalizeCodexFilter(options: NativeSourceScanOptions): {
  origins: Set<Exclude<CodexNativeOrigin, 'subagent'>>, includeSubagents: boolean, includeArchived: boolean,
} {
  const origins = options.codex?.origins ?? ['cli', 'ide_app']
  return { origins: new Set(origins), includeSubagents: options.codex?.includeSubagents === true,
    includeArchived: options.codex?.includeArchived === true }
}

function codexOrigin(value: unknown): CodexNativeOrigin {
  if (value === 'cli') return 'cli'
  if (value === 'vscode') return 'ide_app'
  if (value === 'exec') return 'exec'
  return typeof value === 'string' && value.startsWith('{"subagent"') ? 'subagent' : 'other'
}

function parseCodexRecords(text: string, sessionId: string, includeRecords: boolean): ParsedCodexRecords {
  const records = new NativeRecordAccumulator(includeRecords)
  const toolNames = new Map<string, string>()
  const goalToolActions = new Map<string, { action: CodexGoalToolAction; timestamp: string | null }>()
  const goal = new NativeGoalReconstructor()
  let currentModel: string | null = null
  let currentEffort: string | null = null
  let skipped = 0
  for (const [lineIndex, line] of nativePhysicalLines(text)) {
    if (!line.trim()) continue
    let event: Record<string, unknown>
    try {
      const parsed = JSON.parse(line) as unknown
      event = object(parsed) ?? fail('codex_record_framing_invalid')
    } catch (error) {
      if (error instanceof Error && error.message === 'codex_record_framing_invalid') throw error
      throw new Error('codex_json_corrupt')
    }
    const eventType = string(event.type)
    if (!eventType || !CODEX_TOP_LEVEL_TYPES.has(eventType)) throw new Error('codex_top_level_type_unsupported')
    const payload = object(event.payload)
    if (!payload) throw new Error('codex_record_framing_invalid')
    const timestamp = string(event.timestamp)
    if (eventType === 'inter_agent_communication') {
      skipped += addCodexCollaborationRecord(records, `${sessionId}:${lineIndex + 1}:collaboration`, payload, timestamp)
      continue
    }
    if (eventType === 'turn_context') {
      currentModel = string(payload.model)
      currentEffort = string(payload.effort)
      skipped += 1
      continue
    }
    if (eventType === 'compacted') {
      const history = payload.replacement_history
      if (!Array.isArray(history) || !history.every((item) => object(item) !== null)) {
        skipped += 1
        continue
      }
      addRecord(records, `${sessionId}:${lineIndex + 1}:compact`, 'provider_event', nativeContextCheckpointPayload({
        version: 1,
        provider: 'codex',
        format: 'codex_replacement_history',
        history: history as Record<string, unknown>[],
        sourceModel: currentModel,
      }), timestamp, 'provider_private')
      continue
    }
    if (eventType !== 'response_item') { skipped += 1; continue }
    const payloadType = string(payload.type)
    if (!payloadType) throw new Error('codex_response_item_framing_invalid')
    const baseId = string(payload.id) ?? `${sessionId}:${lineIndex + 1}`

    if (payloadType === 'agent_message') {
      if (codexCollaborationHasEncryptedContent(payload)) { skipped += 1; continue }
      const textValue = messageText(payload.content)
      const taskNotification = textValue ? parseCodexTaskNotification(textValue) : null
      if (taskNotification) {
        addRecord(records, `${baseId}:task-notification`, 'user_message', {
          ...taskNotificationPayload(taskNotification),
          nativeSourceClient: 'codex_local',
          nativeRecordType: 'agent_message',
          nativeTimestamp: timestamp,
        }, timestamp)
      } else {
        skipped += addCodexCollaborationRecord(records, `${baseId}:collaboration`, payload, timestamp)
      }
      continue
    }
    if (payloadType === 'message') {
      const role = string(payload.role)
      if (role !== 'user' && role !== 'assistant') { skipped += 1; continue }
      let portableContent = payload.content
      if (Array.isArray(payload.content)) {
        portableContent = payload.content.filter((rawBlock) => {
          const blockType = string(object(rawBlock)?.type)
          const portable = !!blockType && ['input_text', 'output_text', 'text'].includes(blockType)
          if (!portable) skipped += 1
          return portable
        })
      }
      const textValue = messageText(portableContent)
      if (!textValue?.trim()) { skipped += 1; continue }
      if (role === 'user') {
        const taskNotification = parseCodexTaskNotification(textValue)
        if (taskNotification) {
          addRecord(records, `${baseId}:task-notification`, 'user_message', {
            ...taskNotificationPayload(taskNotification),
            nativeSourceClient: 'codex_local',
            nativeRecordType: 'subagent-notification',
            nativeTimestamp: timestamp,
          }, timestamp)
          continue
        }
        const envelope = parseCodexEnvelope(textValue)
        if (envelope) {
          addRecord(records, `${baseId}:envelope`, envelope.presentation === 'hidden' ? 'provider_event' : 'user_message', {
            ...codexEnvelopePayload(envelope),
            nativeSourceClient: 'codex_local',
            nativeRecordType: 'codex-envelope',
            nativeTimestamp: timestamp,
          }, timestamp, envelope.presentation === 'hidden' ? 'provider_private' : 'portable')
          continue
        }
      }
      if (role === 'user') {
        applyGoalCommand(goal, parseExplicitGoalCommand(textValue), timestamp, 'slash_command')
      }
      const legacyPayload = {
        text: textValue, nativeSourceClient: 'codex_local', nativeRecordType: payloadType, nativeTimestamp: timestamp,
      }
      addRecord(records, baseId, role === 'user' ? 'user_message' : 'assistant_message', {
        ...legacyPayload,
        ...(role === 'assistant' && currentModel ? { requestedModel: currentModel } : {}),
        ...(role === 'assistant' && currentEffort ? { effort: currentEffort } : {}),
      }, timestamp, 'portable', legacyPayload)
      continue
    }
    if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
      const callId = safeAlias(string(payload.call_id) ?? baseId, baseId)
      const name = safeAlias(string(payload.name) ?? 'tool', 'tool')
      toolNames.set(callId, name)
      const rawInput = parseJsonString(payload.arguments ?? payload.input)
      const goalAction = name === 'exec' && typeof rawInput === 'string'
        ? parseCodexGoalToolAction(rawInput)
        : null
      if (goalAction) goalToolActions.set(callId, { action: goalAction, timestamp })
      const sanitized = sanitizeToolInput(rawInput)
      skipped += sanitized.lossCount
      addRecord(records, `${baseId}:call`, 'tool_call', {
        callId, name, input: sanitized.value, nativeSourceClient: 'codex_local', nativeTimestamp: timestamp,
      }, timestamp)
      const change = fileChangeSummary(name, rawInput)
      if (change) addRecord(records, `${baseId}:change`, 'file_change', { ...change, callId }, timestamp)
      continue
    }
    if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
      const callId = safeAlias(string(payload.call_id) ?? baseId, baseId)
      const pendingGoal = goalToolActions.get(callId)
      if (pendingGoal && codexToolCallSucceeded(payload.output)) {
        applyGoalCommand(goal, pendingGoal.action, pendingGoal.timestamp ?? timestamp, 'codex_goal_tool')
      }
      goalToolActions.delete(callId)
      const sanitized = sanitizeToolResult(payload.output)
      skipped += sanitized.lossCount
      addRecord(records, `${baseId}:result`, 'tool_result', {
        callId, toolName: toolNames.get(callId) ?? null, output: sanitized.value,
        nativeSourceClient: 'codex_local', nativeTimestamp: timestamp,
      }, timestamp)
      continue
    }
    if (payloadType === 'tool_search_call') {
      const callId = safeAlias(string(payload.call_id) ?? baseId, baseId)
      const sanitized = sanitizeToolInput(payload.arguments ?? payload.input ?? payload.query)
      skipped += sanitized.lossCount
      addRecord(records, `${baseId}:call`, 'tool_call', {
        callId, name: 'tool_search', execution: safeAlias(payload.execution, 'search'),
        status: string(payload.status), input: sanitized.value,
        nativeSourceClient: 'codex_local', nativeTimestamp: timestamp,
      }, timestamp)
      continue
    }
    if (payloadType === 'tool_search_output') {
      const callId = safeAlias(string(payload.call_id) ?? baseId, baseId)
      const sanitized = sanitizeToolResult(payload.tools ?? payload.output)
      skipped += sanitized.lossCount
      addRecord(records, `${baseId}:result`, 'tool_result', {
        callId, toolName: 'tool_search', status: string(payload.status), output: sanitized.value,
        nativeSourceClient: 'codex_local', nativeTimestamp: timestamp,
      }, timestamp)
      continue
    }
    if (payloadType === 'web_search_call' || payloadType === 'local_shell_call') {
      const callId = safeAlias(string(payload.call_id) ?? baseId, baseId)
      const name = payloadType === 'web_search_call' ? 'web_search' : 'local_shell'
      const sanitized = sanitizeToolInput(payload.action ?? payload.input)
      skipped += sanitized.lossCount
      addRecord(records, `${baseId}:call`, 'tool_call', {
        callId, name, status: string(payload.status), input: sanitized.value,
        nativeSourceClient: 'codex_local', nativeTimestamp: timestamp,
      }, timestamp)
      continue
    }
    if (payloadType === 'image_generation_call') {
      if (payload.revised_prompt != null) skipped += 1
      if (payload.result != null) skipped += 1
      addRecord(records, `${baseId}:image-generation`, 'provider_event', {
        event: 'image_generation', status: string(payload.status),
        nativeSourceClient: 'codex_local', nativeTimestamp: timestamp,
      }, timestamp, 'provider_private')
      continue
    }
    if (payloadType === 'reasoning') {
      const summary = messageText(payload.summary)
      const sanitized = summary?.trim() ? sanitizeReasoningSummary(summary) : { value: null, lossCount: 0 }
      skipped += sanitized.lossCount
      if (sanitized.value) addRecord(records, `${baseId}:summary`, 'reasoning_summary', { summary: sanitized.value }, timestamp, 'provider_private')
      if (payload.content != null || payload.encrypted_content != null || !sanitized.value) skipped += 1
      continue
    }
    skipped += 1
  }
  return {
    records: records.records,
    contentDigest: records.contentDigest,
    portableItemCount: records.portableCount,
    skipped,
    warnings: skipped ? [`${skipped} known non-portable or hidden Codex records were not imported`] : [],
    goal: goal.snapshot('codex', currentModel, currentEffort),
  }
}

function addCodexCollaborationRecord(
  records: NativeRecordAccumulator, key: string, payload: Record<string, unknown>, timestamp: string | null,
): number {
  if (codexCollaborationHasEncryptedContent(payload)) return 1
  const content = string(payload.content) ?? messageText(payload.content)
  if (!content?.trim()) return 1
  const sanitized = sanitizeReasoningSummary(content)
  if (!sanitized.value) return Math.max(1, sanitized.lossCount)
  const otherRecipients = Array.isArray(payload.other_recipients)
    ? payload.other_recipients.map((recipient) => safeAlias(recipient, '')).filter(Boolean)
    : []
  addRecord(records, key, 'provider_event', {
    event: 'provider_native_collaboration_message',
    author: safeAlias(payload.author, 'unknown'),
    recipient: safeAlias(payload.recipient, 'unknown'),
    otherRecipients,
    content: sanitized.value,
    triggerTurn: payload.trigger_turn === true,
    nativeSourceClient: 'codex_local',
    nativeTimestamp: timestamp,
  }, timestamp, 'provider_private')
  return sanitized.lossCount
}

function codexCollaborationHasEncryptedContent(payload: Record<string, unknown>): boolean {
  const blocks = Array.isArray(payload.content) ? payload.content : []
  return payload.encrypted_content != null || blocks.some((block) => {
    return string(object(block)?.type) === 'encrypted_content'
  })
}

function addRecord(
  records: NativeRecordAccumulator, key: string,
  kind: NativePortableRecord['item']['kind'], payload: Record<string, unknown>, createdAt: string | null,
  visibility: NativePortableRecord['item']['visibility'] = 'portable',
  identityPayload: Record<string, unknown> = payload,
): void {
  // Additive display metadata must not rewrite the immutable native record identity. Codex
  // turn_context was absent from parser v1, so hashing it would break existing append updates.
  const normalized = { kind, payload: identityPayload, key }
  records.add({
    key, ordinal: records.count + 1, digest: sha256(stableJson(normalized)), createdAt,
    item: { kind, visibility, provider: 'codex', nativeId: key, payload },
  })
}

function fileChangeSummary(name: string, value: unknown): Record<string, unknown> | null {
  const input = object(value)
  const normalizedName = name.toLocaleLowerCase('en-US')
  if (!input) return null
  if (!['apply_patch', 'write', 'edit', 'multiedit', 'notebookedit'].some((token) => normalizedName.includes(token))) return null
  const rawTarget = string(input.file_path) ?? string(input.path) ?? string(input.notebook_path)
  const target = rawTarget ? safeAlias(rawTarget, '') || null : null
  return { operation: name, path: target, summary: target ? `${name}: ${path.basename(target)}` : name }
}

function portableValue(value: unknown): unknown {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(portableValue)
  const valueObject = object(value)
  return valueObject ? Object.fromEntries(Object.entries(valueObject).map(([key, child]) => [key, portableValue(child)])) : String(value)
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return portableValue(value)
  try { return portableValue(JSON.parse(value)) } catch { return value }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function string(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null }
function fail(message: string): never { throw new Error(message) }
function errorCode(error: unknown, fallback: string): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return code.toLocaleLowerCase('en-US')
  return error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : fallback
}
function warningStatus(error: unknown): NativeSourceWarning['status'] {
  const code = errorCode(error, '')
  return code.endsWith('_limit') ? 'unsupported' : 'corrupt'
}
function asIso(value: unknown): string | null {
  if (typeof value === 'number') return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString()
  if (typeof value === 'string') return value
  return null
}
