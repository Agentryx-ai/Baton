import type { CanonicalItem, CanonicalProvider } from './domain.js'

type JsonObject = Record<string, unknown>

export type NativeContextCheckpoint =
  | {
      version: 1
      provider: 'codex'
      format: 'codex_replacement_history'
      history: JsonObject[]
      sourceModel: string | null
    }
  | {
      version: 1
      provider: 'claude'
      format: 'claude_compact_summary'
      summary: string
      metadata: JsonObject | null
    }

export interface NativeContextCheckpointItem {
  item: CanonicalItem
  checkpoint: NativeContextCheckpoint
}

export function nativeContextCheckpointPayload(checkpoint: NativeContextCheckpoint): JsonObject {
  return { nativeContextCheckpoint: checkpoint }
}

export function latestNativeContextCheckpoint(
  items: readonly CanonicalItem[],
  provider: CanonicalProvider,
): NativeContextCheckpointItem | null {
  let latest: NativeContextCheckpointItem | null = null
  for (const item of items) {
    if (item.kind !== 'provider_event' || item.visibility !== 'provider_private' || item.provider !== provider) continue
    const checkpoint = parseNativeContextCheckpoint(item.payload.nativeContextCheckpoint)
    if (!checkpoint || checkpoint.provider !== provider) continue
    if (!latest || item.sequence > latest.item.sequence) latest = { item, checkpoint }
  }
  return latest
}

function parseNativeContextCheckpoint(value: unknown): NativeContextCheckpoint | null {
  if (!isObject(value) || value.version !== 1) return null
  if (value.provider === 'codex' && value.format === 'codex_replacement_history') {
    if (!Array.isArray(value.history) || !value.history.every(isObject)) return null
    if (value.sourceModel !== null && typeof value.sourceModel !== 'string') return null
    return {
      version: 1,
      provider: 'codex',
      format: 'codex_replacement_history',
      history: value.history,
      sourceModel: value.sourceModel,
    }
  }
  if (value.provider === 'claude' && value.format === 'claude_compact_summary') {
    if (typeof value.summary !== 'string' || !value.summary.trim()) return null
    if (value.metadata !== null && !isObject(value.metadata)) return null
    return {
      version: 1,
      provider: 'claude',
      format: 'claude_compact_summary',
      summary: value.summary,
      metadata: value.metadata,
    }
  }
  return null
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
