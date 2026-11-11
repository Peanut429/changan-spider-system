import { endOfDayInTimeZone, prefixedId, scrapeWindowStartTsMs } from "@changan/shared";
import type { DbHandle } from "@changan/db";

import { runCommentPlatform } from "../../../crawler/src/comments/runner.ts";
import type {
  CommentProgressEvent,
  CommentRunnerOptions,
  RunCommentPlatformInput,
} from "../../../crawler/src/comments/runner.ts";
import { COMMENT_PLATFORM_CODES, getCommentFetcher } from "../../../crawler/src/comments/registry.ts";
import { createTikHubClient } from "../../../crawler/src/core/tikhub.ts";
import { dayKeyInTimeZone } from "../../../crawler/src/core/db-time.ts";
import { consoleLogger } from "../../../crawler/src/core/logger.ts";
import {
  COMMENT_NOT_RETRYABLE,
  isPermanentCommentError,
} from "../../../crawler/src/core/comment-errors.ts";
import {
  createScrapeRun,
  ensurePlatform,
  finalizeRunFromAccounts,
} from "../../../crawler/src/db/repositories/runs.ts";

const TIME_ZONE = process.env.SCRAPE_TIMEZONE || "Asia/Shanghai";
const MAX_ACCOUNTS_PER_JOB = 200;
const SUPPORTED_PLATFORMS = new Set(COMMENT_PLATFORM_CODES);
const STALE_MESSAGE = "Web 服务重启导致任务中断，请重新触发";

/**
 * Web 进程启动时间：第一次查任务时，把本进程启动前遗留的 pending/running
 * 标记为失败。当前部署是单个 Web 实例；多实例部署需要改成 DB 锁。
 */
const PROCESS_STARTED_AT = Date.now();
let recovered = false;

type CommentJobRow = {
  id: string;
  status: string;
  account_ids: unknown;
  platform_codes: unknown;
  window_since_ts_ms: string | number;
  window_until_ts_ms: string | number;
  options: unknown;
  total_accounts: string | number;
  processed_accounts: string | number;
  success_accounts: string | number;
  failed_accounts: string | number;
  total_posts: string | number;
  processed_posts: string | number;
  fetched_comments: string | number;
  inserted_comments: string | number;
  updated_comments: string | number;
  failed_posts: string | number;
  run_ids: unknown;
  error_message: string | null;
  created_ts_ms: string | number;
  started_ts_ms: string | number | null;
  finished_ts_ms: string | number | null;
  updated_ts_ms: string | number;
};

export type CommentJobDto = {
  id: string;
  status: string;
  accountIds: string[];
  platformCodes: string[];
  window: { since: string | null; until: string | null; sinceTsMs: number; untilTsMs: number };
  options: Json;
  totalAccounts: number;
  processedAccounts: number;
  successAccounts: number;
  failedAccounts: number;
  totalPosts: number;
  processedPosts: number;
  fetchedComments: number;
  insertedComments: number;
  updatedComments: number;
  failedPosts: number;
  /** 失败帖子里真正可重试的数量；资源不存在/无权限等为 0。 */
  retryableFailedPosts: number;
  runIds: string[];
  errorMessage: string | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string | null;
};

type Json = Record<string, any>;

export type CreateCommentJobInput = {
  accountIds: string[];
  since: string;
  until: string;
  includeReplies?: boolean;
  maxCommentsPerPost?: number;
  maxRepliesPerComment?: number;
  maxPostsPerAccount?: number;
  includeZeroComments?: boolean;
  /** 失败重试时只处理这些 content id。 */
  contentIds?: string[];
  retryOfJobId?: string;
};

type JobAccount = {
  id: string;
  handle: string;
  profileUrl: string;
  platformCode: string;
  platformName: string;
};

const iso = (value: unknown): string | null => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? new Date(number).toISOString() : null;
};

const numberValue = (value: unknown): number => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const textArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
};

