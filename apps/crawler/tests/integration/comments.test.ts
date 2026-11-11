import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { openTestDatabase, resetTestDb, testDatabaseAvailable } from "../helpers/test-db.ts";
import { createScrapeRun, ensurePlatform, finalizeRunFromAccounts } from "../../src/db/repositories/runs.ts";
import { ensureAccount } from "../../src/db/repositories/accounts.ts";
import { runCommentPlatform } from "../../src/comments/runner.ts";
import { loadCommentPosts } from "../../src/comments/posts.ts";
import type { CommentFetcher, CommentFetchOptions, CommentFetchResult, CommentPost } from "../../src/comments/types.ts";
import {
  comments,
  contentDailyMetrics,
  scrapeRawRecords,
  scrapeRunAccounts,
  scrapeRuns,
  socialContents,
} from "../../src/db/schema.ts";

const hasTestDb = testDatabaseAvailable();
const skip = hasTestDb ? false : "缺少 TEST_DATABASE_URL";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

const windowSinceTsMs = Date.parse("2026-01-01T00:00:00.000Z");
const windowUntilTsMs = Date.parse("2026-01-31T23:59:59.999Z");
const publishTsMs = Date.parse("2026-01-10T00:00:00.000Z");

function options(overrides: Partial<CommentFetchOptions> = {}): CommentFetchOptions & {
  includeZeroComments: boolean;
  maxPostsPerAccount: number;
} {
  return {
    includeReplies: true,
    maxPagesPerPost: 10,
    maxReplyPagesPerComment: 3,
    maxRepliesPerComment: 50,
    maxCommentsPerPost: 500,
    includeZeroComments: false,
    maxPostsPerAccount: 0,
    ...overrides,
  };
}

function stats(overrides: Partial<CommentFetchResult["stats"]> = {}): CommentFetchResult["stats"] {
  return {
    topLevelCount: 0,
    replyCount: 0,
    pages: 1,
    replyPages: 0,
    apiCalls: 1,
    truncated: false,
    ...overrides,
  };
}

function topComment(id: string, likeCount = 1) {
  return {
    id,
    userId: "u1",
    username: "alice",
    text: `comment ${id}`,
    createdAtTsMs: 1700000000000,
    likeCount,
    replyCount: 1,
    parentCommentId: null,
    rootCommentId: null,
  };
}

function replyComment(id: string, parentId: string) {
  return {
    id,
    userId: "u2",
    username: "bob",
    text: `reply ${id}`,
    createdAtTsMs: 1700000100000,
    likeCount: 0,
    replyCount: 0,
    parentCommentId: parentId,
    rootCommentId: parentId,
  };
}

function stubFetcher(
  handler: (post: CommentPost) => CommentFetchResult | Promise<CommentFetchResult>,
): CommentFetcher & { calls: CommentPost[] } {
  const calls: CommentPost[] = [];
  const fetcher: CommentFetcher & { calls: CommentPost[] } = {
    code: "youtube",
    name: "YouTube",
    calls,
    fetchComments: async ({ post }) => {
      calls.push(post);
      return handler(post);
    },
  };
  return fetcher;
}

