import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { subDays } from 'date-fns'
import {
  ArrowLeft,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  MessageSquare,
  RefreshCw,
  UsersRound,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { getAccountComments, getAccountPosts } from '@/lib/api'
import { downloadCommentsExcel } from '@/lib/export-comments'
import { dateKeyFromDate, formatDateTime, formatNumber, todayKey } from '@/lib/format'
import type { AccountPost } from '@/lib/types'
import { ConsoleBar } from '@/components/console/console-bar'
import { ConsolePage } from '@/components/console/console-page'
import { EmptyState } from '@/components/empty-state'
import { PlatformMark } from '@/components/platform-mark'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import '@/components/console/console.css'

type AccountSearch = {
  since?: string
  until?: string
  page?: number
}

const PAGE_SIZE = 50
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/
const COMMENT_PLATFORMS = new Set(['instagram', 'tiktok', 'youtube', 'x'])

function validDateKey(value: unknown): string | undefined {
  return typeof value === 'string' && DATE_KEY.test(value) ? value : undefined
}

export const Route = createFileRoute('/account/$accountId')({
  validateSearch: (search: Record<string, unknown>): AccountSearch => {
    const page = Number(search.page)
    return {
      since: validDateKey(search.since),
      until: validDateKey(search.until),
      page: Number.isInteger(page) && page > 0 ? page : undefined,
    }
  },
  component: AccountDetailPage,
})

function MiniMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl bg-muted/45 px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium tabular-nums">{value}</p>
    </div>
  )
}