function failureIsRetryable(errorCode: string | null, errorMessage: string | null): boolean {
  if (errorCode === COMMENT_NOT_RETRYABLE) return false;
  return !isPermanentCommentError(errorMessage);
}

function jobDto(row: CommentJobRow, retryableFailedPosts = 0): CommentJobDto {
  return {
    id: row.id,
    status: row.status,
    accountIds: textArray(row.account_ids),
    platformCodes: textArray(row.platform_codes),
    window: {
      since: iso(row.window_since_ts_ms),
      until: iso(row.window_until_ts_ms),
      sinceTsMs: numberValue(row.window_since_ts_ms),
      untilTsMs: numberValue(row.window_until_ts_ms),
    },
    options: (row.options && typeof row.options === "object" ? row.options : {}) as Json,
    totalAccounts: numberValue(row.total_accounts),
    processedAccounts: numberValue(row.processed_accounts),
    successAccounts: numberValue(row.success_accounts),
    failedAccounts: numberValue(row.failed_accounts),
    totalPosts: numberValue(row.total_posts),
    processedPosts: numberValue(row.processed_posts),
    fetchedComments: numberValue(row.fetched_comments),
    insertedComments: numberValue(row.inserted_comments),
    updatedComments: numberValue(row.updated_comments),
    failedPosts: numberValue(row.failed_posts),
    retryableFailedPosts,
    runIds: textArray(row.run_ids),
    errorMessage: row.error_message,
    createdAt: iso(row.created_ts_ms),
    startedAt: iso(row.started_ts_ms),
    finishedAt: iso(row.finished_ts_ms),
    updatedAt: iso(row.updated_ts_ms),
  };
}

function isDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function integerOption(value: unknown, fallback: number, min: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`抓取参数必须是 ≥ ${min} 的整数：${value}`);
  }
  return parsed;
}

async function recoverInterruptedJobs(handle: DbHandle): Promise<void> {
  if (recovered) return;
  recovered = true;
  try {
    await handle.pool.query(
      `update comment_jobs
          set status = 'failed',
              finished_ts_ms = $1,
              updated_ts_ms = $1,
              error_message = $2
        where status in ('pending', 'running')
          and created_ts_ms < $3`,
      [Date.now(), STALE_MESSAGE, PROCESS_STARTED_AT],
    );
  } catch (error) {
    console.error("[comment-jobs] 清理中断任务失败：", error);
  }
}

async function loadJob(handle: DbHandle, id: string): Promise<CommentJobRow | null> {
  const result = await handle.pool.query("select * from comment_jobs where id = $1", [id]);
  return (result.rows[0] as CommentJobRow) ?? null;
}

async function loadJobAccounts(handle: DbHandle, accountIds: string[]): Promise<JobAccount[]> {
  if (!accountIds.length) return [];
  const result = await handle.pool.query(
    `select a.id, a.handle, a.profile_url, p.code as platform_code, p.name as platform_name
       from social_accounts a
       join platforms p on p.id = a.platform_id
      where a.id = any($1::text[])
        and a.active = true
        and p.enabled = true
      order by p.code, a.handle`,
    [accountIds],
  );
  return result.rows.map((row: any) => ({
    id: row.id,
    handle: row.handle,
    profileUrl: row.profile_url,
    platformCode: row.platform_code,
    platformName: row.platform_name,
  }));
}

