import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('isolated runs can disable cwd .env loading', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-config-env-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, '.env'), 'BATON_DATA_DIR=C:\\\\live-baton\\n')
  const script = path.resolve('server/config.ts')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BATON_DISABLE_ENV_FILE: '1',
    LOCALAPPDATA: path.join(directory, 'local'),
  }
  delete env.BATON_DATA_DIR
  const result = await spawnResult(process.execPath, [
    path.resolve('node_modules/tsx/dist/cli.mjs'), '-e',
    `import { config } from ${JSON.stringify(script)}; process.stdout.write(config.dataDir)`,
  ], directory, env)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, path.join(directory, 'local', 'Baton'))
})

function spawnResult(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}
