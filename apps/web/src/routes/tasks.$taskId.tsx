import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  CalendarClock,
  CircleAlert,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Info,
  RefreshCw,
  UsersRound,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'

import { getTask, rerunTask } from '@/lib/api'
import { downloadTaskExcel } from '@/lib/export-task'
import type { TaskAccount, TaskContent, TaskDetailResponse } from '@/lib/types'
import { dateKeyFromDate, formatDateTime, formatFullDate, formatFullDateTime, formatNumber, formatWindow, todayKey } from '@/lib/format'
import GlareHover from '@/components/GlareHover/GlareHover'
import RubberSegment from '@/components/RubberSegment/RubberSegment'
import { ConsoleBar } from '@/components/console/console-bar'
import { useTheme } from '@/lib/theme'
import { ConsolePage } from '@/components/console/console-page'
import '@/components/console/console.css'
import { platformColor } from '@/components/console/platform-color'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
  const isZero = account.status === 'success' && Number(account.contentCountInWindow || 0) === 0
  const meta = isZero
    ? { label: '成功但 0 条', className: 'text-amber-400', dot: 'bg-amber-400' }
    : coverageMeta[account.status] || coverageMeta.pending
  return (
    <span className={cn('inline-flex items-center gap-2 text-xs font-medium', meta.className)}>
      <span className={cn('size-1.5 rounded-full', meta.dot)} />
      {meta.label}
    </span>
  )
}

type ConfirmAction = {
  mode: 'failed' | 'new' | 'selected'
  ids: string[]
  title: string
  description: string
}

