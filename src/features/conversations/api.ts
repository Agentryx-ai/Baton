import type {
  BeginTurnResultDto,
  CanonicalItemDto,
  CanonicalGoalDto,
  CanonicalSessionDto,
  CreateSessionDto,
  CreateGoalDto,
  EditGoalDto,
  StartTurnDto,
  ThreadSnapshotDto,
  ProviderModelDescriptorDto,
  CodexNativeScanFilter,
  NativeImportCommitDto,
  NativeImportPreviewDto,
  NativeImportSourceClient,
  ReconcileUnknownMutationDto,
  ReconcileUnknownMutationResultDto,
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

function jsonRequest(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', body: unknown, headers: Record<string, string> = {}): RequestInit {
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

  listSessions: async (scope: 'active' | 'trash' = 'active'): Promise<CanonicalSessionDto[]> => {
    const result = await request<{ sessions: CanonicalSessionDto[] }>(`/sessions?scope=${scope}`)
    return result.sessions
  },

  createSession: (input: CreateSessionDto): Promise<CanonicalSessionDto> =>
    request('/sessions', jsonRequest('POST', input)),

  archiveSession: (sessionId: string): Promise<CanonicalSessionDto> =>
    request(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),

  restoreSession: (sessionId: string): Promise<CanonicalSessionDto> =>
    request(`/sessions/${encodeURIComponent(sessionId)}/restore`, jsonRequest('POST', {})),

  connectWorkspace: (sessionId: string, cwd: string, expectedRevision: number): Promise<CanonicalSessionDto> =>
    request(`/sessions/${encodeURIComponent(sessionId)}/workspace`, jsonRequest('PUT', { cwd, expectedRevision })),

  disconnectWorkspace: (sessionId: string, expectedRevision: number): Promise<CanonicalSessionDto> =>
    request(`/sessions/${encodeURIComponent(sessionId)}/workspace`, jsonRequest('DELETE', { expectedRevision })),

  getThread: (threadId: string): Promise<ThreadSnapshotDto> =>
    request(`/threads/${encodeURIComponent(threadId)}`),

  getGoal: async (threadId: string): Promise<CanonicalGoalDto | null> => {
    const result = await request<{ goal: CanonicalGoalDto | null }>(`/threads/${encodeURIComponent(threadId)}/goal`)
    return result.goal
  },

  createGoal: (threadId: string, input: CreateGoalDto): Promise<CanonicalGoalDto> =>
    request(`/threads/${encodeURIComponent(threadId)}/goal`, jsonRequest('POST', input)),

  editGoal: (goalId: string, input: EditGoalDto): Promise<CanonicalGoalDto> =>
    request(`/goals/${encodeURIComponent(goalId)}`, jsonRequest('PATCH', input)),

  setGoalStatus: (
    goalId: string,
    input: { expectedRevision: number; status: 'active' | 'paused'; resetLimitCounters?: boolean },
  ): Promise<{ status: 'applied' | 'stale'; goal: CanonicalGoalDto | null }> =>
    request(`/goals/${encodeURIComponent(goalId)}/status`, jsonRequest('POST', input)),

  clearGoal: (goalId: string, expectedRevision: number): Promise<void> =>
    request(`/goals/${encodeURIComponent(goalId)}?expectedRevision=${expectedRevision}`, { method: 'DELETE' }),

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

  reconcileUnknownMutation: (
    turnId: string,
    input: ReconcileUnknownMutationDto,
  ): Promise<ReconcileUnknownMutationResultDto> =>
    request(`/turns/${encodeURIComponent(turnId)}/reconcile-tool`, jsonRequest('POST', input)),

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
