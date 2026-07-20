import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const resolver = path.resolve(
  'plugins/baton-codex-runtime-bridge/skills/resolve-codex-runtime/scripts/resolve-workspace-dependencies.mjs',
)

test('Codex runtime bridge returns only a validated official artifact-tool dependency root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'baton-runtime-bridge-'))
  try {
    const nodeExecutable = path.join(root, 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
    const packageRoot = path.join(root, 'node', 'node_modules', '@oai', 'artifact-tool')
    await mkdir(path.dirname(nodeExecutable), { recursive: true })
    await mkdir(packageRoot, { recursive: true })
    await writeFile(nodeExecutable, '')
    if (process.platform !== 'win32') await chmod(nodeExecutable, 0o755)
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: '@oai/artifact-tool',
      version: '9.9.9-test',
    }))

    const result = spawnSync(process.execPath, [resolver], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_RUNTIME_DEPENDENCIES: '',
        CODEX_WORKSPACE_DEPENDENCIES: root,
        CODEX_DEPENDENCIES: '',
      },
    })
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout) as Record<string, unknown>
    assert.equal(output.schema, 'baton.codex-workspace-dependencies/v1')
    assert.equal(output.source, 'CODEX_WORKSPACE_DEPENDENCIES')
    assert.equal(output.dependencyRoot, await realpath(root))
    assert.equal(output.nodeExecutable, await realpath(nodeExecutable))
    assert.equal(output.nodeModules, await realpath(path.join(root, 'node', 'node_modules')))
    assert.equal(output.artifactToolPackage, await realpath(packageRoot))
    assert.equal(output.artifactToolVersion, '9.9.9-test')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
