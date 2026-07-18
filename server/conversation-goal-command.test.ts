import assert from 'node:assert/strict'
import test from 'node:test'

import { parseGoalComposerCommand } from '../src/features/conversations/goal-command.ts'

test('goal command requires an exact command boundary', () => {
  assert.deepEqual(parseGoalComposerCommand('/goal'), { type: 'open' })
  assert.deepEqual(parseGoalComposerCommand('/goal   '), { type: 'open' })
  assert.equal(parseGoalComposerCommand('/goalkeeper'), null)
  assert.equal(parseGoalComposerCommand(' /goal work'), null)
})

test('goal command accepts Unicode whitespace, multiline objectives, and controls', () => {
  assert.deepEqual(parseGoalComposerCommand('/goal\nship it\nwith tests'), {
    type: 'set',
    objective: 'ship it\nwith tests',
  })
  assert.deepEqual(parseGoalComposerCommand('/goal\u3000목표'), { type: 'set', objective: '목표' })
  assert.deepEqual(parseGoalComposerCommand('/goal PAUSE'), { type: 'pause' })
  assert.deepEqual(parseGoalComposerCommand('/goal resume'), { type: 'resume' })
  assert.deepEqual(parseGoalComposerCommand('/goal edit'), { type: 'edit' })
  assert.deepEqual(parseGoalComposerCommand('/goal clear'), { type: 'clear' })
})
