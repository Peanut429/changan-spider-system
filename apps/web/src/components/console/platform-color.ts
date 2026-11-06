const PLATFORM_COLOR: Record<string, string> = {
  youtube: '#ff4d4d',
  x: '#e8f0ec',
  instagram: '#ff5fa2',
  facebook: '#5b9cff',
  tiktok: '#e8f0ec',
  linkedin: '#4a9eff',
  fake: '#8fa79b',
}

/** Phosphor-brightened brand mark: the only saturated colour in the table. */
export function platformColor(code: string): string {
  return PLATFORM_COLOR[code?.toLowerCase()] ?? '#8fa79b'
}