function shortText(value: string | null | undefined, max = 80): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return '—'
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function PostsTable({ posts, since, until }: { posts: AccountPost[]; since: string; until: string }) {
  return (
    <table className="cx-table cx-table--dense">
      <thead>
        <tr>
          <th>帖子</th>
          <th>类型</th>
          <th>发布时间</th>
          <th className="cx-right">平台评论</th>
          <th className="cx-right">已抓评论</th>
          <th data-hide-mobile="true">最近抓取</th>
          <th className="cx-right">操作</th>
        </tr>
      </thead>
      <tbody>
        {posts.map((post) => (
          <tr key={post.id} className="cx-row">
            <td data-block="true">
              <div className="cx-handle" title={post.title || post.url}>
                {shortText(post.title || post.url, 72)}
              </div>
              <div className="cx-cell-sub" title={post.url}>{shortText(post.summary || post.url, 90)}</div>
            </td>
            <td data-label="类型">
              <span className="cx-tag">{post.contentType || '内容'}</span>
            </td>
            <td data-label="发布时间">
              <span className="cx-when">{formatDateTime(post.publishTime)}</span>
            </td>
            <td data-label="平台评论" className="cx-right tabular-nums">
              {formatNumber(post.platformCommentCount)}
            </td>
            <td data-label="已抓评论" className="cx-right">
              <div className="tabular-nums">{formatNumber(post.fetchedCommentCount)}</div>
              {post.fetchedCommentCount > 0 ? (
                <div className="cx-cell-sub">
                  一级 {formatNumber(post.topLevelCommentCount)} · 回复 {formatNumber(post.replyCommentCount)}
                </div>
              ) : null}
            </td>
            <td data-label="最近抓取" data-hide-mobile="true">
              <span className="cx-when">{formatDateTime(post.lastCommentSeenAt)}</span>
            </td>
            <td data-label="操作" className="cx-right">
              <div className="cx-row-actions">
                <Link
                  className="cx-link"
                  to="/post/$contentId"
                  params={{ contentId: post.id }}
                  search={{ since: since || undefined, until: until || undefined }}
                >
                  查看评论
                </Link>
                {post.url ? (
                  <a
                    className="cx-link"
                    href={post.url}
                    target="_blank"
                    rel="noreferrer"
                    title="打开原帖"
                  >
                    <ExternalLink className="size-3.5" />
                  </a>
                ) : null}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function AccountDetailPage() {
  const { accountId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate()
  const since = search.since || ''
  const until = search.until || ''
  const page = search.page || 1
  const [exporting, setExporting] = useState(false)

  const query = useQuery({
    queryKey: ['account-posts', accountId, since, until, page],
    placeholderData: keepPreviousData,
    queryFn: () => getAccountPosts(accountId, {
      since: since || undefined,
      until: until || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
  })

  const applyRange = (nextSince: string, nextUntil: string) => {
    if (nextSince && nextUntil && nextSince > nextUntil) {
      toast.error('开始日期不能晚于结束日期')
      return
    }
    void navigate({
      to: '/account/$accountId',
      params: { accountId },
      search: {
        since: nextSince || undefined,
        until: nextUntil || undefined,
        page: undefined,
      },
      replace: true,
    })
  }

  const applyPreset = (days: number) => {
    applyRange(dateKeyFromDate(subDays(new Date(), days - 1)), todayKey())
  }

  const goPage = (nextPage: number) => {
    void navigate({
      to: '/account/$accountId',
      params: { accountId },
      search: {
        since: search.since,
        until: search.until,
        page: nextPage > 1 ? nextPage : undefined,
      },
      replace: true,
    })
  }

  const downloadAll = async () => {
    const data = query.data
    if (!data || data.summary.fetchedComments === 0) return
    setExporting(true)
    try {
      const comments = await getAccountComments(accountId, {
        since: since || undefined,
        until: until || undefined,
      })
      await downloadCommentsExcel({
        platformName: data.account.platformName,
        accountHandle: data.account.handle,
        rows: comments.comments.map((comment) => ({
          postTitle: comment.postTitle,
          postUrl: comment.postUrl,
          postPublishTime: comment.postPublishTime,
          commentId: comment.id,
          username: comment.username,
          userId: comment.userId,
          text: comment.text,
          likeCount: comment.likeCount,
          replyCount: comment.replyCount,
          parentCommentId: comment.parentCommentId,
          rootCommentId: comment.rootCommentId,
          createdAt: comment.createdAt,
          isReply: Boolean(comment.parentCommentId),
        })),
        fileBaseName: `${data.account.platformName}_${data.account.handle}_评论_${since || '全部'}_${until || '全部'}`,
      })
      toast.success(
        comments.truncated
          ? `已导出 ${comments.comments.length} 条（共 ${comments.total} 条，已达导出上限）`
          : `已导出 ${comments.comments.length} 条评论`,
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  const account = query.data?.account
  const summary = query.data?.summary
  const posts = query.data?.posts ?? []
  const total = query.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const rangeText = since || until ? `${since || '最早'} ~ ${until || '至今'}` : '全部时间'
  const hasComments = Number(summary?.fetchedComments || 0) > 0

  return (
    <ConsolePage>
      <ConsoleBar
        title="账号详情"
        description="查看账号帖子；时间范围只筛选帖子发布时间，评论不按时间筛选。"
        actions={(
          <>
            {account && COMMENT_PLATFORMS.has(account.platformCode) ? (
              <Button asChild variant="outline" className="gap-1.5">
                <Link
                  to="/comments"
                  search={{ accountId, since: since || undefined, until: until || undefined }}
                >
                  <MessageSquare className="size-3.5" />
                  抓取该账号评论
                </Link>
              </Button>
            ) : null}
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() => void downloadAll()}
              disabled={!hasComments || exporting}
              title={hasComments ? `导出 ${formatNumber(summary?.fetchedComments)} 条评论` : '当前范围还没有抓到评论'}
            >
              {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              {exporting ? '导出中…' : '下载范围内全部评论'}
            </Button>
            <Button asChild variant="outline" className="gap-1.5">
              <Link to="/accounts">
                <ArrowLeft className="size-3.5" />
                返回账号列表
              </Link>
            </Button>
          </>
        )}
      />

      {query.isPending ? (
        <div className="cx-loading">
          <div className="cx-skel" style={{ height: 120 }} />
          <div className="cx-skel" style={{ height: 56 }} />
          <div className="cx-skel" style={{ height: 56 }} />
        </div>
      ) : query.isError ? (
        query.error.message.includes('404') ? (
          <EmptyState
            icon={UsersRound}
            title="账号不存在"
            description="该账号可能已被删除，返回账号列表重新选择。"
          />
        ) : (
          <div className="cx-error" style={{ marginTop: 16 }}>
            <p>账号帖子加载失败：{query.error.message}</p>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => query.refetch()}>
              <RefreshCw className="size-3.5" />重试
            </Button>
          </div>
        )
      ) : account ? (
        <>
          <section className="cx-surface" style={{ padding: 16 }}>
            <div className="flex flex-wrap items-start justify-between gap-5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <PlatformMark code={account.platformCode} name={account.platformName} />
                  <span className="cx-handle text-base">{account.handle}</span>
                  {account.displayName ? (
                    <span className="text-sm text-muted-foreground">{account.displayName}</span>
                  ) : null}
                  <Badge variant="outline" className="font-normal">
                    {account.active ? '启用' : '停用'}
                  </Badge>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  {(account.accountTypes?.length ? account.accountTypes : account.accountType ? [account.accountType] : []).map((type) => (
                    <span key={type} className="cx-tag">{type}</span>
                  ))}
                  <a
                    className="cx-link ml-1 inline-flex items-center gap-1"
                    href={account.profileUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ExternalLink className="size-3.5" />主页
                  </a>
                </div>
              </div>
              <div className="grid min-w-[260px] grid-cols-2 gap-2 sm:grid-cols-4">
                <MiniMetric label="粉丝" value={formatNumber(account.metrics?.followersCount)} />
                <MiniMetric label="帖子" value={formatNumber(account.metrics?.postsCount)} />
                <MiniMetric label="范围内帖子" value={formatNumber(summary?.posts)} />
                <MiniMetric label="已抓评论" value={formatNumber(summary?.fetchedComments)} />
              </div>
            </div>
          </section>

          <section className="cx-toolbar" style={{ marginTop: 16 }}>
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarRange className="size-3.5" />
              帖子发布时间
            </span>
            <div className="cx-filters">
              <Input
                type="date"
                className="h-9 w-[150px]"
                value={since}
                max={until || undefined}
                aria-label="开始日期"
                onChange={(event) => applyRange(event.target.value, until)}
              />
              <span className="text-xs text-muted-foreground">至</span>
              <Input
                type="date"
                className="h-9 w-[150px]"
                value={until}
                min={since || undefined}
                aria-label="结束日期"
                onChange={(event) => applyRange(since, event.target.value)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <Button variant={since || until ? 'ghost' : 'secondary'} size="sm" onClick={() => applyRange('', '')}>
                全部
              </Button>
              <Button variant="ghost" size="sm" onClick={() => applyPreset(7)}>近 7 天</Button>
              <Button variant="ghost" size="sm" onClick={() => applyPreset(30)}>近 30 天</Button>
              <Button variant="ghost" size="sm" onClick={() => applyPreset(90)}>近 90 天</Button>
            </div>
            <span className="ml-auto text-xs text-muted-foreground">当前：{rangeText}</span>
          </section>

          <section className="cx-section">
            <div className="cx-section-head">
              <h2 className="cx-h2">帖子</h2>
              <span className="cx-count">{formatNumber(total)} 个</span>
              <span className="cx-count">· 有已抓评论 {formatNumber(summary?.postsWithComments)}</span>
              <span className="cx-count">· 评论 {formatNumber(summary?.fetchedComments)}</span>
              {summary?.platformComments ? (
                <span className="cx-count">· 平台评论 {formatNumber(summary.platformComments)}</span>
              ) : null}
            </div>

            <div className="cx-surface">
              {posts.length ? (
                <PostsTable posts={posts} since={since} until={until} />
              ) : (
                <EmptyState
                  icon={FileText}
                  title="范围内没有帖子"
                  description="调整帖子发布时间范围，或确认该账号的帖子已经由每日任务入库。"
                  className="border-0 bg-transparent"
                />
              )}
            </div>

            {total > 0 ? (
              <div className="cx-pager">
                <span className="cx-pager-meta">
                  共 {formatNumber(total)} 个帖子 · 第 {page} / {totalPages} 页
                </span>
                <div className="cx-pager-controls">
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8"
                    disabled={page <= 1}
                    onClick={() => goPage(page - 1)}
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
                    onClick={() => goPage(page + 1)}
                    aria-label="下一页"
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
            ) : null}
          </section>
        </>
      ) : (
        <EmptyState
          icon={UsersRound}
          title="账号不存在"
          description="该账号可能已被删除，返回账号列表重新选择。"
        />
      )}
    </ConsolePage>
  )
}
