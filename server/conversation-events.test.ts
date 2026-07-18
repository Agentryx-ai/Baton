import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createConversationEventBatcher,
  rememberedConversationEventCursor,
  resetConversationEventCursorsForTest,
} from '../src/features/conversations/useConversationEvents.ts'
import type { CanonicalStreamEventDto } from '../src/features/conversations/types.ts'

function streamEvent(sequence: number): CanonicalStreamEventDto {
  return {
    sequence,
    sessionId: 'session-1',
    threadId: 'thread-1',
    turnId: null,
    type: 'items_appended',
    payload: {},
    createdAt: '2026-07-19T00:00:00.000Z',
  }
}

test('historical SSE replay coalesces to one snapshot refresh and remembers its cursor', () => {
  resetConversationEventCursorsForTest()
  let nextTimer = 0
  const pending = new Map<number, () => void>()
  const flushed: number[] = []
  const batcher = createConversationEventBatcher(
    'thread-1',
    (_event, cursor) => {
      flushed.push(cursor)
      return true
    },
    75,
    (callback) => {
      const timer = ++nextTimer
      pending.set(timer, callback)
      return timer as unknown as ReturnType<typeof setTimeout>
    },
    (timer) => pending.delete(timer as unknown as number),
  )

  for (let sequence = 1; sequence <= 1_000; sequence += 1) {
    batcher.push(streamEvent(sequence), sequence)
  }
  assert.equal(pending.size, 1)
  for (const callback of pending.values()) callback()
  assert.deepEqual(flushed, [1_000])
  assert.equal(rememberedConversationEventCursor('thread-1'), 1_000)

  batcher.push(streamEvent(999), 999)
  assert.deepEqual(flushed, [1_000])
  batcher.cancel()
})
