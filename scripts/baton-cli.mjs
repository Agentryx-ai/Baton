#!/usr/bin/env node

const command = process.argv[2] ?? 'help'
const baseUrl = process.env.BATON_URL ?? 'http://127.0.0.1:4400'

if (command === 'help' || command === '--help' || command === '-h') {
  console.log(`Usage:
  baton status [--json]                    Runtime and lifecycle status
  baton integration status [--json]        Offline receipt/config status
  baton integration remove [--target NAME] Offline safe removal
  baton integration adopt-existing [--target NAME] [--confirm]
  baton autostart status [--json]           Scheduled Task status
  baton autostart install --confirm         Opt in to CurrentUser logon start
  baton autostart repair                    Repair an existing registration
  baton autostart uninstall                 Remove the registration
  baton start|stop|restart                   Worker lifecycle (registered task)
  baton logs [--json]                       Last lifecycle event
  baton doctor [--json]                     Offline recovery + lifecycle diagnostics`)
  process.exit(0)
}

if (command === 'integration') {
  try {
    await runOfflineCommand(command)
  } catch (error) {
    console.error(`Offline recovery failed: ${terminalText(error instanceof Error ? error.message : String(error))}`)
    process.exitCode = 1
  }
  process.exit(process.exitCode ?? 0)
}

if (command === 'autostart' || ['start', 'stop', 'restart', 'logs'].includes(command)) {
  try {
    await runLifecycleCommand(command)
  } catch (error) {
    console.error(`Baton lifecycle failed: ${terminalText(error instanceof Error ? error.message : String(error))}`)
    process.exitCode = 1
  }
  process.exit(process.exitCode ?? 0)
}

if (command === 'doctor') {
  try {
    const offline = await loadOffline()
    const lifecycle = await loadLifecycle()
    const recovery = await offline.offlineDoctor()
    const worker = await lifecycle.lifecycleStatus()
    const result = { ...recovery, lifecycle: worker }
    output(result, process.argv.includes('--json'))
    if (!recovery.ok || worker.task?.unavailable) process.exitCode = 1
  } catch (error) {
    console.error(`Offline recovery failed: ${terminalText(error instanceof Error ? error.message : String(error))}`)
    process.exitCode = 1
  }
  process.exit(process.exitCode ?? 0)
}

if (command !== 'status') {
  console.error(`Unknown command: ${command}`)
  process.exit(2)
}

let body = null
try {
  const response = await fetch(`${baseUrl}/baton/status`, { signal: AbortSignal.timeout(2_000) })
  if (response.ok) body = await response.json().catch(() => null)
} catch {
  // Lifecycle status remains useful while the Worker is unavailable.
}

const lifecycle = await loadLifecycle()
const worker = await lifecycle.lifecycleStatus()

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ runtime: body, lifecycle: worker }, null, 2))
  process.exit(body && !worker.task?.unavailable ? 0 : 1)
}

if (!body) {
  console.log('Baton runtime: unavailable')
  printLifecycle(worker)
  process.exit(1)
}
const value = body
console.log('Baton status')
console.log(`  Proxy: ${value.proxy.running === true ? `running :${value.proxy.port ?? '?'} (${value.proxy.version ?? 'unknown'})` : value.proxy.running === false ? 'stopped' : 'unknown'}`)
console.log(`  Routing: ${value.proxy.strategy ?? 'unknown'} · session affinity ${value.proxy.sessionAffinity === true ? 'on' : value.proxy.sessionAffinity === false ? 'off' : 'unknown'}`)
console.log(`  Codex provider: ${value.codex.modelProvider}`)
console.log(`  Provider auth: ${value.codex.providerAuth}`)
console.log(`  OpenAI/ChatGPT login: ${terminalText(value.codex.openAiLogin.label)}`)
console.log(`  Remote plugin catalog: ${value.codex.remotePluginCatalog.state}`)
console.log(`  Codex home: ${terminalText(value.codex.configuredHome)}`)
if (value.inferenceAccount) {
  console.log(`  Last used model account: ${terminalText(value.inferenceAccount.label)} (${terminalText(value.inferenceAccount.observedAt ?? 'time unknown')})`)
}
console.log(`  Note: ${terminalText(value.codex.notice)}`)
for (const warning of value.warnings ?? []) console.log(`  Warning: ${terminalText(warning)}`)
printLifecycle(worker)
if (worker.task?.unavailable) process.exit(1)

async function runOfflineCommand(topLevel) {
  // Intentional dynamic import: runtime status remains lightweight, while all
  // recovery commands use only the pure local-file core (no server/OAuth import).
  const offline = await loadOffline()
  const jsonOutput = process.argv.includes('--json')
  if (topLevel === 'doctor') {
    const result = await offline.offlineDoctor()
    output(result, jsonOutput)
    if (!result.ok) process.exitCode = 1
    return
  }

  const subcommand = process.argv[3] ?? 'status'
  const targets = parseTargets(process.argv)
  if (subcommand === 'status') {
    output(await offline.offlineIntegrationStatus(), jsonOutput)
    return
  }
  if (subcommand === 'remove') {
    const result = await offline.offlineIntegrationRemove(targets)
    output(result, jsonOutput)
    if (result.some((item) => item.ok === false)) process.exitCode = 1
    return
  }
  if (subcommand === 'adopt-existing') {
    const confirmed = process.argv.includes('--confirm')
    const result = await offline.offlineIntegrationAdopt(targets, confirmed)
    output(result, jsonOutput)
    if (result.some((item) => item.ok === false)) process.exitCode = 1
    if (!confirmed) console.log('Preview only. Re-run with --confirm to create receipts.')
    return
  }
  console.error(`Unknown integration command: ${subcommand}`)
  process.exitCode = 2
}

