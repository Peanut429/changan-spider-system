import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { openTestDatabase, resetTestDb, testDatabaseAvailable } from "../helpers/test-db.ts";
import { createScrapeRun, ensurePlatform, finalizeRunFromAccounts } from "../../src/db/repositories/runs.ts";
import { runPlatform } from "../../src/platforms/runner.ts";
import { createFakeScraper } from "../../src/platforms/fake/index.ts";
import {
  accountDailyMetrics,
  contentDailyMetrics,
  scrapeRawRecords,
  scrapeRunAccounts,
  scrapeRuns,
} from "../../src/db/schema.ts";

const hasTestDb = testDatabaseAvailable();
const skip = hasTestDb ? false : "缺少 TEST_DATABASE_URL";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const window = {
  sinceTsMs: Date.parse("2026-01-01T00:00:00.000Z"),
  untilTsMs: Date.parse("2026-01-01T23:59:59.999Z"),
  taskDateKey: 20260101,
};

async function createRun(handle: ReturnType<typeof openTestDatabase>): Promise<string> {
  const platformId = await ensurePlatform(handle.db, { code: "fake", name: "Fake" });
  return createScrapeRun(handle.db, {
    platformId,
    triggerType: "manual",
    windowSinceTsMs: window.sinceTsMs,
    windowUntilTsMs: window.untilTsMs,
    taskDateKey: window.taskDateKey,
    command: "test",
  });
}

test("fake 平台跑通：账号/内容/指标/raw/run 收口", { skip }, async () => {
  const handle = openTestDatabase();
  try {
    await resetTestDb(handle);
    const runId = await createRun(handle);

    await runPlatform({
      scraper: createFakeScraper(),
      ctx: {
        db: handle.db,
        runId,
        taskDateKey: window.taskDateKey,
        sinceTsMs: window.sinceTsMs,
        untilTsMs: window.untilTsMs,
        accountType: "总部",
        limit: 0,
        logger: silentLogger,
        browserOptions: { browserMode: "playwright" },
      },
      accounts: [{ account: "fake_account", link: "https://example.com/fake" }],
    });

    const status = await finalizeRunFromAccounts(handle.db, { runId, exitCode: 0 });
    assert.equal(status, "success");

    const [run] = await handle.db.select().from(scrapeRuns).where(eq(scrapeRuns.id, runId));
    assert.equal(run.status, "success");
    assert.equal(run.totalAccounts, 1);
    assert.equal(run.successAccounts, 1);
    assert.equal(run.accountMetricCount, 1);
    assert.equal(run.contentMetricCount, 1);
    assert.equal(run.rawRecordCount, 2);

    const [runAccount] = await handle.db
      .select()
      .from(scrapeRunAccounts)
      .where(eq(scrapeRunAccounts.runId, runId));
    assert.equal(runAccount.status, "success");
    assert.equal(runAccount.contentFoundCount, 1);
    assert.equal(runAccount.contentSavedCount, 1);

    const [accountMetric] = await handle.db
      .select()
      .from(accountDailyMetrics)
      .where(eq(accountDailyMetrics.runId, runId));
    assert.equal(accountMetric.metricDayKey, window.taskDateKey);
    assert.equal(accountMetric.followersCount, 1234);
    assert.equal(accountMetric.followingCount, 56);
    assert.equal(accountMetric.postsCount, 7);

    const [contentMetric] = await handle.db
      .select()
      .from(contentDailyMetrics)
      .where(eq(contentDailyMetrics.runId, runId));
    assert.equal(contentMetric.playCount, 100);
    assert.equal(contentMetric.likeCount, 10);
    assert.equal(contentMetric.commentCount, 2);

    const rawRows = await handle.db
      .select()
      .from(scrapeRawRecords)
      .where(eq(scrapeRawRecords.runId, runId));
    assert.equal(rawRows.length, 2);
    assert.deepEqual(
      rawRows.map((row) => row.recordType).sort(),
      ["account", "content"],
    );
  } finally {
    await handle.close();
  }
});

test("账号失败会落库，run 收口为 failed", { skip }, async () => {
  const handle = openTestDatabase();
  try {
    await resetTestDb(handle);
    const runId = await createRun(handle);

    await runPlatform({
      scraper: createFakeScraper(),
      ctx: {
        db: handle.db,
        runId,
        taskDateKey: window.taskDateKey,
        sinceTsMs: window.sinceTsMs,
        untilTsMs: window.untilTsMs,
        accountType: "总部",
        limit: 0,
        logger: silentLogger,
        browserOptions: { browserMode: "playwright" },
      },
      accounts: [{ account: "fail", link: "https://example.com/fail" }],
    });

    const status = await finalizeRunFromAccounts(handle.db, { runId, exitCode: 0 });
    assert.equal(status, "failed");

    const [runAccount] = await handle.db
      .select()
      .from(scrapeRunAccounts)
      .where(eq(scrapeRunAccounts.runId, runId));
    assert.equal(runAccount.status, "failed");
    assert.match(runAccount.errorMessage || "", /fake 平台按约定失败/);

    const [accountMetric] = await handle.db
      .select()
      .from(accountDailyMetrics)
      .where(eq(accountDailyMetrics.runId, runId));
    assert.equal(accountMetric.followersCount, null);
    assert.equal(accountMetric.errorCode, "SCRAPE_ERROR");
  } finally {
    await handle.close();
  }
});

test("一个成功一个失败：run 收口为 partial_failed", { skip }, async () => {
  const handle = openTestDatabase();
  try {
    await resetTestDb(handle);
    const runId = await createRun(handle);

    await runPlatform({
      scraper: createFakeScraper(),
      ctx: {
        db: handle.db,
        runId,
        taskDateKey: window.taskDateKey,
        sinceTsMs: window.sinceTsMs,
        untilTsMs: window.untilTsMs,
        accountType: "总部",
        limit: 0,
        logger: silentLogger,
        browserOptions: { browserMode: "playwright" },
      },
      accounts: [
        { account: "fake_account", link: "https://example.com/fake" },
        { account: "fail", link: "https://example.com/fail" },
      ],
    });

    const status = await finalizeRunFromAccounts(handle.db, { runId, exitCode: 0 });
    assert.equal(status, "partial_failed");

    const [run] = await handle.db.select().from(scrapeRuns).where(eq(scrapeRuns.id, runId));
    assert.equal(run.status, "partial_failed");
    assert.equal(run.totalAccounts, 2);
    assert.equal(run.successAccounts, 1);
    assert.equal(run.failedAccounts, 1);
  } finally {
    await handle.close();
  }
});
