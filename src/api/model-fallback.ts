import type { ModelFallbackEvent } from './types.ts'

/** Return only unresolved offers while preserving the canonical event history. */
export function pendingModelFallbackOffers(
  events: readonly ModelFallbackEvent[],
): ModelFallbackEvent[] {
  const resolvedModels = new Set<string>()
  const pending: ModelFallbackEvent[] = []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (resolvedModels.has(event.preferredModel)) continue
    if (
      event.type === 'available'
      || event.type === 'activated'
      || event.type === 'recovered'
      || event.type === 'disabled'
    ) {
      resolvedModels.add(event.preferredModel)
      if (event.type === 'available') pending.push(event)
    }
  }
  return pending.reverse()
}
