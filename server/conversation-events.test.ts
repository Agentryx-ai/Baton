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

test('live SSE bursts never overlap snapshot refreshes and run one trailing refresh', async () => {
  resetConversationEventCursorsForTest()
  let nextTimer = 0
  const pending = new Map<number, () => void>()
  const flushed: number[] = []
  let active = 0
  let maximumActive = 0
  let releaseFirst!: (refreshed: boolean) => void
  const firstRefresh = new Promise<boolean>((resolve) => { releaseFirst = resolve })
  const batcher = createConversationEventBatcher(
    'thread-1',
    (_event, cursor) => {
      flushed.push(cursor)
      active += 1
      maximumActive = Math.max(maximumActive, active)
      if (flushed.length === 1) return firstRefresh.finally(() => { active -= 1 })
      active -= 1
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

  batcher.push(streamEvent(1), 1)
  const firstTimer = [...pending.entries()][0]
  assert.ok(firstTimer)
  pending.delete(firstTimer[0])
  firstTimer[1]()
  batcher.push(streamEvent(2), 2)
  batcher.push(streamEvent(3), 3)
  assert.equal(pending.size, 0)
  assert.deepEqual(flushed, [1])

  releaseFirst(true)
  await firstRefresh
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(pending.size, 1)
  const trailingTimer = [...pending.entries()][0]
  assert.ok(trailingTimer)
  pending.delete(trailingTimer[0])
  trailingTimer[1]()

  assert.deepEqual(flushed, [1, 3])
  assert.equal(maximumActive, 1)
  assert.equal(rememberedConversationEventCursor('thread-1'), 3)
  batcher.cancel()
})
