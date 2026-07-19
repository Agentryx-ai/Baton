import { spawn } from 'node:child_process'
import path from 'node:path'

import type { AgentToolDefinition, AgentToolInvocation, AgentToolResult, LdPlayerGrant } from '../domain.ts'
import type { ImageArtifactRef } from '../image-artifacts.ts'
import { LocalImageArtifactStore } from '../image-artifacts.ts'
import type { ToolRuntime } from '../tool-coordinator.ts'

export interface LdPlayerInstance {
  index: number
  name: string
  running: boolean
  androidStarted: boolean
  pid: number | null
}

export interface LdPlayerCommandResult {
  stdout: Buffer
  stderr: Buffer
  exitCode: number
}

export type LdPlayerCommandRunner = (
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<LdPlayerCommandResult>

export interface LdPlayerHostOptions {
  installationRoots?: readonly string[]
  runner?: LdPlayerCommandRunner
  now?: () => Date
}

export class LdPlayerHost {
  readonly #roots: readonly string[]
  readonly #runner: LdPlayerCommandRunner
  readonly #now: () => Date

  constructor(options: LdPlayerHostOptions = {}) {
    this.#roots = [...new Set(options.installationRoots ?? defaultInstallationRoots())]
      .map((root) => path.resolve(root))
    this.#runner = options.runner ?? runLdPlayerCommand
    this.#now = options.now ?? (() => new Date())
  }

  async listInstances(signal?: AbortSignal): Promise<Array<LdPlayerInstance & { installationRoot: string }>> {
    const instances: Array<LdPlayerInstance & { installationRoot: string }> = []
    for (const installationRoot of this.#roots) {
      const executable = path.join(installationRoot, 'ldconsole.exe')
      try {
        const result = await this.#runner(executable, ['list2'], signal)
        if (result.exitCode !== 0) continue
        instances.push(...parseLdPlayerList(result.stdout.toString('utf8')).map((instance) => ({
          ...instance,
          installationRoot,
        })))
      } catch (error) {
        if (signal?.aborted) throw error
      }
    }
    return instances.sort((left, right) => left.installationRoot.localeCompare(right.installationRoot)
      || left.index - right.index)
  }

  async verifyGrant(grant: LdPlayerGrant, signal?: AbortSignal): Promise<LdPlayerInstance> {
    validateGrant(grant)
    if (!this.#roots.some((root) => samePath(root, grant.installationRoot))) {
      throw new LdPlayerError('ldplayer_installation_unavailable', 'The granted LDPlayer installation is no longer trusted')
    }
    const instance = (await this.listInstances(signal)).find((candidate) => (
      samePath(candidate.installationRoot, grant.installationRoot)
      && candidate.index === grant.instanceIndex
    ))
    if (!instance || instance.name !== grant.instanceName) {
      throw new LdPlayerError('ldplayer_instance_changed', 'The granted LDPlayer instance no longer matches its observed identity')
    }
    return instance
  }

  async start(grant: LdPlayerGrant, signal?: AbortSignal): Promise<LdPlayerInstance> {
    const before = await this.verifyGrant(grant, signal)
    if (before.androidStarted) return before
    await this.#runConsole(grant, ['launch', '--index', String(grant.instanceIndex)], signal)
    const deadline = this.#now().getTime() + 120_000
    while (this.#now().getTime() < deadline) {
      await delay(1_000, signal)
      const current = await this.verifyGrant(grant, signal)
      if (current.androidStarted) return current
    }
    throw new LdPlayerError('ldplayer_start_timeout', 'LDPlayer did not finish Android startup within 120 seconds')
  }

  async adb(grant: LdPlayerGrant, command: string, signal?: AbortSignal): Promise<Buffer> {
    const instance = await this.verifyGrant(grant, signal)
    if (!instance.androidStarted) throw new LdPlayerError('ldplayer_not_running', 'The granted LDPlayer instance is not running')
    const result = await this.#runConsole(
      grant,
      ['adb', '--index', String(grant.instanceIndex), '--command', command],
      signal,
      true,
    )
    const screenshot = command === 'exec-out screencap -p'
      && result.stdout.indexOf(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) >= 0
    if (!screenshot && /(?:^|\s)(?:error|failed|failure):?/i.test(result.stderr.toString('utf8'))) {
      throw new LdPlayerError('ldplayer_adb_failed', `ADB command failed: ${boundedText(result.stderr)}`)
    }
    return result.stdout
  }

  async #runConsole(
    grant: LdPlayerGrant,
    args: readonly string[],
    signal?: AbortSignal,
    allowStdout = false,
  ): Promise<LdPlayerCommandResult> {
    const executable = path.join(grant.installationRoot, 'ldconsole.exe')
    const result = await this.#runner(executable, args, signal)
    if (result.exitCode !== 0) {
      throw new LdPlayerError(
        'ldplayer_command_failed',
        `LDPlayer command failed with exit code ${result.exitCode}${result.stderr.length ? `: ${boundedText(result.stderr)}` : ''}`,
      )
    }
    if (!allowStdout && result.stderr.length > 64 * 1024) {
      throw new LdPlayerError('ldplayer_command_failed', 'LDPlayer command produced excessive diagnostic output')
    }
    return result
  }
}

