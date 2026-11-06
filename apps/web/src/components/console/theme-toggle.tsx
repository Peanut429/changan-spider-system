import { Moon, Sun } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Theme } from '@/lib/theme'

/**
 * A two-position switch rather than a button: the thumb carries the sun and the
 * moon, so the state is legible before you press it, and it slides rather than
 * swapping icons in place.
 */
export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const dark = theme === 'dark'

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={dark ? '切换到亮色' : '切换到暗色'}
      aria-pressed={!dark}
      className="cx-toggle group"
      data-dark={dark ? 'true' : 'false'}
    >
      <span className="cx-toggle-track" aria-hidden="true">
        <span className="cx-toggle-thumb">
          <Sun className={cn('cx-toggle-glyph', dark ? 'cx-toggle-glyph--out' : 'cx-toggle-glyph--in')} strokeWidth={2} />
          <Moon className={cn('cx-toggle-glyph', dark ? 'cx-toggle-glyph--in' : 'cx-toggle-glyph--out')} strokeWidth={2} />
        </span>
      </span>
    </button>
  )
}
