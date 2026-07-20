import { createHash } from 'node:crypto'

export function goalEvidenceHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

function canonicalize(current: unknown): unknown {
  if (current === null || typeof current === 'string' || typeof current === 'boolean') return current
  if (typeof current === 'number') {
    if (!Number.isFinite(current)) throw new TypeError('Goal evidence rejects non-finite numbers')
    return Object.is(current, -0) ? 0 : current
  }
  if (Array.isArray(current)) return current.map(canonicalize)
  if (typeof current === 'object') {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(current as Record<string, unknown>).sort()) {
      const child = (current as Record<string, unknown>)[key]
      if (child === undefined) throw new TypeError('Goal evidence rejects undefined values')
      result[key] = canonicalize(child)
    }
    return result
  }
  throw new TypeError(`Goal evidence rejects ${typeof current} values`)
}
