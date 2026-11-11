import type { Logger } from "../core/logger.ts";
import type { SourceAccount } from "../core/accounts.ts";
import { truncateText } from "../core/strings.ts";
import type { DbHandle } from "../db/factory.ts";
import {
  finishRunAccount,
  isRunAccountCompleted,
  refreshScrapeRunCounts,
  startScrapeRunAccount,
} from "../db/repositories/run-accounts.ts";
import { upsertComments } from "../db/repositories/comments.ts";
import {
  isCommentPostDone,
  isCommentPostPermanentlyFailed,
  writeCommentPostProgress,
} from "../db/repositories/comment-progress.ts";
import { commentFailureCode } from "../core/comment-errors.ts";
import { loadCommentPosts } from "./posts.ts";
import { describeError, isFatalTikHubError } from "./shared.ts";
import type {
  CommentApiClient,
  CommentFetcher,
  CommentFetchOptions,
} from "./types.ts";

export class RunInterruptedError extends Error {
  constructor() {
    super("收到中断信号，评论任务停止");
    this.name = "RunInterruptedError";
  }
}

export type StopSignal = { stopped: boolean };

/** 评论任务进度事件，Web 端用来更新实时进度；CLI 不传就忽略。 */
export type CommentProgressEvent =
  | { type: "account_start"; account: string; posts: number }
  | {
      type: "post_done";
      account: string;
      postId: string;
      comments: number;
      inserted: number;
      updated: number;
      failed: boolean;
    }
  | {
      type: "account_done";
      account: string;
      status: "success" | "partial_failed" | "failed" | "skipped";
      posts: number;
      saved: number;
      failed: number;
    };

