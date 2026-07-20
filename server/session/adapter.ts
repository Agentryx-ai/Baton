import type {
  AgentLoopLimits,
  AgentToolDefinition,
  AgentToolInvocation,
  AgentToolResult,
  CanonicalProvider,
  NewCanonicalItem,
  ProviderCapabilities,
  ThreadSnapshot,
  TurnId,
} from './domain.ts'

export interface CanonicalTurnRequest {
  turnId: TurnId
  model: string
  effort?: string | null
  input: NewCanonicalItem[]
}

export interface AdapterHandshake {
  adapterVersion: string
  capabilities: ProviderCapabilities
  exposedNativeAgentTools: string[]
  enforcementEvidence: Record<string, unknown>
}

export interface NativeTurnRequest {
  body: unknown
  bindingPatch?: Record<string, unknown>
}

export interface NativeProviderEvent {
  eventId: string | null
  type: string
  payload: unknown
  durability: 'durable' | 'ephemeral'
}

export interface ProviderExecutionContext {
  signal: AbortSignal
  toolDefinitions: readonly AgentToolDefinition[]
  limits: Readonly<AgentLoopLimits>
  executeTool(request: AgentToolInvocation): Promise<AgentToolResult>
  denyApproval(request: unknown): Promise<never>
  denyToolCall(request: unknown): Promise<never>
}

export interface ProviderTerminalResult {
  status: 'completed' | 'cancelled' | 'failed' | 'interrupted'
  usage?: Record<string, unknown> | null
  error?: Record<string, unknown> | null
}

export interface ProviderSteerRequest {
  followUpId: string
  text: string
  /** Baton canonical turn identity observed when the follow-up was enqueued. */
  expectedTurnId: TurnId
}

export type ProviderSteerResult =
  | { status: 'accepted' }
  | { status: 'closed' }
  | { status: 'unsupported' }

export interface ProviderTurnExecution {
  events: AsyncIterable<NativeProviderEvent>
  terminal: Promise<ProviderTerminalResult>
  /** A rejection is an unknown delivery outcome: never consume it or retry it automatically. */
  steer?(request: ProviderSteerRequest): Promise<ProviderSteerResult>
  cancel(): Promise<void>
  dispose(): Promise<void>
}

export interface ProviderBindingPatch {
  nativeThreadId?: string | null
  nativeResponseId?: string | null
  opaqueState?: Uint8Array | null
  modelFamily?: string
}

export interface ProviderSkillResource {
  /** Stable provider-local identifier exposed to the model (for example, openai-docs). */
  id: string
  /** Immutable root that the Baton read-only skill resource tool may access. */
  root: string
}

export interface SessionProviderAdapter {
  readonly provider: CanonicalProvider

  initialize(): Promise<AdapterHandshake>
  validate(request: CanonicalTurnRequest, snapshot: ThreadSnapshot): void
  materialize(request: CanonicalTurnRequest, snapshot: ThreadSnapshot): NativeTurnRequest
  execute(
    request: NativeTurnRequest,
    context: ProviderExecutionContext,
  ): Promise<ProviderTurnExecution>
  normalize(event: NativeProviderEvent): NewCanonicalItem[]
  extractBinding(event: NativeProviderEvent): ProviderBindingPatch | null
  /** Provider-selected skill resources. These never grant execution or general filesystem access. */
  skillResources?(): readonly ProviderSkillResource[]
  shutdown(): Promise<void>
}

export function assertCanonicalAdapterHandshake(handshake: AdapterHandshake): void {
  const tools = handshake.exposedNativeAgentTools
  if (handshake.capabilities.nativeChildExecution === 'disabled' && tools.length > 0) {
    throw new Error(
      `Adapter declared disabled native child execution but exposed native agent tools: ${tools.join(', ')}`,
    )
  }
  if (handshake.capabilities.nativeChildExecution === 'exposed' && tools.length === 0) {
    throw new Error('Adapter declared exposed native child execution without native agent tools')
  }
  if (tools.some((tool) => tool.trim().length === 0) || new Set(tools).size !== tools.length) {
    throw new Error('Adapter exposed invalid or duplicate native agent tool names')
  }
}