async function seed(handle: ReturnType<typeof openTestDatabase>) {
  await resetTestDb(handle);
  const platformId = await ensurePlatform(handle.db, { code: "youtube", name: "YouTube" });
  const accountId = await ensureAccount(handle.db, platformId, {
    account: "test_channel",
    profileUrl: "https://www.youtube.com/@test_channel",
  });
  const runId = await createScrapeRun(handle.db, {
    platformId,
    triggerType: "manual",
    windowSinceTsMs,
    windowUntilTsMs,
    taskDateKey: 20260110,
    command: "test",
  });

  const contents = [
    { id: "cont-1", externalContentId: "video-1", url: "https://www.youtube.com/watch?v=video-1", commentCount: 5 },
    { id: "cont-2", externalContentId: "video-2", url: "https://www.youtube.com/watch?v=video-2", commentCount: 2 },
  ];
  for (const content of contents) {
    await handle.db.insert(socialContents).values({
      id: content.id,
      platformId,
      accountId,
      externalContentId: content.externalContentId,
      url: content.url,
      contentType: "video",
      publishTsMs,
      firstSeenTsMs: publishTsMs,
      lastSeenTsMs: publishTsMs,
      title: content.id,
      contentSummary: null,
      excerptFetchStatus: "fetched",
      createdTsMs: publishTsMs,
      updatedTsMs: publishTsMs,
    });
    await handle.db.insert(contentDailyMetrics).values({
      id: `cm-${content.id}`,
      contentId: content.id,
      accountId,
      platformId,
      runId,
      metricDayKey: 20260110,
      capturedTsMs: publishTsMs,
      commentCount: content.commentCount,
      rawMetricJson: {},
      createdTsMs: publishTsMs,
    });
  }

  return { platformId, accountId, runId };
}

const accounts = [{ id: "unused", account: "test_channel", link: "https://www.youtube.com/@test_channel" }];
const dummyClient = { baseUrl: "http://stub", getJson: async () => ({}) };

async function runOnce(
  handle: ReturnType<typeof openTestDatabase>,
  platformId: string,
  runId: string,
  fetcher: CommentFetcher,
  fetcherOptions = options(),
) {
  return runCommentPlatform({
    handle,
    runId,
    platformId,
    platformCode: "youtube",
    fetcher,
    accounts,
    client: dummyClient,
    windowSinceTsMs,
    windowUntilTsMs,
    options: fetcherOptions,
    logger: silentLogger,
  });
}

test("评论任务：入库、父子关系、raw 进度、run 收口", { skip }, async () => {
  const handle = openTestDatabase();
  try {
    const { platformId, runId } = await seed(handle);
    const fetcher = stubFetcher((post) => ({
      comments: post.externalContentId === "video-1" ? [topComment("c1"), replyComment("r1", "c1")] : [],
      stats: post.externalContentId === "video-1"
        ? stats({ topLevelCount: 1, replyCount: 1, apiCalls: 2, replyPages: 1 })
        : stats(),
      errors: [],
    }));

    const summary = await runOnce(handle, platformId, runId, fetcher);
    assert.equal(summary.posts, 2);
    assert.equal(summary.topLevelComments, 1);
    assert.equal(summary.replyComments, 1);
    assert.equal(summary.inserted, 2);
    assert.equal(fetcher.calls.length, 2);

    const rows = await handle.db.select().from(comments).orderBy(comments.id);
    assert.equal(rows.length, 2);
    const top = rows.find((row) => row.id === "c1")!;
    const reply = rows.find((row) => row.id === "r1")!;
    assert.equal(top.platform, "youtube");
    assert.equal(top.contentId, "cont-1");
    assert.equal(top.parentCommentId, null);
    assert.equal(top.likeCount, 1);
    assert.equal(top.runId, runId);
    assert.equal(reply.parentCommentId, "c1");
    assert.equal(reply.rootCommentId, "c1");
    assert.equal(top.firstSeenTsMs, top.lastSeenTsMs);

    const raw = await handle.db
      .select()
      .from(scrapeRawRecords)
      .where(eq(scrapeRawRecords.recordType, "comment_post"));
    assert.equal(raw.length, 2);
    assert.equal(raw.every((row) => row.errorCode === null), true);

    const [runAccount] = await handle.db
      .select()
      .from(scrapeRunAccounts)
      .where(eq(scrapeRunAccounts.runId, runId));
    assert.equal(runAccount.status, "success");
    assert.equal(runAccount.contentFoundCount, 2);
    assert.equal(runAccount.contentSavedCount, 2);

    const status = await finalizeRunFromAccounts(handle.db, { runId, exitCode: 0 });
    assert.equal(status, "success");
    const [run] = await handle.db.select().from(scrapeRuns).where(eq(scrapeRuns.id, runId));
    assert.equal(run.status, "success");
    assert.equal(run.totalAccounts, 1);
    assert.equal(run.rawRecordCount, 2);

    // 同一 run 再跑：账号已完成，直接跳过，不再请求评论接口。
    const callsBefore = fetcher.calls.length;
    await runOnce(handle, platformId, runId, fetcher);
    assert.equal(fetcher.calls.length, callsBefore);
  } finally {
    await handle.close();
  }
});

