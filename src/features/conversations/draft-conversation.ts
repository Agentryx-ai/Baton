import type { CanonicalProvider, FirstTurnDto, ImageArtifactRefDto } from './types.ts'

export const DRAFT_STORAGE_KEY = 'baton.conversation.draft.v1'

export interface ConversationDraft {
  version: 1
  sessionId: string
  clientRequestId: string
  cwd: string | null
  provider: CanonicalProvider
  model: string
  effort: string | null
  message: string
  frozenRequest: FirstTurnDto | null
  deliveryUnknown: boolean
  conflict: boolean
}

export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function createConversationDraft(input: {
  provider: CanonicalProvider
  model: string
  effort: string | null
  cwd?: string | null
  randomId?: () => string
}): ConversationDraft {
  const randomId = input.randomId ?? (() => crypto.randomUUID())
  return {
    version: 1,
    sessionId: randomId(),
    clientRequestId: randomId(),
    cwd: input.cwd ?? null,
    provider: input.provider,
    model: input.model,
    effort: input.effort,
    message: '',
    frozenRequest: null,
    deliveryUnknown: false,
    conflict: false,
  }
}

export function freezeFirstTurn(draft: ConversationDraft, attachments: ImageArtifactRefDto[] = []): ConversationDraft {
  if (draft.frozenRequest) return draft
  const message = draft.message.trim()
  if (!draft.model.trim() || (!message && attachments.length === 0)) throw new Error('Model and message or image are required')
  const request: FirstTurnDto = {
    clientRequestId: draft.clientRequestId,
    cwd: draft.cwd,
    provider: draft.provider,
    model: draft.model.trim(),
    effort: draft.effort,
    input: [{
      kind: 'user_message',
      visibility: 'portable',
      payload: { text: message, ...(attachments.length ? { attachments } : {}) },
    }],
  }
  return { ...draft, message, frozenRequest: request, deliveryUnknown: false, conflict: false }
}

export function editableAfterKnownFailure(draft: ConversationDraft): ConversationDraft {
  return { ...draft, frozenRequest: null, deliveryUnknown: false, conflict: false }
}

export function markDeliveryUnknown(draft: ConversationDraft): ConversationDraft {
  if (!draft.frozenRequest) throw new Error('Cannot mark an unfrozen first turn as unknown')
  return { ...draft, deliveryUnknown: true, conflict: false }
}

export function markInitialSessionConflict(draft: ConversationDraft): ConversationDraft {
  if (!draft.frozenRequest) throw new Error('Cannot mark an unfrozen first turn as conflicted')
  return { ...draft, deliveryUnknown: false, conflict: true }
}

export type FirstTurnFailureDisposition = 'editable' | 'unknown' | 'conflict'

export function classifyFirstTurnFailure(error: unknown): FirstTurnFailureDisposition {
  if (!error || typeof error !== 'object') return 'unknown'
  const value = error as { status?: unknown; code?: unknown }
  if (value.status === 409 && value.code === 'initial_session_conflict') return 'conflict'
  if (value.status === 503 && value.code === 'provider_not_ready') return 'editable'
  if (value.status === 400 && (
    value.code === 'invalid_request'
    || value.code === 'invalid_json'
    || value.code === 'invalid_workspace'
  )) return 'editable'
  return 'unknown'
}

export function applyDraftFolderSelection(
  current: ConversationDraft | null,
  requestedSessionId: string,
  cwd: string,
): ConversationDraft | null {
  if (!current || current.sessionId !== requestedSessionId || current.frozenRequest) return current
  return { ...current, cwd }
}

export function saveConversationDraft(storage: DraftStorage, draft: ConversationDraft): void {
  storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft))
}

export function clearConversationDraft(storage: DraftStorage): void {
  storage.removeItem(DRAFT_STORAGE_KEY)
}

export function loadConversationDraft(storage: DraftStorage): ConversationDraft | null {
  const raw = storage.getItem(DRAFT_STORAGE_KEY)
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<ConversationDraft>
    if (
      value.version !== 1
      || typeof value.sessionId !== 'string'
      || !value.sessionId
      || typeof value.clientRequestId !== 'string'
      || !value.clientRequestId
      || (value.cwd !== null && typeof value.cwd !== 'string')
      || !isProvider(value.provider)
      || typeof value.model !== 'string'
      || (value.effort !== null && typeof value.effort !== 'string')
      || typeof value.message !== 'string'
      || typeof value.deliveryUnknown !== 'boolean'
      || (value.conflict !== undefined && typeof value.conflict !== 'boolean')
      || !isFrozenRequest(value.frozenRequest, value.clientRequestId)
    ) return null
    return { ...value, conflict: value.conflict === true } as ConversationDraft
  } catch {
    return null
  }
}

export function conversationRouteUrl(
  href: string,
  route: { kind: 'draft'; sessionId: string } | { kind: 'session'; sessionId: string },
): string {
  const url = new URL(href)
  url.searchParams.delete('draft')
  url.searchParams.delete('session')
  url.searchParams.set(route.kind, route.sessionId)
  url.hash = 'conversations'
  return url.toString()
}

export type ConversationRoute =
  | { kind: 'draft'; sessionId: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'none' }

export function conversationRouteFromUrl(href: string): ConversationRoute {
  const url = new URL(href)
  const draft = url.searchParams.get('draft')
  const session = url.searchParams.get('session')
  if (draft) return { kind: 'draft', sessionId: draft }
  if (session) return { kind: 'session', sessionId: session }
  return { kind: 'none' }
}

export function conversationRouteWithoutSelection(href: string): string {
  const url = new URL(href)
  url.searchParams.delete('draft')
  url.searchParams.delete('session')
  url.hash = 'conversations'
  return url.toString()
}

export interface InitialConversationRoute {
  draftOpen: boolean
  selectedSessionId: string | null
  invalidDraftRoute: boolean
}

export function resolveInitialConversationRoute(
  href: string,
  draft: ConversationDraft | null,
): InitialConversationRoute {
  const route = conversationRouteFromUrl(href)
  if (route.kind === 'session') {
    return { draftOpen: false, selectedSessionId: route.sessionId, invalidDraftRoute: false }
  }
  if (route.kind === 'draft') {
    const valid = draft?.sessionId === route.sessionId
    return { draftOpen: valid, selectedSessionId: null, invalidDraftRoute: !valid }
  }
  return { draftOpen: draft !== null, selectedSessionId: null, invalidDraftRoute: false }
}

function isProvider(value: unknown): value is CanonicalProvider {
  return value === 'claude' || value === 'codex' || value === 'gemini'
}

function isFrozenRequest(value: unknown, clientRequestId: string): value is FirstTurnDto | null {
  if (value === null) return true
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<FirstTurnDto>
  return request.clientRequestId === clientRequestId
    && (request.cwd === null || typeof request.cwd === 'string')
    && isProvider(request.provider)
    && typeof request.model === 'string'
    && request.model.length > 0
    && (request.effort === undefined || request.effort === null || typeof request.effort === 'string')
    && Array.isArray(request.input)
    && request.input.length === 1
    && request.input[0]?.kind === 'user_message'
    && request.input[0]?.visibility === 'portable'
    && typeof request.input[0]?.payload?.text === 'string'
}
