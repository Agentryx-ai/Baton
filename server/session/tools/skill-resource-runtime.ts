import { existsSync, readdirSync } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { AgentToolDefinition, AgentToolInvocation, AgentToolResult } from '../domain.ts'
import type { ProviderSkillResource } from '../adapter.ts'
import type { ToolRuntime } from '../tool-coordinator.ts'

const MAX_READ_BYTES = 1_048_576
const NEVER_ABORTED_SIGNAL = new AbortController().signal

export const READ_SKILL_RESOURCE_TOOL: AgentToolDefinition = Object.freeze({
  name: 'read_skill_resource',
  description: 'Read an approved resource belonging to a skill exposed by the selected provider. Use the skill name and a path relative to that skill; never pass skill paths to read_file.',
  sideEffect: 'read_only',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['skill', 'path'],
    properties: {
      skill: { type: 'string', minLength: 1, maxLength: 256 },
      path: { type: 'string', minLength: 1, maxLength: 4_096 },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: MAX_READ_BYTES },
    },
  },
})

export function discoverSkillResources(roots: readonly string[]): readonly ProviderSkillResource[] {
  const resources = new Map<string, string>()
  for (const root of roots) {
    if (!path.isAbsolute(root) || !existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.system') continue
      const skillRoot = path.join(root, entry.name)
      if (existsSync(path.join(skillRoot, 'SKILL.md')) && !resources.has(entry.name)) {
        resources.set(entry.name, skillRoot)
      }
    }
  }
  return Object.freeze([...resources].map(([id, root]) => Object.freeze({ id, root })))
}

export class SkillResourceToolRuntime implements ToolRuntime {
  readonly definitions = Object.freeze([READ_SKILL_RESOURCE_TOOL])
  readonly #resources: ReadonlyMap<string, string>

  constructor(resources: readonly ProviderSkillResource[]) {
    const entries = resources.map(({ id, root }) => {
      if (!id || path.isAbsolute(id) || id.includes('/') || id.includes('\\')) {
        throw new TypeError(`Invalid skill resource id: ${id}`)
      }
      if (!path.isAbsolute(root)) throw new TypeError(`Skill resource root must be absolute: ${id}`)
      return [id, path.resolve(root)] as const
    })
    if (new Set(entries.map(([id]) => id)).size !== entries.length) {
      throw new TypeError('Skill resource ids must be unique')
    }
    this.#resources = new Map(entries)
  }

  async execute(invocation: AgentToolInvocation, signal: AbortSignal = NEVER_ABORTED_SIGNAL): Promise<AgentToolResult> {
    try {
      if (invocation.name !== 'read_skill_resource') return failure('tool_not_found', `Unregistered tool: ${invocation.name}`)
      if (signal.aborted) return failure('tool_aborted', 'Tool execution was aborted', true)
      const input = validateInput(invocation.input)
      const root = this.#resources.get(input.skill)
      if (!root) return failure('skill_not_available', `Skill is not exposed by the selected provider: ${input.skill}`)
      const rootReal = await realpath(root)
      const requested = path.resolve(root, input.path)
      if (!isContained(root, requested)) return failure('path_escape', 'Skill resource path escapes its approved root')
      const targetReal = await realpath(requested)
      if (!isContained(rootReal, targetReal)) return failure('path_escape', 'Skill resource path escapes its approved root')
      const file = await stat(targetReal)
      if (!file.isFile()) return failure('path_type_mismatch', 'Skill resource path is not a file')
      const offset = input.offset ?? 0
      const limit = input.limit ?? MAX_READ_BYTES
      const handle = await open(targetReal, 'r')
      try {
        const available = Math.max(0, file.size - offset)
        const length = Math.min(limit, available)
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, offset)
        const text = buffer.subarray(0, bytesRead).toString('utf8')
        const nextOffset = offset + bytesRead
        return { success: true, content: {
          skill: input.skill,
          path: input.path.replaceAll('\\', '/'),
          text,
          truncated: nextOffset < file.size,
          nextOffset,
          size: file.size,
        }, error: null }
      } finally {
        await handle.close()
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return failure('path_not_found', 'Skill resource does not exist')
      return failure('skill_resource_error', error instanceof Error ? error.message : String(error))
    }
  }
}

export class CompositeToolRuntime implements ToolRuntime {
  readonly definitions: readonly AgentToolDefinition[]
  readonly abortWaitsForTermination: boolean
  readonly #byTool = new Map<string, ToolRuntime>()

  constructor(runtimes: readonly ToolRuntime[]) {
    const definitions: AgentToolDefinition[] = []
    for (const runtime of runtimes) {
      for (const definition of runtime.definitions) {
        if (this.#byTool.has(definition.name)) throw new TypeError(`Duplicate tool definition: ${definition.name}`)
        this.#byTool.set(definition.name, runtime)
        definitions.push(definition)
      }
    }
    this.definitions = Object.freeze(definitions)
    this.abortWaitsForTermination = runtimes.every((runtime) => (
      !runtime.definitions.some((definition) => definition.sideEffect === 'workspace_command')
      || runtime.abortWaitsForTermination === true
    ))
  }

  execute(invocation: AgentToolInvocation, signal?: AbortSignal): Promise<AgentToolResult> {
    const runtime = this.#byTool.get(invocation.name)
    return runtime
      ? runtime.execute(invocation, signal)
      : Promise.resolve(failure('tool_not_found', `Unregistered tool: ${invocation.name}`))
  }
}

function validateInput(value: Record<string, unknown>): { skill: string; path: string; offset?: number; limit?: number } {
  const keys = Object.keys(value)
  if (keys.some((key) => !['skill', 'path', 'offset', 'limit'].includes(key))) throw new TypeError('Unexpected skill resource input')
  if (typeof value.skill !== 'string' || value.skill.length < 1 || value.skill.length > 256) throw new TypeError('skill must be a non-empty string')
  if (typeof value.path !== 'string' || value.path.length < 1 || value.path.length > 4_096 || path.isAbsolute(value.path)) {
    throw new TypeError('path must be skill-relative')
  }
  if (value.offset !== undefined && (!Number.isSafeInteger(value.offset) || Number(value.offset) < 0)) throw new TypeError('offset must be a non-negative integer')
  if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > MAX_READ_BYTES)) throw new TypeError('limit is out of range')
  return { skill: value.skill, path: value.path, ...(value.offset === undefined ? {} : { offset: Number(value.offset) }), ...(value.limit === undefined ? {} : { limit: Number(value.limit) }) }
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function failure(code: string, message: string, retryable = false): AgentToolResult {
  return { success: false, content: null, error: { code, message, retryable } }
}
