export type FallbackProvenance = 'server' | 'user' | 'compatibility-default'
export type FallbackReason = 'quota' | 'safety_refusal'
export type FallbackDirection = 'retry' | 'revert' | 'sticky'

export interface FallbackCapability {
  sourceModel: string
  fallbackModels: string[]
  reasonCategories: FallbackReason[]
  direction: FallbackDirection
  resetHint: number | null
  provenance: FallbackProvenance
}

export interface ModelFallbackEvent {
  id: number
  at: number
  type: 'available' | 'activated' | 'recovered' | 'disabled' | 'failed' | 'server_event'
  preferredModel: string
  effectiveModel: string
  reason: FallbackReason
  direction?: FallbackDirection
  category?: string
  accountId?: string
}

export interface ActiveModelFallback {
  preferredModel: string
  effectiveModel: string
  reason: FallbackReason
  activatedAt: number
  resetHint: number | null
  lastProbeAt: number | null
  accountAlias?: string
}

export interface ModelFallbackStatus {
  enabled: boolean
  promptDismissed: boolean
  userMappings: Record<string, string[]>
  active: ActiveModelFallback[]
  events: ModelFallbackEvent[]
}

type Mapping = Readonly<Record<string, readonly string[]>>

export const CLAUDE_COMPATIBILITY_FALLBACKS: Mapping = {
  'claude-fable-5': ['claude-opus-4-8'],
}

function cleanModels(sourceModel: string, values: readonly unknown[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const model = typeof value === 'string'
      ? value
      : value && typeof value === 'object' && typeof (value as { model?: unknown }).model === 'string'
        ? (value as { model: string }).model
        : null
    if (!model || model === sourceModel || seen.has(model)) continue
    seen.add(model)
    result.push(model)
  }
  return result
}

/** Extract only provider-advertised model relations; unknown shapes are ignored fail-closed. */
export function parseModelFallbackCapabilities(payload: unknown): Map<string, string[]> {
  const result = new Map<string, string[]>()
  if (!payload || typeof payload !== 'object') return result
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return result
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as { id?: unknown; allowed_fallback_models?: unknown }
    if (typeof item.id !== 'string' || !Array.isArray(item.allowed_fallback_models)) continue
    result.set(item.id, cleanModels(item.id, item.allowed_fallback_models))
  }
  return result
}

export function resolveFallbackCapability(options: {
  sourceModel: string
  server: ReadonlyMap<string, readonly string[]>
  user?: Mapping
  compatibility?: Mapping
  reason: FallbackReason
  resetHint?: number | null
}): FallbackCapability | null {
  const { sourceModel } = options
  let values: readonly unknown[] | undefined
  let provenance: FallbackProvenance
  if (options.server.has(sourceModel)) {
    values = options.server.get(sourceModel)
    provenance = 'server'
  } else if (options.user && Object.hasOwn(options.user, sourceModel)) {
    values = options.user[sourceModel]
    provenance = 'user'
  } else if (options.compatibility && Object.hasOwn(options.compatibility, sourceModel)) {
    values = options.compatibility[sourceModel]
    provenance = 'compatibility-default'
  } else {
    return null
  }
  const fallbackModels = cleanModels(sourceModel, values ?? [])
  if (fallbackModels.length === 0) return null
  return {
    sourceModel,
    fallbackModels,
    reasonCategories: [options.reason],
    direction: 'retry',
    resetHint: options.resetHint ?? null,
    provenance,
  }
}

export function parseStructuredRefusal(payload: unknown): { category: string } | null {
  if (!payload || typeof payload !== 'object') return null
  const value = payload as { stop_reason?: unknown; stop_details?: unknown }
  if (value.stop_reason !== 'refusal' || !value.stop_details || typeof value.stop_details !== 'object') return null
  const category = (value.stop_details as { category?: unknown }).category
  return typeof category === 'string' && category.length > 0 ? { category } : null
}

export function parseServerFallbackEvent(payload: unknown): {
  direction: FallbackDirection
  preferredModel: string
  effectiveModel: string
  category?: string
} | null {
  if (!payload || typeof payload !== 'object') return null
  const value = payload as Record<string, unknown>
  if (value.type !== 'system' || value.subtype !== 'model_refusal_fallback') return null
  if (value.direction !== 'retry' && value.direction !== 'revert' && value.direction !== 'sticky') return null
  if (typeof value.original_model !== 'string' || typeof value.fallback_model !== 'string') return null
  return {
    direction: value.direction,
    preferredModel: value.original_model,
    effectiveModel: value.fallback_model,
    ...(typeof value.category === 'string' ? { category: value.category } : {}),
  }
}

export class ModelFallbackController {
  readonly #now: () => number
  readonly #probeIntervalMs: number
  readonly #compatibility: Mapping
  #user: Mapping
  #server = new Map<string, string[]>()
  #enabled: boolean
  #promptDismissed: boolean
  #active = new Map<string, ActiveModelFallback>()
  #events: ModelFallbackEvent[] = []
  #nextEventId = 1

