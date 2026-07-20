import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import type { ClaudeNativeAccountSecret } from './claude-native-account-vault.ts'

export interface ClaudeNativeCredential {
  accountId: string
  accessToken: string
  expiresAt?: number
  scopes: string[]
}

export interface ClaudeCodeOAuthAccountSnapshot {
  nickname: string
  secret: ClaudeNativeAccountSecret
}

const CLAUDE_CODE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLAUDE_CODE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const CLAUDE_CODE_DEFAULT_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
] as const
const REFRESH_SKEW_MS = 120_000

export interface ClaudeCredentialsFile {
  claudeAiOauth?: {
    accessToken?: unknown
    refreshToken?: unknown
    expiresAt?: unknown
    refreshTokenExpiresAt?: unknown
    scopes?: unknown
    [key: string]: unknown
  }
  [key: string]: unknown
}

interface NativeProxyState {
  version: 1
  clientToken: string
}

export class ClaudeNativeCredentialError extends Error {
  readonly code: 'missing' | 'invalid' | 'expired'

  constructor(code: ClaudeNativeCredentialError['code'], message: string) {
    super(message)
    this.name = 'ClaudeNativeCredentialError'
    this.code = code
  }
}

export function defaultClaudeCredentialsPath(): string {
  return path.join(homedir(), '.claude', '.credentials.json')
}

export async function loadClaudeCodeCredential(
  credentialsPath: string = defaultClaudeCredentialsPath(),
  now: number = Date.now(),
): Promise<ClaudeNativeCredential> {
  let raw: string
  try {
    raw = await readFile(credentialsPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ClaudeNativeCredentialError(
        'missing',
        'Claude OAuth 자격증명이 없습니다. Claude Code에서 먼저 로그인하세요.',
      )
    }
    throw error
  }

  let parsed: ClaudeCredentialsFile
  try {
    parsed = JSON.parse(raw) as ClaudeCredentialsFile
  } catch {
    throw new ClaudeNativeCredentialError('invalid', 'Claude OAuth 자격증명 파일이 올바른 JSON이 아닙니다.')
  }

  const oauth = parsed.claudeAiOauth
  if (!oauth || typeof oauth.accessToken !== 'string' || oauth.accessToken.length === 0) {
    throw new ClaudeNativeCredentialError('invalid', 'Claude OAuth access token을 읽지 못했습니다.')
  }
  const expiresAt = typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt)
    ? oauth.expiresAt
    : undefined
  if (expiresAt !== undefined && expiresAt <= now) {
    throw new ClaudeNativeCredentialError(
      'expired',
      'Claude OAuth access token이 만료되었습니다. Claude Code에서 다시 인증하세요.',
    )
  }

  return {
    accountId: 'claude-code-default',
    accessToken: oauth.accessToken,
    expiresAt,
    scopes: Array.isArray(oauth.scopes)
      ? oauth.scopes.filter((scope): scope is string => typeof scope === 'string')
      : [],
  }
}

export async function loadClaudeCodeOAuthAccountSnapshot(
  credentialsPath: string = defaultClaudeCredentialsPath(),
): Promise<ClaudeCodeOAuthAccountSnapshot> {
  const parsed = await readCredentialsFile(credentialsPath)
  const oauth = parsed.claudeAiOauth
  if (
    !oauth
    || typeof oauth.accessToken !== 'string'
    || oauth.accessToken.length === 0
    || typeof oauth.refreshToken !== 'string'
    || oauth.refreshToken.length === 0
  ) throw new ClaudeNativeCredentialError('invalid', 'Claude Code OAuth 자격증명을 vault로 가져올 수 없습니다.')
  return {
    nickname: 'Claude Code',
    secret: {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      ...(typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt)
        ? { expiresAt: oauth.expiresAt }
        : {}),
      ...(typeof oauth.refreshTokenExpiresAt === 'number' && Number.isFinite(oauth.refreshTokenExpiresAt)
        ? { refreshTokenExpiresAt: oauth.refreshTokenExpiresAt }
        : {}),
      scopes: Array.isArray(oauth.scopes)
        ? oauth.scopes.filter((scope): scope is string => typeof scope === 'string')
        : [],
    },
  }
}

interface ClaudeOAuthRefreshResponse {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  refresh_token_expires_in?: unknown
  scope?: unknown
}

export interface ClaudeCodeCredentialManagerOptions {
  credentialsPath?: string
  credentialStore?: ClaudeCredentialStore
  accountId?: string
  tokenUrl?: string
  clientId?: string
  fetchImpl?: typeof fetch
  now?: () => number
}

