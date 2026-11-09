import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { CalendarDays, History, ListTodo, LoaderCircle, Pause, Pencil, Play, Plus, RefreshCw, Trash2, UsersRound } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale'

import { deleteTask, getAccountTypes, getPlatforms, getTasks, pauseTask, resumeTask } from '@/lib/api'
import type { Task } from '@/lib/types'
import { dateFromKey, dateKeyFromDate, formatClock, formatDateTime, formatNumber, formatWindow, todayKey } from '@/lib/format'
import StarBorder from '@/components/StarBorder/StarBorder'
import { AnimatedNumber } from '@/components/console/animated-number'
import { ConsoleBar } from '@/components/console/console-bar'
import { ConsolePage } from '@/components/console/console-page'
import { ROW_IN, ROW_STAGGER } from '@/components/console/motion'
import RubberSegment from '@/components/RubberSegment/RubberSegment'
import { PlatformMark } from '@/components/platform-mark'
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
type GroupBy = 'none' | 'platform' | 'accountType'

const GROUP_STORAGE_KEY = 'changan.tasks.group'
/** Stable empty value so the dialog effect does not reset while data loads. */
const NO_PLATFORM_COUNTS: Record<string, Record<string, number>> = {}
const UNCLASSIFIED = '__unclassified__'
const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: 'none', label: '不分组' },
  { value: 'platform', label: '平台' },
  { value: 'accountType', label: '账号类型' },
]

function isGroupBy(value: string): value is GroupBy {
  return value === 'none' || value === 'platform' || value === 'accountType'
}

/**
 * Grouping is a view preference, not content state: keeping it in the URL
 * would reset it every time you open a task and come back.
 */
function readStoredGroup(): GroupBy {
  if (typeof window === 'undefined') return 'none'
  try {
    const saved = window.localStorage.getItem(GROUP_STORAGE_KEY)
    if (saved && isGroupBy(saved)) return saved
  } catch {
    // localStorage may be unavailable
  }
  return 'none'
}

type TaskGroup = {
  key: string
  label: string
  code: string | null
  tasks: Task[]
}

function groupTasks(tasks: Task[], groupBy: GroupBy, rank: Map<string, number>): TaskGroup[] {
  if (groupBy === 'none') return [{ key: 'all', label: '', code: null, tasks }]

  const buckets = new Map<string, TaskGroup>()
  for (const task of tasks) {
    const accountType = task.accountType?.trim() || UNCLASSIFIED
    const key = groupBy === 'platform' ? task.platformId : accountType
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = {
        key,
        label:
          groupBy === 'platform'
            ? task.platformName || task.platformCode
            : accountType === UNCLASSIFIED
              ? '未分类'
              : accountType,
        code: groupBy === 'platform' ? task.platformCode : null,
        tasks: [],
      }
      buckets.set(key, bucket)
    }
    bucket.tasks.push(task)
  }

  // Follow the same order as the platform/account-type pickers, so the page
  // does not reshuffle itself from one day to the next.
  return [...buckets.values()].sort((a, b) => {
    const rankA = rank.get(a.key) ?? Number.MAX_SAFE_INTEGER
    const rankB = rank.get(b.key) ?? Number.MAX_SAFE_INTEGER
    return rankA === rankB ? a.label.localeCompare(b.label, 'zh-CN') : rankA - rankB
  })
}

function groupCoverage(tasks: Task[]) {
  return {
    total: tasks.reduce((sum, task) => sum + accountsOf(task), 0),
    success: tasks.reduce((sum, task) => sum + task.successAccounts, 0),
    failed: tasks.reduce((sum, task) => sum + task.failedAccounts, 0),
  }
}

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

/**
 * Records stay on their planned day, so a run that starts after midnight needs
 * the date next to the clock: "03:05" alone would point at the wrong day.
 */
function runMoment(task: Task, value: string | null): string {
  if (!value) return ''
  const moment = new Date(value)
  const planned = task.scheduledAt ? new Date(task.scheduledAt) : null
  if (Number.isNaN(moment.getTime())) return formatDateTime(value)
  if (planned && !Number.isNaN(planned.getTime()) && dateKeyFromDate(moment) !== dateKeyFromDate(planned)) {
    return formatDateTime(value)
  }
  return formatClock(value)
}

function taskRunClock(task: Task): string {
  if (!task.runStartedAt) return '—'
  if (!task.runFinishedAt) return `${runMoment(task, task.runStartedAt)} → 进行中`
  return `${runMoment(task, task.runStartedAt)} → ${runMoment(task, task.runFinishedAt)}`
}

