import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const accountCardModulePath: string = '../src/components/AccountCard.tsx'

const baseProps = {
  account: {
    id: 'account-1', provider: 'claude', isDefault: false,
    email: 'stable-account-label', nickname: 'Claude Code',
  },
  quota: null,
  status: 'active' as const,
  engineEnabled: false,
  canSolo: false,
  onPause() {},
  onResume() {},
  onSolo() {},
  onRemove() {},
}

test('account card renders reauth and quota failures instead of an endless loading skeleton', async () => {
  const { AccountCard } = await import(accountCardModulePath) as {
    AccountCard: React.ComponentType<typeof baseProps & {
      quotaError: { code: string; message: string }
    }>
  }
  const reauth = renderToStaticMarkup(React.createElement(AccountCard, {
    ...baseProps,
    quotaError: { code: 'reauth_required', message: 'Claude 계정을 다시 인증하세요.' },
  }))
  assert.match(reauth, /재로그인 필요/)
  assert.match(reauth, /다시 인증/)
  assert.doesNotMatch(reauth, /animate-pulse/)

  const unavailable = renderToStaticMarkup(React.createElement(AccountCard, {
    ...baseProps,
    quotaError: { code: 'unavailable', message: '한도 endpoint unavailable' },
  }))
  assert.match(unavailable, /한도 조회 실패/)
  assert.match(unavailable, /endpoint unavailable/)
  assert.doesNotMatch(unavailable, /animate-pulse/)
})
