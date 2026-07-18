import assert from 'node:assert/strict'
import test from 'node:test'

import {
  payloadText,
  usageSummary,
} from '../src/features/conversations/conversation-presentation.ts'
import type { CanonicalItemDto } from '../src/features/conversations/types.ts'

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