export class LdPlayerToolRuntime implements ToolRuntime {
  readonly definitions = LDPLAYER_TOOL_DEFINITIONS
  readonly abortWaitsForTermination = true
  readonly #grant: LdPlayerGrant
  readonly #host: LdPlayerHost
  readonly #artifacts: LocalImageArtifactStore

  constructor(grant: LdPlayerGrant, host: LdPlayerHost, artifacts: LocalImageArtifactStore) {
    validateGrant(grant)
    this.#grant = Object.freeze({ ...grant })
    this.#host = host
    this.#artifacts = artifacts
  }

  async execute(invocation: AgentToolInvocation, signal?: AbortSignal): Promise<AgentToolResult> {
    try {
      switch (invocation.name) {
        case 'ldplayer_status': {
          requireExactKeys(invocation.input, [])
          return success({ instance: await this.#host.verifyGrant(this.#grant, signal) })
        }
        case 'ldplayer_start': {
          requireExactKeys(invocation.input, [])
          return success({ instance: await this.#host.start(this.#grant, signal) })
        }
        case 'ldplayer_capture': {
          requireExactKeys(invocation.input, [])
          const bytes = await this.#host.adb(this.#grant, 'exec-out screencap -p', signal)
          const artifact = this.#artifacts.put(
            normalizeScreencap(bytes),
            'image/png',
            `ldplayer-${this.#grant.instanceIndex}-${Date.now()}.png`,
            'ldplayer_capture',
          )
          return success({ artifact }, [artifact])
        }
        case 'ldplayer_tap': {
          requireExactKeys(invocation.input, ['x', 'y'])
          const x = coordinate(invocation.input.x, 'x')
          const y = coordinate(invocation.input.y, 'y')
          await this.#host.adb(this.#grant, `shell input tap ${x} ${y}`, signal)
          return success({ tapped: { x, y } })
        }
        case 'ldplayer_swipe': {
          requireExactKeys(invocation.input, ['x1', 'y1', 'x2', 'y2', 'durationMs'])
          const x1 = coordinate(invocation.input.x1, 'x1')
          const y1 = coordinate(invocation.input.y1, 'y1')
          const x2 = coordinate(invocation.input.x2, 'x2')
          const y2 = coordinate(invocation.input.y2, 'y2')
          const durationMs = integerInRange(invocation.input.durationMs, 'durationMs', 1, 10_000)
          await this.#host.adb(this.#grant, `shell input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`, signal)
          return success({ swiped: { x1, y1, x2, y2, durationMs } })
        }
        case 'ldplayer_input_text': {
          requireExactKeys(invocation.input, ['text'])
          const text = safeInputText(invocation.input.text)
          const encoded = encodeInputText(text)
          await this.#host.adb(this.#grant, `shell input text ${encoded}`, signal)
          return success({ inputLength: text.length })
        }
        case 'ldplayer_keyevent': {
          requireExactKeys(invocation.input, ['keyCode'])
          const keyCode = integerInRange(invocation.input.keyCode, 'keyCode', 0, 1_000)
          await this.#host.adb(this.#grant, `shell input keyevent ${keyCode}`, signal)
          return success({ keyCode })
        }
        case 'ldplayer_run_flow': {
          requireExactKeys(invocation.input, ['steps'])
          if (!Array.isArray(invocation.input.steps) || invocation.input.steps.length < 1
            || invocation.input.steps.length > 50) {
            throw new LdPlayerError('invalid_tool_input', 'steps must contain 1..50 bounded UX-flow actions')
          }
          const images: ImageArtifactRef[] = []
          const completed: Array<Record<string, unknown>> = []
          let totalWaitMs = 0
          for (const [index, rawStep] of invocation.input.steps.entries()) {
            if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) {
              throw new LdPlayerError('invalid_tool_input', `steps[${index}] must be an object`)
            }
            const step = rawStep as Record<string, unknown>
            const label = typeof step.label === 'string' && step.label.length <= 100 ? step.label : null
            switch (step.action) {
              case 'tap': {
                requireExactKeys(step, ['action', 'label', 'x', 'y'].filter((key) => key !== 'label' || label !== null))
                const x = coordinate(step.x, 'x')
                const y = coordinate(step.y, 'y')
                await this.#host.adb(this.#grant, `shell input tap ${x} ${y}`, signal)
                completed.push({ index, action: 'tap', ...(label ? { label } : {}) })
                break
              }
              case 'swipe': {
                const keys = ['action', 'x1', 'y1', 'x2', 'y2', 'durationMs', ...(label ? ['label'] : [])]
                requireExactKeys(step, keys)
                const x1 = coordinate(step.x1, 'x1')
                const y1 = coordinate(step.y1, 'y1')
                const x2 = coordinate(step.x2, 'x2')
                const y2 = coordinate(step.y2, 'y2')
                const durationMs = integerInRange(step.durationMs, 'durationMs', 1, 10_000)
                await this.#host.adb(this.#grant, `shell input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`, signal)
                completed.push({ index, action: 'swipe', ...(label ? { label } : {}) })
                break
              }
              case 'text': {
                requireExactKeys(step, ['action', 'text', ...(label ? ['label'] : [])])
                const text = safeInputText(step.text)
                await this.#host.adb(this.#grant, `shell input text ${encodeInputText(text)}`, signal)
                completed.push({ index, action: 'text', inputLength: text.length, ...(label ? { label } : {}) })
                break
              }
              case 'keyevent': {
                requireExactKeys(step, ['action', 'keyCode', ...(label ? ['label'] : [])])
                const keyCode = integerInRange(step.keyCode, 'keyCode', 0, 1_000)
                await this.#host.adb(this.#grant, `shell input keyevent ${keyCode}`, signal)
                completed.push({ index, action: 'keyevent', keyCode, ...(label ? { label } : {}) })
                break
              }
              case 'wait': {
                requireExactKeys(step, ['action', 'durationMs', ...(label ? ['label'] : [])])
                const durationMs = integerInRange(step.durationMs, 'durationMs', 1, 5_000)
                totalWaitMs += durationMs
                if (totalWaitMs > 30_000) throw new LdPlayerError('invalid_tool_input', 'UX-flow waits exceed 30 seconds')
                await delay(durationMs, signal)
                completed.push({ index, action: 'wait', durationMs, ...(label ? { label } : {}) })
                break
              }
              case 'capture': {
                requireExactKeys(step, ['action', ...(label ? ['label'] : [])])
                const bytes = await this.#host.adb(this.#grant, 'exec-out screencap -p', signal)
                const artifact = this.#artifacts.put(
                  normalizeScreencap(bytes),
                  'image/png',
                  `ldplayer-${this.#grant.instanceIndex}-flow-${index}-${Date.now()}.png`,
                  'ldplayer_capture',
                )
                images.push(artifact)
                completed.push({ index, action: 'capture', artifact, ...(label ? { label } : {}) })
                break
              }
              default:
                throw new LdPlayerError('invalid_tool_input', `steps[${index}].action is unsupported`)
            }
          }
          return success({ completed }, images)
        }
        default:
          throw new LdPlayerError('unknown_tool', `Unknown LDPlayer tool: ${invocation.name}`)
      }
    } catch (error) {
      return failure(
        error instanceof LdPlayerError ? error.code : signal?.aborted ? 'tool_aborted' : 'ldplayer_error',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}

export class LdPlayerError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'LdPlayerError'
    this.code = code
  }
}

export const LDPLAYER_TOOL_DEFINITIONS: readonly AgentToolDefinition[] = Object.freeze([
  tool('ldplayer_status', 'Inspect the exact LDPlayer instance connected to this Baton conversation.', 'read_only', {}),
  tool('ldplayer_start', 'Start the exact LDPlayer instance connected to this conversation and wait for Android.', 'host_mutation', {}),
  tool('ldplayer_capture', 'Capture the current LDPlayer screen and inspect it as an image.', 'read_only', {}),
  tool('ldplayer_tap', 'Tap a screen coordinate in the connected LDPlayer instance.', 'host_mutation', {
    x: integerSchema(0, 16_383), y: integerSchema(0, 16_383),
  }, ['x', 'y']),
  tool('ldplayer_swipe', 'Swipe between two screen coordinates in the connected LDPlayer instance.', 'host_mutation', {
    x1: integerSchema(0, 16_383), y1: integerSchema(0, 16_383),
    x2: integerSchema(0, 16_383), y2: integerSchema(0, 16_383),
    durationMs: integerSchema(1, 10_000),
  }, ['x1', 'y1', 'x2', 'y2', 'durationMs']),
  tool('ldplayer_input_text', 'Type bounded ASCII text into the connected LDPlayer instance.', 'host_mutation', {
    text: { type: 'string', minLength: 1, maxLength: 500, pattern: '^[A-Za-z0-9 .,\\-_@+:/%]+$' },
  }, ['text']),
  tool('ldplayer_keyevent', 'Send one Android key event to the connected LDPlayer instance.', 'host_mutation', {
    keyCode: integerSchema(0, 1_000),
  }, ['keyCode']),
  tool('ldplayer_run_flow', 'Run a bounded declarative UX-flow template and return every requested screenshot.', 'host_mutation', {
    steps: {
      type: 'array', minItems: 1, maxItems: 50,
      items: flowStepSchema(),
    },
  }, ['steps']),
])

export function parseLdPlayerList(output: string): LdPlayerInstance[] {
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const fields = line.split(',')
    // LDPlayer 9 list2: index,name,topWindow,bindHandle,androidStarted,pid,vboxPid,width,height,dpi.
    // Instance names are user-controlled, so parse the eight fixed fields from the right.
    if (fields.length < 10) throw new LdPlayerError('invalid_ldplayer_output', 'LDPlayer list2 returned an unsupported row')
    const index = Number(fields[0])
    const fixed = fields.slice(-8)
    const topWindow = Number(fixed[0])
    const androidStarted = Number(fixed[2])
    const pid = Number(fixed[3])
    if (!Number.isSafeInteger(index) || index < 0 || index > 999
      || !Number.isSafeInteger(topWindow) || topWindow < 0
      || (androidStarted !== 0 && androidStarted !== 1)) {
      throw new LdPlayerError('invalid_ldplayer_output', 'LDPlayer list2 returned invalid state fields')
    }
    return {
      index,
      name: fields.slice(1, -8).join(','),
      running: topWindow > 0 || pid > 0,
      androidStarted: androidStarted === 1,
      pid: pid > 0 ? pid : null,
    }
  })
}

