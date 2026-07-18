import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile as writeFsFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  AgentToolDefinition,
  AgentToolInvocation,
  AgentToolResult,
} from '../domain.ts'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const DEFAULT_OUTPUT_BYTES = 256 * 1024
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const NEVER_ABORTED_SIGNAL = new AbortController().signal
const MUTATION_LOCKS = new Map<string, Promise<void>>()

type JsonObject = Record<string, unknown>

export const LOCAL_WORKSPACE_TOOL_DEFINITIONS: readonly AgentToolDefinition[] = Object.freeze([
  definition('read_file', 'Read a UTF-8 file from the workspace by byte range.', 'read_only', {
    path: stringSchema(1), offset: integerSchema(0), limit: integerSchema(1, 1_048_576),
  }, ['path']),
  definition('list_files', 'List workspace files and directories recursively.', 'read_only', {
    path: { ...stringSchema(1), default: '.' }, maxEntries: integerSchema(1, 500),
  }),
  definition('search_text', 'Search UTF-8 workspace files for literal text.', 'read_only', {
    query: stringSchema(1, 4_096), path: { ...stringSchema(1), default: '.' }, glob: stringSchema(1),
    maxResults: integerSchema(1, 500),
  }, ['query']),
  definition('write_file', 'Create or atomically replace a workspace file using SHA-256 CAS.', 'workspace_mutation', {
    path: stringSchema(1), content: { type: 'string' },
    expectedSha256: { anyOf: [{ type: 'string', pattern: '^[A-Fa-f0-9]{64}$' }, { type: 'null' }] },
  }, ['path', 'content', 'expectedSha256']),
  definition('replace_text', 'Atomically replace exact text occurrences using SHA-256 CAS.', 'workspace_mutation', {
    path: stringSchema(1), oldText: stringSchema(1), newText: { type: 'string' },
    expectedSha256: { type: 'string', pattern: '^[A-Fa-f0-9]{64}$' },
    expectedOccurrences: integerSchema(1, 1_000),
  }, ['path', 'oldText', 'newText', 'expectedSha256']),
  definition('run_command', 'Run an argv command in the workspace sandbox without shell interpolation.', 'workspace_command', {
    argv: {
      type: 'array', minItems: 1, maxItems: 128,
      items: { type: 'string', minLength: 1, maxLength: 32_768 },
    },
    timeoutMs: integerSchema(1, 120_000),
  }, ['argv']),
])

export interface SandboxCommandRequest {
  argv: readonly string[]
  cwd: string
  signal: AbortSignal
  onStdout(chunk: Uint8Array): void
  onStderr(chunk: Uint8Array): void
}

export interface SandboxCommandRunner {
  run(request: SandboxCommandRequest): Promise<{ exitCode: number | null }>
}

export class CodexSandboxCommandRunner implements SandboxCommandRunner {
  readonly #executable: string

  constructor(executable?: string) {
    this.#executable = executable ?? resolveCodexExecutable()
  }

  async run(request: SandboxCommandRequest): Promise<{ exitCode: number | null }> {
    const sandboxHome = await mkdtemp(path.join(tmpdir(), 'baton-command-'))
    const commandTemp = path.join(sandboxHome, 'tmp')
    await mkdir(commandTemp)
    await writeFsFile(path.join(sandboxHome, 'config.toml'), commandSandboxConfig(request.cwd, commandTemp), {
      encoding: 'utf8',
      mode: 0o600,
    })
    try {
      return await new Promise((resolve, reject) => {
      const child = spawn(this.#executable, [
        'sandbox', '-P', 'baton-workspace', '-C', request.cwd,
        '--sandbox-state-disable-network', '--', ...request.argv,
      ], {
        cwd: request.cwd,
        env: commandEnvironment(sandboxHome, commandTemp),
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        request.signal.removeEventListener('abort', abort)
        callback()
      }
      const abort = (): void => {
        if (child.exitCode !== null) return
        if (process.platform === 'win32' && child.pid) {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true, shell: false, stdio: 'ignore',
          })
          killer.once('error', () => child.kill())
        } else {
          child.kill('SIGKILL')
        }
      }
      child.stdout?.on('data', (chunk: Buffer) => request.onStdout(chunk))
      child.stderr?.on('data', (chunk: Buffer) => request.onStderr(chunk))
      child.once('error', (error) => finish(() => reject(error)))
      child.once('close', (code) => finish(() => resolve({ exitCode: code })))
      request.signal.addEventListener('abort', abort, { once: true })
      if (request.signal.aborted) abort()
      })
    } finally {
      await rm(sandboxHome, { recursive: true, force: true })
    }
  }
}

