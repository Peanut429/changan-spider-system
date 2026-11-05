import type { LucideIcon } from 'lucide-react'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'

export function SummaryCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'default',
  delay = 0,
}: {
  label: string
  value: string | number
  hint?: string
  icon: LucideIcon
  tone?: 'default' | 'success' | 'warning' | 'danger'
  delay?: number
}) {
  const toneClass = {
    default: 'text-foreground',
    success: 'text-emerald-700',
    warning: 'text-amber-700',
    danger: 'text-rose-700',
  }[tone]
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, delay, ease: [0.22, 1, 0.36, 1] }}
      className="group relative overflow-hidden rounded-2xl bg-card p-5 ring-1 ring-foreground/8 transition-shadow duration-300 hover:shadow-[0_16px_40px_-24px_rgba(15,40,30,0.35)]"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
          <p className={cn('mt-2 text-3xl font-semibold tracking-tight tabular-nums', toneClass)}>{value}</p>
          {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        <div className="rounded-xl bg-muted/80 p-2.5 text-muted-foreground transition-colors group-hover:bg-accent group-hover:text-accent-foreground">
          <Icon className="size-4" strokeWidth={1.8} />
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-5 bottom-0 h-px bg-gradient-to-r from-transparent via-foreground/10 to-transparent" />
    </motion.div>
  )
}
