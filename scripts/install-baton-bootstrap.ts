import path from 'node:path'

import { installBootstrap } from '../server/bootstrap-installer.ts'

const artifactIndex = process.argv.indexOf('--artifact')
if (artifactIndex < 0 || !process.argv[artifactIndex + 1]) throw new Error('--artifact is required')
const signedIndex = process.argv.indexOf('--signed-release-thumbprint')
const unsigned = process.argv.includes('--allow-unsigned-development')
if (!unsigned && signedIndex < 0) {
  throw new Error('Choose --signed-release-thumbprint or explicitly opt into --allow-unsigned-development')
}
if (unsigned && signedIndex >= 0) throw new Error('Bootstrap trust modes are mutually exclusive')

const manifest = await installBootstrap({
  artifact: path.resolve(process.argv[artifactIndex + 1]),
  workerRoot: path.resolve(process.env.BATON_WORKER_ROOT ?? process.cwd()),
  workerNode: path.resolve(process.env.BATON_WORKER_NODE ?? process.execPath),
  trust: unsigned
    ? { kind: 'unsigned-development' }
    : { kind: 'signed-release', signerThumbprint: process.argv[signedIndex + 1] ?? '' },
  failAfterSwitch: process.env.NODE_ENV === 'test' && process.env.BATON_TEST_FAIL_AFTER_SWITCH === '1',
  failAfterSwitchStep: process.env.NODE_ENV === 'test'
    ? Number(process.env.BATON_TEST_FAIL_AFTER_SWITCH_STEP ?? 0) || undefined
    : undefined,
  holdLockMs: process.env.NODE_ENV === 'test' ? Number(process.env.BATON_TEST_HOLD_INSTALL_LOCK_MS ?? 0) : 0,
})
console.log(`Activated bootstrap ${manifest.artifactSha256}`)
