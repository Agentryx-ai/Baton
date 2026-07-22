import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  ClaudeNativeAccountVault,
  type ClaudeNativeSecretProtector,
} from './claude-native-account-vault.ts'
import { ClaudeNativeOAuthManager } from './claude-native-oauth.ts'

class TestProtector implements ClaudeNativeSecretProtector {
  async protect(value: string): Promise<string> { return Buffer.from(value).toString('base64') }
  async unprotect(value: string): Promise<string> { return Buffer.from(value, 'base64').toString('utf8') }
}

async function createVault(): Promise<ClaudeNativeAccountVault> {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-oauth-'))
  return new ClaudeNativeAccountVault({
    filePath: path.join(directory, 'accounts.json'),
    protector: new TestProtector(),
    createId: () => 'account-1',
    now: () => 1_000,
  })
}

test('native Claude OAuth start uses the installed Claude Code PKCE contract', async () => {
  const bytes = [Buffer.alloc(32, 1), Buffer.alloc(24, 2)]
  const manager = new ClaudeNativeOAuthManager({ vault: await createVault(), random: () => bytes.shift()! })
  const { authUrl, state } = manager.start('Primary')
  const url = new URL(authUrl)
  const verifier = Buffer.alloc(32, 1).toString('base64url')

  assert.equal(url.origin + url.pathname, 'https://claude.ai/oauth/authorize')
  assert.equal(url.searchParams.get('client_id'), '9d1c250a-e61b-44d9-88ed-5944d1962f5e')
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:54545/callback')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(verifier).digest('base64url'))
  assert.equal(url.searchParams.get('state'), state)
  assert.equal(url.searchParams.get('scope'), 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload')
})

test('native Claude OAuth exchanges once, enriches identity, stores protected credentials, and rejects replay', async () => {
  const vault = await createVault()
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = []
  const manager = new ClaudeNativeOAuthManager({
    vault,
    random: (size) => Buffer.alloc(size, size),
    now: () => 10_000,
    fetchImpl: async (input, init) => {
      const url = String(input)
      requests.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}) })
      if (url === 'https://api.anthropic.com/api/oauth/profile') {
        return new Response(JSON.stringify({
          account: { uuid: 'acct-uuid', email: 'user@example.com', display_name: 'User Example' },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        expires_in: 3_600,
        refresh_token_expires_in: 7_200,
        scope: 'user:profile user:inference',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const { state } = manager.start()
  const callback = `http://localhost:54545/callback?code=authorization-code&state=${state}`
  const result = await manager.submit(callback)

  const tokenExchanges = () => requests.filter((request) => request.url === 'https://platform.claude.com/v1/oauth/token')
  assert.equal(result.status, 'success')
  assert.equal(tokenExchanges().length, 1)
  assert.equal(tokenExchanges()[0]?.body?.state, state)
  assert.equal(tokenExchanges()[0]?.body?.code, 'authorization-code')
  assert.equal(typeof tokenExchanges()[0]?.body?.code_verifier, 'string')
  // Identity enrichment: real email + stable account id + email-derived nickname.
  assert.equal(result.account?.email, 'user@example.com')
  assert.equal(result.account?.accountId, 'acct-uuid')
  assert.equal(result.account?.nickname, 'user')
  assert.deepEqual(await vault.getSecret('account-1'), {
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    expiresAt: 3_610_000,
    refreshTokenExpiresAt: 7_210_000,
    scopes: ['user:profile', 'user:inference'],
  })
  assert.deepEqual(manager.status(state), result)
  await assert.rejects(manager.submit(callback), /이미 사용되었거나 처리 중/)
  assert.equal(tokenExchanges().length, 1)
})

test('native OAuth stable-identity upsert replaces a Claude Code placeholder with OAuth ownership', async () => {
  const vault = await createVault()
  await vault.put({
    nickname: 'Claude Code',
    accountId: 'acct-uuid',
    source: 'claude-code',
    secret: { accessToken: 'old-access', refreshToken: 'old-refresh', scopes: [] },
  })
  const manager = new ClaudeNativeOAuthManager({
    vault,
    random: (size) => Buffer.alloc(size, 8),
    fetchImpl: async (input) => String(input).includes('/api/oauth/profile')
      ? Response.json({ account: { uuid: 'acct-uuid', email: 'user@example.com' } })
      : Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3_600 }),
  })
  const { state } = manager.start()
  const result = await manager.submit(`http://localhost:54545/callback?code=new-code&state=${state}`)

  assert.equal(result.status, 'success')
  assert.deepEqual((await vault.list()).map(({ id, source, email }) => ({ id, source, email })), [{
    id: 'account-1', source: 'oauth', email: 'user@example.com',
  }])
  assert.equal((await vault.getSecret('account-1')).refreshToken, 'new-refresh')
})

test('native OAuth claims a production-shaped identity-less Claude Code placeholder only after verifying its credential', async () => {
  const vault = await createVault()
  await vault.importClaudeCodeOnce(async () => ({
    nickname: 'Claude Code',
    secret: { accessToken: 'imported-access', refreshToken: 'imported-refresh', scopes: [] },
  }))
  const manager = new ClaudeNativeOAuthManager({
    vault,
    random: (size) => Buffer.alloc(size, 9),
    fetchImpl: async (input, init) => {
      const url = String(input)
      if (!url.includes('/api/oauth/profile')) {
        return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3_600 })
      }
      const authorization = new Headers(init?.headers).get('authorization')
      return Response.json({
        account: authorization === 'Bearer imported-access'
          ? { uuid: 'acct-uuid', email: 'imported@example.com' }
          : { uuid: 'acct-uuid', email: 'user@example.com' },
      })
    },
  })
  const { state } = manager.start()
  const result = await manager.submit(`http://localhost:54545/callback?code=new-code&state=${state}`)

  assert.equal(result.status, 'success')
  assert.deepEqual((await vault.list()).map(({ id, accountId, source }) => ({ id, accountId, source })), [{
    id: 'account-1', accountId: 'acct-uuid', source: 'oauth',
  }])
  assert.equal((await vault.getSecret('account-1')).refreshToken, 'new-refresh')
})

