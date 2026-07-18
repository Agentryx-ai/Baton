import assert from 'node:assert/strict'
import test from 'node:test'

import { conversationApi } from '../src/features/conversations/api.ts'

const itemModulePath: string = '../src/features/conversations/ConversationItem.tsx'
const workspaceModulePath: string = '../src/features/conversations/ConversationWorkspace.tsx'

test('assistant model labels preserve catalog names and provider version punctuation', async () => {
  const { friendlyModel, assistantExecutionMetadata } = await import(itemModulePath) as {
    friendlyModel: (model: string, names?: Readonly<Record<string, string>>) => string
    assistantExecutionMetadata: (
      item: { payload: Record<string, unknown> },
      turn: { model: string; effort: string | null } | null,
    ) => { requestedModel: string | null; effort: string | null }
  }
  assert.equal(friendlyModel('gpt-5.6-sol'), 'GPT-5.6 Sol')
  assert.equal(friendlyModel('claude-opus-4-8-20260719'), 'Opus 4.8')
  assert.equal(friendlyModel('gpt-custom', { 'gpt-custom': 'GPT Custom Display' }), 'GPT Custom Display')
  assert.deepEqual(assistantExecutionMetadata(
    { payload: { text: 'legacy Codex response' } },
    { model: 'gpt-5.6-sol', effort: 'high' },
  ), { requestedModel: 'gpt-5.6-sol', effort: 'high' })
  assert.deepEqual(assistantExecutionMetadata(
    { payload: { requestedModel: 'gpt-live', effort: 'xhigh' } },
    { model: 'gpt-fallback', effort: 'low' },
  ), { requestedModel: 'gpt-live', effort: 'xhigh' })
})

test('conversation header and sidebar share every canonical work status presentation', async () => {
  const { SESSION_STATUS, sessionStatusPresentation } = await import(workspaceModulePath) as {
    SESSION_STATUS: Record<string, { label: string; dot: string }>
    sessionStatusPresentation: (status: unknown) => { label: string; dot: string }
  }
  for (const status of [
    'idle', 'queued', 'running', 'waiting_tool', 'paused', 'blocked', 'usage_limited',
    'budget_limited', 'failed', 'interrupted', 'cancelled', 'completed', 'complete', 'imported', 'archived',
  ]) {
    assert.ok(SESSION_STATUS[status]?.label)
    assert.ok(SESSION_STATUS[status]?.dot)
  }
  assert.deepEqual(sessionStatusPresentation(undefined), SESSION_STATUS.idle)
  assert.deepEqual(sessionStatusPresentation('future_status'), SESSION_STATUS.idle)
})

test('stale Goal status mutations are surfaced as explicit conflicts', async () => {
  const { requireAppliedGoalStatus } = await import(workspaceModulePath) as {
    requireAppliedGoalStatus: (result: { status: 'applied' | 'stale' }) => void
  }
  assert.doesNotThrow(() => requireAppliedGoalStatus({ status: 'applied' }))
  assert.throws(
    () => requireAppliedGoalStatus({ status: 'stale' }),
    /Goal 상태가 다른 실행에서 변경되었습니다/,
  )
})

test('Goal edit copy reflects whether execution state is retained or restarted', async () => {
  const { goalEditDescription } = await import(workspaceModulePath) as {
    goalEditDescription: (status: 'active' | 'paused' | 'complete' | 'budget_limited') => string
  }
  assert.match(goalEditDescription('active'), /진행 상태.*유지/)
  assert.match(goalEditDescription('paused'), /정지 상태.*유지/)
  assert.match(goalEditDescription('complete'), /다시 시작/)
  assert.match(goalEditDescription('budget_limited'), /먼저 Goal을 다시 시작/)
})