function durationText(task: Task): string {
  if (!task.runStartedAt) return '—'
  const start = new Date(task.runStartedAt).getTime()
  const end = task.runFinishedAt ? new Date(task.runFinishedAt).getTime() : Date.now()
  if (Number.isNaN(start) || Number.isNaN(end)) return '—'
  const minutes = Math.max(0, Math.round((end - start) / 60_000))
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return hours > 0 ? `${hours} 小时 ${rest} 分` : `${rest} 分`
}

/** Run state, not outcome: is this batch still going, or is it done? */
function runState(task: Task): { label: string; tone: 'running' | 'ok' | 'fail' | 'idle'; detail: string } {
  if (task.status === 'running') {
    return { label: '运行中', tone: 'running', detail: task.runStartedAt ? `开始 ${runMoment(task, task.runStartedAt)}` : '已开始' }
  }
  if (task.status === 'cancelled') {
    return { label: '已取消', tone: 'idle', detail: '未完成' }
  }
  if (task.status === 'paused') {
    return { label: '已暂停', tone: 'idle', detail: task.scheduledAt ? `计划 ${formatDateTime(task.scheduledAt)}` : '已暂停' }
  }
  if (task.status === 'pending') {
    return { label: '待执行', tone: 'idle', detail: task.scheduledAt ? `计划 ${formatDateTime(task.scheduledAt)}` : '未排期' }
  }
  return {
    label: '已结束',
    tone: task.runStatus === 'partial_failed' || task.status === 'failed' ? 'fail' : 'ok',
    detail: task.runFinishedAt ? `用时 ${durationText(task)}` : '已结束',
  }
}

function RunCell({ task }: { task: Task }) {
  const state = runState(task)
  return (
    <span className="cx-run" data-tone={state.tone}>
      <span className="cx-run-label">{state.label}</span>
      <span className="cx-run-detail">{state.detail}</span>
    </span>
  )
}

function accountsOf(task: Task): number {
  return task.coverageTotal || task.plannedAccounts || task.totalAccounts
}

/** The account currently being scraped is the remainder not yet settled. */
function runningOf(task: Task): number {
  return Math.max(0, accountsOf(task) - task.successAccounts - task.failedAccounts - task.newAccounts)
}

/**
 * Solid coverage bar: completed (success / failed), the account being scraped,
 * then the queue, laid end to end over a track. One element per slice instead
 * of one per account, so the widths stay exact at any count.
 */
function Coverage({
  success,
  total,
  failed,
  running,
  pending,
}: {
  success: number
  total: number
  failed: number
  running: number
  pending: number
}) {
  const denominator = Math.max(total, 1)
  const okWidth = Math.min(100, (success / denominator) * 100)
  const failWidth = Math.min(100 - okWidth, (failed / denominator) * 100)
  const runWidth = Math.min(100 - okWidth - failWidth, (running / denominator) * 100)
  const pendingWidth = Math.min(100 - okWidth - failWidth - runWidth, (pending / denominator) * 100)

  return (
    <span className="cx-cover">
      <span className="cx-cover-num">
        <AnimatedNumber value={success} />
        <span>/{formatNumber(total)}</span>
      </span>
      <span className="cx-cover-bar" aria-hidden="true">
        <i data-state="ok" style={{ width: `${okWidth}%` }} />
        {failWidth > 0 ? <i data-state="fail" style={{ width: `${failWidth}%` }} /> : null}
        {runWidth > 0 ? <i data-state="run" style={{ width: `${runWidth}%` }} /> : null}
        {pendingWidth > 0 ? <i data-state="wait" style={{ width: `${pendingWidth}%` }} /> : null}
      </span>
      {failed > 0 || running > 0 || pending > 0 ? (
        <span className="cx-cover-note">
          {failed > 0 ? <span data-tone="fail">失败 {failed}</span> : null}
          {failed > 0 && (running > 0 || pending > 0) ? ' · ' : null}
          {running > 0 ? <span data-tone="run">运行中 {running}</span> : null}
          {running > 0 && pending > 0 ? ' · ' : null}
          {pending > 0 ? <span data-tone="wait">待补 {pending}</span> : null}
        </span>
      ) : null}
      <span className="sr-only">
        成功 {success} 个，失败 {failed} 个，运行中 {running} 个，待补 {pending} 个，共 {total} 个账号
      </span>
    </span>
  )
}

