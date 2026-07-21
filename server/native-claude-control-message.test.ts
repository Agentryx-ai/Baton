import assert from 'node:assert/strict'
import test from 'node:test'

import {
  claudeControlMessageContextText,
  claudeControlMessageFromPayload,
  claudeControlMessagePayload,
  parseClaudeControlMessage,
} from '../src/lib/native-claude-control-message.ts'

test('Claude command envelopes become portable Baton control messages', () => {
  const command = parseClaudeControlMessage([
    '<command-name>/goal</command-name>',
    '<command-message>goal</command-message>',
    '<command-args>finish &amp; verify</command-args>',
  ].join('\n'))
  assert.deepEqual(command, {
    version: 1,
    source: 'claude',
    kind: 'command',
    summary: 'Claude 명령 · /goal',
    content: 'finish & verify',
    commandName: '/goal',
  })
  assert.deepEqual(claudeControlMessagePayload(command!), {
    text: 'finish & verify',
    nativeClaudeControlMessage: {
      version: 1,
      source: 'claude',
      kind: 'command',
      summary: 'Claude 명령 · /goal',
      commandName: '/goal',
    },
  })
  assert.equal(claudeControlMessageContextText(command!), '[Claude command /goal]\nfinish & verify')
})

test('Claude local command output and Goal Stop hooks lose their provider prose', () => {
  const output = parseClaudeControlMessage('<local-command-stdout>Login successful</local-command-stdout>')
  assert.equal(output?.summary, 'Claude 명령 결과')
  assert.equal(output?.content, 'Login successful')

  const hook = parseClaudeControlMessage([
    'A session-scoped Stop hook is now active with condition: "finish the report".',
    'Briefly acknowledge the goal, then immediately start working toward it.',
    'The hook will block stopping until the condition holds.',
    'It auto-clears once the condition is met.',
  ].join(' '))
  assert.equal(hook?.kind, 'stop_hook')
  assert.equal(hook?.content, '')
  assert.equal(claudeControlMessageContextText(hook!), '[Claude Goal Stop hook active]')

  const feedback = parseClaudeControlMessage('Stop hook feedback:\n[goal]\nStill incomplete.')
  assert.equal(feedback?.kind, 'stop_hook_feedback')
  assert.equal(feedback?.summary, '목표 Stop hook 피드백')
  assert.doesNotMatch(claudeControlMessageContextText(feedback!) ?? '', /Stop hook feedback:/)

  const caveat = parseClaudeControlMessage(
    '<local-command-caveat>Internal local command warning.</local-command-caveat>',
  )
  assert.equal(caveat?.kind, 'local_command_caveat')
  assert.equal(claudeControlMessageContextText(caveat!), null)
})

test('legacy control-message recognition requires Claude native provenance', () => {
  const raw = '<local-command-stdout>Goal set: finish the report</local-command-stdout>'
  assert.equal(claudeControlMessageFromPayload({ text: raw }), null)
  assert.equal(
    claudeControlMessageFromPayload({ text: raw, nativeSourceClient: 'claude_desktop' })?.summary,
    '목표 설정 완료',
  )
  assert.equal(parseClaudeControlMessage('A session-scoped Stop hook is now active. Ordinary prose.'), null)
  assert.equal(parseClaudeControlMessage(
    'A session-scoped Stop hook is now active with condition: user-authored prose.',
  ), null)
})
