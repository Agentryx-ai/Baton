import type { AgentToolInvocation, AgentToolResult } from '../domain.ts'
import type { ToolRuntime } from '../tool-coordinator.ts'

export class CompositeToolRuntime implements ToolRuntime {
  readonly definitions
  readonly abortWaitsForTermination: boolean
  readonly #runtimeByTool: ReadonlyMap<string, ToolRuntime>

  constructor(runtimes: readonly ToolRuntime[]) {
    const runtimeByTool = new Map<string, ToolRuntime>()
    for (const runtime of runtimes) {
      for (const definition of runtime.definitions) {
        if (runtimeByTool.has(definition.name)) throw new Error(`Duplicate tool definition: ${definition.name}`)
        runtimeByTool.set(definition.name, runtime)
      }
    }
    this.#runtimeByTool = runtimeByTool
    this.definitions = Object.freeze(runtimes.flatMap((runtime) => [...runtime.definitions]))
    this.abortWaitsForTermination = runtimes.every((runtime) => runtime.abortWaitsForTermination === true)
  }

  execute(invocation: AgentToolInvocation, signal?: AbortSignal): Promise<AgentToolResult> {
    const runtime = this.#runtimeByTool.get(invocation.name)
    if (!runtime) return Promise.resolve({
      success: false,
      content: null,
      error: { code: 'tool_unavailable', message: `Tool is unavailable: ${invocation.name}`, retryable: false },
    })
    return runtime.execute(invocation, signal)
  }
}
