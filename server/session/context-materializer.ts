import { createHash } from 'node:crypto'

import type {
  CanonicalItem,
  CanonicalProvider,
  CanonicalTurn,
  ItemId,
  ThreadId,
  ThreadSnapshot,
  TurnId,
} from './domain.js'
import {
  CONTEXT_SUMMARY_PROMPT_VERSION,
  contextSummaryGenerationInput,
  contextSummaryInputHash,
  contextSummaryTurnReceipt,
} from './context-summary-contract.js'

/**
 * An immutable, derived view over a precise canonical-item coverage frontier.
 * `sourceItemIds` includes private audit records even though only portable
 * items enter the generator. Canonical items remain the source of truth and
 * are never replaced by this artifact.
 */
export interface ContextSummaryArtifact {
  schemaVersion: 1
  id: string
  threadId: ThreadId
  sourceItemIds: readonly ItemId[]
  sourceHash: string
  /** Digest of the exact portable generator inputs and generation settings. */
  summaryInputHash: string
  summaryInput: {
    promptVersion: string
    previousArtifactId: string | null
    deltaItemIds: readonly ItemId[]
    turnIds: readonly TurnId[]
    maximumSummaryTokens: number
  }
  throughSequence: number
  summary: string
  generator: {
    id: string
    model: string | null
    effort: string | null
    version: string
  }
  estimatedSummaryTokens: number
  createdAt: string
}

export type MaterializedContextEntry =
  | { type: 'derived_summary'; artifact: ContextSummaryArtifact }
  | { type: 'canonical_item'; item: CanonicalItem }

export interface MaterializedContext {
  /** Newest valid coverage frontier, or null when canonical history is used. */
  artifact: ContextSummaryArtifact | null
  entries: readonly MaterializedContextEntry[]
  /** Invalid artifacts are ignored; callers may record these IDs as telemetry. */
  invalidArtifactIds: readonly string[]
  estimatedTokens: number
}

export interface StableContextPrefix {
  turns: readonly CanonicalTurn[]
  throughSequence: number
}

const SAFE_TERMINAL_TURN_STATUSES = new Set<CanonicalTurn['status']>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

const SUMMARY_INPUT_KINDS = new Set<CanonicalItem['kind']>([
  'user_message',
  'assistant_message',
  'reasoning_summary',
  'tool_call',
  'tool_result',
  'file_change',
  'approval',
  'plan',
  'task',
  'error',
  'summary',
])

/** Versioned so estimator changes cannot silently alter persisted policy decisions. */
export const CONTEXT_TOKEN_ESTIMATOR_VERSION = 'utf8-bytes-v1'
const INVALID_CONTEXT_ITEM_ESTIMATE_TOKENS = 2_147_483_647

/**
 * Conservative deterministic estimate for mixed ASCII/Unicode JSON. This is
 * deliberately not advertised as a provider tokenizer: one token per three
 * UTF-8 bytes plus explicit envelope overhead errs on the safe side.
 */
export function estimateUtf8Tokens(value: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(value, 'utf8') / 3))
}

export function estimateCanonicalItemTokens(item: CanonicalItem): number {
  try {
    return 12 + estimateUtf8Tokens(canonicalJson(contextItemEnvelope(item)))
  } catch {
    // Corrupt/non-JSON canonical bytes must trigger compaction conservatively,
    // while exact hashing will refuse to summarize them.
    return INVALID_CONTEXT_ITEM_ESTIMATE_TOKENS
  }
}

export function estimateContextTokens(
  entries: readonly MaterializedContextEntry[],
  provider?: CanonicalProvider,
): number {
  return entries.reduce((total, entry) => {
    const addition = entry.type === 'canonical_item'
      ? estimatedProviderItemTokens(entry.item, provider)
      : 16 + estimateUtf8Tokens(entry.artifact.summary)
    return Math.min(Number.MAX_SAFE_INTEGER, total + addition)
  }, 0)
}

/** Exact hash of the complete immutable canonical envelopes, in source order. */
export function sourceHashForItems(items: readonly CanonicalItem[]): string {
  return createHash('sha256')
    .update(canonicalJson(items.map(contextItemEnvelope)))
    .digest('hex')
}

/**
 * Returns each safe terminal-turn frontier in order. Failed, cancelled, and
 * interrupted turns are final history too; their status/error receipts are
 * included in the summary input by the compaction engine. Active, malformed,
 * unresolved-tool, and unknown-mutation turns remain a hard barrier.
 */
