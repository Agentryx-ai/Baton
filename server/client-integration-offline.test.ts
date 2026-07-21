import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  detectExistingIntegrations,
  isOfflineClientProcess,
  offlineDoctor,
  offlineIntegrationAdopt,
  offlineIntegrationRemove,
  offlineIntegrationStatus,
} from './client-integration-offline.ts'
import { applyRecoveryMutation, type PayloadProtector } from './client-integration-recovery.ts'

class TestProtector implements PayloadProtector {
  async protect(value: Buffer): Promise<string> { return value.toString('base64') }
  async unprotect(value: string): Promise<Buffer> { return Buffer.from(value, 'base64') }
}

test('legacy exact Baton installations require preview and explicit adoption', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-adopt-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const home = path.join(directory, 'home')
  const localAppData = path.join(directory, 'local')
  const root = path.join(directory, 'state')
  const cliPath = path.join(home, '.claude', 'settings.json')
  const desktopDir = path.join(localAppData, 'Claude-3p', 'configLibrary')
  const codexPath = path.join(home, '.codex', 'config.toml')
  await Promise.all([mkdir(path.dirname(cliPath), { recursive: true }), mkdir(desktopDir, { recursive: true }), mkdir(path.dirname(codexPath), { recursive: true })])
  await writeFile(cliPath, JSON.stringify({ env: { KEEP: 'yes', ANTHROPIC_BASE_URL: 'http://127.0.0.1:4400/baton/inference/anthropic' } }))
  await writeFile(path.join(desktopDir, '_meta.json'), JSON.stringify({ appliedId: 'active' }))
  await writeFile(path.join(desktopDir, 'active.json'), JSON.stringify({
    keep: true,
    inferenceProvider: 'gateway',
    inferenceCredentialKind: 'static',
    inferenceGatewayBaseUrl: 'http://127.0.0.1:4400/baton/inference/anthropic',
    inferenceGatewayApiKey: 'must-not-print',
    inferenceModels: [],
  }))
  await writeFile(codexPath, [
    '# preserve root comment',
    'model = "gpt-test"',
    'openai_base_url = "http://127.0.0.1:4400/baton/inference/openai/v1" # owned inline',
    '[model_providers.other]',
    'name = "Other"',
    'base_url = "https://other.invalid"',
    'wire_api = "responses"',
    '[model_providers.baton] # owned table',
    'name = "Baton Native (resume compatibility)"',
    'base_url = "http://127.0.0.1:4400/baton/inference/openai/v1"',
    'wire_api = "responses"',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '# preserve trailing comment',
  ].join('\r\n'))
  const options = { home, localAppData, root, protector: new TestProtector(), skipClientSafetyChecks: true }

  const detected = await detectExistingIntegrations(options)
  assert.deepEqual([...detected.keys()], ['claude-cli', 'claude-desktop', 'codex'])
  const codexBefore = detected.get('codex')?.beforeContent ?? ''
  assert.match(codexBefore, /# preserve root comment/)
  assert.match(codexBefore, /# preserve trailing comment/)
  assert.match(codexBefore, /\[model_providers\.other\]/)
  assert.match(codexBefore, /\r\n/)
  assert.doesNotMatch(codexBefore, /openai_base_url|model_providers\.baton/)
  assert.deepEqual((await offlineIntegrationStatus(options)).map((item) => item.state), [
    'UNTRACKED', 'UNTRACKED', 'UNTRACKED',
  ])
  assert.deepEqual(await offlineIntegrationAdopt(['claude-cli'], false, options), [{
    preview: true,
    target: 'claude-cli',
    filePath: cliPath,
    originalValuesKnown: false,
    ok: true,
  }])
  const running = await offlineIntegrationAdopt(['claude-cli'], true, {
    ...options,
    skipClientSafetyChecks: false,
    processCheck: async () => { throw new Error('running') },
  })
  assert.deepEqual(running.map((item) => ({ target: item.target, ok: item.ok })), [{ target: 'claude-cli', ok: false }])
  assert.equal((await offlineIntegrationRemove(['claude-cli'], options))[0]?.ok, false)
  await offlineIntegrationAdopt(['claude-cli'], true, options)
  await offlineIntegrationRemove(['claude-cli'], options)
  assert.deepEqual(JSON.parse(await readFile(cliPath, 'utf8')), { env: { KEEP: 'yes' } })
})

test('offline CLI doctor performs zero HTTP requests when Baton is unavailable', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-cli-offline-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let requests = 0
  const server = createServer((_request, response) => {
    requests += 1
    response.statusCode = 500
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert(address && typeof address === 'object')
  const result = await spawnResult(process.execPath, ['scripts/baton-cli.mjs', 'doctor', '--json'], {
    ...process.env,
    BATON_URL: `http://127.0.0.1:${address.port}`,
    BATON_RECOVERY_ROOT: path.join(directory, 'state'),
    BATON_OFFLINE_HOME: path.join(directory, 'home'),
    BATON_OFFLINE_LOCAL_APP_DATA: path.join(directory, 'local'),
  })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(requests, 0)
  assert.equal(JSON.parse(result.stdout).ok, true)
})

test('offline CLI reports all three exact untracked targets and doctor fails', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-cli-three-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const home = path.join(directory, 'home')
  const local = path.join(directory, 'local')
  const desktop = path.join(local, 'Claude-3p', 'configLibrary')
  await Promise.all([
    mkdir(path.join(home, '.claude'), { recursive: true }),
    mkdir(path.join(home, '.codex'), { recursive: true }),
    mkdir(desktop, { recursive: true }),
  ])
  const claudeEndpoint = 'http://127.0.0.1:4400/baton/inference/anthropic'
  const codexEndpoint = 'http://127.0.0.1:4400/baton/inference/openai/v1'
  await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: claudeEndpoint } }))
  await writeFile(path.join(desktop, '_meta.json'), JSON.stringify({ appliedId: 'active' }))
  await writeFile(path.join(desktop, 'active.json'), JSON.stringify({
    inferenceProvider: 'gateway', inferenceCredentialKind: 'static', inferenceGatewayBaseUrl: claudeEndpoint,
    inferenceGatewayApiKey: 'SECRET_NOT_IN_OUTPUT', inferenceModels: [],
  }))
  await writeFile(path.join(home, '.codex', 'config.toml'), `openai_base_url = "${codexEndpoint}"\n[model_providers.baton]\nname = "Baton Native (resume compatibility)"\nbase_url = "${codexEndpoint}"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n`)
  const env = {
    ...process.env,
    BATON_RECOVERY_ROOT: path.join(directory, 'state'),
    BATON_OFFLINE_HOME: home,
    BATON_OFFLINE_LOCAL_APP_DATA: local,
  }
  const status = await spawnResult(process.execPath, ['scripts/baton-cli.mjs', 'integration', 'status', '--json'], env)
  assert.equal(status.code, 0, status.stderr)
  assert.deepEqual(JSON.parse(status.stdout).map((item: { state: string }) => item.state), ['UNTRACKED', 'UNTRACKED', 'UNTRACKED'])
  assert.doesNotMatch(status.stdout + status.stderr, /SECRET_NOT_IN_OUTPUT/)
  const doctor = await spawnResult(process.execPath, ['scripts/baton-cli.mjs', 'doctor', '--json'], env)
  assert.equal(doctor.code, 1)
})

