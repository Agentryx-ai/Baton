import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'

export class WorkspaceRootError extends Error {
  readonly code: 'invalid_workspace' | 'workspace_disconnected'

  constructor(
    message: string,
    code: 'invalid_workspace' | 'workspace_disconnected' = 'invalid_workspace',
  ) {
    super(message)
    this.name = 'WorkspaceRootError'
    this.code = code
  }
}

/** Resolve a user-selected workspace to the exact directory Baton is allowed to expose to tools. */
export function resolveWorkspaceRoot(value: string): string {
  const input = value.trim()
  if (!input || !path.isAbsolute(input)) throw new WorkspaceRootError('workspace cwd must be an absolute path')
  let resolved: string
  try {
    resolved = realpathSync.native(input)
  } catch {
    throw new WorkspaceRootError('workspace cwd is unavailable')
  }
  if (!statSync(resolved).isDirectory()) throw new WorkspaceRootError('workspace cwd must be a directory')
  const normalized = path.resolve(resolved)
  if (normalized === path.parse(normalized).root) throw new WorkspaceRootError('filesystem roots cannot be used as a workspace')
  return normalized
}

/** Fail closed if a previously-authorized canonical root now resolves elsewhere. */
export function assertWorkspaceRoot(storedCanonicalRoot: string): string {
  let current: string
  try {
    current = resolveWorkspaceRoot(storedCanonicalRoot)
  } catch {
    throw new WorkspaceRootError('workspace is no longer available; reconnect it before continuing', 'workspace_disconnected')
  }
  if (!samePlatformPath(current, storedCanonicalRoot)) {
    throw new WorkspaceRootError('workspace location changed; reconnect it before continuing', 'workspace_disconnected')
  }
  return storedCanonicalRoot
}

function samePlatformPath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left)
  const normalizedRight = path.normalize(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight
}
