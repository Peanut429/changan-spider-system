import type { ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import Aurora from '@/components/Aurora/Aurora'
import GradientText from '@/components/GradientText/GradientText'

export function PageHeader({
  eyebrow = 'Changan RPA',
  title,
  description,
  actions,
}: {
  eyebrow?: string
  title: string
  description?: string
  actions?: ReactNode
}) {
  const reduceMotion = useReducedMotion()

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      className="page-hero relative isolate mb-7 overflow-hidden rounded-[28px] border border-emerald-200/10 px-6 py-7 text-sidebar-foreground shadow-[0_32px_70px_-48px_rgba(6,78,59,0.95)] sm:px-8 sm:py-8"
    >
      <div className="pointer-events-none absolute inset-0 -z-20 bg-[radial-gradient(125%_150%_at_10%_0%,#0f766e_0%,#04302a_48%,#021b16_100%)]" />
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        {reduceMotion ? null : (
          <Aurora
            className="h-full w-full"
            colorStops={['#021b16', '#064e3b', '#0d9488', '#0e7490']}
            amplitude={0.65}
            blend={0.35}
            speed={0.5}
            height={0.9}
            glow={0.2}
            brightness={0.35}
            mouseInteraction={false}
          />
        )}
        <div className="absolute inset-0 bg-[linear-gradient(105deg,rgba(2,20,16,0.96)_0%,rgba(2,20,16,0.82)_50%,rgba(2,20,16,0.95)_100%)]" />
        <div className="absolute inset-0 opacity-[0.14] [background-image:radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.55)_1px,transparent_0)] [background-size:22px_22px]" />
      </div>
      <span className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-emerald-200/60 to-transparent" />
      <div className="pointer-events-none absolute -right-20 -top-24 -z-10 size-64 rounded-full bg-emerald-400/10 blur-3xl" />

      <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/6 px-3 py-1 text-[10px] font-medium uppercase tracking-[0.2em] text-emerald-100/85 backdrop-blur-md">
            <span className="animate-soft-pulse size-1.5 rounded-full bg-emerald-300 shadow-[0_0_10px_rgba(110,231,183,0.9)]" />
            {eyebrow}
          </span>
          <h1 className="mt-4 max-w-3xl text-[27px] font-semibold leading-tight tracking-tight sm:text-[33px]">
            <GradientText
              colors={['#f0fdf4', '#a7f3d0', '#67e8f9', '#f0fdf4']}
              animationSpeed={7}
              angle={100}
              glow={0.22}
              className="py-0.5"
            >
              {title}
            </GradientText>
          </h1>
          {description ? (
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-sidebar-foreground/70">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </motion.div>
  )
}
