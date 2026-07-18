/**
 * Gateway session manager (DESIGN.md §3.1, §7).
 *
 * The BFF logs into the gateway once and holds the `connect.sid` cookie so the SPA
 * never deals with auth. Gateway login is rate limited (5 attempts / 15 min), so:
 *  - login is single-flight and spaced by a minimum local interval, AND
 *  - the cookie is PERSISTED to disk so a BFF restart (dev hot-reload) reuses the
 *    existing session instead of re-logging-in — which would otherwise storm the
 *    gateway's login limit across many restarts.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { config } from './config.ts'

const LOGIN_MIN_INTERVAL_MS = 30_000
const SESSION_PATH = fileURLToPath(new URL('./.baton-session.json', import.meta.url))

let sessionCookie: string | null = null
let loginInFlight: Promise<void> | null = null
let lastLoginAttempt = 0

// Restore a persisted cookie so restarts don't re-login (§ login-storm guard).
try {
  const raw = readFileSync(SESSION_PATH, 'utf8')
  const saved = JSON.parse(raw) as { cookie?: string }
  if (saved.cookie) sessionCookie = saved.cookie
} catch {
  /* no persisted session — will log in on first use */
}

function persistCookie(cookie: string | null): void {
  try {
    writeFileSync(SESSION_PATH, JSON.stringify({ cookie }), 'utf8')
  } catch {
    /* best-effort */
  }
}

function extractSessionCookie(res: Response): string | null {
  const setCookie = res.headers.getSetCookie?.() ?? []
  for (const cookie of setCookie) {
    if (cookie.startsWith('connect.sid=')) return cookie.split(';')[0]
  }
  return null
}

async function login(): Promise<void> {
  const sinceLast = Date.now() - lastLoginAttempt
  if (sinceLast < LOGIN_MIN_INTERVAL_MS) {
    throw new Error(
      `Gateway login throttled locally (retry in ${Math.ceil((LOGIN_MIN_INTERVAL_MS - sinceLast) / 1000)}s) — guarding the gateway rate limit`,
    )
  }
  lastLoginAttempt = Date.now()

  const res = await fetch(`${config.gatewayUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: config.gatewayUser, password: config.gatewayPass }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Gateway login failed: HTTP ${res.status} ${body.slice(0, 200)}`)
  }
  const cookie = extractSessionCookie(res)
  if (!cookie) throw new Error('Gateway login succeeded but no connect.sid cookie returned')
  sessionCookie = cookie
  persistCookie(cookie)
  console.log('[baton] gateway session established')
}

function ensureLogin(): Promise<void> {
  loginInFlight ??= login().finally(() => {
    loginInFlight = null
  })
  return loginInFlight
}

export interface GatewayResponse {
  status: number
  headers: Headers
  body: Buffer
}

/** Forward a request to the gateway with the held session cookie; re-login once on 401. */
export async function fetchGateway(
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: Buffer },
): Promise<GatewayResponse> {
  if (!sessionCookie) await ensureLogin()

  const doFetch = (): Promise<Response> =>
    fetch(`${config.gatewayUrl}${path}`, {
      method: init.method,
      headers: { ...(init.headers ?? {}), cookie: sessionCookie ?? '' },
      body: init.body && init.body.length > 0 ? init.body : undefined,
    })

  let res = await doFetch()
  if (res.status === 401) {
    // Stale/expired cookie — drop it (incl. persisted) and re-login once.
    sessionCookie = null
    persistCookie(null)
    await ensureLogin()
    res = await doFetch()
  }
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) }
}

export function sessionStatus(): { loggedIn: boolean } {
  return { loggedIn: sessionCookie !== null }
}
