import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { CalendarDays, Plus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { useMemo, useState } from 'react'
import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale'

import { deleteTask, getAccountTypes, getPlatforms, getTasks, retryTask } from '@/lib/api'
import type { Task } from '@/lib/types'
import { dateFromKey, dateKeyFromDate, formatClock, formatDateTime, formatWindow, todayKey } from '@/lib/format'
import { AnimatedNumber } from '@/components/console/animated-number'
import { ConsoleBar } from '@/components/console/console-bar'
import { ROW_IN, ROW_STAGGER } from '@/components/console/motion'
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

function accountsOf(task: Task): number {
  return task.coverageTotal || task.plannedAccounts || task.totalAccounts
}

/**
 * The number the operator scans for: how many of the planned accounts came
 * back. Gaps only appear when there are any, so a clean day stays quiet.
 */
function Coverage({ success, total, failed, pending }: { success: number; total: number; failed: number; pending: number }) {
  return (
    <span className="cx-cover">
      <span className="cx-cover-num">
        <AnimatedNumber value={success} />
        <span>/<AnimatedNumber value={total} /></span>
      </span>
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
        <button type="button" className="cx-link" data-quiet="true" aria-label="删除任务" disabled={deleting}>
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
        <button type="button" className="cx-link" disabled={retrying}>
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
    <Link className="cx-link" to="/tasks/$taskId" params={{ taskId: task.id }} search={{ date }}>
      查看
    </Link>
  )
}

function PlatformCell({ task }: { task: Task }) {
  return (
    <span className="cx-plat">
      <i style={{ background: platformColor(task.platformCode) }} aria-hidden="true" />
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
  return (
    <table className="cx-table">
      <thead>
        <tr>
          <th>平台</th>
          <th>账号类型</th>
          <th>周期（UTC+8）</th>
          <th className="cx-num">账号</th>
          <th className="cx-num">内容</th>
          <th>执行时段</th>
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
            <td data-label="账号" className="cx-num">
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
              </div>
            </td>
          </motion.tr>
        ))}
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
  const query = useQuery({ queryKey: ['tasks', date], queryFn: () => getTasks(date) })
  const platformsQuery = useQuery({ queryKey: ['platforms'], queryFn: getPlatforms })
  const accountTypesQuery = useQuery({ queryKey: ['account-types'], queryFn: getAccountTypes })
  const selectedDate = useMemo(() => dateFromKey(date), [date])
  const reduceMotion = useReducedMotion()

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
                data-fetching={query.isFetching ? 'true' : undefined}
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
              className="cx-surface"
              data-fetching={query.isFetching ? 'true' : undefined}
              initial={reduceMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={ROW_IN}
            >
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