test('thread refresh replaces only the matching sidebar session projection', async () => {
  const { replaceSessionProjection } = await import(workspaceModulePath) as {
    replaceSessionProjection: (
      sessions: Array<{ id: string; workStatus: string }> | null,
      projection: { id: string; workStatus: string },
    ) => Array<{ id: string; workStatus: string }> | null
  }
  const original = [
    { id: 'selected', workStatus: 'idle' },
    { id: 'other', workStatus: 'imported' },
  ]
  assert.deepEqual(replaceSessionProjection(original, {
    id: 'selected',
    workStatus: 'waiting_tool',
  }), [
    { id: 'selected', workStatus: 'waiting_tool' },
    { id: 'other', workStatus: 'imported' },
  ])
  assert.equal(replaceSessionProjection(null, { id: 'selected', workStatus: 'running' }), null)
})

test('background session projection polling runs only while visible and cleans up listeners', async () => {
  const { installSessionProjectionPolling } = await import(workspaceModulePath) as {
    installSessionProjectionPolling: (
      refresh: () => void,
      host: unknown,
      visibilityHost: unknown,
      intervalMs?: number,
    ) => () => void
  }
  let visibilityState: 'visible' | 'hidden' = 'visible'
  let interval: (() => void) | null = null
  const windowListeners = new Map<string, () => void>()
  const documentListeners = new Map<string, () => void>()
  let refreshes = 0
  let cleared = false
  const host = {
    setInterval(callback: () => void, delayMs: number) {
      assert.equal(delayMs, 10_000)
      interval = callback
      return 7
    },
    clearInterval(handle: number) {
      assert.equal(handle, 7)
      cleared = true
    },
    addEventListener(type: string, listener: () => void) { windowListeners.set(type, listener) },
    removeEventListener(type: string, listener: () => void) {
      if (windowListeners.get(type) === listener) windowListeners.delete(type)
    },
  }
  const visibilityHost = {
    get visibilityState() { return visibilityState },
    addEventListener(type: string, listener: () => void) { documentListeners.set(type, listener) },
    removeEventListener(type: string, listener: () => void) {
      if (documentListeners.get(type) === listener) documentListeners.delete(type)
    },
  }

  const dispose = installSessionProjectionPolling(() => { refreshes += 1 }, host, visibilityHost)
  assert.ok(interval)
  ;(interval as () => void)()
  assert.equal(refreshes, 1)
  visibilityState = 'hidden'
  ;(interval as () => void)()
  windowListeners.get('focus')?.()
  assert.equal(refreshes, 1)
  visibilityState = 'visible'
  documentListeners.get('visibilitychange')?.()
  assert.equal(refreshes, 2)

  dispose()
  assert.equal(cleared, true)
  assert.equal(windowListeners.size, 0)
  assert.equal(documentListeners.size, 0)
})

test('unknown mutation detection requires an interrupted unknown-outcome turn and no tool result', async () => {
  const { unresolvedUnknownMutations } = await import(workspaceModulePath) as {
    unresolvedUnknownMutations: (snapshot: unknown) => Array<{ turnId: string; callId: string; toolName: string }>
  }
  const turn = { id: 'turn-1', status: 'interrupted', error: { code: 'unknown_mutation_outcome' } }
  const call = (callId: string, sideEffect: string, turnId = 'turn-1') => ({
    kind: 'tool_call', turnId, payload: { callId, name: 'write_file', sideEffect },
  })
  const snapshot = {
    turns: [turn, { id: 'turn-2', status: 'interrupted', error: { code: 'runtime_interrupted' } }],
    items: [
      call('unknown', 'workspace_mutation'),
      call('read', 'read_only'),
      call('resolved', 'workspace_command'),
      call('other-turn', 'workspace_mutation', 'turn-2'),
      { kind: 'tool_result', turnId: 'turn-1', payload: { callId: 'resolved' } },
      { kind: 'tool_result', turnId: 'turn-2', payload: { callId: 'unknown' } },
    ],
  }
  assert.deepEqual(unresolvedUnknownMutations(snapshot), [{
    turnId: 'turn-1', callId: 'unknown', toolName: 'write_file', sideEffect: 'workspace_mutation',
  }])
})

