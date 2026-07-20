/**
 * Offline-only integration discovery and recovery commands.
 *
 * This module deliberately imports no server, OAuth, account, model-catalog,
 * or HTTP client module. All operations are local file/receipt operations.
 */
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import { parse as parseToml } from 'smol-toml'

import {
  adoptExistingIntegration,
  doctorRecovery,
  listRecoveryStatuses,
  removeManagedCodexIntegrationText,
  removeRecoveryIntegration,
  RecoveryError,
  type RecoveryMutation,
  type RecoveryOptions,
  type RecoveryTarget,
} from './client-integration-recovery.ts'

const CLAUDE_ENDPOINT = 'http://127.0.0.1:4400/baton/inference/anthropic'
const CODEX_ENDPOINT = 'http://127.0.0.1:4400/baton/inference/openai/v1'

export interface OfflineIntegrationOptions extends RecoveryOptions {
  home?: string
  localAppData?: string
  /** Tests only; production commands always enforce stopped clients. */
  skipClientSafetyChecks?: boolean
  processCheck?: (target: RecoveryTarget) => Promise<void>
}

export interface OfflineProcessRecord {
  Name?: string | null
  ExecutablePath?: string | null
  CommandLine?: string | null
}

export async function offlineIntegrationStatus(options: OfflineIntegrationOptions = {}) {
  const statuses = await listRecoveryStatuses(options)
  const inspected = []
  for (const status of statuses) {
    if (status.state !== 'MISSING') {
      inspected.push(status)
      continue
    }
    try {
      const existing = await detectExistingIntegrations(options, [status.target])
      inspected.push(existing.has(status.target)
        ? { ...status, state: 'UNTRACKED' as const, detail: 'exact Baton 설정이지만 receipt가 없습니다. adopt-existing가 필요합니다.' }
        : status)
    } catch (error) {
      inspected.push({
        ...status,
        state: 'CORRUPT' as const,
        detail: publicError(error),
      })
    }
  }
  return inspected
}

export async function offlineIntegrationRemove(
  targets: RecoveryTarget[],
  options: OfflineIntegrationOptions = {},
) {
  const results = []
  for (const target of targets) {
    try {
      if (!options.skipClientSafetyChecks) await (options.processCheck ?? assertOfflineClientStopped)(target)
      const receipt = await removeRecoveryIntegration(target, options)
      results.push({ ...publicReceipt(receipt), ok: true })
    } catch (error) {
      results.push({ target, ok: false, error: publicError(error) })
    }
  }
  return results
}

export async function offlineIntegrationAdopt(
  targets: RecoveryTarget[],
  confirmed: boolean,
  options: OfflineIntegrationOptions = {},
) {
  const results = []
  for (const target of targets) {
    try {
      const detected = await detectExistingIntegrations(options, [target])
      const mutation = detected.get(target)
      if (!mutation) throw new RecoveryError('missing', `${target}: exact Baton 설정을 찾지 못했습니다.`)
      if (!options.skipClientSafetyChecks) await (options.processCheck ?? assertOfflineClientStopped)(target)
      const result = await adoptExistingIntegration(mutation, confirmed, options)
      results.push('preview' in result ? { ...result, ok: true } : { ...publicReceipt(result), ok: true })
    } catch (error) {
      results.push({ target, ok: false, error: publicError(error) })
    }
  }
  return results
}

export async function offlineDoctor(options: OfflineIntegrationOptions = {}) {
  const recovery = await doctorRecovery(options)
  const statuses = await offlineIntegrationStatus(options)
  return {
    ...recovery,
    statuses,
    ok: recovery.ok && statuses.every((item) => !['UNTRACKED', 'CORRUPT', 'CONFLICT'].includes(item.state)),
  }
}

