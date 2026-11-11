import type { DbHandle } from "../factory.ts";
import type { FetchedComment } from "../../comments/types.ts";

const CHUNK_SIZE = 200;
const COLUMN_COUNT = 15;

export type UpsertCommentsInput = {
  platformCode: string;
  contentId: string;
  accountId: string;
  runId: string;
  comments: FetchedComment[];
  capturedTsMs?: number;
};

export type UpsertCommentsResult = {
  inserted: number;
  updated: number;
  /** 同一批里重复的 ID + 跨平台 ID 冲突被跳过的行。 */
  skipped: number;
};

function uniqueById(comments: FetchedComment[]): FetchedComment[] {
  const byId = new Map<string, FetchedComment>();
  for (const comment of comments) {
    if (!comment.id) continue;
    byId.set(comment.id, comment);
  }
  return [...byId.values()];
}

/**
 * 批量写入评论。
 *
 * - 主键仍是平台评论 ID；同一评论重跑时更新点赞/最后出现时间，不新增行。
 * - parent/root 用 coalesce 保留第一次写入的关系。
 * - where cm.platform = excluded.platform 防止极小概率的跨平台 ID 撞车覆盖。
 * - returning (xmax = 0) 区分新增/更新，供汇总使用。
 */
export async function upsertComments(
  handle: DbHandle,
  input: UpsertCommentsInput,
): Promise<UpsertCommentsResult> {
  const comments = uniqueById(input.comments);
  const duplicates = input.comments.length - comments.length;
  if (!comments.length) {
    return { inserted: 0, updated: 0, skipped: duplicates };
  }

  const capturedTsMs = input.capturedTsMs ?? Date.now();
  let inserted = 0;
  let updated = 0;
  let returned = 0;

  for (let start = 0; start < comments.length; start += CHUNK_SIZE) {
    const chunk = comments.slice(start, start + CHUNK_SIZE);
    const placeholders: string[] = [];
    const values: any[] = [];

    for (const comment of chunk) {
      const base = values.length;
      const rowPlaceholders: string[] = [];
      for (let column = 1; column <= COLUMN_COUNT; column++) {
        rowPlaceholders.push(`$${base + column}`);
      }
      placeholders.push(`(${rowPlaceholders.join(", ")})`);
      values.push(
        comment.id,
        comment.username,
        comment.userId,
        comment.text,
        input.platformCode,
        input.contentId,
        comment.createdAtTsMs || 0,
        input.accountId,
        input.runId,
        comment.likeCount,
        comment.replyCount,
        comment.parentCommentId,
        comment.rootCommentId,
        capturedTsMs,
        capturedTsMs,
      );
    }

    const result = await handle.pool.query(
      `insert into comment as cm (
         id, username, user_id, text_content, platform, content_id, create_timestamp,
         account_id, run_id, like_count, reply_count,
         parent_comment_id, root_comment_id, first_seen_ts_ms, last_seen_ts_ms
       ) values ${placeholders.join(", ")}
       on conflict (id) do update set
         username = case when excluded.username <> '' then excluded.username else cm.username end,
         user_id = case when excluded.user_id <> '' then excluded.user_id else cm.user_id end,
         text_content = case when excluded.text_content <> '' then excluded.text_content else cm.text_content end,
         platform = excluded.platform,
         content_id = coalesce(cm.content_id, excluded.content_id),
         create_timestamp = case
           when coalesce(cm.create_timestamp, 0) = 0 and excluded.create_timestamp > 0
           then excluded.create_timestamp
           else cm.create_timestamp
         end,
         like_count = coalesce(excluded.like_count, cm.like_count),
         reply_count = coalesce(excluded.reply_count, cm.reply_count),
         parent_comment_id = coalesce(cm.parent_comment_id, excluded.parent_comment_id),
         root_comment_id = coalesce(cm.root_comment_id, excluded.root_comment_id),
         last_seen_ts_ms = excluded.last_seen_ts_ms,
         run_id = excluded.run_id,
         account_id = coalesce(cm.account_id, excluded.account_id)
       where cm.platform = excluded.platform
       returning (xmax = 0) as inserted`,
      values,
    );

    returned += result.rows.length;
    for (const row of result.rows) {
      if (row.inserted) inserted += 1;
      else updated += 1;
    }
  }

  return {
    inserted,
    updated,
    skipped: duplicates + (comments.length - returned),
  };
}