export interface LocalWorkspaceToolRuntimeOptions {
  cwd: string
  commandRunner?: SandboxCommandRunner
  /** Commands stay unavailable unless a strict external-read sandbox has been verified by the host. */
  enableCommands?: boolean
  maxOutputBytes?: number
}

export class LocalWorkspaceToolRuntime {
  readonly definitions: readonly AgentToolDefinition[]
  readonly #cwd: string
  readonly #commandRunner: SandboxCommandRunner
  readonly #maxOutputBytes: number
  readonly #enableCommands: boolean

  constructor(options: LocalWorkspaceToolRuntimeOptions) {
    if (!path.isAbsolute(options.cwd)) throw new Error('LocalWorkspaceToolRuntime cwd must be absolute')
    if (options.maxOutputBytes !== undefined
      && (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1)) {
      throw new Error('maxOutputBytes must be a positive integer')
    }
    this.#cwd = path.resolve(options.cwd)
    this.#commandRunner = options.commandRunner ?? new CodexSandboxCommandRunner()
    this.#enableCommands = options.enableCommands === true
    this.definitions = this.#enableCommands
      ? LOCAL_WORKSPACE_TOOL_DEFINITIONS
      : LOCAL_WORKSPACE_TOOL_DEFINITIONS.filter((definition) => definition.name !== 'run_command')
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES
  }

