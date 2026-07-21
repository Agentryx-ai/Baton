import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { assertBootstrapReady, resolveArtifactStrict, withBootstrapLock } from './bootstrap-contract.ts'

test('bootstrap apply gate fails closed on unknown manifest schema and missing artifacts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'baton-bootstrap-gate-'))
  const previousRoot = process.env.BATON_BOOTSTRAP_ROOT
  process.env.BATON_BOOTSTRAP_ROOT = root
  try {
    await writeFile(path.join(root, 'active.json'), '{"schemaVersion":999}\n')
    await assert.rejects(assertBootstrapReady(), /manifest is incompatible/)

    await mkdir(path.join(root, 'versions', 'missing'), { recursive: true })
    await writeFile(path.join(root, 'active.json'), `${JSON.stringify({
      schemaVersion: 1,
      bootstrapVersion: 1,
      receiptSchemaVersion: 1,
      artifactPath: `versions/${'0'.repeat(64)}/baton-bootstrap.exe`,
      artifactSha256: '0'.repeat(64),
      artifactSize: 1,
      selfTestSha256: '0'.repeat(64),
      activatedAt: new Date().toISOString(),
      workerRoot: 'C:\\Baton',
      workerNode: 'C:\\node.exe',
      trust: { kind: 'unsigned-development' },
    })}\n`)
    await assert.rejects(assertBootstrapReady({ allowUnsignedDevelopment: true }), /artifact is missing or changed/)

    const signed = {
      schemaVersion: 1, bootstrapVersion: 1, receiptSchemaVersion: 1,
      artifactPath: `versions/${'0'.repeat(64)}/baton-bootstrap.exe`,
      artifactSha256: '0'.repeat(64), artifactSize: 1, selfTestSha256: '0'.repeat(64),
      activatedAt: new Date().toISOString(), workerRoot: 'C:\\Baton', workerNode: 'C:\\node.exe',
      trust: { kind: 'signed-release', signerThumbprint: 'A'.repeat(40) },
    }
    await writeFile(path.join(root, 'active.json'), `${JSON.stringify(signed)}\n`)
    await assert.rejects(assertBootstrapReady(), /independently approved signer policy/)
    await assert.rejects(
      assertBootstrapReady({ approvedSignerThumbprint: 'B'.repeat(40) }),
      /does not match the independently approved deployment policy/,
    )
  } finally {
    if (previousRoot === undefined) delete process.env.BATON_BOOTSTRAP_ROOT
    else process.env.BATON_BOOTSTRAP_ROOT = previousRoot
    await rm(root, { recursive: true, force: true })
  }
})

test('bootstrap installer/apply mutex excludes a concurrent contender', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows OS lock contract')
  const root = await mkdtemp(path.join(tmpdir(), 'baton-bootstrap-lock-'))
  const previousRoot = process.env.BATON_BOOTSTRAP_ROOT
  process.env.BATON_BOOTSTRAP_ROOT = root
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const ready = new Promise<void>((resolve) => { entered = resolve })
  try {
    const holder = withBootstrapLock(async () => { entered(); await gate })
    await ready
    await assert.rejects(withBootstrapLock(async () => {}), /busy in another process/i)
    release()
    await holder
  } finally {
    release?.()
    if (previousRoot === undefined) delete process.env.BATON_BOOTSTRAP_ROOT
    else process.env.BATON_BOOTSTRAP_ROOT = previousRoot
    await rm(root, { recursive: true, force: true })
  }
})

test('bootstrap artifact resolver rejects a content-addressed junction escape', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows junction contract')
  const root = await mkdtemp(path.join(tmpdir(), 'baton-bootstrap-junction-'))
  const external = await mkdtemp(path.join(tmpdir(), 'baton-bootstrap-external-'))
  const previousRoot = process.env.BATON_BOOTSTRAP_ROOT
  process.env.BATON_BOOTSTRAP_ROOT = root
  const digest = 'a'.repeat(64)
  try {
    await mkdir(path.join(root, 'versions'), { recursive: true })
    await writeFile(path.join(external, 'baton-bootstrap.exe'), 'not-an-executable')
    await symlink(external, path.join(root, 'versions', digest), 'junction')
    await assert.rejects(resolveArtifactStrict({
      schemaVersion: 1, bootstrapVersion: 1, receiptSchemaVersion: 1,
      artifactPath: path.join('versions', digest, 'baton-bootstrap.exe'),
      artifactSha256: digest, artifactSize: 17, selfTestSha256: 'b'.repeat(64),
      activatedAt: new Date().toISOString(), workerRoot: 'C:\\Baton', workerNode: 'C:\\node.exe',
      trust: { kind: 'unsigned-development' },
    }), /escaped through a link or junction/)
  } finally {
    if (previousRoot === undefined) delete process.env.BATON_BOOTSTRAP_ROOT
    else process.env.BATON_BOOTSTRAP_ROOT = previousRoot
    await rm(root, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
})
