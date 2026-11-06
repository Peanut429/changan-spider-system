import { Link, useRouterState } from '@tanstack/react-router'
import { LayoutDashboard, UsersRound } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

const NAV_ITEMS = [
  { to: '/tasks', label: '任务数据', icon: LayoutDashboard },
  { to: '/accounts', label: '账号管理', icon: UsersRound },
]

function BrandMark() {
  return (
    <div className="grid size-8 shrink-0 place-items-center rounded-md bg-sidebar-foreground/5 ring-1 ring-sidebar-foreground/10">
      <div className="size-3 rounded-[2px] bg-sidebar-primary" />
    </div>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const reduceMotion = useReducedMotion()

  return (
    <div className="min-h-screen">
      <header className="app-rail sticky top-0 z-40 border-b border-sidebar-border/70 bg-sidebar/95 backdrop-blur-xl">
        <div className="mx-auto flex h-14 w-full max-w-[1480px] items-center gap-3 px-4 sm:gap-6 sm:px-6 lg:px-9">
          <Link to="/" className="flex shrink-0 items-center gap-2.5" aria-label="RPA Console">
            <BrandMark />
            <span className="leading-tight">
              <span className="hidden text-[10.5px] leading-none text-sidebar-foreground/55 sm:block">长安汽车 · 海外数据</span>
              <span className="mt-1 block text-[13px] font-semibold leading-none text-sidebar-foreground">
                RPA Console
              </span>
            </span>
          </Link>

          <nav className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-subtle">
            {NAV_ITEMS.map((item) => {
              const active = pathname === item.to || pathname.startsWith(`${item.to}/`)
              const Icon = item.icon
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    'group relative isolate flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 transition-colors duration-200',
                    active
                      ? 'text-sidebar-accent-foreground'
                      : 'text-sidebar-foreground/65 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                  )}
                >
                  {active ? (
                    <motion.span
                      layoutId="top-nav-active"
                      aria-hidden="true"
                      className="absolute inset-0 -z-10 overflow-hidden rounded-md bg-sidebar-accent"
                      transition={reduceMotion ? { duration: 0 } : { type: 'spring', duration: 0.3, bounce: 0.1 }}
                    >
                      <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-sidebar-primary" />
                    </motion.span>
                  ) : null}
                  <Icon
                    className={cn('size-4 shrink-0', active ? 'text-sidebar-primary' : 'text-sidebar-foreground/55')}
                    strokeWidth={1.9}
                  />
                  <span className="text-[13px] font-medium whitespace-nowrap">{item.label}</span>
                </Link>
              )
            })}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-9 lg:py-8">{children}</main>
    </div>
  )
}