async function emitProgress(
  onProgress: RunCommentPlatformInput["onProgress"],
  event: CommentProgressEvent,
): Promise<void> {
  if (!onProgress) return;
  try {
    await onProgress(event);
  } catch (error) {
    console.warn(`[comment] 进度回调失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

export type CommentRunnerOptions = CommentFetchOptions & {
  includeZeroComments: boolean;
  maxPostsPerAccount: number;
  /** 只处理这些帖子（失败重试）；给了以后忽略时间/评论数筛选。 */
  contentIds?: string[];
};

export type PlatformCommentSummary = {
  platformCode: string;
  platformName: string;
  accounts: number;
  successAccounts: number;
  failedAccounts: number;
  skippedAccounts: number;
  posts: number;
  postsWithComments: number;
  failedPosts: number;
  topLevelComments: number;
  replyComments: number;
  inserted: number;
  updated: number;
  skippedComments: number;
  apiCalls: number;
  truncatedPosts: number;
  zeroPostAccounts: string[];
  durationMs: number;
};

export type RunCommentPlatformInput = {
  handle: DbHandle;
  runId: string;
  platformId: string;
  platformCode: string;
  fetcher: CommentFetcher;
  accounts: SourceAccount[];
  client: CommentApiClient;
  windowSinceTsMs: number;
  windowUntilTsMs: number;
  options: CommentRunnerOptions;
  logger: Logger;
  stop?: StopSignal;
  onProgress?: (event: CommentProgressEvent) => void | Promise<void>;
};

function summaryOf(input: RunCommentPlatformInput): PlatformCommentSummary {
  return {
    platformCode: input.platformCode,
    platformName: input.fetcher.name,
    accounts: input.accounts.length,
    successAccounts: 0,
    failedAccounts: 0,
    skippedAccounts: 0,
    posts: 0,
    postsWithComments: 0,
    failedPosts: 0,
    topLevelComments: 0,
    replyComments: 0,
    inserted: 0,
    updated: 0,
    skippedComments: 0,
    apiCalls: 0,
    truncatedPosts: 0,
    zeroPostAccounts: [],
    durationMs: 0,
  };
}

/**
 * 一个平台的评论抓取：账号循环 → 帖子循环 → 评论接口 → 入库。
 *
 * 帖子从 social_contents 读取（帖子由每日任务负责），
 * 每个帖子的评论进度写 scrape_raw_records，支持同一 run 内续跑。
 */
export async function runCommentPlatform(input: RunCommentPlatformInput): Promise<PlatformCommentSummary> {
  const {
    handle,
    runId,
    platformId,
    platformCode,
    fetcher,
    accounts,
    client,
    options,
    logger,
    stop,
    onProgress,
  } = input;
  const summary = summaryOf(input);
  const startedAt = Date.now();

  for (const account of accounts) {
    if (stop?.stopped) throw new RunInterruptedError();
    const handleName = account.account;

    const completed = await isRunAccountCompleted(handle.db, {
      platformCode,
      runId,
      account: handleName,
    });
    if (completed) {
      summary.skippedAccounts += 1;
      logger.info(`跳过已完成账号：${handleName}`);
      continue;
    }

    const { accountId } = await startScrapeRunAccount(handle.db, {
      platformCode,
      platformName: fetcher.name,
      runId,
      accountRow: {
        account: account.account,
        profileUrl: account.link,
        externalAccountId: account.externalAccountId,
      },
    });

    let postsFound = 0;
    let postsSaved = 0;
    let postsFailed = 0;

    try {
      const posts = await loadCommentPosts(handle, {
        accountId,
        windowSinceTsMs: input.windowSinceTsMs,
        windowUntilTsMs: input.windowUntilTsMs,
        includeZeroComments: options.includeZeroComments,
        limit: options.maxPostsPerAccount,
        contentIds: options.contentIds,
      });
      postsFound = posts.length;
      summary.posts += posts.length;
      if (!posts.length) summary.zeroPostAccounts.push(handleName);
      logger.info(`账号 ${handleName}：窗口内 ${posts.length} 个帖子`);
      await emitProgress(onProgress, { type: "account_start", account: handleName, posts: posts.length });

      for (const post of posts) {
        if (stop?.stopped) throw new RunInterruptedError();

        if (await isCommentPostDone(handle, runId, post.contentId)) {
          postsSaved += 1;
          continue;
        }

        if (await isCommentPostPermanentlyFailed(handle, runId, post.contentId)) {
          postsFailed += 1;
          summary.failedPosts += 1;
          logger.warn(`帖子 ${post.url || post.contentId} 上次为不可重试错误，跳过本次请求`);
          await emitProgress(onProgress, {
            type: "post_done",
            account: handleName,
            postId: post.contentId,
            comments: 0,
            inserted: 0,
            updated: 0,
            failed: true,
          });
          continue;
        }

        const postStartedAt = Date.now();
        let result;
        try {
          result = await fetcher.fetchComments({ post, client, options, logger });
        } catch (error) {
          if (error instanceof RunInterruptedError) throw error;
          if (isFatalTikHubError(error)) throw error;
          const message = truncateText(describeError(error), 1000);
          postsFailed += 1;
          summary.failedPosts += 1;
          await writeCommentPostProgress(handle, {
            runId,
            platformId,
            accountId,
            contentId: post.contentId,
            externalId: post.externalContentId,
            url: post.url,
            summary: {
              url: post.url,
              commentCount: post.commentCount,
              durationMs: Date.now() - postStartedAt,
            },
            errorMessage: message || "评论抓取失败",
            errorCode: commentFailureCode(message),
          });
          logger.error(`帖子 ${post.url || post.contentId} 评论抓取失败：${message}`);
          await emitProgress(onProgress, {
            type: "post_done",
            account: handleName,
            postId: post.contentId,
            comments: 0,
            inserted: 0,
            updated: 0,
            failed: true,
          });
          continue;
        }

        // 接口调用已经发生，统计先记上；即使后面入库失败，汇总也能反映真实请求数。
        summary.topLevelComments += result.stats.topLevelCount;
        summary.replyComments += result.stats.replyCount;
        summary.apiCalls += result.stats.apiCalls;
        if (result.stats.truncated) summary.truncatedPosts += 1;
        if (result.comments.length) summary.postsWithComments += 1;

        let written = { inserted: 0, updated: 0, skipped: 0 };
        try {
          written = await upsertComments(handle, {
            platformCode,
            contentId: post.contentId,
            accountId,
            runId,
            comments: result.comments,
          });
        } catch (error) {
          if (error instanceof RunInterruptedError || isFatalTikHubError(error)) throw error;
          const message = truncateText(`写入评论失败：${describeError(error)}`, 1000);
          postsFailed += 1;
          summary.failedPosts += 1;
          await writeCommentPostProgress(handle, {
            runId,
            platformId,
            accountId,
            contentId: post.contentId,
            externalId: post.externalContentId,
            url: post.url,
            summary: {
              url: post.url,
              commentCount: post.commentCount,
              topLevelCount: result.stats.topLevelCount,
              replyCount: result.stats.replyCount,
              apiCalls: result.stats.apiCalls,
              durationMs: Date.now() - postStartedAt,
            },
            errorMessage: message,
            errorCode: "COMMENT_SAVE_FAILED",
          });
          logger.error(`帖子 ${post.url || post.contentId} 评论入库失败：${message}`);
          await emitProgress(onProgress, {
            type: "post_done",
            account: handleName,
            postId: post.contentId,
            comments: result.comments.length,
            inserted: 0,
            updated: 0,
            failed: true,
          });
          continue;
        }

        summary.inserted += written.inserted;
        summary.updated += written.updated;
        summary.skippedComments += written.skipped;

        const durationMs = Date.now() - postStartedAt;
        const partialError = result.errors.length
          ? truncateText(result.errors.slice(0, 5).join(" | "), 1000)
          : null;
        await writeCommentPostProgress(handle, {
          runId,
          platformId,
          accountId,
          contentId: post.contentId,
          externalId: post.externalContentId,
          url: post.url,
          summary: {
            url: post.url,
            commentCount: post.commentCount,
            topLevelCount: result.stats.topLevelCount,
            replyCount: result.stats.replyCount,
            pages: result.stats.pages,
            replyPages: result.stats.replyPages,
            apiCalls: result.stats.apiCalls,
            truncated: result.stats.truncated,
            inserted: written.inserted,
            updated: written.updated,
            skipped: written.skipped,
            durationMs,
            ...(result.errors.length ? { errors: result.errors.slice(0, 5) } : {}),
          },
          errorMessage: partialError,
          errorCode: partialError ? commentFailureCode(partialError) : null,
        });

        if (partialError) {
          postsFailed += 1;
          summary.failedPosts += 1;
          logger.error(`帖子 ${post.url || post.contentId} 部分失败：${partialError}`);
        } else {
          postsSaved += 1;
        }
        await emitProgress(onProgress, {
          type: "post_done",
          account: handleName,
          postId: post.contentId,
          comments: result.comments.length,
          inserted: written.inserted,
          updated: written.updated,
          failed: Boolean(partialError),
        });
      }

      const accountError = postsFailed > 0
        ? `${postsFailed} 个帖子评论抓取失败（成功 ${postsSaved} / 共 ${postsFound}）`
        : null;
      const status = postsFailed === 0
        ? "success"
        : postsSaved === 0
          ? "failed"
          : "partial_failed";

      await finishRunAccount(handle.db, {
        runId,
        accountId,
        status,
        contentFoundCount: postsFound,
        contentSavedCount: postsSaved,
        failedContentCount: postsFailed,
        lastStep: status === "success" ? "comments_saved" : "comments_partial",
        errorCode: postsFailed > 0 ? "COMMENT_FETCH_FAILED" : null,
        errorMessage: accountError,
      });

      if (status === "success") summary.successAccounts += 1;
      else summary.failedAccounts += 1;
      logger.info(
        `账号 ${handleName} 完成：${status}，帖子 ${postsFound}，成功 ${postsSaved}，失败 ${postsFailed}`,
      );
      await emitProgress(onProgress, {
        type: "account_done",
        account: handleName,
        status,
        posts: postsFound,
        saved: postsSaved,
        failed: postsFailed,
      });
    } catch (error) {
      summary.failedAccounts += 1;
      const interrupted = error instanceof RunInterruptedError;
      const fatal = isFatalTikHubError(error);
      const message = truncateText(describeError(error), 1000);

      await finishRunAccount(handle.db, {
        runId,
        accountId,
        status: "failed",
        contentFoundCount: postsFound,
        contentSavedCount: postsSaved,
        failedContentCount: Math.max(postsFailed, postsFound - postsSaved),
        lastStep: interrupted ? "interrupted" : "comments_failed",
        errorCode: interrupted ? "INTERRUPTED" : "COMMENT_FETCH_FAILED",
        errorMessage: interrupted ? "收到中断信号，账号未完成" : message,
      }).catch(() => {});

      await emitProgress(onProgress, {
        type: "account_done",
        account: handleName,
        status: "failed",
        posts: postsFound,
        saved: postsSaved,
        failed: Math.max(postsFailed, postsFound - postsSaved),
      });

      if (interrupted || fatal) throw error;
      logger.error(`账号 ${handleName} 失败：${message}`);
    } finally {
      await refreshScrapeRunCounts(handle.db, runId).catch(() => {});
    }
  }

  summary.durationMs = Date.now() - startedAt;
  return summary;
}