export function stableContextPrefixes(snapshot: ThreadSnapshot): readonly StableContextPrefix[] {
  const items = orderedThreadItems(snapshot)
  const itemsByTurn = new Map<TurnId, CanonicalItem[]>()
  for (const item of items) {
    if (item.turnId === null) continue
    const bucket = itemsByTurn.get(item.turnId) ?? []
    bucket.push(item)
    itemsByTurn.set(item.turnId, bucket)
  }
  const turns = [...snapshot.turns]
    .sort((left, right) =>
      (itemsByTurn.get(left.id)?.[0]?.sequence ?? Number.MAX_SAFE_INTEGER)
        - (itemsByTurn.get(right.id)?.[0]?.sequence ?? Number.MAX_SAFE_INTEGER)
      || left.id.localeCompare(right.id))
  const terminal: CanonicalTurn[] = []
  const prefixes: StableContextPrefix[] = []

  for (const turn of turns) {
    if (!SAFE_TERMINAL_TURN_STATUSES.has(turn.status)) break
    const turnItems = itemsByTurn.get(turn.id) ?? []
    if (turnItems.length === 0 || !hasSafeContextToolState(turnItems)) break
    terminal.push(turn)
    prefixes.push({
      turns: [...terminal],
      throughSequence: turnItems.at(-1)!.sequence,
    })
  }
  return prefixes
}

/** Every immutable canonical item retired from provider execution by a summary. */
export function coverageItems(
  snapshot: ThreadSnapshot,
  prefix: StableContextPrefix,
): readonly CanonicalItem[] {
  const includedTurns = new Set<TurnId>(prefix.turns.map((turn) => turn.id))
  return orderedThreadItems(snapshot).filter((item) =>
    item.sequence <= prefix.throughSequence
      && item.turnId !== null
      && includedTurns.has(item.turnId),
  )
}

/** Portable, provider-neutral inputs represented by a safe prefix artifact. */
export function summarySourceItems(
  snapshot: ThreadSnapshot,
  prefix: StableContextPrefix,
): readonly CanonicalItem[] {
  const includedTurns = new Set<TurnId>(prefix.turns.map((turn) => turn.id))
  return orderedThreadItems(snapshot).filter((item) =>
    item.sequence <= prefix.throughSequence
      && item.turnId !== null
      && includedTurns.has(item.turnId)
      && item.visibility === 'portable'
      && SUMMARY_INPUT_KINDS.has(item.kind),
  )
}

/**
 * Validates artifacts against current canonical bytes and materializes a
 * synthetic summary plus every item outside its exact canonical coverage.
 * Private/opaque values are never fed into the summary; once their terminal
 * turn is covered they are intentionally retired from provider execution while
 * remaining immutable in the canonical ledger and artifact provenance.
 */
export function materializeContext(
  snapshot: ThreadSnapshot,
  artifacts: readonly ContextSummaryArtifact[],
  provider?: CanonicalProvider,
): MaterializedContext {
  const invalidArtifactIds: string[] = []
  const orderedArtifacts = [...artifacts].sort((left, right) =>
    right.throughSequence - left.throughSequence
      || right.createdAt.localeCompare(left.createdAt)
      || right.id.localeCompare(left.id),
  )

  let selected: ContextSummaryArtifact | null = null
  const artifactIndex = indexArtifacts(artifacts)
  const validation = new Map<string, boolean>()
  for (const artifact of orderedArtifacts) {
    if (validateArtifactChain(snapshot, artifact, artifactIndex, validation, new Set())) {
      selected = artifact
      break
    }
    invalidArtifactIds.push(artifact.id)
  }

  const items = orderedThreadItems(snapshot)
  const coveredIds = new Set(selected?.sourceItemIds ?? [])
  const entries: MaterializedContextEntry[] = selected
    ? [{ type: 'derived_summary', artifact: selected }, ...items
        .filter((item) => !coveredIds.has(item.id))
        .map((item): MaterializedContextEntry => ({ type: 'canonical_item', item }))]
    : items.map((item): MaterializedContextEntry => ({ type: 'canonical_item', item }))

  return {
    artifact: selected,
    entries,
    invalidArtifactIds,
    estimatedTokens: estimateContextTokens(entries, provider),
  }
}

export function isValidArtifact(
  snapshot: ThreadSnapshot,
  artifact: ContextSummaryArtifact,
  artifacts: readonly ContextSummaryArtifact[] = [artifact],
): boolean {
  return validateArtifactChain(
    snapshot,
    artifact,
    indexArtifacts(artifacts),
    new Map(),
    new Set(),
  )
}

