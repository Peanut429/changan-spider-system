import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import {
  CalendarDays,
  CircleX,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale'

import { deleteTask, getAccountTypes, getPlatforms, getTasks, retryTask } from '@/lib/api'
import type { Task } from '@/lib/types'
import { dateFromKey, dateKeyFromDate, formatClock, formatDateTime, formatNumber, formatWindow, todayKey } from '@/lib/format'
import { ConsoleBar } from '@/components/console/console-bar'
import { DayStrip, summariseDay } from '@/components/console/day-strip'
import { platformColor } from '@/components/console/platform-color'
import { StatusText } from '@/components/console/status-text'
import { statusTone } from '@/components/status-badge'
import { TaskDialog } from '@/components/task-dialog'
import { EmptyState } from '@/components/empty-state'
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

const DAY_MINUTES = 24 * 60

/** Where the run sits inside its own day, as percentages of a 24h track. */
function dayPosition(task: Task): { left: number; width: number } | null {
  if (!task.runStartedAt) return null
  const start = new Date(task.runStartedAt)
  if (Number.isNaN(start.getTime())) return null
  const dayStart = new Date(start)
  dayStart.setHours(0, 0, 0, 0)
  const startMinutes = (start.getTime() - dayStart.getTime()) / 60_000
  const end = task.runFinishedAt ? new Date(task.runFinishedAt) : null
  const endMinutes = end && !Number.isNaN(end.getTime())
    ? (end.getTime() - dayStart.getTime()) / 60_000
    : startMinutes + 2
  const left = Math.max(0, Math.min(99, (startMinutes / DAY_MINUTES) * 100))
  const width = Math.max(2, Math.min(100 - left, ((endMinutes - startMinutes) / DAY_MINUTES) * 100))
  return { left, width }
}

function taskRunClock(task: Task): string {
  if (!task.runStartedAt) return '—'
  if (!task.runFinishedAt) return `${formatClock(task.runStartedAt)} → 进行中`
  return `${formatClock(task.runStartedAt)} → ${formatClock(task.runFinishedAt)}`
}

function DeleteTaskButton({ task, onDelete, deleting }: { task: Task; onDelete: (task: Task) => void; deleting: boolean }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <button type="button" className="cx-link" data-quiet="true" aria-label="删除任务" disabled={deleting}>
          <Trash2 className="size-3.5" />
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent>
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
        <button type="button" className="cx-link" disabled={retrying}>
          <RotateCcw className="size-3.5" />继续执行
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent>
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
    <Link className="cx-link" to="/tasks/$taskId" params={{ taskId: task.id }} search={{ date }}>
      查看
    </Link>
  )
}

