import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatGoalDuration,
  formatGoalReason,
  formatGoalTokens,
  formatGoalTurns,
  goalRemainingTokens,
  goalStatusPresentation,
} from '../src/features/conversations/goal-presentation.ts'

test('goal statuses have stable labels and semantic tones', () => {
  assert.deepEqual(goalStatusPresentation('active'), { label: '진행 중', tone: 'active' })
  assert.deepEqual(goalStatusPresentation('paused'), { label: '일시 정지', tone: 'muted' })
  assert.deepEqual(goalStatusPresentation('blocked'), { label: '확인 필요', tone: 'warning' })
  assert.deepEqual(goalStatusPresentation('usage_limited'), { label: '사용량 제한', tone: 'warning' })
  assert.deepEqual(goalStatusPresentation('budget_limited'), { label: '예산 제한', tone: 'warning' })
  assert.deepEqual(goalStatusPresentation('complete'), { label: '완료', tone: 'success' })
})

test('goal duration and turn counters are formatted deterministically', () => {
  assert.equal(formatGoalDuration(0), '0초')
  assert.equal(formatGoalDuration(61.9), '1분 1초')
  assert.equal(formatGoalDuration(7_260), '2시간 1분')
  assert.equal(formatGoalDuration(Number.NaN), '0초')
  assert.equal(formatGoalTurns(3, 24), '3 / 24회')
  assert.equal(formatGoalTurns(-1, 12.8), '0 / 12회')
})

test('goal tokens show used and remaining budget without allowing negative remaining', () => {
  assert.equal(formatGoalTokens(1_234, null), '1,234 토큰 · 예산 없음')
  assert.equal(formatGoalTokens(1_234, 5_000), '1,234 토큰 · 3,766 남음')
  assert.equal(formatGoalTokens(6_000, 5_000), '6,000 토큰 · 0 남음')
  assert.equal(goalRemainingTokens(1_234, 5_000), 3_766)
  assert.equal(goalRemainingTokens(1_234, null), null)
})

test('goal reason prefers sanitized display text and falls back to a stable label', () => {
  assert.equal(formatGoalReason(null), null)
  assert.equal(formatGoalReason({
    code: 'no_progress',
    source: 'host',
    message: null,
    at: '2026-07-19T00:00:00.000Z',
  }), '진전이 없어 멈췄습니다.')
  assert.equal(formatGoalReason({
    code: 'custom_reason',
    source: 'provider',
    message: '  계정 상태를 확인해 주세요.  ',
    at: '2026-07-19T00:00:00.000Z',
  }), '계정 상태를 확인해 주세요.')
  assert.equal(formatGoalReason({
    code: 'custom_reason',
    source: 'model',
    message: '   ',
    at: '2026-07-19T00:00:00.000Z',
  }), '계속하려면 상태를 확인해 주세요.')
})
