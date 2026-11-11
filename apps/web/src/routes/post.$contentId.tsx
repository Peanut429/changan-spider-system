import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  Download,
  ExternalLink,
  Loader2,
  MessageSquare,
  RefreshCw,
  ThumbsUp,
  UsersRound,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

import { getPostDetail } from '@/lib/api'
import { downloadCommentsExcel } from '@/lib/export-comments'
import { formatDateTime, formatFullDateTime, formatNumber } from '@/lib/format'
import type { PostComment } from '@/lib/types'
import { ConsoleBar } from '@/components/console/console-bar'
import { ConsolePage } from '@/components/console/console-page'
import { EmptyState } from '@/components/empty-state'
import { PlatformMark } from '@/components/platform-mark'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import '@/components/console/console.css'

type PostSearch = {
  from?: string
  since?: string
  until?: string
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

function validDateKey(value: unknown): string | undefined {
  return typeof value === 'string' && DATE_KEY.test(value) ? value : undefined
}

export const Route = createFileRoute('/post/$contentId')({
  validateSearch: (search: Record<string, unknown>): PostSearch => ({
    from: typeof search.from === 'string' && search.from ? search.from : undefined,
    since: validDateKey(search.since),
    until: validDateKey(search.until),
  }),
  component: PostDetailPage,
})

function timeValue(value: string | null | undefined): number {
  if (!value) return 0
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
}

function MiniMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl bg-muted/45 px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium tabular-nums">{value}</p>
    </div>
  )
}

function CommentBlock({
  comment,
  nested = false,
  parentName,
}: {
  comment: PostComment
  nested?: boolean
  parentName?: string | null
}) {
  return (
    <div className={nested ? 'rounded-lg bg-muted/35 px-3 py-2.5' : ''}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="font-medium text-foreground">{comment.username || '未知用户'}</span>
        {nested && parentName ? (
          <span className="text-muted-foreground">回复 @{parentName}</span>
        ) : null}
        <span className="text-muted-foreground">
          {comment.createdAt ? formatDateTime(comment.createdAt) : '时间未知'}
        </span>
        {comment.userId ? (
          <span className="text-muted-foreground/70" title="用户 ID">{comment.userId}</span>
        ) : null}
        <span className="ml-auto inline-flex items-center gap-1 text-muted-foreground">
          <ThumbsUp className="size-3" />
          {formatNumber(comment.likeCount)}
        </span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed">
        {comment.text || '（空评论）'}
      </p>
    </div>
  )
}

