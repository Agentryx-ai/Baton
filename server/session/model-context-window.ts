import type { CanonicalProvider } from './domain.ts'

export const CONSERVATIVE_CONTEXT_WINDOW_TOKENS = 128_000

const CODEX_272K_MODELS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.2',
])

export interface ModelContextDefaults {
  contextWindowTokens: number
  /** Provider-client input allowance after its own reserved headroom. */
  usableInputTokens: number | null
  /** Provider-client default pre-turn compaction threshold. */
  autoCompactTokens: number | null
}

/**
 * Provider/model defaults used only when an adapter cannot advertise a
 * model-specific value. Keep unknown models on the conservative fallback.
 */
export function modelContextWindowTokens(
  provider: CanonicalProvider,
  model: string,
  advertised: number | null,
): number {
  if (advertised !== null && Number.isSafeInteger(advertised) && advertised > 0) {
    return advertised
  }
  if (provider === 'codex' && CODEX_272K_MODELS.has(model)) return 272_000
  if (provider === 'claude') return claudeContextWindowTokens(model)
  return CONSERVATIVE_CONTEXT_WINDOW_TOKENS
}

export function modelContextDefaults(
  provider: CanonicalProvider,
  model: string,
  advertised: number | null,
): ModelContextDefaults {
  const contextWindowTokens = modelContextWindowTokens(provider, model, advertised)
  if (provider === 'codex' && CODEX_272K_MODELS.has(model)) {
    return {
      contextWindowTokens,
      usableInputTokens: Math.floor(contextWindowTokens * 0.95),
      autoCompactTokens: Math.floor(contextWindowTokens * 0.9),
    }
  }
  return { contextWindowTokens, usableInputTokens: null, autoCompactTokens: null }
}

function claudeContextWindowTokens(model: string): number {
  if (model.startsWith('claude-fable-5')) return 1_000_000
  if (model.startsWith('claude-sonnet-5')) return 1_000_000
  if (/^claude-opus-4-(?:6|7|8)(?:-|$)/u.test(model)) return 1_000_000
  if (/^claude-sonnet-4-6(?:-|$)/u.test(model)) return 1_000_000
  if (model.startsWith('claude-haiku-4-5')) return 200_000
  return 200_000
}
