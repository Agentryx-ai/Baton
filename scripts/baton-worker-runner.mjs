#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import {
  chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const portIndex = process.argv.indexOf('--port')
if (portIndex >= 0) {
  const port = Number(process.argv[portIndex + 1])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Task action --port must be an integer between 1 and 65535')
  }
  process.env.BATON_PORT = String(port)
}
const rootIndex = process.argv.indexOf('--root')
const root = path.resolve(rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd())
const stateRoot = process.env.BATON_RECOVERY_ROOT ?? path.join(process.env.LOCALAPPDATA ?? homedir(), 'Baton')
const lifecycleDir = path.join(stateRoot, 'lifecycle')
const DEFAULT_MAX_LOG_BYTES = 1024 * 1024
const requestedTestMax = Number(process.env.BATON_WORKER_LOG_MAX_BYTES)
const maxLogBytes = process.env.NODE_ENV === 'test' && Number.isSafeInteger(requestedTestMax)
  ? Math.max(64 * 1024, Math.min(DEFAULT_MAX_LOG_BYTES, requestedTestMax))
  : DEFAULT_MAX_LOG_BYTES
const testFailureAfter = process.env.NODE_ENV === 'test'
  ? Number(process.env.BATON_TEST_FORCE_LOG_FAILURE_AFTER_WRITES ?? Number.POSITIVE_INFINITY)
  : Number.POSITIVE_INFINITY

