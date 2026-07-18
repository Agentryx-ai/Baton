import assert from 'node:assert/strict'
import test from 'node:test'

import type { GatewayAccount } from './gateway-client.ts'
import { selectTargetAndReserve } from './policy-engine.ts'

function account(id: string): GatewayAccount {
  return {
    id,
    provider: 'claude',
    isDefault: false,
    email: `${id}@example.com`,
    nickname: id,
  }
}

test('selectTargetAndReserve supports zero, one, and multiple ranked accounts', () => {
  const first = account('first')
  const second = account('second')
  const third = account('third')

  assert.deepEqual(selectTargetAndReserve([]), { target: null, reserve: null })
  assert.deepEqual(selectTargetAndReserve([first]), { target: first, reserve: null })
  assert.deepEqual(selectTargetAndReserve([first, second, third]), {
    target: first,
    reserve: second,
  })
})
