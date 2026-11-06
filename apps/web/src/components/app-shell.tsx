import { Link, useRouterState } from '@tanstack/react-router'
import { LayoutDashboard, PanelLeftClose, PanelLeftOpen, UsersRound } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const NAV_ITEMS = [
  { to: '/tasks', label: '任务数据', hint: '按天查看抓取结果', icon: LayoutDashboard },
  { to: '/accounts', label: '账号管理', hint: '平台账号与类型', icon: UsersRound },
]

const SIDEBAR_STORAGE_KEY = 'changan.sidebar.collapsed'
const SIDEBAR_WIDTH = { expanded: '244px', collapsed: '76px' }

function BrandMark() {
  return (
    <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-white/6 ring-1 ring-white/10">
      <div className="size-3 rounded-[2px] bg-sidebar-primary" />
    </div>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const reduceMotion = useReducedMotion()
  const [collapsed, setCollapsed] = useState(false)
  const [preferenceReady, setPreferenceReady] = useState(false)
  // 首帧不启用宽度过渡，避免读取到「已收起」偏好时页面加载阶段出现一段收起动画。
  const [transitionsReady, setTransitionsReady] = useState(false)

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setTransitionsReady(true))
    return () => window.cancelAnimationFrame(frame)
  }, [])

  // 首次挂载时读取上次的收起状态；SSR 首帧先按展开渲染，避免水合不一致。
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1')
    } catch {
      // localStorage 不可用时保持默认展开
    }
    setPreferenceReady(true)
  }, [])

  useEffect(() => {
    if (!preferenceReady) return
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? '1' : '0')
    } catch {
      // 忽略写入失败
    }
  }, [collapsed, preferenceReady])

  return (
    <div
      className={cn(
        'min-h-screen lg:grid lg:grid-cols-[var(--app-sidebar-width)_minmax(0,1fr)]',
        transitionsReady && 'lg:transition-[grid-template-columns] lg:duration-300 lg:ease-[cubic-bezier(0.22,1,0.36,1)] lg:motion-reduce:transition-none',
      )}
      style={{ '--app-sidebar-width': collapsed ? SIDEBAR_WIDTH.collapsed : SIDEBAR_WIDTH.expanded } as CSSProperties}
    >
      <aside id="app-sidebar" className="relative hidden flex-col overflow-hidden bg-sidebar text-sidebar-foreground lg:sticky lg:top-0 lg:flex lg:h-screen lg:self-start">
        <div
          className={cn(
            'relative flex shrink-0 items-center gap-3 pb-8 pt-7',
            collapsed ? 'justify-center px-0' : 'px-6',
          )}
        >
          <BrandMark />
          {collapsed ? null : (
            <div>
              <p className="text-[11px] leading-none text-sidebar-foreground/55">长安汽车 · 海外数据</p>
              <p className="mt-1.5 text-[13px] font-semibold leading-none tracking-[0.01em]">RPA Console</p>
            </div>
          )}
        </div>

        <nav
          className={cn(
            'relative flex-1 space-y-1 overflow-y-auto scrollbar-subtle',
            collapsed ? 'px-2' : 'px-3',
          )}
        >
          {collapsed ? (
            <div className="mx-auto mb-2 h-px w-6 bg-sidebar-border/70" />
          ) : (
            <p className="px-3 pb-2 text-[11px] text-sidebar-foreground/50">工作台</p>
          )}
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.to || pathname.startsWith(`${item.to}/`)
            const Icon = item.icon
            return (
              <Tooltip key={item.to}>
                <TooltipTrigger asChild>
                  <Link
                    to={item.to}
                    aria-label={collapsed ? item.label : undefined}
                    className={cn(
                      'group relative isolate flex rounded-xl transition-colors duration-200',
                      collapsed ? 'justify-center px-0 py-2' : 'items-start gap-3 px-3 py-2.5',
                      active
                        ? 'bg-white/[0.06] text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground/70 hover:bg-white/[0.035] hover:text-sidebar-foreground',
                    )}
                  >
                    {active ? (
                      <motion.span
                        layoutId="sidebar-active"
                        aria-hidden="true"
                        className="absolute inset-0 -z-10 overflow-hidden rounded-lg bg-white/[0.06]"
                        transition={reduceMotion ? { duration: 0 } : { type: 'spring', duration: 0.32, bounce: 0.12 }}
                      >
                        <span className="absolute inset-y-2.5 left-0 w-[2px] rounded-full bg-sidebar-primary/80" />
                      </motion.span>
                    ) : null}
                    <span
                      className={cn(
                        'grid size-7 place-items-center rounded-md transition-colors',
                        collapsed ? 'mt-0' : 'mt-0.5',
                        active ? 'bg-white/10 text-sidebar-accent-foreground' : 'bg-white/[0.04] text-sidebar-foreground/55 group-hover:text-sidebar-foreground',
                      )}
                    >
                      <Icon className="size-3.5" strokeWidth={1.9} />
                    </span>
                    {collapsed ? null : (
                      <span>
                        <span className="block text-[13px] font-medium leading-5">{item.label}</span>
                        <span className="mt-0.5 block text-[11.5px] leading-4 text-sidebar-foreground/55">{item.hint}</span>
                      </span>
                    )}
                  </Link>
                </TooltipTrigger>
                {collapsed ? (
                  <TooltipContent side="right" sideOffset={10}>
                    {item.label}
                  </TooltipContent>
                ) : null}
              </Tooltip>
            )
          })}
        </nav>

        <div className="relative shrink-0 border-t border-sidebar-border/50 p-3">
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            aria-expanded={!collapsed}
            aria-controls="app-sidebar"
            aria-label={collapsed ? '展开菜单' : '收起菜单'}
            title={collapsed ? '展开菜单' : '收起菜单'}
            className={cn(
              'flex w-full items-center rounded-lg py-2 text-xs font-medium text-sidebar-foreground/55 transition-colors hover:bg-white/[0.05] hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
              collapsed ? 'justify-center px-0' : 'gap-2 px-3',
            )}
          >
            {collapsed ? <PanelLeftOpen className="size-4 shrink-0" /> : <PanelLeftClose className="size-4 shrink-0" />}
            {collapsed ? null : <span>收起菜单</span>}
          </button>
        </div>
      </aside>

      <div className="min-w-0">
        <div className="sticky top-0 z-30 lg:hidden">
          <header className="flex items-center justify-between border-b border-border/70 bg-background/85 px-4 py-3 backdrop-blur-xl">
            <div className="flex items-center gap-2.5">
              <BrandMark />
              <div>
                <p className="text-[11px] leading-none text-muted-foreground">长安汽车 · 海外数据</p>
                <p className="mt-1 text-[13px] font-semibold leading-none">RPA Console</p>
              </div>
            </div>
          </header>

          <div className="flex gap-1 overflow-x-auto border-b border-border/70 bg-background/85 px-3 py-2 backdrop-blur-xl">
            {NAV_ITEMS.map((item) => {
              const active = pathname === item.to || pathname.startsWith(`${item.to}/`)
              const Icon = item.icon
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    'flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                    active ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted',
                  )}
                >
                  <Icon className="size-3.5" />
                  {item.label}
                </Link>
              )
            })}
          </div>
        </div>

        <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-9 lg:py-9">{children}</main>
      </div>
    </div>
  )
}
