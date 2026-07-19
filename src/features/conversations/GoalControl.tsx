import { useId, useState } from 'react'
import { AlertTriangle, ChevronRight, CirclePause, CirclePlay, LoaderCircle, Pencil, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import {
  formatGoalDuration,
  formatGoalReason,
  formatGoalTokens,
  formatGoalTurns,
  goalStatusPresentation,
  type GoalWorkStatus,
  type GoalStatusTone,
  type GoalView,
} from './goal-presentation'

export type GoalAction = 'edit' | 'pause' | 'resume' | 'clear'

export interface GoalControlProps {
  goal: GoalView
  workStatus?: GoalWorkStatus
  busyAction?: GoalAction | null
  disabledActions?: readonly GoalAction[]
  defaultExpanded?: boolean
  className?: string
  onAction: (action: GoalAction) => void
}

const STATUS_CLASS: Record<GoalStatusTone, string> = {
  active: 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
  muted: 'bg-muted text-muted-foreground',
  warning: 'bg-amber-500/12 text-amber-800 dark:text-amber-300',
  success: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
}

export function GoalControl({
  goal,
  workStatus,
  busyAction = null,
  disabledActions = [],
  defaultExpanded = false,
  className,
  onAction,
}: GoalControlProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const detailsId = useId()
  const status = goalStatusPresentation(goal.status, workStatus)
  const latestReason = formatGoalReason(goal.statusReason)
  const showPersistentReason = status.tone === 'warning' && latestReason !== null
  const disabled = new Set(disabledActions)
  const isBusy = busyAction !== null
  const canPause = goal.status === 'active'
  const canResume = ['paused', 'blocked', 'usage_limited', 'budget_limited'].includes(goal.status)

  const actionButton = (
    action: GoalAction,
    label: string,
    icon: typeof Pencil,
    unavailable = false,
  ) => {
    const Icon = busyAction === action ? LoaderCircle : icon
    const actionDisabled = isBusy || disabled.has(action) || unavailable
    return (
      <Button
        key={action}
        type="button"
        variant="ghost"
        size="xs"
        disabled={actionDisabled}
        aria-label={label}
        aria-busy={busyAction === action || undefined}
        onClick={() => onAction(action)}
      >
        <Icon className={cn('size-3', busyAction === action && 'animate-spin')} aria-hidden />
        {label}
      </Button>
    )
  }

  return (
    <section
      className={cn('rounded-xl border bg-card/80 text-card-foreground shadow-xs', className)}
      aria-label="완수 목표"
      aria-busy={isBusy || undefined}
    >
      <div className="flex min-w-0 items-center gap-1 p-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((current) => !current)}
        >
          <ChevronRight
            className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')}
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{goal.objective}</span>
          <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium', STATUS_CLASS[status.tone])}>
            {status.label}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-0.5" aria-label="목표 작업">
          {canPause ? actionButton('pause', '일시 정지', CirclePause) : null}
          {canResume ? actionButton('resume', '재개', CirclePlay) : null}
          {actionButton('edit', '목표 수정', Pencil)}
          {actionButton('clear', '목표 지우기', Trash2)}
        </div>
      </div>

      {showPersistentReason ? (
        <div
          className="flex gap-2 border-t border-amber-500/20 bg-amber-500/8 px-3 py-2 text-xs text-amber-950 dark:text-amber-100"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          <div className="min-w-0">
            <p className="font-medium">작업이 차단되었습니다</p>
            <p className="mt-0.5 break-words leading-5 text-amber-900/80 dark:text-amber-100/75">{latestReason}</p>
          </div>
        </div>
      ) : null}

      {expanded ? (
        <div id={detailsId} className="max-h-[min(24rem,45vh)] overflow-y-auto border-t px-3 py-3">
          <p className="whitespace-pre-wrap break-words text-sm leading-6">{goal.objective}</p>

          <dl className="mt-3 grid grid-cols-1 gap-x-5 gap-y-2 text-xs sm:grid-cols-3">
            <Metric label="활성 시간" value={formatGoalDuration(goal.timeUsedSeconds)} />
            <Metric label="자동 실행" value={formatGoalTurns(goal.automaticTurnsUsed, goal.maxAutomaticTurns)} />
            <Metric label="토큰" value={formatGoalTokens(goal.tokensUsed, goal.tokenBudget)} />
          </dl>

          {latestReason && !showPersistentReason ? (
            <p className="mt-3 rounded-lg bg-muted/60 px-2.5 py-2 text-xs leading-5 text-muted-foreground">
              <span className="font-medium text-foreground">최근 상태</span>
              <span className="mx-1.5" aria-hidden>·</span>
              {latestReason}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate font-medium tabular-nums" title={value}>{value}</dd>
    </div>
  )
}
