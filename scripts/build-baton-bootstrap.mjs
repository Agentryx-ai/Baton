#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const outputRoot = path.join(root, '.tmp', 'bootstrap-build')
const bundle = path.join(outputRoot, 'baton-bootstrap.cjs')
const blob = path.join(outputRoot, 'baton-bootstrap.blob')
const artifact = path.join(outputRoot, 'baton-bootstrap.exe')

await rm(outputRoot, { recursive: true, force: true })
await mkdir(outputRoot, { recursive: true })
const result = await build({
  entryPoints: [path.join(root, 'scripts', 'baton-bootstrap-entry.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  minify: false,
  sourcemap: false,
  metafile: true,
  banner: { js: "'use strict';" },
})
await writeFile(path.join(outputRoot, 'metafile.json'), `${JSON.stringify(result.metafile, null, 2)}\n`)
assertRecoveryOnlyBundle(result.metafile)

const seaConfig = path.join(outputRoot, 'sea-config.json')
await writeFile(seaConfig, `${JSON.stringify({
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
}, null, 2)}\n`)
await run(process.execPath, ['--experimental-sea-config', seaConfig])
await copyFile(process.execPath, artifact)
await run(process.execPath, [
  path.join(root, 'node_modules', 'postject', 'dist', 'cli.js'), artifact, 'NODE_SEA_BLOB', blob,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
])

const selfTest = JSON.parse((await capture(artifact, ['self-test', '--json'])).toString('utf8'))
if (selfTest.ok !== true || selfTest.standalone !== true) throw new Error('Generated bootstrap failed its standalone contract')
console.log(`Built standalone recovery artifact: ${artifact}`)

if (process.argv.includes('--install')) {
  const trustArgs = process.argv.includes('--allow-unsigned-development')
    ? ['--allow-unsigned-development']
    : process.argv.includes('--signed-release-thumbprint')
      ? ['--signed-release-thumbprint', process.argv[process.argv.indexOf('--signed-release-thumbprint') + 1] ?? '']
      : []
  await run(process.execPath, [
    path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    'scripts/install-baton-bootstrap.ts', '--artifact', artifact, ...trustArgs,
  ])
}

function assertRecoveryOnlyBundle(meta) {
  const allowedServerInputs = new Set([
    'server/bootstrap-contract.ts',
    'server/bootstrap-metadata-recovery.ts',
    'server/client-integration-offline.ts',
    'server/client-integration-recovery.ts',
    'server/windows-lifecycle.ts',
  ])
  const violations = Object.keys(meta.inputs)
    .map((input) => input.replaceAll('\\', '/'))
    .filter((input) => input.startsWith('server/') && !allowedServerInputs.has(input))
  for (const output of Object.values(meta.outputs)) {
    for (const item of output.imports ?? []) {
      if (/^node:(?:http|https|net|tls|http2)$/.test(item.path)) violations.push(item.path)
    }
  }
  if (violations.length) throw new Error(`Bootstrap imported forbidden Worker/server modules: ${violations.join(', ')}`)
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(file)} exited ${code}`)))
  })
}

function capture(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const stdout = []
    let stderr = ''
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk.slice(0, 4096) })
    child.once('error', reject)
    child.once('close', (code) => code === 0
      ? resolve(Buffer.concat(stdout))
      : reject(new Error(`${path.basename(file)} exited ${code}: ${redact(stderr)}`)))
  })
}

function redact(value) {
  return value
    .replace(/((?:access_token|refresh_token|api_key|api-key|token|authorization)\s*[=:]\s*)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .slice(0, 1000)
}
