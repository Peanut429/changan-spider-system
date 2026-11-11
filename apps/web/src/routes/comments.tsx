import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { subDays } from 'date-fns'
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  Loader2,
  MessageSquare,
  Play,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import {
  createCommentJob,
  getAccount,
  getAccountTypes,
  getAccounts,
  getCommentJobs,
  getCommentJobFailedPosts,
  getPlatforms,
  retryCommentJob,
} from '@/lib/api'
import {
  dateKeyFromDate,
  formatDateTime,
  formatFullDate,
  formatNumber,
  todayKey,
} from '@/lib/format'
import type { Account, CommentJob } from '@/lib/types'
import { ConsoleBar } from '@/components/console/console-bar'
import { ConsolePage } from '@/components/console/console-page'
import { EmptyState } from '@/components/empty-state'
import { PlatformMark } from '@/components/platform-mark'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import '@/components/console/console.css'

const COMMENT_PLATFORMS = new Set(['instagram', 'tiktok', 'youtube', 'x'])
const PAGE_SIZE = 20
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

type CommentsSearch = {
  accountId?: string
  since?: string
  until?: string
}

function validDateKey(value: unknown): string | undefined {
  return typeof value === 'string' && DATE_KEY.test(value) ? value : undefined
}

export const Route = createFileRoute('/comments')({
  validateSearch: (search: Record<string, unknown>): CommentsSearch => ({
    accountId: typeof search.accountId === 'string' && search.accountId ? search.accountId : undefined,
    since: validDateKey(search.since),
    until: validDateKey(search.until),
  }),
  component: CommentsPage,
})

const JOB_STATUS: Record<string, { label: string; className: string }> = {
  pending: { label: '排队中', className: 'border-sky-500/40 text-sky-500' },
  running: { label: '抓取中', className: 'border-amber-500/40 text-amber-500' },
  success: { label: '成功', className: 'border-emerald-500/40 text-emerald-500' },
  partial_failed: { label: '部分失败', className: 'border-orange-500/40 text-orange-500' },
  failed: { label: '失败', className: 'border-rose-500/40 text-rose-500' },
  cancelled: { label: '已取消', className: 'border-muted-foreground/40 text-muted-foreground' },
}

function jobStatusMeta(status: string) {
  return JOB_STATUS[status] || JOB_STATUS.pending
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary transition-all"
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  )
}

function JobStatusCell({ job }: { job: CommentJob }) {
  const meta = jobStatusMeta(job.status)
  const accountProgress = job.totalAccounts
    ? Math.round((job.processedAccounts / job.totalAccounts) * 100)
    : 0
  const postProgress = job.totalPosts
    ? Math.round((job.processedPosts / job.totalPosts) * 100)
    : 0
  return (
    <div className="min-w-[130px] space-y-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <Badge variant="outline" className={`font-normal ${meta.className}`}>{meta.label}</Badge>
        {job.options.retryOfJobId ? <span className="cx-tag">重试</span> : null}
      </div>
      {job.status === 'running' || job.status === 'pending' ? (
        <div className="space-y-1">
          <ProgressBar value={accountProgress} />
          <p className="text-[10px] text-muted-foreground tabular-nums">
            账号 {job.processedAccounts}/{job.totalAccounts} · 帖子 {job.processedPosts}/{job.totalPosts}
            {postProgress ? ` · ${postProgress}%` : ''}
          </p>
        </div>
      ) : null}
      {job.errorMessage ? (
        <p className="max-w-[260px] truncate text-[10px] text-rose-500" title={job.errorMessage}>
          {job.errorMessage}
        </p>
      ) : null}
    </div>
  )
}

