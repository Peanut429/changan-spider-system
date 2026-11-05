import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../factory.ts";
import { platforms, scrapeRunAccounts, socialAccounts } from "../schema.ts";
import { nowTsMs } from "../../core/db-time.ts";
import { prefixedId } from "../../core/id.ts";
import { ensureAccount } from "./accounts.ts";
import { ensurePlatform } from "./runs.ts";
import { errorCodeForMessage } from "../persistence/normalize.ts";

export async function isRunAccountCompleted(
  db: Database,
  {
    platformCode,
    runId,
    account,
  }: {
    platformCode: string;
    runId: string;
    account: string;
  },
): Promise<boolean> {
  const handle = String(account || "").trim();
  if (!handle) return false;

  const rows = await db
    .select({ id: scrapeRunAccounts.id })
    .from(scrapeRunAccounts)
    .innerJoin(socialAccounts, eq(socialAccounts.id, scrapeRunAccounts.accountId))
    .innerJoin(platforms, eq(platforms.id, socialAccounts.platformId))
    .where(and(
      eq(scrapeRunAccounts.runId, runId),
      eq(scrapeRunAccounts.status, "success"),
      eq(platforms.code, platformCode),
      eq(socialAccounts.handle, handle),
    ))
    .limit(1);

  return rows.length > 0;
}

export async function startScrapeRunAccount(
  db: Database,
  {
    platformCode,
    platformName,
    runId,
    accountRow,
  }: {
    platformCode: string;
    platformName: string;
    runId: string;
    accountRow: any;
  },
): Promise<{ accountId: string; runAccountId: string }> {
  const platformId = await ensurePlatform(db, { code: platformCode, name: platformName });
  const accountId = await ensureAccount(db, platformId, accountRow);
  const runAccountId = await startRunAccount(db, { runId, accountId });
  await refreshScrapeRunCounts(db, runId);
  return { accountId, runAccountId };
}

export async function startRunAccount(
  db: Database,
  {
    runId,
    accountId,
  }: {
    runId: string;
    accountId: string;
  },
): Promise<string> {
  const now = nowTsMs();
  const rows = await db
    .insert(scrapeRunAccounts)
    .values({
      id: prefixedId("racc"),
      runId,
      accountId,
      status: "running",
      startedTsMs: now,
      finishedTsMs: null,
      contentFoundCount: 0,
      contentSavedCount: 0,
      failedContentCount: 0,
      lastStep: "account_start",
      errorCode: null,
      errorMessage: null,
      createdTsMs: now,
    })
    .onConflictDoUpdate({
      target: [scrapeRunAccounts.runId, scrapeRunAccounts.accountId],
      set: {
        status: "running",
        startedTsMs: now,
        finishedTsMs: null,
        contentFoundCount: 0,
        contentSavedCount: 0,
        failedContentCount: 0,
        lastStep: "account_start",
        errorCode: null,
        errorMessage: null,
      },
    })
    .returning({ id: scrapeRunAccounts.id });

  return rows[0].id;
}

export async function finishRunAccount(
  db: Database,
  {
    runId,
    accountId,
    status,
    contentFoundCount,
    contentSavedCount,
    failedContentCount,
    lastStep,
    errorCode,
    errorMessage,
  }: {
    runId: string;
    accountId: string;
    status: "success" | "partial_failed" | "failed";
    contentFoundCount: number;
    contentSavedCount: number;
    failedContentCount: number;
    lastStep: string;
    errorCode?: string | null;
    errorMessage?: string | null;
  },
): Promise<void> {
  await db
    .update(scrapeRunAccounts)
    .set({
      status,
      finishedTsMs: nowTsMs(),
      contentFoundCount,
      contentSavedCount,
      failedContentCount,
      lastStep,
      errorCode: errorCode || errorCodeForMessage(errorMessage),
      errorMessage: errorMessage || null,
    })
    .where(and(
      eq(scrapeRunAccounts.runId, runId),
      eq(scrapeRunAccounts.accountId, accountId),
    ));
}

export async function refreshScrapeRunCounts(db: Database, runId: string): Promise<void> {
  await db.execute(sql`
    update scrape_runs
    set
      raw_record_count = (
        select count(*)::int
        from scrape_raw_records
        where run_id = ${runId}
      ),
      account_metric_count = (
        select count(*)::int
        from account_daily_metrics
        where run_id = ${runId}
      ),
      content_metric_count = (
        select count(*)::int
        from content_daily_metrics
        where run_id = ${runId}
      ),
      total_accounts = (
        select count(*)::int
        from scrape_run_accounts
        where run_id = ${runId}
      ),
      success_accounts = (
        select count(*)::int
        from scrape_run_accounts
        where run_id = ${runId} and status = 'success'
      ),
      failed_accounts = (
        select count(*)::int
        from scrape_run_accounts
        where run_id = ${runId} and status in ('failed', 'partial_failed')
      ),
      total_contents = coalesce((
        select sum(content_found_count)::int
        from scrape_run_accounts
        where run_id = ${runId}
      ), 0),
      success_contents = coalesce((
        select sum(content_saved_count)::int
        from scrape_run_accounts
        where run_id = ${runId}
      ), 0),
      failed_contents = coalesce((
        select sum(failed_content_count)::int
        from scrape_run_accounts
        where run_id = ${runId}
      ), 0)
    where id = ${runId}
  `);
}
