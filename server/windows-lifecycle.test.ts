import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createLifecyclePlan,
  installScheduledTask,
  lifecycleStatus,
  registrationScript,
  repairScheduledTask,
  restartWorker,
  stopWorker,
  uninstallScheduledTask,
} from './windows-lifecycle.ts'

test('scheduled task plan preserves spaces and uses CurrentUser limited interactive principal', () => {
  const plan = createLifecyclePlan({
    root: 'C:\\Path With Spaces\\Baton',
    executable: 'C:\\Program Files\\nodejs\\node.exe',
    userId: 'DOMAIN\\alice',
    taskName: 'Baton-Test-Plan',
  })
  const script = registrationScript(plan)
  assert.match(plan.arguments, /^"C:\\Path With Spaces\\Baton\\scripts\\baton-worker-runner\.mjs" --root "C:\\Path With Spaces\\Baton"$/)
  assert.match(script, /-LogonType Interactive -RunLevel Limited/)
  assert.match(script, /-AtLogOn -User 'DOMAIN\\alice'/)
  assert.match(script, /-RestartCount 3/)
  assert.match(script, /-RestartInterval \(New-TimeSpan -Minutes 1\)/)
  assert.match(script, /-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries/)
  assert.doesNotMatch(script, /SYSTEM|LocalSystem/)
})

test('standalone bootstrap becomes the task action without changing the Worker checkout identity', () => {
  const previousBootstrap = process.env.BATON_BOOTSTRAP_EXECUTABLE
  process.env.BATON_BOOTSTRAP_EXECUTABLE = 'C:\\Local App Data\\Baton\\bootstrap\\versions\\v1\\baton-bootstrap.exe'
  try {
    const plan = createLifecyclePlan({ root: 'C:\\Path With Spaces\\Baton', taskName: 'Baton-Test-Bootstrap' })
    assert.equal(plan.executable, process.env.BATON_BOOTSTRAP_EXECUTABLE)
    assert.equal(plan.arguments, 'worker-runner --root "C:\\Path With Spaces\\Baton"')
    assert.equal(plan.root, 'C:\\Path With Spaces\\Baton')
  } finally {
    if (previousBootstrap === undefined) delete process.env.BATON_BOOTSTRAP_EXECUTABLE
    else process.env.BATON_BOOTSTRAP_EXECUTABLE = previousBootstrap
  }
})

test('normal lifecycle imports derive the checkout root independently of cwd', () => {
  const previousReleaseRoot = process.env.BATON_RELEASE_ROOT
  const previousCwd = process.cwd()
  delete process.env.BATON_RELEASE_ROOT
  try {
    process.chdir(tmpdir())
    const plan = createLifecyclePlan({ taskName: 'Baton-Test-Module-Root' })
    assert.equal(plan.root, path.resolve(fileURLToPath(new URL('..', import.meta.url))))
  } finally {
    process.chdir(previousCwd)
    if (previousReleaseRoot === undefined) delete process.env.BATON_RELEASE_ROOT
    else process.env.BATON_RELEASE_ROOT = previousReleaseRoot
  }
})

test('registration requires explicit opt-in and is idempotent', async () => {
  const calls: string[] = []
  const plan = createLifecyclePlan({ root: 'C:\\Baton', userId: 'alice', taskName: 'test' })
  const run = async (script: string) => { calls.push(script); return '{"exists":true,"enabled":true,"ownershipMatches":true,"definitionMatches":true}' }
  await assert.rejects(() => installScheduledTask(false, plan, run), /explicit --confirm/)
  assert.equal(calls.length, 0)
  await installScheduledTask(true, plan, run)
  assert.equal(calls.length, 1)
  assert.match(calls[0] ?? '', /if \(\$null -ne \$task\)/)
  assert.match(calls[0] ?? '', /Service-account lifecycle mutation is forbidden/)
  assert.doesNotMatch(calls[0] ?? '', /Register-ScheduledTask[^\n]*-Force/)
})

