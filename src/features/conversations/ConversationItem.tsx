import { Bot, Brain, CircleAlert, Gauge, UserRound } from 'lucide-react'

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
  const requestedModel = typeof item.payload.requestedModel === 'string'
    ? friendlyModel(item.payload.requestedModel)
    : null
  const actualModel = typeof item.payload.actualModel === 'string'
    ? friendlyModel(item.payload.actualModel)
    : null
  const effort = typeof item.payload.effort === 'string' ? item.payload.effort : null
  const modelFallback = requestedModel && actualModel && requestedModel !== actualModel


  if (item.kind === 'user_message') {
    return (
      <article className="ml-auto max-w-[88%] rounded-2xl bg-muted px-4 py-3 sm:max-w-[78%]">
        <div className="whitespace-pre-wrap break-words text-[0.9375rem] leading-6 text-foreground">
          {body}
        </div>
      </article>
    )
  }

  if (isReasoning) {
    return (
      <details className="text-sm text-muted-foreground">
        <summary className="flex cursor-pointer select-none items-center gap-2 rounded-md py-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <ItemIcon kind={item.kind} />
          <span className="font-medium">추론 요약</span>
        </summary>
        <div className="mt-2 border-l-2 pl-4 italic leading-6">{body}</div>
        <details className="mt-2 pl-4 text-xs">
          <summary className="cursor-pointer select-none hover:text-foreground">세부 정보</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 font-mono text-[0.6875rem] text-foreground">
            {payloadDetail(item)}
          </pre>
        </details>
      </details>
    )
  }

  return (
    <article
      role={isError ? 'alert' : undefined}
      className={cn(
        item.kind === 'assistant_message' ? 'py-1' : 'rounded-xl border px-4 py-3',
        isUsage && 'border-dashed bg-muted/20',
        isError && 'border-destructive/40 bg-destructive/10',
      )}
    >
      <header
        className={cn(
          'mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground',
          isError && 'text-destructive',
        )}
      >
        <ItemIcon kind={item.kind} />
        <span className="font-medium text-foreground">{ITEM_LABEL[item.kind]}</span>
        {item.provider ? (
          <span>{PROVIDER_LABEL[item.provider]}</span>
        ) : null}
        {requestedModel ? (
          <span className={cn(modelFallback && 'font-medium text-warn')}>
            {modelFallback ? `${requestedModel} → ${actualModel}` : requestedModel}
            {effort ? ` · ${effortLabel(effort)}` : ''}
          </span>
        ) : null}
      </header>

      <div
        className={cn(
          'whitespace-pre-wrap break-words text-[0.9375rem] leading-7 text-foreground',
          isUsage && 'font-mono text-xs text-muted-foreground',
          isError && 'font-medium text-destructive',
        )}
      >
        {isError && <span aria-hidden>■ </span>}
        {body}
      </div>

      {showRawDetail && (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            세부 정보
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background/70 p-2 font-mono text-[0.6875rem] text-foreground">
            {payloadDetail(item)}
          </pre>
        </details>
      )}
    </article>
  )
}

function friendlyModel(model: string): string {
  return model
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .split('-')
    .map((part) => /^\d+$/.test(part) ? part : part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

function effortLabel(effort: string): string {
  if (effort === 'xhigh') return 'Extra High'
  return effort[0]?.toUpperCase() + effort.slice(1)
}
