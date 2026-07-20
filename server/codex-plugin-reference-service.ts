import { createHash } from 'node:crypto'

import type { CodexNativeRuntime } from './codex-native-runtime.ts'
import {
  CodexPluginControlPlane,
  type CodexPluginCatalogSnapshot,
  type CodexPluginMarketplace,
} from './codex-plugin-control-plane.ts'
import {
  CodexPluginReferenceStore,
  CodexPluginReferenceStoreError,
  type CodexPluginReference,
  type CodexPluginReferenceState,
} from './codex-plugin-reference-store.ts'
import { NativeAccountVaultError } from './native-account-vault.ts'

export interface CodexPluginReferenceStatus {
  state: CodexPluginReferenceState
  problem: 'selected_account_missing' | null
  account: null | {
    id: string
    alias: string
    enabledForModelRouting: boolean
    revision: number
  }
}

export interface CodexPluginReferencePreview {
  current: CodexPluginReferenceStatus
  target: CodexPluginReference
  targetAccountRevision: number | null
  currentCatalog: CodexPluginCatalogSnapshot | null
  currentCatalogError: string | null
  diffAvailable: boolean
  targetCatalog: CodexPluginCatalogSnapshot
  addedPluginIds: string[]
  removedPluginIds: string[]
  unchangedPluginIds: string[]
  previewDigest: string
}

export type SwitchCodexPluginReferenceInput = CodexPluginReference & {
  expectedStateRevision: number
  expectedTargetAccountRevision: number | null
  previewDigest: string
}

export interface CodexPluginReferenceServiceOptions {
  runtime: CodexNativeRuntime
  store: CodexPluginReferenceStore
  controlPlane?: CodexPluginControlPlane
}

export class CodexPluginReferenceServiceError extends Error {
  readonly code: 'invalid' | 'conflict' | 'verification_failed'

  constructor(code: CodexPluginReferenceServiceError['code'], message: string) {
    super(message)
    this.name = 'CodexPluginReferenceServiceError'
    this.code = code
  }
}

export class CodexPluginReferenceService {
  readonly controlPlane: CodexPluginControlPlane
  private readonly runtime: CodexNativeRuntime
  private readonly store: CodexPluginReferenceStore
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(options: CodexPluginReferenceServiceOptions) {
    this.runtime = options.runtime
    this.store = options.store
    this.controlPlane = options.controlPlane ?? new CodexPluginControlPlane()
  }

  async status(): Promise<CodexPluginReferenceStatus> {
    const state = await this.store.get()
    if (state.mode === 'local_only') return { state, account: null, problem: null }
    const account = (await this.runtime.vault.list('codex')).find((candidate) => candidate.id === state.accountId)
    if (!account) {
      return { state, account: null, problem: 'selected_account_missing' }
    }
    return {
      state,
      problem: null,
      account: {
        id: account.id,
        alias: account.alias,
        enabledForModelRouting: account.enabled,
        revision: account.revision,
      },
    }
  }

  async listCurrent(cwds: string[] = []): Promise<CodexPluginCatalogSnapshot> {
    const state = await this.store.get()
    return await this.catalogFor(state, cwds)
  }

  async install(input: {
    marketplacePath?: string
    remoteMarketplaceName?: string
    pluginName: string
  }): Promise<{ authPolicy: 'ON_INSTALL' | 'ON_USE'; appsNeedingAuth: Array<{ id: string; name: string }> }> {
    const state = await this.store.get()
    const accessToken = state.mode === 'account'
      ? (await this.runtime.getPluginCredential(state.accountId)).accessToken
      : undefined
    return await this.controlPlane.install({ ...input, accessToken })
  }

  async uninstall(pluginId: string): Promise<void> {
    const state = await this.store.get()
    const accessToken = state.mode === 'account'
      ? (await this.runtime.getPluginCredential(state.accountId)).accessToken
      : undefined
    await this.controlPlane.uninstall(pluginId, accessToken)
  }

  async preview(target: CodexPluginReference, cwds: string[] = []): Promise<CodexPluginReferencePreview> {
    const current = await this.status()
    const targetAccount = target.mode === 'account'
      ? await this.runtime.vault.readAccount(target.accountId, 'codex')
      : null
    const [currentCatalogResult, targetCatalog] = await Promise.all([
      this.catalogFor(current.state, cwds).then(
        (catalog) => ({ catalog, failed: false as const }),
        () => ({ catalog: null, failed: true as const }),
      ),
      this.catalogFor(target, cwds),
    ])
    const currentCatalog = currentCatalogResult.catalog
    const currentIds = pluginIds(currentCatalog?.marketplaces ?? [])
    const targetIds = pluginIds(targetCatalog.marketplaces)
    const addedPluginIds = [...targetIds].filter((id) => !currentIds.has(id)).sort()
    const removedPluginIds = [...currentIds].filter((id) => !targetIds.has(id)).sort()
    const unchangedPluginIds = [...targetIds].filter((id) => currentIds.has(id)).sort()
    const targetAccountRevision = targetAccount?.metadata.revision ?? null
    const previewDigest = digest({
      currentStateRevision: current.state.revision,
      target,
      targetAccountRevision,
      currentCatalog: catalogDigest(currentCatalog),
      targetCatalog: catalogDigest(targetCatalog),
    })
    return {
      current,
      target,
      targetAccountRevision,
      currentCatalog,
      currentCatalogError: currentCatalogResult.failed
        ? '현재 기준계정의 catalog를 읽지 못해 정확한 변경 차이를 계산할 수 없습니다.'
        : null,
      diffAvailable: !currentCatalogResult.failed,
      targetCatalog,
      addedPluginIds,
      removedPluginIds,
      unchangedPluginIds,
      previewDigest,
    }
  }

