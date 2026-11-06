import { useEffect, type ReactNode } from 'react'

/**
 * The console scope for a page: token overrides and the page class. The
 * backdrop itself lives in the shell so it survives navigation.
 */
export function ConsolePage({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.classList.add('cx-page')
    return () => document.documentElement.classList.remove('cx-page')
  }, [])

  return <div className="cx">{children}</div>
}
