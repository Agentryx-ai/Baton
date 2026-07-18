import * as React from 'react'
import { RotateCcw } from 'lucide-react'

import type { QuotaWindow } from '@/api/types'
import { cn } from '@/lib/utils'

/** Title-cases a model/feature token from a rate-limit type, e.g. `fable5` → `Fable5`. */
function prettyScope(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

/**
 * Human label for a quota window. Prefers a friendly mapping, falls back to the API label.
 *
 * Beyond the two canonical Claude windows (`five_hour`, `seven_day`), providers may expose
 * extra scoped limits that only appear in the usage response when they exist — e.g. Claude's
 * Fable5-only weekly cap (`seven_day_fable5`) or a Codex feature sub-quota. Those arrive as
 * ordinary `windows[]` entries and render alongside the primary bars; here we give them a
 * clean label instead of the raw type. The gateway's own `label` (when present) always wins.
 */
function windowLabel(w: QuotaWindow): string {
  switch (w.rateLimitType) {
    case 'five_hour':
      return '5h'
    case 'seven_day':
      return '주간'
  }
  if (w.label) return w.label
  const t = w.rateLimitType ?? ''
  const weekly = /^seven_day[_-](.+)$/.exec(t)
  if (weekly) return `주간 · ${prettyScope(weekly[1])}`
  const hourly = /^five_hour[_-](.+)$/.exec(t)
  if (hourly) return `5h · ${prettyScope(hourly[1])}`
  return t || '한도'
}

/** Semantic color bucket for a usage percentage: <60 ok / 60–85 warn / >85 danger. */
function usageBucket(usedPercent: number): 'ok' | 'warn' | 'danger' {
  if (usedPercent > 85) return 'danger'
  if (usedPercent >= 60) return 'warn'
  return 'ok'
}

/** Formats the remaining time until `resetAt` as a compact countdown, or null if already past/invalid. */
function formatCountdown(resetAt: string | null, now: number): string | null {
  if (!resetAt) return null
  const target = Date.parse(resetAt)
  if (Number.isNaN(target)) return null

  const diffMs = target - now
  if (diffMs <= 0) return '곧 리셋'

  const totalMin = Math.floor(diffMs / 60000)
  const days = Math.floor(totalMin / (60 * 24))
  const hours = Math.floor((totalMin % (60 * 24)) / 60)
  const mins = totalMin % 60

  if (days >= 1) return `${days}d ${hours}h 후 리셋`
  if (hours >= 1) return `${hours}h ${mins}m 후 리셋`
  return `${mins}m 후 리셋`
}

/** Ticks a `now` timestamp every `ms` so relative countdowns stay fresh cheaply. */
function useNow(ms = 30000): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

const FILL_CLASS: Record<'ok' | 'warn' | 'danger', string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
}

const TEXT_CLASS: Record<'ok' | 'warn' | 'danger', string> = {
  ok: 'text-muted-foreground',
  warn: 'text-warn',
  danger: 'text-danger',
}

export interface QuotaBarProps {
  window: QuotaWindow
}

export function QuotaBar({ window: w }: QuotaBarProps) {
  const now = useNow()
  const used = Math.max(0, Math.min(100, w.usedPercent))
  const bucket = usageBucket(w.usedPercent)
  const countdown = formatCountdown(w.resetAt, now)

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground tabular-nums">
          {windowLabel(w)}
        </span>
        <span className={cn('text-xs font-semibold tabular-nums', TEXT_CLASS[bucket])}>
          {Math.round(w.usedPercent)}%
        </span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={Math.round(w.usedPercent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={windowLabel(w)}
      >
        <div
          className={cn('h-full rounded-full transition-all', FILL_CLASS[bucket])}
          style={{ width: `${used}%` }}
        />
      </div>
      {countdown && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <RotateCcw className="size-3" aria-hidden />
          <span className="tabular-nums">{countdown}</span>
        </div>
      )}
    </div>
  )
}