function validateArtifactChain(
  snapshot: ThreadSnapshot,
  artifact: ContextSummaryArtifact,
  artifactIndex: ArtifactIndex,
  validation: Map<string, boolean>,
  visiting: Set<string>,
): boolean {
  const memoized = validation.get(artifact.id)
  if (memoized !== undefined) return memoized
  if (visiting.has(artifact.id) || artifactIndex.duplicateIds.has(artifact.id)) return false
  visiting.add(artifact.id)
  try {
    if (artifact.schemaVersion !== 1
      || artifact.threadId !== snapshot.thread.id
      || !artifact.id.trim()
      || !artifact.summary.trim()
      || !artifact.sourceHash.match(/^[a-f0-9]{64}$/)
      || !artifact.summaryInputHash.match(/^[a-f0-9]{64}$/)
      || artifact.summaryInput.promptVersion !== CONTEXT_SUMMARY_PROMPT_VERSION
      || (artifact.summaryInput.previousArtifactId !== null
        && !artifact.summaryInput.previousArtifactId.trim())
      || artifact.summaryInput.deltaItemIds.some((id) => !id.trim())
      || new Set(artifact.summaryInput.deltaItemIds).size !== artifact.summaryInput.deltaItemIds.length
      || artifact.summaryInput.turnIds.some((id) => !id.trim())
      || new Set(artifact.summaryInput.turnIds).size !== artifact.summaryInput.turnIds.length
      || !Number.isSafeInteger(artifact.summaryInput.maximumSummaryTokens)
      || artifact.summaryInput.maximumSummaryTokens < 1
      || !Number.isSafeInteger(artifact.throughSequence)
      || artifact.throughSequence < 1
      || !Number.isSafeInteger(artifact.estimatedSummaryTokens)
      || artifact.estimatedSummaryTokens < 1
      || !artifact.generator.id.trim()
      || !artifact.generator.version.trim()
      || (artifact.generator.model !== null && !artifact.generator.model.trim())
      || (artifact.generator.effort !== null && !artifact.generator.effort.trim())
      || !Number.isFinite(Date.parse(artifact.createdAt))) return invalid()

    const prefix = stableContextPrefixes(snapshot)
      .find((candidate) => candidate.throughSequence === artifact.throughSequence)
    if (!prefix) return invalid()
    const source = coverageItems(snapshot, prefix)
    if (source.length === 0 || !sameIds(source, artifact.sourceItemIds)) return invalid()
    if (sourceHashForItems(source) !== artifact.sourceHash) return invalid()

    let previous: ContextSummaryArtifact | null = null
    let previousTurnIds = new Set<TurnId>()
    if (artifact.summaryInput.previousArtifactId !== null) {
      previous = artifactIndex.byId.get(artifact.summaryInput.previousArtifactId) ?? null
      if (previous === null
        || previous.id === artifact.id
        || previous.threadId !== artifact.threadId
        || previous.throughSequence >= artifact.throughSequence
        || !validateArtifactChain(snapshot, previous, artifactIndex, validation, visiting)
        || previous.sourceItemIds.some((id, index) => artifact.sourceItemIds[index] !== id)) {
        return invalid()
      }
      const previousPrefix = stableContextPrefixes(snapshot)
        .find((candidate) => candidate.throughSequence === previous?.throughSequence)
      if (!previousPrefix) return invalid()
      previousTurnIds = new Set(previousPrefix.turns.map((turn) => turn.id))
    }

    const previousSourceIds = new Set(previous?.sourceItemIds ?? [])
    const delta = summarySourceItems(snapshot, prefix)
      .filter((item) => !previousSourceIds.has(item.id))
    const receipts = prefix.turns
      .filter((turn) => !previousTurnIds.has(turn.id))
      .map(contextSummaryTurnReceipt)
    if (!sameStrings(artifact.summaryInput.deltaItemIds, delta.map((item) => item.id))
      || !sameStrings(artifact.summaryInput.turnIds, receipts.map((turn) => turn.id))) {
      return invalid()
    }

    const exactInput = contextSummaryGenerationInput({
      threadId: snapshot.thread.id,
      sourceItemIds: source.map((item) => item.id),
      sourceHash: artifact.sourceHash,
      throughSequence: prefix.throughSequence,
      previousSummary: previous,
      turns: receipts,
      items: delta,
      maximumSummaryTokens: artifact.summaryInput.maximumSummaryTokens,
    })
    if (contextSummaryInputHash(exactInput, artifact.generator) !== artifact.summaryInputHash) {
      return invalid()
    }
    validation.set(artifact.id, true)
    return true
  } catch {
    return invalid()
  } finally {
    visiting.delete(artifact.id)
  }

  function invalid(): false {
    validation.set(artifact.id, false)
    return false
  }
}

