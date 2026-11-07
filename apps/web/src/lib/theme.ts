import { useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'changan.theme'
const listeners = new Set<() => void>()

function readInitial(): Theme {
  if (typeof document === 'undefined') return 'dark'
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    // localStorage may be unavailable
  }
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

let current: Theme = readInitial()

/**
 * Paint the attribute as early as possible so the first frame is correct.
 * This happens before React hydrates, which is why <html> in __root.tsx is
 * marked suppressHydrationWarning: the server can't know the saved theme.
 */
if (typeof document !== 'undefined') {
  document.documentElement.dataset.theme = current
}

export function setTheme(next: Theme) {
  current = next
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = next
  try {
    window.localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // ignore write failures
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * One source of truth for the whole app. A per-component `useState` here would
 * leave every other consumer (backdrop colours, card glare, chart ink) stuck on
 * the value it mounted with.
 */
export function useTheme() {
  const theme = useSyncExternalStore(
    subscribe,
    () => current,
    () => 'dark' as Theme,
  )

  return {
    theme,
    toggle: () => setTheme(current === 'dark' ? 'light' : 'dark'),
  }
}
