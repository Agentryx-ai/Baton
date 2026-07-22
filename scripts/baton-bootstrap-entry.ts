import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { isSea } from 'node:sea'

import {
  BOOTSTRAP_RECEIPT_SCHEMA,
  BOOTSTRAP_VERSION,
  verifyActiveBootstrapForLifecycle,
  withBootstrapLock,
} from '../server/bootstrap-contract.ts'
import { restoreActiveMetadataFromLastKnownGood } from '../server/bootstrap-metadata-recovery.ts'
import { offlineDoctor, offlineIntegrationRemove, offlineIntegrationStatus } from '../server/client-integration-offline.ts'
import { lifecycleStatus, repairScheduledTask } from '../server/windows-lifecycle.ts'

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'help'
  if (command === 'test-hold' && process.env.NODE_ENV === 'test') {
    const duration = Number(process.env.BATON_TEST_HOLD_BOOTSTRAP_MS ?? 0)
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid test hold duration')
    console.log('BATON_TEST_HOLD_READY')
    await new Promise((resolve) => setTimeout(resolve, duration))
    return
  }
  if (command === 'self-test') {
    const result = {
      ok: isSea(), standalone: isSea(), bootstrapVersion: BOOTSTRAP_VERSION,
      receiptSchemaVersion: BOOTSTRAP_RECEIPT_SCHEMA,
    }
    console.log(JSON.stringify(result))
    if (!result.ok) process.exitCode = 1
    return
  }

  const json = process.argv.includes('--json')
  if (command === 'integration') {
    const subcommand = process.argv[3] ?? 'status'
    if (subcommand === 'status') return output(await offlineIntegrationStatus(), json)
    if (subcommand === 'remove') {
      const result = await offlineIntegrationRemove(parseTargets(process.argv))
      output(result, json)
      if (result.some((item) => !item.ok)) process.exitCode = 1
      return
    }
    throw new Error('Unknown integration command')
  }

  if (command === 'recover-active' && process.argv.includes('--from-lkg')) {
    const restored = await restoreActiveMetadataFromLastKnownGood()
    return output({ recovered: true, artifactSha256: restored.artifactSha256 }, json)
  }

  if (command === 'doctor') {
    const recovery = await offlineDoctor()
    const lifecycle = await lifecycleDiagnostic()
    output({ ...recovery, lifecycle }, json)
    if (!recovery.ok || lifecycle.task?.unavailable) process.exitCode = 1
    return
  }

  if (command === 'autostart' || command === 'worker-runner') {
    if (command === 'worker-runner') {
      process.env.BATON_PORT = String(taskActionPort(process.argv))
      const verified = await withLifecycleBootstrap(async (value) => {
        if (!value.stableEntry || !samePath(await realpath(process.execPath), await realpath(value.stableEntry))) {
          throw new Error('Worker launcher is not the active verified bootstrap artifact')
        }
        return value
      })
      await launchWorkerRunner(verified.manifest.workerNode, verified.manifest.workerRoot)
      return
    }
    const subcommand = process.argv[3] ?? 'status'
    if (subcommand === 'status') return output(await withLifecycleBootstrap(() => lifecycleStatus()), json)
    if (subcommand === 'repair') return output(await withLifecycleBootstrap(async () => {
      await repairScheduledTask()
      return lifecycleStatus()
    }), json)
    throw new Error('Standalone bootstrap supports only autostart status and repair')
  }

  console.log('Usage: baton-bootstrap integration status|remove [--target NAME] [--json]\n  baton-bootstrap doctor [--json]\n  baton-bootstrap autostart status|repair [--json]\n  baton-bootstrap recover-active --from-lkg [--json]')
}

function taskActionPort(argv: string[]): number {
  const index = argv.indexOf('--port')
  const value = index >= 0 ? Number(argv[index + 1]) : Number.NaN
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error('Task action --port must be an integer between 1 and 65535')
  }
  return value
}

async function lifecycleDiagnostic() {
  try {
    return await withLifecycleBootstrap(() => lifecycleStatus())
  } catch (error) {
    return { supported: process.platform === 'win32', task: { exists: false, unavailable: true, error: safe(error) } }
  }
}

async function withLifecycleBootstrap<T>(action: (verified: Awaited<ReturnType<typeof verifyActiveBootstrapForLifecycle>>) => Promise<T>): Promise<T> {
  return withBootstrapLock(async () => {
    const verified = await verifyActiveBootstrapForLifecycle()
    if (!verified.stableEntry) throw new Error('Stable bootstrap entry was not verified')
    process.env.BATON_BOOTSTRAP_EXECUTABLE = verified.stableEntry
    process.env.BATON_WORKER_EXECUTABLE = verified.manifest.workerNode
    process.env.BATON_RELEASE_ROOT = verified.manifest.workerRoot
    return action(verified)
  })
}

async function launchWorkerRunner(workerNode: string, workerRoot: string): Promise<void> {
  const runner = path.join(workerRoot, 'scripts', 'baton-worker-runner.mjs')
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(workerNode, [runner, '--root', workerRoot], {
      cwd: workerRoot, env: process.env, stdio: 'inherit', windowsHide: true,
    })
    child.once('error', reject)
    child.once('close', (value) => resolve(value ?? 1))
  })
  process.exitCode = code
}

function parseTargets(argv: string[]) {
  const valid = new Set(['claude-cli', 'claude-desktop', 'codex'] as const)
  const values: Array<'claude-cli' | 'claude-desktop' | 'codex'> = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--target') continue
    const value = argv[index + 1] as typeof values[number]
    if (!valid.has(value)) throw new Error('Invalid integration target')
    values.push(value)
  }
  return values.length ? [...new Set(values)] : [...valid]
}

function output(value: unknown, json: boolean): void {
  if (json) console.log(JSON.stringify(value, null, 2))
  else if (Array.isArray(value)) {
    for (const item of value as Array<Record<string, unknown>>) {
      console.log(`${item.target ?? 'Baton'}: ${item.ok === false ? 'failed' : item.state ?? 'ok'}${item.error ? ` · ${safe(item.error)}` : ''}`)
    }
  } else console.log(JSON.stringify(value, null, 2))
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

function safe(value: unknown): string {
  const redacted = String(value)
    .replace(/("(?:access_token|refresh_token|api_key|token|authorization)"\s*:\s*")((?:\\.|[^"\\])*)(")/gi, '$1[REDACTED]$3')
    .replace(/((?:access_token|refresh_token|api_key|api-key|token|authorization)\s*[=:]\s*)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED]')
  return Array.from(redacted, (character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || (code >= 127 && code <= 159) ? ' ' : character
  }).join('').slice(0, 1000)
}

main().catch((error) => {
  console.error(`Standalone recovery failed: ${safe(error instanceof Error ? error.message : String(error))}`)
  process.exitCode = 1
})
