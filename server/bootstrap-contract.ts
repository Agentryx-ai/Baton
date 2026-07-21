import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { RECOVERY_RECEIPT_SCHEMA_VERSION } from './client-integration-recovery.ts'

export const BOOTSTRAP_MANIFEST_SCHEMA = 1 as const
export const BOOTSTRAP_VERSION = 1 as const
export const BOOTSTRAP_RECEIPT_SCHEMA = RECOVERY_RECEIPT_SCHEMA_VERSION
export const BOOTSTRAP_EXE = 'baton-bootstrap.exe'
export const BOOTSTRAP_LKG_EXE = 'baton-bootstrap-lkg.exe'

export type BootstrapTrust =
  | { kind: 'unsigned-development' }
  | { kind: 'signed-release'; signerThumbprint: string }

export interface BootstrapManifest {
  schemaVersion: typeof BOOTSTRAP_MANIFEST_SCHEMA
  bootstrapVersion: typeof BOOTSTRAP_VERSION
  receiptSchemaVersion: typeof BOOTSTRAP_RECEIPT_SCHEMA
  artifactPath: string
  artifactSha256: string
  artifactSize: number
  selfTestSha256: string
  activatedAt: string
  workerRoot: string
  workerNode: string
  trust: BootstrapTrust
}

export interface VerifiedBootstrap {
  manifest: BootstrapManifest
  artifact: string
  digest: string
  stableEntry?: string
}

export function bootstrapRoot(): string {
  if (process.env.BATON_BOOTSTRAP_ROOT) return path.resolve(process.env.BATON_BOOTSTRAP_ROOT)
  return path.join(process.env.LOCALAPPDATA ?? homedir(), 'Baton', 'bootstrap')
}

export function activeManifestPath(): string {
  return process.env.BATON_BOOTSTRAP_MANIFEST
    ? path.resolve(process.env.BATON_BOOTSTRAP_MANIFEST)
    : path.join(bootstrapRoot(), 'active.json')
}

export function lastKnownGoodManifestPath(): string {
  return path.join(bootstrapRoot(), 'last-known-good.json')
}

export function stableBootstrapPath(): string {
  return path.join(bootstrapRoot(), BOOTSTRAP_EXE)
}

export function stableLastKnownGoodPath(): string {
  return path.join(bootstrapRoot(), BOOTSTRAP_LKG_EXE)
}

export async function readActiveBootstrapManifest(): Promise<BootstrapManifest> {
  return readManifest(activeManifestPath(), 'active')
}

export async function readLastKnownGoodManifest(): Promise<BootstrapManifest> {
  return readManifest(lastKnownGoodManifestPath(), 'last-known-good')
}

export async function assertBootstrapReady(options: {
  allowUnsignedDevelopment?: boolean
  approvedSignerThumbprint?: string
} = {}): Promise<VerifiedBootstrap> {
  const manifest = await readActiveBootstrapManifest()
  if (manifest.trust.kind === 'signed-release' && !options.approvedSignerThumbprint) {
    throw new Error('Production bootstrap requires an independently approved signer policy')
  }
  const verified = await verifyBootstrapManifest(manifest, options)
  return verifyStableEntry(verified)
}

export async function verifyActiveBootstrapForLifecycle(): Promise<VerifiedBootstrap> {
  const manifest = await readActiveBootstrapManifest()
  const approvedSignerThumbprint = process.env.BATON_APPROVED_SIGNER_THUMBPRINT
  if (manifest.trust.kind === 'signed-release' && !approvedSignerThumbprint) {
    throw new Error('Production bootstrap lifecycle requires an independently approved signer policy')
  }
  const verified = await verifyBootstrapManifest(manifest, {
    allowUnsignedDevelopment: true,
    approvedSignerThumbprint,
  })
  return verifyStableEntry(verified)
}

async function verifyStableEntry(verified: VerifiedBootstrap): Promise<VerifiedBootstrap> {
  const stableEntry = stableBootstrapPath()
  if (sha256(await readFile(stableEntry)) !== verified.digest) {
    throw new Error('Baton stable recovery entry does not match the active artifact')
  }
  if (verified.manifest.trust.kind === 'signed-release') {
    await assertAuthenticode(stableEntry, verified.manifest.trust.signerThumbprint)
  }
  await runSelfTest(stableEntry)
  return { ...verified, stableEntry }
}

