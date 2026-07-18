import { ChevronRight } from 'lucide-react'

import type { Account, PolicyId, PolicyState, SteerLogEntry } from '@/api/types'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'

const POLICY_NAME: Record<PolicyId, string> = {
  'reset-imminent-first': '리셋 임박 우선 소진',
}

const PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  ghcp: 'GitHub Copilot',
}

const ACTION_STYLE: Record<SteerLogEntry['action'], string> = {
  target: 'text-ok',
  pause: 'text-warn',
  resume: 'text-ok',
  info: 'text-muted-foreground',
  error: 'text-danger',
}

const ACTION_LABEL: Record<SteerLogEntry['action'], string> = {
  target: '타깃',
  pause: '일시정지',
  resume: '재개',
  info: '정보',
  error: '오류',
}

function providerName(p: string): string {
  return PROVIDER_LABEL[p] ?? p
}

/** Resolve an account id to its nickname/email so the panel matches the log lines. */
function accountLabel(
  accounts: Record<string, Account[]> | null | undefined,
  provider: string,
  id: string | null,
): string {
  if (!id) return '없음'
  const a = accounts?.[provider]?.find((x) => x.id === id)
  return a ? a.nickname || a.email || a.id : id
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export interface RotationPanelProps {
  state: PolicyState | null
  /** Account lists per provider, to resolve target/reserve ids to human labels. */
  accounts?: Record<string, Account[]> | null
  onToggle: (enabled: boolean) => void
}

export function RotationPanel({ state, accounts, onToggle }: RotationPanelProps) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">스마트 로테이션</h2>
        <Switch
          checked={state?.enabled ?? false}
          disabled={state === null}
          onCheckedChange={onToggle}
          aria-label="스마트 로테이션 토글"
        />
      </div>

      {state === null ? (
        <p className="mt-3 text-sm text-muted-foreground">로테이션 상태 불러오는 중…</p>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="space-y-1 text-sm">
            <div className="flex gap-2">
              <span className="text-muted-foreground">정책</span>
              <span className="text-foreground">
                {POLICY_NAME[state.policy] ?? state.policy}
              </span>
            </div>
            <div className="flex gap-2">
              <span className="shrink-0 text-muted-foreground">현재 타깃</span>
              <div className="flex flex-col gap-0.5">
                {state.providers.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  state.providers.map((p) => (
                    <span key={p.provider} className="text-foreground tabular-nums">
                      {providerName(p.provider)} → {accountLabel(accounts, p.provider, p.target)}
                      {p.reserve && (
                        <span className="text-muted-foreground">
                          {' '}
                          (예비: {accountLabel(accounts, p.provider, p.reserve)})
                        </span>
                      )}
                    </span>
                  ))
                )}
              </div>
            </div>
          </div>

          <Collapsible>
            <CollapsibleTrigger className="group flex w-full items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground">
              <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
              조향 로그
              <span className="text-xs text-muted-foreground/70">
                (최근 {Math.min(state.log.length, 20)}건)
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Separator className="my-2" />
              {state.log.length === 0 ? (
                <p className="py-2 text-xs text-muted-foreground">기록된 조향 이벤트가 없습니다.</p>
              ) : (
                <ul className="max-h-64 space-y-1 overflow-y-auto pr-1">
                  {state.log
                    .slice(-20)
                    .reverse()
                    .map((entry, i) => (
                      <li
                        key={`${entry.ts}-${i}`}
                        className="flex items-baseline gap-2 text-xs"
                      >
                        <span className="shrink-0 text-muted-foreground tabular-nums">
                          {formatTime(entry.ts)}
                        </span>
                        <span
                          className={cn(
                            'shrink-0 font-medium tabular-nums',
                            ACTION_STYLE[entry.action],
                          )}
                        >
                          {ACTION_LABEL[entry.action]}
                        </span>
                        {entry.accountId && (
                          <span className="shrink-0 text-muted-foreground tabular-nums">
                            {entry.accountId}
                          </span>
                        )}
                        <span className="min-w-0 text-muted-foreground">{entry.reason}</span>
                      </li>
                    ))}
                </ul>
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}
    </section>
  )
}