function PostDetailPage() {
  const { contentId } = Route.useParams()
  const search = Route.useSearch()
  const [exporting, setExporting] = useState(false)

  const query = useQuery({
    queryKey: ['post-detail', contentId],
    queryFn: () => getPostDetail(contentId),
  })

  const post = query.data?.post
  const comments = query.data?.comments ?? []

  const { topLevel, repliesByRoot, nameById, ordered } = useMemo(() => {
    const top = comments
      .filter((comment) => !comment.parentCommentId)
      .sort((a, b) => timeValue(b.createdAt) - timeValue(a.createdAt))
    const topIds = new Set(top.map((comment) => comment.id))
    const map = new Map<string, PostComment[]>()
    const orphans: PostComment[] = []
    for (const comment of comments) {
      if (!comment.parentCommentId) continue
      const root = comment.rootCommentId || comment.parentCommentId
      if (!topIds.has(root)) {
        orphans.push(comment)
        continue
      }
      const list = map.get(root) || []
      list.push(comment)
      map.set(root, list)
    }
    for (const list of map.values()) {
      list.sort((a, b) => timeValue(a.createdAt) - timeValue(b.createdAt))
    }
    const flat: PostComment[] = []
    for (const comment of top) {
      flat.push(comment)
      flat.push(...(map.get(comment.id) || []))
    }
    flat.push(...orphans)
    return {
      topLevel: top,
      repliesByRoot: { map, orphans },
      nameById: new Map(comments.map((comment) => [comment.id, comment.username])),
      ordered: flat,
    }
  }, [comments])

  const downloadPost = async () => {
    if (!post || !ordered.length) return
    setExporting(true)
    try {
      await downloadCommentsExcel({
        platformName: post.platformName,
        accountHandle: post.account.handle,
        rows: ordered.map((comment) => ({
          postTitle: post.title,
          postUrl: post.url,
          postPublishTime: post.publishTime,
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
        fileBaseName: `${post.platformName}_${post.account.handle}_${post.title || post.externalContentId || post.id}_评论`,
      })
      toast.success(`已导出 ${ordered.length} 条评论`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  const backAccountId = search.from || post?.account.id || ''
  const backSearch = { since: search.since, until: search.until }

  return (
    <ConsolePage>
      <ConsoleBar
        title="帖子评论"
        description="查看该帖的一级评论和二级回复；评论不按时间筛选。"
        actions={(
          <>
            {backAccountId ? (
              <Button asChild variant="outline" className="gap-1.5">
                <Link to="/account/$accountId" params={{ accountId: backAccountId }} search={backSearch}>
                  <ArrowLeft className="size-3.5" />
                  返回账号
                </Link>
              </Button>
            ) : (
              <Button asChild variant="outline" className="gap-1.5">
                <Link to="/accounts">
                  <ArrowLeft className="size-3.5" />
                  返回账号列表
                </Link>
              </Button>
            )}
          </>
        )}
      />

      {query.isPending ? (
        <div className="cx-loading">
          <div className="cx-skel" style={{ height: 140 }} />
          <div className="cx-skel" style={{ height: 120 }} />
        </div>
      ) : query.isError ? (
        query.error.message.includes('404') ? (
          <EmptyState
            icon={MessageSquare}
            title="帖子不存在"
            description="该帖子可能已被删除，返回账号列表重新选择。"
          />
        ) : (
          <div className="cx-error" style={{ marginTop: 16 }}>
            <p>帖子评论加载失败：{query.error.message}</p>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => query.refetch()}>
              <RefreshCw className="size-3.5" />重试
            </Button>
          </div>
        )
      ) : post ? (
        <>
          <section className="cx-surface" style={{ padding: 16 }}>
            <div className="flex flex-wrap items-start justify-between gap-5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <PlatformMark code={post.platformCode} name={post.platformName} />
                  <Link
                    className="cx-handle text-base hover:underline"
                    to="/account/$accountId"
                    params={{ accountId: post.account.id }}
                    search={backSearch}
                  >
                    {post.account.handle}
                  </Link>
                  <Badge variant="outline" className="font-normal">
                    {post.account.active ? '启用' : '停用'}
                  </Badge>
                  {post.contentType ? <span className="cx-tag">{post.contentType}</span> : null}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <a
                    className="text-sm font-medium hover:underline"
                    href={post.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {post.title || post.url || post.id}
                  </a>
                  <a className="cx-link inline-flex items-center gap-1" href={post.url} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-3.5" />打开原帖
                  </a>
                </div>
                {post.summary ? (
                  <p className="mt-2 line-clamp-4 max-w-3xl text-xs leading-relaxed text-muted-foreground">
                    {post.summary.replace(/\s+/g, ' ').trim()}
                  </p>
                ) : null}
                <p className="mt-2 text-xs text-muted-foreground">
                  发布时间：{formatFullDateTime(post.publishTime)}
                </p>
              </div>
              <div className="grid min-w-[260px] grid-cols-2 gap-2 sm:grid-cols-4">
                <MiniMetric label="平台评论" value={formatNumber(query.data?.counts.platform)} />
                <MiniMetric label="已抓评论" value={formatNumber(query.data?.counts.total)} />
                <MiniMetric label="一级" value={formatNumber(query.data?.counts.topLevel)} />
                <MiniMetric label="回复" value={formatNumber(query.data?.counts.replies)} />
              </div>
            </div>
          </section>

          <section className="cx-section" style={{ marginTop: 16 }}>
            <div className="cx-section-head">
              <h2 className="cx-h2">评论</h2>
              <span className="cx-count">{formatNumber(comments.length)} 条</span>
              <span className="cx-count">· 一级 {formatNumber(topLevel.length)}</span>
              <span className="cx-count">· 回复 {formatNumber(comments.length - topLevel.length)}</span>
              <Button
                variant="outline"
                size="sm"
                className="ml-auto gap-1.5"
                onClick={() => void downloadPost()}
                disabled={!ordered.length || exporting}
                title={ordered.length ? `导出 ${ordered.length} 条评论` : '该帖还没有抓到评论'}
              >
                {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                {exporting ? '导出中…' : '下载该帖评论'}
              </Button>
            </div>

            {comments.length ? (
              <div className="grid gap-3">
                {topLevel.map((comment) => {
                  const replies = repliesByRoot.map.get(comment.id) || []
                  return (
                    <article key={comment.id} className="rounded-xl border border-border/70 bg-card/70 p-4">
                      <CommentBlock comment={comment} />
                      {replies.length ? (
                        <div className="mt-3 space-y-2 border-l-2 border-border/60 pl-3">
                          {replies.map((reply) => {
                            const nestedParent = reply.parentCommentId && reply.parentCommentId !== comment.id
                              ? nameById.get(reply.parentCommentId) || reply.parentCommentId
                              : null
                            return (
                              <CommentBlock
                                key={reply.id}
                                comment={reply}
                                nested
                                parentName={nestedParent}
                              />
                            )
                          })}
                        </div>
                      ) : null}
                      {replies.length ? (
                        <p className="mt-2 text-[11px] text-muted-foreground">已抓回复 {replies.length} 条</p>
                      ) : null}
                    </article>
                  )
                })}

                {repliesByRoot.orphans.length ? (
                  <article className="rounded-xl border border-dashed border-border/70 bg-card/50 p-4">
                    <p className="text-xs text-muted-foreground">
                      以下回复找不到对应的一级评论（可能是一级评论已被删除）：{repliesByRoot.orphans.length} 条
                    </p>
                    <div className="mt-3 space-y-2">
                      {repliesByRoot.orphans.map((reply) => (
                        <CommentBlock key={reply.id} comment={reply} nested />
                      ))}
                    </div>
                  </article>
                ) : null}
              </div>
            ) : (
              <EmptyState
                icon={MessageSquare}
                title="还没有抓到评论"
                description="该帖子可能没有评论，或评论任务还没有覆盖到它。"
              />
            )}
          </section>
        </>
      ) : (
        <EmptyState
          icon={UsersRound}
          title="帖子不存在"
          description="该帖子可能已被删除，返回账号列表重新选择。"
        />
      )}
    </ConsolePage>
  )
}