  async switch(input: SwitchCodexPluginReferenceInput, cwds: string[] = []): Promise<{
    status: CodexPluginReferenceStatus
    catalog: CodexPluginCatalogSnapshot
  }> {
    return await this.mutate(() => this.switchUnlocked(input, cwds))
  }

  async removeAccount(accountId: string, expectedRevision: number): Promise<void> {
    await this.mutate(async () => {
      await this.assertAccountRemovable(accountId)
      await this.runtime.vault.remove(accountId, expectedRevision)
      this.runtime.forget(accountId)
    })
  }

  private async switchUnlocked(input: SwitchCodexPluginReferenceInput, cwds: string[]): Promise<{
    status: CodexPluginReferenceStatus
    catalog: CodexPluginCatalogSnapshot
  }> {
    const target: CodexPluginReference = input.mode === 'account'
      ? { mode: 'account', accountId: input.accountId }
      : { mode: 'local_only', accountId: null }
    const preview = await this.preview(target, cwds)
    if (preview.current.state.revision !== input.expectedStateRevision) {
      throw new CodexPluginReferenceServiceError('conflict', '플러그인 기준계정 상태가 preview 이후 변경되었습니다.')
    }
    if (preview.targetAccountRevision !== input.expectedTargetAccountRevision) {
      throw new CodexPluginReferenceServiceError('conflict', '대상 계정이 preview 이후 변경되었습니다.')
    }
    if (preview.previewDigest !== input.previewDigest) {
      throw new CodexPluginReferenceServiceError('conflict', '플러그인 catalog가 preview 이후 변경되었습니다.')
    }

    const previous = preview.current.state
    const updated = await this.store.set(target, input.expectedStateRevision)
    try {
      const catalog = await this.catalogFor(updated, cwds, true)
      return { status: await this.status(), catalog }
    } catch (error) {
      try {
        await this.store.set(
          previous.mode === 'account'
            ? { mode: 'account', accountId: previous.accountId }
            : { mode: 'local_only', accountId: null },
          updated.revision,
        )
      } catch {
        throw new CodexPluginReferenceServiceError(
          'verification_failed',
          '새 plugin catalog 확인과 이전 기준계정 복원이 모두 실패했습니다. 수동 확인이 필요합니다.',
        )
      }
      throw error
    }
  }

  async assertAccountRemovable(accountId: string): Promise<void> {
    const state = await this.store.get()
    if (state.mode === 'account' && state.accountId === accountId) {
      throw new CodexPluginReferenceServiceError(
        'invalid',
        '플러그인 기준계정은 바로 삭제할 수 없습니다. 다른 계정 또는 local-only로 전환하세요.',
      )
    }
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void
    const previous = this.mutationTail
    this.mutationTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async catalogFor(
    reference: CodexPluginReference,
    cwds: string[],
    forceRefresh = false,
  ): Promise<CodexPluginCatalogSnapshot> {
    if (reference.mode === 'local_only') {
      return this.requireCompleteCatalog(await this.controlPlane.list({
        accountId: null,
        cwds,
        marketplaceKinds: ['local'],
      }))
    }
    const credential = await this.runtime.getPluginCredential(reference.accountId, forceRefresh)
    return this.requireCompleteCatalog(await this.controlPlane.list({
      accountId: reference.accountId,
      accessToken: credential.accessToken,
      cwds,
    }))
  }

  private requireCompleteCatalog(catalog: CodexPluginCatalogSnapshot): CodexPluginCatalogSnapshot {
    if (catalog.loadErrors.length > 0) {
      throw new CodexPluginReferenceServiceError(
        'verification_failed',
        'Codex plugin marketplace 일부를 불러오지 못해 catalog 검증을 완료할 수 없습니다.',
      )
    }
    return catalog
  }
}

function pluginIds(marketplaces: CodexPluginMarketplace[]): Set<string> {
  return new Set(marketplaces.flatMap((marketplace) => (
    marketplace.plugins.map((plugin) => `${marketplace.name}/${plugin.id}`)
  )))
}

function catalogDigest(catalog: CodexPluginCatalogSnapshot | null): string {
  if (catalog === null) return digest({ unavailable: true })
  return digest(catalog.marketplaces.map((marketplace) => ({
    name: marketplace.name,
    plugins: marketplace.plugins.map((plugin) => ({
      id: plugin.id,
      installed: plugin.installed,
      enabled: plugin.enabled,
      availability: plugin.availability,
    })).sort((left, right) => left.id.localeCompare(right.id)),
  })).sort((left, right) => left.name.localeCompare(right.name)))
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function pluginReferenceErrorStatus(error: unknown): number | null {
  if (error instanceof CodexPluginReferenceServiceError) {
    return error.code === 'conflict' ? 409 : error.code === 'invalid' ? 409 : 502
  }
  if (error instanceof CodexPluginReferenceStoreError) {
    return error.code === 'conflict' ? 409 : error.code === 'invalid' ? 500 : 503
  }
  if (error instanceof NativeAccountVaultError) {
    return error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : error.code === 'invalid' ? 400 : 503
  }
  return null
}
