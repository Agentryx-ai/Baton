import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

test('Baton Native Claude core has no CLIProxy library, process, port, config, or management API dependency', async () => {
  const serverDirectory = path.resolve(import.meta.dirname)
  const entries = await readdir(serverDirectory)
  const implementationFiles = entries.filter((name) => (
    !name.endsWith('.test.ts')
    && (
      name.startsWith('claude-native-')
      || name.startsWith('model-fallback')
      || name === 'native-account-router.ts'
    )
  ))
  assert.ok(implementationFiles.length >= 8, 'native core boundary unexpectedly shrank')

  const forbidden = /cliproxy|gateway-session|fetchGateway|\/api\/cliproxy|8317/i
  for (const name of implementationFiles) {
    const source = await readFile(path.join(serverDirectory, name), 'utf8')
    assert.doesNotMatch(source, forbidden, `${name} crossed the Native core dependency boundary`)
  }

  const packageJson = JSON.parse(await readFile(path.resolve(serverDirectory, '../package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  }
  assert.equal(Object.keys(dependencies).some((name) => /cliproxy/i.test(name)), false)
})
