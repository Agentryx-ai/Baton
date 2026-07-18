import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTheme } from '@/components/theme'

/**
 * Light/dark toggle. Hydration-safe: renders a stable placeholder until mounted,
 * because `resolvedTheme` is undefined during SSR / before the client hydrates.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  const isDark = resolvedTheme === 'dark'

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="테마 전환"
      title={mounted ? (isDark ? '라이트 모드' : '다크 모드') : '테마 전환'}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
    >
      {/* Until mounted, render neutral (Sun) to avoid a hydration mismatch. */}
      {mounted && isDark ? <Moon /> : <Sun />}
    </Button>
  )
}
