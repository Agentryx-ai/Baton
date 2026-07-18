/* oxlint-disable react/only-export-components -- colocated pure presenter is covered by UI tests */
import { useState } from 'react'
import { Bot, Brain, ChevronRight, CircleAlert, FilePenLine, Gauge, UserRound, Wrench } from 'lucide-react'

import { cn } from '@/lib/utils'

import {
  activityFailed,
  activitySummary,
  ITEM_LABEL,
  isLongConversationText,
  PROVIDER_LABEL,
  payloadDetail,
  payloadText,
  usageSummary,
} from './conversation-presentation'
import type { CanonicalItemDto, CanonicalTurnDto } from './types'
import type { AssistantLabelMode } from './session-view-preferences'

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

export function ConversationItem({
  item,
  toolResult = null,
  assistantLabelMode = 'provider',
  modelDisplayNames = {},
  turn = null,
}: {
  item: CanonicalItemDto
  toolResult?: CanonicalItemDto | null
  assistantLabelMode?: AssistantLabelMode
  modelDisplayNames?: Readonly<Record<string, string>>
  turn?: Pick<CanonicalTurnDto, 'model' | 'effort'> | null
}) {
  const isError = item.kind === 'error'
  const isReasoning = item.kind === 'reasoning_summary'
  const isUsage = item.kind === 'usage'
  const body = isUsage ? usageSummary(item.payload) : payloadText(item)
  const showRawDetail = isError || isReasoning || isUsage || item.kind === 'provider_event'
  const metadata = assistantExecutionMetadata(item, turn)
  const requestedModel = metadata.requestedModel
    ? friendlyModel(metadata.requestedModel, modelDisplayNames)
    : null
  const observedModel = typeof item.payload.reportedModel === 'string'
    ? friendlyModel(item.payload.reportedModel, modelDisplayNames)
    : typeof item.payload.resolvedModel === 'string'
      ? friendlyModel(item.payload.resolvedModel, modelDisplayNames)
      : typeof item.payload.actualModel === 'string'
        ? friendlyModel(item.payload.actualModel, modelDisplayNames)
        : null
  const displayModel = requestedModel ?? observedModel
  const effort = metadata.effort
  const modelFallback = requestedModel && observedModel && requestedModel !== observedModel
  const assistantHeader = item.kind === 'assistant_message'
    ? assistantLabel(item, assistantLabelMode)
    : null
  const isToolActivity = item.kind === 'tool_call'
    || item.kind === 'tool_result'
    || item.kind === 'file_change'
    || item.kind === 'provider_event'

  if (isToolActivity) {
    const failed = activityFailed(item) || (toolResult ? activityFailed(toolResult) : false)
    const ActivityIcon = item.kind === 'file_change' ? FilePenLine : Wrench
    return (
      <details className={cn('group/activity text-sm text-muted-foreground', failed && 'text-destructive')}>
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ActivityIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate font-medium">{activitySummary(item, toolResult)}</span>
          <ChevronRight className="ml-auto size-3.5 shrink-0 opacity-50 transition-transform group-open/activity:rotate-90" aria-hidden />
        </summary>
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 font-mono text-[0.6875rem] text-foreground">
          {payloadDetail(item)}
          {toolResult ? `\n\n결과\n${payloadDetail(toolResult)}` : ''}
        </pre>
      </details>
    )
  }

  if (item.kind === 'user_message') {
    return (
      <article className="ml-auto max-w-[88%] rounded-2xl bg-muted px-4 py-3 sm:max-w-[78%]">
        <LongContent text={body} className="text-[0.9375rem] leading-6 text-foreground" fadeClassName="after:from-muted" />
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
        <div className="mt-2 border-l-2 pl-4 italic leading-6"><LongContent text={body} /></div>
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
        <span className="font-medium text-foreground">{assistantHeader ?? ITEM_LABEL[item.kind]}</span>
        {item.provider && item.kind !== 'assistant_message' ? (
          <span>{PROVIDER_LABEL[item.provider]}</span>
        ) : null}
        {displayModel ? (
          <span className={cn(modelFallback && 'font-medium text-warn')}>
            {modelFallback ? `${requestedModel} → ${observedModel}` : displayModel}
            {effort ? ` · ${effortLabel(effort)}` : ''}
          </span>
        ) : null}
      </header>

      <LongContent
        text={body}
        className={cn(
          'text-[0.9375rem] leading-7 text-foreground',
          isUsage && 'font-mono text-xs text-muted-foreground',
          isError && 'font-medium text-destructive',
        )}
      />

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

export function assistantExecutionMetadata(
  item: CanonicalItemDto,
  turn: Pick<CanonicalTurnDto, 'model' | 'effort'> | null = null,
): { requestedModel: string | null; effort: string | null } {
  return {
    requestedModel: typeof item.payload.requestedModel === 'string'
      ? item.payload.requestedModel
      : turn?.model ?? null,
    effort: typeof item.payload.effort === 'string'
      ? item.payload.effort
      : turn?.effort ?? null,
  }
}

function LongContent({
  text,
  className,
  fadeClassName = 'after:from-background',
}: {
  text: string
  className?: string
  fadeClassName?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const collapsible = isLongConversationText(text)
  return (
    <div>
      <div
        className={cn(
          'relative whitespace-pre-wrap break-words',
          collapsible && !expanded && 'max-h-72 overflow-hidden after:absolute after:inset-x-0 after:bottom-0 after:h-16 after:bg-gradient-to-t after:to-transparent',
          collapsible && !expanded && fadeClassName,
          className,
        )}
      >
        {text}
      </div>
      {collapsible ? (
        <button
          type="button"
          className="mt-2 rounded-md text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? '접기' : '더 보기'}
        </button>
      ) : null}
    </div>
  )
}

function assistantLabel(item: CanonicalItemDto, mode: AssistantLabelMode): string {
  const provider = item.provider ? PROVIDER_LABEL[item.provider] : null
  if (mode === 'assistant' || !provider) return 'Assistant'
  if (mode === 'both') return `Assistant · ${provider}`
  return provider
}

export function friendlyModel(
  model: string,
  displayNames: Readonly<Record<string, string>> = {},
): string {
  const catalogName = displayNames[model]
  if (catalogName) return catalogName

  const withoutDate = model.replace(/-\d{8}$/, '')
  const gpt = /^gpt-([^-]+)(?:-(.+))?$/i.exec(withoutDate)
  if (gpt) {
    const suffix = gpt[2] ? ` ${titleModelParts(gpt[2].split('-'))}` : ''
    return `GPT-${gpt[1]}${suffix}`
  }

  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?(?:-(.+))?$/i.exec(withoutDate)
  if (claude) {
    const version = `${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`
    const suffix = claude[4] ? ` ${titleModelParts(claude[4].split('-'))}` : ''
    return `${titleModelPart(claude[1])} ${version}${suffix}`
  }

  return titleModelParts(withoutDate.replace(/^claude-/, '').split('-'))
}

function titleModelParts(parts: string[]): string {
  return parts.map(titleModelPart).join(' ')
}

function titleModelPart(part: string): string {
  if (/^o\d+$/i.test(part)) return part.toUpperCase()
  if (/^\d+(?:\.\d+)*$/.test(part)) return part
  return part ? part[0]!.toUpperCase() + part.slice(1) : part
}

function effortLabel(effort: string): string {
  if (effort === 'xhigh') return 'Extra High'
  return effort[0]?.toUpperCase() + effort.slice(1)
}
