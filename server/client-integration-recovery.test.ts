import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  applyRecoveryMutation,
  adoptExistingIntegration,
  doctorRecovery,
  getRecoveryStatus,
  removeManagedCodexIntegrationText,
  removeRecoveryIntegration,
  type PayloadProtector,
  type RecoveryMutation,
  WindowsCurrentUserProtector,
} from './client-integration-recovery.ts'

class TestProtector implements PayloadProtector {
  async protect(value: Buffer): Promise<string> {
    return Buffer.from([...value].map((byte) => byte ^ 0xa5)).toString('base64')
  }

  async unprotect(value: string): Promise<Buffer> {
    return Buffer.from([...Buffer.from(value, 'base64')].map((byte) => byte ^ 0xa5))
  }
}

async function fixture(target: RecoveryMutation['target'] = 'claude-cli') {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-recovery-'))
  const root = path.join(directory, 'state')
  const filePath = path.join(directory, target === 'codex' ? 'config.toml' : 'settings.json')
  const beforeContent = target === 'codex'
    ? 'model = "gpt-test"\n'
    : target === 'claude-desktop'
      ? `${JSON.stringify({ keep: true }, null, 2)}\n`
      : `${JSON.stringify({ env: { KEEP: 'yes' }, user: 1 }, null, 2)}\n`
  const endpoint = target === 'codex'
    ? 'http://127.0.0.1:4400/baton/inference/openai/v1'
    : 'http://127.0.0.1:4400/baton/inference/anthropic'
  const appliedContent = target === 'codex'
    ? `model = "gpt-test"\nopenai_base_url = "${endpoint}"\n\n[model_providers.baton]\nname = "Baton Native (resume compatibility)"\nbase_url = "${endpoint}"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n`
    : target === 'claude-desktop'
      ? `${JSON.stringify({
        keep: true,
        inferenceProvider: 'gateway',
        inferenceCredentialKind: 'static',
        inferenceGatewayBaseUrl: endpoint,
        inferenceGatewayApiKey: 'desktop-secret',
        inferenceModels: [],
      }, null, 2)}\n`
      : `${JSON.stringify({ env: { KEEP: 'yes', ANTHROPIC_BASE_URL: endpoint }, user: 1 }, null, 2)}\n`
  await writeFile(filePath, beforeContent)
  const mutation: RecoveryMutation = {
    target,
    label: target,
    filePath,
    format: target === 'codex' ? 'toml' : 'json',
    ownedFields: target === 'codex'
      ? [['openai_base_url'], ['model_providers', 'baton']]
      : target === 'claude-desktop'
        ? [
          ['inferenceProvider'], ['inferenceCredentialKind'], ['inferenceGatewayBaseUrl'],
          ['inferenceGatewayApiKey'], ['inferenceModels'],
        ]
        : [['env', 'ANTHROPIC_BASE_URL'], ['env', 'ANTHROPIC_AUTH_TOKEN']],
    endpoint,
    beforeExisted: true,
    beforeContent,
    appliedContent,
  }
  return {
    directory,
    root,
    filePath,
    mutation,
    options: { root, protector: new TestProtector() },
  }
}

test('offline recovery applies and restores exact original bytes without a server', async (t) => {
  const value = await fixture()
  t.after(() => rm(value.directory, { recursive: true, force: true }))

  await applyRecoveryMutation(value.mutation, value.options)
  assert.equal(await readFile(value.filePath, 'utf8'), value.mutation.appliedContent)
  assert.equal((await getRecoveryStatus('claude-cli', value.options)).state, 'APPLIED')

  await removeRecoveryIntegration('claude-cli', value.options)
  assert.equal(await readFile(value.filePath, 'utf8'), value.mutation.beforeContent)
  assert.equal((await getRecoveryStatus('claude-cli', value.options)).state, 'REMOVED')
})

test('Claude Desktop can be recovered independently while another target remains applied', async (t) => {
  const desktop = await fixture('claude-desktop')
  const codex = await fixture('codex')
  t.after(() => Promise.all([desktop, codex].map((item) => rm(item.directory, { recursive: true, force: true }))))
  await applyRecoveryMutation(desktop.mutation, desktop.options)
  await applyRecoveryMutation(codex.mutation, codex.options)

  await removeRecoveryIntegration('claude-desktop', desktop.options)
  assert.equal(await readFile(desktop.filePath, 'utf8'), desktop.mutation.beforeContent)
  assert.equal((await getRecoveryStatus('codex', codex.options)).state, 'APPLIED')
})