export async function runLdPlayerCommand(
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<LdPlayerCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      signal,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    const cap = 16 * 1024 * 1024
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= cap) stdout.push(chunk)
      else child.kill()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes <= cap) stderr.push(chunk)
      else child.kill()
    })
    child.once('error', reject)
    child.once('close', (exitCode) => {
      if (stdoutBytes > cap || stderrBytes > cap) {
        reject(new LdPlayerError('ldplayer_output_limit', 'LDPlayer command exceeded the output limit'))
        return
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: exitCode ?? -1 })
    })
  })
}

function defaultInstallationRoots(): string[] {
  return [process.env.LDPLAYER_HOME, 'C:\\LDPlayer\\LDPlayer9'].filter((value): value is string => Boolean(value))
}

function validateGrant(grant: LdPlayerGrant): void {
  if (grant.kind !== 'ldplayer' || !path.isAbsolute(grant.installationRoot)
    || !Number.isSafeInteger(grant.instanceIndex) || grant.instanceIndex < 0 || grant.instanceIndex > 999
    || !grant.instanceName || grant.instanceName.length > 200) {
    throw new LdPlayerError('invalid_ldplayer_grant', 'LDPlayer grant is invalid')
  }
}

function normalizeScreencap(value: Buffer): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const offset = value.indexOf(signature)
  if (offset < 0) throw new LdPlayerError('invalid_screenshot', 'ADB screencap did not return a PNG image')
  return value.subarray(offset)
}

