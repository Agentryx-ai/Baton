import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { mkdtemp, rename, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { assertWorkspaceRoot, resolveWorkspaceRoot, WorkspaceRootError } from './workspace-root.ts'

test('workspace roots require a real non-root directory and canonicalize links', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-workspace-root-'))
  const file = path.join(directory, 'file.txt')
  await writeFile(file, 'x')
  const canonicalDirectory = path.resolve(realpathSync.native(directory))
  assert.equal(resolveWorkspaceRoot(directory), canonicalDirectory)
  assert.throws(() => resolveWorkspaceRoot('relative/path'), /absolute/)
  assert.throws(() => resolveWorkspaceRoot(file), /directory/)
  assert.throws(() => resolveWorkspaceRoot(path.parse(directory).root), /filesystem roots/)

  const link = `${directory}-link`
  await symlink(directory, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(resolveWorkspaceRoot(link), canonicalDirectory)
})

test('an authorized root fails closed when its path is replaced by a link', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-workspace-authority-'))
  const replacement = await mkdtemp(path.join(tmpdir(), 'baton-workspace-replacement-'))
  const moved = `${directory}-moved`
  const canonicalDirectory = resolveWorkspaceRoot(directory)
  assert.equal(assertWorkspaceRoot(canonicalDirectory), canonicalDirectory)

  await rename(directory, moved)
  await symlink(replacement, directory, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(
    () => assertWorkspaceRoot(canonicalDirectory),
    (error: unknown) => error instanceof WorkspaceRootError && error.code === 'workspace_disconnected',
  )
})
