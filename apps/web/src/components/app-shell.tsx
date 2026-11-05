import { Link, useRouterState } from '@tanstack/react-router'
import { LayoutDashboard, UsersRound } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

const NAV_ITEMS = [
  { to: '/tasks', label: '任务数据', hint: '按天查看抓取结果', icon: LayoutDashboard },
  { to: '/accounts', label: '账号管理', hint: '平台账号与类型', icon: UsersRound },
]

function BrandMark() {
  return (
    <div className="relative grid size-9 place-items-center rounded-xl bg-emerald-400/15 ring-1 ring-emerald-300/25">
      <div className="size-3.5 rounded-[4px] bg-emerald-300 shadow-[0_0_18px_rgba(110,231,183,0.6)]" />
      <div className="absolute inset-2 rounded-lg border border-emerald-300/25" />
    </div>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[244px_minmax(0,1fr)]">
      <aside className="relative hidden min-h-screen flex-col overflow-hidden bg-sidebar text-sidebar-foreground lg:flex">
        <div className="pointer-events-none absolute -left-24 top-[-80px] size-64 rounded-full bg-emerald-400/10 blur-3xl" />
        <div className="pointer-events-none absolute bottom-[-120px] right-[-80px] size-72 rounded-full bg-cyan-400/8 blur-3xl" />
        <div className="relative flex items-center gap-3 px-6 pb-8 pt-7">
          <BrandMark />
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-sidebar-foreground/45">Changan</p>
            <p className="text-sm font-semibold tracking-wide">RPA Console</p>
          </div>
        </div>

        <nav className="relative flex-1 space-y-1 px-3">
          <p className="px-3 pb-2 text-[10px] font-medium uppercase tracking-[0.2em] text-sidebar-foreground/35">工作台</p>
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.to || pathname.startsWith(`${item.to}/`)
            const Icon = item.icon
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  'group flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors duration-200',
                  active
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]'
                    : 'text-sidebar-foreground/65 hover:bg-white/4 hover:text-sidebar-foreground',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 grid size-7 place-items-center rounded-lg transition-colors',
                    active ? 'bg-emerald-300/15 text-emerald-200' : 'bg-white/4 text-sidebar-foreground/60 group-hover:text-sidebar-foreground',
                  )}
                >
                  <Icon className="size-3.5" strokeWidth={1.9} />
                </span>
                <span>
                  <span className="block text-[13px] font-medium">{item.label}</span>
                  <span className="mt-0.5 block text-[11px] text-sidebar-foreground/40">{item.hint}</span>
                </span>
              </Link>
            )
          })}
        </nav>


      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-border/70 bg-background/80 px-4 py-3 backdrop-blur-xl lg:hidden">
          <div className="flex items-center gap-2.5">
            <BrandMark />
            <div>
              <p className="text-[9px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">Changan</p>
              <p className="text-sm font-semibold">RPA Console</p>
            </div>
          </div>
        </header>

        <div className="flex gap-1 overflow-x-auto border-b border-border/70 bg-background/70 px-3 py-2 lg:hidden">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.to || pathname.startsWith(`${item.to}/`)
            const Icon = item.icon
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                  active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
                )}
              >
                <Icon className="size-3.5" />
                {item.label}
              </Link>
            )
          })}
        </div>

        <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-9 lg:py-9">{children}</main>
      </div>
    </div>
  )
}