test('every mutation embeds ownership and full-definition guards before changing a task', async () => {
  const plan = createLifecyclePlan({ root: 'C:\\Baton', userId: 'alice', taskName: 'test' })
  const calls: string[] = []
  const run = async (script: string) => { calls.push(script); return '{"exists":true,"ownershipMatches":true,"definitionMatches":true}' }
  await installScheduledTask(true, plan, run)
  await repairScheduledTask(plan, run)
  await stopWorker(plan, run)
  await uninstallScheduledTask(plan, run)
  for (const script of calls) {
    assert.match(script, /Scheduled Task ownership mismatch/)
    assert.match(script, /Scheduled Task definition mismatch|Unregister-ScheduledTask/)
    assert.match(script, /\$task\.TaskPath/)
  }
  const install = calls[0] ?? ''
  assert.ok(install.indexOf('Scheduled Task ownership mismatch') < install.indexOf('Register-ScheduledTask'))
  assert.doesNotMatch(install, /Register-ScheduledTask[^\n]*-Force/)
})

test('repair cannot create an absent task and preserves explicit stopped state', async () => {
  const plan = createLifecyclePlan({ root: 'C:\\Baton', userId: 'alice', taskName: 'test' })
  const calls: string[] = []
  const run = async (script: string) => { calls.push(script); return '{"exists":true,"enabled":false,"ownershipMatches":true,"definitionMatches":true}' }
  const result = await repairScheduledTask(plan, run)
  assert.equal(result.definitionMatches, true)
  assert.equal(calls.length, 1)
  assert.match(calls[0] ?? '', /if \(\$null -eq \$task\).*Autostart is not registered/)
  assert.match(calls[0] ?? '', /\$wasDisabled/)
  assert.ok((calls[0] ?? '').lastIndexOf('Scheduled Task ownership changed during repair') < (calls[0] ?? '').indexOf('Unregister-ScheduledTask'))
  assert.doesNotMatch(calls[0] ?? '', /Register-ScheduledTask[^\n]*-Force/)
})

test('explicit stop disables before stopping; restart enables only afterwards', async () => {
  const plan = createLifecyclePlan({ root: 'C:\\Baton', userId: 'alice', taskName: 'test' })
  const calls: string[] = []
  const run = async (script: string) => { calls.push(script); return '' }
  await stopWorker(plan, run)
  const stop = calls[0] ?? ''
  assert.ok(stop.indexOf('Disable-ScheduledTask') < stop.indexOf('Stop-ScheduledTask'))
  calls.length = 0
  await restartWorker(plan, run)
  assert.equal(calls.length, 1)
  const mutations = calls[0] ?? ''
  assert.ok(mutations.indexOf('Disable-ScheduledTask') < mutations.indexOf('Stop-ScheduledTask'))
  assert.ok(mutations.indexOf('Stop-ScheduledTask') < mutations.indexOf('Enable-ScheduledTask'))
  assert.ok(mutations.indexOf('Enable-ScheduledTask') < mutations.indexOf('Start-ScheduledTask'))
})

test('start validates a running task and classifies the port owner before any no-op or launch', async () => {
  const plan = createLifecyclePlan({ root: 'C:\\Baton', userId: 'alice', taskName: 'test' })
  const calls: string[] = []
  const run = async (script: string) => { calls.push(script); return '' }
  const { startWorker } = await import('./windows-lifecycle.ts')
  await startWorker(plan, run)
  assert.equal(calls.length, 1)
  const script = calls[0] ?? ''
  assert.ok(script.indexOf('Scheduled Task definition mismatch') < script.indexOf("$task.State -eq 'Running'"))
  assert.ok(script.indexOf('Get-NetTCPConnection') < script.indexOf("$task.State -eq 'Running'"))
  assert.match(script, /ExecutablePath/)
  assert.match(script, /CommandLine/)
  assert.match(script, /expected-baton-worker/)
  assert.doesNotMatch(script, /Stop-Process|taskkill/)
})

test('uninstall is idempotent and never changes integration files or kills a port owner', async () => {
  const plan = createLifecyclePlan({ root: 'C:\\Baton', userId: 'alice', taskName: 'test' })
  const calls: string[] = []
  await uninstallScheduledTask(plan, async (script) => { calls.push(script); return '' })
  assert.equal(calls.length, 1)
  assert.ok((calls[0] ?? '').indexOf('Scheduled Task definition mismatch') < (calls[0] ?? '').indexOf('Unregister-ScheduledTask'))
  assert.doesNotMatch(calls.join('\n'), /Stop-Process|taskkill|client-integration|\.codex|\.claude/)
})

