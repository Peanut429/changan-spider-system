import { COMMENT_NOT_RETRYABLE, isPermanentCommentError } from "../../core/comment-errors.ts";
import type { DbHandle } from "../factory.ts";
import { insertRawRecord } from "./raw-records.ts";

export type CommentPostProgressInput = {
  runId: string;
  platformId: string;
  accountId: string;
  contentId: string;
  externalId: string | null;
  url: string;
  summary: Record<string, any>;
  errorMessage?: string | null;
  errorCode?: string | null;
  capturedTsMs?: number;
};

/**
 * 帖子级评论进度：一个帖子一次抓取写一条 scrape_raw_records。
 *
 * 成功行（error_code is null）即断点标记；失败行保留错误，续跑时会重试。
 * 不存完整 API 响应，只存计数摘要，避免每月几百 MB 的 raw 数据。
 */
export async function writeCommentPostProgress(
  handle: DbHandle,
  input: CommentPostProgressInput,
): Promise<string> {
  const failed = Boolean(input.errorMessage);
  return insertRawRecord(handle.db, {
    runId: input.runId,
    platformId: input.platformId,
    accountId: input.accountId,
    contentId: input.contentId,
    recordType: "comment_post",
    source: "tikhub",
    externalId: input.externalId,
    url: input.url,
    rawJson: input.summary,
    errorMessage: input.errorMessage || null,
    errorCode: failed ? (input.errorCode || "COMMENT_FETCH_FAILED") : null,
    capturedTsMs: input.capturedTsMs ?? Date.now(),
  });
}

/** 本 run 里该帖子是否已经成功抓过（失败行不算完成）。 */
export async function isCommentPostDone(
  handle: DbHandle,
  runId: string,
  contentId: string,
): Promise<boolean> {
  const result = await handle.pool.query(
    `select 1
       from scrape_raw_records
      where run_id = $1
        and content_id = $2
        and record_type = 'comment_post'
        and error_code is null
      limit 1`,
    [runId, contentId],
  );
  return result.rows.length > 0;
}

/**
 * 同一 run 内该帖子是否已经因为永久错误失败过。
 * 资源不存在/无权限/评论关闭这类错误重试也不会变好，直接跳过，避免再次扣费。
 */
export async function isCommentPostPermanentlyFailed(
  handle: DbHandle,
  runId: string,
  contentId: string,
): Promise<boolean> {
  const result = await handle.pool.query(
    `select error_code, error_message
       from scrape_raw_records
      where run_id = $1
        and content_id = $2
        and record_type = 'comment_post'
      order by captured_ts_ms desc
      limit 1`,
    [runId, contentId],
  );
  const row = result.rows[0];
  if (!row || !row.error_code) return false;
  return row.error_code === COMMENT_NOT_RETRYABLE || isPermanentCommentError(row.error_message);
}
