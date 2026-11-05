import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowUpRight,
  CalendarDays,
  CircleCheck,
  CircleX,
  Clock3,
  ListTodo,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  SearchX,
} from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { useMemo, useState } from 'react'
import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale'

import { deleteTask, getAccountTypes, getPlatforms, getTasks, retryTask } from '@/lib/api'
import type { Task } from '@/lib/types'
import { dateFromKey, dateKeyFromDate, formatCount, formatDateTime, formatNumber, formatWindow, todayKey } from '@/lib/format'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/page-header'
import { PlatformBadge } from '@/components/platform-badge'
import { StatusBadge } from '@/components/status-badge'
import { SummaryCard } from '@/components/summary-card'
import { EmptyState } from '@/components/empty-state'
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
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'

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

function AccountCounts({ task }: { task: Task }) {
  const total = task.plannedAccounts || task.totalAccounts
  return (
    <div className="space-y-0.5 text-xs tabular-nums">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1 text-emerald-700">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          成功 {task.successAccounts}
        </span>
        <span className="inline-flex items-center gap-1 text-rose-700">
          <span className="size-1.5 rounded-full bg-rose-400" />
          失败 {task.failedAccounts}
        </span>
        <span className="text-muted-foreground">总数 {total}</span>
      </div>
      {task.totalAccounts < total ? (
        <p className="text-[10px] text-muted-foreground">已处理 {task.totalAccounts}</p>
      ) : null}
    </div>
  )
}

function TaskAction({
  task,
  pending = false,
  onDelete,
  deleting = false,
  onRetry,
  retrying = false,
}: {
  task: Task
  pending?: boolean
  onDelete?: (task: Task) => void
  deleting?: boolean
  onRetry?: (task: Task) => void
  retrying?: boolean
}) {
  const taskDate = task.runStartedAt
    ? dateKeyFromDate(new Date(task.runStartedAt))
    : task.scheduledAt
      ? dateKeyFromDate(new Date(task.scheduledAt))
      : todayKey()
  return (
    <div className="flex items-center justify-end gap-1">
      <Button asChild variant={pending ? 'outline' : 'ghost'} size="sm" className="gap-1">
        <Link to="/tasks/$taskId" params={{ taskId: task.id }} search={{ date: taskDate }}>
          {pending ? '查看任务' : '查看数据'}
          <ArrowUpRight className="size-3.5" />
        </Link>
      </Button>
      {pending && onDelete ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hover:text-destructive"
              disabled={deleting}
              aria-label="删除任务"
            >
              <Trash2 className="size-3.5" />
            </Button>
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
      ) : null}
      {!pending && task.status === 'failed' && onRetry ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1" disabled={retrying}>
              <RotateCcw className="size-3.5" />继续执行
            </Button>
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
      ) : null}
    </div>
  )
}

