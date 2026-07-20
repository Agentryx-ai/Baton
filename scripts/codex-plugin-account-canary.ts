import process from 'node:process'

type Reference =
  | { mode: 'local_only'; accountId: null }
  | { mode: 'account'; accountId: string }

interface ReferenceStatus {
  state: Reference & { revision: number }
  problem: 'selected_account_missing' | null
  account: null | { id: string; alias: string; enabledForModelRouting: boolean; revision: number }
}

interface Preview {
  current: ReferenceStatus
  target: Reference
  targetAccountRevision: number | null
  previewDigest: string
  diffAvailable: boolean
  currentCatalogError: string | null
  addedPluginIds: string[]
  removedPluginIds: string[]
  unchangedPluginIds: string[]
}

interface Catalog {
  mode: 'local_only' | 'account'
  accountId: string | null
  marketplaces: Array<{ name: string; plugins: unknown[] }>
  loadErrors: unknown[]
}

const args = process.argv.slice(2)
const accountIndex = args.indexOf('--account')
const accountId = accountIndex >= 0 ? args[accountIndex + 1]?.trim() : undefined
const apply = args.includes('--apply')
const baseUrl = (process.env.BATON_URL ?? 'http://127.0.0.1:4400').replace(/\/$/, '')

if (!accountId) {
  throw new Error('Usage: npm run smoke:codex-plugins -- --account <native-account-id> [--apply]')
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(45_000),
  })
  const raw = await response.text()
  let parsed: unknown
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    throw new Error(`${path} returned non-JSON HTTP ${response.status}`)
  }
  if (!response.ok) {
    const message = parsed && typeof parsed === 'object' && 'error' in parsed
      ? String(parsed.error)
      : `HTTP ${response.status}`
    throw new Error(`${path} failed: ${message}`)
  }
  return parsed as T
}

function mutation<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'x-baton-interaction': 'codex-plugin-control' },
    body: JSON.stringify(body),
  })
}

async function preview(target: Reference): Promise<Preview> {
  return await mutation<Preview>('/baton/codex-plugins/reference/preview', target)
}

async function switchReference(value: Preview): Promise<{ status: ReferenceStatus; catalog: Catalog }> {
  return await mutation('/baton/codex-plugins/reference/switch', {
    ...value.target,
    expectedStateRevision: value.current.state.revision,
    expectedTargetAccountRevision: value.targetAccountRevision,
    previewDigest: value.previewDigest,
  })
}

function catalogSummary(catalog: Catalog): Record<string, unknown> {
  return {
    mode: catalog.mode,
    accountId: catalog.accountId,
    marketplaceCount: catalog.marketplaces.length,
    pluginCount: catalog.marketplaces.reduce((sum, marketplace) => sum + marketplace.plugins.length, 0),
    loadErrorCount: catalog.loadErrors.length,
  }
}

const accounts = await request<{ accounts: Array<{
  id: string
  nickname: string
  paused?: boolean
  revision?: number
}> }>('/baton/codex-native/accounts')
const targetAccount = accounts.accounts.find((account) => account.id === accountId)
if (!targetAccount) throw new Error(`Native Codex account not found: ${accountId}`)

const original = await request<ReferenceStatus>('/baton/codex-plugins/reference')
if (apply && original.problem) {
  throw new Error('Current reference is already unhealthy; recover it in Settings before an apply canary.')
}
const target: Reference = { mode: 'account', accountId }
const initialPreview = await preview(target)
console.log(JSON.stringify({
  phase: 'preview',
  target: {
    id: targetAccount.id,
    nickname: targetAccount.nickname,
    pausedForModelRouting: targetAccount.paused === true,
    revision: targetAccount.revision ?? null,
  },
  diffAvailable: initialPreview.diffAvailable,
  currentCatalogError: initialPreview.currentCatalogError,
  added: initialPreview.addedPluginIds.length,
  removed: initialPreview.removedPluginIds.length,
  unchanged: initialPreview.unchangedPluginIds.length,
  apply,
}, null, 2))

if (!apply) {
  console.log('PREVIEW_ONLY: rerun with --apply to switch, verify, and restore the reference.')
  process.exit(0)
}

const originalReference: Reference = original.state.mode === 'account'
  ? { mode: 'account', accountId: original.state.accountId }
  : { mode: 'local_only', accountId: null }
const alreadySelected = originalReference.mode === 'account' && originalReference.accountId === accountId
let switched = false
let canaryError: unknown = null
try {
  if (!alreadySelected) {
    const result = await switchReference(initialPreview)
    switched = true
    if (result.status.state.mode !== 'account' || result.status.state.accountId !== accountId) {
      throw new Error('Reference switch confirmation returned a different account.')
    }
    console.log(JSON.stringify({ phase: 'switched', ...catalogSummary(result.catalog) }, null, 2))
  }
  const verified = await request<Catalog>('/baton/codex-plugins/catalog')
  if (verified.mode !== 'account' || verified.accountId !== accountId || verified.loadErrors.length > 0) {
    throw new Error('Account catalog verification did not match the target reference.')
  }
  console.log(JSON.stringify({ phase: 'verified', ...catalogSummary(verified) }, null, 2))
} catch (error) {
  canaryError = error
}
if (switched) {
  try {
    const restorePreview = await preview(originalReference)
    const restored = await switchReference(restorePreview)
    if (
      restored.status.state.mode !== originalReference.mode
      || restored.status.state.accountId !== originalReference.accountId
    ) {
      throw new Error('Canary completed but failed to restore the original plugin reference.')
    }
    console.log(JSON.stringify({ phase: 'restored', reference: originalReference }, null, 2))
  } catch (restoreError) {
    throw new AggregateError(
      canaryError === null ? [restoreError] : [canaryError, restoreError],
      'Plugin canary failed and the original reference could not be restored.',
    )
  }
}
if (canaryError !== null) throw canaryError

console.log('PASS: Codex plugin account catalog canary completed.')
