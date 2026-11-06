const PLATFORM_COLOR: Record<string, string> = {
  youtube: '#c4302b',
  x: '#0f1419',
  instagram: '#c13584',
  facebook: '#1877f2',
  tiktok: '#111111',
  linkedin: '#0a66c2',
  fake: '#8a8f84',
}

/** A 7px brand mark, the only saturated colour in the table. */
export function platformColor(code: string): string {
  return PLATFORM_COLOR[code?.toLowerCase()] ?? '#8a8f84'
}