test('offline recovery preserves unrelated edits and rejects Baton-owned edits', async (t) => {
  const unrelated = await fixture()
  const owned = await fixture()
  t.after(() => Promise.all([unrelated, owned].map((item) => rm(item.directory, { recursive: true, force: true }))))

  await applyRecoveryMutation(unrelated.mutation, unrelated.options)
  const withUnrelatedEdit = JSON.parse(unrelated.mutation.appliedContent) as Record<string, unknown>
  withUnrelatedEdit.user = 2
  await writeFile(unrelated.filePath, `${JSON.stringify(withUnrelatedEdit, null, 2)}\n`)
  await removeRecoveryIntegration('claude-cli', unrelated.options)
  assert.deepEqual(JSON.parse(await readFile(unrelated.filePath, 'utf8')), {
    env: { KEEP: 'yes' },
    user: 2,
  })

  await applyRecoveryMutation(owned.mutation, owned.options)
  const withOwnedEdit = JSON.parse(owned.mutation.appliedContent) as { env: Record<string, unknown> }
  withOwnedEdit.env.ANTHROPIC_BASE_URL = 'https://changed.invalid'
  await writeFile(owned.filePath, `${JSON.stringify(withOwnedEdit, null, 2)}\n`)
  await assert.rejects(
    removeRecoveryIntegration('claude-cli', owned.options),
    /Baton 소유 값 .*변경/,
  )
  assert.equal((await getRecoveryStatus('claude-cli', owned.options)).state, 'CONFLICT')
})

test('PREPARED receipts reconcile both crash boundaries without guessing', async (t) => {
  const beforeWrite = await fixture()
  const afterWrite = await fixture()
  t.after(() => Promise.all([beforeWrite, afterWrite].map((item) => rm(item.directory, { recursive: true, force: true }))))

  await assert.rejects(
    applyRecoveryMutation(beforeWrite.mutation, { ...beforeWrite.options, crashAfter: 'PREPARED' }),
    /simulated crash/,
  )
  assert.equal((await getRecoveryStatus('claude-cli', beforeWrite.options)).state, 'REMOVED')
  assert.equal(await readFile(beforeWrite.filePath, 'utf8'), beforeWrite.mutation.beforeContent)

  await assert.rejects(
    applyRecoveryMutation(afterWrite.mutation, { ...afterWrite.options, crashAfter: 'FILE_REPLACED' }),
    /simulated crash/,
  )
  assert.equal((await getRecoveryStatus('claude-cli', afterWrite.options)).state, 'APPLIED')
  await removeRecoveryIntegration('claude-cli', afterWrite.options)
  assert.equal(await readFile(afterWrite.filePath, 'utf8'), afterWrite.mutation.beforeContent)
})

test('removal receipt reconciles crashes before and after the config replacement', async (t) => {
  const beforeWrite = await fixture()
  const afterWrite = await fixture()
  t.after(() => Promise.all([beforeWrite, afterWrite].map((item) => rm(item.directory, { recursive: true, force: true }))))
  await applyRecoveryMutation(beforeWrite.mutation, beforeWrite.options)
  await applyRecoveryMutation(afterWrite.mutation, afterWrite.options)

  await assert.rejects(
    removeRecoveryIntegration('claude-cli', { ...beforeWrite.options, crashAfter: 'REMOVAL_PREPARED' }),
    /simulated crash/,
  )
  assert.equal((await getRecoveryStatus('claude-cli', beforeWrite.options)).state, 'APPLIED')
  await removeRecoveryIntegration('claude-cli', beforeWrite.options)

  await assert.rejects(
    removeRecoveryIntegration('claude-cli', { ...afterWrite.options, crashAfter: 'REMOVAL_FILE_REPLACED' }),
    /simulated crash/,
  )
  assert.equal((await getRecoveryStatus('claude-cli', afterWrite.options)).state, 'REMOVED')
  assert.equal(await readFile(afterWrite.filePath, 'utf8'), afterWrite.mutation.beforeContent)
})