  async execute(invocation: AgentToolInvocation, signal: AbortSignal = NEVER_ABORTED_SIGNAL): Promise<AgentToolResult> {
    try {
      if (signal.aborted) throw new ToolRuntimeError('tool_aborted', 'Tool execution was cancelled', false)
      switch (invocation.name) {
        case 'read_file': return ok(await this.#readFile(validateReadFile(invocation.input), signal))
        case 'list_files': return ok(await this.#listFiles(validateListFiles(invocation.input), signal))
        case 'search_text': return ok(await this.#searchText(validateSearchText(invocation.input), signal))
        case 'write_file': return ok(await this.#writeFile(validateWriteFile(invocation.input), signal))
        case 'replace_text': return ok(await this.#replaceText(validateReplaceText(invocation.input), signal))
        case 'run_command': {
          if (!this.#enableCommands) {
            throw new ToolRuntimeError(
              'tool_unavailable',
              'run_command is disabled until the host verifies strict workspace-only read isolation',
              false,
            )
          }
          return ok(await this.#runCommand(validateRunCommand(invocation.input), signal))
        }
        default: throw new ToolRuntimeError('tool_not_found', `Unregistered tool: ${invocation.name}`, false)
      }
    } catch (error) {
      return failure(normalizeError(error))
    }
  }

  async #readFile(input: ReadFileInput, signal: AbortSignal): Promise<JsonObject> {
    const resolved = await this.#resolvePath(input.path, false)
    abortIfNeeded(signal)
    const fileStat = await stat(resolved.absolute)
    if (!fileStat.isFile()) throw new ToolRuntimeError('path_type_mismatch', 'Path is not a file', false)
    if (fileStat.size > MAX_FILE_BYTES) throw new ToolRuntimeError('file_too_large', 'File exceeds 2 MiB', false)
    const content = await readFile(resolved.absolute)
    abortIfNeeded(signal)
    if (content.length > MAX_FILE_BYTES) throw new ToolRuntimeError('file_too_large', 'File exceeds 2 MiB', false)
    assertValidUtf8(content)
    const requestedOffset = Math.min(input.offset ?? 0, content.length)
    let start = requestedOffset
    while (start < content.length && isContinuationByte(content[start]!)) start += 1
    let end = Math.min(start + Math.min(input.limit ?? this.#maxOutputBytes, this.#maxOutputBytes), content.length)
    while (end > start && end < content.length && isContinuationByte(content[end]!)) end -= 1
    if (end === start && start < content.length) {
      end = start + 1
      while (end < content.length && isContinuationByte(content[end]!)) end += 1
    }
    return {
      path: resolved.relative,
      sha256: sha256(content),
      text: content.subarray(start, end).toString('utf8'),
      truncated: end < content.length,
      nextOffset: end,
    }
  }

  async #listFiles(input: ListFilesInput, signal: AbortSignal): Promise<JsonObject> {
    const root = await this.#resolvePath(input.path ?? '.', false)
    const rootStat = await stat(root.absolute)
    if (!rootStat.isDirectory()) throw new ToolRuntimeError('path_type_mismatch', 'Path is not a directory', false)
    const maxEntries = input.maxEntries ?? 500
    const entries: JsonObject[] = []
    const pending = [root.absolute]
    const visited = new Set<string>()
    let truncated = false
    while (pending.length > 0) {
      abortIfNeeded(signal)
      const directory = pending.shift()!
      const canonicalDirectory = await realpath(directory)
      if (visited.has(canonicalDirectory)) continue
      visited.add(canonicalDirectory)
      const children = await readdir(directory, { withFileTypes: true })
      children.sort((left, right) => left.name.localeCompare(right.name, 'en'))
      for (const child of children) {
        abortIfNeeded(signal)
        if (entries.length >= maxEntries) { truncated = true; break }
        const childPath = path.join(directory, child.name)
        const checked = await this.#resolveAbsoluteExisting(childPath)
        const childStat = await stat(checked.absolute)
        const type = childStat.isDirectory() ? 'directory' : childStat.isFile() ? 'file' : 'other'
        entries.push({ path: checked.relative, type, size: childStat.size })
        if (childStat.isDirectory()) pending.push(childPath)
      }
      if (truncated) break
    }
    return { path: root.relative, entries, truncated }
  }

  async #searchText(input: SearchTextInput, signal: AbortSignal): Promise<JsonObject> {
    const root = await this.#resolvePath(input.path ?? '.', false)
    const rootStat = await stat(root.absolute)
    if (!rootStat.isDirectory() && !rootStat.isFile()) {
      throw new ToolRuntimeError('path_type_mismatch', 'Search path must be a file or directory', false)
    }
    const maxResults = input.maxResults ?? 500
    const matches: JsonObject[] = []
    const files = rootStat.isFile() ? [root.absolute] : await this.#collectFiles(root.absolute, signal)
    const glob = input.glob ? compileGlob(input.glob) : null
    let truncated = false
    for (const file of files) {
      abortIfNeeded(signal)
      const checked = await this.#resolveAbsoluteExisting(file)
      if (glob && !glob.test(checked.relative.replaceAll('\\', '/'))) continue
      const fileStat = await stat(checked.absolute)
      if (fileStat.size > MAX_FILE_BYTES) continue
      const bytes = await readFile(checked.absolute)
      if (bytes.length > MAX_FILE_BYTES) continue
      try { assertValidUtf8(bytes) } catch { continue }
      const lines = bytes.toString('utf8').split(/\r?\n/u)
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex]!
        let from = 0
        while (from <= line.length) {
          const column = line.indexOf(input.query, from)
          if (column < 0) break
          if (matches.length >= maxResults) { truncated = true; break }
          matches.push({ path: checked.relative, line: lineIndex + 1, column: column + 1, text: line })
          from = column + Math.max(1, input.query.length)
        }
        if (truncated) break
      }
      if (truncated) break
    }
    return { matches, truncated }
  }

  async #writeFile(input: WriteFileInput, signal: AbortSignal): Promise<JsonObject> {
    const content = Buffer.from(input.content, 'utf8')
    if (content.length > MAX_FILE_BYTES) throw new ToolRuntimeError('file_too_large', 'File exceeds 2 MiB', false)
    const resolved = await this.#resolvePath(input.path, true)
    return withMutationLock(resolved.absolute, async () => {
      const before = await readOptionalFile(resolved.absolute)
      if (input.expectedSha256 === null) {
        if (before !== null) throw new ToolRuntimeError('target_exists', 'Creation target already exists', false)
      } else {
        if (before === null) throw new ToolRuntimeError('path_not_found', 'Overwrite target does not exist', false)
        assertDigest(input.expectedSha256, before)
      }
      abortIfNeeded(signal)
      await this.#atomicWrite(resolved.absolute, content, input.expectedSha256, signal)
      return {
        path: resolved.relative, sha256: sha256(content), bytes: content.length, created: before === null,
      }
    })
  }

  async #replaceText(input: ReplaceTextInput, signal: AbortSignal): Promise<JsonObject> {
    const resolved = await this.#resolvePath(input.path, false)
    return withMutationLock(resolved.absolute, async () => {
      const before = await readFile(resolved.absolute)
      if (before.length > MAX_FILE_BYTES) throw new ToolRuntimeError('file_too_large', 'File exceeds 2 MiB', false)
      assertValidUtf8(before)
      assertDigest(input.expectedSha256, before)
      const text = before.toString('utf8')
      const occurrences = countOccurrences(text, input.oldText)
      if (input.expectedOccurrences !== undefined && occurrences !== input.expectedOccurrences) {
        throw new ToolRuntimeError(
          'occurrence_mismatch',
          `Expected ${input.expectedOccurrences} occurrence(s), found ${occurrences}`,
          false,
        )
      }
      if (occurrences === 0) throw new ToolRuntimeError('occurrence_mismatch', 'Text was not found', false)
      const content = Buffer.from(text.split(input.oldText).join(input.newText), 'utf8')
      if (content.length > MAX_FILE_BYTES) throw new ToolRuntimeError('file_too_large', 'File exceeds 2 MiB', false)
      abortIfNeeded(signal)
      await this.#atomicWrite(resolved.absolute, content, input.expectedSha256, signal)
      return {
        path: resolved.relative, sha256: sha256(content), bytes: content.length, replacements: occurrences,
      }
    })
  }

  async #runCommand(input: RunCommandInput, signal: AbortSignal): Promise<JsonObject> {
    const root = await this.#resolvePath('.', false)
    const controller = new AbortController()
    let timedOut = false
    const forwardAbort = (): void => controller.abort(signal.reason)
    signal.addEventListener('abort', forwardAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('tool timeout'))
    }, input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS)
    let remaining = this.#maxOutputBytes
    let truncated = false
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const collect = (target: Buffer[], value: Uint8Array): void => {
      const chunk = Buffer.from(value)
      if (chunk.length > remaining) truncated = true
      if (remaining > 0) {
        const accepted = chunk.subarray(0, remaining)
        if (accepted.length > 0) target.push(accepted)
        remaining -= accepted.length
      }
    }
    try {
      let exitCode: number | null
      try {
        const result = await this.#commandRunner.run({
          argv: input.argv,
          cwd: root.absolute,
          signal: controller.signal,
          onStdout: (chunk) => collect(stdout, chunk),
          onStderr: (chunk) => collect(stderr, chunk),
        })
        exitCode = result.exitCode
      } catch (error) {
        if (!timedOut) {
          if (signal.aborted) throw new ToolRuntimeError('tool_aborted', 'Tool execution was cancelled', false)
          throw error
        }
        exitCode = null
      }
      if (signal.aborted && !timedOut) {
        throw new ToolRuntimeError('tool_aborted', 'Tool execution was cancelled', false)
      }
      const output = {
        exitCode: timedOut ? null : exitCode,
        stdout: safeOutputText(Buffer.concat(stdout)),
        stderr: safeOutputText(Buffer.concat(stderr)),
        timedOut,
        truncated,
      }
      if (timedOut) {
        throw new ToolRuntimeError(
          'tool_timeout',
          'Command exceeded its timeout and its process tree was terminated',
          false,
          output,
        )
      }
      return output
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', forwardAbort)
    }
  }

  async #atomicWrite(
    target: string,
    content: Buffer,
    expectedSha256: string | null,
    signal: AbortSignal,
  ): Promise<void> {
    const parent = path.dirname(target)
    await this.#resolveAbsoluteExisting(parent)
    const temp = path.join(parent, `.${path.basename(target)}.baton-${process.pid}-${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(temp, 'wx', 0o600)
      await handle.writeFile(content)
      await handle.sync()
      await handle.close()
      handle = null
      abortIfNeeded(signal)
      await this.#resolveAbsoluteExisting(parent)
      const current = await readOptionalFile(target)
      if (expectedSha256 === null) {
        if (current !== null) throw new ToolRuntimeError('target_exists', 'Creation target changed during write', false)
      } else {
        if (current === null) throw new ToolRuntimeError('sha256_mismatch', 'Target disappeared during write', false)
        assertDigest(expectedSha256, current)
      }
      await rename(temp, target)
    } finally {
      if (handle) await handle.close().catch(() => undefined)
      await unlink(temp).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }

  async #collectFiles(root: string, signal: AbortSignal): Promise<string[]> {
    const files: string[] = []
    const pending = [root]
    const visited = new Set<string>()
    while (pending.length > 0) {
      abortIfNeeded(signal)
      const directory = pending.shift()!
      const canonical = await realpath(directory)
      if (visited.has(canonical)) continue
      visited.add(canonical)
      const children = await readdir(directory, { withFileTypes: true })
      children.sort((left, right) => left.name.localeCompare(right.name, 'en'))
      for (const child of children) {
        const childPath = path.join(directory, child.name)
        const checked = await this.#resolveAbsoluteExisting(childPath)
        const childStat = await stat(checked.absolute)
        if (childStat.isDirectory()) pending.push(childPath)
        else if (childStat.isFile()) files.push(childPath)
      }
    }
    return files
  }

  async #resolvePath(input: string, allowMissing: boolean): Promise<ResolvedWorkspacePath> {
    if (input.includes('\0') || path.isAbsolute(input)) {
      throw new ToolRuntimeError('path_escape', 'Path must be workspace-relative', false)
    }
    const absolute = path.resolve(this.#cwd, input)
    if (!isContained(this.#cwd, absolute)) {
      throw new ToolRuntimeError('path_escape', 'Path escapes the workspace', false)
    }
    if (!allowMissing) return this.#resolveAbsoluteExisting(absolute)
    let ancestor = absolute
    while (true) {
      try {
        await lstat(ancestor)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const parent = path.dirname(ancestor)
        if (parent === ancestor) throw new ToolRuntimeError('path_not_found', 'No existing path ancestor', false)
        ancestor = parent
      }
    }
    const rootReal = await realpath(this.#cwd)
    const ancestorReal = await realpath(ancestor)
    if (!isContained(rootReal, ancestorReal)) {
      throw new ToolRuntimeError('path_escape', 'Path resolves outside the workspace', false)
    }
    const safeAbsolute = path.resolve(ancestorReal, path.relative(ancestor, absolute))
    return { absolute: safeAbsolute, relative: portableRelative(this.#cwd, absolute) }
  }

  async #resolveAbsoluteExisting(absolute: string): Promise<ResolvedWorkspacePath> {
    let rootReal: string
    let targetReal: string
    try {
      [rootReal, targetReal] = await Promise.all([realpath(this.#cwd), realpath(absolute)])
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ToolRuntimeError('path_not_found', 'Path does not exist', false)
      }
      throw error
    }
    if (!isContained(rootReal, targetReal)) {
      throw new ToolRuntimeError('path_escape', 'Path resolves outside the workspace', false)
    }
    const displayRoot = isContained(this.#cwd, absolute) ? this.#cwd : rootReal
    return { absolute: targetReal, relative: portableRelative(displayRoot, absolute) }
  }
}

interface ResolvedWorkspacePath { absolute: string, relative: string }
interface ReadFileInput { path: string, offset?: number, limit?: number }
interface ListFilesInput { path?: string, maxEntries?: number }
interface SearchTextInput { query: string, path?: string, glob?: string, maxResults?: number }
interface WriteFileInput { path: string, content: string, expectedSha256: string | null }
interface ReplaceTextInput {
  path: string, oldText: string, newText: string, expectedSha256: string, expectedOccurrences?: number
}
interface RunCommandInput { argv: string[], timeoutMs?: number }

class ToolRuntimeError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly metadata: JsonObject | undefined
  constructor(code: string, message: string, retryable: boolean, metadata?: JsonObject) {
    super(message)
    this.code = code
    this.retryable = retryable
    this.metadata = metadata
  }
}

function definition(
  name: string,
  description: string,
  sideEffect: AgentToolDefinition['sideEffect'],
  properties: JsonObject,
  required: string[] = [],
): AgentToolDefinition {
  return {
    name, description, sideEffect,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
  }
}

function stringSchema(minLength?: number, maxLength?: number): JsonObject {
  return { type: 'string', ...(minLength === undefined ? {} : { minLength }), ...(maxLength === undefined ? {} : { maxLength }) }
}

function integerSchema(minimum: number, maximum?: number): JsonObject {
  return { type: 'integer', minimum, ...(maximum === undefined ? {} : { maximum }) }
}

function validateReadFile(input: JsonObject): ReadFileInput {
  onlyKeys(input, ['path', 'offset', 'limit'])
  return {
    path: requiredString(input, 'path'),
    ...(input.offset === undefined ? {} : { offset: integer(input.offset, 'offset', 0) }),
    ...(input.limit === undefined ? {} : { limit: integer(input.limit, 'limit', 1, 1_048_576) }),
  }
}

function validateListFiles(input: JsonObject): ListFilesInput {
  onlyKeys(input, ['path', 'maxEntries'])
  return {
    ...(input.path === undefined ? {} : { path: requiredString(input, 'path') }),
    ...(input.maxEntries === undefined ? {} : { maxEntries: integer(input.maxEntries, 'maxEntries', 1, 500) }),
  }
}

function validateSearchText(input: JsonObject): SearchTextInput {
  onlyKeys(input, ['query', 'path', 'glob', 'maxResults'])
  const query = requiredString(input, 'query')
  if (utf8Bytes(query) > 4_096) invalid('query exceeds 4096 UTF-8 bytes')
  return {
    query,
    ...(input.path === undefined ? {} : { path: requiredString(input, 'path') }),
    ...(input.glob === undefined ? {} : { glob: requiredString(input, 'glob') }),
    ...(input.maxResults === undefined ? {} : { maxResults: integer(input.maxResults, 'maxResults', 1, 500) }),
  }
}

function validateWriteFile(input: JsonObject): WriteFileInput {
  onlyKeys(input, ['path', 'content', 'expectedSha256'])
  if (typeof input.content !== 'string') invalid('content must be a string')
  if (input.expectedSha256 !== null && !validDigest(input.expectedSha256)) {
    invalid('expectedSha256 must be null or a SHA-256 digest')
  }
  return {
    path: requiredString(input, 'path'), content: input.content,
    expectedSha256: input.expectedSha256 === null ? null : String(input.expectedSha256).toLowerCase(),
  }
}

function validateReplaceText(input: JsonObject): ReplaceTextInput {
  onlyKeys(input, ['path', 'oldText', 'newText', 'expectedSha256', 'expectedOccurrences'])
  const oldText = requiredString(input, 'oldText')
  if (typeof input.newText !== 'string') invalid('newText must be a string')
  if (!validDigest(input.expectedSha256)) invalid('expectedSha256 must be a SHA-256 digest')
  return {
    path: requiredString(input, 'path'), oldText, newText: input.newText,
    expectedSha256: input.expectedSha256.toLowerCase(),
    ...(input.expectedOccurrences === undefined ? {} : {
      expectedOccurrences: integer(input.expectedOccurrences, 'expectedOccurrences', 1, 1_000),
    }),
  }
}

function validateRunCommand(input: JsonObject): RunCommandInput {
  onlyKeys(input, ['argv', 'timeoutMs'])
  if (!Array.isArray(input.argv) || input.argv.length < 1 || input.argv.length > 128) {
    invalid('argv must contain 1..128 elements')
  }
  const argv = input.argv.map((value, index) => {
    if (typeof value !== 'string' || value.length === 0 || utf8Bytes(value) > 32_768) {
      invalid(`argv[${index}] must contain 1..32768 UTF-8 bytes`)
    }
    if (value.includes('\0')) invalid(`argv[${index}] contains NUL`)
    return value
  })
  if (argv.reduce((total, value) => total + utf8Bytes(value), 0) > 128 * 1024) {
    invalid('argv exceeds 128 KiB')
  }
  return {
    argv,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: integer(input.timeoutMs, 'timeoutMs', 1, 120_000) }),
  }
}

function onlyKeys(input: JsonObject, allowed: readonly string[]): void {
  const unexpected = Object.keys(input).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) invalid(`Unsupported input properties: ${unexpected.sort().join(', ')}`)
}

function requiredString(input: JsonObject, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.length === 0) invalid(`${key} must be a non-empty string`)
  return value
}

function integer(value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(`${label} must be an integer from ${minimum} through ${maximum}`)
  }
  return value as number
}

function invalid(message: string): never {
  throw new ToolRuntimeError('invalid_tool_input', message, false)
}

function ok(content: JsonObject): AgentToolResult { return { success: true, content, error: null } }

function failure(error: ToolRuntimeError): AgentToolResult {
  return {
    success: false,
    content: null,
    ...(error.metadata ? { metadata: error.metadata } : {}),
    error: { code: error.code, message: error.message, retryable: error.retryable },
  }
}

function normalizeError(error: unknown): ToolRuntimeError {
  if (error instanceof ToolRuntimeError) return error
  if (error instanceof Error && error.name === 'AbortError') {
    return new ToolRuntimeError('tool_aborted', 'Tool execution was cancelled', false)
  }
  const code = error instanceof Error && 'code' in error ? String(error.code) : ''
  if (code === 'EACCES' || code === 'EPERM') return new ToolRuntimeError('permission_denied', 'Permission denied', false)
  return new ToolRuntimeError('tool_io_error', error instanceof Error ? error.message : 'Tool execution failed', false)
}

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw new ToolRuntimeError('tool_aborted', 'Tool execution was cancelled', false)
}

function sha256(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
function validDigest(value: unknown): value is string { return typeof value === 'string' && SHA256_PATTERN.test(value) }
function assertDigest(expected: string, content: Uint8Array): void {
  if (sha256(content) !== expected.toLowerCase()) {
    throw new ToolRuntimeError('sha256_mismatch', 'File digest does not match expectedSha256', false)
  }
}

function isContained(root: string, child: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(child))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function portableRelative(root: string, child: string): string {
  const relative = path.relative(root, child).replaceAll('\\', '/')
  return relative || '.'
}

function assertValidUtf8(value: Uint8Array): void {
  try { new TextDecoder('utf-8', { fatal: true }).decode(value) }
  catch { throw new ToolRuntimeError('invalid_utf8', 'File is not valid UTF-8', false) }
}

function isContinuationByte(value: number): boolean { return (value & 0xc0) === 0x80 }
function utf8Bytes(value: string): number { return Buffer.byteLength(value, 'utf8') }

async function readOptionalFile(file: string): Promise<Buffer | null> {
  try {
    const fileStat = await stat(file)
    if (!fileStat.isFile()) throw new ToolRuntimeError('path_type_mismatch', 'Path is not a file', false)
    if (fileStat.size > MAX_FILE_BYTES) throw new ToolRuntimeError('file_too_large', 'File exceeds 2 MiB', false)
    return await readFile(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function countOccurrences(text: string, query: string): number {
  let count = 0
  let from = 0
  while (from <= text.length) {
    const next = text.indexOf(query, from)
    if (next < 0) return count
    count += 1
    from = next + query.length
  }
  return count
}

function compileGlob(glob: string): RegExp {
  let source = '^'
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]!
    if (character === '*') {
      if (glob[index + 1] === '*') { source += '.*'; index += 1 }
      else source += '[^/]*'
    } else if (character === '?') source += '[^/]'
    else source += character.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')
  }
  try { return new RegExp(`${source}$`, 'u') }
  catch { throw new ToolRuntimeError('invalid_tool_input', 'glob is invalid', false) }
}

function safeOutputText(value: Buffer): string {
  if (value.length === 0) return ''
  let leadIndex = value.length - 1
  while (leadIndex >= 0 && isContinuationByte(value[leadIndex]!)) leadIndex -= 1
  if (leadIndex < 0) return ''
  const lead = value[leadIndex]!
  const expected = lead >= 0xf0 && lead <= 0xf7 ? 4
    : lead >= 0xe0 && lead <= 0xef ? 3
      : lead >= 0xc0 && lead <= 0xdf ? 2 : 1
  const actual = value.length - leadIndex
  const end = actual < expected ? leadIndex : value.length
  return value.subarray(0, end).toString('utf8')
}

function commandSandboxConfig(cwd: string, commandTemp: string): string {
  return [
    'default_permissions = "baton-workspace"',
    '',
    '[permissions.baton-workspace.filesystem]',
    '":minimal" = "read"',
    `${JSON.stringify(path.resolve(cwd))} = "write"`,
    `${JSON.stringify(path.resolve(commandTemp))} = "write"`,
    '',
    '[permissions.baton-workspace.network]',
    'enabled = false',
    '',
  ].join('\n')
}

function commandEnvironment(sandboxHome: string, commandTemp: string): NodeJS.ProcessEnv {
  const inherited = ['PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'OS',
    'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']
  const environment: NodeJS.ProcessEnv = {}
  for (const key of inherited) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  environment.CODEX_HOME = sandboxHome
  environment.HOME = sandboxHome
  environment.USERPROFILE = sandboxHome
  environment.TEMP = commandTemp
  environment.TMP = commandTemp
  return environment
}

async function withMutationLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? path.resolve(target).toLowerCase() : path.resolve(target)
  const previous = MUTATION_LOCKS.get(key) ?? Promise.resolve()
  let release: (() => void) | undefined
  const current = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.then(() => current)
  MUTATION_LOCKS.set(key, queued)
  await previous
  try {
    return await operation()
  } finally {
    release?.()
    if (MUTATION_LOCKS.get(key) === queued) MUTATION_LOCKS.delete(key)
  }
}

function resolveCodexExecutable(): string {
  if (process.platform !== 'win32') return 'codex'
  const architecture = process.arch === 'arm64'
    ? { packageName: 'codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' }
    : { packageName: 'codex-win32-x64', triple: 'x86_64-pc-windows-msvc' }
  const pathDirectories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const appDataNpm = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null
  const roots = [...new Set([...pathDirectories, ...(appDataNpm ? [appDataNpm] : [])])]
  for (const root of roots) {
    const direct = path.join(root, 'codex.exe')
    if (existsSync(direct)) return direct
    const packaged = path.join(
      root, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', architecture.packageName,
      'vendor', architecture.triple, 'bin', 'codex.exe',
    )
    if (existsSync(packaged)) return packaged
  }
  return 'codex.exe'
}