function JobsTable({
  jobs,
  onRetry,
  onOpenFailed,
  retryingId,
}: {
  jobs: CommentJob[]
  onRetry: (job: CommentJob) => void
  onOpenFailed: (job: CommentJob) => void
  retryingId: string | null
}) {
  return (
    <table className="cx-table cx-table--dense">
      <thead>
        <tr>
          <th>状态</th>
          <th>帖子发布时间</th>
          <th className="cx-right">账号</th>
          <th className="cx-right">帖子</th>
          <th className="cx-right">评论</th>
          <th className="cx-right">失败</th>
          <th data-hide-mobile="true">创建时间</th>
          <th className="cx-right">操作</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => (
          <tr key={job.id} className="cx-row">
            <td data-block="true"><JobStatusCell job={job} /></td>
            <td data-block="true">
              <div className="cx-when">
                {formatFullDate(job.window.since)} ~ {formatFullDate(job.window.until)}
              </div>
              <div className="cx-cell-sub">{job.platformCodes.join(' / ') || '—'}</div>
            </td>
            <td data-label="账号" className="cx-right tabular-nums">
              {job.processedAccounts} / {job.totalAccounts}
            </td>
            <td data-label="帖子" className="cx-right tabular-nums">
              {job.processedPosts} / {job.totalPosts}
            </td>
            <td data-label="评论" className="cx-right">
              <div className="tabular-nums">{formatNumber(job.fetchedComments)}</div>
              <div className="cx-cell-sub">新增 {formatNumber(job.insertedComments)} · 更新 {formatNumber(job.updatedComments)}</div>
            </td>
            <td data-label="失败" className="cx-right">
              <div className="tabular-nums">{formatNumber(job.failedPosts)} 帖</div>
              <div className="cx-cell-sub">
                {job.failedAccounts} 账号
                {job.failedPosts > 0
                  ? ` · ${job.retryableFailedPosts > 0 ? `${job.retryableFailedPosts} 可重试` : '不可重试'}`
                  : ''}
              </div>
            </td>
            <td data-label="创建时间" data-hide-mobile="true">
              <span className="cx-when">{formatDateTime(job.createdAt)}</span>
            </td>
            <td data-label="操作" className="cx-right">
              <div className="cx-row-actions">
                {job.failedPosts > 0 ? (
                  <button type="button" className="cx-link" onClick={() => onOpenFailed(job)}>
                    失败详情
                  </button>
                ) : null}
                {job.retryableFailedPosts > 0 && job.status !== 'pending' && job.status !== 'running' ? (
                  <button
                    type="button"
                    className="cx-link"
                    disabled={retryingId === job.id}
                    onClick={() => onRetry(job)}
                  >
                    <RefreshCw className={`size-3.5${retryingId === job.id ? ' animate-spin' : ''}`} />
                    {retryingId === job.id ? '重试中…' : '重试失败'}
                  </button>
                ) : null}
                {job.accountIds[0] ? (
                  <Link
                    className="cx-link"
                    to="/account/$accountId"
                    params={{ accountId: job.accountIds[0] }}
                    search={{
                      since: job.window.since ? dateKeyFromDate(new Date(job.window.since)) : undefined,
                      until: job.window.until ? dateKeyFromDate(new Date(job.window.until)) : undefined,
                    }}
                  >
                    查看账号
                  </Link>
                ) : <span className="text-muted-foreground">—</span>}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function CommentsPage() {
  const search = Route.useSearch()
  const queryClient = useQueryClient()
  const [platformId, setPlatformId] = useState('all')
  const [accountType, setAccountType] = useState('all')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Map<string, Account>>(new Map())
  const [since, setSince] = useState(search.since || dateKeyFromDate(subDays(new Date(), 29)))
  const [until, setUntil] = useState(search.until || todayKey())
  const [includeReplies, setIncludeReplies] = useState(true)
  const [maxComments, setMaxComments] = useState('500')
  const [maxReplies, setMaxReplies] = useState('50')
  const [submitting, setSubmitting] = useState(false)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [failedJob, setFailedJob] = useState<CommentJob | null>(null)

  const platformsQuery = useQuery({ queryKey: ['platforms'], queryFn: getPlatforms })
  const typesQuery = useQuery({ queryKey: ['account-types'], queryFn: getAccountTypes })
  const accountsQuery = useQuery({
    queryKey: ['accounts-for-comments', platformId, accountType, keyword, page],
    queryFn: () => getAccounts({
      platformId: platformId === 'all' ? undefined : platformId,
      accountType: accountType === 'all' ? undefined : accountType,
      active: 'true',
      q: keyword.trim() || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
  })
  const jobsQuery = useQuery({
    queryKey: ['comment-jobs'],
    queryFn: () => getCommentJobs(20),
    refetchInterval: 3000,
  })
  const presetQuery = useQuery({
    queryKey: ['account-preselect', search.accountId],
    queryFn: () => getAccount(search.accountId!),
    enabled: Boolean(search.accountId),
  })
  const failedPostsQuery = useQuery({
    queryKey: ['comment-job-failed-posts', failedJob?.id],
    queryFn: () => getCommentJobFailedPosts(failedJob!.id),
    enabled: Boolean(failedJob),
  })

  useEffect(() => {
    setPage(1)
  }, [platformId, accountType, keyword])

  useEffect(() => {
    if (search.since) setSince(search.since)
    if (search.until) setUntil(search.until)
  }, [search.since, search.until])

  useEffect(() => {
    const account = presetQuery.data?.account
    if (!account) return
    if (!account.active || !COMMENT_PLATFORMS.has(account.platformCode)) {
      toast.error(`${account.platformName}/${account.handle} 没有评论接口，已跳过`)
      return
    }
    setSelected((current) => {
      if (current.has(account.id)) return current
      const next = new Map(current)
      next.set(account.id, account)
      return next
    })
  }, [presetQuery.data])

  const accounts = accountsQuery.data?.accounts ?? []
  const total = accountsQuery.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const platforms = platformsQuery.data?.platforms ?? []
  const accountTypes = typesQuery.data?.accountTypes ?? []
  const jobs = jobsQuery.data?.jobs ?? []
  const tikHubConfigured = jobsQuery.data?.tikHubConfigured
  const selectedIds = useMemo(() => [...selected.keys()], [selected])

  const selectableAccounts = accounts.filter(
    (account) => account.active && COMMENT_PLATFORMS.has(account.platformCode),
  )
  const allPageSelected = selectableAccounts.length > 0
    && selectableAccounts.every((account) => selected.has(account.id))

  const toggleAccount = (account: Account) => {
    if (!account.active || !COMMENT_PLATFORMS.has(account.platformCode)) return
    setSelected((current) => {
      const next = new Map(current)
      if (next.has(account.id)) next.delete(account.id)
      else next.set(account.id, account)
      return next
    })
  }

  const togglePage = () => {
    setSelected((current) => {
      const next = new Map(current)
      for (const account of selectableAccounts) {
        if (allPageSelected) next.delete(account.id)
        else next.set(account.id, account)
      }
      return next
    })
  }

  const applyPreset = (days: number) => {
    setSince(dateKeyFromDate(subDays(new Date(), days - 1)))
    setUntil(todayKey())
  }

  const submit = async () => {
    if (!selectedIds.length) {
      toast.error('请先选择账号')
      return
    }
    if (!since || !until || !DATE_KEY.test(since) || !DATE_KEY.test(until)) {
      toast.error('请选择有效的帖子发布时间范围')
      return
    }
    if (since > until) {
      toast.error('开始日期不能晚于结束日期')
      return
    }
    const commentsLimit = Number(maxComments)
    const repliesLimit = Number(maxReplies)
    if (!Number.isInteger(commentsLimit) || commentsLimit < 1) {
      toast.error('单帖评论上限必须是正整数')
      return
    }
    if (!Number.isInteger(repliesLimit) || repliesLimit < 0) {
      toast.error('单条评论回复上限必须是非负整数')
      return
    }
    setSubmitting(true)
    try {
      const { job } = await createCommentJob({
        accountIds: selectedIds,
        since,
        until,
        includeReplies,
        maxCommentsPerPost: commentsLimit,
        maxRepliesPerComment: repliesLimit,
      })
      toast.success(`评论任务已创建：${job.id.slice(0, 16)}…，后台开始抓取`)
      setSelected(new Map())
      await queryClient.invalidateQueries({ queryKey: ['comment-jobs'] })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建评论任务失败')
    } finally {
      setSubmitting(false)
    }
  }

  const retryFailed = async (job: CommentJob) => {
    setRetryingId(job.id)
    try {
      const result = await retryCommentJob(job.id)
      toast.success(`已创建失败重试任务：${result.job.id.slice(0, 16)}…`)
      await queryClient.invalidateQueries({ queryKey: ['comment-jobs'] })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建重试任务失败')
    } finally {
      setRetryingId(null)
    }
  }

  const disabled = !selectedIds.length || !tikHubConfigured || submitting

  return (
    <ConsolePage>
      <ConsoleBar
        title="评论抓取"
        description="选择账号和帖子发布时间范围，后台通过 TikHub 接口抓取评论。评论本身不按时间筛选。"
        actions={(
          <Button
            variant="outline"
            className="gap-1.5"
            onClick={() => void queryClient.invalidateQueries({ queryKey: ['comment-jobs'] })}
          >
            <RefreshCw className="size-3.5" />
            刷新任务
          </Button>
        )}
      />

      {jobsQuery.data?.database ? (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>目标库：<span className="font-mono text-foreground/80">{jobsQuery.data.database.database}</span> @ <span className="font-mono">{jobsQuery.data.database.host}</span></span>
          {jobsQuery.data.database.remote ? (
            <span className="text-amber-500">（远程库，任务产生的评论会写入这里）</span>
          ) : null}
        </div>
      ) : null}

      {tikHubConfigured === false ? (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>Web 服务没有配置 <code className="font-mono">TIKHUB_API_KEY</code>，无法开始抓取。请在 Web 的环境变量里补上后重启。</span>
        </div>
      ) : null}

      <section className="cx-surface" style={{ padding: 16 }}>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">选择账号</span>
              <span className="cx-count">已选 {selectedIds.length}</span>
              {selectedIds.length ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  onClick={() => setSelected(new Map())}
                >
                  <X className="size-3" />清空
                </Button>
              ) : null}
            </div>

            {selected.size ? (
              <div className="mb-2 flex flex-wrap gap-1">
                {[...selected.values()].slice(0, 6).map((account) => (
                  <span key={account.id} className="cx-tag">
                    {account.platformCode} / {account.handle}
                  </span>
                ))}
                {selected.size > 6 ? <span className="cx-count">+{selected.size - 6}</span> : null}
              </div>
            ) : null}

            <div className="cx-toolbar" style={{ marginTop: 0 }}>
              <div className="cx-search">
                <Search className="size-3.5" />
                <Input
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder="搜索账号或显示名称"
                />
              </div>
              <div className="cx-filters">
                <Select value={platformId} onValueChange={setPlatformId}>
                  <SelectTrigger className="h-9 w-full"><SelectValue placeholder="平台" /></SelectTrigger>
                  <SelectContent className="cx-portal">
                    <SelectItem value="all">全部平台</SelectItem>
                    {platforms.map((platform) => (
                      <SelectItem key={platform.id} value={platform.id}>{platform.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={accountType} onValueChange={setAccountType}>
                  <SelectTrigger className="h-9 w-full"><SelectValue placeholder="类型" /></SelectTrigger>
                  <SelectContent className="cx-portal">
                    <SelectItem value="all">全部类型</SelectItem>
                    {accountTypes.map((type) => (
                      <SelectItem key={type} value={type}>{type}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {accountsQuery.isError ? (
              <div className="cx-error" style={{ marginTop: 12 }}>
                <p>账号加载失败：{accountsQuery.error.message}</p>
                <Button variant="outline" size="sm" onClick={() => accountsQuery.refetch()}>重试</Button>
              </div>
            ) : null}
            <div className="mt-3 overflow-auto rounded-lg border border-border/60" style={{ maxHeight: 520 }}>
              <table className="cx-table cx-table--dense">
                <thead>
                  <tr>
                    <th>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          checked={allPageSelected}
                          onCheckedChange={togglePage}
                          disabled={!selectableAccounts.length}
                          aria-label="全选当前页"
                        />
                        <span>账号</span>
                      </div>
                    </th>
                    <th>平台</th>
                    <th>类型</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((account) => {
                    const supported = COMMENT_PLATFORMS.has(account.platformCode)
                    const types = account.accountTypes?.length
                      ? account.accountTypes
                      : account.accountType
                        ? [account.accountType]
                        : []
                    return (
                      <tr
                        key={account.id}
                        className={`cx-row${supported ? '' : ' opacity-55'}`}
                      >
                        <td data-block="true">
                          <div className="flex items-start gap-2">
                            <Checkbox
                              className="mt-0.5"
                              checked={selected.has(account.id)}
                              onCheckedChange={() => toggleAccount(account)}
                              disabled={!supported || !account.active}
                              aria-label={`选择 ${account.handle}`}
                            />
                            <div className="min-w-0">
                              <div className="cx-handle">{account.handle}</div>
                              <div className="cx-cell-sub">{account.displayName || account.profileUrl}</div>
                            </div>
                          </div>
                        </td>
                        <td data-label="平台">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <PlatformMark code={account.platformCode} name={account.platformName} />
                            {!supported ? <span className="cx-tag">无评论接口</span> : null}
                          </div>
                        </td>
                        <td data-label="类型">
                          {types.length ? (
                            <div className="flex flex-wrap gap-1">
                              {types.map((type) => <span key={type} className="cx-tag">{type}</span>)}
                            </div>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {!accounts.length && !accountsQuery.isPending ? (
                <EmptyState
                  icon={MessageSquare}
                  title="没有匹配的账号"
                  description="调整平台、类型或搜索条件。"
                  className="border-0 bg-transparent"
                />
              ) : null}
            </div>

            <div className="cx-pager">
              <span className="cx-pager-meta">
                共 {formatNumber(total)} 个账号 · 第 {page} / {totalPages} 页
              </span>
              <div className="cx-pager-controls">
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  aria-label="上一页"
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <span className="cx-pager-current">{page} / {totalPages}</span>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  disabled={page >= totalPages}
                  onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                  aria-label="下一页"
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          </div>

          <aside className="space-y-4">
            <div className="rounded-xl border border-border/70 bg-muted/25 p-4">
              <h3 className="text-sm font-medium">帖子发布时间范围</h3>
              <p className="mt-1 text-xs text-muted-foreground">只筛选帖子；评论本身不按时间筛选。</p>
              <div className="mt-3 grid gap-2">
                <div className="flex items-center gap-2">
                  <Input
                    type="date"
                    value={since}
                    max={until || undefined}
                    onChange={(event) => setSince(event.target.value)}
                    aria-label="开始日期"
                  />
                  <span className="text-xs text-muted-foreground">至</span>
                  <Input
                    type="date"
                    value={until}
                    min={since || undefined}
                    onChange={(event) => setUntil(event.target.value)}
                    aria-label="结束日期"
                  />
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button variant="ghost" size="sm" onClick={() => applyPreset(7)}>近 7 天</Button>
                  <Button variant="ghost" size="sm" onClick={() => applyPreset(30)}>近 30 天</Button>
                  <Button variant="ghost" size="sm" onClick={() => applyPreset(90)}>近 90 天</Button>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-border/70 bg-muted/25 p-4">
              <h3 className="text-sm font-medium">抓取选项</h3>
              <label className="mt-3 flex items-center gap-2 text-sm">
                <Checkbox
                  checked={includeReplies}
                  onCheckedChange={(checked) => setIncludeReplies(checked === true)}
                />
                抓取二级回复
              </label>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <label className="text-xs text-muted-foreground">
                  单帖评论上限
                  <Input
                    className="mt-1 block h-9 w-full"
                    type="number"
                    min={1}
                    value={maxComments}
                    onChange={(event) => setMaxComments(event.target.value)}
                  />
                </label>
                <label className="text-xs text-muted-foreground">
                  单条回复上限
                  <Input
                    className="mt-1 block h-9 w-full"
                    type="number"
                    min={0}
                    value={maxReplies}
                    onChange={(event) => setMaxReplies(event.target.value)}
                  />
                </label>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                超过上限会截断，但任务仍算成功；默认单帖 500 条、每条一级评论 50 条回复。
              </p>
            </div>

            <Button className="w-full gap-1.5" onClick={() => void submit()} disabled={disabled}>
              {submitting ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              {submitting ? '创建中…' : `开始抓取${selectedIds.length ? `（${selectedIds.length} 个账号）` : ''}`}
            </Button>
            <p className="text-center text-[11px] text-muted-foreground">
              后台顺序执行；任务创建后可以离开此页。
            </p>
          </aside>
        </div>
      </section>

      <section className="cx-section" style={{ marginTop: 20 }}>
        <div className="cx-section-head">
          <h2 className="cx-h2">抓取任务</h2>
          <span className="cx-count">{formatNumber(jobs.length)} 个</span>
          <span className="cx-count">· 最近 20 条</span>
        </div>
        <div className="cx-surface">
          {jobsQuery.isError ? (
            <div className="cx-error" style={{ margin: 16 }}>
              <p>
                评论任务列表加载失败：{jobsQuery.error.message}
                （如果提示 comment_jobs 不存在，请先在数据库执行 apps/crawler/db/comment-jobs-upgrade.sql）
              </p>
              <Button variant="outline" size="sm" onClick={() => jobsQuery.refetch()}>重试</Button>
            </div>
          ) : jobs.length ? (
            <JobsTable
              jobs={jobs}
              onRetry={(job) => void retryFailed(job)}
              onOpenFailed={setFailedJob}
              retryingId={retryingId}
            />
          ) : jobsQuery.isPending ? (
            <div className="cx-loading">
              <div className="cx-skel" style={{ height: 56 }} />
              <div className="cx-skel" style={{ height: 56 }} />
            </div>
          ) : (
            <EmptyState
              icon={MessageSquare}
              title="还没有评论抓取任务"
              description="选择账号和帖子发布时间范围，点「开始抓取」；任务会在后台执行，结果可以在账号详情页查看。"
              className="border-0 bg-transparent"
            />
          )}
        </div>
      </section>

      <Dialog
        open={Boolean(failedJob)}
        onOpenChange={(open) => {
          if (!open) setFailedJob(null)
        }}
      >
        <DialogContent className="cx-portal max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>失败帖子</DialogTitle>
            <DialogDescription>
              {failedJob ? `任务 ${failedJob.id.slice(0, 20)}…` : ''}
              {' '}只展示每个帖子最后一次尝试仍然失败的情况。资源不存在、无权限、评论关闭等标为「不可重试」，不会再次请求，避免重复扣费。
            </DialogDescription>
          </DialogHeader>
          {failedPostsQuery.isPending ? (
            <div className="cx-loading">
              <div className="cx-skel" style={{ height: 56 }} />
              <div className="cx-skel" style={{ height: 56 }} />
            </div>
          ) : failedPostsQuery.isError ? (
            <div className="cx-error">
              <p>失败帖子加载失败：{failedPostsQuery.error.message}</p>
            </div>
          ) : (failedPostsQuery.data?.posts.length ?? 0) > 0 ? (
            <div className="max-h-[420px] space-y-2 overflow-auto">
              {failedPostsQuery.data!.posts.map((post) => (
                <div key={post.contentId} className="rounded-lg border border-border/70 bg-muted/25 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-medium">{post.accountHandle}</span>
                    <span className="cx-tag">{post.platformCode}</span>
                    {post.retryable ? null : <span className="cx-tag">不可重试</span>}
                    {post.url ? (
                      <a className="cx-link inline-flex items-center gap-1" href={post.url} target="_blank" rel="noreferrer">
                        打开帖子 <ExternalLink className="size-3" />
                      </a>
                    ) : null}
                    <span className="ml-auto text-muted-foreground">{formatDateTime(post.attemptedAt)}</span>
                  </div>
                  <p className="mt-1 break-words text-xs text-rose-500">
                    {post.errorMessage || '未知错误'}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={MessageSquare}
              title="没有仍失败的帖子"
              description="可能已经被后续重试成功，或者失败记录已被成功记录覆盖。"
              className="border-0 bg-transparent"
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setFailedJob(null)}>关闭</Button>
            <Button
              className="gap-1.5"
              disabled={Boolean(
                (failedJob && retryingId === failedJob.id)
                || !(failedPostsQuery.data?.posts.some((post) => post.retryable)),
              )}
              onClick={() => {
                if (!failedJob) return
                void retryFailed(failedJob).then(() => setFailedJob(null))
              }}
            >
              {failedJob && retryingId === failedJob.id
                ? <Loader2 className="size-4 animate-spin" />
                : <RefreshCw className="size-4" />}
              重试失败
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConsolePage>
  )
}