function AccountTable({ accounts, coverage, taskId }: { accounts: TaskAccount[]; coverage: TaskDetailResponse['coverage']; taskId: string }) {
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
  const effectiveFilter = filter || (failed.length + newAccounts.length > 0 ? 'action' : 'all')
  const filtered = useMemo(() => {
    if (effectiveFilter === 'action') return accounts.filter((a) => a.status === 'failed' || a.status === 'partial' || (a.status === 'pending' && a.isNew));
    if (effectiveFilter === 'failed') return failed;
    if (effectiveFilter === 'new') return newAccounts;
    if (effectiveFilter === 'zero') return zero;
    if (effectiveFilter === 'success') return success;
    if (effectiveFilter === 'disabled') return disabled;
    return accounts;
  }, [accounts, effectiveFilter, failed, newAccounts, zero, success, disabled])
  const selectable = filtered.filter((a) => a.status !== 'disabled')
  const allSelected = selectable.length > 0 && selectable.every((a) => selected.has(a.accountId))

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
      toast.success('已创建补跑任务')
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
    { key: 'zero', label: '成功但 0 条', count: zero.length },
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
              成功 {coverage.success} · 失败 {coverage.failed} · 新增待补 {coverage.newAccounts} · 已禁用 {coverage.disabled}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {failed.length > 0 ? <Button size="sm" variant="outline" onClick={() => ask('failed', failed.map((a) => a.accountId))}><RefreshCw className="size-3.5" />重试失败 {failed.length}</Button> : null}
            {newAccounts.length > 0 ? <Button size="sm" onClick={() => ask('new', newAccounts.map((a) => a.accountId))}><UsersRound className="size-3.5" />补新增 {newAccounts.length}</Button> : null}
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
        <span className="cx-hint">“需处理” = 失败账号 + 新增待补账号</span>
      </div>

      {selected.size > 0 ? (
        <div className="sticky top-2 z-10 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/25 bg-primary/5 px-3 py-2 text-xs">
          <span>已选 {selected.size} 个账号</span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>取消选择</Button>
            <Button size="sm" onClick={() => ask('selected', [...selected])}>重跑选中账号</Button>
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-2xl border border-border/70 bg-card shadow-[0_24px_60px_-52px_rgba(6,78,59,0.55)]">
        <Table className="min-w-[1080px]">
          <TableHeader>
            <TableRow className="bg-emerald-50/60 hover:bg-emerald-50/60">
              <TableHead className="w-10">
                <Checkbox
                  checked={allSelected ? true : selectable.some((a) => selected.has(a.accountId)) ? 'indeterminate' : false}
                  onCheckedChange={(value) => toggleAll(value === true)}
                  aria-label="选择当前筛选账号"
                />
              </TableHead>
              <TableHead>账号</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">窗口内容</TableHead>
              <TableHead className="text-right">粉丝</TableHead>
              <TableHead className="text-right">帖子数</TableHead>
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
                    disabled={account.status === 'disabled'}
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
                <TableCell className="text-xs tabular-nums text-muted-foreground">{formatFullDateTime(account.latestRunStartedAt)}</TableCell>
                <TableCell>
                  {account.errorMessage ? (
                    <span className="line-clamp-2 max-w-[220px] text-[11px] text-rose-700" title={account.errorMessage}>{account.errorMessage}</span>
                  ) : <span className="text-xs text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="text-right">
                  {account.status !== 'disabled' ? (
                    <Button size="sm" variant="ghost" onClick={() => ask('selected', [account.accountId])}>重跑</Button>
                  ) : <span className="text-[11px] text-muted-foreground">不可操作</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={Boolean(confirm)} onOpenChange={(open) => { if (!open) setConfirm(null) }}>
        <AlertDialogContent>
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
          <span className="text-xs text-muted-foreground">按账号筛选</span>
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
      <div className="overflow-x-auto rounded-2xl border border-border/70 bg-card shadow-[0_24px_60px_-52px_rgba(6,78,59,0.55)]">
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
          <Button variant="outline" size="icon" className="size-8" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} aria-label="帖子上一页">
            <ChevronLeft className="size-4" />
          </Button>
          <Button variant="outline" size="icon" className="size-8" disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} aria-label="帖子下一页">
            <ChevronRight className="size-4" />
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function TaskDetailPage() {
  const { taskId } = Route.useParams()
  const reduceMotion = useReducedMotion()
  const { theme } = useTheme()
  const dark = theme === 'dark'
  const query = useQuery({ queryKey: ['task', taskId], queryFn: () => getTask(taskId) })

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

  const { task, run, accounts, contents, coverage, childTasks } = query.data
  const backDate = run?.startedAt
    ? dateKeyFromDate(new Date(run.startedAt))
    : task.runStartedAt
      ? dateKeyFromDate(new Date(task.runStartedAt))
      : task.scheduledAt
        ? dateKeyFromDate(new Date(task.scheduledAt))
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
        title={task.platformName}
        description="查看任务结果、账号数据和帖子数据。"
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 bg-card"
              onClick={() => {
                void downloadTaskExcel({ task, accounts, contents })
                  .then(() => toast.success('Excel 已生成'))
                  .catch((error) => toast.error(error instanceof Error ? error.message : 'Excel 生成失败'))
              }}
            >
              <Download className="size-3.5" />
              下载 Excel
            </Button>
            <Button asChild variant="outline" size="sm" className="gap-1.5 bg-card">
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
              <span className="cx-plat">
                <i style={{ color: platformColor(task.platformCode) }} aria-hidden="true" />
                <span>{task.platformName}</span>
              </span>
              <StatusBadge status={task.status} runStatus={task.runStatus} />
              <Badge variant="outline" className="font-normal">{task.accountType || '未设置账号类型'}</Badge>
            </div>
            <div className="text-right text-[11px] text-muted-foreground">
              <p>计划执行 {formatDateTime(task.scheduledAt)}</p>
            </div>
          </div>

          <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="抓取范围（UTC+8）" value={formatWindow(task.windowSince, task.windowUntil)} />
            <Metric label="实际开始" value={formatFullDateTime(run?.startedAt ?? task.runStartedAt)} />
            <Metric label="实际结束" value={run?.finishedAt ? formatFullDateTime(run.finishedAt) : task.status === 'running' ? '进行中' : '—'} />
            <Metric label="账号覆盖（成功/总数）" value={`${coverage.success} / ${coverage.total}`} />
          </div>

          {run?.errorMessage || task.lastError ? (
            <div className="cx-banner mx-4 mb-4 flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>{run?.errorMessage || task.lastError}</span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Tabs defaultValue="accounts" className="flex-col gap-4">
        <TabsList className="h-auto w-fit flex-wrap bg-muted/60 p-1">
          <TabsTrigger value="accounts" className="gap-1.5 px-3">
            <UsersRound className="size-3.5" />账号数据
            <Badge variant="secondary" className="ml-0.5 h-5 px-1.5 text-[10px]">{accounts.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="contents" className="gap-1.5 px-3">
            <FileText className="size-3.5" />帖子数据
            <Badge variant="secondary" className="ml-0.5 h-5 px-1.5 text-[10px]">{contents.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="run" className="gap-1.5 px-3">
            <Info className="size-3.5" />执行信息
          </TabsTrigger>
        </TabsList>

        <TabsContent value="accounts"><AccountTable accounts={accounts} coverage={coverage} taskId={task.id} /></TabsContent>
        <TabsContent value="contents"><ContentTable contents={contents} /></TabsContent>
        <TabsContent value="run">
          {run ? (
            <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <GlareHover
                width="100%"
                height="100%"
                background="transparent"
                borderColor="transparent"
                borderRadius="10px"
                glareColor={dark ? '#a8ffdc' : '#a9dcc4'}
                glareOpacity={dark ? 0.34 : 0.55}
                blendMode={dark ? 'screen' : 'multiply'}
                mode="follow"
                softness={0.78}
                variant="sheen"
                style={{ display: 'grid', placeItems: 'stretch' }}
              >
<Card>
                <CardHeader className="pb-3"><CardTitle className="text-sm">执行结果</CardTitle></CardHeader>
                <CardContent className="grid gap-2 text-xs">
                  <div className="flex justify-between"><span className="text-muted-foreground">执行状态</span><StatusBadge status={run.status} /></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">开始</span><span className="tabular-nums">{formatFullDateTime(run.startedAt)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">结束</span><span className="tabular-nums">{formatFullDateTime(run.finishedAt)}</span></div>
                  <Separator className="my-1" />
                  <div className="flex justify-between"><span className="text-muted-foreground">账号成功/失败</span><span>{run.successAccounts} / {run.failedAccounts}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">内容成功/失败</span><span>{run.successContents} / {run.failedContents}</span></div>
                </CardContent>
              </Card>
              </GlareHover>
              <GlareHover
                width="100%"
                height="100%"
                background="transparent"
                borderColor="transparent"
                borderRadius="10px"
                glareColor={dark ? '#a8ffdc' : '#a9dcc4'}
                glareOpacity={dark ? 0.34 : 0.55}
                blendMode={dark ? 'screen' : 'multiply'}
                mode="follow"
                softness={0.78}
                variant="sheen"
                style={{ display: 'grid', placeItems: 'stretch' }}
              >
<Card>
                <CardHeader className="pb-3"><CardTitle className="text-sm">数据量</CardTitle></CardHeader>
                <CardContent className="grid grid-cols-2 gap-3 text-xs">
                  <Metric label="原始数据" value={formatNumber(run.rawRecordCount)} />
                  <Metric label="账号数据" value={formatNumber(run.accountMetricCount)} />
                  <Metric label="帖子数据" value={formatNumber(run.contentMetricCount)} />
                  <Metric label="内容总数" value={formatNumber(run.totalContents)} />
                </CardContent>
              </Card>
              </GlareHover>
              <GlareHover
                width="100%"
                height="100%"
                background="transparent"
                borderColor="transparent"
                borderRadius="10px"
                glareColor={dark ? '#a8ffdc' : '#a9dcc4'}
                glareOpacity={dark ? 0.34 : 0.55}
                blendMode={dark ? 'screen' : 'multiply'}
                mode="follow"
                softness={0.78}
                variant="sheen"
                style={{ display: 'grid', placeItems: 'stretch' }}
              >
<Card>
                <CardHeader className="pb-3"><CardTitle className="text-sm">抓取设置</CardTitle></CardHeader>
                <CardContent className="space-y-2 text-xs">
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">执行日期</span><span>{formatFullDate(run.startedAt)}</span></div>
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">抓取开始</span><span className="text-right tabular-nums">{formatDateTime(run.windowSince)}</span></div>
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">抓取结束</span><span className="text-right tabular-nums">{formatDateTime(run.windowUntil)}</span></div>
                </CardContent>
              </Card>
              </GlareHover>
            </div>
            {childTasks.length ? (
              <Card>
                <CardHeader className="pb-3"><CardTitle className="text-sm">补跑记录</CardTitle></CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-emerald-50/60 hover:bg-emerald-50/60">
                        <TableHead>类型</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead className="text-right">账号</TableHead>
                        <TableHead className="text-right">内容</TableHead>
                        <TableHead>开始</TableHead>
                        <TableHead>结束</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {childTasks.map((child) => (
                        <TableRow key={child.id}>
                          <TableCell className="text-xs">{child.kind === 'retry_failed' ? '失败重试' : child.kind === 'backfill_new' ? '新增补数据' : '手动重跑'}</TableCell>
                          <TableCell><StatusBadge status={child.status} runStatus={child.runStatus} /></TableCell>
                          <TableCell className="text-right tabular-nums">{child.successAccounts}/{child.accountCount || child.plannedAccounts}</TableCell>
                          <TableCell className="text-right tabular-nums">{child.contentMetricCount}</TableCell>
                          <TableCell className="text-xs tabular-nums text-muted-foreground">{formatFullDateTime(child.runStartedAt)}</TableCell>
                          <TableCell className="text-xs tabular-nums text-muted-foreground">{formatFullDateTime(child.runFinishedAt)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
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
