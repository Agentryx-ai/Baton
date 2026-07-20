import assert from 'node:assert/strict'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  NativeFolderPickerError,
  type NativeFolderPickerProcessRequest,
  type NativeFolderPickerProcessResult,
  type NativeFolderPickerRunner,
  pickNativeFolder,
} from './native-folder-picker.ts'

test('Windows picker uses a fixed hidden STA command and returns an existing directory', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-native-picker-'))
  const runner = new FakeRunner(result(selectedResponse(directory)))

  assert.equal(await pickNativeFolder({ platform: 'win32', runner }), await realpath(directory))
  assert.equal(runner.requests.length, 1)
  const [request] = runner.requests
  assert.equal(request?.executable, 'pwsh.exe')
  assert.deepEqual(request?.args.slice(0, 6), ['-NoLogo', '-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand'])
  assert.equal(request?.args.length, 7)
  assert.equal(request?.args.some((argument) => argument.includes(directory)), false)
  const script = Buffer.from(request?.args.at(-1) ?? '', 'base64').toString('utf16le')
  assert.match(script, /FolderBrowserDialog/)
  assert.match(script, /pathBase64/)
  assert.doesNotMatch(script, /Get-ChildItem|Get-Content|Environment/)
})

test('Windows picker forwards an existing initial directory as an env var and drops invalid ones', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-native-picker-initial-'))
  const runner = new FakeRunner(result(selectedResponse(directory)))

  await pickNativeFolder({ platform: 'win32', runner, initialDirectory: directory })
  assert.equal(runner.requests[0]?.env?.BATON_PICKER_INITIAL_DIR, Buffer.from(directory, 'utf8').toString('base64'))
  assert.equal(runner.requests[0]?.args.some((argument) => argument.includes(directory)), false)

  for (const invalid of [path.join(directory, 'missing-child'), 'relative\\path', null, undefined]) {
    const ignored = new FakeRunner(result(selectedResponse(directory)))
    await pickNativeFolder({ platform: 'win32', runner: ignored, initialDirectory: invalid })
    assert.equal(ignored.requests[0]?.env, undefined)
  }
})

test('Windows picker falls back to Windows PowerShell when pwsh is not installed', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-native-picker-fallback-'))
  const runner = new MissingPwshRunner(result(selectedResponse(directory)))

  assert.equal(await pickNativeFolder({ platform: 'win32', runner }), await realpath(directory))
  assert.deepEqual(runner.requests.map((request) => request.executable), ['pwsh.exe', 'powershell.exe'])
})

test('Windows picker returns null only for the exact cancellation protocol', async () => {
  const runner = new FakeRunner(result('{"status":"cancelled"}'))
  assert.equal(await pickNativeFolder({ platform: 'win32', runner }), null)
})

test('malformed, non-directory, and over-limit responses fail closed', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-native-picker-file-'))
  const file = path.join(directory, 'not-a-directory.txt')
  await writeFile(file, 'x')
  const cases: Array<[string, NativeFolderPickerProcessResult]> = [
    ['invalid JSON', result('not-json')],
    ['extra cancellation data', result('{"status":"cancelled","path":"leak"}')],
    ['invalid base64', result('{"status":"selected","pathBase64":"not base64"}')],
    ['non-directory', result(selectedResponse(file))],
    ['bounded output', { ...result('{}'), outputLimitExceeded: true }],
  ]
  for (const [name, response] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        pickNativeFolder({ platform: 'win32', runner: new FakeRunner(response) }),
        hasCode('invalid_picker_response'),
      )
    })
  }
})

test('timeout and unavailable picker failures are typed without exposing process output', async () => {
  await assert.rejects(
    pickNativeFolder({ platform: 'win32', runner: new FakeRunner({ ...result('secret output'), timedOut: true }) }),
    hasCode('picker_timeout'),
  )
  await assert.rejects(
    pickNativeFolder({ platform: 'win32', runner: new FakeRunner(result('{"status":"error","code":"picker_unavailable"}')) }),
    hasCode('picker_unavailable'),
  )
  await assert.rejects(
    pickNativeFolder({ platform: 'win32', runner: new RejectingRunner(Object.assign(new Error('sensitive spawn detail'), { code: 'ENOENT' })) }),
    (error: unknown) => hasCode('picker_unavailable')(error) && !String(error).includes('sensitive'),
  )
})

test('unsupported operating systems fail before invoking the runner', async () => {
  const runner = new FakeRunner(result('{"status":"cancelled"}'))
  await assert.rejects(pickNativeFolder({ platform: 'linux', runner }), hasCode('unsupported_os'))
  assert.equal(runner.requests.length, 0)
})

function selectedResponse(selectedPath: string): string {
  return JSON.stringify({ status: 'selected', pathBase64: Buffer.from(selectedPath, 'utf8').toString('base64') })
}

function result(stdout: string): NativeFolderPickerProcessResult {
  return { exitCode: 0, stdout: Buffer.from(stdout, 'utf8'), timedOut: false }
}

function hasCode(code: NativeFolderPickerError['code']): (error: unknown) => boolean {
  return (error) => error instanceof NativeFolderPickerError && error.code === code
}

class FakeRunner implements NativeFolderPickerRunner {
  readonly requests: NativeFolderPickerProcessRequest[] = []
  readonly #response: NativeFolderPickerProcessResult

  constructor(response: NativeFolderPickerProcessResult) {
    this.#response = response
  }

  async run(request: NativeFolderPickerProcessRequest): Promise<NativeFolderPickerProcessResult> {
    this.requests.push(request)
    return this.#response
  }
}

class MissingPwshRunner implements NativeFolderPickerRunner {
  readonly requests: NativeFolderPickerProcessRequest[] = []
  readonly #response: NativeFolderPickerProcessResult

  constructor(response: NativeFolderPickerProcessResult) {
    this.#response = response
  }

  async run(request: NativeFolderPickerProcessRequest): Promise<NativeFolderPickerProcessResult> {
    this.requests.push(request)
    if (request.executable === 'pwsh.exe') throw Object.assign(new Error('spawn pwsh.exe ENOENT'), { code: 'ENOENT' })
    return this.#response
  }
}

class RejectingRunner implements NativeFolderPickerRunner {
  readonly #error: Error

  constructor(error: Error) {
    this.#error = error
  }

  async run(): Promise<NativeFolderPickerProcessResult> {
    throw this.#error
  }
}