function PendingTable({ tasks, date, onDelete, deletingId }: { tasks: Task[]; date: string; onDelete: (task: Task) => void; deletingId: string | null }) {
  return (
    <table className="cx-table">
      <thead>
        <tr>
          <th>平台</th>
          <th>计划执行</th>
          <th data-hide-mobile="true">抓取范围（UTC+8）</th>
          <th>状态</th>
          <th className="cx-right">操作</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((task) => (
          <tr key={task.id}>
            <td data-block="true">
              <span className="cx-plat">
                <i style={{ background: platformColor(task.platformCode) }} aria-hidden="true" />
                <span className="cx-cell-main">{task.platformName || task.platformCode}</span>
              </span>
              <div className="cx-cell-sub">{task.accountType || '未设置类型'}</div>
            </td>
            <td data-label="计划执行">{formatDateTime(task.scheduledAt)}</td>
            <td data-label="抓取范围" data-hide-mobile="true"><span className="cx-window">{taskWindow(task)}</span></td>
            <td data-label="状态"><StatusText status={task.status} runStatus={task.runStatus} /></td>
            <td data-label="操作" className="cx-right">
              <div className="cx-row-actions">
                <ViewTaskLink task={task} date={date} />
                <DeleteTaskButton task={task} onDelete={onDelete} deleting={deletingId === task.id} />
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ExecutedTable({
  tasks,
  date,
  onRetry,
  retryingId,
  sharedWindow,
  sharedAccountType,
}: {
  tasks: Task[]
  date: string
  onRetry: (task: Task) => void
  retryingId: string | null
  sharedWindow: string | null
  sharedAccountType: string | null
}) {
  if (!tasks.length) {
    return (
      <EmptyState
        icon={CircleX}
        title="今天还没有执行记录"
        description="任务开始执行后会按实际开始时间归到对应日期。"
        className="border-0 bg-transparent py-10"
      />
    )
  }

  return (
    <table className="cx-table">
      <thead>
        <tr>
          <th>平台</th>
          {sharedWindow ? null : <th data-hide-mobile="true">抓取范围（UTC+8）</th>}
          <th className="cx-num">账号</th>
          <th className="cx-num">内容</th>
          <th>执行时段</th>
          <th>状态</th>
          <th className="cx-right">操作</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((task) => {
          const total = task.coverageTotal || task.plannedAccounts || task.totalAccounts
          const position = dayPosition(task)
          return (
            <tr key={task.id} data-tone={statusTone(task.status, task.runStatus) === 'partial' ? 'warn' : task.status === 'failed' ? 'fail' : undefined}>
              <td data-block="true">
                <span className="cx-plat">
                  <i style={{ background: platformColor(task.platformCode) }} aria-hidden="true" />
                  <span className="cx-cell-main">{task.platformName || task.platformCode}</span>
                </span>
                {sharedAccountType ? null : <div className="cx-cell-sub">{task.accountType || '未设置类型'}</div>}
              </td>
              {sharedWindow ? null : (
                <td data-label="抓取范围" data-hide-mobile="true"><span className="cx-window">{taskWindow(task)}</span></td>
              )}
              <td data-label="账号" className="cx-num">
                <span className="cx-ratio">{task.successAccounts}<span>/{total}</span></span>
                {task.failedAccounts > 0 ? <div className="cx-cell-sub" data-tone="fail">失败 {task.failedAccounts}</div> : null}
              </td>
              <td data-label="内容" className="cx-num">{formatNumber(task.contentMetricCount)}</td>
              <td data-label="执行时段">
                <span className="cx-when">
                  <span className="cx-when-track" aria-hidden="true">
                    {position ? (
                      <i
                        data-fail={task.failedAccounts > 0 ? 'true' : undefined}
                        style={{ left: `${position.left}%`, width: `${position.width}%` }}
                      />
                    ) : null}
                  </span>
                  <span className="cx-when-text">{taskRunClock(task)}</span>
                </span>
              </td>
              <td data-label="状态"><StatusText status={task.status} runStatus={task.runStatus} /></td>
              <td data-label="操作" className="cx-right">
                <div className="cx-row-actions">
                  <ViewTaskLink task={task} date={date} />
                  {task.status === 'failed' ? (
                    <RetryTaskButton task={task} onRetry={onRetry} retrying={retryingId === task.id} />
                  ) : null}
                </div>
              </td>
            </tr>
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
          <div className="cx-skel" style={{ width: 128, height: 26 }} />
          <div className="cx-skel" style={{ width: 220, height: 13, marginTop: 10 }} />
        </div>
      </div>
      <div className="cx-skel-day" />
      <div className="cx-skel" style={{ height: 220, marginTop: 28, borderRadius: 8 }} />
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
  const query = useQuery({ queryKey: ['tasks', date], queryFn: () => getTasks(date) })
  const platformsQuery = useQuery({ queryKey: ['platforms'], queryFn: getPlatforms })
  const accountTypesQuery = useQuery({ queryKey: ['account-types'], queryFn: getAccountTypes })
  const selectedDate = useMemo(() => dateFromKey(date), [date])

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

  const dateLabel = format(selectedDate, 'yyyy年M月d日 EEEE', { locale: zhCN })
  const day = useMemo(() => summariseDay(query.data?.executed ?? []), [query.data?.executed])
  // Columns that would repeat the same value in every row move up to the header.
  const sharedWindow = useMemo(() => {
    const values = new Set((query.data?.executed ?? []).map(taskWindow))
    return values.size === 1 ? [...values][0] : null
  }, [query.data?.executed])
  const sharedAccountType = useMemo(() => {
    const values = new Set((query.data?.executed ?? []).map((task) => task.accountType || '未设置类型'))
    return values.size === 1 ? [...values][0] : null
  }, [query.data?.executed])

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
          <PopoverContent align="end" className="w-auto p-0">
            <Calendar mode="single" selected={selectedDate} onSelect={changeDate} locale={zhCN} />
          </PopoverContent>
        </Popover>
        <Button
          variant="outline"
          size="icon"
          className="size-9"
          aria-label="刷新"
          onClick={() => query.refetch()}
        >
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

      {query.data && day.batches > 0 ? <DayStrip summary={day} /> : null}

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
              <div className="cx-surface">
                <PendingTable
                  tasks={query.data.pending}
                  date={date}
                  onDelete={handleDelete}
                  deletingId={deletingId}
                />
              </div>
            ) : null}
          </section>

          <section className="cx-section">
            <div className="cx-section-head">
              <h2 className="cx-h2">执行记录</h2>
              <span className="cx-count">{query.data.executed.length} 个批次</span>
              {sharedAccountType ? <span className="cx-count">· {sharedAccountType}</span> : null}
              {sharedWindow ? <span className="cx-count">· {sharedWindow}（UTC+8）</span> : null}
            </div>
            <div className="cx-surface">
              <ExecutedTable
                tasks={query.data.executed}
                date={date}
                onRetry={handleRetry}
                retryingId={retryingId}
                sharedWindow={sharedWindow}
                sharedAccountType={sharedAccountType}
              />
            </div>
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
