import type {
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
  denyApproval(request: unknown): Promise<never>
  denyToolCall(request: unknown): Promise<never>
}

export interface ProviderTerminalResult {
  status: 'completed' | 'cancelled' | 'failed' | 'interrupted'
  usage?: Record<string, unknown> | null
  error?: Record<string, unknown> | null
}

export interface ProviderTurnExecution {
  events: AsyncIterable<NativeProviderEvent>
  terminal: Promise<ProviderTerminalResult>
  cancel(): Promise<void>
  dispose(): Promise<void>
}

export interface ProviderBindingPatch {
  nativeThreadId?: string | null
  nativeResponseId?: string | null
  opaqueState?: Uint8Array | null
  modelFamily?: string
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
  shutdown(): Promise<void>
}

export function assertCanonicalAdapterHandshake(handshake: AdapterHandshake): void {
  if (handshake.capabilities.nativeChildExecution !== 'disabled') {
    throw new Error('Canonical mode requires native child execution to be disabled')
  }
  if (handshake.exposedNativeAgentTools.length > 0) {
    throw new Error(
      `Canonical mode rejected native agent tools: ${handshake.exposedNativeAgentTools.join(', ')}`,
    )
  }
}
