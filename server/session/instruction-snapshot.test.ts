import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canonicalDeveloperInstructions,
  MAX_DEVELOPER_INSTRUCTION_BYTES,
  normalizeInstructionSnapshot,
} from './instruction-snapshot.ts'

test('canonical instructions accept only the explicit bounded developer field', () => {
  assert.equal(canonicalDeveloperInstructions({ unknown: 'do not promote me' }), null)
  assert.equal(canonicalDeveloperInstructions({ developerInstructions: '  verify first  ' }), 'verify first')
  assert.throws(
    () => canonicalDeveloperInstructions({ developerInstructions: 3 }),
    /must be a string/,
  )
  assert.throws(
    () => canonicalDeveloperInstructions({
      developerInstructions: '😀'.repeat(Math.floor(MAX_DEVELOPER_INSTRUCTION_BYTES / 4) + 1),
    }),
    /exceeds/,
  )
})

test('public instruction snapshots are versioned and reject authority-shaped unknown fields', () => {
  assert.deepEqual(normalizeInstructionSnapshot({ developerInstructions: ' ship ' }), {
    schemaVersion: 1,
    developerInstructions: 'ship',
  })
  assert.throws(() => normalizeInstructionSnapshot({ cwd: 'C:\\escape' }), /unsupported fields/)
  assert.throws(() => normalizeInstructionSnapshot({ schemaVersion: 2 }), /must be 1/)
})
