import { Bot, Brain, CircleAlert, Gauge, UserRound } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

import {
  ITEM_LABEL,
  PROVIDER_LABEL,
  payloadDetail,
  payloadText,
  usageSummary,
} from './conversation-presentation'
import type { CanonicalItemDto } from './types'

const ICON = {
  user_message: UserRound,
  assistant_message: Bot,
  reasoning_summary: Brain,
  usage: Gauge,
  error: CircleAlert,
} as const

function ItemIcon({ kind }: { kind: CanonicalItemDto['kind'] }) {
  const Icon = ICON[kind as keyof typeof ICON]
  return Icon ? <Icon className="size-3.5" aria-hidden /> : null
}

export function ConversationItem({ item }: { item: CanonicalItemDto }) {
  const isError = item.kind === 'error'
  const isReasoning = item.kind === 'reasoning_summary'
  const isUsage = item.kind === 'usage'
  const body = isUsage ? usageSummary(item.payload) : payloadText(item)
  const showRawDetail = isError || isReasoning || isUsage || item.kind === 'provider_event'

  return (
    <article
      role={isError ? 'alert' : undefined}
      className={cn(
        'rounded-md border px-3 py-2',
        item.kind === 'user_message' && 'ml-auto max-w-[92%] border-primary/25 bg-primary/5',
        item.kind === 'assistant_message' && 'border-border bg-background',
        isReasoning && 'border-dashed bg-muted/30',
        isUsage && 'border-dashed bg-muted/20',
        isError && 'border-destructive/40 bg-destructive/10',
      )}
    >
      <header
        className={cn(
          'mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground',
          isError && 'text-destructive',
        )}
      >
        <ItemIcon kind={item.kind} />
        <span className="font-medium text-foreground">{ITEM_LABEL[item.kind]}</span>
        {item.provider && <span>{PROVIDER_LABEL[item.provider]}</span>}
        <span>#{item.sequence}</span>
        {item.visibility !== 'portable' && <Badge variant="outline">{item.visibility}</Badge>}
      </header>

      <div
        className={cn(
          'whitespace-pre-wrap break-words text-sm text-foreground',
          isReasoning && 'italic text-muted-foreground',
          isUsage && 'font-mono text-xs text-muted-foreground',
          isError && 'font-medium text-destructive',
        )}
      >
        {isError && <span aria-hidden>■ </span>}
        {isReasoning && <span aria-hidden>• </span>}
        {body}
      </div>

      {showRawDetail && (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            세부 정보 보기
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background/70 p-2 font-mono text-[0.6875rem] text-foreground">
            {payloadDetail(item)}
          </pre>
        </details>
      )}
    </article>
  )
}