interface ArtifactIndex {
  byId: Map<string, ContextSummaryArtifact>
  duplicateIds: Set<string>
}

function indexArtifacts(artifacts: readonly ContextSummaryArtifact[]): ArtifactIndex {
  const byId = new Map<string, ContextSummaryArtifact>()
  const duplicateIds = new Set<string>()
  for (const artifact of artifacts) {
    if (byId.has(artifact.id)) duplicateIds.add(artifact.id)
    else byId.set(artifact.id, artifact)
  }
  return { byId, duplicateIds }
}

function sameIds(items: readonly CanonicalItem[], ids: readonly string[]): boolean {
  return items.length === ids.length && items.every((item, index) => item.id === ids[index])
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function estimatedProviderItemTokens(
  item: CanonicalItem,
  provider: CanonicalProvider | undefined,
): number {
  if (item.visibility === 'baton_private') return 0
  if (item.visibility === 'provider_private' && provider !== undefined && item.provider !== provider) return 0
  return estimateCanonicalItemTokens(item)
}

function orderedThreadItems(snapshot: ThreadSnapshot): CanonicalItem[] {
  // Store snapshots already contain only the selected thread's exact fork
  // lineage. Parent items retain their original thread IDs and must remain in
  // both compaction provenance and the provider context.
  return [...snapshot.items]
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
}

export function hasSafeContextToolState(items: readonly CanonicalItem[]): boolean {
  const calls = new Map<string, CanonicalItem>()
  const results = new Map<string, CanonicalItem>()
  for (const item of items) {
    if (item.kind !== 'tool_call' && item.kind !== 'tool_result') continue
    const callId = typeof item.payload.callId === 'string' && item.payload.callId.trim()
      ? item.payload.callId
      : null
    if (!callId) return false
    const target = item.kind === 'tool_call' ? calls : results
    if (target.has(callId)) return false
    target.set(callId, item)
  }
  if (calls.size !== results.size) return false
  for (const [callId, call] of calls) {
    const result = results.get(callId)
    if (!result || result.sequence <= call.sequence || mutationOutcomeIsUnknown(call, result)) return false
  }
  for (const callId of results.keys()) if (!calls.has(callId)) return false
  return true
}

function mutationOutcomeIsUnknown(call: CanonicalItem, result: CanonicalItem): boolean {
  if (call.payload.sideEffect !== 'workspace_mutation'
    && call.payload.sideEffect !== 'workspace_command'
    && call.payload.sideEffect !== 'host_mutation') return false
  const reconciliation = object(result.payload.reconciliation)
  const nestedResult = object(result.payload.result)
  const nestedMetadata = object(nestedResult?.metadata)
  const nestedReconciliation = object(nestedMetadata?.reconciliation)
  const error = object(nestedResult?.error)
  return reconciliation?.resolution === 'unknown_outcome'
    || nestedReconciliation?.resolution === 'unknown_outcome'
    || error?.code === 'unknown_mutation_acknowledged'
}

function contextItemEnvelope(item: CanonicalItem): Record<string, unknown> {
  return {
    id: item.id,
    sessionId: item.sessionId,
    threadId: item.threadId,
    turnId: item.turnId,
    sequence: item.sequence,
    kind: item.kind,
    visibility: item.visibility,
    payload: item.payload,
    provider: item.provider,
    nativeId: item.nativeId,
    createdAt: item.createdAt,
  }
}

function canonicalJson(value: unknown): string {
  const visiting = new Set<object>()
  const visit = (current: unknown): string => {
    if (current === null) return 'null'
    if (typeof current === 'string' || typeof current === 'boolean') return JSON.stringify(current)
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error('Canonical context values must be finite')
      return JSON.stringify(Object.is(current, -0) ? 0 : current)
    }
    if (typeof current !== 'object') throw new Error('Canonical context values must be JSON-compatible')
    if (visiting.has(current)) throw new Error('Canonical context values must not contain cycles')
    visiting.add(current)
    try {
      if (Array.isArray(current)) {
        if (Object.keys(current).some((key) =>
          !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= current.length)) {
          throw new Error('Canonical context arrays must not have named properties')
        }
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.hasOwn(current, index)) throw new Error('Canonical context arrays must not be sparse')
        }
        return `[${current.map(visit).join(',')}]`
      }
      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('Canonical context objects must be plain objects')
      }
      const record = current as Record<string, unknown>
      return `{${Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${visit(record[key])}`).join(',')}}`
    } finally {
      visiting.delete(current)
    }
  }
  return visit(value)
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
