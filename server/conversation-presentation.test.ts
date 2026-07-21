import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activityFailed,
  activitySummary,
  conversationEntries,
  isLongConversationText,
  itemClaudeControlMessage,
  itemTaskNotification,
  latestUsageSummary,
  payloadText,
  tailConversationEntries,
  transcriptItems,
  usageSummary,
} from '../src/features/conversations/conversation-presentation.ts'
import type { CanonicalItemDto, CanonicalTurnDto } from '../src/features/conversations/types.ts'

function item(payload: CanonicalItemDto['payload']): CanonicalItemDto {
  return {
    id: 'item-1',
    sessionId: 'session-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    sequence: 1,
    kind: 'reasoning_summary',
    visibility: 'portable',
    payload,
    provider: 'codex',
    nativeId: null,
    createdAt: '2026-07-18T00:00:00.000Z',
  }
}

test('reasoning summaries are rendered as readable text instead of raw JSON', () => {
  assert.equal(payloadText(item({ summary: ['첫 판단', '검증 완료'] })), '첫 판단\n\n검증 완료')
})

test('legacy native task notifications render their result instead of provider envelopes', () => {
  const raw = [
    '<task-notification>',
    '<task-id>a6bcbb3346afee066</task-id>',
    '<tool-use-id>toolu_01ABC</tool-use-id>',
    '<output-file>C:\\temp\\task.output</output-file>',
    '<status>completed</status>',
    '<summary>Agent "audit" finished</summary>',
    '<note>A task-notification fires each time this agent stops.</note>',
    '<result>Useful audit result.</result>',
    '</task-notification>',
  ].join('\n')
  const legacy = {
    ...item({ text: raw, nativeSourceClient: 'claude_desktop' }),
    kind: 'user_message' as const,
    provider: 'claude' as const,
  }
  assert.equal(payloadText(legacy), 'Useful audit result.')
  assert.equal(itemTaskNotification(legacy)?.summary, 'Agent "audit" finished')

  const userAuthored = { ...legacy, payload: { text: raw } }
  assert.equal(itemTaskNotification(userAuthored), null)
  assert.equal(payloadText(userAuthored), raw)
})

test('legacy Claude command envelopes render as compact control messages without raw tags', () => {
  const raw = '<local-command-stdout>Goal set: finish the report</local-command-stdout>'
  const legacy = {
    ...item({ text: raw, nativeSourceClient: 'claude_desktop' }),
    kind: 'user_message' as const,
    provider: 'claude' as const,
  }
  assert.equal(itemClaudeControlMessage(legacy)?.summary, '목표 설정 완료')
  assert.equal(payloadText(legacy), 'Goal set: finish the report')

  const userAuthored = { ...legacy, payload: { text: raw } }
  assert.equal(itemClaudeControlMessage(userAuthored), null)
  assert.equal(payloadText(userAuthored), raw)
})

test('usage summary mirrors Codex token grouping and accepts app-server camelCase', () => {
  assert.equal(
    usageSummary({
      tokenUsage: {
        last: {
          inputTokens: 1_200,
          cachedInputTokens: 200,
          outputTokens: 300,
          reasoningOutputTokens: 100,
        },
      },
    }),
    '합계 1,300 · 입력 1,000 · 캐시 200 · 출력 300 · 추론 100',
  )
})

test('usage stays canonical but is summarized once outside the transcript', () => {
  const assistant = { ...item({ text: 'answer' }), kind: 'assistant_message' as const }
  const usage = { ...item({ inputTokens: 10, outputTokens: 2 }), id: 'usage-1', kind: 'usage' as const }
  const turn: CanonicalTurnDto = {
    id: 'turn-1',
    threadId: 'thread-1',
    goalId: null,
    goalRevision: null,
    sequence: 1,
    provider: 'codex',
    model: 'gpt-test',
    effort: null,
    status: 'completed',
    clientRequestId: 'request-1',
    startedAt: '2026-07-18T00:00:00.000Z',
    completedAt: '2026-07-18T00:00:01.000Z',
    usage: { inputTokens: 10, outputTokens: 2 },
    error: null,
  }

  assert.deepEqual(transcriptItems([assistant, usage]), [assistant])
  assert.equal(latestUsageSummary([turn]), '합계 12 · 입력 10 · 출력 2')
})

test('internal Goal continuation stays canonical without appearing as a user chat message', () => {
  const internal = {
    ...item({
      goalContinuation: true,
      text: 'Continue working toward the active conversation Goal.',
    }),
    id: 'goal-continuation',
    kind: 'user_message' as const,
    visibility: 'baton_private' as const,
  }
  const user = {
    ...item({ text: '계속 진행해 주세요.' }),
    id: 'user-message',
    kind: 'user_message' as const,
  }

  assert.deepEqual(transcriptItems([internal, user]), [user])
  assert.deepEqual(conversationEntries([internal, user]).map((entry) => entry.item), [user])
})

test('tool calls and results become one compact transcript entry', () => {
  const call = {
    ...item({ callId: 'tool-1', name: 'read_file', arguments: { path: 'src/App.tsx' } }),
    id: 'call',
    kind: 'tool_call' as const,
  }
  const result = {
    ...item({ callId: 'tool-1', content: 'large raw output' }),
    id: 'result',
    kind: 'tool_result' as const,
  }
  const entries = conversationEntries([call, result])
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.toolResult?.id, 'result')
  assert.equal(activitySummary(call, result), '읽기 · src/App.tsx · 완료')
})

test('large transcripts render a bounded tail while retaining an explicit hidden count', () => {
  const entries = conversationEntries([
    { ...item({ text: 'one' }), id: 'one', kind: 'assistant_message' },
    { ...item({ text: 'two' }), id: 'two', kind: 'assistant_message' },
    { ...item({ text: 'three' }), id: 'three', kind: 'assistant_message' },
  ])

  assert.deepEqual(tailConversationEntries(entries, 2), {
    entries: entries.slice(1),
    hiddenCount: 1,
  })
  assert.deepEqual(tailConversationEntries(entries, 20), { entries, hiddenCount: 0 })
})

test('nested canonical tool results preserve success and failure presentation', () => {
  const call = {
    ...item({ callId: 'tool-1', name: 'write_file', input: { path: 'src/App.tsx' } }),
    kind: 'tool_call' as const,
  }
  const failed = {
    ...item({
      callId: 'tool-1',
      result: { success: false, content: {}, error: { code: 'tool_timeout', message: 'timed out' } },
    }),
    kind: 'tool_result' as const,
  }
  const succeeded = {
    ...item({ callId: 'tool-1', result: { success: true, content: {}, error: null } }),
    kind: 'tool_result' as const,
  }

  assert.equal(activityFailed(failed), true)
  assert.equal(activitySummary(call, failed), '편집 · src/App.tsx · 실패')
  assert.equal(activityFailed(succeeded), false)
  assert.equal(activitySummary(call, succeeded), '편집 · src/App.tsx · 완료')
})

test('long message detection is deterministic by characters or lines', () => {
  assert.equal(isLongConversationText('short'), false)
  assert.equal(isLongConversationText('x'.repeat(2_401)), true)
  assert.equal(isLongConversationText(Array.from({ length: 25 }, () => 'line').join('\n')), true)
})