  constructor(options: {
    now?: () => number
    probeIntervalMs?: number
    compatibility?: Mapping
    user?: Mapping
    enabled?: boolean
    promptDismissed?: boolean
    initial?: Partial<ModelFallbackStatus>
  } = {}) {
    this.#now = options.now ?? Date.now
    this.#probeIntervalMs = options.probeIntervalMs ?? 60_000
    this.#compatibility = options.compatibility ?? CLAUDE_COMPATIBILITY_FALLBACKS
    this.#user = options.initial?.userMappings ?? options.user ?? {}
    this.#enabled = options.initial?.enabled ?? options.enabled ?? false
    this.#promptDismissed = options.initial?.promptDismissed ?? options.promptDismissed ?? false
    for (const active of options.initial?.active ?? []) {
      if (active.preferredModel && active.effectiveModel && active.preferredModel !== active.effectiveModel) {
        this.#active.set(active.preferredModel, { ...active })
      }
    }
    this.#events = (options.initial?.events ?? []).slice(-100).map((event) => ({ ...event }))
    this.#nextEventId = Math.max(0, ...this.#events.map((event) => event.id)) + 1
  }

  observeModels(payload: unknown): void {
    this.#server = parseModelFallbackCapabilities(payload)
  }

  setUserMappings(mapping: Mapping): void { this.#user = mapping }

  setEnabled(enabled: boolean): void {
    if (this.#enabled === enabled) return
    this.#enabled = enabled
    if (!enabled) {
      for (const active of this.#active.values()) this.#record('disabled', active)
      this.#active.clear()
    }
  }

  setPromptDismissed(dismissed: boolean): void { this.#promptDismissed = dismissed }

  noteExhausted(sourceModel: string, resetHint: number | null = null): FallbackCapability | null {
    const capability = this.capability(sourceModel, 'quota', resetHint)
    if (!capability) return null
    if (!this.#enabled) {
      if (!this.#promptDismissed && !this.#events.some((event) => (
        event.type === 'available' && event.preferredModel === sourceModel
      ))) {
        this.#record('available', {
          preferredModel: sourceModel,
          effectiveModel: capability.fallbackModels[0],
          reason: 'quota',
        })
      }
      return capability
    }
    if (!this.#active.has(sourceModel)) {
      const active: ActiveModelFallback = {
        preferredModel: sourceModel,
        effectiveModel: capability.fallbackModels[0],
        reason: 'quota',
        activatedAt: this.#now(),
        resetHint: capability.resetHint,
        lastProbeAt: this.#now(),
      }
      this.#active.set(sourceModel, active)
      this.#record('activated', active)
    }
    return capability
  }

  capability(
    sourceModel: string,
    reason: FallbackReason,
    resetHint: number | null = null,
  ): FallbackCapability | null {
    return resolveFallbackCapability({
      sourceModel,
      server: this.#server,
      user: this.#user,
      compatibility: this.#compatibility,
      reason,
      resetHint,
    })
  }

  requestModel(preferredModel: string): { model: string; probing: boolean } {
    const active = this.#active.get(preferredModel)
    if (!active || !this.#enabled) return { model: preferredModel, probing: false }
    const now = this.#now()
    const due = active.lastProbeAt === null
      || now - active.lastProbeAt >= this.#probeIntervalMs
      || (active.resetHint !== null && now >= active.resetHint)
    if (due) {
      active.lastProbeAt = now
      return { model: preferredModel, probing: true }
    }
    return { model: active.effectiveModel, probing: false }
  }

  recovered(preferredModel: string): void {
    const active = this.#active.get(preferredModel)
    if (!active) return
    this.#active.delete(preferredModel)
    this.#record('recovered', { ...active, effectiveModel: preferredModel })
  }

  failed(preferredModel: string, effectiveModel: string): void {
    this.#record('failed', { preferredModel, effectiveModel, reason: 'quota' })
  }

  recordAccount(preferredModel: string, accountAlias: string): void {
    const active = this.#active.get(preferredModel)
    if (!active || !accountAlias) return
    active.accountAlias = accountAlias
    const activated = [...this.#events].reverse().find((event) => (
      event.type === 'activated' && event.preferredModel === preferredModel
    ))
    if (activated) activated.accountId = accountAlias
  }

  observeServerEvent(payload: unknown): boolean {
    const event = parseServerFallbackEvent(payload)
    if (!event) return false
    this.#record('server_event', {
      preferredModel: event.preferredModel,
      effectiveModel: event.effectiveModel,
      reason: 'safety_refusal',
      direction: event.direction,
      category: event.category,
    })
    return true
  }

  observeRefusal(payload: unknown, preferredModel: string): boolean {
    const refusal = parseStructuredRefusal(payload)
    if (!refusal) return false
    this.#record('server_event', {
      preferredModel,
      effectiveModel: preferredModel,
      reason: 'safety_refusal',
      category: refusal.category,
    })
    return true
  }

  status(): ModelFallbackStatus {
    return {
      enabled: this.#enabled,
      promptDismissed: this.#promptDismissed,
      userMappings: Object.fromEntries(Object.entries(this.#user).map(([source, models]) => [source, [...models]])),
      active: Array.from(this.#active.values(), (value) => ({ ...value })),
      events: this.#events.map((event) => ({ ...event })),
    }
  }

  #record(type: ModelFallbackEvent['type'], value: {
    preferredModel: string
    effectiveModel: string
    reason: FallbackReason
    direction?: FallbackDirection
    category?: string
    accountId?: string
  }): void {
    this.#events.push({ id: this.#nextEventId++, at: this.#now(), type, ...value })
    if (this.#events.length > 100) this.#events.splice(0, this.#events.length - 100)
  }
}
