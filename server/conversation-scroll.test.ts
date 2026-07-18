import assert from 'node:assert/strict'
import test from 'node:test'

import { isNearScrollBottom } from '../src/features/conversations/conversation-scroll.ts'

test('live output follows only while the reader remains near the bottom', () => {
  assert.equal(isNearScrollBottom({ scrollHeight: 1_000, scrollTop: 404, clientHeight: 500 }), true)
  assert.equal(isNearScrollBottom({ scrollHeight: 1_000, scrollTop: 300, clientHeight: 500 }), false)
})
