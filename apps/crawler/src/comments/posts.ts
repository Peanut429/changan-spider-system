import type { DbHandle } from "../db/factory.ts";
import type { CommentPost } from "./types.ts";

export type LoadCommentPostsInput = {
  accountId: string;
  windowSinceTsMs: number;
  windowUntilTsMs: number;
  /** 默认 false：只取最近一次每日指标里 comment_count > 0 的帖子。 */
  includeZeroComments?: boolean;
  /** 0 / 省略表示不限制。 */
  limit?: number;
  /** 只处理这些帖子（失败重试用）；给了以后忽略时间范围和评论数筛选。 */
  contentIds?: string[];
};

/**
 * 取某个账号在时间窗口内的帖子。
 *
 * 评论数取 content_daily_metrics 最近一次快照（captured_ts_ms 最大），
 * 只用于"有没有必要请求评论接口"的判断；没有指标行的帖子按 0 处理。
 */
export async function loadCommentPosts(
  handle: DbHandle,
  input: LoadCommentPostsInput,
): Promise<CommentPost[]> {
  const limit = Math.max(0, Math.floor(Number(input.limit || 0)));
  const contentIds = [...new Set((input.contentIds || []).map((id) => String(id || "").trim()).filter(Boolean))];

  const selectColumns = `
    select c.id, c.external_content_id, c.url, c.publish_ts_ms, c.content_type, c.title,
           m.comment_count
      from social_contents c
      left join lateral (
        select comment_count
          from content_daily_metrics
         where content_id = c.id
           and comment_count is not null
         order by captured_ts_ms desc
         limit 1
      ) m on true`;

  const result = contentIds.length
    ? await handle.pool.query(
        `${selectColumns}
          where c.account_id = $1
            and c.id = any($2::text[])
          order by c.publish_ts_ms asc nulls last, c.id asc
          limit $3`,
        [input.accountId, contentIds, limit > 0 ? limit : null],
      )
    : await handle.pool.query(
        `${selectColumns}
          where c.account_id = $1
            and c.publish_ts_ms is not null
            and c.publish_ts_ms between $2 and $3
            and ($4::boolean or coalesce(m.comment_count, 0) > 0)
          order by c.publish_ts_ms asc, c.id asc
          limit $5`,
        [
          input.accountId,
          input.windowSinceTsMs,
          input.windowUntilTsMs,
          Boolean(input.includeZeroComments),
          limit > 0 ? limit : null,
        ],
      );

  return result.rows.map((row: any) => ({
    contentId: row.id,
    externalContentId: row.external_content_id || null,
    url: String(row.url || ""),
    publishTsMs: row.publish_ts_ms == null ? null : Number(row.publish_ts_ms),
    contentType: row.content_type || null,
    title: row.title || null,
    commentCount: row.comment_count == null ? null : Number(row.comment_count),
  }));
}
