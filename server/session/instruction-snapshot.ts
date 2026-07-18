export const MAX_DEVELOPER_INSTRUCTION_BYTES = 32 * 1_024

export interface InstructionSnapshotV1 extends Record<string, unknown> {
  schemaVersion: 1
  developerInstructions: string | null
}

export function normalizeInstructionSnapshot(snapshot: Record<string, unknown>): InstructionSnapshotV1 {
  const allowed = new Set(['schemaVersion', 'developerInstructions'])
  const unknown = Object.keys(snapshot).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new Error(`instructionSnapshot contains unsupported fields: ${unknown.join(', ')}`)
  if (snapshot.schemaVersion !== undefined && snapshot.schemaVersion !== 1) {
    throw new Error('instructionSnapshot.schemaVersion must be 1')
  }
  return {
    schemaVersion: 1,
    developerInstructions: canonicalDeveloperInstructions(snapshot),
  }
}

/**
 * Returns the one provider-neutral instruction field Baton currently supports.
 * Unknown snapshot keys remain durable metadata and never become model instructions implicitly.
 */
export function canonicalDeveloperInstructions(snapshot: Record<string, unknown> | undefined): string | null {
  const value = snapshot?.developerInstructions
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error('instructionSnapshot.developerInstructions must be a string')
  const trimmed = value.trim()
  if (!trimmed) return null
  if (new TextEncoder().encode(trimmed).byteLength > MAX_DEVELOPER_INSTRUCTION_BYTES) {
    throw new Error(`instructionSnapshot.developerInstructions exceeds ${MAX_DEVELOPER_INSTRUCTION_BYTES} UTF-8 bytes`)
  }
  return trimmed
}
