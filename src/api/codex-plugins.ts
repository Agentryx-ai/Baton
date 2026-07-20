export type CodexPluginReference =
  | { mode: 'local_only'; accountId: null }
  | { mode: 'account'; accountId: string }

export interface CodexPluginReferenceStatus {
  state: CodexPluginReference & { version: 1; revision: number; updatedAt: string }
  account: null | {
    id: string
    alias: string
    enabledForModelRouting: boolean
    revision: number
  }
}

export interface CodexPluginSummary {
  id: string
  name: string
  installed: boolean
  enabled: boolean
  installPolicy: 'NOT_AVAILABLE' | 'AVAILABLE' | 'INSTALLED_BY_DEFAULT'
  displayName: string | null
  shortDescription: string | null
}

export interface CodexPluginCatalog {
  accountId: string | null
  mode: 'account' | 'local_only'
  fetchedAt: string
  marketplaces: Array<{
    name: string
    path: string | null
    displayName: string | null
    plugins: CodexPluginSummary[]
  }>
  loadErrors: Array<{ path: string; message: string }>
  featuredPluginIds: string[]
}

export interface CodexPluginReferencePreview {
  current: CodexPluginReferenceStatus
  target: CodexPluginReference
  targetAccountRevision: number | null
  currentCatalog: CodexPluginCatalog
  targetCatalog: CodexPluginCatalog
  addedPluginIds: string[]
  removedPluginIds: string[]
  unchangedPluginIds: string[]
  previewDigest: string
}

export interface CodexPluginInstallResult {
  authPolicy: 'ON_INSTALL' | 'ON_USE'
  appsNeedingAuth: Array<{ id: string; name: string }>
}