test('port conflict is diagnostic only and never terminates its owner', async () => {
  const plan = createLifecyclePlan({ root: 'C:\\Baton', userId: 'alice', taskName: 'test' })
  const calls: string[] = []
  const result = await lifecycleStatus(plan, async (script) => {
    calls.push(script)
    if (script.includes('Get-NetTCPConnection')) return '{"occupied":true,"pid":123,"processName":"other.exe"}'
    return '{"exists":true,"enabled":true,"ownershipMatches":true}'
  })
  assert.deepEqual(result.port4400, { occupied: true, pid: 123, processName: 'other.exe' })
  assert.doesNotMatch(calls.join('\n'), /Stop-Process|taskkill|TerminateProcess/)
})

test('lifecycle status fails soft when Task Scheduler diagnostics are unavailable', async () => {
  const plan = createLifecyclePlan({ root: 'C:\\Baton', userId: 'alice', taskName: 'test' })
  const result = await lifecycleStatus(plan, async () => { throw new Error('scheduler unavailable token=SECRET') })
  assert.equal(result.task.unavailable, true)
  assert.match(result.task.error ?? '', /scheduler unavailable/)
  assert.doesNotMatch(JSON.stringify(result), /SECRET/)
})

test('CLI doctor preserves P0 output when lifecycle tooling is unavailable', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-doctor-soft-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const result = await spawnResult(process.execPath, ['scripts/baton-cli.mjs', 'doctor', '--json'], {
    ...process.env,
    BATON_LIFECYCLE_POWERSHELL: path.join(directory, 'missing-powershell.exe'),
    BATON_RECOVERY_ROOT: path.join(directory, 'state'),
    BATON_OFFLINE_HOME: path.join(directory, 'home'),
    BATON_OFFLINE_LOCAL_APP_DATA: path.join(directory, 'local'),
  })
  const value = JSON.parse(result.stdout)
  assert.equal(value.ok, true)
  assert.equal(value.statuses.length, 3)
  assert.equal(value.lifecycle.task.unavailable, true)
  assert.equal(result.code, 1)
})

test('autostart status prints unavailable lifecycle state and exits nonzero', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-autostart-unavailable-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const result = await spawnResult(process.execPath, ['scripts/baton-cli.mjs', 'autostart', 'status', '--json'], {
    ...process.env,
    BATON_LIFECYCLE_POWERSHELL: path.join(directory, 'missing-powershell.exe'),
    BATON_RECOVERY_ROOT: directory,
  })
  const value = JSON.parse(result.stdout)
  assert.equal(value.task.unavailable, true)
  assert.equal(result.code, 1)
})

test('CLI status reports lifecycle state but exits nonzero when runtime is unavailable', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-status-offline-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const result = await spawnResult(process.execPath, ['scripts/baton-cli.mjs', 'status', '--json'], {
    ...process.env,
    BATON_URL: 'http://127.0.0.1:1',
    BATON_RECOVERY_ROOT: directory,
    BATON_TASK_NAME: `Baton-P1-Isolated-${Date.now()}`,
  })
  const value = JSON.parse(result.stdout)
  assert.equal(value.runtime, null)
  assert.ok(value.lifecycle)
  assert.equal(result.code, 1)
})

test('runner startup failure records bounded exhaustion diagnostics without environment secrets', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-runner-failure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ['scripts/baton-worker-runner.mjs', '--root', path.join(directory, 'missing-root')], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'test', BATON_RECOVERY_ROOT: directory, BATON_TEST_TOKEN: 'MUST_NOT_LEAK', BATON_WORKER_RESTART_COUNT: '0' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('close', (code) => resolve({ code, stderr }))
  })
  assert.equal(result.code, 0)
  const events = await readFile(path.join(directory, 'lifecycle', 'events.jsonl'), 'utf8')
  assert.match(events, /worker-(started|exited|start-failed)/)
  assert.match(events, /worker-restart-exhausted/)
  assert.doesNotMatch(events + result.stderr, /MUST_NOT_LEAK/)
})