export async function verifyBootstrapManifest(
  manifest: BootstrapManifest,
  options: { allowUnsignedDevelopment?: boolean; approvedSignerThumbprint?: string } = {},
): Promise<VerifiedBootstrap> {
  assertTrustAllowed(manifest, options.allowUnsignedDevelopment === true, options.approvedSignerThumbprint)
  const artifact = await resolveArtifactStrict(manifest)
  const metadata = await stat(artifact)
  if (!metadata.isFile() || metadata.size !== manifest.artifactSize) {
    throw new Error('Baton standalone recovery bootstrap artifact is missing or changed')
  }
  const digest = sha256(await readFile(artifact))
  if (digest !== manifest.artifactSha256) {
    throw new Error('Baton standalone recovery bootstrap artifact hash verification failed')
  }
  if (manifest.trust.kind === 'signed-release') {
    await assertAuthenticode(artifact, manifest.trust.signerThumbprint)
  }
  const selfTest = await runSelfTest(artifact)
  if (sha256(selfTest) !== manifest.selfTestSha256) {
    throw new Error('Baton standalone recovery bootstrap self-test proof verification failed')
  }
  return { manifest, artifact, digest }
}

export async function assertBootstrapUnchanged(verified: VerifiedBootstrap): Promise<void> {
  if (!verified.stableEntry) throw new Error('Baton stable recovery entry was not verified before integration apply')
  const artifact = await resolveArtifactStrict(verified.manifest)
  if (artifact !== verified.artifact
    || sha256(await readFile(artifact)) !== verified.digest
    || sha256(await readFile(verified.stableEntry)) !== verified.digest) {
    throw new Error('Baton standalone recovery bootstrap changed during integration apply')
  }
}

export async function resolveArtifactStrict(manifest: BootstrapManifest): Promise<string> {
  const root = bootstrapRoot()
  await mkdir(root, { recursive: true })
  const canonicalRoot = await realpath(root)
  const expectedDeclared = path.join(path.resolve(root), 'versions', manifest.artifactSha256, BOOTSTRAP_EXE)
  const expectedCanonical = path.join(canonicalRoot, 'versions', manifest.artifactSha256, BOOTSTRAP_EXE)
  const declared = path.resolve(root, manifest.artifactPath)
  if (!samePath(declared, expectedDeclared)) {
    throw new Error('Baton standalone recovery bootstrap artifact path is not content-addressed')
  }
  let canonicalArtifact: string
  try {
    canonicalArtifact = await realpath(declared)
  } catch {
    throw new Error('Baton standalone recovery bootstrap artifact is missing or changed')
  }
  if (!samePath(canonicalArtifact, expectedCanonical)) {
    throw new Error('Baton standalone recovery bootstrap artifact escaped through a link or junction')
  }
  return canonicalArtifact
}

export async function withBootstrapLock<T>(action: () => Promise<T>): Promise<T> {
  const root = bootstrapRoot()
  await mkdir(root, { recursive: true })
  const lockPath = path.join(root, 'bootstrap.lock')
  if (process.platform !== 'win32') return action()
  const encoded = Buffer.from(String.raw`$ErrorActionPreference = 'Stop'
$filePath = [Console]::In.ReadLine()
try { $stream = [System.IO.File]::Open($filePath, 'OpenOrCreate', 'ReadWrite', 'None') }
catch { [Console]::Error.Write('BUSY'); exit 3 }
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
[Console]::In.ReadToEnd() | Out-Null
$stream.Dispose()`, 'utf16le').toString('base64')
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.write(`${lockPath}\n`)
  await new Promise<void>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (value: string) => {
      stdout += value
      if (stdout.includes('READY')) resolve()
    })
    child.stderr.setEncoding('utf8').on('data', (value: string) => { stderr += value })
    child.once('error', reject)
    child.once('close', (code) => {
      if (!stdout.includes('READY')) reject(new Error(code === 3 ? 'Baton bootstrap is busy in another process' : redact(stderr)))
    })
  })
  try {
    return await action()
  } finally {
    child.stdin.end()
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => child.once('close', () => resolve()))
    }
  }
}

