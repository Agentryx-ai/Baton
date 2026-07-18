import { Home, MessageSquareText, Settings } from 'lucide-react'

import { cn } from '@/lib/utils'

export type AppView = 'home' | 'conversations' | 'settings'

const ITEMS: ReadonlyArray<{
  view: AppView
  label: string
  icon: typeof Home
}> = [
  { view: 'home', label: '홈', icon: Home },
  { view: 'conversations', label: '대화', icon: MessageSquareText },
  { view: 'settings', label: '설정', icon: Settings },
]

export function AppNavigation({
  active,
  onNavigate,
  variant,
}: {
  active: AppView
  onNavigate: (view: AppView) => void
  variant: 'mobile' | 'desktop'
}) {
  const items = ITEMS.map((item) => {
    const selected = item.view === active
    return (
      <button
        key={item.view}
        type="button"
        aria-current={selected ? 'page' : undefined}
        onClick={() => onNavigate(item.view)}
        className={cn(
          'flex min-w-0 items-center justify-center gap-2 rounded-lg px-2 py-2 text-sm font-medium transition-colors md:w-full md:justify-start md:px-3',
          selected
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
        )}
      >
        <item.icon className="size-4" aria-hidden />
        {item.label}
      </button>
    )
  })

  if (variant === 'mobile') {
    return (
      <nav
        aria-label="주요 화면"
        className="grid grid-cols-3 gap-1 border-b bg-background px-4 py-2 md:hidden"
      >
        {items}
      </nav>
    )
  }

  return (
    <aside className="hidden w-44 shrink-0 md:block">
      <nav
        aria-label="주요 화면"
        className="sticky top-20 space-y-1 rounded-xl border bg-sidebar p-2 text-sidebar-foreground"
      >
        {items}
      </nav>
    </aside>
  )
}
