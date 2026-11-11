import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  CalendarClock,
  CircleAlert,
  CircleX,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Hourglass,
  Info,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  UsersRound,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'

import { cancelTask, getTask, pauseTask, rerunTask, resumeTask } from '@/lib/api'
import { downloadTaskExcel } from '@/lib/export-task'
import type { ActiveRerun, TaskAccount, TaskChildRun, TaskContent, TaskDetailResponse } from '@/lib/types'
import { dateKeyFromDate, formatClock, formatDateTime, formatFullDate, formatFullDateTime, formatNumber, formatWindow, todayKey } from '@/lib/format'
import RubberSegment from '@/components/RubberSegment/RubberSegment'
import { CancelTaskDialog } from '@/components/cancel-task-dialog'
import { ConsoleBar } from '@/components/console/console-bar'
import { ConsolePage } from '@/components/console/console-page'
import '@/components/console/console.css'
import { ChangeBadge } from '@/components/day-compare'
import { PlatformMark } from '@/components/platform-mark'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import PillNav from '@/components/PillNav/PillNav'
import { useTheme } from '@/lib/theme'
import { Checkbox } from '@/components/ui/checkbox'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

export const Route = createFileRoute('/tasks/$taskId')({
  component: TaskDetailPage,
})

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl bg-muted/45 px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium tabular-nums">{value}</p>
    </div>
  )
}

const coverageMeta: Record<string, { label: string; className: string; dot: string }> = {
  success: { label: '成功', className: 'text-emerald-400', dot: 'bg-emerald-400' },
  failed: { label: '失败', className: 'text-rose-400', dot: 'bg-rose-400' },
  partial: { label: '部分失败', className: 'text-orange-400', dot: 'bg-orange-400' },
  pending: { label: '新增待补', className: 'text-sky-400', dot: 'bg-sky-400' },
  running: { label: '执行中', className: 'text-sky-400', dot: 'bg-sky-400 animate-soft-pulse' },
  disabled: { label: '已禁用', className: 'text-muted-foreground', dot: 'bg-muted-foreground/50' },
}

function CoverageStatus({ account }: { account: TaskAccount }) {
  if (account.queue) {
    const state = account.queue.status
    const last = account.status === 'success'
      ? '上次成功'
      : account.status === 'partial'
        ? '上次部分失败'
        : account.status === 'failed'
          ? '上次失败'
          : null
    const note = state === 'paused'
      ? '补跑已暂停'
      : state === 'running'
        ? '补跑执行中，等待账号'
        : '补跑排队中'
    const title = state === 'paused'
      ? `补跑任务已暂停，不会自动执行${account.queue.accountCount > 1 ? `（本次共 ${account.queue.accountCount} 个账号）` : ''}`
      : state === 'running'
        ? '补跑任务执行中，该账号还在等待'
        : `补跑排队中${account.queue.scheduledAt ? `，加入队列 ${formatClock(account.queue.scheduledAt)}` : ''}${account.queue.accountCount > 1 ? `（本次共 ${account.queue.accountCount} 个账号）` : ''}`
    return (
      <span className="cx-queue-status" data-state={state} title={title}>
        <span className="cx-queue-status-label">
          <span className="cx-queue-status-dot" />
          {state === 'paused' ? '已暂停' : '待执行'}
        </span>
        <span className="cx-queue-status-note">
          {note}{last ? ` · ${last}` : ''}
        </span>
      </span>
    )
  }

  const isZero = account.status === 'success' && Number(account.contentCountInWindow || 0) === 0
  const meta = isZero
    ? { label: '无数据', className: 'text-amber-400', dot: 'bg-amber-400' }
    : coverageMeta[account.status] || coverageMeta.pending
  return (
    <span className={cn('inline-flex items-center gap-2 text-xs font-medium', meta.className)}>
      <span className={cn('size-1.5 rounded-full', meta.dot)} />
      {meta.label}
    </span>
  )
}

/**
 * The same account on the previous business day. Values are read from that
 * day's latest successful run, so they line up with the current-day cells.
 */