/** 创建任务：校验账号/范围/选项，落库后加入内存队列。 */
export async function createCommentJob(
  handle: DbHandle,
  input: CreateCommentJobInput,
): Promise<CommentJobDto> {
  await recoverInterruptedJobs(handle);

  const accountIds = [...new Set((input.accountIds || []).map((id) => String(id).trim()).filter(Boolean))];
  if (!accountIds.length) throw new Error("请至少选择一个账号");
  if (accountIds.length > MAX_ACCOUNTS_PER_JOB) {
    throw new Error(`一次最多选择 ${MAX_ACCOUNTS_PER_JOB} 个账号`);
  }
  if (!input.since || !input.until || !isDateKey(input.since) || !isDateKey(input.until)) {
    throw new Error("请选择有效的帖子发布时间范围（YYYY-MM-DD）");
  }
  if (input.since > input.until) throw new Error("开始日期不能晚于结束日期");

  const client = createTikHubClient();
  if (!client.enabled) {
    throw new Error("Web 服务缺少 TIKHUB_API_KEY，无法执行评论抓取");
  }

  const accounts = await loadJobAccounts(handle, accountIds);
  if (!accounts.length) throw new Error("选中的账号不存在、已停用，或所属平台已停用");
  if (accounts.length !== accountIds.length) {
    throw new Error(`有 ${accountIds.length - accounts.length} 个账号已停用或不存在，请刷新后重新选择`);
  }
  const unsupported = accounts.filter((account) => !SUPPORTED_PLATFORMS.has(account.platformCode));
  if (unsupported.length) {
    const names = unsupported.slice(0, 5).map((account) => `${account.platformName}/${account.handle}`).join("、");
    throw new Error(
      `以下账号所在平台没有评论接口：${names}${unsupported.length > 5 ? " 等" : ""}`
      + "（评论任务只支持 Instagram / TikTok / YouTube / X）",
    );
  }

  const contentIds = [...new Set((input.contentIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  const options: CommentRunnerOptions & Json = {
    includeReplies: input.includeReplies !== false,
    maxCommentsPerPost: integerOption(input.maxCommentsPerPost, 500, 1),
    maxRepliesPerComment: integerOption(input.maxRepliesPerComment, 50, 0),
    maxPostsPerAccount: integerOption(input.maxPostsPerAccount, 0, 0),
    maxPagesPerPost: 10,
    maxReplyPagesPerComment: 3,
    includeZeroComments: Boolean(input.includeZeroComments),
    ...(contentIds.length ? { contentIds } : {}),
    ...(input.retryOfJobId ? { retryOfJobId: input.retryOfJobId } : {}),
  };

  const platformCodes = [...new Set(accounts.map((account) => account.platformCode))];
  const sinceTsMs = scrapeWindowStartTsMs(input.since, TIME_ZONE);
  const untilTsMs = endOfDayInTimeZone(Number(input.until.replace(/-/g, "")), TIME_ZONE);
  const id = prefixedId("comment-job");
  const now = Date.now();

  await handle.pool.query(
    `insert into comment_jobs(
       id, status, account_ids, platform_codes, window_since_ts_ms, window_until_ts_ms,
       options, total_accounts, created_ts_ms, updated_ts_ms
     ) values ($1, 'pending', $2::jsonb, $3::jsonb, $4, $5, $6::jsonb, $7, $8, $8)`,
    [
      id,
      JSON.stringify(accountIds),
      JSON.stringify(platformCodes),
      sinceTsMs,
      untilTsMs,
      JSON.stringify(options),
      accounts.length,
      now,
    ],
  );

  enqueueCommentJob(handle, id);
  const created = await loadJob(handle, id);
  if (!created) throw new Error("评论任务创建失败");
  return jobDto(created);
}

/**
 * 统计每个 run 里"最后一次尝试仍失败且可重试"的帖子数。
 * 只用于界面展示/重试入口，不改历史失败计数。
 */
async function retryableFailureCounts(
  handle: DbHandle,
  jobs: CommentJobRow[],
): Promise<Map<string, number>> {
  const runIds = [...new Set(jobs.flatMap((job) => textArray(job.run_ids)))];
  const counts = new Map<string, number>();
  if (!runIds.length) return counts;
  const result = await handle.pool.query(
    `with latest as (
       select content_id, max(captured_ts_ms) as max_ts
         from scrape_raw_records
        where record_type = 'comment_post'
        group by content_id
     )
     select r.run_id, r.content_id, r.error_code, r.error_message
       from scrape_raw_records r
       join latest l on l.content_id = r.content_id and l.max_ts = r.captured_ts_ms
      where r.record_type = 'comment_post'
        and r.run_id = any($1::text[])
        and r.error_code is not null`,
    [runIds],
  );
  for (const row of result.rows as any[]) {
    if (!failureIsRetryable(row.error_code, row.error_message)) continue;
    counts.set(row.run_id, (counts.get(row.run_id) || 0) + 1);
  }
  return counts;
}

function retryableCountForJob(
  row: CommentJobRow,
  counts: Map<string, number>,
): number {
  return textArray(row.run_ids).reduce((sum, runId) => sum + (counts.get(runId) || 0), 0);
}

/** 最近任务列表。 */
export async function listCommentJobs(handle: DbHandle, limit = 20): Promise<CommentJobDto[]> {
  await recoverInterruptedJobs(handle);
  const pageSize = Math.min(100, Math.max(1, Number(limit) || 20));
  const result = await handle.pool.query(
    "select * from comment_jobs order by created_ts_ms desc limit $1",
    [pageSize],
  );
  const rows = result.rows as CommentJobRow[];
  const counts = await retryableFailureCounts(handle, rows);
  return rows.map((row) => jobDto(row, retryableCountForJob(row, counts)));
}

export async function getCommentJob(handle: DbHandle, id: string): Promise<CommentJobDto | null> {
  await recoverInterruptedJobs(handle);
  const row = await loadJob(handle, id);
  if (!row) return null;
  const counts = await retryableFailureCounts(handle, [row]);
  return jobDto(row, retryableCountForJob(row, counts));
}

/** 内存队列：当前 Web 进程串行执行评论任务。 */
const queue: string[] = [];
let draining = false;

function enqueueCommentJob(handle: DbHandle, jobId: string): void {
  queue.push(jobId);
  void drainQueue(handle);
}

async function drainQueue(handle: DbHandle): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const jobId = queue.shift()!;
      try {
        await executeCommentJob(handle, jobId);
      } catch (error: any) {
        console.error(`[comment-jobs] 任务 ${jobId} 执行异常：`, error);
        await handle.pool.query(
          `update comment_jobs
              set status = 'failed',
                  error_message = $2,
                  finished_ts_ms = $3,
                  updated_ts_ms = $3
            where id = $1`,
          [jobId, String(error?.message || error).slice(0, 2000), Date.now()],
        ).catch(() => {});
      }
    }
  } finally {
    draining = false;
  }
}