test('runner preserves bounded redacted worker output and propagates the worker exit code', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-runner-output-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const fixture = path.join(directory, 'fixture.mjs')
  const secrets = {
    json: 'PrefixlessJsonSecret987',
    refresh: 'PrefixlessRefreshSecret987',
    keyValue: 'PrefixlessKeyValueSecret987',
    query: 'PrefixlessQuerySecret987',
    chunked: 'PrefixlessChunkSecret987',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJiYXRvbiJ9.signature987',
    quotedDouble: 'PrefixlessDoubleQuoted987',
    quotedSingle: 'PrefixlessSingleQuoted987',
    quotedColon: 'PrefixlessColonQuoted987',
  }
  await writeFile(fixture, [
    `process.stdout.write(${JSON.stringify(`{"ToKeN":"${secrets.json}","access_token":"${secrets.json}","REFRESH_TOKEN":"${secrets.refresh}","api_key":"${secrets.json}","authorization":"Bearer ${secrets.json}"}\n`)})`,
    `process.stderr.write(${JSON.stringify(`TOKEN=${secrets.keyValue} Access_Token=${secrets.keyValue}\nhttps://example.invalid/?ReFrEsH_ToKeN=${secrets.query}&ok=1\n${secrets.jwt}\nFINAL_STDERR\n`)})`,
    `process.stderr.write(${JSON.stringify(`token="${secrets.quotedDouble}" access_token='${secrets.quotedSingle}' ReFrEsH_ToKeN: '${secrets.quotedColon}' API_KEY="${secrets.quotedDouble}" authorization='${secrets.quotedSingle}'\n`)})`,
    `process.stdout.write('Authorization: Bear')`,
    `setTimeout(() => { process.stdout.write(${JSON.stringify(`er ${secrets.chunked}\nFINAL_STDOUT\n`)} + ('x'.repeat(1000) + '\\n').repeat(70)); process.exit(0) }, 10)`,
  ].join(';'))
  const result = await spawnResult(process.execPath, ['scripts/baton-worker-runner.mjs', '--root', directory], {
    ...process.env,
    NODE_ENV: 'test',
    BATON_RECOVERY_ROOT: directory,
    BATON_WORKER_EXECUTABLE: process.execPath,
    BATON_WORKER_ARGS_JSON: JSON.stringify([fixture]),
    BATON_WORKER_LOG_MAX_BYTES: String(64 * 1024),
  })
  assert.equal(result.code, 0, result.stderr)
  const log = await readFile(path.join(directory, 'lifecycle', 'worker.log'), 'utf8')
  const rotated = await readFile(path.join(directory, 'lifecycle', 'worker.log.1'), 'utf8')
  for (const secret of Object.values(secrets)) assert.doesNotMatch(log + rotated, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(log + rotated, /\[REDACTED\]/)
  assert.match(log + rotated, /FINAL_STDOUT/)
  assert.match(log + rotated, /FINAL_STDERR/)
  assert.ok((await stat(path.join(directory, 'lifecycle', 'worker.log'))).size <= 64 * 1024)
  assert.ok((await stat(path.join(directory, 'lifecycle', 'worker.log.1'))).size <= 64 * 1024)

  const cli = await spawnResult(process.execPath, ['scripts/baton-cli.mjs', 'logs', '--json'], {
    ...process.env,
    BATON_RECOVERY_ROOT: directory,
  })
  assert.equal(cli.code, 0, cli.stderr)
  const cliLogs = JSON.parse(cli.stdout)
  assert.ok(Array.isArray(cliLogs.events))
  assert.equal(typeof cliLogs.worker, 'string')
  assert.ok(Buffer.byteLength(cliLogs.worker) <= 64 * 1024)
  for (const secret of Object.values(secrets)) assert.doesNotMatch(cli.stdout + cli.stderr, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('runner kills and settles its owned child tree when lifecycle logging fails', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-runner-log-fail-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pidFile = path.join(directory, 'worker.pid')
  const fixture = path.join(directory, 'fixture.mjs')
  await writeFile(fixture, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); console.log('trigger log write'); setInterval(() => {}, 1000)\n`)
  const result = await spawnResult(process.execPath, ['scripts/baton-worker-runner.mjs', '--root', directory], {
    ...process.env,
    NODE_ENV: 'test',
    BATON_RECOVERY_ROOT: directory,
    BATON_WORKER_EXECUTABLE: process.execPath,
    BATON_WORKER_ARGS_JSON: JSON.stringify([fixture]),
    BATON_TEST_FORCE_LOG_FAILURE_AFTER_WRITES: '1',
  })
  assert.equal(result.code, 1)
  const pid = Number(await readFile(pidFile, 'utf8'))
  assert.equal(isProcessAlive(pid), false)
})

test('runner performs exactly three bounded retries then records exhaustion and exits successfully', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-runner-retry-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const fixture = path.join(directory, 'fixture.mjs')
  await writeFile(fixture, `process.exit(23)\n`)
  const result = await spawnResult(process.execPath, ['scripts/baton-worker-runner.mjs', '--root', directory], {
    ...process.env,
    NODE_ENV: 'test',
    BATON_RECOVERY_ROOT: directory,
    BATON_WORKER_EXECUTABLE: process.execPath,
    BATON_WORKER_ARGS_JSON: JSON.stringify([fixture]),
    BATON_WORKER_RESTART_COUNT: '3',
    BATON_WORKER_RESTART_INTERVAL_MS: '10',
  })
  assert.equal(result.code, 0, result.stderr)
  const events = await readFile(path.join(directory, 'lifecycle', 'events.jsonl'), 'utf8')
  assert.equal((events.match(/"event":"worker-started"/g) ?? []).length, 4)
  assert.equal((events.match(/"event":"worker-restart-scheduled"/g) ?? []).length, 3)
  assert.equal((events.match(/"event":"worker-restart-exhausted"/g) ?? []).length, 1)
})

test('runner log size override cannot disable or exceed the 1 MiB safety bound', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-runner-log-bound-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const fixture = path.join(directory, 'fixture.mjs')
  await writeFile(fixture, `for (let i = 0; i < 1400; i += 1) console.log('x'.repeat(1000));\n`)
  for (const value of ['Infinity', 'NaN', '9999999999']) {
    const root = path.join(directory, value)
    const result = await spawnResult(process.execPath, ['scripts/baton-worker-runner.mjs', '--root', directory], {
      ...process.env,
      NODE_ENV: 'test',
      BATON_RECOVERY_ROOT: root,
      BATON_WORKER_EXECUTABLE: process.execPath,
      BATON_WORKER_ARGS_JSON: JSON.stringify([fixture]),
      BATON_WORKER_LOG_MAX_BYTES: value,
    })
    assert.equal(result.code, 0, result.stderr)
    assert.ok((await stat(path.join(root, 'lifecycle', 'worker.log'))).size <= 1024 * 1024)
    assert.ok((await stat(path.join(root, 'lifecycle', 'worker.log.1'))).size <= 1024 * 1024)
  }

  const productionRoot = path.join(directory, 'production-fixed')
  const shortFixture = path.join(directory, 'short-fixture.mjs')
  await writeFile(shortFixture, `for (let i = 0; i < 200; i += 1) console.log('x'.repeat(1000));\n`)
  const production = await spawnResult(process.execPath, ['scripts/baton-worker-runner.mjs', '--root', directory], {
    ...process.env,
    NODE_ENV: 'production',
    BATON_RECOVERY_ROOT: productionRoot,
    BATON_WORKER_EXECUTABLE: process.execPath,
    BATON_WORKER_ARGS_JSON: JSON.stringify([shortFixture]),
    BATON_WORKER_LOG_MAX_BYTES: String(64 * 1024),
  })
  assert.equal(production.code, 0, production.stderr)
  await assert.rejects(() => stat(path.join(productionRoot, 'lifecycle', 'worker.log.1')), { code: 'ENOENT' })
  assert.ok((await stat(path.join(productionRoot, 'lifecycle', 'worker.log'))).size > 64 * 1024)
})

function spawnResult(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