async function loadOffline() {
  const { tsImport } = await import('tsx/esm/api')
  return tsImport('../server/client-integration-offline.ts', import.meta.url)
}

async function loadLifecycle() {
  const { tsImport } = await import('tsx/esm/api')
  return tsImport('../server/windows-lifecycle.ts', import.meta.url)
}

async function runLifecycleCommand(topLevel) {
  const lifecycle = await loadLifecycle()
  const json = process.argv.includes('--json')
  if (topLevel === 'autostart') {
    const subcommand = process.argv[3] ?? 'status'
    if (subcommand === 'status') return outputLifecycle(await lifecycle.lifecycleStatus(), json)
    if (subcommand === 'install') {
      const result = await lifecycle.installScheduledTask(process.argv.includes('--confirm'))
      return outputLifecycle(await lifecycle.lifecycleStatus(), json, result)
    }
    if (subcommand === 'repair') {
      const result = await lifecycle.repairScheduledTask()
      return outputLifecycle(await lifecycle.lifecycleStatus(), json, result)
    }
    if (subcommand === 'uninstall') {
      await lifecycle.uninstallScheduledTask()
      return outputLifecycle(await lifecycle.lifecycleStatus(), json)
    }
    throw new Error(`Unknown autostart command: ${subcommand}`)
  }
  if (topLevel === 'start') await lifecycle.startWorker()
  else if (topLevel === 'stop') await lifecycle.stopWorker()
  else if (topLevel === 'restart') await lifecycle.restartWorker()
  else if (topLevel === 'logs') {
    const logs = await lifecycle.lifecycleLogs()
    if (json) console.log(JSON.stringify(logs, null, 2))
    else {
      if (!logs.events.length && !logs.worker) console.log('No Baton lifecycle logs recorded.')
      for (const event of logs.events) console.log(`${terminalText(event.at ?? 'unknown')} · ${terminalText(event.event ?? 'unknown')} · ${event.code ?? event.reason ?? ''}`)
      if (logs.worker) console.log(`Worker output (bounded tail):\n${terminalText(logs.worker)}`)
    }
    return
  } else throw new Error(`Unknown lifecycle command: ${topLevel}`)
  outputLifecycle(await lifecycle.lifecycleStatus(), json)
}

function outputLifecycle(value, jsonOutput, registration) {
  if (jsonOutput) console.log(JSON.stringify(registration ? { ...value, registration } : value, null, 2))
  else printLifecycle(value)
  if (value.task?.unavailable) process.exitCode = 1
}

function printLifecycle(value) {
  const task = value.task ?? {}
  console.log(`Baton lifecycle: ${task.unavailable ? `unavailable${task.error ? ` (${terminalText(task.error)})` : ''}` : task.exists ? `${task.enabled ? 'enabled' : 'stopped'} (${task.state ?? 'unknown'})` : 'not registered'}`)
  if (task.lastRunTime) console.log(`  Last run: ${terminalText(task.lastRunTime)} · result ${task.lastTaskResult ?? 'unknown'}`)
  if (value.lastWorkerEvent) console.log(`  Last worker event: ${terminalText(value.lastWorkerEvent.event ?? 'unknown')} at ${terminalText(value.lastWorkerEvent.at ?? 'unknown')}`)
  if (value.port4400?.occupied) console.log(`  Port 4400: occupied by PID ${value.port4400.pid ?? '?'} (${terminalText(value.port4400.processName ?? 'unknown')}); no process was stopped`)
  else if (value.port4400) console.log('  Port 4400: available')
}

function parseTargets(argv) {
  const valid = new Set(['claude-cli', 'claude-desktop', 'codex'])
  const values = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--target') continue
    const value = argv[index + 1]
    if (!valid.has(value)) {
      console.error(`Invalid --target: ${value ?? '(missing)'}`)
      process.exit(2)
    }
    values.push(value)
  }
  return values.length ? [...new Set(values)] : [...valid]
}

function output(value, jsonOutput) {
  if (jsonOutput) console.log(JSON.stringify(value, null, 2))
  else if (Array.isArray(value)) {
    for (const item of value) console.log(`${item.target}: ${item.ok === false ? 'failed' : (item.state ?? 'ok')}${item.error ? ` · ${terminalText(item.error)}` : item.detail ? ` · ${terminalText(item.detail)}` : ''}`)
  } else {
    console.log(`Offline recovery: ${value.ok === false ? 'problems found' : 'ok'}`)
    for (const item of value.statuses ?? []) console.log(`  ${item.target}: ${item.state}${item.detail ? ` · ${terminalText(item.detail)}` : ''}`)
    if (value.lifecycle) printLifecycle(value.lifecycle)
  }
}

function terminalText(value) {
  return Array.from(String(value), (character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || (code >= 127 && code <= 159) ? ' ' : character
  }).join('')
}
