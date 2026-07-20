import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CodexNativeOAuthError, CodexNativeOAuthManager } from './codex-native-oauth.ts'
import type { NativeAccountSecretProtector } from './native-account-vault.ts'
import { NativeAccountVault } from './native-account-vault.ts'

class TestProtector implements NativeAccountSecretProtector {
  async seal(value: string): Promise<string> { return Buffer.from(value).toString('base64') }
  async open(value: string): Promise<string> { return Buffer.from(value, 'base64').toString() }
}

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'fixture-signature',
  ].join('.')
}

test('Codex OAuth uses source-compatible PKCE and stores exchanged tokens only in the vault', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'baton-codex-oauth-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const vault = new NativeAccountVault({
    vaultPath: path.join(directory, 'accounts.json'),
    protector: new TestProtector(),
  })
  let requestBody = ''
  const oauth = new CodexNativeOAuthManager({
    vault,
    random: (size) => Buffer.alloc(size, size),
    now: () => 1_000,
    fetchImpl: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('content-type'), 'application/x-www-form-urlencoded')
      requestBody = String(init?.body)
      return Response.json({
        id_token: jwt({
          exp: 9_999_999_999,
          'https://api.openai.com/auth': {
            chatgpt_plan_type: 'pro',
            chatgpt_account_id: 'workspace-a',
          },
        }),
        access_token: jwt({ exp: 9_999_999_999 }),
        refresh_token: 'refresh-secret',
      })
    },
  })

  const started = oauth.start('Primary Codex')
  const authUrl = new URL(started.authUrl)
  assert.equal(authUrl.origin, 'https://auth.openai.com')
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(authUrl.searchParams.get('originator'), 'codex_cli_rs')
  assert.match(authUrl.searchParams.get('scope') ?? '', /offline_access/)

  const result = await oauth.submit(
    `http://localhost:1455/auth/callback?code=authorization-code&state=${started.state}`,
  )
  assert.equal(result.status, 'success')
  assert.equal(result.account?.alias, 'Primary Codex')
  const form = new URLSearchParams(requestBody)
  assert.equal(form.get('grant_type'), 'authorization_code')
  assert.equal(form.get('code'), 'authorization-code')
  assert.equal(form.get('redirect_uri'), 'http://localhost:1455/auth/callback')
  assert.ok(form.get('code_verifier'))

  const stored = await vault.readCredential<Record<string, any>>(result.account!.id, 'codex')
  assert.equal(stored.tokens.account_id, 'workspace-a')
  assert.equal(stored.tokens.refresh_token, 'refresh-secret')
  assert.equal('sealedCredential' in result.account!, false)

  await assert.rejects(
    oauth.submit(`http://localhost:1455/auth/callback?code=replay&state=${started.state}`),
    (error: unknown) => error instanceof CodexNativeOAuthError && error.code === 'replayed',
  )
})

test('Codex OAuth rejects a callback outside the registered redirect path', async () => {
  const vault = new NativeAccountVault({ protector: new TestProtector() })
  const oauth = new CodexNativeOAuthManager({ vault, random: (size) => Buffer.alloc(size, 1) })
  const started = oauth.start()
  await assert.rejects(
    oauth.submit(`http://localhost:1457/wrong?code=x&state=${started.state}`),
    (error: unknown) => error instanceof CodexNativeOAuthError && error.code === 'invalid',
  )
})

test('Codex OAuth expires, cancels, rejects replay after failure, and fails closed across restart', async () => {
  const vault = new NativeAccountVault({ protector: new TestProtector() })
  let now = 1_000
  const oauth = new CodexNativeOAuthManager({
    vault,
    now: () => now,
    flowTtlMs: 100,
    random: (size) => Buffer.alloc(size, 2),
    fetchImpl: async () => new Response('upstream rejected', { status: 401 }),
  })

  const cancelled = oauth.start()
  oauth.cancel(cancelled.state)
  assert.throws(
    () => oauth.status(cancelled.state),
    (error: unknown) => error instanceof CodexNativeOAuthError && error.code === 'expired',
  )

  const expired = oauth.start()
  now += 101
  assert.throws(
    () => oauth.status(expired.state),
    (error: unknown) => error instanceof CodexNativeOAuthError && error.code === 'expired',
  )

  const failed = oauth.start()
  const result = await oauth.submit(
    `http://localhost:1455/auth/callback?code=bad-code&state=${failed.state}`,
  )
  assert.equal(result.status, 'error')
  assert.equal(oauth.status(failed.state).status, 'error')
  await assert.rejects(
    oauth.submit(`http://localhost:1455/auth/callback?code=replay&state=${failed.state}`),
    (error: unknown) => error instanceof CodexNativeOAuthError && error.code === 'replayed',
  )

  const pending = oauth.start()
  const restarted = new CodexNativeOAuthManager({ vault })
  assert.throws(
    () => restarted.status(pending.state),
    (error: unknown) => error instanceof CodexNativeOAuthError && error.code === 'expired',
  )
})
