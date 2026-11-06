import type { CSSProperties } from 'react'
import type { LucideIcon } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import CountUp from '@/components/CountUp/CountUp'
import SpotlightCard from '@/components/SpotlightCard/SpotlightCard'
import { cn } from '@/lib/utils'

const TONE_STYLES = {
  default: {
    value: 'text-foreground',
    spotlight: 'rgba(45, 212, 191, 0.55)',
    icon: 'bg-teal-50 text-teal-700 ring-1 ring-teal-200/70',
    accent: 'via-teal-400/60',
    wash: 'to-teal-50/70',
  },
  success: {
    value: 'text-emerald-700',
    spotlight: 'rgba(16, 185, 129, 0.6)',
    icon: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/70',
    accent: 'via-emerald-400/60',
    wash: 'to-emerald-50/70',
  },
  muted: {
    value: 'text-muted-foreground',
    spotlight: 'rgba(100, 116, 139, 0.45)',
    icon: 'bg-slate-50 text-slate-500 ring-1 ring-slate-200/70',
    accent: 'via-slate-400/50',
    wash: 'to-slate-50/70',
  },
} as const

export function StatCard({
  label,
  value,
  icon: Icon,
  tone = 'default',
  delay = 0,
}: {
  label: string
  value: number
  icon: LucideIcon
  tone?: 'default' | 'success' | 'muted'
  delay?: number
}) {
  const reduceMotion = useReducedMotion()
  const palette = TONE_STYLES[tone]

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, delay, ease: [0.22, 1, 0.36, 1] }}
      className="h-full"
    >
      <SpotlightCard
        theme="light"
        spotlightColor={palette.spotlight}
        spotlightSize={260}
        intensity={0.75}
        softness={0.65}
        borderGlow={0.45}
        className={cn('group flex h-full items-center justify-between gap-4 bg-gradient-to-br from-white via-white', palette.wash)}
        style={
          {
            '--spotlight-card-surface': 'transparent',
            padding: '1.1rem 1.25rem',
            borderRadius: '1.1rem',
          } as CSSProperties
        }
      >
        <span
          className={cn('pointer-events-none absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent to-transparent', palette.accent)}
        />
        <div>
          <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
          <p className={cn('mt-1.5 text-[28px] font-semibold leading-none tabular-nums', palette.value)}>
            <CountUp to={value} duration={0.65} separator="," />
          </p>
        </div>
        <div className={cn('grid size-9 shrink-0 place-items-center rounded-xl transition-transform duration-300 group-hover:-rotate-6 group-hover:scale-105', palette.icon)}>
          <Icon className="size-4" strokeWidth={1.8} />
        </div>
      </SpotlightCard>
    </motion.div>
  )
}