test('target lock excludes concurrent UI/CLI mutation and is never age-deleted', async (t) => {
  const value = await fixture()
  t.after(() => rm(value.directory, { recursive: true, force: true }))
  await mkdir(path.join(value.root, 'locks', 'claude-cli.lock'), { recursive: true })
  await writeFile(path.join(value.root, 'locks', 'claude-cli.lock', 'old'), 'do not steal')

  await assert.rejects(applyRecoveryMutation(value.mutation, value.options), /다른 프로세스/)
  assert.equal(await readFile(value.filePath, 'utf8'), value.mutation.beforeContent)
})

test('offline removal fails closed while the real target config has an exclusive Windows lock', { skip: process.platform !== 'win32' }, async (t) => {
  const value = await fixture()
  t.after(() => rm(value.directory, { recursive: true, force: true }))
  await applyRecoveryMutation(value.mutation, value.options)
  const holder = await holdExclusiveFile(value.filePath)
  try {
    await assert.rejects(removeRecoveryIntegration('claude-cli', value.options), /잠겨/)
  } finally {
    await stopHolder(holder)
  }
  assert.equal(await readFile(value.filePath, 'utf8'), value.mutation.appliedContent)
})

test('corrupt receipt fails closed and protected receipt does not contain token plaintext', async (t) => {
  const value = await fixture()
  t.after(() => rm(value.directory, { recursive: true, force: true }))
  value.mutation.appliedContent = value.mutation.appliedContent.replace(
    'ANTHROPIC_BASE_URL": "',
    'ANTHROPIC_AUTH_TOKEN": "secret-token",\n    "ANTHROPIC_BASE_URL": "',
  )
  await applyRecoveryMutation(value.mutation, value.options)
  const receiptPath = path.join(value.root, 'receipts', 'claude-cli.json')
  const receipt = await readFile(receiptPath, 'utf8')
  assert.doesNotMatch(receipt, /secret-token/)
  const tampered = JSON.parse(receipt) as Record<string, unknown>
  tampered.filePath = path.join(value.directory, 'attacker-selected.json')
  await writeFile(receiptPath, JSON.stringify(tampered))
  assert.equal((await getRecoveryStatus('claude-cli', value.options)).state, 'CORRUPT')
  await writeFile(receiptPath, '{broken')
  assert.equal((await getRecoveryStatus('claude-cli', value.options)).state, 'CORRUPT')
  await assert.rejects(removeRecoveryIntegration('claude-cli', value.options), /receipt/)
})

test('receipt state tampering fails closed because decision metadata is sealed', async (t) => {
  const value = await fixture()
  t.after(() => rm(value.directory, { recursive: true, force: true }))
  await applyRecoveryMutation(value.mutation, value.options)
  const receiptPath = path.join(value.root, 'receipts', 'claude-cli.json')
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>
  receipt.state = 'REMOVED'
  await writeFile(receiptPath, JSON.stringify(receipt))
  assert.equal((await getRecoveryStatus('claude-cli', value.options)).state, 'CORRUPT')
})

test('tampered REMOVED receipt blocks apply and adopt without rewriting receipt bytes', async (t) => {
  const applyValue = await fixture()
  const adoptValue = await fixture('codex')
  t.after(() => Promise.all([applyValue, adoptValue].map((item) => rm(item.directory, { recursive: true, force: true }))))

  for (const [value, operation] of [
    [applyValue, () => applyRecoveryMutation(applyValue.mutation, applyValue.options)],
    [adoptValue, () => adoptExistingIntegration(adoptValue.mutation, true, adoptValue.options)],
  ] as const) {
    await applyRecoveryMutation(value.mutation, value.options)
    const receiptPath = path.join(value.root, 'receipts', `${value.mutation.target}.json`)
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>
    receipt.state = 'REMOVED'
    const tamperedBytes = JSON.stringify(receipt)
    await writeFile(receiptPath, tamperedBytes)

    await assert.rejects(operation(), /receipt payload/)
    assert.equal(await readFile(receiptPath, 'utf8'), tamperedBytes)
  }
})

test('status and doctor isolate a busy target and continue inspecting the others', async (t) => {
  const value = await fixture()
  t.after(() => rm(value.directory, { recursive: true, force: true }))
  await mkdir(path.join(value.root, 'locks', 'claude-cli.lock'), { recursive: true })

  const result = await doctorRecovery(value.options)
  assert.equal(result.ok, false)
  assert.deepEqual(result.statuses.map((item) => [item.target, item.state]), [
    ['claude-cli', 'BUSY'],
    ['claude-desktop', 'MISSING'],
    ['codex', 'MISSING'],
  ])
})

