import {
  dayKeyInTimeZone,
  endOfDayInTimeZone,
  scrapeWindowStartTsMs,
  yesterdayDayKeyInTimeZone,
} from "./db-time.ts";
import { parseDateOnlyInTimeZone } from "./time.ts";

export type DailyWindow = {
  windowSinceTsMs: number;
  windowUntilTsMs: number;
  taskDateKey: number;
  sinceDate: string;
  untilValue: string;
};

function parseUntilBoundary(until: string, timeZone: string): number {
  const value = String(until || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const dayKey = dayKeyInTimeZone(parseDateOnlyInTimeZone(value, timeZone), timeZone);
    return endOfDayInTimeZone(dayKey, timeZone);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("--until 必须是 YYYY-MM-DD 或 ISO 时间格式");
  return time;
}

/**
 * 从旧项目 daily-scrape.ts 原样复制，第一阶段不改 task_date_key 的计算逻辑。
 */
export function resolveDailyWindow(timeZone: string, until?: string): DailyWindow {
  const windowStart = process.env.SCRAPE_WINDOW_START || "2026-01-01";
  const windowSinceTsMs = scrapeWindowStartTsMs(windowStart, timeZone);

  const yesterday = new Date(new Date().valueOf() - 86400000);
  const targetTime = Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate());

  const windowUntilTsMs = until
    ? parseUntilBoundary(until, timeZone)
    : endOfDayInTimeZone(yesterdayDayKeyInTimeZone(timeZone), timeZone);
  const taskDateKey = dayKeyInTimeZone(until ? targetTime : windowUntilTsMs, timeZone);

  return {
    windowSinceTsMs,
    windowUntilTsMs,
    taskDateKey,
    sinceDate: windowStart,
    untilValue: new Date(windowUntilTsMs).toISOString(),
  };
}
