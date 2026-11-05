import { cn } from '@/lib/utils'

const PLATFORM_META: Record<string, { label: string; short: string; className: string }> = {
  youtube: { label: 'YouTube', short: 'YT', className: 'bg-red-50 text-red-700 ring-red-200/70' },
  x: { label: 'X', short: 'X', className: 'bg-zinc-900 text-zinc-50 ring-zinc-700/30' },
  instagram: { label: 'Instagram', short: 'IG', className: 'bg-pink-50 text-pink-700 ring-pink-200/70' },
  facebook: { label: 'Facebook', short: 'FB', className: 'bg-blue-50 text-blue-700 ring-blue-200/70' },
  tiktok: { label: 'TikTok', short: 'TT', className: 'bg-cyan-50 text-cyan-800 ring-cyan-200/70' },
  linkedin: { label: 'LinkedIn', short: 'IN', className: 'bg-sky-50 text-sky-700 ring-sky-200/70' },
  fake: { label: 'Fake', short: 'FX', className: 'bg-muted text-muted-foreground ring-border' },
}

export function platformLabel(code: string): string {
  return PLATFORM_META[code]?.label || code
}

export function PlatformBadge({ code, className }: { code: string; className?: string }) {
  const meta = PLATFORM_META[code] || {
    label: code,
    short: code.slice(0, 2).toUpperCase(),
    className: 'bg-muted text-muted-foreground ring-border',
  }
  return (
    <span className={cn('inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset', meta.className, className)}>
      <span className="grid size-5 place-items-center rounded-full bg-white/70 text-[10px] font-semibold tracking-tight ring-1 ring-black/5">
        {meta.short}
      </span>
      {meta.label}
    </span>
  )
}
