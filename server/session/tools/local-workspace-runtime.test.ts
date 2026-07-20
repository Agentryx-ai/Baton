import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import type { AgentToolInvocation } from '../domain.ts'
import {
  CodexSandboxCommandRunner,
  FullAccessCommandRunner,
  HostCommandToolRuntime,
  LocalWorkspaceToolRuntime,
  type SandboxCommandRequest,
  type SandboxCommandRunner,
} from './local-workspace-runtime.ts'

function invocation(name: string, input: Record<string, unknown>): AgentToolInvocation {
  return { callId: `baton-${name}`, providerCallId: `provider-${name}`, name, input }
}

async function workspace(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-tools-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('rejects traversal, absolute paths, and unknown input keys', async (t) => {
  const cwd = await workspace(t)
  const runtime = new LocalWorkspaceToolRuntime({ cwd })

  for (const input of [
    { path: '../escape.txt' },
    { path: path.resolve(cwd, 'absolute.txt') },
    { path: 'ok.txt', futureOption: true },
  ]) {
    const result = await runtime.execute(invocation('read_file', input))
    assert.equal(result.success, false)
    assert.match(result.error?.code ?? '', /^(path_escape|invalid_tool_input)$/)
  }
})

test('rejects a symlink or junction that escapes the workspace', async (t) => {
  const cwd = await workspace(t)
  const outside = await workspace(t)
  await writeFile(path.join(outside, 'secret.txt'), 'outside')
  try {
    await symlink(outside, path.join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('symlink creation is unavailable')
      return
    }
    throw error
  }

  const runtime = new LocalWorkspaceToolRuntime({ cwd })
  const result = await runtime.execute(invocation('read_file', { path: 'linked/secret.txt' }))
  assert.equal(result.success, false)
  assert.equal(result.error?.code, 'path_escape')
  const write = await runtime.execute(invocation('write_file', {
    path: 'linked/new.txt', content: 'must-not-escape', expectedSha256: null,
  }))
  assert.equal(write.success, false)
  assert.equal(write.error?.code, 'path_escape')
})

test('read_file uses UTF-8 byte offsets without splitting code points', async (t) => {
  const cwd = await workspace(t)
  await writeFile(path.join(cwd, 'unicode.txt'), 'A한B')
  const runtime = new LocalWorkspaceToolRuntime({ cwd })

  const first = await runtime.execute(invocation('read_file', { path: 'unicode.txt', offset: 0, limit: 2 }))
  assert.equal(first.success, true)
  assert.deepEqual(first.content && {
    text: first.content.text,
    truncated: first.content.truncated,
    nextOffset: first.content.nextOffset,
  }, { text: 'A', truncated: true, nextOffset: 1 })

  const narrow = await runtime.execute(invocation('read_file', { path: 'unicode.txt', offset: 1, limit: 1 }))
  assert.equal(narrow.success, true)
  assert.deepEqual(narrow.content && {
    text: narrow.content.text,
    truncated: narrow.content.truncated,
    nextOffset: narrow.content.nextOffset,
  }, { text: '한', truncated: true, nextOffset: 4 })

  const inside = await runtime.execute(invocation('read_file', { path: 'unicode.txt', offset: 2, limit: 3 }))
  assert.equal(inside.success, true)
  assert.deepEqual(inside.content && {
    text: inside.content.text,
    truncated: inside.content.truncated,
    nextOffset: inside.content.nextOffset,
  }, { text: 'B', truncated: false, nextOffset: 5 })
})

test('write_file and replace_text enforce SHA-256 CAS and occurrence counts', async (t) => {
  const cwd = await workspace(t)
  const runtime = new LocalWorkspaceToolRuntime({ cwd })

  const created = await runtime.execute(invocation('write_file', {
    path: 'nested/value.txt', content: 'alpha alpha', expectedSha256: null,
  }))
  assert.equal(created.success, false, 'parent directories are not implicitly created')
  await mkdir(path.join(cwd, 'nested'))
  const written = await runtime.execute(invocation('write_file', {
    path: 'nested/value.txt', content: 'alpha alpha', expectedSha256: null,
  }))
  assert.equal(written.success, true)
  const digest = String(written.content?.sha256)

  const stale = await runtime.execute(invocation('write_file', {
    path: 'nested/value.txt', content: 'wrong', expectedSha256: '0'.repeat(64),
  }))
  assert.equal(stale.success, false)
  assert.equal(stale.error?.code, 'sha256_mismatch')

  const mismatch = await runtime.execute(invocation('replace_text', {
    path: 'nested/value.txt', oldText: 'alpha', newText: 'beta', expectedSha256: digest,
    expectedOccurrences: 1,
  }))
  assert.equal(mismatch.success, false)
  assert.equal(mismatch.error?.code, 'occurrence_mismatch')

  const replaced = await runtime.execute(invocation('replace_text', {
    path: 'nested/value.txt', oldText: 'alpha', newText: 'beta', expectedSha256: digest,
    expectedOccurrences: 2,
  }))
  assert.equal(replaced.success, true)
  assert.equal(replaced.content?.replacements, 2)
  assert.equal(await readFile(path.join(cwd, 'nested/value.txt'), 'utf8'), 'beta beta')
})

class FakeRunner implements SandboxCommandRunner {
  readonly #operation: (request: SandboxCommandRequest) => Promise<number | null>
  constructor(operation: (request: SandboxCommandRequest) => Promise<number | null>) {
    this.#operation = operation
  }
  async run(request: SandboxCommandRequest): Promise<{ exitCode: number | null }> {
    return { exitCode: await this.#operation(request) }
  }
}

test('run_command times out, preserves partial output, and reports a null exit code', async (t) => {
  const cwd = await workspace(t)
  const runner = new FakeRunner(async (request) => {
    request.onStdout(Buffer.from('started'))
    await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }))
    return null
  })
  const runtime = new LocalWorkspaceToolRuntime({ cwd, commandRunner: runner, enableCommands: true })
  const result = await runtime.execute(invocation('run_command', { argv: ['fake'], timeoutMs: 10 }))
  assert.equal(result.success, false)
  assert.equal(result.error?.code, 'tool_timeout')
  assert.deepEqual(result.metadata, {
    exitCode: null, stdout: 'started', stderr: '', timedOut: true, truncated: false,
  })
})