test('offline CLI exits nonzero when any requested target fails', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-cli-failure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const result = await spawnResult(process.execPath, [
    'scripts/baton-cli.mjs', 'integration', 'remove', '--target', 'claude-cli', '--json',
  ], {
    ...process.env,
    BATON_RECOVERY_ROOT: path.join(directory, 'state'),
    BATON_OFFLINE_HOME: path.join(directory, 'home'),
    BATON_OFFLINE_LOCAL_APP_DATA: path.join(directory, 'local'),
  })
  assert.equal(result.code, 1)
  assert.equal(JSON.parse(result.stdout)[0].ok, false)
})

test('offline recovery import boundary excludes server, OAuth, model catalog, and HTTP modules', async () => {
  for (const file of ['client-integration-offline.ts', 'client-integration-recovery.ts']) {
    const source = await readFile(path.join(process.cwd(), 'server', file), 'utf8')
    assert.doesNotMatch(source, /from ['"]\.\/(?:index|config|claude-native|codex-native|baton-status)/)
    assert.doesNotMatch(source, /\bfetch\s*\(|node:https?|express/)
  }
})

test('offline Codex process classifier uses CommandLine to exclude only Baton internal app-server', () => {
  assert.equal(isOfflineClientProcess('codex', {
    Name: 'codex.exe',
    ExecutablePath: 'C:\\tools\\codex.exe',
    CommandLine: 'codex.exe exec --model gpt-test',
  }), true)
  assert.equal(isOfflineClientProcess('codex', {
    Name: 'codex.exe',
    ExecutablePath: 'C:\\tools\\baton-model-catalog.json\\codex.exe',
    CommandLine: 'codex.exe exec --model gpt-test',
  }), true)
  assert.equal(isOfflineClientProcess('codex', {
    Name: 'codex.exe',
    ExecutablePath: 'C:\\tools\\codex.exe',
    CommandLine: 'codex.exe --config model_catalog_json="C:\\Temp\\baton-model-catalog.json" app-server --stdio',
  }), false)
  assert.equal(isOfflineClientProcess('codex', {
    Name: 'ChatGPT.exe',
    ExecutablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0\\ChatGPT.exe',
    CommandLine: 'ChatGPT.exe',
  }), true)
})

test('offline status and doctor report one busy target without dropping other targets', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-offline-busy-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'state')
  await mkdir(path.join(root, 'locks', 'claude-cli.lock'), { recursive: true })
  const options = {
    home: path.join(directory, 'home'),
    localAppData: path.join(directory, 'local'),
    root,
    protector: new TestProtector(),
    skipClientSafetyChecks: true,
  }

  const statuses = await offlineIntegrationStatus(options)
  assert.deepEqual(statuses.map((item) => [item.target, item.state]), [
    ['claude-cli', 'BUSY'],
    ['claude-desktop', 'MISSING'],
    ['codex', 'MISSING'],
  ])
  const doctor = await offlineDoctor(options)
  assert.equal(doctor.ok, false)
  assert.equal(doctor.statuses.length, 3)
})

test('offline remove reports partial success and continues to a missing second target', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-offline-partial-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'settings.json')
  const before = '{"keep":true}\n'
  const endpoint = 'http://127.0.0.1:4400/baton/inference/anthropic'
  const applied = `{"keep":true,"env":{"ANTHROPIC_BASE_URL":"${endpoint}"}}\n`
  await writeFile(filePath, before)
  const options = { root: path.join(directory, 'state'), protector: new TestProtector(), skipClientSafetyChecks: true }
  await applyRecoveryMutation({
    target: 'claude-cli', label: 'Claude CLI', filePath, format: 'json',
    ownedFields: [['env', 'ANTHROPIC_BASE_URL'], ['env', 'ANTHROPIC_AUTH_TOKEN']],
    endpoint, beforeExisted: true, beforeContent: before, appliedContent: applied,
  }, options)
  const results = await offlineIntegrationRemove(['claude-cli', 'codex'], options)
  assert.deepEqual(results.map((item) => ({ target: item.target, ok: item.ok })), [
    { target: 'claude-cli', ok: true },
    { target: 'codex', ok: false },
  ])
  assert.equal(await readFile(filePath, 'utf8'), before)
})