export async function detectExistingIntegrations(
  options: OfflineIntegrationOptions = {},
  targets: RecoveryTarget[] = ['claude-cli', 'claude-desktop', 'codex'],
): Promise<Map<RecoveryTarget, RecoveryMutation>> {
  const home = options.home ?? process.env.BATON_OFFLINE_HOME ?? homedir()
  const localAppData = options.localAppData ?? process.env.BATON_OFFLINE_LOCAL_APP_DATA ?? process.env.LOCALAPPDATA
  const detected = new Map<RecoveryTarget, RecoveryMutation>()

  const cliPath = path.join(home, '.claude', 'settings.json')
  const cli = targets.includes('claude-cli') ? await readOptional(cliPath) : { existed: false, content: '' }
  if (targets.includes('claude-cli') && cli.existed) {
    const current = parseJson(cli.content)
    const env = objectValue(current.env)
    if (env?.ANTHROPIC_BASE_URL === CLAUDE_ENDPOINT && !('ANTHROPIC_AUTH_TOKEN' in env)) {
      const before = structuredClone(current)
      const beforeEnv = objectValue(before.env)!
      delete beforeEnv.ANTHROPIC_BASE_URL
      if (Object.keys(beforeEnv).length === 0) delete before.env
      detected.set('claude-cli', {
        target: 'claude-cli', label: 'Claude CLI', filePath: cliPath, format: 'json',
        ownedFields: [['env', 'ANTHROPIC_BASE_URL'], ['env', 'ANTHROPIC_AUTH_TOKEN']],
        endpoint: CLAUDE_ENDPOINT, beforeExisted: true,
        beforeContent: json(before), appliedContent: cli.content,
      })
    }
  }

  if (targets.includes('claude-desktop') && localAppData) {
    const desktopPath = await findDesktopConfig(localAppData).catch(() => null)
    if (desktopPath) {
      const desktop = await readOptional(desktopPath)
      const current = desktop.existed ? parseJson(desktop.content) : null
      if (current
        && current.inferenceProvider === 'gateway'
        && current.inferenceCredentialKind === 'static'
        && current.inferenceGatewayBaseUrl === CLAUDE_ENDPOINT
        && typeof current.inferenceGatewayApiKey === 'string'
        && Array.isArray(current.inferenceModels)) {
        const before = structuredClone(current)
        for (const key of [
          'inferenceProvider', 'inferenceCredentialKind', 'inferenceGatewayBaseUrl',
          'inferenceGatewayApiKey', 'inferenceModels',
        ]) delete before[key]
        detected.set('claude-desktop', {
          target: 'claude-desktop', label: 'Claude Desktop', filePath: desktopPath, format: 'json',
          ownedFields: [
            ['inferenceProvider'], ['inferenceCredentialKind'], ['inferenceGatewayBaseUrl'],
            ['inferenceGatewayApiKey'], ['inferenceModels'],
          ],
          endpoint: CLAUDE_ENDPOINT, beforeExisted: true,
          beforeContent: json(before), appliedContent: desktop.content,
        })
      }
    }
  }

  const codexPath = path.join(home, '.codex', 'config.toml')
  const codex = targets.includes('codex') ? await readOptional(codexPath) : { existed: false, content: '' }
  if (targets.includes('codex') && codex.existed) {
    const current = parseTomlSafe(codex.content)
    const providers = objectValue(current.model_providers)
    const baton = objectValue(providers?.baton)
    if (
      current.openai_base_url === CODEX_ENDPOINT
      && (current.model_provider === undefined || current.model_provider === 'openai')
      && baton?.name === 'Baton Native (resume compatibility)'
      && baton.base_url === CODEX_ENDPOINT
      && baton.wire_api === 'responses'
      && baton.request_max_retries === 0
      && baton.stream_max_retries === 0
    ) {
      detected.set('codex', {
        target: 'codex', label: 'Codex CLI/Desktop', filePath: codexPath, format: 'toml',
        ownedFields: [['openai_base_url'], ['model_providers', 'baton']],
        endpoint: CODEX_ENDPOINT, beforeExisted: true,
        beforeContent: removeManagedCodexIntegrationText(codex.content, CODEX_ENDPOINT),
        appliedContent: codex.content,
      })
    }
  }
  return detected
}

async function findDesktopConfig(localAppData: string): Promise<string> {
  const directory = path.join(localAppData, 'Claude-3p', 'configLibrary')
  const names = (await readdir(directory)).filter((name) => name.toLowerCase().endsWith('.json'))
  const meta = await readOptional(path.join(directory, '_meta.json'))
  if (meta.existed) {
    const appliedId = parseJson(meta.content).appliedId
    if (typeof appliedId === 'string' && /^[0-9a-z-]+$/i.test(appliedId)) {
      const expected = `${appliedId}.json`
      if (names.includes(expected)) return path.join(directory, expected)
    }
  }
  const candidates: string[] = []
  for (const name of names.filter((item) => item !== '_meta.json')) {
    const file = path.join(directory, name)
    const value = parseJson(await readFile(file, 'utf8'))
    if (value.inferenceGatewayBaseUrl === CLAUDE_ENDPOINT) candidates.push(file)
  }
  if (candidates.length !== 1) throw new Error('Claude Desktop 설정 대상을 확정하지 못했습니다.')
  return candidates[0]
}

