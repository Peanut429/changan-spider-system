/**
 * Platform identity as a CSS variable, so the mark brightens on the dark panel
 * and darkens on paper. The values live in console.css.
 */
export function platformColor(code: string): string {
  return `var(--cx-plat-${code?.toLowerCase()}, var(--cx-ink-3))`
}
