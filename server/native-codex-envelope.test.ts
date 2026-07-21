import assert from 'node:assert/strict'
import test from 'node:test'

import {
  codexEnvelopeContextText,
  codexEnvelopeFromPayload,
  codexEnvelopePayload,
  parseCodexEnvelope,
} from '../src/lib/native-codex-envelope.ts'

test('Codex internal contexts are hidden only with native provenance', () => {
  const raw = '<environment_context>\n  <cwd>C:\\work</cwd>\n</environment_context>'
  const parsed = parseCodexEnvelope(raw)
  assert.equal(parsed?.presentation, 'hidden')
  assert.equal(codexEnvelopeContextText(parsed!), null)
  assert.equal(codexEnvelopeFromPayload({ text: raw }), null)
  assert.equal(codexEnvelopeFromPayload({ text: raw, nativeSourceClient: 'codex_local' })?.kind, 'internal_context')
})

test('Codex delegations and shell commands become portable Baton cards', () => {
  const delegation = parseCodexEnvelope([
    '<codex_delegation>',
    '<source_thread_id>thread-1</source_thread_id>',
    '<input>Audit &amp; report.</input>',
    '</codex_delegation>',
  ].join('\n'))
  assert.deepEqual(delegation, {
    version: 1, source: 'codex', kind: 'delegation', presentation: 'card',
    summary: '하위 작업 배정', content: 'Audit & report.', sourceThreadId: 'thread-1',
  })
  assert.equal(codexEnvelopeContextText(delegation!), '[하위 작업 배정 from thread-1]\nAudit & report.')
  assert.equal(JSON.stringify(codexEnvelopePayload(delegation!)).includes('codex_delegation'), false)

  const shell = parseCodexEnvelope([
    '<user_shell_command>', '<command>npm test</command>',
    '<result>Exit code: 0</result>', '</user_shell_command>',
  ].join('\n'))
  assert.equal(shell?.summary, '사용자 셸 명령')
  assert.equal(shell?.content, '$ npm test\n\nExit code: 0')
})

test('ambient browser context retains only the actual user request', () => {
  const parsed = parseCodexEnvelope([
    '<in-app-browser-context source="ambient-ui-state">internal tabs</in-app-browser-context>',
    '', '## My request for Codex:', 'Search this error code.',
  ].join('\n'))
  assert.equal(parsed?.presentation, 'message')
  assert.equal(parsed?.content, 'Search this error code.')
  assert.equal(codexEnvelopeContextText(parsed!), 'Search this error code.')
})

test('turn aborts become lifecycle cards and subagent shutdown bookkeeping is hidden', () => {
  const aborted = parseCodexEnvelope('<turn_aborted>User interrupted the turn.</turn_aborted>')
  assert.equal(aborted?.presentation, 'card')
  assert.equal(aborted?.summary, '이전 턴 중단됨')
  const shutdown = parseCodexEnvelope([
    '<subagent_notification>', '{"agent_path":"child","status":"shutdown"}', '</subagent_notification>',
  ].join('\n'))
  assert.equal(shutdown?.presentation, 'hidden')
})
