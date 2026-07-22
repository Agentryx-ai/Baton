#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { assertLiveBatonUnchanged, snapshotLiveBaton } from './test-lifecycle-guard.mjs'

const root = process.cwd()
const fixture = await mkdtemp(path.join(tmpdir(), 'baton-isolated-tests-'))
let exitCode = 1

try {
  // This must succeed before the test process is spawned. An unreadable live
  // lifecycle state means isolation cannot be proven, so the suite stays off.
  const before = await snapshotLiveBaton()
  const port = await reserveTemporaryPort()
  const env = isolatedEnvironment(fixture, port)
  const patterns = process.argv.slice(2)
  const tests = patterns.length > 0 ? patterns : ['server/**/*.test.ts']
  console.log(`Isolated tests: port ${port}, task ${env.BATON_TASK_NAME}`)
  exitCode = await run(process.execPath, [
    path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    '--test',
    ...tests,
  ], env)
  const after = await snapshotLiveBaton()
  assertLiveBatonUnchanged(before, after)
  console.log(`Live Baton unchanged: PID ${after.listenerPid ?? 'absent'}, health and ${after.tasks.length} task definition(s) identical.`)
} catch (error) {
  console.error(`Isolated test guard failed closed: ${error instanceof Error ? error.message : String(error)}`)
  exitCode = 1
} finally {
  await rm(fixture, { recursive: true, force: true })
}

process.exit(exitCode)

function isolatedEnvironment(directory, port) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('BATON_')),
  )
  const home = path.join(directory, 'home')
  const localAppData = path.join(directory, 'local-app-data')
  const recoveryRoot = path.join(directory, 'recovery')
  return {
    ...env,
    NODE_ENV: 'test',
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: localAppData,
    APPDATA: path.join(directory, 'app-data'),
    XDG_CONFIG_HOME: path.join(directory, 'xdg-config'),
    BATON_PORT: String(port),
    BATON_URL: `http://127.0.0.1:${port}`,
    BATON_TASK_NAME: `Baton-Test-Isolated-${randomUUID()}`,
    BATON_RELEASE_ROOT: path.join(directory, 'release-root'),
    BATON_RECOVERY_ROOT: recoveryRoot,
    BATON_BOOTSTRAP_ROOT: path.join(directory, 'bootstrap'),
    BATON_OFFLINE_HOME: home,
    BATON_OFFLINE_LOCAL_APP_DATA: localAppData,
    BATON_WORKER_EXECUTABLE: process.execPath,
  }
}

function reserveTemporaryPort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not reserve an isolated test port')))
        return
      }
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

function run(file, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env, windowsHide: true, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code) => resolve(code ?? 1))
  })
}