function PendingTable({ tasks, onDelete, deletingId }: { tasks: Task[]; onDelete: (task: Task) => void; deletingId: string | null }) {
  if (!tasks.length) {
    return (
      <EmptyState
        icon={ListTodo}
        title="当日没有待执行任务"
        description="当天没有安排待执行任务。"
      />
    )
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-border/80 bg-card">
      <Table className="min-w-[980px]">
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="w-[150px]">计划执行</TableHead>
            <TableHead>账号类型</TableHead>
            <TableHead>平台</TableHead>
            <TableHead>抓取范围（UTC+8）</TableHead>
            <TableHead className="w-[110px]">状态</TableHead>
            <TableHead className="w-[110px] text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.map((task) => (
            <TableRow key={task.id} className="group">
              <TableCell>
                <div className="flex items-center gap-2 text-sm tabular-nums">
                  <Clock3 className="size-3.5 text-muted-foreground/60" />
                  {formatDateTime(task.scheduledAt)}
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">计划时间</p>
              </TableCell>
              <TableCell>
                <span className="text-sm">{task.accountType || '未设置'}</span>
              </TableCell>
              <TableCell><PlatformBadge code={task.platformCode} /></TableCell>
              <TableCell>
                <span className="text-xs text-muted-foreground">{taskWindow(task)}</span>
              </TableCell>
              <TableCell><StatusBadge status={task.status} runStatus={task.runStatus} /></TableCell>
              <TableCell className="text-right"><TaskAction task={task} pending onDelete={onDelete} deleting={deletingId === task.id} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function ExecutedTable({ tasks, onRetry, retryingId }: { tasks: Task[]; onRetry: (task: Task) => void; retryingId: string | null }) {
  if (!tasks.length) {
    return (
      <EmptyState
        icon={SearchX}
        title="当日还没有执行记录"
        description="任务开始执行后，会按实际开始时间归到对应日期；这里会展示账号、内容和执行结果。"
      />
    )
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-border/80 bg-card">
      <Table className="min-w-[980px]">
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="min-w-[190px]">平台 / 任务</TableHead>
            <TableHead>账号类型</TableHead>
            <TableHead>抓取范围（UTC+8）</TableHead>
            <TableHead className="w-[150px]">账号（成功/失败/总数）</TableHead>
            <TableHead className="min-w-[200px]">执行时间</TableHead>
            <TableHead className="w-[110px]">状态</TableHead>
            <TableHead className="w-[110px] text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.map((task) => (
            <TableRow key={task.id} className="group">
              <TableCell>
                <div className="flex flex-col gap-1.5">
                  <PlatformBadge code={task.platformCode} className="w-fit" />
                </div>
              </TableCell>
              <TableCell>
                <span className="text-sm">{task.accountType || '未设置'}</span>
              </TableCell>
              <TableCell>
                <span className="line-clamp-2 max-w-[210px] text-xs leading-relaxed text-muted-foreground">{taskWindow(task)}</span>
              </TableCell>
              <TableCell><AccountCounts task={task} /></TableCell>
              <TableCell>
                <div className="space-y-1 text-xs tabular-nums">
                  <div className="flex items-center gap-1.5 text-foreground/80">
                    <span className="w-8 text-[10px] text-muted-foreground">开始</span>
                    {formatDateTime(task.runStartedAt)}
                  </div>
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="w-8 text-[10px]">结束</span>
                    {task.status === 'running' || !task.runFinishedAt ? '进行中' : formatDateTime(task.runFinishedAt)}
                  </div>
                </div>
              </TableCell>
              <TableCell><StatusBadge status={task.status} runStatus={task.runStatus} /></TableCell>
              <TableCell className="text-right"><TaskAction task={task} onRetry={onRetry} retrying={retryingId === task.id} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-[116px] rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-12 rounded-xl" />
      <Skeleton className="h-[250px] rounded-xl" />
    </div>
  )
}

function TasksPage() {
  const { date } = Route.useSearch()
  const navigate = useNavigate({ from: '/tasks' })
  const queryClient = useQueryClient()
  const reduceMotion = useReducedMotion()
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const query = useQuery({ queryKey: ['tasks', date], queryFn: () => getTasks(date) })
  const platformsQuery = useQuery({ queryKey: ['platforms'], queryFn: getPlatforms })
  const accountTypesQuery = useQuery({ queryKey: ['account-types'], queryFn: getAccountTypes })
  const selectedDate = useMemo(() => dateFromKey(date), [date])

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

  const summary = query.data?.summary
  const dateLabel = format(selectedDate, 'yyyy年M月d日 EEEE', { locale: zhCN })

  return (
    <div className="space-y-7">
      <PageHeader
        title="任务数据"
        description="查看当天抓取任务和执行结果。"
        actions={
          <>
            <Button
              className="h-9 gap-1.5"
              onClick={() => setCreateOpen(true)}
              disabled={!platformsQuery.data?.platforms.length || !accountTypesQuery.data?.accountTypes.length}
            >
              <Plus className="size-4" />
              创建任务
            </Button>
            <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" className="h-9 gap-2 bg-card">
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
              className="size-9 bg-card"
              aria-label="刷新"
              onClick={() => query.refetch()}
            >
              <RefreshCw className={cn('size-4', query.isFetching && 'animate-spin')} />
            </Button>
          </>
        }
      />

      {query.isPending ? <LoadingState /> : null}

      {query.isError ? (
        <Card className="border-rose-200 bg-rose-50/60">
          <CardContent className="flex flex-col items-start gap-3 py-6">
            <div className="flex items-center gap-2 text-sm font-medium text-rose-900">
              <CircleX className="size-4" />
              任务数据加载失败
            </div>
            <p className="text-xs text-rose-800/80">{query.error.message}</p>
            <Button variant="outline" size="sm" onClick={() => query.refetch()}>
              重试
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {query.data ? (
        <>
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
            className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
          >
            <SummaryCard label="待执行" value={summary?.pending ?? 0} hint="等待执行" icon={ListTodo} tone="warning" />
            <SummaryCard label="执行中" value={summary?.running ?? 0} hint="正在执行" icon={LoaderCircle} />
            <SummaryCard
              label="成功"
              value={summary?.success ?? 0}
              hint={`内容 ${formatNumber(summary?.contentsSuccess ?? 0)} 条`}
              icon={CircleCheck}
              tone="success"
              delay={0.04}
            />
            <SummaryCard
              label="失败"
              value={summary?.failed ?? 0}
              hint={`账号失败 ${summary?.accountsFailed ?? 0} 个`}
              icon={CircleX}
              tone={summary?.failed ? 'danger' : 'default'}
              delay={0.08}
            />
          </motion.div>

          <motion.section
            initial={reduceMotion ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
            className="space-y-3"
          >
            <div className="flex items-end justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold tracking-tight">待执行</h2>
                  <Badge variant="secondary" className="h-5 rounded-full px-2 text-[10px]">{query.data.pending.length}</Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">计划在当天执行的任务。</p>
              </div>
            </div>
            <PendingTable tasks={query.data.pending} onDelete={handleDelete} deletingId={deletingId} />
          </motion.section>

          <motion.section
            initial={reduceMotion ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.14, ease: [0.22, 1, 0.36, 1] }}
            className="space-y-3"
          >
            <div className="flex items-end justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold tracking-tight">执行记录</h2>
                  <Badge variant="secondary" className="h-5 rounded-full px-2 text-[10px]">{query.data.executed.length}</Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">当天已经执行的任务。</p>
              </div>
              <div className="hidden items-center gap-2 text-[11px] text-muted-foreground sm:flex">
                <span className="size-1.5 rounded-full bg-emerald-500" />成功
                <span className="ml-2 size-1.5 rounded-full bg-rose-400" />失败
              </div>
            </div>
            <ExecutedTable tasks={query.data.executed} onRetry={handleRetry} retryingId={retryingId} />
          </motion.section>
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

      <div className="flex items-center justify-between border-t border-border/60 pt-4 text-[11px] text-muted-foreground">
        <span>共 {formatCount((summary?.pending ?? 0) + (summary?.success ?? 0) + (summary?.failed ?? 0) + (summary?.running ?? 0))} 个任务</span>
      </div>
    </div>
  )
}
