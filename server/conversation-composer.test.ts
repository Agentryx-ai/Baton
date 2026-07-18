import assert from 'node:assert/strict'
import test from 'node:test'

import { composerKeyAction } from '../src/features/conversations/composer-keyboard.ts'

test('composer submits on Enter and preserves Shift+Enter as a newline', () => {
  assert.equal(composerKeyAction({ key: 'Enter', shiftKey: false }), 'submit')
  assert.equal(composerKeyAction({ key: 'Enter', shiftKey: true }), 'newline')
  assert.equal(composerKeyAction({ key: 'a', shiftKey: false }), 'ignore')
})

test('composer never submits while an IME composition is active', () => {
  assert.equal(
    composerKeyAction({ key: 'Enter', shiftKey: false, isComposing: true }),
    'ignore',
  )
  assert.equal(
    composerKeyAction({ key: 'Enter', shiftKey: false, keyCode: 229 }),
    'ignore',
  )
})