async function appendRunId(handle: DbHandle, jobId: string, runId: string): Promise<void> {
  await handle.pool.query(
    `update comment_jobs
        set run_ids = coalesce(run_ids, '[]'::jsonb) || to_jsonb($2::text),
            updated_ts_ms = $3
      where id = $1`,
    [jobId, runId, Date.now()],
  );
}

async function applyProgress(
  handle: DbHandle,
  jobId: string,
  event: CommentProgressEvent,
): Promise<void> {
  const now = Date.now();
  if (event.type === "account_start") {
    await handle.pool.query(
      `update comment_jobs
          set total_posts = total_posts + $2,
              updated_ts_ms = $3
        where id = $1`,
      [jobId, event.posts, now],
    );
    return;
  }
  if (event.type === "post_done") {
    await handle.pool.query(
      `update comment_jobs
          set processed_posts = processed_posts + 1,
              fetched_comments = fetched_comments + $2,
              inserted_comments = inserted_comments + $3,
              updated_comments = updated_comments + $4,
              failed_posts = failed_posts + $5,
              updated_ts_ms = $6
        where id = $1`,
      [jobId, event.comments, event.inserted, event.updated, event.failed ? 1 : 0, now],
    );
    return;
  }
  const success = event.status === "success" ? 1 : 0;
  const failed = event.status === "failed" || event.status === "partial_failed" ? 1 : 0;
  await handle.pool.query(
    `update comment_jobs
        set processed_accounts = processed_accounts + 1,
            success_accounts = success_accounts + $2,
            failed_accounts = failed_accounts + $3,
            updated_ts_ms = $4
      where id = $1`,
    [jobId, success, failed, now],
  );
}

