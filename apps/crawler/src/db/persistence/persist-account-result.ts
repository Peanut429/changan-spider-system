import { sql } from "drizzle-orm";
import type { Database } from "../factory.ts";
import { accountDailyMetrics, contentDailyMetrics } from "../schema.ts";
import { nowTsMs } from "../../core/db-time.ts";
import { prefixedId } from "../../core/id.ts";
import { numberOrNull, textOrNull } from "../../core/coerce.ts";
import { ensurePlatform } from "../repositories/runs.ts";
import { finishRunAccount, refreshScrapeRunCounts, startRunAccount } from "../repositories/run-accounts.ts";
import { upsertContent } from "../repositories/contents.ts";
import { insertRawRecord } from "../repositories/raw-records.ts";
import { resolveMetricDayKey } from "./day-key.ts";
import { contentExternalId, contentUrl, errorCodeForMessage } from "./normalize.ts";

export type PersistAccountResultInput = {
  platformCode: string;
  platformName: string;
  runId: string;
  accountId: string;
  accountRow: any;
  contentRows?: any[];
  capturedTsMs?: number;
  taskDateKey?: number | null;
  partialFailure?: {
    errorCode: string;
    errorMessage: string;
  } | null;
};

/**
 * 账号级增量入库。行为从旧项目 persistScrapeAccountResult 原样迁移：
 * - 使用 runner 已解析的 accountId，不再从抓取结果创建账号
 * - raw account 记录
 * - account_daily_metrics upsert（account_id + run_id）
 * - 每条内容 upsert social_contents + raw content + content_daily_metrics
 * - scrape_run_accounts 状态
 * - 刷新 run 统计
 */
export async function persistScrapeAccountResult(
  db: Database,
  {
    platformCode,
    platformName,
    runId,
    accountId,
    accountRow,
    contentRows = [],
    capturedTsMs = nowTsMs(),
    taskDateKey,
    partialFailure = null,
  }: PersistAccountResultInput,
): Promise<void> {
  const platformId = await ensurePlatform(db, { code: platformCode, name: platformName });
  await startRunAccount(db, { runId, accountId });

  const metricDayKey = await resolveMetricDayKey(db, runId, taskDateKey);
  let contentSavedCount = 0;
  let failedContentCount = 0;

  try {
    const accountRawRecordId = await insertRawRecord(db, {
      runId,
      platformId,
      accountId,
      recordType: accountRow.error ? "error" : "account",
      source: "scraper",
      externalId: textOrNull(accountRow.externalAccountId || accountRow.channelId || accountRow.tikhubUserId),
      url: textOrNull(accountRow.profileUrl || accountRow.link),
      rawJson: accountRow,
      errorMessage: accountRow.error || accountRow.tikhubError || null,
      capturedTsMs,
    });

    await db
      .insert(accountDailyMetrics)
      .values({
        id: prefixedId("amtr"),
        accountId,
        platformId,
        runId,
        metricDayKey,
        capturedTsMs,
        followersCount: numberOrNull(accountRow.tikhubFollowerCount ?? accountRow.followersText),
        followingCount: numberOrNull(accountRow.tikhubFollowingCount ?? accountRow.followingText),
        postsCount: numberOrNull(accountRow.tikhubMediaCount ?? accountRow.postsText),
        contentCountInWindow: contentRows.length,
        newContentCount: null,
        errorCode: errorCodeForMessage(accountRow.error || accountRow.tikhubError),
        errorMessage: accountRow.error || accountRow.tikhubError || null,
        rawMetricJson: accountRow,
        rawRecordId: accountRawRecordId,
        createdTsMs: nowTsMs(),
      })
      .onConflictDoUpdate({
        target: [accountDailyMetrics.accountId, accountDailyMetrics.runId],
        set: {
          capturedTsMs,
          followersCount: sql`excluded.followers_count`,
          followingCount: sql`excluded.following_count`,
          postsCount: sql`excluded.posts_count`,
          contentCountInWindow: sql`excluded.content_count_in_window`,
          errorCode: sql`excluded.error_code`,
          errorMessage: sql`excluded.error_message`,
          rawMetricJson: sql`excluded.raw_metric_json`,
          rawRecordId: accountRawRecordId,
        },
      });

    for (const row of contentRows) {
      const contentId = await upsertContent(db, { platformId, accountId, row, capturedTsMs });
      const rawRecordId = await insertRawRecord(db, {
        runId,
        platformId,
        accountId,
        contentId,
        recordType: row.error ? "error" : "content",
        source: "scraper",
        externalId: contentExternalId(row),
        url: contentUrl(row),
        rawJson: row,
        errorMessage: row.error || null,
        capturedTsMs,
      });

      if (row.error) failedContentCount += 1;
      if (!contentId) {
        failedContentCount += row.error ? 0 : 1;
        continue;
      }

      await db
        .insert(contentDailyMetrics)
        .values({
          id: prefixedId("cmtr"),
          contentId,
          accountId,
          platformId,
          runId,
          metricDayKey,
          capturedTsMs,
          exposureCount: numberOrNull(row.exposureText),
          readCount: numberOrNull(row.readText),
          playCount: numberOrNull(row.playText || row.viewsRaw || row.viewCount),
          likeCount: numberOrNull(row.likeText),
          commentCount: numberOrNull(row.commentText),
          collectCount: numberOrNull(row.collectText),
          shareCount: numberOrNull(row.shareText),
          errorCode: errorCodeForMessage(row.error),
          errorMessage: row.error || null,
          rawMetricJson: row,
          rawRecordId,
          createdTsMs: nowTsMs(),
        })
        .onConflictDoUpdate({
          target: [contentDailyMetrics.contentId, contentDailyMetrics.runId],
          set: {
            capturedTsMs,
            exposureCount: sql`excluded.exposure_count`,
            readCount: sql`excluded.read_count`,
            playCount: sql`excluded.play_count`,
            likeCount: sql`excluded.like_count`,
            commentCount: sql`excluded.comment_count`,
            collectCount: sql`excluded.collect_count`,
            shareCount: sql`excluded.share_count`,
            errorCode: sql`excluded.error_code`,
            errorMessage: sql`excluded.error_message`,
            rawMetricJson: sql`excluded.raw_metric_json`,
            rawRecordId,
          },
        });

      if (!row.error) contentSavedCount += 1;
    }

    const accountError = accountRow.error || accountRow.tikhubError || null;
    const status = accountError
      ? "failed"
      : failedContentCount > 0 || partialFailure
        ? "partial_failed"
        : "success";

    await finishRunAccount(db, {
      runId,
      accountId,
      status,
      contentFoundCount: contentRows.length,
      contentSavedCount,
      failedContentCount,
      lastStep: "save_db",
      errorCode: accountError ? null : (partialFailure?.errorCode || null),
      errorMessage: accountError || partialFailure?.errorMessage || null,
    });
  } catch (error: any) {
    await finishRunAccount(db, {
      runId,
      accountId,
      status: "failed",
      contentFoundCount: contentRows.length,
      contentSavedCount,
      failedContentCount: Math.max(failedContentCount, contentRows.length - contentSavedCount),
      lastStep: "save_db",
      errorMessage: error.message || String(error),
    });
    throw error;
  } finally {
    await refreshScrapeRunCounts(db, runId);
  }
}