function requireExactKeys(input: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(input).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new LdPlayerError('invalid_tool_input', 'LDPlayer tool received unsupported or missing properties')
  }
}

function coordinate(value: unknown, name: string): number {
  return integerInRange(value, name, 0, 16_383)
}

function safeInputText(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 500
    || !/^[A-Za-z0-9 .,\-_@+:/%]+$/.test(value)) {
    throw new LdPlayerError('invalid_tool_input', 'text must be 1..500 safe ADB input characters')
  }
  return value
}

function encodeInputText(value: string): string {
  return value.replace(/%/g, '%25').replace(/ /g, '%s')
}

function integerInRange(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new LdPlayerError('invalid_tool_input', `${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return Number(value)
}

function success(content: Record<string, unknown>, images: ImageArtifactRef[] = []): AgentToolResult {
  return { success: true, content, ...(images.length ? { images } : {}), error: null }
}

function failure(code: string, message: string): AgentToolResult {
  return { success: false, content: null, error: { code, message, retryable: false } }
}

function tool(
  name: string,
  description: string,
  sideEffect: AgentToolDefinition['sideEffect'],
  properties: Record<string, unknown>,
  required: string[] = [],
): AgentToolDefinition {
  return { name, description, sideEffect, inputSchema: { type: 'object', properties, required, additionalProperties: false } }
}

function integerSchema(minimum: number, maximum: number): Record<string, unknown> {
  return { type: 'integer', minimum, maximum }
}

function flowStepSchema(): Record<string, unknown> {
  const label = { type: 'string', maxLength: 100 }
  const variant = (
    action: string,
    properties: Record<string, unknown>,
    required: string[] = [],
  ) => ({
    type: 'object',
    properties: { action: { const: action }, label, ...properties },
    required: ['action', ...required],
    additionalProperties: false,
  })
  return {
    oneOf: [
      variant('tap', { x: integerSchema(0, 16_383), y: integerSchema(0, 16_383) }, ['x', 'y']),
      variant('swipe', {
        x1: integerSchema(0, 16_383), y1: integerSchema(0, 16_383),
        x2: integerSchema(0, 16_383), y2: integerSchema(0, 16_383),
        durationMs: integerSchema(1, 10_000),
      }, ['x1', 'y1', 'x2', 'y2', 'durationMs']),
      variant('text', {
        text: { type: 'string', minLength: 1, maxLength: 500, pattern: '^[A-Za-z0-9 .,\\-_@+:/%]+$' },
      }, ['text']),
      variant('keyevent', { keyCode: integerSchema(0, 1_000) }, ['keyCode']),
      variant('wait', { durationMs: integerSchema(1, 5_000) }, ['durationMs']),
      variant('capture', {}),
    ],
  }
}

function boundedText(value: Buffer): string {
  return value.subarray(0, 2_000).toString('utf8').replace(/[\r\n]+/g, ' ').trim()
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}
