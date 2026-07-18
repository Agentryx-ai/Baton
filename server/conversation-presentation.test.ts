import assert from 'node:assert/strict'
import test from 'node:test'

import {
  latestUsageSummary,
  payloadText,
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
    sequence: 1,
    provider: 'codex',
    model: 'gpt-test',
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
