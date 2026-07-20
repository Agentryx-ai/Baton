import { useCallback, useEffect, useState } from 'react'
import { CircleAlert, RefreshCw } from 'lucide-react'

import { client } from '@/api/client'
import type { BatonRuntimeStatus } from '@/api/types'
import { Button } from '@/components/ui/button'

export function BatonStatusCard() {
  const [status, setStatus] = useState<BatonRuntimeStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setStatus(await client.getBatonStatus())
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  return (
    <div className="space-y-3 rounded-md border bg-background/70 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Baton 상태</p>
          <p className="text-xs text-muted-foreground">모델 프록시 인증과 ChatGPT 플러그인 인증을 분리해 표시합니다.</p>
        </div>
        <Button size="sm" variant="ghost" disabled={loading} onClick={() => void refresh()}>
          <RefreshCw className={loading ? 'animate-spin' : ''} />
          새로고침
        </Button>
      </div>

      {status ? (
        <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[11rem_1fr]">
          <dt className="text-muted-foreground">Codex 모델 공급자</dt>
          <dd>{status.codex.modelProvider}</dd>
          <dt className="text-muted-foreground">모델 프록시 인증</dt>
          <dd>{status.codex.providerAuth}</dd>
          <dt className="text-muted-foreground">OpenAI/ChatGPT 로그인</dt>
          <dd>{status.codex.openAiLogin.label}</dd>
          <dt className="text-muted-foreground">원격 플러그인 카탈로그</dt>
          <dd>{status.codex.remotePluginCatalog.state}</dd>
          <dt className="text-muted-foreground">마지막 사용 모델 계정</dt>
          <dd>{status.inferenceAccount?.label ?? '관측값 없음'}</dd>
        </dl>
      ) : null}

      {status?.codex.integrationMode === 'custom-provider' ? (
        <div className="flex items-start gap-2 rounded-md border border-sky-500/30 bg-sky-500/10 p-2 text-xs leading-5">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <p>{status.codex.notice}</p>
        </div>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}
