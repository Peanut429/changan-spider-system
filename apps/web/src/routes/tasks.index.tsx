import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { CalendarDays, ChevronRight, Plus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale'

import { deleteTask, getAccountTypes, getPlatforms, getTasks, retryTask } from '@/lib/api'
import type { Task } from '@/lib/types'
import { dateFromKey, dateKeyFromDate, formatClock, formatDateTime, formatWindow, todayKey } from '@/lib/format'
import { AnimatedNumber } from '@/components/console/animated-number'
import { ConsoleBar } from '@/components/console/console-bar'
import { EASE_OUT, ROW_IN, ROW_STAGGER } from '@/components/console/motion'
import { platformColor } from '@/components/console/platform-color'
import { TaskDialog } from '@/components/task-dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'
import '@/components/console/console.css'

type TasksSearch = { date: string }

export const Route = createFileRoute('/tasks/')({
  validateSearch: (search: Record<string, unknown>): TasksSearch => {
    const date = typeof search.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(search.date)
      ? search.date
      : todayKey()
    return { date }
  },
  component: TasksPage,
})

function taskWindow(task: Task): string {
  if (task.windowSince && task.windowUntil) return formatWindow(task.windowSince, task.windowUntil)
  const since = typeof task.params.since === 'string' ? task.params.since : ''
  const until = typeof task.params.until === 'string' ? task.params.until : ''
  if (since || until) return `${since || '—'} → ${until || '未设置'}`
  return '—'
}

function taskRunClock(task: Task): string {
  if (!task.runStartedAt) return '—'
  if (!task.runFinishedAt) return `${formatClock(task.runStartedAt)} → 进行中`
  return `${formatClock(task.runStartedAt)} → ${formatClock(task.runFinishedAt)}`
}

function taskDuration(task: Task): string {
  if (!task.runStartedAt) return '—'
  const start = new Date(task.runStartedAt).getTime()
  const end = task.runFinishedAt ? new Date(task.runFinishedAt).getTime() : Date.now()
  if (Number.isNaN(start) || Number.isNaN(end)) return '—'
  const minutes = Math.max(0, Math.round((end - start) / 60_000))
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest} 分`
  return `${hours} 小时 ${rest} 分`
}

function accountsOf(task: Task): number {
  return task.coverageTotal || task.plannedAccounts || task.totalAccounts
}

/**
 * Every planned account becomes one cell, in order. The array is the point of
 * the page: you can see coverage as hardware rather than read it off a number.
 */
function CoverageArray({ success, failed, pending, total }: { success: number; failed: number; pending: number; total: number }) {
  if (total <= 0) {
    return <span className="cx-cells" aria-hidden="true" />
  }

  if (total > 220) {
    const pct = (value: number) => `${(value / total) * 100}%`
    return (
      <span className="cx-cells" aria-hidden="true">
        <span className="cx-cell" data-state="ok" style={{ flex: `0 0 ${pct(success)}`, animationDelay: '0ms' }} />
        {failed > 0 ? <span className="cx-cell" data-state="fail" style={{ flex: `0 0 ${pct(failed)}`, animationDelay: '40ms' }} /> : null}
        {pending > 0 ? <span className="cx-cell" data-state="new" style={{ flex: `0 0 ${pct(pending)}`, animationDelay: '80ms' }} /> : null}
        <span className="cx-cell" data-state="idle" style={{ flex: '1 1 0', animationDelay: '120ms' }} />
      </span>
    )
  }

  return (
    <span className="cx-cells" aria-hidden="true">
      {Array.from({ length: total }, (_, index) => {
        const state =
          index < success
            ? 'ok'
            : index < success + failed
              ? 'fail'
              : index < success + failed + pending
                ? 'new'
                : 'idle'
        return <span key={index} className="cx-cell" data-state={state} style={{ ['--i' as string]: index }} />
      })}
    </span>
  )
}

function Coverage({
  success,
  total,
  failed,
  pending,
}: {
  success: number
  total: number
  failed: number
  pending: number
}) {
  return (
    <span className="cx-cover">
      <span className="cx-cover-num">
        <AnimatedNumber value={success} />
        <span>/<AnimatedNumber value={total} /></span>
      </span>
      <CoverageArray success={success} total={total} failed={failed} pending={pending} />
      {failed > 0 || pending > 0 ? (
        <span className="cx-cover-note">
          {failed > 0 ? <span data-tone="fail">失败 {failed}</span> : null}
          {failed > 0 && pending > 0 ? ' · ' : null}
          {pending > 0 ? <span>待补 {pending}</span> : null}
        </span>
      ) : null}
      <span className="sr-only">成功 {success} 个，共 {total} 个账号</span>
    </span>
  )
}

function DeleteTaskButton({ task, onDelete, deleting }: { task: Task; onDelete: (task: Task) => void; deleting: boolean }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <button
          type="button"
          className="cx-link"
          data-quiet="true"
          aria-label="删除任务"
          disabled={deleting}
          onClick={(event) => event.stopPropagation()}
        >
          <Trash2 className="size-3.5" />
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent className="cx-portal">
        <AlertDialogHeader>
          <AlertDialogTitle>删除这个任务？</AlertDialogTitle>
          <AlertDialogDescription>
            计划执行时间为 {formatDateTime(task.scheduledAt)}。删除后该任务不会执行，且无法恢复。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => onDelete(task)}
          >
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function RetryTaskButton({ task, onRetry, retrying }: { task: Task; onRetry: (task: Task) => void; retrying: boolean }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <button
          type="button"
          className="cx-link"
          disabled={retrying}
          onClick={(event) => event.stopPropagation()}
        >
          <RotateCcw className="size-3.5" />继续执行
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent className="cx-portal">
        <AlertDialogHeader>
          <AlertDialogTitle>继续执行这个任务？</AlertDialogTitle>
          <AlertDialogDescription>
            会复用原来的执行记录，跳过已成功的账号，只重跑失败和未完成的账号。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction onClick={() => onRetry(task)}>继续执行</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function ViewTaskLink({ task, date }: { task: Task; date: string }) {
  return (
    <Link
      className="cx-link"
      to="/tasks/$taskId"
      params={{ taskId: task.id }}
      search={{ date }}
      onClick={(event) => event.stopPropagation()}
    >
      查看
    </Link>
  )
}

function PlatformCell({ task }: { task: Task }) {
  return (
    <span className="cx-plat">
      <i style={{ color: platformColor(task.platformCode) }} aria-hidden="true" />
      <span className="cx-cell-main">{task.platformName || task.platformCode}</span>
      {task.status === 'running' ? <span className="cx-running">执行中</span> : null}
    </span>
  )
}

function PendingTable({ tasks, date, onDelete, deletingId }: { tasks: Task[]; date: string; onDelete: (task: Task) => void; deletingId: string | null }) {
  const reduceMotion = useReducedMotion()
  return (
    <table className="cx-table">
      <thead>
        <tr>
          <th>平台</th>
          <th>账号类型</th>
          <th>周期（UTC+8）</th>
          <th>计划执行</th>
          <th className="cx-right">操作</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((task, index) => (
          <motion.tr
            key={task.id}
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ ...ROW_IN, delay: Math.min(index * ROW_STAGGER, 0.2) }}
          >
            <td data-block="true"><PlatformCell task={task} /></td>
            <td data-label="账号类型">{task.accountType || '—'}</td>
            <td data-label="周期"><span className="cx-window">{taskWindow(task)}</span></td>
            <td data-label="计划执行"><span className="cx-window">{formatDateTime(task.scheduledAt)}</span></td>
            <td data-label="操作" className="cx-right">
              <div className="cx-row-actions">
                <ViewTaskLink task={task} date={date} />
                <DeleteTaskButton task={task} onDelete={onDelete} deleting={deletingId === task.id} />
              </div>
            </td>
          </motion.tr>
        ))}
      </tbody>
    </table>
  )
}

function TaskTelemetry({ task }: { task: Task }) {
  return (
    <div className="cx-detail-grid">
      <div className="cx-detail-cell">
        <p className="cx-detail-label">计划执行</p>
        <p className="cx-detail-value">{formatDateTime(task.scheduledAt)}</p>
      </div>
      <div className="cx-detail-cell">
        <p className="cx-detail-label">实际开始</p>
        <p className="cx-detail-value">{formatDateTime(task.runStartedAt)}</p>
      </div>
      <div className="cx-detail-cell">
        <p className="cx-detail-label">结束</p>
        <p className="cx-detail-value">{task.runFinishedAt ? formatDateTime(task.runFinishedAt) : '进行中'}</p>
      </div>
      <div className="cx-detail-cell">
        <p className="cx-detail-label">用时</p>
        <p className="cx-detail-value">{taskDuration(task)}</p>
      </div>
      <div className="cx-detail-cell">
        <p className="cx-detail-label">账号成功</p>
        <p className="cx-detail-value">{task.successAccounts}</p>
      </div>
      <div className="cx-detail-cell">
        <p className="cx-detail-label">账号失败</p>
        <p className="cx-detail-value">{task.failedAccounts}</p>
      </div>
      <div className="cx-detail-cell">
        <p className="cx-detail-label">新增待补</p>
        <p className="cx-detail-value">{task.newAccounts}</p>
      </div>
      <div className="cx-detail-cell">
        <p className="cx-detail-label">原始记录</p>
        <p className="cx-detail-value">{task.rawRecordCount}</p>
      </div>
    </div>
  )
}

function ExecutedTable({
  tasks,
  date,
  onRetry,
  retryingId,
}: {
  tasks: Task[]
  date: string
  onRetry: (task: Task) => void
  retryingId: string | null
}) {
  const reduceMotion = useReducedMotion()
  const [openId, setOpenId] = useState<string | null>(null)

  return (
    <table className="cx-table">
      <thead>
        <tr>
          <th>平台</th>
          <th>账号类型</th>
          <th>周期（UTC+8）</th>
          <th className="cx-num">账号覆盖</th>
          <th className="cx-num">内容</th>
          <th data-hide-mobile="true">执行时段</th>
          <th className="cx-right">操作</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((task, index) => {
          const open = openId === task.id
          const toggle = () => setOpenId(open ? null : task.id)
          return (
            <Fragment key={task.id}>
              <motion.tr
                className="cx-row"
                data-open={open ? 'true' : undefined}
                initial={reduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ ...ROW_IN, delay: Math.min(index * ROW_STAGGER, 0.2) }}
                onClick={toggle}
              >
                <td data-block="true"><PlatformCell task={task} /></td>
                <td data-label="账号类型">{task.accountType || '—'}</td>
                <td data-label="周期"><span className="cx-window">{taskWindow(task)}</span></td>
                <td data-label="账号覆盖" className="cx-num">
                  <Coverage
                    success={task.successAccounts}
                    total={accountsOf(task)}
                    failed={task.failedAccounts}
                    pending={task.newAccounts}
                  />
                </td>
                <td data-label="内容" className="cx-num"><AnimatedNumber value={task.contentMetricCount} /></td>
                <td data-label="执行时段" data-hide-mobile="true"><span className="cx-when">{taskRunClock(task)}</span></td>
                <td data-label="操作" className="cx-right">
                  <div className="cx-row-actions">
                    <ViewTaskLink task={task} date={date} />
                    {task.status === 'failed' ? (
                      <RetryTaskButton task={task} onRetry={onRetry} retrying={retryingId === task.id} />
                    ) : null}
                    <button
                      type="button"
                      className="cx-chevron"
                      aria-expanded={open}
                      aria-controls={`task-detail-${task.id}`}
                      aria-label={open ? '收起任务详情' : '展开任务详情'}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggle()
                      }}
                    >
                      <ChevronRight className="size-3.5" />
                    </button>
                  </div>
                </td>
              </motion.tr>

              <AnimatePresence initial={false}>
                {open ? (
                  <motion.tr
                    key="detail"
                    id={`task-detail-${task.id}`}
                    className="cx-detail"
                    initial={reduceMotion ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={reduceMotion ? undefined : { opacity: 0 }}
                  >
                    <td colSpan={7}>
                      <motion.div
                        className="cx-detail-inner"
                        initial={reduceMotion ? false : { height: 0 }}
                        animate={{ height: 'auto' }}
                        exit={reduceMotion ? undefined : { height: 0 }}
                        transition={{ duration: 0.3, ease: EASE_OUT }}
                      >
                        <div style={{ paddingTop: 14 }}>
                          <TaskTelemetry task={task} />
                          {task.runError || task.lastError ? (
                            <p className="cx-detail-error">{task.runError || task.lastError}</p>
                          ) : null}
                          <div className="cx-detail-actions">
                            <Link className="cx-link" to="/tasks/$taskId" params={{ taskId: task.id }} search={{ date }}>
                              查看完整明细
                            </Link>
                          </div>
                        </div>
                      </motion.div>
                    </td>
                  </motion.tr>
                ) : null}
              </AnimatePresence>
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

function LoadingState() {
  return (
    <div className="cx">
      <div className="cx-bar">
        <div>
          <div className="cx-skel" style={{ width: 128, height: 28 }} />
          <div className="cx-skel" style={{ width: 220, height: 13, marginTop: 12 }} />
        </div>
      </div>
      <div className="cx-skel-table" />
    </div>
  )
}

function TasksPage() {
  const { date } = Route.useSearch()
  const navigate = useNavigate({ from: '/tasks' })
  const queryClient = useQueryClient()
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [sweep, setSweep] = useState(1)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const query = useQuery({ queryKey: ['tasks', date], queryFn: () => getTasks(date) })
  const platformsQuery = useQuery({ queryKey: ['platforms'], queryFn: getPlatforms })
  const accountTypesQuery = useQuery({ queryKey: ['account-types'], queryFn: getAccountTypes })
  const selectedDate = useMemo(() => dateFromKey(date), [date])
  const reduceMotion = useReducedMotion()

  // The console page sits on its own phosphor screen instead of the app's paper.
  useEffect(() => {
    document.documentElement.classList.add('cx-page')
    return () => document.documentElement.classList.remove('cx-page')
  }, [])

  const handleRetry = async (task: Task) => {
    setRetryingId(task.id)
    try {
      await retryTask(task.id)
      toast.success('任务已重新排队')
      await queryClient.invalidateQueries({ queryKey: ['tasks'] })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '任务重新排队失败')
    } finally {
      setRetryingId(null)
    }
  }

  const handleDelete = async (task: Task) => {
    setDeletingId(task.id)
    try {
      await deleteTask(task.id)
      toast.success('任务已删除')
      await queryClient.invalidateQueries({ queryKey: ['tasks'] })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除任务失败')
    } finally {
      setDeletingId(null)
    }
  }

  const changeDate = (next: Date | undefined) => {
    if (!next) return
    setCalendarOpen(false)
    navigate({ to: '/tasks', search: { date: format(next, 'yyyy-MM-dd') } })
  }

  const refresh = () => {
    setSweep((value) => value + 1)
    void query.refetch()
  }

  const trackPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const surface = surfaceRef.current
    if (!surface) return
    const rect = surface.getBoundingClientRect()
    surface.style.setProperty('--mx', `${event.clientX - rect.left}px`)
    surface.style.setProperty('--my', `${event.clientY - rect.top}px`)
  }

  const dateLabel = format(selectedDate, 'yyyy年M月d日 EEEE', { locale: zhCN })

  if (query.isPending) return <LoadingState />

  return (
    <div className="cx">
      <ConsoleBar title="任务数据" description="查看当天抓取任务和执行结果。">
        <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" className="h-9 gap-2 px-2.5 font-normal">
              <CalendarDays className="size-4 text-muted-foreground" />
              {dateLabel}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="cx-portal w-auto p-0">
            <Calendar mode="single" selected={selectedDate} onSelect={changeDate} locale={zhCN} />
          </PopoverContent>
        </Popover>
        <Button variant="outline" size="icon" className="size-9" aria-label="刷新" onClick={refresh}>
          <RefreshCw className={query.isFetching ? 'size-4 animate-spin' : 'size-4'} />
        </Button>
        <Button
          className="h-9 gap-1.5"
          onClick={() => setCreateOpen(true)}
          disabled={!platformsQuery.data?.platforms.length || !accountTypesQuery.data?.accountTypes.length}
        >
          <Plus className="size-4" />
          创建任务
        </Button>
      </ConsoleBar>

      {query.isError ? (
        <div className="cx-error">
          <p>任务数据加载失败：{query.error.message}</p>
          <Button variant="outline" size="sm" onClick={() => query.refetch()}>重试</Button>
        </div>
      ) : null}

      {query.data ? (
        <>
          <section className="cx-section">
            <div className="cx-section-head">
              <h2 className="cx-h2">待执行</h2>
              {query.data.pending.length > 0 ? (
                <span className="cx-count">{query.data.pending.length} 个批次</span>
              ) : (
                <p className="cx-note">今天没有待执行的批次</p>
              )}
            </div>
            {query.data.pending.length > 0 ? (
              <motion.div
                key={`pending-${date}`}
                className="cx-surface"
                initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={ROW_IN}
              >
                <PendingTable
                  tasks={query.data.pending}
                  date={date}
                  onDelete={handleDelete}
                  deletingId={deletingId}
                />
              </motion.div>
            ) : null}
          </section>

          <section className="cx-section">
            <div className="cx-section-head">
              <h2 className="cx-h2">执行记录</h2>
              <span className="cx-count">{query.data.executed.length} 个批次</span>
            </div>
            <motion.div
              key={`executed-${date}`}
              ref={surfaceRef}
              className="cx-surface"
              data-fetching={query.isFetching ? 'true' : undefined}
              onPointerMove={trackPointer}
              initial={reduceMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={ROW_IN}
            >
              {!reduceMotion ? <span key={sweep} className="cx-sweep" aria-hidden="true" /> : null}
              {query.data.executed.length > 0 ? (
                <ExecutedTable
                  tasks={query.data.executed}
                  date={date}
                  onRetry={handleRetry}
                  retryingId={retryingId}
                />
              ) : (
                <p className="cx-empty-row">今天还没有执行记录。任务开始执行后会归到实际开始的那一天。</p>
              )}
            </motion.div>
          </section>
        </>
      ) : null}

      <TaskDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        platforms={platformsQuery.data?.platforms ?? []}
        accountTypes={accountTypesQuery.data?.accountTypes ?? []}
        defaultDate={date}
        onCreated={(task) => {
          const taskDate = task.scheduledAt ? dateKeyFromDate(new Date(task.scheduledAt)) : date
          void queryClient.invalidateQueries({ queryKey: ['tasks'] })
          if (taskDate !== date) {
            navigate({ to: '/tasks', search: { date: taskDate } })
          }
        }}
      />
    </div>
  )
}
