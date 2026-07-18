import type {
  BeginTurnResultDto,
  CanonicalItemDto,
  CanonicalSessionDto,
  CreateSessionDto,
  StartTurnDto,
  ThreadSnapshotDto,
  ProviderModelDescriptorDto,
  CodexNativeScanFilter,
  NativeImportCommitDto,
  NativeImportPreviewDto,
  NativeImportSourceClient,
} from './types.ts'

const BASE_PATH = '/baton/v1'

export class ConversationApiError extends Error {
  readonly status: number
  readonly code: string | null

  constructor(status: number, message: string, code: string | null) {
    super(message)
    this.name = 'ConversationApiError'
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE_PATH}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...init.headers,
    },
  })
  const raw = await response.text()
  let parsed: unknown
  if (raw) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
  }
  if (!response.ok) {
    const error = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
    throw new ConversationApiError(
      response.status,
      typeof error?.error === 'string' ? error.error : `Request failed with status ${response.status}`,
      typeof error?.code === 'string' ? error.code : null,
    )
  }
  return parsed as T
}

function jsonRequest(method: 'POST', body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }
}

let nativeImportCsrfPromise: Promise<string> | null = null

function nativeImportCsrfToken(forceRefresh = false): Promise<string> {
  if (forceRefresh) nativeImportCsrfPromise = null
  nativeImportCsrfPromise ??= request<{ token: string }>('/native-import/csrf').then((result) => {
    if (!result || typeof result.token !== 'string' || !result.token) {
      throw new ConversationApiError(500, 'Native import CSRF bootstrap returned an invalid token', 'invalid_csrf_bootstrap')
    }
    return result.token
  }).catch((error) => {
    nativeImportCsrfPromise = null
    throw error
  })
  return nativeImportCsrfPromise
}

async function nativeImportPost<T>(path: string, body: unknown, retried = false): Promise<T> {
  const csrfToken = await nativeImportCsrfToken(retried)
  try {
    return await request<T>(path, jsonRequest('POST', body, { 'X-Baton-CSRF-Token': csrfToken }))
  } catch (error) {
    if (!retried && error instanceof ConversationApiError && error.status === 403) {
      return nativeImportPost<T>(path, body, true)
    }
    throw error
  }
}

export const conversationApi = {
  listModels: (provider: string): Promise<{
    provider: string
    models: ProviderModelDescriptorDto[]
    defaultModel: string | null
  }> => request(`/providers/${encodeURIComponent(provider)}/models`),

  listSessions: async (): Promise<CanonicalSessionDto[]> => {
    const result = await request<{ sessions: CanonicalSessionDto[] }>('/sessions')
    return result.sessions
  },

  createSession: (input: CreateSessionDto): Promise<CanonicalSessionDto> =>
    request('/sessions', jsonRequest('POST', input)),

  getThread: (threadId: string): Promise<ThreadSnapshotDto> =>
    request(`/threads/${encodeURIComponent(threadId)}`),

  listItems: async (threadId: string, after = 0): Promise<CanonicalItemDto[]> => {
    const result = await request<{ items: CanonicalItemDto[] }>(
      `/threads/${encodeURIComponent(threadId)}/items?after=${after}`,
    )
    return result.items
  },

  startTurn: (threadId: string, input: StartTurnDto): Promise<BeginTurnResultDto> =>
    request(`/threads/${encodeURIComponent(threadId)}/turns`, jsonRequest('POST', input)),

  cancelTurn: (turnId: string): Promise<void> =>
    request(`/turns/${encodeURIComponent(turnId)}/cancel`, { method: 'POST' }),

  previewNativeImport: (
    sources?: NativeImportSourceClient[],
    codex?: CodexNativeScanFilter,
  ): Promise<NativeImportPreviewDto> =>
    nativeImportPost('/native-import/preview', { sources, codex }),

  commitNativeImport: (
    token: string,
    candidateIds: string[],
  ): Promise<NativeImportCommitDto> =>
    nativeImportPost('/native-import/commit', { token, candidateIds }),

  eventsUrl: (threadId: string, after = 0): string =>
    `${BASE_PATH}/threads/${encodeURIComponent(threadId)}/events?after=${after}`,
}
