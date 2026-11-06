import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { LayoutDashboard, UsersRound } from 'lucide-react'
import type { ReactNode } from 'react'
import GooeyNav from '@/components/GooeyNav/GooeyNav'
import { ThemeToggle } from '@/components/console/theme-toggle'
import { todayKey } from '@/lib/format'
import { useTheme } from '@/lib/theme'

const NAV_ITEMS = [
  { to: '/tasks', label: '任务数据', icon: <LayoutDashboard className="size-3.5" strokeWidth={1.9} /> },
  { to: '/accounts', label: '账号管理', icon: <UsersRound className="size-3.5" strokeWidth={1.9} /> },
] as const

function BrandMark() {
  return (
    <div className="grid size-7 shrink-0 place-items-center rounded-md bg-sidebar-foreground/5 ring-1 ring-sidebar-foreground/10">
      <div className="size-2.5 rounded-[2px] bg-sidebar-primary" />
    </div>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const { theme, toggle } = useTheme()
  const navigate = useNavigate()
  const section = pathname.startsWith('/accounts') ? '/accounts' : '/tasks'

  return (
    <div className="min-h-screen">
      <header className="app-rail sticky top-0 z-40 border-b border-sidebar-border/70 bg-sidebar/95 backdrop-blur-xl">
        <div className="mx-auto flex h-14 w-full max-w-[1480px] items-center gap-3 px-4 sm:gap-5 sm:px-6 lg:px-9">
          <Link to="/" className="flex shrink-0 items-center gap-2.5" aria-label="RPA Console">
            <BrandMark />
            <span className="leading-tight">
              <span className="hidden text-[10.5px] leading-none text-sidebar-foreground/55 sm:block">
                长安汽车 · 海外数据
              </span>
              <span className="mt-0.5 block text-[13px] font-semibold leading-none text-sidebar-foreground">
                RPA Console
              </span>
            </span>
          </Link>

          <nav className="min-w-0">
            <GooeyNav
              items={NAV_ITEMS.map((item) => ({ label: item.label, icon: item.icon }))}
              activeIndex={section === '/accounts' ? 1 : 0}
              onChange={(index) => {
                const target = index === 1 ? '/accounts' : '/tasks'
                if (target === section) return
                if (target === '/tasks') navigate({ to: '/tasks', search: { date: todayKey() } })
                else navigate({ to: '/accounts' })
              }}
              size="sm"
              frame={false}
              theme={theme}
              color={theme === 'dark' ? '#2b3a33' : '#e9efe7'}
              activeTextColor={theme === 'dark' ? '#eafbf2' : '#0d1712'}
              colors={theme === 'dark' ? ['#5ef2b0', '#a8ffdc', '#9db2a7'] : ['#d7e6db', '#eef3ec', '#b9cfc1']}
              gooeyness={1.4}
              particleCount={10}
            />
          </nav>

          <div className="ml-auto">
            <ThemeToggle theme={theme} onToggle={toggle} />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-9 lg:py-8">{children}</main>
    </div>
  )
}