function YesterdayAccountCell({ account }: { account: TaskAccount }) {
  const yesterday = account.yesterday
  if (!yesterday) {
    return <span className="text-xs text-muted-foreground" title="昨天没有该账号的成功抓取数据">—</span>
  }
  return (
    <div
      className="flex flex-col items-end gap-0.5 text-[11px] leading-tight tabular-nums text-muted-foreground"
      title={`昨日（${yesterday.date}）${yesterday.runStartedAt ? `${formatClock(yesterday.runStartedAt)} ` : ''}的抓取数据`}
    >
      <span className="inline-flex items-baseline gap-1.5">
        <span className="text-[10px]">内容</span>
        <span className="text-foreground/80">{formatNumber(yesterday.contentCountInWindow)}</span>
        <ChangeBadge today={account.contentCountInWindow} yesterday={yesterday.contentCountInWindow} />
      </span>
      <span className="inline-flex items-baseline gap-1.5">
        <span className="text-[10px]">粉丝</span>
        <span className="text-foreground/80">{formatNumber(yesterday.followersCount)}</span>
      </span>
      <span className="inline-flex items-baseline gap-1.5">
        <span className="text-[10px]">帖子</span>
        <span className="text-foreground/80">{formatNumber(yesterday.postsCount)}</span>
      </span>
    </div>
  )
}

type ConfirmAction = {
  mode: 'failed' | 'new' | 'selected'
  ids: string[]
  title: string
  description: string
}

function rerunKindLabel(kind: string): string {
  return kind === 'retry_failed' ? '失败重试' : kind === 'backfill_new' ? '补充新增' : '手动重跑'
}

/** Pause/resume/cancel a child task, then refresh the parent detail and list. */
function useRerunAction(taskId: string) {
  const queryClient = useQueryClient()
  const [busyId, setBusyId] = useState<string | null>(null)
  const run = async (id: string, action: 'pause' | 'resume' | 'cancel') => {
    setBusyId(id)
    try {
      if (action === 'pause') await pauseTask(id)
      else if (action === 'resume') await resumeTask(id)
      else await cancelTask(id)
      toast.success(
        action === 'pause' ? '已暂停补跑任务' : action === 'resume' ? '已继续补跑任务' : '已取消补跑任务',
      )
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作补跑任务失败')
      return false
    } finally {
      setBusyId(null)
      void queryClient.invalidateQueries({ queryKey: ['task', taskId] })
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    }
  }
  return { busyId, run }
}