export type CommentJobFailedPostDto = {
  contentId: string;
  url: string;
  accountHandle: string;
  platformCode: string;
  errorMessage: string | null;
  retryable: boolean;
  attemptedAt: string | null;
};

/** 原任务里"最后一次尝试仍失败"的帖子（失败详情弹窗用）。 */
export async function listFailedCommentPosts(
  handle: DbHandle,
  jobId: string,
): Promise<CommentJobFailedPostDto[]> {
  const job = await loadJob(handle, jobId);
  if (!job) throw new Error("评论任务不存在");
  const runIds = textArray(job.run_ids);
  if (!runIds.length) return [];
  const result = await handle.pool.query(
    `with latest as (
       select content_id, max(captured_ts_ms) as max_ts
         from scrape_raw_records
        where record_type = 'comment_post'
        group by content_id
     )
     select r.content_id, coalesce(r.url, c.url) as url, r.error_message, r.error_code,
            r.captured_ts_ms, a.handle, p.code as platform_code
       from scrape_raw_records r
       join latest l on l.content_id = r.content_id and l.max_ts = r.captured_ts_ms
       join social_contents c on c.id = r.content_id
       join social_accounts a on a.id = c.account_id
       join platforms p on p.id = a.platform_id
      where r.record_type = 'comment_post'
        and r.run_id = any($1::text[])
        and r.error_code is not null
        and a.active = true
        and p.enabled = true
      order by r.captured_ts_ms desc
      limit 200`,
    [runIds],
  );
  return result.rows.map((row: any) => ({
    contentId: row.content_id,
    url: String(row.url || ""),
    accountHandle: row.handle,
    platformCode: row.platform_code,
    errorMessage: row.error_message || null,
    retryable: failureIsRetryable(row.error_code, row.error_message),
    attemptedAt: iso(row.captured_ts_ms),
  }));
}

/**
 * 只重试原任务里"最后一次尝试仍失败"的帖子。
 * 新建一个任务，options.contentIds 限定帖子，避免重抓已成功的帖子。
 */
