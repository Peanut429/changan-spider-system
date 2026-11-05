import { eq, sql } from "drizzle-orm";
import type { Database } from "../factory.ts";
import { platforms, scrapeEventLogs, scrapeRunAccounts, scrapeRuns } from "../schema.ts";
import { prefixedId } from "../../core/id.ts";
import { nowTsMs } from "../../core/db-time.ts";

export type TriggerType = "scheduled" | "manual" | "retry" | "backfill";
export type RunStatus = "pending" | "running" | "success" | "partial_failed" | "failed" | "cancelled";

export type PlatformConfig = {
  code: string;
  name: string;
};

export async function ensurePlatform(db: Database, config: PlatformConfig): Promise<string> {
  const now = nowTsMs();
  const rows = await db
    .insert(platforms)
    .values({
      id: `plat-${config.code}`,
      code: config.code,
      name: config.name,
      enabled: true,
      createdTsMs: now,
    })
    .onConflictDoUpdate({
      target: platforms.code,
      set: {
        name: config.name,
        enabled: true,
      },
    })
    .returning({ id: platforms.id });
  return rows[0].id;
}

export async function createScrapeRun(
  db: Database,
  {
    platformId,
    triggerType,
    windowSinceTsMs,
    windowUntilTsMs,
    taskDateKey,
    command,
    parentRunId = null,
  }: {
    platformId: string;
    triggerType: TriggerType;
    windowSinceTsMs: number;
    windowUntilTsMs: number;
    taskDateKey: number;
    command: string;
    parentRunId?: string | null;
  },
): Promise<string> {
  const now = nowTsMs();
  const id = prefixedId("run");
  await db.insert(scrapeRuns).values({
    id,
    platformId,
    parentRunId,
    triggerType,
    status: "running",
    windowSinceTsMs,
    windowUntilTsMs,
    taskDateKey,
    startedTsMs: now,
    finishedTsMs: null,
    rawRecordCount: 0,
    accountMetricCount: 0,
    contentMetricCount: 0,
    eventLogCount: 0,
    totalAccounts: 0,
    successAccounts: 0,
    failedAccounts: 0,
    totalContents: 0,
    successContents: 0,
    failedContents: 0,
    command,
    errorCode: null,
    errorMessage: null,
    createdTsMs: now,
  });
  return id;
}

export async function setScrapeRunCommand(db: Database, runId: string, command: string): Promise<void> {
  await db.update(scrapeRuns).set({ command }).where(eq(scrapeRuns.id, runId));
}

export async function finishScrapeRun(
  db: Database,
  {
    runId,
    status,
    errorCode,
    errorMessage,
  }: {
    runId: string;
    status: RunStatus;
    errorCode?: string | null;
    errorMessage?: string | null;
  },
): Promise<void> {
  await db
    .update(scrapeRuns)
    .set({
      status,
      finishedTsMs: nowTsMs(),
      errorCode: errorCode || null,
      errorMessage: errorMessage || null,
    })
    .where(eq(scrapeRuns.id, runId));
}

export async function writeRunLog(
  db: Database,
  {
    runId,
    level,
    step,
    message,
    errorCode,
    errorStack,
    context,
  }: {
    runId: string;
    level: "debug" | "info" | "warn" | "error";
    step: string;
    message: string;
    errorCode?: string | null;
    errorStack?: string | null;
    context?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(scrapeEventLogs).values({
    id: prefixedId("log"),
    runId,
    accountRunId: null,
    attemptId: null,
    level,
    step,
    message: message.slice(0, 10000),
    pageUrl: null,
    contentUrl: null,
    selector: null,
    durationMs: null,
    errorCode: errorCode || null,
    errorStack: errorStack || null,
    contextJson: context || {},
    createdTsMs: nowTsMs(),
  });

  await db
    .update(scrapeRuns)
    .set({ eventLogCount: sql`${scrapeRuns.eventLogCount} + 1` })
    .where(eq(scrapeRuns.id, runId));
}

export type RunAccountCounts = {
  total: number;
  success: number;
  failed: number;
  incomplete: number;
};

export async function getRunAccountCounts(db: Database, runId: string): Promise<RunAccountCounts> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      success: sql<number>`count(*) filter (where status = 'success')::int`,
      failed: sql<number>`count(*) filter (where status in ('failed', 'partial_failed'))::int`,
    })
    .from(scrapeRunAccounts)
    .where(eq(scrapeRunAccounts.runId, runId));

  const total = row?.total ?? 0;
  const success = row?.success ?? 0;
  const failed = row?.failed ?? 0;
  return {
    total,
    success,
    failed,
    incomplete: Math.max(0, total - success - failed),
  };
}

/**
 * run 的最终状态由 daily 统一收口。
 *
 * 旧逻辑里平台脚本写一次、daily 又无条件写 success，会把 partial_failed 覆盖掉；
 * 这里改成只看 scrape_run_accounts 的最终统计。
 */
export async function finalizeRunFromAccounts(
  db: Database,
  {
    runId,
    exitCode,
    timedOut = false,
    errorMessage,
  }: {
    runId: string;
    exitCode: number | null;
    timedOut?: boolean;
    errorMessage?: string | null;
  },
): Promise<RunStatus> {
  if (timedOut) {
    await finishScrapeRun(db, {
      runId,
      status: "failed",
      errorCode: "PLATFORM_TIMEOUT",
      errorMessage: errorMessage || "平台执行超时",
    });
    return "failed";
  }

  if (exitCode !== 0) {
    await finishScrapeRun(db, {
      runId,
      status: "failed",
      errorCode: "PLATFORM_SCRIPT_FAILED",
      errorMessage: errorMessage || `平台脚本退出码：${exitCode}`,
    });
    return "failed";
  }

  const counts = await getRunAccountCounts(db, runId);
  const bad = counts.failed + counts.incomplete;

  if (counts.total === 0) {
    await finishScrapeRun(db, {
      runId,
      status: "failed",
      errorCode: "NO_ACCOUNTS",
      errorMessage: "平台没有处理任何账号",
    });
    return "failed";
  }

  if (bad >= counts.total) {
    await finishScrapeRun(db, {
      runId,
      status: "failed",
      errorCode: "ALL_ACCOUNTS_FAILED",
      errorMessage: `全部账号失败（${counts.failed} 失败 / ${counts.incomplete} 未完成）`,
    });
    return "failed";
  }

  if (bad > 0) {
    await finishScrapeRun(db, {
      runId,
      status: "partial_failed",
      errorCode: "PARTIAL_ACCOUNTS_FAILED",
      errorMessage: `部分账号失败（${counts.failed} 失败 / ${counts.incomplete} 未完成 / 共 ${counts.total}）`,
    });
    return "partial_failed";
  }

  await finishScrapeRun(db, { runId, status: "success" });
  return "success";
}
