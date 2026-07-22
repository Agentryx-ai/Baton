import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { DEFAULT_ISOLATED_TEST_PATTERNS, isolatedEnvironment } from './isolated-test-environment.mjs'

test('isolated test environment pins durable state and disables repository env loading', () => {
  const directory = path.resolve('C:\\isolated-test-fixture')
  const env = isolatedEnvironment(directory, 45127, {
    ...process.env,
    BATON_DATA_DIR: 'C:\\live-baton',
    BATON_BOOTSTRAP_MANIFEST: 'C:\\live-baton\\active.json',
    CODEX_HOME: 'C:\\live-codex-home',
    Codex_Home: 'C:\\live-codex-home-alternate-case',
  })
  assert.equal(env.BATON_DATA_DIR, path.join(directory, 'data'))
  assert.equal(env.BATON_DISABLE_ENV_FILE, '1')
  assert.equal(env.BATON_PORT, '45127')
  assert.equal(env.CODEX_HOME, path.join(directory, 'home', '.codex'))
  assert.equal(Object.keys(env).filter((key) => key.toUpperCase() === 'CODEX_HOME').length, 1)
  assert.notEqual(env.BATON_BOOTSTRAP_MANIFEST, 'C:\\live-baton\\active.json')
})

test('default isolated test plan includes server and script regressions', () => {
  assert.deepEqual(DEFAULT_ISOLATED_TEST_PATTERNS, [
    'server/**/*.test.ts',
    'scripts/**/*.test.mjs',
  ])
})
