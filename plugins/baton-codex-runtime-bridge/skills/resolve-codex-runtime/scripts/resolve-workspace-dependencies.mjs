#!/usr/bin/env node

import { access, readFile, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ENV_ROOTS = [
  'CODEX_RUNTIME_DEPENDENCIES',
  'CODEX_WORKSPACE_DEPENDENCIES',
  'CODEX_DEPENDENCIES',
]

function candidates() {
  const roots = ENV_ROOTS
    .map((name) => process.env[name])
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .map((value) => path.resolve(value))

  roots.push(path.join(
    os.homedir(),
    '.cache',
    'codex-runtimes',
    'codex-primary-runtime',
    'dependencies',
  ))
  return [...new Set(roots)]
}

async function isFile(filePath, mode = constants.R_OK) {
  try {
    await access(filePath, mode)
    return (await stat(filePath)).isFile()
  } catch {
    return false
  }
}

function nodeCandidates(root) {
  return process.platform === 'win32'
    ? [path.join(root, 'node', 'bin', 'node.exe')]
    : [path.join(root, 'node', 'bin', 'node')]
}

async function resolveRoot(candidate) {
  const root = await realpath(candidate)
  const nodeModules = path.join(root, 'node', 'node_modules')
  const artifactToolPackage = path.join(nodeModules, '@oai', 'artifact-tool')
  const packageJsonPath = path.join(artifactToolPackage, 'package.json')
  const nodeExecutable = (await Promise.all(
    nodeCandidates(root).map(async (entry) => (
      await isFile(entry, process.platform === 'win32' ? constants.R_OK : constants.R_OK | constants.X_OK)
        ? entry
        : null
    )),
  )).find(Boolean)

  if (!nodeExecutable || !(await isFile(packageJsonPath))) return null
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
  if (packageJson.name !== '@oai/artifact-tool' || typeof packageJson.version !== 'string') return null

  return {
    schema: 'baton.codex-workspace-dependencies/v1',
    source: ENV_ROOTS.find((name) => process.env[name]
      && path.resolve(process.env[name]) === path.resolve(candidate)) ?? 'codex-primary-runtime',
    dependencyRoot: root,
    nodeExecutable: await realpath(nodeExecutable),
    nodeModules: await realpath(nodeModules),
    artifactToolPackage: await realpath(artifactToolPackage),
    artifactToolVersion: packageJson.version,
  }
}

for (const candidate of candidates()) {
  try {
    const result = await resolveRoot(candidate)
    if (result) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      process.exit(0)
    }
  } catch {
    // Continue to the next declared or standard primary-runtime root.
  }
}

process.stderr.write(
  'Baton could not validate an installed Codex primary runtime containing @oai/artifact-tool. '
  + 'Refresh the openai-primary-runtime plugin and retry.\n',
)
process.exit(1)