export interface ClaudeCredentialStore {
  read(): Promise<ClaudeCredentialsFile>
  write(expectedRefreshToken: string, updated: ClaudeCredentialsFile): Promise<ClaudeCredentialsFile>
}

async function readCredentialsFile(credentialsPath: string): Promise<ClaudeCredentialsFile> {
  let raw: string
  try {
    raw = await readFile(credentialsPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ClaudeNativeCredentialError(
        'missing',
        'Claude OAuth 자격증명이 없습니다. Claude Code에서 먼저 로그인하세요.',
      )
    }
    throw error
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid shape')
    return parsed as ClaudeCredentialsFile
  } catch {
    throw new ClaudeNativeCredentialError('invalid', 'Claude OAuth 자격증명 파일이 올바른 JSON이 아닙니다.')
  }
}

async function writeCredentialsFile(
  credentialsPath: string,
  expectedRefreshToken: string,
  updated: ClaudeCredentialsFile,
): Promise<ClaudeCredentialsFile> {
  const latest = await readCredentialsFile(credentialsPath)
  if (latest.claudeAiOauth?.refreshToken !== expectedRefreshToken) return latest
  const temporary = `${credentialsPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, credentialsPath)
  await chmod(credentialsPath, 0o600).catch(() => undefined)
  return updated
}

function oauthCredential(
  parsed: ClaudeCredentialsFile,
  now: number,
  allowExpired: boolean,
  accountId: string = 'claude-code-default',
): ClaudeNativeCredential {
  const oauth = parsed.claudeAiOauth
  if (!oauth || typeof oauth.accessToken !== 'string' || oauth.accessToken.length === 0) {
    throw new ClaudeNativeCredentialError('invalid', 'Claude OAuth access token을 읽지 못했습니다.')
  }
  const expiresAt = typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt)
    ? oauth.expiresAt
    : undefined
  if (!allowExpired && expiresAt !== undefined && expiresAt <= now) {
    throw new ClaudeNativeCredentialError(
      'expired',
      'Claude OAuth access token이 만료되었습니다. Claude Code에서 다시 인증하세요.',
    )
  }
  return {
    accountId,
    accessToken: oauth.accessToken,
    expiresAt,
    scopes: Array.isArray(oauth.scopes)
      ? oauth.scopes.filter((scope): scope is string => typeof scope === 'string')
      : [],
  }
}

export class ClaudeCodeCredentialManager {
  private readonly accountId: string
  private readonly credentialStore: ClaudeCredentialStore
  private readonly tokenUrl: string
  private readonly clientId: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private pendingRefresh: Promise<ClaudeNativeCredential> | null = null

  constructor(options: ClaudeCodeCredentialManagerOptions = {}) {
    if (options.credentialsPath && options.credentialStore) {
      throw new Error('credentialsPath와 credentialStore는 동시에 지정할 수 없습니다.')
    }
    const credentialsPath = options.credentialsPath ?? defaultClaudeCredentialsPath()
    this.credentialStore = options.credentialStore ?? {
      read: async () => await readCredentialsFile(credentialsPath),
      write: async (expectedRefreshToken, updated) => await writeCredentialsFile(
        credentialsPath,
        expectedRefreshToken,
        updated,
      ),
    }
    this.accountId = options.accountId ?? 'claude-code-default'
    this.tokenUrl = options.tokenUrl ?? process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL?.replace(/\/$/, '')
      + '/v1/oauth/token'
    if (!options.tokenUrl && !process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL) {
      this.tokenUrl = CLAUDE_CODE_OAUTH_TOKEN_URL
    }
    this.clientId = options.clientId ?? process.env.CLAUDE_CODE_OAUTH_CLIENT_ID ?? CLAUDE_CODE_OAUTH_CLIENT_ID
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
  }

  async getCredential(): Promise<ClaudeNativeCredential> {
    const parsed = await this.credentialStore.read()
    const credential = oauthCredential(parsed, this.now(), true, this.accountId)
    if (credential.expiresAt === undefined || credential.expiresAt > this.now() + REFRESH_SKEW_MS) {
      return credential
    }
    if (!this.pendingRefresh) {
      this.pendingRefresh = this.refresh(parsed).finally(() => {
        this.pendingRefresh = null
      })
    }
    return this.pendingRefresh
  }

  private async refresh(original: ClaudeCredentialsFile): Promise<ClaudeNativeCredential> {
    const oauth = original.claudeAiOauth
    if (!oauth) {
      throw new ClaudeNativeCredentialError('invalid', 'Claude OAuth 자격증명 항목을 읽지 못했습니다.')
    }
    const refreshToken = oauth.refreshToken
    if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
      throw new ClaudeNativeCredentialError(
        'expired',
        'Claude OAuth access token이 만료되었고 refresh token이 없습니다. Claude Code에서 다시 인증하세요.',
      )
    }
    const refreshExpiresAt = typeof oauth.refreshTokenExpiresAt === 'number'
      ? oauth.refreshTokenExpiresAt
      : undefined
    if (refreshExpiresAt !== undefined && refreshExpiresAt <= this.now()) {
      throw new ClaudeNativeCredentialError(
        'expired',
        'Claude OAuth refresh token이 만료되었습니다. Claude Code에서 다시 인증하세요.',
      )
    }
    const scopes = Array.isArray(oauth.scopes)
      ? oauth.scopes.filter((scope): scope is string => typeof scope === 'string')
      : []
    const abort = AbortSignal.timeout(30_000)
    let response: Response
    try {
      response = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: this.clientId,
          scope: (scopes.length > 0 ? scopes : CLAUDE_CODE_DEFAULT_SCOPES).join(' '),
        }),
        signal: abort,
      })
    } catch {
      throw new ClaudeNativeCredentialError('expired', 'Claude OAuth token 갱신 endpoint에 연결하지 못했습니다.')
    }
    if (!response.ok) {
      throw new ClaudeNativeCredentialError(
        'expired',
        `Claude OAuth token 갱신이 HTTP ${response.status}로 실패했습니다. Claude Code에서 다시 인증하세요.`,
      )
    }
    const result = await response.json() as ClaudeOAuthRefreshResponse
    if (
      typeof result.access_token !== 'string'
      || result.access_token.length === 0
      || typeof result.expires_in !== 'number'
      || !Number.isFinite(result.expires_in)
      || result.expires_in <= 0
    ) {
      throw new ClaudeNativeCredentialError('invalid', 'Claude OAuth token 갱신 응답이 올바르지 않습니다.')
    }

    // Claude Code may refresh the same file concurrently. Never overwrite a
    // newer refresh token obtained by the native client.
    const latest = await this.credentialStore.read()
    if (latest.claudeAiOauth?.refreshToken !== refreshToken) {
      return oauthCredential(latest, this.now(), false, this.accountId)
    }
    const updatedScopes = typeof result.scope === 'string'
      ? result.scope.split(/\s+/).filter(Boolean)
      : scopes
    const updated = {
      ...latest,
      claudeAiOauth: {
        ...latest.claudeAiOauth,
        accessToken: result.access_token,
        refreshToken: typeof result.refresh_token === 'string' && result.refresh_token.length > 0
          ? result.refresh_token
          : refreshToken,
        expiresAt: this.now() + result.expires_in * 1_000,
        ...(typeof result.refresh_token_expires_in === 'number'
          ? { refreshTokenExpiresAt: this.now() + result.refresh_token_expires_in * 1_000 }
          : {}),
        scopes: updatedScopes,
      },
    } satisfies ClaudeCredentialsFile
    const persisted = await this.credentialStore.write(refreshToken, updated)
    return oauthCredential(persisted, this.now(), false, this.accountId)
  }
}

export function nativeClaudeProxyStatePath(dataDir: string): string {
  return path.join(dataDir, 'native-claude-proxy.json')
}

function parseNativeProxyState(raw: string): NativeProxyState | null {
  try {
    const parsed = JSON.parse(raw) as Partial<NativeProxyState>
    if (parsed.version !== 1 || typeof parsed.clientToken !== 'string' || parsed.clientToken.length < 32) {
      return null
    }
    return { version: 1, clientToken: parsed.clientToken }
  } catch {
    return null
  }
}

export async function loadOrCreateNativeClaudeProxyToken(dataDir: string): Promise<string> {
  const target = nativeClaudeProxyStatePath(dataDir)
  try {
    const existing = parseNativeProxyState(await readFile(target, 'utf8'))
    if (!existing) throw new Error('Baton Native Claude Proxy token 파일이 손상되었습니다.')
    return existing.clientToken
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  await mkdir(dataDir, { recursive: true })
  const state: NativeProxyState = {
    version: 1,
    clientToken: randomBytes(32).toString('base64url'),
  }
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, target)
  await chmod(target, 0o600).catch(() => undefined)
  return state.clientToken
}
