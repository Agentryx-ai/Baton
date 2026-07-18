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
  variant: 'mobile' | 'desktop' | 'embedded'
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
          'flex min-w-0 items-center gap-2 rounded-lg py-2 text-sm font-medium transition-colors',
          variant === 'mobile' ? 'justify-center px-2' : 'w-full justify-start px-3',
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

  const navigation = (
    <nav aria-label="주요 화면" className="space-y-1 p-3">
      {items}
    </nav>
  )

  if (variant === 'embedded') return navigation

  return (
    <aside className="hidden w-72 shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:block">
      {navigation}
    </aside>
  )
}