test("评论任务：新 run 重跑幂等，更新点赞但不新增行", { skip }, async () => {
  const handle = openTestDatabase();
  try {
    const { platformId, runId } = await seed(handle);
    const fetcher = stubFetcher((post) => ({
      comments: post.externalContentId === "video-1" ? [topComment("c1", 1), replyComment("r1", "c1")] : [],
      stats: post.externalContentId === "video-1"
        ? stats({ topLevelCount: 1, replyCount: 1 })
        : stats(),
      errors: [],
    }));
    await runOnce(handle, platformId, runId, fetcher);
    await finalizeRunFromAccounts(handle.db, { runId, exitCode: 0 });

    const runId2 = await createScrapeRun(handle.db, {
      platformId,
      triggerType: "manual",
      windowSinceTsMs,
      windowUntilTsMs,
      taskDateKey: 20260110,
      command: "test-2",
    });
    const second = stubFetcher((post) => ({
      comments: post.externalContentId === "video-1" ? [topComment("c1", 99), replyComment("r1", "c1")] : [],
      stats: post.externalContentId === "video-1"
        ? stats({ topLevelCount: 1, replyCount: 1 })
        : stats(),
      errors: [],
    }));
    const summary = await runOnce(handle, platformId, runId2, second);
    assert.equal(summary.inserted, 0);
    assert.equal(summary.updated, 2);

    const rows = await handle.db.select().from(comments).orderBy(comments.id);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.id === "c1")?.likeCount, 99);
  } finally {
    await handle.close();
  }
});

test("评论任务：部分帖子失败 → 账号 partial_failed、run 按既有语义收口", { skip }, async () => {
  const handle = openTestDatabase();
  try {
    const { platformId, runId } = await seed(handle);
    const fetcher = stubFetcher((post) => {
      if (post.externalContentId === "video-1") throw new Error("video-1 api down");
      return {
        comments: [topComment("c2")],
        stats: stats({ topLevelCount: 1 }),
        errors: [],
      };
    });

    const summary = await runOnce(handle, platformId, runId, fetcher);
    assert.equal(summary.failedPosts, 1);
    assert.equal(summary.inserted, 1);

    const [runAccount] = await handle.db
      .select()
      .from(scrapeRunAccounts)
      .where(eq(scrapeRunAccounts.runId, runId));
    assert.equal(runAccount.status, "partial_failed");
    assert.equal(runAccount.contentFoundCount, 2);
    assert.equal(runAccount.contentSavedCount, 1);
    assert.equal(runAccount.failedContentCount, 1);

    const raw = await handle.db
      .select()
      .from(scrapeRawRecords)
      .where(eq(scrapeRawRecords.recordType, "comment_post"));
    assert.equal(raw.length, 2);
    assert.equal(raw.filter((row) => row.errorCode !== null).length, 1);

    // finalizeRunFromAccounts 的既有语义：一个账号时，partial 也算 failed。
    const status = await finalizeRunFromAccounts(handle.db, { runId, exitCode: 0 });
    assert.equal(status, "failed");
  } finally {
    await handle.close();
  }
});