test('offline status redacts malformed Claude and Codex source lines', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-offline-redact-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const home = path.join(directory, 'home')
  await Promise.all([
    mkdir(path.join(home, '.claude'), { recursive: true }),
    mkdir(path.join(home, '.codex'), { recursive: true }),
  ])
  await writeFile(path.join(home, '.claude', 'settings.json'), '{"secret":"DO_NOT_ECHO"')
  await writeFile(path.join(home, '.codex', 'config.toml'), 'secret = "DO_NOT_ECHO\n')
  const statuses = await offlineIntegrationStatus({
    home,
    localAppData: path.join(directory, 'local'),
    root: path.join(directory, 'state'),
    protector: new TestProtector(),
    skipClientSafetyChecks: true,
  })
  const serialized = JSON.stringify(statuses)
  assert.doesNotMatch(serialized, /DO_NOT_ECHO/)
  assert.equal(statuses.find((item) => item.target === 'claude-cli')?.state, 'CORRUPT')
  assert.equal(statuses.find((item) => item.target === 'codex')?.state, 'CORRUPT')
})

function spawnResult(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{
  code: number | null
  stdout: string
  stderr: string
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (value: string) => { stdout += value })
    child.stderr.setEncoding('utf8').on('data', (value: string) => { stderr += value })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}
