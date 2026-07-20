#!/usr/bin/env node

const command = process.argv[2] ?? 'help'
const baseUrl = process.env.BATON_URL ?? 'http://127.0.0.1:4400'

if (command === 'help' || command === '--help' || command === '-h') {
  console.log(`Usage:
  baton status [--json]                    Live Baton runtime status
  baton integration status [--json]        Offline receipt/config status
  baton integration remove [--target NAME] Offline safe removal
  baton integration adopt-existing [--target NAME] [--confirm]
  baton doctor [--json]                     Offline recovery diagnostics`)
  process.exit(0)
}

if (command === 'integration' || command === 'doctor') {
  try {
    await runOfflineCommand(command)
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

let response
try {
  response = await fetch(`${baseUrl}/baton/status`, { signal: AbortSignal.timeout(10_000) })
} catch (error) {
  console.error(`Baton backend is unavailable at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const body = await response.json().catch(() => null)
if (!response.ok || !body) {
  console.error(`Baton status failed with HTTP ${response.status}`)
  process.exit(1)
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(body, null, 2))
  process.exit(0)
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

async function runOfflineCommand(topLevel) {
  // Intentional dynamic import: runtime status remains lightweight, while all
  // recovery commands use only the pure local-file core (no server/OAuth import).
  const { tsImport } = await import('tsx/esm/api')
  const offline = await tsImport('../server/client-integration-offline.ts', import.meta.url)
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
  }
}

function terminalText(value) {
  return Array.from(String(value), (character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || (code >= 127 && code <= 159) ? ' ' : character
  }).join('')
}