function RerunQueueBanner({
  rerun,
  busy,
  onAction,
  onCancel,
}: {
  rerun: ActiveRerun
  busy: boolean
  onAction: (action: 'pause' | 'resume') => void
  onCancel: () => void
}) {
  const done = rerun.successAccounts + rerun.failedAccounts
  const label = rerun.status === 'running'
    ? '补跑执行中'
    : rerun.status === 'paused'
      ? '补跑已暂停'
      : '补跑排队中'
  return (
    <div className="cx-rerun" data-state={rerun.status}>
      <span className="cx-rerun-icon">
        {rerun.status === 'running'
          ? <LoaderCircle className="size-4 animate-spin" />
          : rerun.status === 'paused'
            ? <Pause className="size-4" />
            : <Hourglass className="size-4" />}
      </span>
      <div className="cx-rerun-body">
        <p className="cx-rerun-title">
          {label}
          <em>{rerunKindLabel(rerun.kind)} · {rerun.accountCount} 个账号</em>
        </p>
        <p className="cx-rerun-detail">
          {rerun.status === 'running'
            ? `已完成 ${done}/${rerun.accountCount}${rerun.runStartedAt ? ` · 开始 ${formatClock(rerun.runStartedAt)}` : ''}`
            : rerun.status === 'paused'
              ? `不会自动执行，可以继续或取消${rerun.createdAt ? ` · 创建于 ${formatDateTime(rerun.createdAt)}` : ''}`
              : `等待 worker 领取，可以暂停或取消${rerun.createdAt ? ` · 创建于 ${formatDateTime(rerun.createdAt)}` : ''}`}
        </p>
      </div>
      <div className="cx-rerun-actions">
        {rerun.status === 'pending' ? (
          <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={() => onAction('pause')}>
            {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Pause className="size-3.5" />}
            暂停
          </Button>
        ) : null}
        {rerun.status === 'paused' ? (
          <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={() => onAction('resume')}>
            {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            继续
          </Button>
        ) : null}
        {rerun.status === 'pending' || rerun.status === 'paused' ? (
          <Button size="sm" variant="ghost" className="cx-rerun-cancel gap-1.5" disabled={busy} onClick={onCancel}>
            <CircleX className="size-3.5" />
            取消补跑
          </Button>
        ) : null}
        {rerun.status === 'running' ? <span className="cx-rerun-live">执行中，当前不可取消</span> : null}
      </div>
    </div>
  )
}

/**
 * The rerun is a task-level state, so the banner lives above the tabs and
 * stays reachable from 账号数据、帖子数据 and 执行信息 alike.
 */
function ActiveRerunPanel({ rerun, taskId }: { rerun: ActiveRerun; taskId: string }) {
  const { busyId, run } = useRerunAction(taskId)
  const [cancelOpen, setCancelOpen] = useState(false)
  return (
    <>
      <RerunQueueBanner
        rerun={rerun}
        busy={busyId === rerun.id}
        onAction={(action) => {
          void run(rerun.id, action)
        }}
        onCancel={() => setCancelOpen(true)}
      />
      <CancelTaskDialog
        target={cancelOpen
          ? {
              id: rerun.id,
              accountCount: rerun.accountCount,
              title: `取消这次${rerunKindLabel(rerun.kind)}？`,
              description: `将取消 ${rerun.accountCount} 个账号的补跑。这些账号不会重新执行，已经抓到的数据不受影响。`,
            }
          : null}
        busy={busyId === rerun.id}
        onClose={() => setCancelOpen(false)}
        onConfirm={(id) => {
          void run(id, 'cancel').then((ok) => {
            if (ok) setCancelOpen(false)
          })
        }}
      />
    </>
  )
}

function AccountTable({
  accounts,
  coverage,
  taskId,
  yesterday,
  activeRerun,
  canRerun,
}: {
  accounts: TaskAccount[]
  coverage: TaskDetailResponse['coverage']
  taskId: string
  yesterday: TaskDetailResponse['yesterday']
  activeRerun: ActiveRerun | null
  canRerun: boolean
}) {
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const failed = accounts.filter((a) => a.status === 'failed' || a.status === 'partial')
  const newAccounts = accounts.filter((a) => a.status === 'pending' && a.isNew)
  const zero = accounts.filter((a) => a.status === 'success' && Number(a.contentCountInWindow || 0) === 0)
  const success = accounts.filter((a) => a.status === 'success')
  const disabled = accounts.filter((a) => a.status === 'disabled')
  const queued = accounts.filter((a) => a.queue)
  // Buttons can only chase accounts that are not already on their way back.
  const retryTargets = failed.filter((a) => !a.queue)
  const newTargets = newAccounts.filter((a) => !a.queue)
  const effectiveFilter = filter || (failed.length + newAccounts.length > 0 ? 'action' : queued.length > 0 ? 'queued' : 'all')
  const filtered = useMemo(() => {
    if (effectiveFilter === 'action') return accounts.filter((a) => a.status === 'failed' || a.status === 'partial' || (a.status === 'pending' && a.isNew));
    if (effectiveFilter === 'failed') return failed;
    if (effectiveFilter === 'new') return newAccounts;
    if (effectiveFilter === 'queued') return queued;
    if (effectiveFilter === 'zero') return zero;
    if (effectiveFilter === 'success') return success;
    if (effectiveFilter === 'disabled') return disabled;
    return accounts;
  }, [accounts, effectiveFilter, failed, newAccounts, queued, zero, success, disabled])
  const selectable = canRerun ? filtered.filter((a) => a.status !== 'disabled' && !a.queue) : []
  const allSelected = selectable.length > 0 && selectable.every((a) => selected.has(a.accountId))

  // A worker can claim the queued rerun while the operator still has a
  // selection from before; the selection must not survive into the next batch.
  useEffect(() => {
    if (!canRerun) setSelected(new Set())
  }, [canRerun])

  const toggle = (id: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(id); else next.delete(id)
      return next
    })
  }
  const toggleAll = (checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current)
      for (const account of selectable) {
        if (checked) next.add(account.accountId); else next.delete(account.accountId)
      }
      return next
    })
  }
  const ask = (mode: 'failed' | 'new' | 'selected', ids: string[]) => {
    if (!ids.length) return
    setConfirm({
      mode,
      ids,
      title: mode === 'failed' ? '重试失败账号' : mode === 'new' ? '补新增账号' : '重跑选中账号',
      description: mode === 'selected'
        ? '即使这些账号之前成功也会重新执行；已禁用账号不会被处理。'
        : '将沿用当前任务的时间范围，只处理目标账号；已成功账号不会被重复执行。',
    })
  }
  const submit = async () => {
    if (!confirm) return
    setSubmitting(true)
    try {
      await rerunTask(taskId, confirm.mode, confirm.ids)
      toast.success(`已加入补跑队列（${confirm.ids.length} 个账号），可在上方查看、暂停或取消`)
      setSelected(new Set())
      setConfirm(null)
      await queryClient.invalidateQueries({ queryKey: ['task', taskId] })
      await queryClient.invalidateQueries({ queryKey: ['tasks'] })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建补跑任务失败')
    } finally {
      setSubmitting(false)
    }
  }

  if (!accounts.length) {
    return <EmptyState icon={UsersRound} title="没有账号数据" description="任务尚未执行，或本次没有选中账号。" />
  }

  const filters = [
    { key: 'all', label: '全部', count: accounts.length },
    { key: 'action', label: '需处理', count: failed.length + newAccounts.length },
    { key: 'failed', label: '失败', count: failed.length },
    { key: 'new', label: '新增待补', count: newAccounts.length },
    { key: 'queued', label: '排队中', count: queued.length },
    { key: 'zero', label: '无数据', count: zero.length },
    { key: 'success', label: '成功', count: success.length },
    { key: 'disabled', label: '已禁用', count: disabled.length },
  ]

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border/80 bg-muted/25 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">账号覆盖 {coverage.success} / {coverage.total}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              成功 {coverage.success} · 失败 {coverage.failed} · 运行中 {coverage.running} · 新增待补 {coverage.newAccounts} · 已禁用 {coverage.disabled}
            </p>
            {coverage.queued > 0 ? (
              <p className="mt-0.5 text-[11px] text-[var(--cx-warn)]">
                其中 {coverage.queued} 个账号在补跑队列中
              </p>
            ) : null}
            {yesterday ? (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                昨日 {yesterday.date.slice(5)} 覆盖 {yesterday.accountsWithData}/{yesterday.total} · 内容 {formatNumber(yesterday.contentCount)}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {retryTargets.length > 0 ? <Button size="sm" variant="outline" disabled={!canRerun} onClick={() => ask('failed', retryTargets.map((a) => a.accountId))}><RefreshCw className="size-3.5" />重试失败 {retryTargets.length}</Button> : null}
            {newTargets.length > 0 ? <Button size="sm" disabled={!canRerun} onClick={() => ask('new', newTargets.map((a) => a.accountId))}><UsersRound className="size-3.5" />补新增 {newTargets.length}</Button> : null}
            {!canRerun ? (
              <span className="cx-hint self-center">
                {activeRerun ? '已有补跑任务在队列中，完成后再补跑' : '任务执行结束后才能补跑'}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="cx-chips-row">
        <div className="cx-chips">
          <RubberSegment
            aria-label="账号筛选"
            size="sm"
            equalSlots={false}
            inset={2}
            items={filters.map((item) => ({ value: item.key, label: `${item.label} ${item.count}` }))}
            value={effectiveFilter}
            onChange={(value) => setFilter(value)}
            trackColor="transparent"
            thumbColor="color-mix(in oklab, var(--cx-accent) 16%, transparent)"
            textColor="var(--cx-ink-2)"
            activeTextColor="var(--cx-ink)"
          />
        </div>
        <span className="cx-hint">“需处理” = 失败账号 + 新增待补账号；排队中的账号已在补跑队列里</span>
      </div>

      {canRerun && selected.size > 0 ? (
        <div className="sticky top-2 z-10 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/25 bg-primary/5 px-3 py-2 text-xs">
          <span>已选 {selected.size} 个账号</span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>取消选择</Button>
            <Button size="sm" onClick={() => ask('selected', [...selected])}>重跑选中账号</Button>
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-2xl border border-border/70 bg-card shadow-[0_24px_60px_-52px_rgba(6,78,59,0.55)]">
        <Table className="min-w-[1220px]">
          <TableHeader>
            <TableRow className="bg-emerald-50/60 hover:bg-emerald-50/60">
              <TableHead className="w-10">
                <Checkbox
                  checked={allSelected ? true : selectable.some((a) => selected.has(a.accountId)) ? 'indeterminate' : false}
                  disabled={!canRerun || selectable.length === 0}
                  onCheckedChange={(value) => toggleAll(value === true)}
                  aria-label="选择当前筛选账号"
                />
              </TableHead>
              <TableHead>账号</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">窗口内容</TableHead>
              <TableHead className="text-right">粉丝</TableHead>
              <TableHead className="text-right">帖子数</TableHead>
              <TableHead className="text-right" title="同一账号在昨天的数据；百分比为今日较昨日的变化">
                {yesterday
                  ? <>昨日 <span className="text-[10px] font-normal text-muted-foreground">{yesterday.date.slice(5)}</span></>
                  : '昨日'}
              </TableHead>
              <TableHead>最近执行</TableHead>
              <TableHead>错误</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((account) => (
              <TableRow key={account.accountId} className={account.status === 'disabled' ? 'opacity-55' : undefined}>
                <TableCell>
                  <Checkbox
                    checked={selected.has(account.accountId)}
                    disabled={!canRerun || account.status === 'disabled' || Boolean(account.queue)}
                    title={account.queue
                      ? '已在补跑队列中'
                      : activeRerun
                        ? '已有补跑任务在队列中，完成后再补跑'
                        : !canRerun
                          ? '任务执行结束后才能补跑'
                          : undefined}
                    onCheckedChange={(value) => toggle(account.accountId, value === true)}
                    aria-label={`选择 ${account.handle}`}
                  />
                </TableCell>
                <TableCell>
                  <div className="flex flex-col">
                    <a href={account.profileUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium hover:text-primary">
                      {account.handle}
                      <ExternalLink className="size-3 text-muted-foreground" />
                    </a>
                    <span className="mt-0.5 text-[11px] text-muted-foreground">{account.displayName || '—'}</span>
                  </div>
                </TableCell>
                <TableCell><CoverageStatus account={account} /></TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(account.contentCountInWindow)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(account.followersCount)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(account.postsCount)}</TableCell>
                <TableCell className="text-right"><YesterdayAccountCell account={account} /></TableCell>
                <TableCell className="text-xs tabular-nums text-muted-foreground">{formatFullDateTime(account.latestRunStartedAt)}</TableCell>
                <TableCell>
                  {account.errorMessage ? (
                    <span className="line-clamp-2 max-w-[220px] text-[11px] text-rose-700" title={account.errorMessage}>{account.errorMessage}</span>
                  ) : <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="text-right">
                  {account.queue ? (
                    <span className="shrink-0 whitespace-nowrap text-[11px] font-medium text-[var(--cx-warn)]">已排队</span>
                  ) : account.status === 'disabled' ? (
                    <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">不可操作</span>
                  ) : !canRerun ? (
                    <span
                      className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground"
                      title={activeRerun ? '已有补跑任务在队列中，完成后再补跑' : '任务执行结束后才能补跑'}
                    >
                      —
                    </span>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => ask('selected', [account.accountId])}>重跑</Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={Boolean(confirm)} onOpenChange={(open) => { if (!open) setConfirm(null) }}>
        <AlertDialogContent className="cx-portal">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}？</AlertDialogTitle>
            <AlertDialogDescription>
              将处理 {confirm?.ids.length || 0} 个账号。{confirm?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>取消</AlertDialogCancel>
            <AlertDialogAction onClick={submit} disabled={submitting}>{submitting ? '创建中…' : '确认'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function ContentTable({ contents }: { contents: TaskContent[] }) {
  const [accountFilter, setAccountFilter] = useState('all')
  const [page, setPage] = useState(1)
  const pageSize = 50
  const accounts = useMemo(() => {
    const map = new Map<string, string>()
    for (const content of contents) {
      if (!map.has(content.accountId)) {
        map.set(content.accountId, content.accountHandle || content.accountId)
      }
    }
    return [...map.entries()].map(([id, label]) => ({ id, label }))
  }, [contents])
  const filtered = useMemo(
    () => accountFilter === 'all' ? contents : contents.filter((content) => content.accountId === accountFilter),
    [contents, accountFilter],
  )
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const visible = useMemo(() => filtered.slice((page - 1) * pageSize, page * pageSize), [filtered, page])

  useEffect(() => {
    setPage(1)
  }, [accountFilter])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  if (!contents.length) {
    return <EmptyState icon={FileText} title="没有帖子数据" description="任务尚未执行，或抓取窗口内没有内容。" />
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">共 {filtered.length} 条内容，当前显示 {visible.length} 条</p>
        <div className="flex items-center gap-2">
          <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">按账号筛选</span>
          <Select value={accountFilter} onValueChange={setAccountFilter}>
            <SelectTrigger className="h-8 w-[200px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent className="cx-portal">
              <SelectItem value="all">全部账号</SelectItem>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>{account.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="cx-surface overflow-x-auto">
        <Table className="min-w-[1120px]">
          <TableHeader>
            <TableRow className="bg-emerald-50/60 hover:bg-emerald-50/60">
              <TableHead className="min-w-[280px]">内容</TableHead>
              <TableHead className="min-w-[170px]">账号</TableHead>
              <TableHead className="w-[90px]">类型</TableHead>
              <TableHead className="w-[150px]">发布时间</TableHead>
              <TableHead className="text-right">播放/阅读</TableHead>
              <TableHead className="text-right">点赞</TableHead>
              <TableHead className="text-right">评论</TableHead>
              <TableHead className="text-right">转发</TableHead>
              <TableHead className="text-right">收藏</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((content) => (
              <TableRow key={content.id}>
                <TableCell>
                  <div className="max-w-[420px]">
                    <a
                      href={content.url}
                      target="_blank"
                      rel="noreferrer"
                      className="line-clamp-2 text-sm font-medium leading-snug hover:text-primary"
                    >
                      {content.title || content.summary || content.externalContentId || content.url}
                    </a>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="text-xs font-medium">{content.accountHandle}</span>
                  </div>
                </TableCell>
                <TableCell><span className="cx-tag">{content.contentType || '内容'}</span></TableCell>
                <TableCell className="text-xs tabular-nums text-muted-foreground">{formatDateTime(content.publishTime)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(content.playCount ?? content.readCount ?? content.exposureCount)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(content.likeCount)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(content.commentCount)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(content.shareCount)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(content.collectCount)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {filtered.length > pageSize ? (
        <div className="flex items-center justify-end gap-2 pt-1">
          <span className="text-xs tabular-nums text-muted-foreground">第 {page} / {totalPages} 页</span>
          <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} aria-label="帖子上一页">
            <ChevronLeft className="size-4" />
          </Button>
          <Button variant="outline" size="icon-sm" disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} aria-label="帖子下一页">
            <ChevronRight className="size-4" />
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function ChildTaskTable({
  childTasks,
  parentTaskId,
}: {
  childTasks: TaskChildRun[]
  parentTaskId: string
}) {
  const { busyId, run } = useRerunAction(parentTaskId)
  const [cancelTarget, setCancelTarget] = useState<TaskChildRun | null>(null)
  const childDate = (child: TaskChildRun) => {
    const value = child.scheduledAt || child.createdAt
    return value ? dateKeyFromDate(new Date(value)) : todayKey()
  }

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-emerald-50/60 hover:bg-emerald-50/60">
              <TableHead>类型</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">账号</TableHead>
              <TableHead className="text-right">内容</TableHead>
              <TableHead>开始</TableHead>
              <TableHead>结束</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {childTasks.map((child) => {
              const busy = busyId === child.id
              const total = child.accountCount || child.plannedAccounts
              const active = child.status === 'pending' || child.status === 'paused'
              return (
                <TableRow key={child.id}>
                  <TableCell className="text-xs">{rerunKindLabel(child.kind)}</TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <StatusBadge status={child.status} runStatus={child.runStatus} />
                      {active ? (
                        <span className="text-[10px] text-muted-foreground">
                          {child.status === 'paused'
                            ? '不会自动执行'
                            : `加入队列 ${formatDateTime(child.scheduledAt)}`}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {active ? `—/${total}` : `${child.successAccounts}/${total}`}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{child.contentMetricCount}</TableCell>
                  <TableCell className="text-xs tabular-nums text-muted-foreground">{formatFullDateTime(child.runStartedAt)}</TableCell>
                  <TableCell className="text-xs tabular-nums text-muted-foreground">{formatFullDateTime(child.runFinishedAt)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {child.status === 'pending' ? (
                        <Button size="sm" variant="ghost" className="gap-1.5" disabled={busy} onClick={() => void run(child.id, 'pause')}>
                          {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Pause className="size-3.5" />}
                          暂停
                        </Button>
                      ) : null}
                      {child.status === 'paused' ? (
                        <Button size="sm" variant="ghost" className="gap-1.5" disabled={busy} onClick={() => void run(child.id, 'resume')}>
                          {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                          继续
                        </Button>
                      ) : null}
                      {active ? (
                        <Button size="sm" variant="ghost" className="cx-rerun-cancel gap-1.5" disabled={busy} onClick={() => setCancelTarget(child)}>
                          <CircleX className="size-3.5" />
                          取消
                        </Button>
                      ) : null}
                      <Button asChild size="sm" variant="ghost">
                        <Link
                          to="/tasks/$taskId"
                          params={{ taskId: child.id }}
                          search={{ date: childDate(child) }}
                        >
                          查看
                        </Link>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <CancelTaskDialog
        target={cancelTarget
          ? {
              id: cancelTarget.id,
              accountCount: cancelTarget.accountCount,
              title: `取消这次${rerunKindLabel(cancelTarget.kind)}？`,
              description: `将取消 ${cancelTarget.accountCount} 个账号的补跑。这些账号不会重新执行，已经抓到的数据不受影响。`,
            }
          : null}
        busy={Boolean(cancelTarget && busyId === cancelTarget.id)}
        onClose={() => setCancelTarget(null)}
        onConfirm={(id) => {
          void run(id, 'cancel').then((ok) => {
            if (ok) setCancelTarget(null)
          })
        }}
      />
    </>
  )
}

function TaskDetailPage() {
  const { taskId } = Route.useParams()
  const reduceMotion = useReducedMotion()
  const { theme } = useTheme()
  const [view, setView] = useState('accounts')
  const query = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => getTask(taskId),
    // A queued rerun moves to "running" on the worker's schedule; keep the
    // detail current while there is live work instead of making the operator
    // reload to find out whether the click landed.
    refetchInterval: (current) => {
      const data = current.state.data
      if (!data) return false
      const rerun = data.task.activeRerun
      const live = data.task.status === 'running' || Boolean(rerun && rerun.status !== 'paused')
      return live ? 8000 : false
    },
  })

  if (query.isPending) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-20 w-full rounded-2xl" />
        <div className="grid gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-20 rounded-xl" />)}
        </div>
        <Skeleton className="h-[320px] rounded-2xl" />
      </div>
    )
  }

  if (query.isError) {
    return (
      <Card className="cx-banner">
        <CardContent className="flex items-start gap-3 py-6">
          <CircleAlert className="mt-0.5 size-4 text-rose-700" />
          <div>
            <p className="text-sm font-medium text-rose-900">任务详情加载失败</p>
            <p className="mt-1 text-xs text-rose-800/80">{query.error.message}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => query.refetch()}>重试</Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  const { task, run, accounts, contents, coverage, childTasks, yesterday } = query.data
  // A rerun is a child task, so the parent row can be "success" while work is
  // still queued. The header needs to say that out loud.
  const canRerun = !task.parentTaskId
    && !task.activeRerun
    && !['pending', 'running', 'paused'].includes(task.status)
  const rerunLabel = task.activeRerun
    ? task.activeRerun.status === 'running'
      ? '补跑执行中'
      : task.activeRerun.status === 'paused'
        ? '补跑已暂停'
        : '补跑排队中'
    : null
  // The list groups tasks by their planned day, so go back there rather than to
  // the day a late run happened to start.
  const backDate = task.scheduledAt
    ? dateKeyFromDate(new Date(task.scheduledAt))
    : run?.startedAt
      ? dateKeyFromDate(new Date(run.startedAt))
      : task.runStartedAt
        ? dateKeyFromDate(new Date(task.runStartedAt))
        : todayKey()
  return (
    <ConsolePage>
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="space-y-6"
    >
      <ConsoleBar
        title={
          <span className="cx-plat-lockup">
            <PlatformMark code={task.platformCode} name={task.platformName} size="lg" />
            <span>任务详情</span>
          </span>
        }
        description="查看任务结果、账号数据和帖子数据。"
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() => {
                void downloadTaskExcel({ task, accounts, contents })
                  .then(() => toast.success('Excel 已生成'))
                  .catch((error) => toast.error(error instanceof Error ? error.message : 'Excel 生成失败'))
              }}
            >
              <Download className="size-3.5" />
              下载 Excel
            </Button>
            <Button asChild variant="outline" className="gap-1.5">
              <Link to="/tasks" search={{ date: backDate }}>
                <ArrowLeft className="size-3.5" />
                返回任务列表
              </Link>
            </Button>
          </div>
        }
      />

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="flex flex-col gap-4 border-b border-border/70 bg-muted/25 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2.5">
              <PlatformMark code={task.platformCode} name={task.platformName} size="sm" />
              <StatusBadge status={task.status} runStatus={task.runStatus} />
              {rerunLabel && task.activeRerun ? (
                <Badge
                  variant="outline"
                  className="cx-rerun-badge font-normal"
                  data-state={task.activeRerun.status}
                >
                  {rerunLabel} · {task.activeRerun.accountCount} 个账号
                </Badge>
              ) : null}
              <Badge variant="outline" className="font-normal">{task.accountType || '未设置账号类型'}</Badge>
            </div>
            <div className="text-right text-[11px] text-muted-foreground">
              <p>计划执行 {formatDateTime(task.scheduledAt)}</p>
            </div>
          </div>

          <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="抓取范围（UTC+8）" value={formatWindow(task.windowSince, task.windowUntil)} />
            <Metric label="实际开始" value={formatFullDateTime(run?.startedAt ?? task.runStartedAt)} />
            <Metric
              label="实际结束"
              value={task.status === 'running' && !task.activeRerun
                ? '进行中'
                : formatFullDateTime(run?.finishedAt ?? task.runFinishedAt)}
            />
            <Metric label="账号覆盖（成功/总数）" value={`${coverage.success} / ${coverage.total}`} />
          </div>

          {task.status === 'failed' && (run?.errorMessage || task.lastError) ? (
            <div className="cx-banner mx-4 mb-4 flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>{run?.errorMessage || task.lastError}</span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {task.activeRerun ? <ActiveRerunPanel rerun={task.activeRerun} taskId={task.id} /> : null}

      <Tabs value={view} onValueChange={setView} className="flex-col gap-4">
        <div className="cx-viewtabs">
          <PillNav
            ariaLabel="任务数据视图"
            items={[
              { label: `账号数据 ${accounts.length}`, href: '#accounts', icon: <UsersRound className="size-3.5" /> },
              { label: `帖子数据 ${contents.length}`, href: '#contents', icon: <FileText className="size-3.5" /> },
              { label: '执行信息', href: '#run', icon: <Info className="size-3.5" /> },
            ]}
            activeHref={`#${view}`}
            onItemClick={(item, _index, event) => {
              event.preventDefault()
              setView((item.href || '#accounts').slice(1))
            }}
            theme={theme}
            size="sm"
            surface="none"
            layout="joined"
            collapse="never"
            indicator="dot"
            hoverEffect="glide"
            highlightColor={theme === 'dark' ? 'rgba(94,242,176,.16)' : 'rgba(15,122,85,.12)'}
            highlightTextColor={theme === 'dark' ? '#eafbf2' : '#0d1712'}
            style={
              {
                '--pn-surface': 'transparent',
                '--pn-solid': 'transparent',
                '--pn-edge': 'transparent',
                '--pn-rim': 'transparent',
                '--pn-shadow': 'none',
                '--pn-text': 'var(--cx-ink-3)',
                '--pn-strong': 'var(--cx-ink)',
                '--pn-pill': 'color-mix(in oklab, var(--cx-accent) 18%, transparent)',
                '--pn-pill-ink': 'var(--cx-ink)',
                '--pn-pill-shadow': 'none',
                '--pn-dot': 'var(--cx-accent)',
                '--pn-ring': 'color-mix(in oklab, var(--cx-accent) 55%, transparent)',
                '--pn-row-hover': 'color-mix(in oklab, var(--cx-accent) 10%, transparent)',
                '--pn-tile': 'transparent',
                '--pn-tile-rim': 'transparent',
              } as React.CSSProperties
            }
          />
        </div>

        <TabsContent value="accounts">
          <AccountTable
            accounts={accounts}
            coverage={coverage}
            taskId={task.id}
            yesterday={yesterday}
            activeRerun={task.activeRerun}
            canRerun={canRerun}
          />
        </TabsContent>
        <TabsContent value="contents"><ContentTable contents={contents} /></TabsContent>
        <TabsContent value="run">
          {run ? (
            <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Card>
                <CardHeader className="pb-3"><CardTitle className="text-sm">{childTasks.length ? '首次执行结果' : '执行结果'}</CardTitle></CardHeader>
                <CardContent className="grid gap-2 text-xs">
                  <div className="flex justify-between"><span className="text-muted-foreground">执行状态</span><StatusBadge status={run.status} /></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">开始</span><span className="tabular-nums">{formatFullDateTime(run.startedAt)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">结束</span><span className="tabular-nums">{formatFullDateTime(run.finishedAt)}</span></div>
                  <Separator className="my-1" />
                  <div className="flex justify-between"><span className="text-muted-foreground">账号成功/失败</span><span>{run.successAccounts} / {run.failedAccounts}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">内容成功/失败</span><span>{run.successContents} / {run.failedContents}</span></div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-3"><CardTitle className="text-sm">数据量</CardTitle></CardHeader>
                <CardContent className="grid grid-cols-2 gap-3 text-xs">
                  <Metric label="原始数据" value={formatNumber(run.rawRecordCount)} />
                  <Metric label="账号数据" value={formatNumber(run.accountMetricCount)} />
                  <Metric label="帖子数据" value={formatNumber(run.contentMetricCount)} />
                  <Metric label="内容总数" value={formatNumber(run.totalContents)} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-3"><CardTitle className="text-sm">抓取设置</CardTitle></CardHeader>
                <CardContent className="space-y-2 text-xs">
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">执行日期</span><span>{formatFullDate(run.startedAt)}</span></div>
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">抓取开始</span><span className="text-right tabular-nums">{formatDateTime(run.windowSince)}</span></div>
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">抓取结束</span><span className="text-right tabular-nums">{formatDateTime(run.windowUntil)}</span></div>
                </CardContent>
              </Card>
            </div>
            {childTasks.length ? (
              <Card>
                <CardHeader className="pb-3"><CardTitle className="text-sm">补跑记录</CardTitle></CardHeader>
                <CardContent className="p-0">
                  <ChildTaskTable childTasks={childTasks} parentTaskId={task.id} />
                </CardContent>
              </Card>
            ) : null}
            </div>
          ) : (
            <EmptyState icon={CalendarClock} title="尚未执行" description="任务执行后会显示运行结果和错误详情。" />
          )}
        </TabsContent>
      </Tabs>
    </motion.div>
    </ConsolePage>
  )
}