function EmptyBlock({ icon: Icon, title, hint }: { icon: typeof ListTodo; title: string; hint: string }) {
  return (
    <div className="cx-empty">
      <span className="cx-empty-icon">
        <Icon className="size-4" strokeWidth={1.7} />
      </span>
      <div className="cx-empty-body">
        <p className="cx-empty-title">{title}</p>
        <p className="cx-empty-hint">{hint}</p>
      </div>
    </div>
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

function PauseResumeButton({
  task,
  onPause,
  onResume,
  busy,
}: {
  task: Task
  onPause: (task: Task) => void
  onResume: (task: Task) => void
  busy: boolean
}) {
  const paused = task.status === 'paused'
  return (
    <button
      type="button"
      className="cx-link disabled:opacity-50"
      disabled={busy}
      aria-label={paused ? '继续执行任务' : '暂停执行任务'}
      onClick={(event) => {
        event.stopPropagation()
        if (paused) onResume(task)
        else onPause(task)
      }}
    >
      {busy
        ? <LoaderCircle className="size-3.5 animate-spin" />
        : paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
      {paused ? '继续' : '暂停'}
    </button>
  )
}

function EditTaskButton({ task, onEdit }: { task: Task; onEdit: (task: Task) => void }) {
  return (
    <button
      type="button"
      className="cx-link"
      aria-label="编辑任务"
      onClick={(event) => {
        event.stopPropagation()
        onEdit(task)
      }}
    >
      <Pencil className="size-3.5" />
      编辑
    </button>
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
  return <PlatformMark code={task.platformCode} name={task.platformName} />
}

function GroupHeaderRow({
  group,
  groupBy,
  colSpan,
  variant,
}: {
  group: TaskGroup
  groupBy: GroupBy
  colSpan: number
  variant: 'pending' | 'executed'
}) {
  const coverage = groupCoverage(group.tasks)
  return (
    <tr className="cx-group-row">
      <td colSpan={colSpan}>
        <div className="cx-group-cell">
          {groupBy === 'platform' ? (
            <PlatformMark code={group.code} name={group.label} size="sm" />
          ) : (
            <span className="cx-group-glyph" aria-hidden="true">
              <UsersRound className="size-3.5" />
            </span>
          )}
          <span className="cx-group-name">{group.label}</span>
          <span className="cx-group-count">{group.tasks.length} 个批次</span>
          <span className="cx-group-stats">
            {variant === 'executed'
              ? `账号 ${formatNumber(coverage.success)}/${formatNumber(coverage.total)}${coverage.failed > 0 ? ` · 失败 ${formatNumber(coverage.failed)}` : ''}`
              : coverage.total > 0
                ? `计划 ${formatNumber(coverage.total)} 个账号`
                : '未排期'}
          </span>
        </div>
      </td>
    </tr>
  )
}

function PendingTable({
  groups,
  grouped,
  groupBy,
  date,
  onDelete,
  deletingId,
  onPause,
  onResume,
  onEdit,
  actingId,
}: {
  groups: TaskGroup[]
  grouped: boolean
  groupBy: GroupBy
  date: string
  onDelete: (task: Task) => void
  deletingId: string | null
  onPause: (task: Task) => void
  onResume: (task: Task) => void
  onEdit: (task: Task) => void
  actingId: string | null
}) {
  const reduceMotion = useReducedMotion()
  return (
    <table className="cx-table">
      <thead>
        <tr>
          <th>平台</th>
          <th>账号类型</th>
          <th>周期（UTC+8）</th>
          <th>计划执行</th>
          <th className="cx-run-head">运行</th>
          <th className="cx-right">操作</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => (
          <Fragment key={group.key}>
            {grouped ? (
              <GroupHeaderRow group={group} groupBy={groupBy} colSpan={6} variant="pending" />
            ) : null}
            {group.tasks.map((task, index) => (
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
                <td data-label="运行"><RunCell task={task} /></td>
                <td data-label="操作" className="cx-right">
                  <div className="cx-row-actions">
                    <ViewTaskLink task={task} date={date} />
                    <EditTaskButton task={task} onEdit={onEdit} />
                    <PauseResumeButton task={task} onPause={onPause} onResume={onResume} busy={actingId === task.id} />
                    <DeleteTaskButton task={task} onDelete={onDelete} deleting={deletingId === task.id} />
                  </div>
                </td>
              </motion.tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  )
}

function ExecutedTable({
  groups,
  grouped,
  groupBy,
  date,
}: {
  groups: TaskGroup[]
  grouped: boolean
  groupBy: GroupBy
  date: string
}) {
  const reduceMotion = useReducedMotion()

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
          <th className="cx-run-head">运行</th>
          <th className="cx-right">操作</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => (
          <Fragment key={group.key}>
            {grouped ? (
              <GroupHeaderRow group={group} groupBy={groupBy} colSpan={8} variant="executed" />
            ) : null}
            {group.tasks.map((task, index) => (
              <motion.tr
                key={task.id}
                className="cx-row"
                initial={reduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ ...ROW_IN, delay: Math.min(index * ROW_STAGGER, 0.2) }}
              >
                <td data-block="true"><PlatformCell task={task} /></td>
                <td data-label="账号类型">{task.accountType || '—'}</td>
                <td data-label="周期"><span className="cx-window">{taskWindow(task)}</span></td>
                <td data-label="账号覆盖" className="cx-num">
                  <Coverage
                    success={task.successAccounts}
                    total={accountsOf(task)}
                    failed={task.failedAccounts}
                    running={runningOf(task)}
                    pending={task.newAccounts}
                  />
                </td>
                <td data-label="内容" className="cx-num">{formatNumber(task.contentMetricCount)}</td>
                <td data-label="执行时段" data-hide-mobile="true"><span className="cx-when">{taskRunClock(task)}</span></td>
                <td data-label="运行"><RunCell task={task} /></td>
                <td data-label="操作" className="cx-right">
                  <div className="cx-row-actions">
                    <ViewTaskLink task={task} date={date} />
                  </div>
                </td>
              </motion.tr>
            ))}
          </Fragment>
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
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [actingId, setActingId] = useState<string | null>(null)
  const [sweep, setSweep] = useState(1)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const query = useQuery({ queryKey: ['tasks', date], queryFn: () => getTasks(date) })
  const platformsQuery = useQuery({ queryKey: ['platforms'], queryFn: getPlatforms })
  const accountTypesQuery = useQuery({ queryKey: ['account-types'], queryFn: getAccountTypes })
  const selectedDate = useMemo(() => dateFromKey(date), [date])
  const reduceMotion = useReducedMotion()
  const [groupBy, setGroupBy] = useState<GroupBy>(readStoredGroup)

  const groupRank = useMemo(() => {
    const rank = new Map<string, number>()
    if (groupBy === 'platform') {
      platformsQuery.data?.platforms.forEach((platform, index) => rank.set(platform.id, index))
    } else if (groupBy === 'accountType') {
      accountTypesQuery.data?.accountTypes.forEach((type, index) => rank.set(type, index))
    }
    return rank
  }, [groupBy, platformsQuery.data, accountTypesQuery.data])

  const pendingGroups = useMemo(
    () => groupTasks(query.data?.pending ?? [], groupBy, groupRank),
    [query.data, groupBy, groupRank],
  )
  const executedGroups = useMemo(
    () => groupTasks(query.data?.executed ?? [], groupBy, groupRank),
    [query.data, groupBy, groupRank],
  )

  // The console page sits on its own phosphor screen instead of the app's paper.
  useEffect(() => {
    document.documentElement.classList.add('cx-page')
    return () => document.documentElement.classList.remove('cx-page')
  }, [])

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

  const handlePause = async (task: Task) => {
    setActingId(task.id)
    try {
      await pauseTask(task.id)
      toast.success('已暂停，worker 不会自动执行')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '暂停任务失败')
    } finally {
      setActingId(null)
      // The worker may have claimed it during the click: refresh either way so
      // the row moves to 执行记录 instead of staying stale in 待执行.
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    }
  }

  const handleResume = async (task: Task) => {
    setActingId(task.id)
    try {
      const result = await resumeTask(task.id)
      toast.success(result.immediate ? '已继续，计划时间已过，将立即执行' : '已继续，将按计划时间执行')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '继续任务失败')
    } finally {
      setActingId(null)
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    }
  }

  const handleSaved = (tasks: Task[]) => {
    const task = tasks[0]
    if (!task) return
    const taskDate = task.scheduledAt ? dateKeyFromDate(new Date(task.scheduledAt)) : date
    void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    for (const item of tasks) {
      void queryClient.invalidateQueries({ queryKey: ['task', item.id] })
    }
    if (taskDate !== date) {
      navigate({ to: '/tasks', search: { date: taskDate } })
    }
  }

  const changeDate = (next: Date | undefined) => {
    if (!next) return
    setCalendarOpen(false)
    navigate({ to: '/tasks', search: { date: format(next, 'yyyy-MM-dd') } })
  }

  const changeGroup = (value: string) => {
    if (!isGroupBy(value)) return
    setGroupBy(value)
    try {
      window.localStorage.setItem(GROUP_STORAGE_KEY, value)
    } catch {
      // ignore write failures
    }
  }

  const refresh = () => {
    setSweep((value) => value + 1)
    void query.refetch()
  }


  const dateLabel = format(selectedDate, 'yyyy年M月d日 EEEE', { locale: zhCN })
  const shortDateLabel = format(selectedDate, 'M月d日 EEE', { locale: zhCN })

  if (query.isPending) return <LoadingState />

  return (
    <ConsolePage>
      <ConsoleBar title="任务数据" description="查看当天抓取任务和执行结果。">
        <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" className="gap-2 font-normal">
              <CalendarDays className="size-4 text-muted-foreground" />
              <span className="hidden sm:inline">{dateLabel}</span>
              <span className="sm:hidden">{shortDateLabel}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="cx-portal w-auto p-0">
            <Calendar mode="single" selected={selectedDate} onSelect={changeDate} locale={zhCN} />
          </PopoverContent>
        </Popover>
        <div className="cx-groupby">
          <span className="cx-groupby-label">分组</span>
          <div className="cx-chips">
            <RubberSegment
              aria-label="任务分组方式"
              size="sm"
              equalSlots={false}
              inset={2}
              items={GROUP_OPTIONS}
              value={groupBy}
              onChange={changeGroup}
              trackColor="transparent"
              thumbColor="color-mix(in oklab, var(--cx-accent) 16%, transparent)"
              textColor="var(--cx-ink-2)"
              activeTextColor="var(--cx-ink)"
            />
          </div>
        </div>
        <Button variant="outline" size="icon" aria-label="刷新" onClick={refresh}>
          <RefreshCw className={query.isFetching ? 'size-4 animate-spin' : 'size-4 transition-transform duration-300 group-hover/button:rotate-90'} />
        </Button>
        <StarBorder
          as="button"
          className="cx-cta h-9 px-4 text-[13.5px]"
          radius={6}
          thickness={1}
          color="#ffffff"
          trailColor="#d7fff0"
          backgroundColor="var(--primary)"
          textColor="var(--primary-foreground)"
          borderColor="color-mix(in oklab, var(--primary) 70%, transparent)"
          duration={4}
          stars={1}
          trailLength={0.3}
          glow={0.6}
          hover="lap"
          disabled={!platformsQuery.data?.platforms.length || !accountTypesQuery.data?.accountTypes.length}
          onClick={() => {
            setEditingTask(null)
            setCreateOpen(true)
          }}
        >
          <Plus className="size-4" />
          创建任务
        </StarBorder>
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
              <span className="cx-count">
                {query.data.pending.length} 个批次
                {query.data.summary.paused > 0 ? ` · ${query.data.summary.paused} 个已暂停` : ''}
              </span>
            </div>
            <motion.div
              key={`pending-${date}`}
              className="cx-surface"
              initial={reduceMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={ROW_IN}
            >
              {query.data.pending.length > 0 ? (
                <PendingTable
                  groups={pendingGroups}
                  grouped={groupBy !== 'none'}
                  groupBy={groupBy}
                  date={date}
                  onDelete={handleDelete}
                  deletingId={deletingId}
                  onPause={handlePause}
                  onResume={handleResume}
                  onEdit={(task) => {
                    setCreateOpen(false)
                    setEditingTask(task)
                  }}
                  actingId={actingId}
                />
              ) : (
                <EmptyBlock
                  icon={ListTodo}
                  title="当天没有待执行的批次"
                  hint="创建任务后，它会按计划执行时间出现在这里；暂停的任务也会保留在这里。"
                />
              )}
            </motion.div>
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
              initial={reduceMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={ROW_IN}
            >
              {!reduceMotion ? <span className="cx-crt" aria-hidden="true" /> : null}
              {!reduceMotion ? <span key={sweep} className="cx-sweep" aria-hidden="true" /> : null}
              {query.data.executed.length > 0 ? (
                <ExecutedTable
                  groups={executedGroups}
                  grouped={groupBy !== 'none'}
                  groupBy={groupBy}
                  date={date}
                />
              ) : (
                <EmptyBlock
                  icon={History}
                  title="当天还没有执行记录"
                  hint="任务开始执行后，会留在计划执行日期下，跨天执行也不会移走。"
                />
              )}
            </motion.div>
          </section>
        </>
      ) : null}

      <TaskDialog
        open={createOpen || editingTask !== null}
        task={editingTask}
        onOpenChange={(open) => {
          if (!open) {
            setCreateOpen(false)
            setEditingTask(null)
          }
        }}
        platforms={platformsQuery.data?.platforms ?? []}
        accountTypes={accountTypesQuery.data?.accountTypes ?? []}
        platformCounts={accountTypesQuery.data?.platformCounts ?? NO_PLATFORM_COUNTS}
        defaultDate={date}
        onSaved={handleSaved}
      />
    </ConsolePage>
  )
}
