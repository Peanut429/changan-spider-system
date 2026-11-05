import { eq } from "drizzle-orm";
import type { Database } from "../factory.ts";
import { scrapeRuns } from "../schema.ts";
import { dayKeyInTimeZone } from "../../core/db-time.ts";

/**
 * 决定本次入库写入 account_daily_metrics / content_daily_metrics.metric_day_key 的值。
 *
 * 这段逻辑从旧项目原样复制，第一阶段不改：
 *   1) 显式传入的 taskDateKey
 *   2) 从 scrape_runs.task_date_key 反查
 *   3) 兜底：用当前时间按 SCRAPE_TIMEZONE 算 day_key
 */
export async function resolveMetricDayKey(
  db: Database,
  runId: string,
  taskDateKey?: number | null,
): Promise<number> {
  if (taskDateKey && Number.isInteger(taskDateKey) && taskDateKey >= 19000101 && taskDateKey <= 29991231) {
    return taskDateKey;
  }

  const [row] = await db
    .select({ taskDateKey: scrapeRuns.taskDateKey })
    .from(scrapeRuns)
    .where(eq(scrapeRuns.id, runId))
    .limit(1);

  if (row?.taskDateKey && Number.isInteger(row.taskDateKey) && row.taskDateKey >= 19000101 && row.taskDateKey <= 29991231) {
    return row.taskDateKey;
  }

  return dayKeyInTimeZone(Date.now(), process.env.SCRAPE_TIMEZONE || "Asia/Shanghai");
}
