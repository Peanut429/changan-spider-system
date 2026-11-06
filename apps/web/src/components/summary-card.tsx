import type { CSSProperties } from 'react'
import type { LucideIcon } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import CountUp from '@/components/CountUp/CountUp'
import SpotlightCard from '@/components/SpotlightCard/SpotlightCard'
import { cn } from '@/lib/utils'

const TONE_STYLES = {
  default: {
    value: 'text-foreground',
    spotlight: 'rgba(45, 212, 191, 0.6)',
    icon: 'bg-teal-50 text-teal-700 ring-1 ring-teal-200/70',
    accent: 'via-teal-400/60',
    dot: 'bg-teal-500',
    wash: 'to-teal-50/70',
  },
  success: {
    value: 'text-emerald-700',
    spotlight: 'rgba(16, 185, 129, 0.65)',
    icon: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/70',
    accent: 'via-emerald-400/60',
    dot: 'bg-emerald-500',
    wash: 'to-emerald-50/70',
  },
  warning: {
    value: 'text-amber-700',
    spotlight: 'rgba(245, 158, 11, 0.6)',
    icon: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200/70',
    accent: 'via-amber-400/60',
    dot: 'bg-amber-500',
    wash: 'to-amber-50/70',
  },
  danger: {
    value: 'text-rose-700',
    spotlight: 'rgba(244, 63, 94, 0.6)',
    icon: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200/70',
    accent: 'via-rose-400/60',
    dot: 'bg-rose-500',
    wash: 'to-rose-50/70',
  },
} as const

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
  const reduceMotion = useReducedMotion()
  const palette = TONE_STYLES[tone]

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, delay, ease: [0.22, 1, 0.36, 1] }}
      className="h-full"
    >
      <SpotlightCard
        theme="light"
        spotlightColor={palette.spotlight}
        spotlightSize={300}
        intensity={0.8}
        softness={0.65}
        borderGlow={0.5}
        className={cn('group h-full bg-gradient-to-br from-white via-white', palette.wash)}
        style={
          {
            '--spotlight-card-surface': 'transparent',
            padding: '1.35rem 1.25rem',
            borderRadius: '1.1rem',
          } as CSSProperties
        }
      >
        <span
          className={cn('pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent to-transparent', palette.accent)}
        />
        <Icon
          className="pointer-events-none absolute -bottom-3 -right-3 size-28 opacity-[0.035]"
          strokeWidth={1}
        />
        <div className="relative flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-1.5">
              <span className={cn('size-1.5 rounded-full', palette.dot)} />
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
            </div>
            <p className={cn('mt-2.5 text-[32px] font-semibold leading-none tracking-tight tabular-nums', palette.value)}>
              {typeof value === 'number' ? <CountUp to={value} duration={0.7} separator="," /> : value}
            </p>
            {hint ? <p className="mt-2 text-xs text-muted-foreground">{hint}</p> : null}
          </div>
          <div
            className={cn(
              'rounded-xl p-2.5 transition-transform duration-300 group-hover:-rotate-6 group-hover:scale-105',
              palette.icon,
            )}
          >
            <Icon className="size-4" strokeWidth={1.8} />
          </div>
        </div>
      </SpotlightCard>
    </motion.div>
  )
}
