import assert from 'node:assert/strict'
import test from 'node:test'

import { clientIntegrationAction } from '../src/components/client-integration-action.ts'
import type { ClientIntegrationTargetStatus } from '../src/api/types.ts'

function status(
  configuration: ClientIntegrationTargetStatus['configuration'],
  options: { repairable?: boolean; certainlyStopped?: boolean } = {},
): ClientIntegrationTargetStatus {
  return {
    target: 'codex',
    label: 'Codex CLI/Desktop',
    running: [],
    configuration,
    certainlyStopped: options.certainlyStopped ?? true,
    ...(options.repairable === undefined ? {} : { repairable: options.repairable }),
  }
}

test('client integration UI exposes only explicitly repairable conflicts', () => {
  assert.deepEqual(clientIntegrationAction(status('conflict', { repairable: true })), {
    actionable: true,
    label: '설정 복구',
  })
  assert.deepEqual(clientIntegrationAction(status('conflict')), {
    actionable: false,
    label: '조치 불가',
  })
  assert.deepEqual(clientIntegrationAction({
    ...status('conflict', { repairable: true }),
    target: 'claude-cli',
  }), {
    actionable: false,
    label: '조치 불가',
  })
  assert.deepEqual(clientIntegrationAction(status('conflict', {
    repairable: true,
    certainlyStopped: false,
  })), {
    actionable: false,
    label: '종료 후 복구',
  })
})

test('client integration UI preserves apply, remove, and unknown states', () => {
  assert.deepEqual(clientIntegrationAction(status('applied')), {
    actionable: true,
    label: '설정 해제',
  })
  assert.deepEqual(clientIntegrationAction(status('not-applied')), {
    actionable: true,
    label: '설정 적용',
  })
  assert.deepEqual(clientIntegrationAction(status('unknown')), {
    actionable: false,
    label: '조치 불가',
  })
  assert.deepEqual(clientIntegrationAction(undefined), {
    actionable: false,
    label: '확인 중…',
  })
})