mkdirSync(lifecycleDir, { recursive: true, mode: 0o700 })
chmodSync(lifecycleDir, 0o700)
if (process.platform === 'win32') {
  const account = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME
  if (!account) throw new Error('Unable to determine CurrentUser for lifecycle log ACL')
  execFileSync('icacls.exe', [lifecycleDir, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`, '/t'], {
    windowsHide: true,
    stdio: 'ignore',
  })
}

let writes = 0
class BoundedLog {
  constructor(name) {
    this.file = path.join(lifecycleDir, name)
    this.rotated = `${this.file}.1`
    this.fd = openSync(this.file, 'a', 0o600)
    chmodSync(this.file, 0o600)
    this.bytes = fstatSync(this.fd).size
  }

  write(text) {
    writes += 1
    if (writes > testFailureAfter) throw new Error('Injected lifecycle log failure')
    const value = Buffer.from(text, 'utf8')
    if (this.bytes + value.length > maxLogBytes) this.rotate()
    const slice = value.length > maxLogBytes ? value.subarray(value.length - maxLogBytes) : value
    writeSync(this.fd, slice)
    this.bytes += slice.length
  }

  rotate() {
    closeSync(this.fd)
    rmSync(this.rotated, { force: true })
    if (existsSync(this.file)) renameSync(this.file, this.rotated)
    this.fd = openSync(this.file, 'w', 0o600)
    chmodSync(this.file, 0o600)
    this.bytes = 0
  }

  close() {
    if (this.fd !== undefined) {
      closeSync(this.fd)
      this.fd = undefined
    }
  }
}

function redact(value) {
  return String(value)
    .replace(/("(?:access_token|refresh_token|api_key|token|authorization)"\s*:\s*")((?:\\.|[^"\\])*)(")/gi, '$1[REDACTED]$3')
    .replace(/(authorization\s*:\s*)(?:Bearer\s+)?[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/((?:access_token|refresh_token|api_key|api-key|token|authorization)\s*[=:]\s*)(["'])((?:\\.|(?!\2).)*)(\2)/gi, '$1$2[REDACTED]$4')
    .replace(/((?:access_token|refresh_token|api_key|api-key|token|authorization)\s*[=:]\s*)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/([?&](?:access_token|refresh_token|api_key|api-key|token|authorization)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|sess|oauth)[-_][A-Za-z0-9._-]{8,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED]')
}

const eventLog = new BoundedLog('events.jsonl')
const workerLog = new BoundedLog('worker.log')
function record(event) {
  eventLog.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
}

function lineSink(stream, onFailure) {
  let pending = ''
  let discardingOverlongLine = false
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    try {
      if (discardingOverlongLine) {
        const newline = chunk.indexOf('\n')
        if (newline < 0) return
        chunk = chunk.slice(newline + 1)
        discardingOverlongLine = false
      }
      pending += chunk
      let newline
      while ((newline = pending.indexOf('\n')) >= 0) {
        workerLog.write(`${redact(pending.slice(0, newline))}\n`)
        pending = pending.slice(newline + 1)
      }
      if (pending.length > 64 * 1024) {
        workerLog.write('[overlong worker output redacted]\n')
        pending = ''
        discardingOverlongLine = true
      }
    } catch (error) { onFailure(error) }
  })
  return () => {
    if (pending && !discardingOverlongLine) workerLog.write(redact(pending))
    pending = ''
  }
}

const defaultExecutable = process.execPath
const defaultArguments = [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'server/index.ts']
const workerExecutable = process.env.BATON_WORKER_EXECUTABLE ?? defaultExecutable
const workerArguments = process.env.BATON_WORKER_ARGS_JSON
  ? JSON.parse(process.env.BATON_WORKER_ARGS_JSON)
  : defaultArguments
if (!Array.isArray(workerArguments) || workerArguments.some((value) => typeof value !== 'string')) {
  throw new Error('Invalid BATON_WORKER_ARGS_JSON')
}

const restartCount = Math.max(0, Math.min(3, Number(process.env.BATON_WORKER_RESTART_COUNT ?? 3)))
const restartIntervalMs = process.env.NODE_ENV === 'test'
  ? Math.max(0, Number(process.env.BATON_WORKER_RESTART_INTERVAL_MS ?? 60_000))
  : 60_000
let activeChild
let stopRequested = false
let wakeDelay
function terminateOwnedChild() {
  const child = activeChild
  if (!child || child.exitCode !== null || !child.pid) return
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    } catch { child.kill() }
  } else {
    child.kill('SIGTERM')
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopRequested = true
    wakeDelay?.()
    terminateOwnedChild()
  })
}

async function runWorker(attempt) {
  const child = spawn(workerExecutable, workerArguments, {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  activeChild = child
  const childOutcome = new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: 1, event: 'worker-start-failed', reason: error.code ?? 'spawn-error' }))
    child.once('exit', (code, signal) => resolve({ code: typeof code === 'number' ? code : 1, event: 'worker-exited', signal: signal ?? null }))
  })
  const childClosed = new Promise((resolve) => child.once('close', resolve))
  let resolveLogFailure
  const logFailure = new Promise((resolve) => { resolveLogFailure = resolve })
  const onLogFailure = (error) => {
    terminateOwnedChild()
    resolveLogFailure({ code: 1, event: 'runner-log-failed', error })
  }
  const flushStdout = lineSink(child.stdout, onLogFailure)
  const flushStderr = lineSink(child.stderr, onLogFailure)
  try { record({ event: 'worker-started', attempt, pid: child.pid ?? null }) } catch (error) { onLogFailure(error) }
  const outcome = await Promise.race([childOutcome, logFailure])
  if (outcome.event === 'runner-log-failed') {
    terminateOwnedChild()
    await childClosed
    throw outcome.error
  }
  await childClosed
  flushStdout()
  flushStderr()
  record({ event: outcome.event, attempt, code: outcome.code, signal: outcome.signal ?? null, reason: outcome.reason })
  activeChild = undefined
  return outcome
}

let finalCode = 1
try {
  for (let attempt = 0; attempt <= restartCount; attempt += 1) {
    const outcome = await runWorker(attempt)
    finalCode = outcome.code
    if (outcome.code === 0 || stopRequested) break
    if (attempt === restartCount) {
      record({ event: 'worker-restart-exhausted', attempts: attempt + 1, lastCode: outcome.code })
      // Worker failures were handled and diagnosed by this bounded runner.
      // Exit success so Task Scheduler does not multiply these four attempts.
      finalCode = 0
      break
    }
    record({ event: 'worker-restart-scheduled', nextAttempt: attempt + 1, delayMs: restartIntervalMs })
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, restartIntervalMs)
      wakeDelay = () => { clearTimeout(timer); resolve() }
    })
    wakeDelay = undefined
    if (stopRequested) break
  }
} catch {
  terminateOwnedChild()
  finalCode = 1
} finally {
  eventLog.close()
  workerLog.close()
}
process.exitCode = finalCode
