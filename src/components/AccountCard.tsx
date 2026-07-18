import * as React from 'react'
import { Target, Shield, Moon, Pause, Play, Crosshair, Trash2 } from 'lucide-react'

import type { Account, AccountQuota } from '@/api/types'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from '@/components/ui/dialog'
import { QuotaBar } from '@/components/QuotaBar'

/**
 * Honest account state — every value maps to a real backend fact, never an
 * inert "default" flag (CLIProxy round-robins all non-paused credentials; there
 * is no per-request default lever). See docs/DESIGN.md §5 and the default-concept
 * removal note.
 *
 * - target        : engine spends this account first (engine ON only)
 * - reserve       : kept active as 429 failover reserve (engine ON only)
 * - engine-paused : the engine removed it from rotation to preserve quota (engine ON only)
 * - user-paused   : the user manually removed it from rotation (either mode)
 * - active        : in the round-robin pool, not a distinguished role
 */
export type AccountStatus = 'target' | 'reserve' | 'engine-paused' | 'user-paused' | 'active'

export interface AccountCardProps {
  account: Account
  quota: AccountQuota | null
  status: AccountStatus
  /** Smart-rotation engine on? Gates which manual controls appear. */
  engineEnabled: boolean
  /** True when "이 계정만"(solo) is meaningful: engine OFF, this account active, ≥1 other unpaused sibling. */
  canSolo: boolean
  onPause: () => void
  onResume: () => void
  onSolo: () => void
  onRemove: () => void
}

const STATUS_BADGE: Record<
  AccountStatus,
  { label: string; icon: React.ComponentType<{ className?: string }>; className: string } | null
> = {
  target: { label: '타깃 · 우선 소진', icon: Target, className: 'text-ok' },
  reserve: { label: '예비 · 429 폴백', icon: Shield, className: 'text-muted-foreground' },
  'engine-paused': { label: '엔진 대기 · 쿼터 보존', icon: Moon, className: 'text-muted-foreground' },
  'user-paused': { label: '수동 정지', icon: Pause, className: 'text-warn' },
  active: null,
}

/** Placeholder shown while quota data is still loading (quota === null). */
function QuotaSkeleton() {
  return (
    <div className="space-y-3" aria-hidden>
      {[0, 1].map((i) => (
        <div key={i} className="space-y-1">
          <div className="flex justify-between">
            <Skeleton className="h-3 w-8" />
            <Skeleton className="h-3 w-8" />
          </div>
          <Skeleton className="h-2 w-full" />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  )
}

/**
 * First-class (not error) state for accounts with no quota window yet.
 * The rate-limit window anchors on the first request, so an account that has
 * never been used simply has no data — this is not a "no subscription" state.
 */
function NoQuotaState() {
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-4 text-center">
      <p className="text-sm text-muted-foreground">한도 정보 없음</p>
      <p className="text-xs text-muted-foreground/80">미사용 · 첫 요청 시 한도 창 시작</p>
    </div>
  )
}

export function AccountCard({
  account,
  quota,
  status,
  engineEnabled,
  canSolo,
  onPause,
  onResume,
  onSolo,
  onRemove,
}: AccountCardProps) {
  const [confirmOpen, setConfirmOpen] = React.useState(false)

  const hasNickname = account.nickname && account.nickname !== account.email
  const badge = STATUS_BADGE[status]
  // Engine ON: engine-paused accounts are engine-managed (resuming is futile — it
  // re-pauses next tick), so no manual pause/resume on them. User-paused stays
  // user-resumable in both modes.
  const engineManaged = status === 'engine-paused'

  const handleConfirmRemove = () => {
    setConfirmOpen(false)
    onRemove()
  }

  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex flex-col gap-4 px-4 py-4">
        {/* Identity */}
        <div className="min-w-0 space-y-0.5">
          <p className="truncate text-sm font-semibold text-foreground" title={account.email}>
            {account.email}
          </p>
          {hasNickname && (
            <p className="truncate text-xs text-muted-foreground" title={account.nickname}>
              {account.nickname}
            </p>
          )}
        </div>

        {/* Status badge — row is always rendered (min height reserved) so quota
            bars align across cards in a grid row, even when a card has no badge.
            'active' has no badge (it's the unremarkable in-pool state). */}
        <div className="flex min-h-[1.375rem] flex-wrap items-center gap-1.5">
          {badge && (
            <Badge variant="outline" className={cn('gap-1', badge.className)}>
              <badge.icon className="size-3" aria-hidden />
              {badge.label}
            </Badge>
          )}
        </div>

        {/* Quota */}
        <div className="space-y-3">
          {quota === null ? (
            <QuotaSkeleton />
          ) : quota.windows.length === 0 ? (
            <NoQuotaState />
          ) : (
            quota.windows.map((w, i) => (
              <QuotaBar key={`${w.rateLimitType}-${w.label}-${i}`} window={w} />
            ))
          )}
        </div>

        <Separator />

        {/* Actions — every control maps to a real backend op (pause/resume =
            CLIProxy rotation membership). No "default" (inert for routing). */}
        <div className="flex flex-wrap items-center gap-2">
          {status === 'user-paused' ? (
            <Button variant="outline" size="sm" onClick={onResume}>
              <Play className="size-3" aria-hidden />
              재개
            </Button>
          ) : engineManaged ? (
            <span className="text-xs text-muted-foreground">엔진이 관리 중</span>
          ) : (
            <Button variant="outline" size="sm" onClick={onPause}>
              <Pause className="size-3" aria-hidden />
              일시정지
            </Button>
          )}
          {/* "이 계정만" — honest "prefer this account": pauses the siblings.
              Only when engine is OFF (manual mode) and this account is active. */}
          {!engineEnabled && status === 'active' && (
            <Button variant="outline" size="sm" onClick={onSolo} disabled={!canSolo}>
              <Crosshair className="size-3" aria-hidden />
              이 계정만
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn('ml-auto text-muted-foreground hover:text-danger')}
            aria-label="계정 삭제"
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 className="size-4" aria-hidden />
          </Button>
        </div>
      </CardContent>

      {/* Delete confirmation */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>계정 삭제</DialogTitle>
            <DialogDescription>
              <span className="font-medium text-foreground">{account.email}</span> 계정을
              삭제합니다. 이 작업은 되돌릴 수 없습니다.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">취소</Button>
            </DialogClose>
            <Button variant="destructive" onClick={handleConfirmRemove}>
              <Trash2 className="size-4" aria-hidden />
              삭제
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