export async function retryFailedCommentJob(handle: DbHandle, jobId: string): Promise<CommentJobDto> {
  await recoverInterruptedJobs(handle);
  const job = await loadJob(handle, jobId);
  if (!job) throw new Error("评论任务不存在");
  const runIds = textArray(job.run_ids);
  if (!runIds.length) throw new Error("该任务没有记录 run，无法重试失败帖子");

  // 每个帖子只看最后一次尝试；只有最后一次是失败的才重试。
  const failed = await handle.pool.query(
    `with latest as (
       select content_id, max(captured_ts_ms) as max_ts
         from scrape_raw_records
        where record_type = 'comment_post'
        group by content_id
     )
     select distinct r.content_id, r.error_code, r.error_message
       from scrape_raw_records r
       join latest l on l.content_id = r.content_id and l.max_ts = r.captured_ts_ms
       join social_contents c on c.id = r.content_id
       join social_accounts a on a.id = c.account_id
       join platforms p on p.id = a.platform_id
      where r.record_type = 'comment_post'
        and r.run_id = any($1::text[])
        and r.error_code is not null
        and a.active = true
        and p.enabled = true
      limit 2001`,
    [runIds],
  );
  const retryableRows = (failed.rows as any[]).filter((row) =>
    failureIsRetryable(row.error_code, row.error_message)
  );
  const contentIds = [...new Set(retryableRows.map((row) => String(row.content_id || "")).filter(Boolean))];
  if (!contentIds.length) {
    throw new Error("没有可重试的失败帖子：资源不存在/无权限/评论关闭等错误不会重试，避免重复扣费");
  }
  if (contentIds.length > 2000) {
    throw new Error(`可重试的失败帖子超过 2000 个（${contentIds.length}），请用 CLI 分批重跑`);
  }

  const accountRows = await handle.pool.query(
    `select distinct c.account_id, a.handle, p.code as platform_code, p.name as platform_name
       from social_contents c
       join social_accounts a on a.id = c.account_id
       join platforms p on p.id = a.platform_id
      where c.id = any($1::text[])
        and a.active = true
        and p.enabled = true`,
    [contentIds],
  );
  if (!accountRows.rows.length) throw new Error("失败帖子对应账号均已停用或不存在");
  const unsupported = accountRows.rows.filter((row: any) => !SUPPORTED_PLATFORMS.has(row.platform_code));
  if (unsupported.length) {
    throw new Error(`失败帖子包含无评论接口的平台：${unsupported.map((row: any) => row.platform_code).join(", ")}`);
  }
  const accountIds = [...new Set(accountRows.rows.map((row: any) => String(row.account_id)))];
  const platformCodes = [...new Set(accountRows.rows.map((row: any) => String(row.platform_code)))];

  const originalOptions = (job.options && typeof job.options === "object" ? job.options : {}) as Json;
  const options = {
    ...originalOptions,
    contentIds,
    retryOfJobId: jobId,
  };
  const id = prefixedId("comment-job");
  const now = Date.now();
  await handle.pool.query(
    `insert into comment_jobs(
       id, status, account_ids, platform_codes, window_since_ts_ms, window_until_ts_ms,
       options, total_accounts, created_ts_ms, updated_ts_ms
     ) values ($1, 'pending', $2::jsonb, $3::jsonb, $4, $5, $6::jsonb, $7, $8, $8)`,
    [
      id,
      JSON.stringify(accountIds),
      JSON.stringify(platformCodes),
      numberValue(job.window_since_ts_ms),
      numberValue(job.window_until_ts_ms),
      JSON.stringify(options),
      accountIds.length,
      now,
    ],
  );
  enqueueCommentJob(handle, id);
  const created = await loadJob(handle, id);
  if (!created) throw new Error("重试任务创建失败");
  return jobDto(created);
}

/**
 * 执行一个任务：按平台建 run，调用 crawler 的评论 runner（纯接口），
 * 进度通过 onProgress 写回 comment_jobs。
 */
