import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { applyRecoveryMutation, type RecoveryMutation } from '../server/client-integration-recovery.ts'

const home = path.resolve(required('BATON_OFFLINE_HOME'))
const localAppData = path.resolve(required('BATON_OFFLINE_LOCAL_APP_DATA'))
const recoveryRoot = path.resolve(required('BATON_RECOVERY_ROOT'))

const claudeCli = path.join(home, '.claude', 'settings.json')
const desktopDirectory = path.join(localAppData, 'Claude-3p', 'configLibrary')
const desktop = path.join(desktopDirectory, 'fixture.json')
const codex = path.join(home, '.codex', 'config.toml')
await mkdir(path.dirname(claudeCli), { recursive: true })
await mkdir(desktopDirectory, { recursive: true })
await mkdir(path.dirname(codex), { recursive: true })
await writeFile(path.join(desktopDirectory, '_meta.json'), '{"appliedId":"fixture"}\n')

const mutations: RecoveryMutation[] = [
  {
    target: 'claude-cli', label: 'Claude CLI', filePath: claudeCli, format: 'json',
    ownedFields: [['env', 'ANTHROPIC_BASE_URL'], ['env', 'ANTHROPIC_AUTH_TOKEN']],
    endpoint: 'http://127.0.0.1:4400/baton/inference/anthropic', beforeExisted: false, beforeContent: '',
    appliedContent: '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4400/baton/inference/anthropic"\n  }\n}\n',
  },
  {
    target: 'claude-desktop', label: 'Claude Desktop', filePath: desktop, format: 'json',
    ownedFields: [['inferenceProvider'], ['inferenceCredentialKind'], ['inferenceGatewayBaseUrl'], ['inferenceGatewayApiKey'], ['inferenceModels']],
    endpoint: 'http://127.0.0.1:4400/baton/inference/anthropic', beforeExisted: false, beforeContent: '',
    appliedContent: '{\n  "inferenceProvider": "gateway",\n  "inferenceCredentialKind": "static",\n  "inferenceGatewayBaseUrl": "http://127.0.0.1:4400/baton/inference/anthropic",\n  "inferenceGatewayApiKey": "fixture-secret",\n  "inferenceModels": []\n}\n',
  },
  {
    target: 'codex', label: 'Codex CLI/Desktop', filePath: codex, format: 'toml',
    ownedFields: [['openai_base_url'], ['model_providers', 'baton']],
    endpoint: 'http://127.0.0.1:4400/baton/inference/openai/v1', beforeExisted: false, beforeContent: '',
    appliedContent: 'openai_base_url = "http://127.0.0.1:4400/baton/inference/openai/v1"\n\n[model_providers.baton]\nname = "Baton Native (resume compatibility)"\nbase_url = "http://127.0.0.1:4400/baton/inference/openai/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n',
  },
]

for (const mutation of mutations) await applyRecoveryMutation(mutation, { root: recoveryRoot })

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
