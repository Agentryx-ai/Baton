#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const fixture = path.join(tmpdir(), `Baton P2 verify ${randomUUID()}`)
const localAppData = path.join(fixture, 'Local App Data')
const home = path.join(fixture, 'User Profile')
const bootstrapRoot = path.join(localAppData, 'Baton', 'bootstrap')
const recoveryRoot = path.join(localAppData, 'Baton', 'integration-recovery')
const tsx = path.join('node_modules', 'tsx', 'dist', 'cli.mjs')
const taskName = `Baton-P2-Isolated-${randomUUID()}`
const baseEnv = {
  ...process.env,
  LOCALAPPDATA: localAppData,
  USERPROFILE: home,
  HOME: home,
  BATON_OFFLINE_HOME: home,
  BATON_OFFLINE_LOCAL_APP_DATA: localAppData,
  BATON_RECOVERY_ROOT: recoveryRoot,
  BATON_BOOTSTRAP_ROOT: bootstrapRoot,
  BATON_TASK_NAME: taskName,
}
let taskInstalled = false
let taskExecutable = null
let holdingStable = null

try {
  await mkdir(fixture, { recursive: true })
  await run(process.execPath, ['scripts/build-baton-bootstrap.mjs', '--install', '--allow-unsigned-development'], baseEnv, root)
  let manifest = JSON.parse(await readFile(path.join(bootstrapRoot, 'active.json'), 'utf8'))
  const stable = path.join(bootstrapRoot, 'baton-bootstrap.exe')
  taskExecutable = stable
  await run(process.execPath, [tsx, 'scripts/prepare-bootstrap-fixture.ts'], baseEnv, root)

  // Unsigned local builds never silently satisfy the production apply gate.
  const rejectedUnsigned = await captureFailureAllowed(process.execPath, [tsx, '-e',
    "import { assertBootstrapReady } from './server/bootstrap-contract.ts'; assertBootstrapReady().catch(() => process.exit(7))"], baseEnv, root)
  assert.equal(rejectedUnsigned.code, 7)
  await run(process.execPath, [tsx, '-e',
    "import { assertBootstrapReady } from './server/bootstrap-contract.ts'; assertBootstrapReady({allowUnsignedDevelopment:true}).catch((e) => { console.error(e); process.exit(1) })"], baseEnv, root)

  // Repair a UUID-isolated, never-started Task. Its action must be the fixed
  // stable entry so content-addressed A can be pruned after B→C activation.
  await run(process.execPath, [tsx, 'scripts/bootstrap-task-fixture.ts', 'install'], {
    ...baseEnv, BATON_RELEASE_ROOT: root,
  }, root)
  taskInstalled = true
  const repaired = JSON.parse((await capture(stable, ['autostart', 'repair', '--json'], baseEnv, fixture)).toString('utf8'))
  assert.equal(repaired.task.definitionMatches, true)
  assert.equal((await realpath(repaired.plan.executable)).toLowerCase(), (await realpath(stable)).toLowerCase())
  taskExecutable = repaired.plan.executable

  const originalDigest = manifest.artifactSha256
  const seaBytes = await readFile(path.join(root, '.tmp', 'bootstrap-build', 'baton-bootstrap.exe'))
  const variantB = path.join(fixture, 'bootstrap-B.exe')
  const variantC = path.join(fixture, 'bootstrap-C.exe')
  await writeFile(variantB, Buffer.concat([seaBytes, Buffer.from('BATON-P2-B')]))
  await writeFile(variantC, Buffer.concat([seaBytes, Buffer.from('BATON-P2-C')]))
  const installVariant = (candidate) => run(process.execPath, [
    tsx, 'scripts/install-baton-bootstrap.ts', '--artifact', candidate, '--allow-unsigned-development',
  ], baseEnv, root)
  await installVariant(variantB)
  const manifestB = JSON.parse(await readFile(path.join(bootstrapRoot, 'active.json'), 'utf8'))
  await installVariant(variantC)
  manifest = JSON.parse(await readFile(path.join(bootstrapRoot, 'active.json'), 'utf8'))
  assert.notEqual(manifestB.artifactSha256, originalDigest)
  assert.notEqual(manifest.artifactSha256, manifestB.artifactSha256)
  assert.equal(JSON.parse(await readFile(path.join(bootstrapRoot, 'last-known-good.json'), 'utf8')).artifactSha256, manifestB.artifactSha256)
  assert.deepEqual((await readdir(path.join(bootstrapRoot, 'versions'))).sort(), [manifest.artifactSha256, manifestB.artifactSha256].sort())
  const afterPrune = JSON.parse((await capture(stable, ['autostart', 'status', '--json'], baseEnv, fixture)).toString('utf8'))
  assert.equal(afterPrune.task.definitionMatches, true)
  assert.equal((await realpath(afterPrune.plan.executable)).toLowerCase(), (await realpath(stable)).toLowerCase())

  await run(process.execPath, [tsx, 'scripts/bootstrap-task-fixture.ts', 'uninstall'], {
    ...baseEnv, BATON_RELEASE_ROOT: root, BATON_BOOTSTRAP_EXECUTABLE: taskExecutable,
  }, root)
  taskInstalled = false

  const isolatedEnv = {
    ...baseEnv,
    PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0`,
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1',
    BATON_URL: 'http://127.0.0.1:1',
  }
  const status = JSON.parse((await capture(stable, ['integration', 'status', '--json'], isolatedEnv, fixture)).toString('utf8'))
  assert.deepEqual(status.map((item) => item.state), ['APPLIED', 'APPLIED', 'APPLIED'])

  // Unknown receipt schemas fail closed before any client bytes change.
  const receiptPath = path.join(recoveryRoot, 'receipts', 'codex.json')
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  receipt.schemaVersion = 999
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  const codexPath = path.join(home, '.codex', 'config.toml')
  const beforeUnknown = await readFile(codexPath)
  const unknown = await captureFailureAllowed(stable, ['integration', 'remove', '--target', 'codex', '--json'], isolatedEnv, fixture)
  assert.notEqual(unknown.code, 0)
  assert.deepEqual(await readFile(codexPath), beforeUnknown)

  const remove = await captureFailureAllowed(stable, [
    'integration', 'remove', '--target', 'claude-cli', '--target', 'claude-desktop', '--json',
  ], isolatedEnv, fixture)
  const removal = JSON.parse(remove.stdout.toString('utf8'))
  assert.ok(removal.every((item) => item.ok === true || item.error), 'each target must remove or fail closed')
  assert.ok(!`${remove.stdout}\n${remove.stderr}`.includes('fixture-secret'), 'secret leaked from standalone output')

  // B is the directly executable LKG after A→B→C pruning.
  const lkg = path.join(bootstrapRoot, 'baton-bootstrap-lkg.exe')

  // Missing/corrupt active metadata cannot disable either fixed P0 entry.
  await writeFile(path.join(bootstrapRoot, 'active.json'), '{"schemaVersion":999}\n')
  const stableWithoutManifest = JSON.parse((await capture(stable, ['integration', 'status', '--json'], isolatedEnv, fixture)).toString('utf8'))
  const lkgWithoutManifest = JSON.parse((await capture(lkg, ['integration', 'status', '--json'], isolatedEnv, fixture)).toString('utf8'))
  assert.equal(stableWithoutManifest.length, 3)
  assert.equal(lkgWithoutManifest.length, 3)
  const doctor = await captureFailureAllowed(stable, ['doctor', '--json'], isolatedEnv, fixture)
  assert.notEqual(doctor.code, 0)
  assert.equal(JSON.parse(doctor.stdout.toString('utf8')).statuses.length, 3)
  await run(lkg, ['recover-active', '--from-lkg', '--json'], isolatedEnv, fixture)
  assert.equal(JSON.parse(await readFile(path.join(bootstrapRoot, 'active.json'), 'utf8')).schemaVersion, 1)

  const switchedFiles = ['active.json', 'last-known-good.json', 'baton-bootstrap.exe', 'baton-bootstrap-lkg.exe']
  const beforeSwitchFailure = new Map(await Promise.all(switchedFiles.map(async (name) => [name, await readFile(path.join(bootstrapRoot, name))])))
  const installerArgs = [tsx, 'scripts/install-baton-bootstrap.ts', '--artifact', path.join(root, '.tmp', 'bootstrap-build', 'baton-bootstrap.exe'), '--allow-unsigned-development']
  for (let step = 1; step <= switchedFiles.length; step += 1) {
    const failedSwitch = await captureFailureAllowed(process.execPath, installerArgs, {
      ...baseEnv, NODE_ENV: 'test', BATON_TEST_FAIL_AFTER_SWITCH_STEP: String(step),
    }, root)
    assert.notEqual(failedSwitch.code, 0, `switch boundary ${step} unexpectedly succeeded`)
    for (const name of switchedFiles) {
      assert.deepEqual(await readFile(path.join(bootstrapRoot, name)), beforeSwitchFailure.get(name), `${name} changed after switch boundary ${step}`)
    }
  }

  // A running Windows image locks the stable executable. The active stable
  // replacement is deliberately the first switch mutation, so this failure
  // must leave both manifests and both fixed entries byte-for-byte unchanged.
  holdingStable = await spawnUntilLine(stable, ['test-hold'], {
    ...baseEnv, NODE_ENV: 'test', BATON_TEST_HOLD_BOOTSTRAP_MS: '30000',
  }, fixture, 'BATON_TEST_HOLD_READY')
  const lockedStableInstall = await captureFailureAllowed(process.execPath, installerArgs, {
    ...baseEnv, NODE_ENV: 'test',
  }, root)
  assert.notEqual(lockedStableInstall.code, 0, 'installer replaced a running stable executable')
  for (const name of switchedFiles) {
    assert.deepEqual(await readFile(path.join(bootstrapRoot, name)), beforeSwitchFailure.get(name), `${name} changed while stable executable was running`)
  }
  holdingStable.kill()
  await onceClosed(holdingStable)
  holdingStable = null

  const failedStaging = await captureFailureAllowed(process.execPath, installerArgs, {
    ...baseEnv, NODE_ENV: 'test', BATON_TEST_CORRUPT_STAGED: '1',
  }, root)
  assert.notEqual(failedStaging.code, 0)
  for (const name of switchedFiles) assert.deepEqual(await readFile(path.join(bootstrapRoot, name)), beforeSwitchFailure.get(name))

  // Two installers cannot switch metadata concurrently.
  const holder = captureFailureAllowed(process.execPath, installerArgs, {
    ...baseEnv, NODE_ENV: 'test', BATON_TEST_HOLD_INSTALL_LOCK_MS: '1500',
  }, root)
  await new Promise((resolve) => setTimeout(resolve, 250))
  const contender = await captureFailureAllowed(process.execPath, installerArgs, { ...baseEnv, NODE_ENV: 'test' }, root)
  const holderResult = await holder
  assert.equal(holderResult.code, 0)
  assert.notEqual(contender.code, 0)
  assert.match(contender.stderr.toString('utf8'), /busy in another process/i)

  console.log('Standalone bootstrap adversarial verification passed.')
} finally {
  if (holdingStable) {
    holdingStable.kill()
    await onceClosed(holdingStable)
  }
  if (taskInstalled && taskExecutable) {
    await captureFailureAllowed(process.execPath, [tsx, 'scripts/bootstrap-task-fixture.ts', 'uninstall'], {
      ...baseEnv, BATON_RELEASE_ROOT: root, BATON_BOOTSTRAP_EXECUTABLE: taskExecutable,
    }, root)
  }
  await rm(fixture, { recursive: true, force: true })
}

function run(file, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(file)} exited ${code}`)))
  })
}

function capture(file, args, env, cwd) {
  return captureFailureAllowed(file, args, env, cwd).then((result) => {
    if (result.code !== 0) throw new Error(`${path.basename(file)} exited ${result.code}: ${result.stderr}`)
    return result.stdout
  })
}

function captureFailureAllowed(file, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }))
  })
}

function spawnUntilLine(file, args, env, cwd, expected) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const fail = (error) => {
      child.kill()
      reject(error)
    }
    child.once('error', fail)
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
      if (stdout.includes(expected)) resolve(child)
    })
    child.once('close', (code) => {
      if (!stdout.includes(expected)) fail(new Error(`${path.basename(file)} exited ${code}: ${stderr}`))
    })
  })
}

function onceClosed(child) {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('close', resolve))
}
