import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  CalendarClock,
  CircleAlert,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Info,
  UsersRound,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'

import { getTask } from '@/lib/api'
import type { TaskAccount, TaskContent } from '@/lib/types'
import { dateKeyFromDate, formatDateTime, formatFullDate, formatFullDateTime, formatNumber, formatWindow, todayKey } from '@/lib/format'
import { PageHeader } from '@/components/page-header'
import { PlatformBadge } from '@/components/platform-badge'
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

function AccountTable({ accounts }: { accounts: TaskAccount[] }) {
  if (!accounts.length) {
    return <EmptyState icon={UsersRound} title="没有账号数据" description="任务尚未执行，或本次没有选中账号。" />
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-border/80 bg-card">
      <Table className="min-w-[980px]">
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead>账号</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="text-right">粉丝</TableHead>
            <TableHead className="text-right">关注</TableHead>
            <TableHead className="text-right">帖子</TableHead>
            <TableHead className="text-right">抓到</TableHead>
            <TableHead className="text-right">保存</TableHead>
            <TableHead>错误</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {accounts.map((account) => (
            <TableRow key={account.id}>
              <TableCell>
                <div className="flex flex-col">
                  <a
                    href={account.profileUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-sm font-medium hover:text-primary"
                  >
                    {account.handle}
                    <ExternalLink className="size-3 text-muted-foreground" />
                  </a>
                  <span className="mt-0.5 text-[11px] text-muted-foreground">{account.displayName || '—'}</span>
                </div>
              </TableCell>
              <TableCell><StatusBadge status={account.status} /></TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(account.followersCount)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(account.followingCount)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(account.postsCount)}</TableCell>
              <TableCell className="text-right tabular-nums">{account.contentFoundCount}</TableCell>
              <TableCell className="text-right tabular-nums">{account.contentSavedCount}</TableCell>
              <TableCell>
                {account.errorMessage ? (
                  <span className="line-clamp-2 max-w-[220px] text-[11px] text-rose-700" title={account.errorMessage}>
                    {account.errorMessage}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
            <SelectContent>
              <SelectItem value="all">全部账号</SelectItem>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>{account.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="overflow-x-auto rounded-xl border border-border/80 bg-card">
        <Table className="min-w-[1120px]">
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
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
                <TableCell><Badge variant="secondary" className="text-[10px]">{content.contentType || '内容'}</Badge></TableCell>
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
      <Card className="border-rose-200 bg-rose-50/60">
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

  const { task, run, accounts, contents } = query.data
  const backDate = run?.startedAt
    ? dateKeyFromDate(new Date(run.startedAt))
    : task.runStartedAt
      ? dateKeyFromDate(new Date(task.runStartedAt))
      : task.scheduledAt
        ? dateKeyFromDate(new Date(task.scheduledAt))
        : todayKey()
  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="space-y-6"
    >
      <PageHeader
        title={task.platformName}
        description="查看任务结果、账号数据和帖子数据。"
        actions={
          <Button asChild variant="outline" size="sm" className="gap-1.5 bg-card">
            <Link to="/tasks" search={{ date: backDate }}>
              <ArrowLeft className="size-3.5" />
              返回任务列表
            </Link>
          </Button>
        }
      />

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="flex flex-col gap-4 border-b border-border/70 bg-muted/25 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2.5">
              <PlatformBadge code={task.platformCode} />
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
            <Metric label="账号（成功/失败/总数）" value={`${task.successAccounts} / ${task.failedAccounts} / ${task.plannedAccounts || task.totalAccounts}`} />
          </div>

          {run?.errorMessage || task.lastError ? (
            <div className="mx-4 mb-4 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50/70 px-3 py-2.5 text-xs text-rose-800">
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

        <TabsContent value="accounts"><AccountTable accounts={accounts} /></TabsContent>
        <TabsContent value="contents"><ContentTable contents={contents} /></TabsContent>
        <TabsContent value="run">
          {run ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
          ) : (
            <EmptyState icon={CalendarClock} title="尚未执行" description="任务执行后会显示运行结果和错误详情。" />
          )}
        </TabsContent>
      </Tabs>
    </motion.div>
  )
}
