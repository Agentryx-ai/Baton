import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  ModelFallbackController,
  type ActiveModelFallback,
  type ModelFallbackEvent,
  type ModelFallbackStatus,
} from './model-fallback.ts'

interface StoredFallbackState extends ModelFallbackStatus { version: 1 }

const EVENT_TYPES = new Set<ModelFallbackEvent['type']>([
  'available', 'activated', 'recovered', 'disabled', 'failed', 'server_event',
])
const REASONS = new Set(['quota', 'safety_refusal'])
const DIRECTIONS = new Set(['retry', 'revert', 'sticky'])

function finiteOrNull(value: unknown): number | null | undefined {
  return value === null ? null : typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseActive(value: unknown): ActiveModelFallback | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const resetHint = finiteOrNull(item.resetHint)
  const lastProbeAt = finiteOrNull(item.lastProbeAt)
  if (
    typeof item.preferredModel !== 'string'
    || typeof item.effectiveModel !== 'string'
    || item.preferredModel === item.effectiveModel
    || !REASONS.has(String(item.reason))
    || typeof item.activatedAt !== 'number'
    || !Number.isFinite(item.activatedAt)
    || resetHint === undefined
    || lastProbeAt === undefined
  ) return null
  return {
    preferredModel: item.preferredModel,
    effectiveModel: item.effectiveModel,
    reason: item.reason as ActiveModelFallback['reason'],
    activatedAt: item.activatedAt,
    resetHint,
    lastProbeAt,
    ...(typeof item.accountAlias === 'string' ? { accountAlias: item.accountAlias.slice(0, 200) } : {}),
  }
}

function parseEvent(value: unknown): ModelFallbackEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (
    typeof item.id !== 'number'
    || !Number.isSafeInteger(item.id)
    || item.id < 1
    || typeof item.at !== 'number'
    || !Number.isFinite(item.at)
    || !EVENT_TYPES.has(item.type as ModelFallbackEvent['type'])
    || typeof item.preferredModel !== 'string'
    || typeof item.effectiveModel !== 'string'
    || !REASONS.has(String(item.reason))
    || (item.direction !== undefined && !DIRECTIONS.has(String(item.direction)))
  ) return null
  return {
    id: item.id,
    at: item.at,
    type: item.type as ModelFallbackEvent['type'],
    preferredModel: item.preferredModel,
    effectiveModel: item.effectiveModel,
    reason: item.reason as ModelFallbackEvent['reason'],
    ...(typeof item.direction === 'string' ? { direction: item.direction as ModelFallbackEvent['direction'] } : {}),
    ...(typeof item.category === 'string' ? { category: item.category.slice(0, 200) } : {}),
    ...(typeof item.accountId === 'string' ? { accountId: item.accountId.slice(0, 200) } : {}),
  }
}

function parseMappings(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).slice(0, 100).flatMap(([source, models]) => {
    if (!source || source.length > 200 || !Array.isArray(models)) return []
    const valid = models.filter((model): model is string => (
      typeof model === 'string' && model.length > 0 && model.length <= 200
    )).slice(0, 10)
    return valid.length > 0 ? [[source, valid]] : []
  }))
}

function readState(filePath: string): Partial<ModelFallbackStatus> | undefined {
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const stored = value as Partial<StoredFallbackState>
    if (stored.version !== 1) return undefined
    const active = Array.isArray(stored.active)
      ? stored.active.slice(0, 100).flatMap((item) => parseActive(item) ?? [])
      : []
    const events = Array.isArray(stored.events)
      ? stored.events.slice(-100).flatMap((item) => parseEvent(item) ?? [])
      : []
    return {
      enabled: stored.enabled === true,
      promptDismissed: stored.promptDismissed === true,
      userMappings: parseMappings(stored.userMappings),
      active,
      events,
    }
  } catch {
    return undefined
  }
}

export class ModelFallbackRuntime {
  readonly controller: ModelFallbackController
  readonly #filePath: string

  constructor(options: { filePath: string; now?: () => number; probeIntervalMs?: number }) {
    this.#filePath = options.filePath
    this.controller = new ModelFallbackController({
      now: options.now,
      probeIntervalMs: options.probeIntervalMs,
      initial: readState(options.filePath),
    })
  }

  status(): ModelFallbackStatus { return this.controller.status() }

  update(input: {
    enabled?: boolean
    promptDismissed?: boolean
    userMappings?: Record<string, string[]>
  }): ModelFallbackStatus {
    if (input.userMappings !== undefined) this.controller.setUserMappings(input.userMappings)
    if (input.promptDismissed !== undefined) this.controller.setPromptDismissed(input.promptDismissed)
    if (input.enabled !== undefined) this.controller.setEnabled(input.enabled)
    return this.persist()
  }

  persist(): ModelFallbackStatus {
    const status = this.controller.status()
    mkdirSync(path.dirname(this.#filePath), { recursive: true })
    const temporary = `${this.#filePath}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ version: 1, ...status }, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600,
    })
    renameSync(temporary, this.#filePath)
    return status
  }
}

export function modelFallbackStatePath(dataDir: string): string {
  return path.join(dataDir, 'model-fallback.v1.json')
}