test('unknown mutation reconciliation sends the explicit user resolution without replaying a tool', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; body: unknown }> = []
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
    return Response.json({ item: {}, duplicate: false })
  }) as typeof fetch
  try {
    await conversationApi.reconcileUnknownMutation('turn/1', {
      callId: 'call-1', resolution: 'unknown_acknowledged', note: '외부 상태를 확인함',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(calls, [{
    url: '/baton/v1/turns/turn%2F1/reconcile-tool',
    body: { callId: 'call-1', resolution: 'unknown_acknowledged', note: '외부 상태를 확인함' },
  }])
})

test('follow-up presentation preserves FIFO and exposes cancellation only while queued', async () => {
  const { composerSubmissionKind, followUpPresentation, pendingFollowUps, followUpText } = await import(workspaceModulePath) as {
    composerSubmissionKind: (prompt: string, goalMode: boolean, activeTurnId: string | null) => string
    followUpPresentation: (
      followUp: { status: string; targetTurnId: string | null; delivery: string },
      activeTurnId: string | null,
    ) => { label: string; cancellable: boolean }
    pendingFollowUps: (followUps: Array<Record<string, unknown>>) => Array<Record<string, unknown>>
    followUpText: (followUp: { input: Array<{ payload: Record<string, unknown> }> }) => string
  }
  assert.deepEqual(followUpPresentation({
    status: 'dispatching', targetTurnId: 'turn-1', delivery: 'steer_or_queue',
  }, 'turn-1'), { label: '현재 턴 전달 중', tone: 'info', cancellable: false })
  assert.deepEqual(followUpPresentation({
    status: 'queued', targetTurnId: null, delivery: 'next_turn',
  }, 'turn-1'), { label: '다음 턴 대기', tone: 'muted', cancellable: true })
  assert.equal(followUpPresentation({
    status: 'delivery_unknown', targetTurnId: 'turn-1', delivery: 'steer_or_queue',
  }, 'turn-1').label, '전달 확인 필요')
  assert.equal(followUpPresentation({
    status: 'stale_goal', targetTurnId: null, delivery: 'next_turn',
  }, null).cancellable, false)

  const pending = pendingFollowUps([
    { id: 'later', sequence: 2, status: 'queued' },
    { id: 'done', sequence: 3, status: 'consumed' },
    { id: 'first', sequence: 1, status: 'delivery_unknown' },
    { id: 'cancelled', sequence: 4, status: 'cancelled' },
  ])
  assert.deepEqual(pending.map((followUp) => followUp.id), ['first', 'later'])
  assert.equal(followUpText({ input: [{ payload: { text: '추가 제약' } }] }), '추가 제약')
  assert.equal(composerSubmissionKind('일반 추가 요청', false, 'turn-1'), 'follow_up')
  assert.equal(composerSubmissionKind('/goal pause', false, 'turn-1'), 'goal')
  assert.equal(composerSubmissionKind('새 목표', true, 'turn-1'), 'goal')
  assert.equal(composerSubmissionKind('새 요청', false, null), 'turn')
})

test('follow-up API sends the fixed enqueue and revision-CAS cancel bodies', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; method: string | undefined; body: unknown }> = []
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return Response.json({ followUp: { id: 'follow-up-1' }, duplicate: false })
  }) as typeof fetch
  try {
    await conversationApi.enqueueFollowUp('thread/1', {
      clientRequestId: 'request-1',
      expectedTurnId: 'turn-1',
      delivery: 'steer_or_queue',
      input: [{ kind: 'user_message', visibility: 'portable', payload: { text: 'continue' } }],
    })
    await conversationApi.cancelFollowUp('follow-up/1', 7)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(calls, [
    {
      url: '/baton/v1/threads/thread%2F1/follow-ups',
      method: 'POST',
      body: {
        clientRequestId: 'request-1',
        expectedTurnId: 'turn-1',
        delivery: 'steer_or_queue',
        input: [{ kind: 'user_message', visibility: 'portable', payload: { text: 'continue' } }],
      },
    },
    {
      url: '/baton/v1/follow-ups/follow-up%2F1',
      method: 'DELETE',
      body: { expectedRevision: 7 },
    },
  ])
})
