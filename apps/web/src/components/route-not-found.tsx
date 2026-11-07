import { Link, useRouter, useRouterState } from '@tanstack/react-router'
import { ArrowLeft, LayoutDashboard, SearchX } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'

import { ConsolePage } from '@/components/console/console-page'
import { Button } from '@/components/ui/button'
import { todayKey } from '@/lib/format'

/**
 * Rendered by the router whenever a `notFoundError` reaches a route that has no
 * `notFoundComponent` of its own — in practice an unmatched URL. It renders
 * inside the root shell, so the header and backdrop stay in place.
 */
export function RouteNotFound() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const router = useRouter()
  const reduceMotion = useReducedMotion()

  return (
    <ConsolePage>
      <motion.div
        initial={reduceMotion ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
        className="mx-auto flex max-w-xl flex-col items-center rounded-2xl border border-dashed border-border bg-card/70 px-6 py-16 text-center shadow-[0_24px_60px_-52px_rgba(6,78,59,0.55)]"
      >
        <div className="grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
          <SearchX className="size-5" strokeWidth={1.8} />
        </div>
        <p className="mt-4 text-sm font-medium">页面不存在</p>
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
          没有找到
          <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">{pathname}</code>
          对应的页面，可能是链接已失效或地址输入有误。
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Button asChild size="sm">
            <Link to="/tasks" search={{ date: todayKey() }}>
              <LayoutDashboard className="size-3.5" />
              前往任务数据
            </Link>
          </Button>
          <Button size="sm" variant="outline" onClick={() => router.history.back()}>
            <ArrowLeft className="size-3.5" />
            返回上一页
          </Button>
        </div>
      </motion.div>
    </ConsolePage>
  )
}