test('run_command caps aggregate output bytes and rejects invalid argv', async (t) => {
  const cwd = await workspace(t)
  const runner = new FakeRunner(async (request) => {
    request.onStdout(Buffer.from('123456'))
    request.onStderr(Buffer.from('abcdef'))
    return 0
  })
  const runtime = new LocalWorkspaceToolRuntime({ cwd, commandRunner: runner, enableCommands: true, maxOutputBytes: 8 })
  const result = await runtime.execute(invocation('run_command', { argv: ['fake'] }))
  assert.equal(result.success, true)
  assert.deepEqual(result.content, {
    exitCode: 0, stdout: '123456', stderr: 'ab', timedOut: false, truncated: true,
  })

  const invalid = await runtime.execute(invocation('run_command', { argv: ['fake'], shell: true }))
  assert.equal(invalid.success, false)
  assert.equal(invalid.error?.code, 'invalid_tool_input')
})

test('run_command does not split UTF-8 output and waits for termination after timeout', async (t) => {
  const cwd = await workspace(t)
  const outputRunner = new FakeRunner(async (request) => {
    request.onStdout(Buffer.from('한B'))
    return 0
  })
  const outputRuntime = new LocalWorkspaceToolRuntime({ cwd, commandRunner: outputRunner, enableCommands: true, maxOutputBytes: 3 })
  const output = await outputRuntime.execute(invocation('run_command', { argv: ['fake'] }))
  assert.equal(output.success, true)
  assert.equal(output.content?.stdout, '한')
  assert.equal(output.content?.truncated, true)

  let terminated = false
  const delayedTerminationRunner = new FakeRunner(async (request) => {
    await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => {
      setTimeout(() => { terminated = true; resolve() }, 40)
    }, { once: true }))
    return null
  })
  const timeoutRuntime = new LocalWorkspaceToolRuntime({ cwd, commandRunner: delayedTerminationRunner, enableCommands: true })
  const startedAt = Date.now()
  const timeout = await timeoutRuntime.execute(invocation('run_command', { argv: ['fake'], timeoutMs: 10 }))
  assert.equal(timeout.success, false)
  assert.equal(timeout.error?.code, 'tool_timeout')
  assert.equal(timeout.metadata?.timedOut, true)
  assert.equal(terminated, true)
  assert.ok(Date.now() - startedAt >= 40)
})

