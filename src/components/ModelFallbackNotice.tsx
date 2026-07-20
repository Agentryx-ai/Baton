import { useState } from 'react'
import { toast } from 'sonner'

import { client } from '@/api/client'
import { pendingModelFallbackOffers } from '@/api/model-fallback'
import type { ModelFallbackStatus } from '@/api/types'
import { usePolling } from '@/hooks/usePolling'
import { Button } from '@/components/ui/button'

const EVENT_LABELS: Record<ModelFallbackStatus['events'][number]['type'], string> = {
  available: '자동전환 사용 가능',
  activated: '자동전환 시작',
  recovered: '원 모델 복귀',
  disabled: '자동전환 해제',
  failed: '자동전환 실패',
  server_event: 'Provider 자동전환',
}

interface ModelFallbackNoticeViewProps {
  status: ModelFallbackStatus
  saving: boolean
  onEnable: () => void
  onDismiss: () => void
  onDisable: (preferredModel: string) => void
}

export function ModelFallbackNoticeView({
  status,
  saving,
  onEnable,
  onDismiss,
  onDisable,
}: ModelFallbackNoticeViewProps) {
  const available = pendingModelFallbackOffers(status.events).at(-1)
  const showPrompt = !status.enabled && !status.promptDismissed && available

  return (
    <div className="mx-auto w-full max-w-5xl space-y-2 px-4 pt-3" aria-live="polite">
      {showPrompt ? (
        <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm" role="alert">
          <p className="font-semibold">{available.preferredModel} 한도가 모든 계정에서 소진되었습니다.</p>
          <p className="mt-1 text-muted-foreground">
            자동 모델전환을 켜면 다음 요청부터 {available.effectiveModel}(으)로 수행하고,
            원 모델이 회복되면 주기적인 제한 확인 후 자동으로 복귀합니다.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" disabled={saving} onClick={onEnable}>자동전환 켜기</Button>
            <Button size="sm" variant="outline" disabled={saving} onClick={onDismiss}>
              다시 보지 않기
            </Button>
          </div>
        </div>
      ) : null}

      {status.active.map((fallback) => (
        <div
          key={fallback.preferredModel}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-500/50 bg-sky-500/10 px-4 py-3 text-sm"
          role="status"
        >
          <div>
            <p className="font-semibold">
              자동전환됨: {fallback.preferredModel} → {fallback.effectiveModel}
            </p>
            <p className="mt-1 text-muted-foreground">
              선호 모델 설정은 그대로 유지됩니다. 원 모델 한도가 회복되면 자동으로 복귀합니다.
              {fallback.accountAlias ? ` 현재 계정: ${fallback.accountAlias}.` : ''}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={() => onDisable(fallback.preferredModel)}
          >
            자동전환 끄기
          </Button>
        </div>
      ))}

      {status.events.length > 0 ? (
        <details className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs">
          <summary className="cursor-pointer select-none font-medium">최근 모델 전환 이벤트</summary>
          <ol className="mt-2 space-y-1.5 text-muted-foreground">
            {status.events.slice(-5).reverse().map((event) => (
              <li key={event.id}>
                <time dateTime={new Date(event.at).toISOString()}>
                  {new Date(event.at).toLocaleString()}
                </time>
                {' · '}{EVENT_LABELS[event.type]} · {event.preferredModel} → {event.effectiveModel}
                {event.category ? ` · ${event.category}` : ''}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  )
}

export function ModelFallbackNotice() {
  const { data, refresh } = usePolling<ModelFallbackStatus>(client.getModelFallback, 5_000)
  const [saving, setSaving] = useState(false)

  const update = async (settings: {
    enabled?: boolean
    promptDismissed?: boolean
  }, successMessage: string) => {
    setSaving(true)
    try {
      await client.setModelFallback(settings)
      toast.success(successMessage)
      refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  if (!data) return null

  return (
    <ModelFallbackNoticeView
      status={data}
      saving={saving}
      onEnable={() => void update(
        { enabled: true, promptDismissed: false },
        '자동 모델전환을 켰습니다.',
      )}
      onDismiss={() => void update(
        { promptDismissed: true },
        '자동전환 안내를 다시 표시하지 않습니다.',
      )}
      onDisable={(preferredModel) => void update(
        { enabled: false, promptDismissed: true },
        `${preferredModel} 원 모델로 다시 시도합니다.`,
      )}
    />
  )
}
