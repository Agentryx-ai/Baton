#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { DEFAULT_ISOLATED_TEST_PATTERNS, isolatedEnvironment } from './isolated-test-environment.mjs'
import { assertLiveBatonUnchanged, snapshotLiveBaton } from './test-lifecycle-guard.mjs'
import { reserveTemporaryPort } from './temporary-port-reservation.mjs'

const root = process.cwd()
const fixture = await mkdtemp(path.join(tmpdir(), 'baton-isolated-tests-'))
let exitCode = 1
let portReservation

try {
  // This must succeed before the test process is spawned. An unreadable live
  // lifecycle state means isolation cannot be proven, so the suite stays off.
  const before = await snapshotLiveBaton()
  portReservation = await reserveTemporaryPort('isolated test port')
  const port = portReservation.port
  const env = isolatedEnvironment(fixture, port)
  const patterns = process.argv.slice(2)
  const tests = patterns.length > 0 ? patterns : DEFAULT_ISOLATED_TEST_PATTERNS
  console.log(`Isolated tests: port ${port}, task ${env.BATON_TASK_NAME}`)
  exitCode = await run(process.execPath, [
    path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    '--test',
    ...tests,
  ], env, portReservation.release)
  portReservation = undefined
  const after = await snapshotLiveBaton()
  assertLiveBatonUnchanged(before, after)
  console.log(`Live Baton unchanged: PID ${after.listenerPid ?? 'absent'}, health and ${after.tasks.length} task definition(s) identical.`)
} catch (error) {
  console.error(`Isolated test guard failed closed: ${error instanceof Error ? error.message : String(error)}`)
  exitCode = 1
} finally {
  await portReservation?.release()
  await rm(fixture, { recursive: true, force: true })
}

process.exit(exitCode)

async function run(file, args, env, beforeSpawn) {
  await beforeSpawn()
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env, windowsHide: true, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code) => resolve(code ?? 1))
  })
}
