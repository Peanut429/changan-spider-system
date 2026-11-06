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
const SIDEBAR_WIDTH = { expanded: '212px', collapsed: '64px' }

function BrandMark() {
  return (
    <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-sidebar-foreground/5 ring-1 ring-sidebar-foreground/10">
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
      <aside id="app-sidebar" className="relative hidden flex-col overflow-hidden border-r border-sidebar-border/70 bg-sidebar text-sidebar-foreground lg:sticky lg:top-0 lg:flex lg:h-screen lg:self-start">
        <div
          className={cn(
            'relative flex shrink-0 items-center gap-2.5 pb-6 pt-5',
            collapsed ? 'justify-center px-0' : 'px-4',
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
            <p className="px-3 pb-2 text-[11px] tracking-[0.06em] text-sidebar-foreground/45">工作台</p>
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
                    title={collapsed ? item.label : undefined}
                    className={cn(
                      'group relative isolate flex items-center rounded-md transition-colors duration-200',
                      collapsed ? 'justify-center py-2' : 'gap-3 px-3 py-2',
                      active
                        ? 'text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground/65 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                    )}
                  >
                    {active ? (
                      <motion.span
                        layoutId="sidebar-active"
                        aria-hidden="true"
                        className="absolute inset-0 -z-10 overflow-hidden rounded-md bg-sidebar-accent"
                        transition={reduceMotion ? { duration: 0 } : { type: 'spring', duration: 0.3, bounce: 0.1 }}
                      >
                        <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-sidebar-primary" />
                      </motion.span>
                    ) : null}
                    <Icon
                      className={cn('size-4 shrink-0', active ? 'text-sidebar-primary' : 'text-sidebar-foreground/55 group-hover:text-sidebar-foreground')}
                      strokeWidth={1.9}
                    />
                    {collapsed ? null : <span className="text-[13px] font-medium">{item.label}</span>}
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
              'flex w-full items-center rounded-lg py-2 text-xs font-medium text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
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
          <header className="flex items-center justify-between border-b border-sidebar-border/60 bg-sidebar/95 px-4 py-3 backdrop-blur-xl">
            <div className="flex items-center gap-2.5">
              <BrandMark />
              <div>
                <p className="text-[11px] leading-none text-sidebar-foreground/55">长安汽车 · 海外数据</p>
                <p className="mt-1 text-[13px] font-semibold leading-none text-sidebar-foreground">RPA Console</p>
              </div>
            </div>
          </header>

          <div className="flex gap-1 overflow-x-auto border-b border-sidebar-border/60 bg-sidebar/95 px-3 py-2 backdrop-blur-xl">
            {NAV_ITEMS.map((item) => {
              const active = pathname === item.to || pathname.startsWith(`${item.to}/`)
              const Icon = item.icon
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    'flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                    active ? 'bg-sidebar-primary text-sidebar-primary-foreground' : 'text-sidebar-foreground/65 hover:bg-white/6',
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