test('concurrent Baton writers serialize SHA-256 CAS so only one mutation wins', async (t) => {
  const cwd = await workspace(t)
  const runtime = new LocalWorkspaceToolRuntime({ cwd })
  const results = await Promise.all([
    runtime.execute(invocation('write_file', { path: 'race.txt', content: 'first', expectedSha256: null })),
    runtime.execute({ ...invocation('write_file', { path: 'race.txt', content: 'second', expectedSha256: null }), callId: 'race-2' }),
  ])
  assert.equal(results.filter((result) => result.success).length, 1)
  assert.equal(results.filter((result) => !result.success && result.error?.code === 'target_exists').length, 1)
})

test('real command sandbox hides Baton environment and denies reads outside cwd', { skip: process.platform !== 'win32' }, async (t) => {
  const cwd = await workspace(t)
  const outside = await workspace(t)
  const sentinel = 'BATON_OUTSIDE_SENTINEL_7f2e'
  const outsideFile = path.join(outside, 'outside.txt')
  await writeFile(outsideFile, sentinel)
  const previous = process.env.BATON_TEST_SECRET
  process.env.BATON_TEST_SECRET = 'BATON_ENV_SENTINEL_4b91'
  t.after(() => {
    if (previous === undefined) delete process.env.BATON_TEST_SECRET
    else process.env.BATON_TEST_SECRET = previous
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  const runner = new CodexSandboxCommandRunner()
  const command = `if defined BATON_TEST_SECRET (echo secret-visible) else (echo secret-hidden) & type "${outsideFile}"`
  const result = await runner.run({
    argv: ['cmd.exe', '/d', '/s', '/c', command],
    cwd,
    signal: new AbortController().signal,
    onStdout: (chunk) => stdout.push(Buffer.from(chunk)),
    onStderr: (chunk) => stderr.push(Buffer.from(chunk)),
  })
  const visible = Buffer.concat([...stdout, ...stderr]).toString('utf8')
  assert.doesNotMatch(visible, /BATON_ENV_SENTINEL_4b91/u)
  assert.doesNotMatch(visible, new RegExp(sentinel, 'u'))
  if (/Restricted read-only access requires the elevated Windows sandbox backend/u.test(visible)) {
    assert.notEqual(result.exitCode, 0, 'unsupported strict isolation must fail closed before command execution')
  } else {
    assert.equal(result.exitCode === 0 || result.exitCode === 1, true)
    assert.match(visible, /secret-hidden/u)
  }
})

test('run_command is not advertised or executable before strict sandbox verification', async (t) => {
  const cwd = await workspace(t)
  const runtime = new LocalWorkspaceToolRuntime({ cwd })
  assert.equal(runtime.definitions.some((definition) => definition.name === 'run_command'), false)
  const result = await runtime.execute(invocation('run_command', { argv: ['cmd.exe', '/c', 'echo unsafe'] }))
  assert.equal(result.success, false)
  assert.equal(result.error?.code, 'tool_unavailable')
})

test('read-only workspace advertises and executes no mutation or command tools', async (t) => {
  const cwd = await workspace(t)
  await writeFile(path.join(cwd, 'value.txt'), 'safe')
  const runtime = new LocalWorkspaceToolRuntime({ cwd, access: 'read_only', enableCommands: true })
  assert.deepEqual(runtime.definitions.map((definition) => definition.name), [
    'read_file', 'list_files', 'search_text',
  ])
  const write = await runtime.execute(invocation('write_file', {
    path: 'value.txt', content: 'changed', expectedSha256: '0'.repeat(64),
  }))
  assert.equal(write.success, false)
  assert.equal(write.error?.code, 'tool_unavailable')
  const command = await runtime.execute(invocation('run_command', { argv: ['unused'] }))
  assert.equal(command.success, false)
  assert.equal(command.error?.code, 'tool_unavailable')
})

test('host command runtime exposes only run_command without a connected workspace', async (t) => {
  const cwd = await workspace(t)
  const runner = new FakeRunner(async (request) => {
    assert.equal(request.cwd, cwd)
    request.onStdout(Buffer.from('host-ok'))
    return 0
  })
  const runtime = new HostCommandToolRuntime({ cwd, commandRunner: runner })
  assert.deepEqual(runtime.definitions.map((definition) => definition.name), ['run_command'])
  const result = await runtime.execute(invocation('run_command', { argv: ['adb', 'devices', '-l'] }))
  assert.equal(result.success, true)
  assert.equal(result.content?.stdout, 'host-ok')
})

test('full-access runner uses direct argv and strips Baton-owned secrets', async (t) => {
  const cwd = await workspace(t)
  const previousSecret = process.env.BATON_PROXY_TOKEN
  const previousMarker = process.env.BATON_FULL_ACCESS_TEST
  process.env.BATON_PROXY_TOKEN = 'must-not-leak'
  process.env.BATON_FULL_ACCESS_TEST = 'also-stripped'
  process.env.FULL_ACCESS_PUBLIC_MARKER = 'visible'
  t.after(() => {
    if (previousSecret === undefined) delete process.env.BATON_PROXY_TOKEN
    else process.env.BATON_PROXY_TOKEN = previousSecret
    if (previousMarker === undefined) delete process.env.BATON_FULL_ACCESS_TEST
    else process.env.BATON_FULL_ACCESS_TEST = previousMarker
    delete process.env.FULL_ACCESS_PUBLIC_MARKER
  })
  const stdout: Buffer[] = []
  const runner = new FullAccessCommandRunner()
  const result = await runner.run({
    argv: [process.execPath, '-e', "process.stdout.write(String(Boolean(process.env.BATON_PROXY_TOKEN))+','+String(Boolean(process.env.BATON_FULL_ACCESS_TEST))+','+process.env.FULL_ACCESS_PUBLIC_MARKER)"],
    cwd,
    signal: new AbortController().signal,
    onStdout: (chunk) => stdout.push(Buffer.from(chunk)),
    onStderr: () => undefined,
  })
  assert.equal(result.exitCode, 0)
  assert.equal(Buffer.concat(stdout).toString('utf8'), 'false,false,visible')
})

test('list_files and search_text return deterministic workspace-relative results', async (t) => {
  const cwd = await workspace(t)
  await mkdir(path.join(cwd, 'src'))
  await writeFile(path.join(cwd, 'src', 'a.ts'), 'first needle\nsecond needle')
  await writeFile(path.join(cwd, 'src', 'b.txt'), 'needle')
  const runtime = new LocalWorkspaceToolRuntime({ cwd })

  const listed = await runtime.execute(invocation('list_files', { path: 'src' }))
  assert.equal(listed.success, true)
  if (!listed.success) throw new Error('list_files failed')
  assert.deepEqual((listed.content.entries as Record<string, unknown>[]).map((entry) => entry.path), [
    'src/a.ts', 'src/b.txt',
  ])

  const searched = await runtime.execute(invocation('search_text', {
    path: 'src', query: 'needle', glob: '**/*.ts', maxResults: 10,
  }))
  assert.equal(searched.success, true)
  assert.deepEqual(searched.content?.matches, [
    { path: 'src/a.ts', line: 1, column: 7, text: 'first needle' },
    { path: 'src/a.ts', line: 2, column: 8, text: 'second needle' },
  ])
})
