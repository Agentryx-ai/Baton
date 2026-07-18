/**
 * Typed helpers over the gateway management API, used by the policy engine (P2).
 * Response shapes sampled from the live gateway instance — see DESIGN.md §2.4.
 */
import { fetchGateway } from './gateway-session.ts'

export interface GatewayAccount {
  id: string
  provider: string
  isDefault: boolean
  email: string
  nickname: string
  paused?: boolean
  createdAt?: string
  lastUsedAt?: string
}

export interface QuotaWindow {
  /** Claude uses `rateLimitType` ('five_hour'|'seven_day'); Codex uses `category`+`cadence`. */
  rateLimitType?: string
  /** Codex: 'usage' = primary blocking limit, 'additional' = feature sub-quota (non-blocking). */
  category?: string
  label?: string
  usedPercent: number
  remainingPercent: number
  resetAt: string | null
}

export interface AccountQuota {
  success: boolean
  windows: QuotaWindow[]
  lastUpdated: number
  accountId: string
}

export function isSuccessfulHttpStatus(status: number): boolean {
  return status >= 200 && status < 300
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetchGateway(path, { method: 'GET', headers: { accept: 'application/json' } })
  if (!isSuccessfulHttpStatus(res.status)) throw new Error(`GET ${path} → HTTP ${res.status}`)
  return JSON.parse(res.body.toString('utf8')) as T
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetchGateway(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : Buffer.from(JSON.stringify(body)),
  })
  if (!isSuccessfulHttpStatus(res.status)) throw new Error(`POST ${path} → HTTP ${res.status}`)
  return JSON.parse(res.body.toString('utf8')) as T
}

async function putJson(path: string, body: unknown): Promise<void> {
  const res = await fetchGateway(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: Buffer.from(JSON.stringify(body)),
  })
  if (!isSuccessfulHttpStatus(res.status)) throw new Error(`PUT ${path} → HTTP ${res.status}`)
}

export async function getAccounts(provider: string): Promise<GatewayAccount[]> {
  const data = await getJson<{ accounts: GatewayAccount[] }>(
    `/api/cliproxy/auth/accounts/${provider}`,
  )
  return data.accounts ?? []
}

export async function getQuota(provider: string, accountId: string): Promise<AccountQuota> {
  return getJson<AccountQuota>(
    `/api/cliproxy/quota/${provider}/${encodeURIComponent(accountId)}`,
  )
}

export async function pauseAccount(provider: string, accountId: string): Promise<void> {
  await postJson(`/api/cliproxy/auth/accounts/${provider}/${encodeURIComponent(accountId)}/pause`)
}

export async function resumeAccount(provider: string, accountId: string): Promise<void> {
  await postJson(`/api/cliproxy/auth/accounts/${provider}/${encodeURIComponent(accountId)}/resume`)
}

/**
 * Establish the routing prerequisite used by Baton policy mode.
 *
 * The installed CLIProxy management contract is PUT + `{value}`. A successful
 * response is the acknowledgement boundary; the policy engine must not start
 * when this call fails.
 */
export async function setFillFirstRouting(): Promise<void> {
  await putJson('/api/cliproxy/routing/strategy', { value: 'fill-first' })
}
