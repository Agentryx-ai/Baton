import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { LocalImageArtifactStore } from '../image-artifacts.ts'
import { LdPlayerHost, LdPlayerToolRuntime, parseLdPlayerList, type LdPlayerCommandRunner } from './ldplayer-runtime.ts'

const ROOT = 'C:\\LDPlayer\\LDPlayer9'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

test('parses list2 state without granting arbitrary process data', () => {
  assert.deepEqual(parseLdPlayerList('14,Audit-LD9-Fresh,0,0,0,-1,-1,1280,720,240\r\n'), [{
    index: 14, name: 'Audit-LD9-Fresh', running: false, androidStarted: false, pid: null,
  }])
  assert.equal(
    parseLdPlayerList('14,Audit,Fresh,0,0,0,-1,-1,1280,720,240\r\n')[0]?.name,
    'Audit,Fresh',
  )
})

test('runtime targets only the exact granted instance and returns screenshots as artifact references', async () => {
  const calls: string[][] = []
  const runner: LdPlayerCommandRunner = async (_executable, args) => {
    calls.push([...args])
    if (args[0] === 'list2') {
      return { stdout: Buffer.from('14,Audit-LD9-Fresh,123,456,1,4321,999,1280,720,240\r\n'), stderr: Buffer.alloc(0), exitCode: 0 }
    }
    if (args.includes('exec-out screencap -p')) {
      return { stdout: Buffer.concat([Buffer.from('diagnostic\r\n'), PNG]), stderr: Buffer.alloc(0), exitCode: 0 }
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 }
  }
  const host = new LdPlayerHost({ installationRoots: [ROOT], runner })
  const runtime = new LdPlayerToolRuntime({
    kind: 'ldplayer', installationRoot: ROOT, instanceIndex: 14, instanceName: 'Audit-LD9-Fresh',
  }, host, new LocalImageArtifactStore(mkdtempSync(path.join(tmpdir(), 'baton-ld-images-'))))

  const capture = await runtime.execute({
    callId: 'call-1', providerCallId: 'native-1', name: 'ldplayer_capture', input: {},
  })
  assert.equal(capture.success, true)
  assert.equal(capture.success && capture.images?.[0]?.width, 1)
  assert.deepEqual(calls.at(-1), ['adb', '--index', '14', '--command', 'exec-out screencap -p'])

  const rejected = await runtime.execute({
    callId: 'call-2', providerCallId: 'native-2', name: 'ldplayer_input_text', input: { text: 'hello; rm' },
  })
  assert.equal(rejected.success, false)
  assert.equal(!rejected.success && rejected.error.code, 'invalid_tool_input')

  const flow = await runtime.execute({
    callId: 'call-3', providerCallId: 'native-3', name: 'ldplayer_run_flow', input: {
      steps: [
        { action: 'tap', x: 10, y: 20, label: 'open' },
        { action: 'capture', label: 'opened' },
      ],
    },
  })
  assert.equal(flow.success, true)
  assert.equal(flow.success && flow.images?.length, 1)
  assert.ok(calls.some((args) => args.includes('shell input tap 10 20')))
})
