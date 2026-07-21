import { randomUUID } from 'node:crypto'
import {
  copyFile, mkdir, open, readFile, readdir, realpath, rename, rm, stat,
} from 'node:fs/promises'
import path from 'node:path'

import {
  activeManifestPath,
  authenticodeIdentity,
  BOOTSTRAP_EXE,
  BOOTSTRAP_MANIFEST_SCHEMA,
  BOOTSTRAP_RECEIPT_SCHEMA,
  BOOTSTRAP_VERSION,
  bootstrapRoot,
  lastKnownGoodManifestPath,
  readActiveBootstrapManifest,
  readLastKnownGoodManifest,
  runSelfTest,
  sha256,
  stableBootstrapPath,
  stableLastKnownGoodPath,
  verifyBootstrapManifest,
  withBootstrapLock,
  type BootstrapManifest,
  type BootstrapTrust,
  type VerifiedBootstrap,
} from './bootstrap-contract.ts'

export interface InstallOptions {
  artifact: string
  workerRoot: string
  workerNode: string
  trust: BootstrapTrust
  /** Tests only: fail after every switched file has been written. */
  failAfterSwitch?: boolean
  /** Tests only: fail immediately after this many switch paths commit. */
  failAfterSwitchStep?: number
  /** Tests only: keep the OS lock held long enough for a contender. */
  holdLockMs?: number
  /** Tests only: observe that trust is checked before candidate execution. */
  verification?: {
    verifyTrust?: (artifact: string, trust: BootstrapTrust) => Promise<BootstrapTrust>
    selfTest?: (artifact: string) => Promise<Buffer>
  }
}

interface Snapshot {
  path: string
  content: Buffer | null
}

export async function installBootstrap(options: InstallOptions): Promise<BootstrapManifest> {
  return withBootstrapLock(async () => {
    if (options.holdLockMs) await new Promise((resolve) => setTimeout(resolve, options.holdLockMs))
    const root = bootstrapRoot()
    await mkdir(root, { recursive: true })
    const canonicalRoot = await realpath(root)
    const source = await realpath(path.resolve(options.artifact))
    const bytes = await readFile(source)
    const digest = sha256(bytes)
    const verifyTrust = options.verification?.verifyTrust ?? validateInstallTrust
    const executeSelfTest = options.verification?.selfTest ?? runSelfTest
    // Signed candidates are never executed until external trust policy has
    // authenticated the exact source bytes.
    const trust = await verifyTrust(source, options.trust)
    const selfTest = await executeSelfTest(source)
    const relativeArtifact = path.join('versions', digest, BOOTSTRAP_EXE)
    const versionsRoot = path.join(canonicalRoot, 'versions')
    const versionDirectory = path.join(versionsRoot, digest)
    const finalArtifact = path.join(versionDirectory, BOOTSTRAP_EXE)
    const staging = path.join(canonicalRoot, '.staging', randomUUID())
    const stagedArtifact = path.join(staging, BOOTSTRAP_EXE)
    let publishedVersion = false
    let switchCommitted = false
    await mkdir(staging, { recursive: true })
    try {
      await copyFile(source, stagedArtifact)
      if (process.env.NODE_ENV === 'test' && process.env.BATON_TEST_CORRUPT_STAGED === '1') {
        await atomicReplace(stagedArtifact, Buffer.from('corrupt candidate'))
      }
      if (sha256(await readFile(stagedArtifact)) !== digest) throw new Error('Staged bootstrap hash mismatch')
      // Copying is another trust boundary: authenticate the staged exact bytes
      // and signer again before executing their self-test.
      await verifyTrust(stagedArtifact, trust)
      if (!(await executeSelfTest(stagedArtifact)).equals(selfTest)) throw new Error('Staged bootstrap self-test proof mismatch')

      await mkdir(versionsRoot, { recursive: true })
      if (!samePath(await realpath(versionsRoot), versionsRoot)) throw new Error('Bootstrap versions root is not canonical')
      const existingDirectory = await stat(versionDirectory).catch(() => null)
      if (!existingDirectory) {
        // Publish the already verified directory in one rename. A concurrent
        // junction/file creator makes rename fail instead of redirecting writes.
        await rename(staging, versionDirectory)
        publishedVersion = true
      } else {
        if (!existingDirectory.isDirectory() || !samePath(await realpath(versionDirectory), versionDirectory)) {
          throw new Error('Bootstrap version directory escaped through a link or junction')
        }
        const existing = await stat(finalArtifact).catch(() => null)
        if (!existing?.isFile() || sha256(await readFile(finalArtifact)) !== digest) {
          throw new Error('Existing content-addressed bootstrap is not immutable')
        }
      }

      const manifest: BootstrapManifest = {
        schemaVersion: BOOTSTRAP_MANIFEST_SCHEMA,
        bootstrapVersion: BOOTSTRAP_VERSION,
        receiptSchemaVersion: BOOTSTRAP_RECEIPT_SCHEMA,
        artifactPath: relativeArtifact,
        artifactSha256: digest,
        artifactSize: bytes.length,
        selfTestSha256: sha256(selfTest),
        activatedAt: new Date().toISOString(),
        workerRoot: path.resolve(options.workerRoot),
        workerNode: path.resolve(options.workerNode),
        trust,
      }

      const previous = await tryVerify(readActiveBootstrapManifest)
      const existingLkg = await tryVerify(readLastKnownGoodManifest)
      // First install must be recoverable too. The already published candidate
      // is verified through the same manifest contract before it may seed both
      // the active and last-known-good fixed entries.
      const candidate = await verifyBootstrapManifest(manifest, { allowUnsignedDevelopment: true })
      const nextLkg = previous ?? existingLkg ?? candidate
      // Replace the active stable entry first. On Windows a running image locks
      // its executable, so an upgrade then fails before any manifest/LKG byte
      // is changed rather than entering rollback with a still-locked target.
      const switched = [
        stableBootstrapPath(), activeManifestPath(), stableLastKnownGoodPath(), lastKnownGoodManifestPath(),
      ]
      const snapshots = await Promise.all(switched.map(snapshot))
      const snapshotsByPath = new Map(snapshots.map((item) => [item.path, item]))
      const committed: Snapshot[] = []
      const replace = async (target: string, content: Buffer): Promise<void> => {
        await atomicReplace(target, content)
        committed.push(snapshotsByPath.get(target)!)
        if (options.failAfterSwitchStep === committed.length) {
          throw new Error(`Injected switch failure after step ${committed.length}`)
        }
      }
      try {
        await replace(stableBootstrapPath(), bytes)
        await replace(activeManifestPath(), serialize(manifest))
        if (nextLkg) {
          await replace(stableLastKnownGoodPath(), await readFile(nextLkg.artifact))
          await replace(lastKnownGoodManifestPath(), serialize(nextLkg.manifest))
        }
        if (options.failAfterSwitch) throw new Error('Injected post-switch validation failure')
        await verifyBootstrapManifest(manifest, { allowUnsignedDevelopment: true })
        await assertStableCopy(stableBootstrapPath(), digest, selfTest)
        if (nextLkg) await assertStableCopy(stableLastKnownGoodPath(), nextLkg.digest)
        switchCommitted = true
      } catch (error) {
        const rollbackFailures = await rollback(committed)
        if (rollbackFailures.length) {
          throw new AggregateError(
            [error, ...rollbackFailures],
            `Bootstrap switch failed (${message(error)}); rollback was incomplete (${rollbackFailures.map(message).join('; ')})`,
          )
        }
        throw error
      }

      await pruneVersions(canonicalRoot, new Set([digest, ...(nextLkg ? [nextLkg.digest] : [])]))
      return manifest
    } finally {
      await rm(staging, { recursive: true, force: true })
      if (publishedVersion && !switchCommitted) {
        await rm(versionDirectory, { recursive: true, force: true })
      }
    }
  })
}

