#!/usr/bin/env node

const command = process.argv[2] ?? 'help'
const baseUrl = process.env.BATON_URL ?? 'http://127.0.0.1:4400'

if (command === 'help' || command === '--help' || command === '-h') {
  console.log('Usage: baton status [--json]')
  process.exit(0)
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

function terminalText(value) {
  return Array.from(String(value), (character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || (code >= 127 && code <= 159) ? ' ' : character
  }).join('')
}
