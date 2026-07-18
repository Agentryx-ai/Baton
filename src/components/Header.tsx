import { useEffect, useState } from 'react'
import { GitBranch, RefreshCw } from 'lucide-react'

import type { ProxyStatus } from '@/api/types'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ThemeToggle } from '@/components/ThemeToggle'

interface HeaderProps {
  proxy: ProxyStatus | null
  onRefresh: () => void
}

/** Format an elapsed duration from an ISO start time into "42m" / "1h 3m" / "2d 4h". */
function formatUptime(startedAt: string): string | null {
  const started = new Date(startedAt).getTime()
  if (Number.isNaN(started)) return null

  const totalSec = Math.max(0, Math.floor((Date.now() - started) / 1000))
  const totalMin = Math.floor(totalSec / 60)

  if (totalMin < 1) return `${totalSec}s`
  if (totalMin < 60) return `${totalMin}m`

  const totalHr = Math.floor(totalMin / 60)
  if (totalHr < 24) {
    const min = totalMin % 60
    return min ? `${totalHr}h ${min}m` : `${totalHr}h`
  }

  const days = Math.floor(totalHr / 24)
  const hr = totalHr % 24
  return hr ? `${days}d ${hr}h` : `${days}d`
}

function ProxyPill({ proxy }: { proxy: ProxyStatus | null }) {
  // Re-render on a cadence so the uptime label stays live between prop updates.
  const [, force] = useState(0)
  useEffect(() => {
    if (!proxy?.running) return
    const id = setInterval(() => force((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [proxy?.running])

  const running = proxy?.running ?? false
  const uptime = proxy?.startedAt ? formatUptime(proxy.startedAt) : null

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium',
        running
          ? 'border-border bg-muted/50 text-foreground'
          : 'border-border bg-muted/30 text-muted-foreground'
      )}
    >
      <span
        className={cn(
          'size-2 shrink-0 rounded-full',
          running ? 'bg-emerald-500' : 'bg-muted-foreground/50'
        )}
        aria-hidden
      />
      {running ? (
        <span className="tabular-nums">
          Proxy :{proxy?.port}
          {uptime ? ` · ${uptime}` : ''}
        </span>
      ) : (
        <span>Proxy 정지</span>
      )}
    </div>
  )
}

export function Header({ proxy, onRefresh }: HeaderProps) {
  const [spinning, setSpinning] = useState(false)

  const handleRefresh = () => {
    setSpinning(true)
    onRefresh()
    // Brief visual spin; refresh itself is fire-and-forget from here.
    window.setTimeout(() => setSpinning(false), 600)
  }

  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4">
        {/* Wordmark */}
        <div className="flex items-center gap-2 font-semibold tracking-tight">
          <GitBranch className="size-5 text-primary" aria-hidden />
          <span>Baton</span>
        </div>

        {/* Proxy status */}
        <div className="ml-2 flex min-w-0 flex-1 items-center">
          <ProxyPill proxy={proxy} />
        </div>

        {/* Right cluster */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="새로고침"
            title="새로고침"
            onClick={handleRefresh}
          >
            <RefreshCw className={cn(spinning && 'animate-spin')} />
          </Button>
          <ThemeToggle />
        </div>
      </div>
    </header>
  )
}