test("评论任务：同一 run 内失败帖子可续跑，成功帖子跳过", { skip }, async () => {
  const handle = openTestDatabase();
  try {
    const { platformId, runId } = await seed(handle);
    let failVideo1 = true;
    const fetcher = stubFetcher((post) => {
      if (post.externalContentId === "video-1" && failVideo1) throw new Error("temporary");
      return {
        comments: [topComment(post.externalContentId === "video-1" ? "c1" : "c2")],
        stats: stats({ topLevelCount: 1 }),
        errors: [],
      };
    });

    await runOnce(handle, platformId, runId, fetcher);
    // 账号是 partial_failed，不满足 isRunAccountCompleted；重跑会进入账号，
    // 但 video-2 已有成功进度行，应跳过，只重试 video-1。
    failVideo1 = false;
    const callsBefore = fetcher.calls.length;
    await runOnce(handle, platformId, runId, fetcher);
    const newCalls = fetcher.calls.slice(callsBefore).map((post) => post.externalContentId);
    assert.deepEqual(newCalls, ["video-1"]);

    const [runAccount] = await handle.db
      .select()
      .from(scrapeRunAccounts)
      .where(eq(scrapeRunAccounts.runId, runId));
    assert.equal(runAccount.status, "success");
    assert.equal(runAccount.failedContentCount, 0);
  } finally {
    await handle.close();
  }
});

test("评论任务：只读 comment_count>0 的帖子，includeZeroComments 可放开", { skip }, async () => {
  const handle = openTestDatabase();
  try {
    const { platformId, accountId } = await seed(handle);
    await handle.db.insert(socialContents).values({
      id: "cont-3",
      platformId,
      accountId,
      externalContentId: "video-3",
      url: "https://www.youtube.com/watch?v=video-3",
      contentType: "video",
      publishTsMs,
      firstSeenTsMs: publishTsMs,
      lastSeenTsMs: publishTsMs,
      title: "cont-3",
      contentSummary: null,
      excerptFetchStatus: "fetched",
      createdTsMs: publishTsMs,
      updatedTsMs: publishTsMs,
    });
    await handle.db.insert(contentDailyMetrics).values({
      id: "cm-cont-3",
      contentId: "cont-3",
      accountId,
      platformId,
      runId: "run-seed",
      metricDayKey: 20260110,
      capturedTsMs: publishTsMs,
      commentCount: 0,
      rawMetricJson: {},
      createdTsMs: publishTsMs,
    });

    const filtered = await loadCommentPosts(handle, {
      accountId,
      windowSinceTsMs,
      windowUntilTsMs,
      includeZeroComments: false,
    });
    assert.deepEqual(filtered.map((row) => row.externalContentId).sort(), ["video-1", "video-2"]);

    const all = await loadCommentPosts(handle, {
      accountId,
      windowSinceTsMs,
      windowUntilTsMs,
      includeZeroComments: true,
    });
    assert.deepEqual(all.map((row) => row.externalContentId).sort(), ["video-1", "video-2", "video-3"]);
  } finally {
    await handle.close();
  }
});

test("评论任务：跨平台评论 ID 撞车时不覆盖旧行", { skip }, async () => {
  const handle = openTestDatabase();
  try {
    const { platformId, runId } = await seed(handle);
    // 先放一条同 ID 的 Instagram 评论，模拟跨平台撞车。
    await handle.db.insert(comments).values({
      id: "c1",
      username: "legacy",
      userId: "legacy-user",
      textContent: "legacy comment",
      platform: "instagram",
      contentId: "cont-legacy",
      createTimestamp: 1,
    });

    const fetcher = stubFetcher((post) => ({
      comments: post.externalContentId === "video-1" ? [topComment("c1")] : [],
      stats: post.externalContentId === "video-1" ? stats({ topLevelCount: 1 }) : stats(),
      errors: [],
    }));
    const summary = await runOnce(handle, platformId, runId, fetcher);
    assert.equal(summary.inserted, 0);
    assert.equal(summary.updated, 0);
    assert.equal(summary.skippedComments, 1);

    const [legacy] = await handle.db.select().from(comments).where(eq(comments.id, "c1"));
    assert.equal(legacy.platform, "instagram");
    assert.equal(legacy.textContent, "legacy comment");
  } finally {
    await handle.close();
  }
});
