import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseClaudeTaskNotification,
  parseCodexTaskNotification,
  taskNotificationContextText,
  taskNotificationFromPayload,
  taskNotificationPayload,
} from '../src/lib/native-task-notification.ts'

const CLAUDE_NOTIFICATION = `<task-notification>
<task-id>a6bcbb3346afee066</task-id>
<tool-use-id>toolu_01ABC</tool-use-id>
<output-file>C:\\temp\\task.output</output-file>
<status>completed</status>
<summary>Agent "evidence audit" finished</summary>
<note>A task-notification fires each time this agent stops.</note>
<result>first line

## Finding

Result with <literal> markup.</result>
</task-notification>`

test('Claude task notifications become a portable Baton event without internal envelope metadata', () => {
  const notification = parseClaudeTaskNotification(CLAUDE_NOTIFICATION)
  assert.deepEqual(notification, {
    version: 1,
    source: 'claude',
    status: 'completed',
    summary: 'Agent "evidence audit" finished',
    result: 'first line\n\n## Finding\n\nResult with <literal> markup.',
    taskId: 'a6bcbb3346afee066',
    toolUseId: 'toolu_01ABC',
    messageType: null,
  })
  assert.equal(taskNotificationContextText(notification!), [
    '[Background agent completed: Agent "evidence audit" finished]',
    'first line',
    '',
    '## Finding',
    '',
    'Result with <literal> markup.',
  ].join('\n'))
  const payload = taskNotificationPayload(notification!)
  assert.equal(payload.text, notification?.result)
  assert.equal(JSON.stringify(payload).includes('output-file'), false)
  assert.equal(Object.hasOwn(payload.nativeTaskNotification as object, 'result'), false)
})

test('Codex collaboration messages share the Baton task notification contract', () => {
  const notification = parseCodexTaskNotification([
    'Message Type: FINAL_ANSWER',
    'Task name: /root/audit',
    'Sender: /root/audit',
    'Payload:',
    'Audit passed.',
  ].join('\n'))
  assert.deepEqual(notification, {
    version: 1,
    source: 'codex',
    status: 'completed',
    summary: '/root/audit finished',
    result: 'Audit passed.',
    taskId: '/root/audit',
    toolUseId: null,
    messageType: 'FINAL_ANSWER',
  })
})

test('legacy imports require native provenance before interpreting notification-like user text', () => {
  assert.equal(taskNotificationFromPayload({ text: CLAUDE_NOTIFICATION }), null)
  assert.equal(
    taskNotificationFromPayload({ text: CLAUDE_NOTIFICATION, nativeSourceClient: 'claude_desktop' })?.taskId,
    'a6bcbb3346afee066',
  )
  const olderTaskId = CLAUDE_NOTIFICATION.replace('a6bcbb3346afee066', 'a12bc3456')
  assert.equal(
    taskNotificationFromPayload({ text: olderTaskId, nativeSourceClient: 'claude_code' })?.taskId,
    'a12bc3456',
  )
  const copiedByUser = CLAUDE_NOTIFICATION.replace('a6bcbb3346afee066', 'task-1')
  assert.equal(taskNotificationFromPayload({ text: copiedByUser, nativeSourceClient: 'claude_desktop' }), null)
  assert.equal(parseClaudeTaskNotification('<task-notification>user prose</task-notification>'), null)
  assert.equal(parseCodexTaskNotification('Message Type: FINAL_ANSWER\nordinary prose'), null)
})
