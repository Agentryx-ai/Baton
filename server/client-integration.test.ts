import assert from 'node:assert/strict'
import test from 'node:test'
import { parse as parseToml } from 'smol-toml'

import {
  blockedProcessesForTargets,
  canApplyConfiguration,
  classifyProcessRecords,
  inspectClaudeCliConfig,
  inspectClaudeDesktopConfig,
  inspectCodexNativeConfig,
  patchClaudeCliConfig,
  patchClaudeDesktopConfig,
  patchCodexNativeConfig,
  parseCodexIntegrationMode,
  parseClaudeProxyMode,
  parseIntegrationTargets,
  removeClaudeCliConfig,
  removeClaudeDesktopConfig,
  selectClaudeModels,
  unpatchCodexNativeConfig,
} from './client-integration.ts'

test('configuration conflicts are repairable but applied and unknown states are not', () => {
  assert.equal(canApplyConfiguration('not-applied'), true)
  assert.equal(canApplyConfiguration('conflict'), true)
  assert.equal(canApplyConfiguration('applied'), false)
  assert.equal(canApplyConfiguration('unknown'), false)
})

test('native Codex mode changes only openai_base_url and round-trips bytes safely', () => {
  const original = [
    '# keep provider identity and comments',
    'model_provider = "openai"',
    'model = "gpt-5.6-sol"',
    '',
    '[projects."C:\\\\work"]',
    'trust_level = "trusted"',
    '',
  ].join('\r\n')
  const baseUrl = 'http://127.0.0.1:4400/baton/inference/openai/v1'
  const applied = patchCodexNativeConfig(original, baseUrl)
  const parsed = parseToml(applied) as Record<string, unknown>

  assert.equal(patchCodexNativeConfig(applied, baseUrl), applied)
  assert.equal(parsed.model_provider, 'openai')
  assert.equal(parsed.openai_base_url, baseUrl)
  assert.match(applied, /# keep provider identity and comments/)
  assert.match(applied, /\[projects\."C:\\\\work"\]/)
  assert.equal(unpatchCodexNativeConfig(applied, baseUrl), original)
  assert.equal(inspectCodexNativeConfig(applied, baseUrl).configuration, 'applied')
})

test('native Codex mode refuses to overwrite user transport or another provider', () => {
  const baseUrl = 'http://127.0.0.1:4400/baton/inference/openai/v1'
  assert.throws(
    () => patchCodexNativeConfig('openai_base_url = "https://example.invalid/v1"\n', baseUrl),
    /덮어쓰지 않았습니다/,
  )
  assert.throws(
    () => patchCodexNativeConfig('model_provider = "custom"\n', baseUrl),
    /사용자가 지정한 model_provider/,
  )
})

test('native Codex mode migrates the exact Baton-owned legacy provider without touching user settings', () => {
  const baseUrl = 'http://127.0.0.1:4400/baton/inference/openai/v1'
  const source = [
    '# keep me',
    'model_provider = "baton"',
    'model = "gpt-5.6-sol"',
    '',
    '[features]',
    'example = true',
    '',
    '[model_providers.baton]',
    'name = "Baton Legacy"',
    'base_url = "http://127.0.0.1:8317/v1"',
    'env_key = "BATON_PROXY_TOKEN"',
    'wire_api = "responses"',
    '',
  ].join('\n')
  const migrated = patchCodexNativeConfig(source, baseUrl)
  const parsed = parseToml(migrated) as Record<string, unknown>
  assert.equal(parsed.model_provider, undefined)
  assert.equal(parsed.openai_base_url, baseUrl)
  assert.equal((parsed.model_providers as Record<string, unknown> | undefined)?.baton, undefined)
  assert.equal(parsed.model, 'gpt-5.6-sol')
  assert.match(migrated, /# keep me/)
  assert.match(migrated, /\[features\]/)
})

test('configuration inspection distinguishes applied, absent, and conflicting values', () => {
  const baseUrl = 'http://127.0.0.1:8317'
  const token = 'secret'
  const cli = JSON.stringify({ env: { KEEP: 'yes', ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: token } })
  const desktop = JSON.stringify({
    keep: true,
    inferenceProvider: 'gateway',
    inferenceCredentialKind: 'static',
    inferenceGatewayBaseUrl: baseUrl,
    inferenceGatewayApiKey: token,
    inferenceModels: [],
  })

  assert.equal(inspectClaudeCliConfig(cli, baseUrl, token).configuration, 'applied')
  assert.equal(inspectClaudeCliConfig('{}', baseUrl, token).configuration, 'not-applied')
  assert.equal(inspectClaudeCliConfig(cli, baseUrl, 'other').configuration, 'conflict')
  assert.equal(inspectClaudeDesktopConfig(desktop, baseUrl, token).configuration, 'applied')
  assert.equal(inspectClaudeDesktopConfig(JSON.stringify({
    inferenceProvider: 'firstParty',
    inferenceModels: [],
  }), baseUrl, token).configuration, 'not-applied')
})

test('JSON removers preserve unrelated user settings', () => {
  const baseUrl = 'http://127.0.0.1:8317'
  const token = 'secret'
  const cli = JSON.stringify({ env: { KEEP: 'yes', ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: token }, user: 1 })
  const desktop = JSON.stringify({
    keep: true,
    inferenceProvider: 'gateway',
    inferenceCredentialKind: 'static',
    inferenceGatewayBaseUrl: baseUrl,
    inferenceGatewayApiKey: token,
    inferenceModels: [],
  })

  assert.deepEqual(JSON.parse(removeClaudeCliConfig(cli, baseUrl, token)), {
    env: { KEEP: 'yes' },
    user: 1,
  })
  assert.deepEqual(JSON.parse(removeClaudeDesktopConfig(desktop, baseUrl, token)), { keep: true })
})

test('Claude CLI Native settings apply, inspect, and remove without touching user values', () => {
  const original = JSON.stringify({ env: { KEEP: 'yes', ANTHROPIC_AUTH_TOKEN: 'stale' }, user: 1 })
  const nativeBaseUrl = 'http://127.0.0.1:4400/baton/inference/anthropic'

  const native = patchClaudeCliConfig(original, nativeBaseUrl, null)
  assert.equal(inspectClaudeCliConfig(native, nativeBaseUrl, null).configuration, 'applied')
  assert.deepEqual(JSON.parse(native), {
    env: { KEEP: 'yes', ANTHROPIC_BASE_URL: nativeBaseUrl },
    user: 1,
  })
  assert.deepEqual(JSON.parse(removeClaudeCliConfig(native, nativeBaseUrl, null)), {
    env: { KEEP: 'yes' },
    user: 1,
  })
})

test('Claude Desktop uses the Baton Native static client token and round-trips user values', () => {
  const original = JSON.stringify({ keep: true, inferenceProvider: 'firstParty' })
  const models = [{
    name: 'claude-fable-5',
    anthropicFamilyTier: 'fable',
    labelOverride: 'Fable 5',
    isFamilyDefault: true as const,
  }]
  const baseUrl = 'http://127.0.0.1:4400/baton/inference/anthropic'
  const token = 'native-token'
  const applied = patchClaudeDesktopConfig(original, baseUrl, token, models)
  assert.equal(inspectClaudeDesktopConfig(applied, baseUrl, token).configuration, 'applied')
  assert.deepEqual(JSON.parse(removeClaudeDesktopConfig(applied, baseUrl, token)), { keep: true })
})

test('selectClaudeModels is input-order independent and selects newest families', () => {
  const models = [
    'claude-opus-4-6',
    'claude-haiku-4-5-20251001',
    'gpt-5.6-sol',
    'claude-sonnet-4-6',
    'claude-opus-4-8',
    'claude-fable-5',
    'claude-sonnet-5',
  ]
  const expectedNames = [
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-haiku-4-5-20251001',
    'claude-fable-5',
  ]

  assert.deepEqual(selectClaudeModels(models).map((item) => item.name), expectedNames)
  assert.deepEqual(selectClaudeModels([...models].reverse()).map((item) => item.name), expectedNames)
})

test('classifyProcessRecords distinguishes CLI/Desktop and fails closed when unknown', () => {
  const result = classifyProcessRecords([
    { ProcessId: 10, Name: 'claude.exe', ExecutablePath: 'C:\\Users\\me\\.local\\bin\\claude.exe' },
    { ProcessId: 20, Name: 'codex.exe', ExecutablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_x\\resources\\codex.exe' },
    { ProcessId: 30, Name: 'ChatGPT.exe', ExecutablePath: null, CommandLine: null },
    { ProcessId: 40, Name: 'ChatGPT.exe', ExecutablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT_x\\ChatGPT.exe' },
  ])

  assert.deepEqual(result.map((item) => item.client), [
    'claude-cli',
    'codex-desktop',
    'unknown-codex-desktop',
  ])
})

test('classifyProcessRecords does not guess CLI when executable evidence is unavailable', () => {
  const result = classifyProcessRecords([
    { ProcessId: 31, Name: 'claude.exe' },
    { ProcessId: 32, Name: 'codex.exe' },
  ])

  assert.deepEqual(result.map((item) => item.client), [
    'unknown-claude',
    'unknown-codex-desktop',
  ])
})

test('parseIntegrationTargets validates and canonicalizes partial selections', () => {
  assert.deepEqual(parseIntegrationTargets(['codex', 'claude-cli']), [
    'claude-cli',
    'codex',
  ])
  assert.throws(() => parseIntegrationTargets([]), /하나 이상/)
  assert.throws(() => parseIntegrationTargets(['codex', 'codex']), /중복/)
  assert.throws(() => parseIntegrationTargets(['unknown']), /올바르지/)
})

test('parseCodexIntegrationMode accepts only declared modes', () => {
  assert.equal(parseCodexIntegrationMode(undefined), 'native-openai')
  assert.equal(parseCodexIntegrationMode('native-openai'), 'native-openai')
  assert.throws(() => parseCodexIntegrationMode('custom-provider'), /올바르지 않은/)
  assert.throws(() => parseCodexIntegrationMode('openai'), /올바르지 않은/)
})

test('parseClaudeProxyMode accepts Baton Native only', () => {
  assert.equal(parseClaudeProxyMode(undefined), 'native')
  assert.equal(parseClaudeProxyMode('native'), 'native')
  assert.throws(() => parseClaudeProxyMode('legacy-proxy'), /올바르지 않은/)
  assert.throws(() => parseClaudeProxyMode('gateway'), /올바르지 않은/)
})

test('blockedProcessesForTargets ignores running unselected clients', () => {
  const running = classifyProcessRecords([
    { ProcessId: 10, Name: 'claude.exe', ExecutablePath: 'C:\\Users\\me\\.local\\bin\\claude.exe' },
    { ProcessId: 20, Name: 'Claude.exe', ExecutablePath: 'C:\\Program Files\\WindowsApps\\Claude_x\\Claude.exe' },
    { ProcessId: 30, Name: 'codex.exe', ExecutablePath: 'C:\\Users\\me\\npm\\codex.exe' },
    { ProcessId: 40, Name: 'ChatGPT.exe', ExecutablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_x\\ChatGPT.exe' },
  ])

  assert.deepEqual(
    blockedProcessesForTargets(running, ['claude-cli']).map((item) => item.pid),
    [10],
  )
  assert.deepEqual(
    blockedProcessesForTargets(running, ['claude-desktop']).map((item) => item.pid),
    [20],
  )
  assert.deepEqual(
    blockedProcessesForTargets(running, ['codex']).map((item) => item.pid),
    [30, 40],
  )
})