test('a crash after plaintext temp creation is deterministically scrubbed on reconciliation', async (t) => {
  const value = await fixture('claude-desktop')
  t.after(() => rm(value.directory, { recursive: true, force: true }))
  await assert.rejects(
    applyRecoveryMutation(value.mutation, { ...value.options, crashAfter: 'TEMP_WRITTEN' }),
    /plaintext temp/,
  )
  const receipt = JSON.parse(await readFile(path.join(value.root, 'receipts', 'claude-desktop.json'), 'utf8')) as { tempPath: string }
  assert.match(await readFile(receipt.tempPath, 'utf8'), /desktop-secret/)
  assert.equal((await getRecoveryStatus('claude-desktop', value.options)).state, 'REMOVED')
  await assert.rejects(readFile(receipt.tempPath, 'utf8'), /ENOENT/)
})

test('CAS and parser failures leave externally changed settings untouched', async (t) => {
  const beforeApply = await fixture()
  const malformed = await fixture()
  t.after(() => Promise.all([beforeApply, malformed].map((item) => rm(item.directory, { recursive: true, force: true }))))

  await writeFile(beforeApply.filePath, '{"external":true}\n')
  await assert.rejects(applyRecoveryMutation(beforeApply.mutation, beforeApply.options), /변경/)
  assert.equal(await readFile(beforeApply.filePath, 'utf8'), '{"external":true}\n')

  await applyRecoveryMutation(malformed.mutation, malformed.options)
  await writeFile(malformed.filePath, '{malformed')
  await assert.rejects(removeRecoveryIntegration('claude-cli', malformed.options), /문법/)
  assert.equal(await readFile(malformed.filePath, 'utf8'), '{malformed')
})

test('Codex unrelated TOML values survive owned-field recovery', async (t) => {
  const value = await fixture('codex')
  t.after(() => rm(value.directory, { recursive: true, force: true }))
  await applyRecoveryMutation(value.mutation, value.options)
  await writeFile(value.filePath, `${value.mutation.appliedContent}\n# keep this new comment\n[features]\nnew_flag = true\n`)
  await removeRecoveryIntegration('codex', value.options)
  const restored = await readFile(value.filePath, 'utf8')
  assert.match(restored, /model = "gpt-test"/)
  assert.match(restored, /new_flag = true/)
  assert.match(restored, /# keep this new comment/)
  assert.doesNotMatch(restored, /openai_base_url|model_providers\.baton/)
})

test('Codex text remover rejects unknown or nested managed-provider shapes without echoing secrets', () => {
  const endpoint = 'http://127.0.0.1:4400/baton/inference/openai/v1'
  const unknown = `openai_base_url = "${endpoint}"\n[model_providers.baton]\nname = "Baton Native (resume compatibility)"\nbase_url = "${endpoint}"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\nsecret_extra = "DO_NOT_ECHO"\n`
  assert.throws(
    () => removeManagedCodexIntegrationText(unknown, endpoint),
    (error: unknown) => error instanceof Error && /exact managed/.test(error.message) && !error.message.includes('DO_NOT_ECHO'),
  )
  const nested = `${unknown.replace('secret_extra = "DO_NOT_ECHO"\n', '')}[model_providers.baton.extra]\nvalue = true\n`
  assert.throws(() => removeManagedCodexIntegrationText(nested, endpoint), /exact managed|중첩/)
})

test('Windows CurrentUser DPAPI round-trips recovery payload', { skip: process.platform !== 'win32' }, async () => {
  const protector = new WindowsCurrentUserProtector()
  const plaintext = Buffer.from('secret payload')
  const ciphertext = await protector.protect(plaintext)
  assert.notEqual(ciphertext, plaintext.toString('base64'))
  assert.deepEqual(await protector.unprotect(ciphertext), plaintext)
})

function holdExclusiveFile(file: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const script = Buffer.from(String.raw`$path = [Console]::In.ReadLine()
$stream = [System.IO.File]::Open($path, 'Open', 'ReadWrite', 'None')
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
[Console]::In.ReadToEnd() | Out-Null
$stream.Dispose()`, 'utf16le').toString('base64')
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.setEncoding('utf8').on('data', (value: string) => {
      stdout += value
      if (stdout.includes('READY')) resolve(child)
    })
    child.once('error', reject)
    child.stdin.write(`${file}\n`)
  })
}

async function stopHolder(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill()
  await new Promise<void>((resolve) => child.once('close', () => resolve()))
}
