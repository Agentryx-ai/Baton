import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'

import {
  activeManifestPath,
  readLastKnownGoodManifest,
  sha256,
  stableBootstrapPath,
  verifyBootstrapManifest,
  withBootstrapLock,
  type BootstrapManifest,
} from './bootstrap-contract.ts'

export async function restoreActiveMetadataFromLastKnownGood(): Promise<BootstrapManifest> {
  return withBootstrapLock(async () => {
    const lkg = await verifyBootstrapManifest(await readLastKnownGoodManifest(), { allowUnsignedDevelopment: true })
    const activeManifest = activeManifestPath()
    const stableEntry = stableBootstrapPath()
    const previousManifest = await readFile(activeManifest).catch(() => null)
    const previousEntry = await readFile(stableEntry).catch(() => null)
    try {
      const artifact = await readFile(lkg.artifact)
      await atomicReplace(stableEntry, artifact)
      await atomicReplace(activeManifest, Buffer.from(`${JSON.stringify(lkg.manifest, null, 2)}\n`))
      if (sha256(await readFile(stableEntry)) !== lkg.digest) throw new Error('Recovered stable bootstrap hash mismatch')
      await verifyBootstrapManifest(lkg.manifest, { allowUnsignedDevelopment: true })
      return lkg.manifest
    } catch (error) {
      await restore(activeManifest, previousManifest)
      await restore(stableEntry, previousEntry)
      throw error
    }
  })
}

async function restore(target: string, content: Buffer | null): Promise<void> {
  if (content === null) await rm(target, { force: true })
  else await atomicReplace(target, content)
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