export async function runSelfTest(artifact: string): Promise<Buffer> {
  return runCapture(artifact, ['self-test', '--json']).then((output) => {
    try {
      const result = JSON.parse(output.toString('utf8')) as Record<string, unknown>
      if (result.ok !== true || result.standalone !== true
        || result.bootstrapVersion !== BOOTSTRAP_VERSION
        || result.receiptSchemaVersion !== BOOTSTRAP_RECEIPT_SCHEMA) throw new Error('contract mismatch')
    } catch {
      throw new Error('Baton standalone recovery bootstrap returned an incompatible self-test result')
    }
    return output
  })
}

export async function authenticodeIdentity(artifact: string): Promise<{ status: string; thumbprint?: string }> {
  const script = Buffer.from(String.raw`$ErrorActionPreference = 'Stop'
$inputObject = [Console]::In.ReadToEnd() | ConvertFrom-Json
$signature = Get-AuthenticodeSignature -LiteralPath ([string]$inputObject.path)
[pscustomobject]@{ status=[string]$signature.Status; thumbprint=$signature.SignerCertificate.Thumbprint } | ConvertTo-Json -Compress`, 'utf16le').toString('base64')
  const output = await runCapture('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', script], JSON.stringify({ path: artifact }))
  return JSON.parse(output.toString('utf8')) as { status: string; thumbprint?: string }
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function readManifest(file: string, label: string): Promise<BootstrapManifest> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    throw new Error(`Baton standalone recovery ${label} manifest is missing or unreadable`)
  }
  if (!isManifest(value)) throw new Error(`Baton standalone recovery ${label} manifest is incompatible`)
  return value
}

function isManifest(value: unknown): value is BootstrapManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  const trust = item.trust as Record<string, unknown> | undefined
  const validTrust = trust?.kind === 'unsigned-development'
    || (trust?.kind === 'signed-release' && typeof trust.signerThumbprint === 'string' && /^[A-Fa-f0-9]{40,64}$/.test(trust.signerThumbprint))
  return item.schemaVersion === BOOTSTRAP_MANIFEST_SCHEMA
    && item.bootstrapVersion === BOOTSTRAP_VERSION
    && item.receiptSchemaVersion === BOOTSTRAP_RECEIPT_SCHEMA
    && typeof item.artifactPath === 'string'
    && typeof item.artifactSha256 === 'string' && /^[a-f0-9]{64}$/.test(item.artifactSha256)
    && typeof item.artifactSize === 'number' && Number.isSafeInteger(item.artifactSize) && item.artifactSize > 0
    && typeof item.selfTestSha256 === 'string' && /^[a-f0-9]{64}$/.test(item.selfTestSha256)
    && typeof item.activatedAt === 'string'
    && typeof item.workerRoot === 'string' && path.isAbsolute(item.workerRoot)
    && typeof item.workerNode === 'string' && path.isAbsolute(item.workerNode)
    && validTrust
}

function assertTrustAllowed(
  manifest: BootstrapManifest,
  allowUnsigned: boolean,
  approvedSignerThumbprint?: string,
): void {
  if (manifest.trust.kind === 'unsigned-development' && !allowUnsigned) {
    throw new Error('Unsigned development bootstrap cannot authorize global integration apply; use a signed release or explicit development override')
  }
  if (manifest.trust.kind === 'signed-release' && approvedSignerThumbprint !== undefined
    && manifest.trust.signerThumbprint.toUpperCase() !== approvedSignerThumbprint.toUpperCase()) {
    throw new Error('Bootstrap signer does not match the independently approved deployment policy')
  }
}

async function assertAuthenticode(artifact: string, expectedThumbprint: string): Promise<void> {
  const identity = await authenticodeIdentity(artifact)
  if (identity.status !== 'Valid' || identity.thumbprint?.toUpperCase() !== expectedThumbprint.toUpperCase()) {
    throw new Error('Baton standalone recovery release signature verification failed')
  }
}

function runCapture(file: string, args: string[], stdin?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk.slice(0, 4096) })
    child.once('error', reject)
    child.once('close', (code) => code === 0
      ? resolve(Buffer.concat(stdout))
      : reject(new Error(redact(stderr || `${path.basename(file)} exited ${code}`))))
    child.stdin.end(stdin)
  })
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

function redact(value: string): string {
  return value
    .replace(/((?:access_token|refresh_token|api_key|api-key|token|authorization)\s*[=:]\s*)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .slice(0, 1000)
}