async function validateInstallTrust(artifact: string, trust: BootstrapTrust): Promise<BootstrapTrust> {
  if (trust.kind === 'unsigned-development') return trust
  const identity = await authenticodeIdentity(artifact)
  if (identity.status !== 'Valid' || !identity.thumbprint
    || identity.thumbprint.toUpperCase() !== trust.signerThumbprint.toUpperCase()) {
    throw new Error('Signed release bootstrap did not pass Authenticode identity verification')
  }
  return { kind: 'signed-release', signerThumbprint: identity.thumbprint.toUpperCase() }
}

async function tryVerify(loader: () => Promise<BootstrapManifest>): Promise<VerifiedBootstrap | null> {
  try {
    return await verifyBootstrapManifest(await loader(), { allowUnsignedDevelopment: true })
  } catch {
    return null
  }
}

async function snapshot(file: string): Promise<Snapshot> {
  return { path: file, content: await readFile(file).catch(() => null) }
}

async function rollback(snapshots: Snapshot[]): Promise<unknown[]> {
  const failures: unknown[] = []
  for (const item of [...snapshots].reverse()) {
    try {
      if (item.content === null) await rm(item.path, { force: true })
      else await atomicReplace(item.path, item.content)
    } catch (error) {
      failures.push(new Error(`Failed to roll back ${path.basename(item.path)}: ${message(error)}`, { cause: error }))
    }
  }
  return failures
}

async function atomicReplace(target: string, content: Buffer): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

async function assertStableCopy(file: string, digest: string, selfTest?: Buffer): Promise<void> {
  if (sha256(await readFile(file)) !== digest) throw new Error('Stable bootstrap entry hash verification failed')
  if (selfTest && !(await runSelfTest(file)).equals(selfTest)) throw new Error('Stable bootstrap entry self-test failed')
}

async function pruneVersions(root: string, retained: Set<string>): Promise<void> {
  const versions = path.join(root, 'versions')
  for (const item of await readdir(versions, { withFileTypes: true })) {
    if (!item.isDirectory() || !/^[a-f0-9]{64}$/.test(item.name) || retained.has(item.name)) continue
    const candidate = path.join(versions, item.name)
    if (!samePath(await realpath(candidate), candidate)) continue
    await rm(candidate, { recursive: true, force: true })
  }
}

function serialize(manifest: BootstrapManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
