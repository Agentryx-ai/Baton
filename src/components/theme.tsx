import { ThemeProvider as NextThemesProvider, useTheme } from 'next-themes'

/**
 * App-configured theme provider. Wrap the app tree with this in App/main.
 * class-based dark mode, follows system by default, manual override persisted.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  )
}

export { useTheme }
