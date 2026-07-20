import assert from 'node:assert/strict'
import test from 'node:test'

import {
  codexToolCallSucceeded, NativeGoalReconstructor, parseClaudeGoalCommand,
  parseClaudeGoalConfirmation, parseCodexGoalToolAction, parseExplicitGoalCommand,
} from './goal-reconstruction.ts'

test('only an exact slash command is treated as a Goal mutation', () => {
  assert.deepEqual(parseExplicitGoalCommand('/goal finish the audit'), { kind: 'set', objective: 'finish the audit' })
  assert.deepEqual(parseExplicitGoalCommand('  /goal clear  '), { kind: 'clear' })
  assert.equal(parseExplicitGoalCommand('Please run /goal finish the audit'), null)
  assert.equal(parseExplicitGoalCommand('`/goal finish the audit`'), null)
  assert.equal(parseExplicitGoalCommand('/goal'), null)
})

test('Claude structured commands and confirmations preserve multiline objectives', () => {
  assert.deepEqual(parseClaudeGoalCommand(
    '<command-name>/goal</command-name>\n<command-args>first &amp; second\nline</command-args>',
  ), { kind: 'set', objective: 'first & second\nline' })
  assert.deepEqual(parseClaudeGoalConfirmation(
    '<local-command-stdout>Goal set: first\nsecond</local-command-stdout>',
  ), { kind: 'set', objective: 'first\nsecond' })
  assert.deepEqual(parseClaudeGoalConfirmation(
    '<local-command-stdout>Goal cleared: old objective</local-command-stdout>',
  ), { kind: 'clear' })
})

test('Codex Goal tools accept literal objectives and ignore failed calls', () => {
  assert.deepEqual(parseCodexGoalToolAction(
    'const goal = await tools.create_goal({ objective: "ship \\n safely" }); text(goal)',
  ), { kind: 'set', objective: 'ship \n safely' })
  assert.deepEqual(parseCodexGoalToolAction(
    "await tools.create_goal({objective: 'single quoted'})",
  ), { kind: 'set', objective: 'single quoted' })
  assert.deepEqual(parseCodexGoalToolAction(
    'await tools.update_goal({status: "complete"})',
  ), { kind: 'complete' })
  assert.equal(parseCodexGoalToolAction('await tools.create_goal({objective})'), null)
  assert.equal(parseCodexGoalToolAction('await tools.create_goal({objective: `dynamic ${objective}`})'), null)
  assert.deepEqual(parseCodexGoalToolAction(
    'const unrelated = {objective: "wrong"}; await tools.create_goal({objective: "right"})',
  ), { kind: 'set', objective: 'right' })
  assert.equal(codexToolCallSucceeded('Script completed\nOutput:\nok'), true)
  assert.equal(codexToolCallSucceeded('Script failed\nScript error:\ncannot create a new goal'), false)
})

test('latest explicit unresolved Goal wins and completion clears it', () => {
  const tracker = new NativeGoalReconstructor()
  tracker.set('first', '2026-07-18T00:00:00Z', 'slash_command')
  tracker.set('second', '2026-07-18T00:00:01Z', 'codex_goal_tool')
  assert.equal(tracker.snapshot('codex', 'gpt-5.6-sol', 'high')?.objective, 'second')
  tracker.clear()
  assert.equal(tracker.snapshot('codex', 'gpt-5.6-sol', 'high'), null)
})