async function readOptional(file: string): Promise<{ existed: boolean; content: string }> {
  try {
    return { existed: true, content: await readFile(file, 'utf8') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { existed: false, content: '' }
    throw error
  }
}

function parseJson(content: string): Record<string, unknown> {
  try {
    const value = JSON.parse(content) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object expected')
    return value as Record<string, unknown>
  } catch {
    throw new RecoveryError('corrupt', '클라이언트 JSON 설정 문법이 올바르지 않습니다.')
  }
}

function parseTomlSafe(content: string): Record<string, unknown> {
  try {
    const value = parseToml(content) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object expected')
    return value as Record<string, unknown>
  } catch {
    throw new RecoveryError('corrupt', 'Codex TOML 설정 문법이 올바르지 않습니다.')
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function json(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function publicReceipt(receipt: {
  target: RecoveryTarget
  state: string
  filePath: string
  adopted: boolean
  originalValuesKnown: boolean
}) {
  return {
    target: receipt.target,
    state: receipt.state,
    filePath: receipt.filePath,
    adopted: receipt.adopted,
    originalValuesKnown: receipt.originalValuesKnown,
  }
}

function publicError(error: unknown): string {
  if (error instanceof RecoveryError) return error.message
  return '예상하지 못한 로컬 설정 오류가 발생했습니다.'
}

async function assertOfflineClientStopped(target: RecoveryTarget): Promise<void> {
  if (process.platform !== 'win32') throw new RecoveryError('invalid', 'offline client 안전 검사는 Windows에서만 지원합니다.')
  const script = String.raw`$records = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object Name, ExecutablePath, CommandLine)
[Console]::Out.Write(($records | ConvertTo-Json -Compress))`
  const output = await runOfflinePowerShell(script, [])
  let parsed: unknown
  try {
    parsed = output ? JSON.parse(output) : []
  } catch {
    throw new RecoveryError('busy', '클라이언트 종료 상태를 확정할 수 없습니다.')
  }
  const records = (Array.isArray(parsed) ? parsed : [parsed]) as OfflineProcessRecord[]
  if (records.some((record) => isOfflineClientProcess(target, record))) {
    throw new RecoveryError('busy', `${target} 클라이언트가 실행 중이거나 종료 상태를 확정할 수 없습니다.`)
  }
}

/** Recovery-safe pure classifier; command-line markers are never inferred from the executable path. */
export function isOfflineClientProcess(target: RecoveryTarget, record: OfflineProcessRecord): boolean {
  const name = (record.Name ?? '').toLowerCase()
  const executablePath = (record.ExecutablePath ?? '').toLowerCase()
  const commandLine = (record.CommandLine ?? '').toLowerCase()

  if (target === 'claude-cli') {
    return name === 'claude.exe'
      && !(executablePath.includes('claude-3p') || executablePath.includes('windowsapps\\claude_'))
  }
  if (target === 'claude-desktop') {
    return name === 'claude.exe'
      && (executablePath.includes('claude-3p') || executablePath.includes('windowsapps\\claude_') || !executablePath)
  }
  if (name === 'codex.exe') {
    const batonAppServer = commandLine.includes('app-server') && commandLine.includes('baton-model-catalog.json')
    return !batonAppServer
  }
  if (name === 'chatgpt.exe') {
    return executablePath.includes('openai.codex') || commandLine.includes('openai.codex')
      || (!executablePath && !commandLine)
  }
  return false
}

function runOfflinePowerShell(script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(
      `$ErrorActionPreference = 'Stop'\n$inputObject = [Console]::In.ReadToEnd() | ConvertFrom-Json\n${script}`,
      'utf16le',
    ).toString('base64')
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.setEncoding('utf8').on('data', (value: string) => { stdout += value })
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new RecoveryError('busy', '클라이언트 종료 상태를 확정할 수 없습니다.')))
    child.stdin.end(JSON.stringify({ items: args }))
  })
}
