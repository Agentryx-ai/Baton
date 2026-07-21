import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { installBootstrap } from './bootstrap-installer.ts'

test('wrong-signer release candidate is rejected before any candidate execution', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'baton-bootstrap-untrusted-'))
  const candidate = path.join(root, 'untrusted.exe')
  const previousRoot = process.env.BATON_BOOTSTRAP_ROOT
  process.env.BATON_BOOTSTRAP_ROOT = path.join(root, 'bootstrap')
  await writeFile(candidate, 'untrusted candidate bytes')
  let trustChecks = 0
  let executions = 0
  try {
    await assert.rejects(installBootstrap({
      artifact: candidate,
      workerRoot: 'C:\\Baton',
      workerNode: 'C:\\node.exe',
      trust: { kind: 'signed-release', signerThumbprint: 'A'.repeat(40) },
      verification: {
        verifyTrust: async () => {
          trustChecks += 1
          throw new Error('wrong signer')
        },
        selfTest: async () => {
          executions += 1
          return Buffer.from('{}')
        },
      },
    }), /wrong signer/)
    assert.equal(trustChecks, 1)
    assert.equal(executions, 0)
  } finally {
    if (previousRoot === undefined) delete process.env.BATON_BOOTSTRAP_ROOT
    else process.env.BATON_BOOTSTRAP_ROOT = previousRoot
    await rm(root, { recursive: true, force: true })
  }
})