async function executeCommentJob(handle: DbHandle, jobId: string): Promise<void> {
  const job = await loadJob(handle, jobId);
  if (!job || !["pending", "running"].includes(job.status)) return;

  const startedAt = Date.now();
  await handle.pool.query(
    `update comment_jobs
        set status = 'running', started_ts_ms = $2, finished_ts_ms = null,
            error_message = null, updated_ts_ms = $2
      where id = $1`,
    [jobId, startedAt],
  );

  const rawOptions = (job.options && typeof job.options === "object" ? job.options : {}) as Json;
  const options: CommentRunnerOptions = {
    includeReplies: rawOptions.includeReplies !== false,
    maxCommentsPerPost: integerOption(rawOptions.maxCommentsPerPost, 500, 1),
    maxRepliesPerComment: integerOption(rawOptions.maxRepliesPerComment, 50, 0),
    maxPostsPerAccount: integerOption(rawOptions.maxPostsPerAccount, 0, 0),
    maxPagesPerPost: integerOption(rawOptions.maxPagesPerPost, 10, 1),
    maxReplyPagesPerComment: integerOption(rawOptions.maxReplyPagesPerComment, 3, 0),
    includeZeroComments: Boolean(rawOptions.includeZeroComments),
    contentIds: Array.isArray(rawOptions.contentIds)
      ? rawOptions.contentIds.map((id: unknown) => String(id || "").trim()).filter(Boolean)
      : undefined,
  };
  const accountIds = textArray(job.account_ids);
  const sinceTsMs = numberValue(job.window_since_ts_ms);
  const untilTsMs = numberValue(job.window_until_ts_ms);
  const accounts = await loadJobAccounts(handle, accountIds);
  if (!accounts.length) {
    await handle.pool.query(
      `update comment_jobs
          set status = 'failed', error_message = '选中账号均已停用或不存在',
              finished_ts_ms = $2, updated_ts_ms = $2
        where id = $1`,
      [jobId, Date.now()],
    );
    return;
  }

  const errors: string[] = [];
  if (accounts.length !== accountIds.length) {
    errors.push(`有 ${accountIds.length - accounts.length} 个账号已停用或不存在，未处理`);
  }

  const grouped = new Map<string, JobAccount[]>();
  for (const account of accounts) {
    const list = grouped.get(account.platformCode) || [];
    list.push(account);
    grouped.set(account.platformCode, list);
  }

  const client = createTikHubClient();
  if (!client.enabled) {
    await handle.pool.query(
      `update comment_jobs
          set status = 'failed', error_message = 'Web 服务缺少 TIKHUB_API_KEY',
              finished_ts_ms = $2, updated_ts_ms = $2
        where id = $1`,
      [jobId, Date.now()],
    );
    return;
  }

  for (const [platformCode, platformAccounts] of grouped) {
    const fetcher = getCommentFetcher(platformCode);
    const platformId = await ensurePlatform(handle.db, { code: fetcher.code, name: fetcher.name });
    const runId = await createScrapeRun(handle.db, {
      platformId,
      triggerType: "manual",
      windowSinceTsMs: sinceTsMs,
      windowUntilTsMs: untilTsMs,
      taskDateKey: dayKeyInTimeZone(Date.now(), TIME_ZONE),
      command: `web comment job ${jobId}`,
    });
    await appendRunId(handle, jobId, runId);

    try {
      const runnerInput: RunCommentPlatformInput = {
        handle,
        runId,
        platformId,
        platformCode: fetcher.code,
        fetcher,
        accounts: platformAccounts.map((account) => ({
          id: account.id,
          account: account.handle,
          link: account.profileUrl,
        })),
        client,
        windowSinceTsMs: sinceTsMs,
        windowUntilTsMs: untilTsMs,
        options,
        logger: consoleLogger(fetcher.code),
        stop: { stopped: false },
        onProgress: (event) => applyProgress(handle, jobId, event),
      };
      await runCommentPlatform(runnerInput);
      const runStatus = await finalizeRunFromAccounts(handle.db, { runId, exitCode: 0 });
      if (runStatus !== "success") {
        errors.push(`${fetcher.name}: ${runStatus}`);
      }
    } catch (error: any) {
      const message = String(error?.message || error).slice(0, 1000);
      errors.push(`${fetcher.name}: ${message}`);
      await finalizeRunFromAccounts(handle.db, { runId, exitCode: 1, errorMessage: message }).catch(() => {});
    }
  }

  const finalJob = await loadJob(handle, jobId);
  if (!finalJob) return;
  const processed = numberValue(finalJob.processed_accounts);
  const success = numberValue(finalJob.success_accounts);
  const failed = numberValue(finalJob.failed_accounts);
  let status: "success" | "partial_failed" | "failed";
  if (processed === 0) status = "failed";
  else if (failed > 0 || errors.length > 0) status = success > 0 ? "partial_failed" : "failed";
  else status = "success";

  const finishedAt = Date.now();
  await handle.pool.query(
    `update comment_jobs
        set status = $2,
            error_message = $3,
            finished_ts_ms = $4,
            updated_ts_ms = $4
      where id = $1`,
    [jobId, status, errors.length ? errors.join(" | ").slice(0, 2000) : null, finishedAt],
  );
}
