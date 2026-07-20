import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type CodexPluginReference =
  | { mode: 'local_only'; accountId: null }
  | { mode: 'account'; accountId: string }

export type CodexPluginReferenceState = CodexPluginReference & {
  version: 1
  revision: number
  updatedAt: string
}

export interface CodexPluginReferenceStoreOptions {
  filePath: string
  now?: () => Date
}

export class CodexPluginReferenceStoreError extends Error {
  readonly code: 'invalid' | 'conflict' | 'unavailable'

  constructor(code: CodexPluginReferenceStoreError['code'], message: string) {
    super(message)
    this.name = 'CodexPluginReferenceStoreError'
    this.code = code
  }
}

export class CodexPluginReferenceStore {
  private readonly filePath: string
  private readonly now: () => Date
  private pendingMutation: Promise<void> = Promise.resolve()

  constructor(options: CodexPluginReferenceStoreOptions) {
    this.filePath = options.filePath
    this.now = options.now ?? (() => new Date())
  }

  async get(): Promise<CodexPluginReferenceState> {
    try {
      return parseState(await readFile(this.filePath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          version: 1,
          mode: 'local_only',
          accountId: null,
          revision: 0,
          updatedAt: new Date(0).toISOString(),
        }
      }
      throw error
    }
  }

  async set(reference: CodexPluginReference, expectedRevision: number): Promise<CodexPluginReferenceState> {
    validateReference(reference)
    let updated: CodexPluginReferenceState | undefined
    await this.mutate(async () => {
      const current = await this.get()
      if (current.revision !== expectedRevision) {
        throw new CodexPluginReferenceStoreError('conflict', '플러그인 기준계정 상태가 변경되었습니다.')
      }
      updated = {
        version: 1,
        ...reference,
        revision: current.revision + 1,
        updatedAt: this.now().toISOString(),
      }
      await this.save(updated)
    })
    if (!updated) throw new CodexPluginReferenceStoreError('unavailable', '플러그인 기준계정 상태를 저장하지 못했습니다.')
    return updated
  }

  private async mutate(operation: () => Promise<void>): Promise<void> {
    let resolveCurrent!: () => void
    let rejectCurrent!: (error: unknown) => void
    const current = new Promise<void>((resolve, reject) => {
      resolveCurrent = resolve
      rejectCurrent = reject
    })
    const previous = this.pendingMutation
    this.pendingMutation = current.catch(() => undefined)
    await previous
    try {
      await operation()
      resolveCurrent()
    } catch (error) {
      rejectCurrent(error)
      throw error
    }
  }

  private async save(state: CodexPluginReferenceState): Promise<void> {
    const directory = path.dirname(this.filePath)
    await mkdir(directory, { recursive: true })
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.filePath)
      await chmod(this.filePath, 0o600).catch(() => undefined)
    } catch {
      throw new CodexPluginReferenceStoreError('unavailable', '플러그인 기준계정 상태 파일을 저장하지 못했습니다.')
    }
  }
}

export function codexPluginReferenceStatePath(dataDir: string): string {
  return path.join(dataDir, 'codex-plugin-reference.v1.json')
}

function parseState(raw: string): CodexPluginReferenceState {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new CodexPluginReferenceStoreError('invalid', '플러그인 기준계정 상태가 올바른 JSON이 아닙니다.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CodexPluginReferenceStoreError('invalid', '플러그인 기준계정 상태 형식이 올바르지 않습니다.')
  }
  const state = parsed as Partial<CodexPluginReferenceState>
  if (
    state.version !== 1
    || !Number.isSafeInteger(state.revision) || Number(state.revision) < 1
    || typeof state.updatedAt !== 'string' || !Number.isFinite(Date.parse(state.updatedAt))
  ) {
    throw new CodexPluginReferenceStoreError('invalid', '플러그인 기준계정 상태 필드가 올바르지 않습니다.')
  }
  validateReference(state as CodexPluginReference)
  return state as CodexPluginReferenceState
}

function validateReference(reference: CodexPluginReference): void {
  if (reference.mode === 'local_only' && reference.accountId === null) return
  if (reference.mode === 'account' && typeof reference.accountId === 'string' && reference.accountId.length > 0) return
  throw new CodexPluginReferenceStoreError('invalid', '플러그인 기준계정 선택이 올바르지 않습니다.')
}