test('repeated OAuth profile failures fail closed without creating identity-less accounts', async () => {
  const vault = await createVault()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const manager = new ClaudeNativeOAuthManager({
      vault,
      random: (size) => Buffer.alloc(size, attempt + 10),
      fetchImpl: async (input) => String(input).includes('/api/oauth/profile')
        ? new Response('{}', { status: 503 })
        : Response.json({
            access_token: `access-${attempt}`,
            refresh_token: `refresh-${attempt}`,
            expires_in: 3_600,
          }),
    })
    const { state } = manager.start()
    const result = await manager.submit(`http://localhost:54545/callback?code=code-${attempt}&state=${state}`)
    assert.equal(result.status, 'error')
  }
  assert.deepEqual(await vault.list(), [])
})

test('native Claude OAuth rejects foreign callbacks and mismatched state without token exchange', async () => {
  let requests = 0
  const manager = new ClaudeNativeOAuthManager({
    vault: await createVault(),
    random: (size) => Buffer.alloc(size, 3),
    fetchImpl: async () => {
      requests += 1
      return new Response('{}')
    },
  })
  const { state } = manager.start()
  await assert.rejects(
    manager.submit(`http://evil.example/callback?code=x&state=${state}`),
    /origin 또는 경로/,
  )
  await assert.rejects(
    manager.submit('http://localhost:54545/callback?code=x&state=wrong'),
    /없거나 만료/,
  )
  assert.equal(requests, 0)
  assert.deepEqual(manager.status(state), { status: 'wait' })
})

test('native Claude OAuth fails closed on token errors and expires or cancels state', async () => {
  let now = 1_000
  const manager = new ClaudeNativeOAuthManager({
    vault: await createVault(),
    random: (size) => Buffer.alloc(size, 4),
    now: () => now,
    flowTtlMs: 100,
    fetchImpl: async () => new Response('{"access_token":"must-not-leak"}', { status: 400 }),
  })
  const first = manager.start()
  const failed = await manager.submit(`http://localhost:54545/callback?code=x&state=${first.state}`)
  assert.deepEqual(failed, { status: 'error', error: 'Claude OAuth token 교환이 HTTP 400로 실패했습니다.' })
  assert.doesNotMatch(JSON.stringify(failed), /must-not-leak/)

  const second = manager.start()
  manager.cancel(second.state)
  assert.throws(() => manager.status(second.state), /없거나 만료/)
  const third = manager.start()
  now += 101
  assert.throws(() => manager.status(third.state), /없거나 만료/)
})
