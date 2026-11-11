import { endOfDayInTimeZone, scrapeWindowStartTsMs } from "./db-time.ts";
import { DEFAULT_TIME_ZONE } from "./time.ts";

/**
 * 评论任务的时间窗口。
 *
 * 和每日任务不同，评论任务通常一次跑一整个自然月：
 *   --since 2026-10-01 --until 2026-10-31
 *   或 --last-month（按业务时区取上个月整月，cron 用）
 *
 * 语义与 Web 建任务一致：since 是当天 00:00:00.000，until 是当天 23:59:59.999。
 */

export type CommentWindow = {
  sinceText: string;
  untilText: string;
  sinceTsMs: number;
  untilTsMs: number;
  source: "range" | "last-month";
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** YYYY-MM-DD 的格式 + 日历有效性（拒绝 2026-02-30 / 2026-13-01）。 */
function isValidDateText(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function yearMonthInTimeZone(now: number, timeZone: string): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(now));
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  const year = pick("year");
  const month = pick("month");
  if (!Number.isInteger(year) || !Number.isInteger(month)) {
    throw new Error(`无法按 ${timeZone} 解析当前年月`);
  }
  return { year, month };
}

/**
 * 业务时区下"上个月"的第一天和最后一天（YYYY-MM-DD）。
 * 例：2026-01-05 调用 → 2025-12-01 ~ 2025-12-31。
 */
export function lastMonthRange(
  now: number = Date.now(),
  timeZone: string = DEFAULT_TIME_ZONE,
): { sinceText: string; untilText: string } {
  const current = yearMonthInTimeZone(now, timeZone);
  let year = current.year;
  let month = current.month - 1;
  if (month === 0) {
    month = 12;
    year -= 1;
  }
  // 下个月的第 0 天 = 本月最后一天；用 UTC 算，避免本地时区影响。
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    sinceText: `${year}-${pad2(month)}-01`,
    untilText: `${year}-${pad2(month)}-${pad2(daysInMonth)}`,
  };
}

/**
 * 解析评论任务窗口。lastMonth 与 since/until 互斥；
 * 两者都不给时报错，避免误跑。
 */
export function resolveCommentWindow({
  since,
  until,
  lastMonth = false,
  now = Date.now(),
  timeZone = DEFAULT_TIME_ZONE,
}: {
  since?: string | null;
  until?: string | null;
  lastMonth?: boolean;
  now?: number;
  timeZone?: string;
}): CommentWindow {
  const sinceRaw = String(since || "").trim();
  const untilRaw = String(until || "").trim();

  if (lastMonth && (sinceRaw || untilRaw)) {
    throw new Error("--last-month 不能和 --since/--until 同时使用");
  }

  let sinceText: string;
  let untilText: string;
  let source: CommentWindow["source"];

  if (lastMonth) {
    const range = lastMonthRange(now, timeZone);
    sinceText = range.sinceText;
    untilText = range.untilText;
    source = "last-month";
  } else {
    if (!sinceRaw || !untilRaw) {
      throw new Error("必须提供 --since/--until，或使用 --last-month");
    }
    if (!isValidDateText(sinceRaw) || !isValidDateText(untilRaw)) {
      throw new Error("--since/--until 必须是有效的 YYYY-MM-DD 日期");
    }
    if (sinceRaw > untilRaw) {
      throw new Error("--since 不能晚于 --until");
    }
    sinceText = sinceRaw;
    untilText = untilRaw;
    source = "range";
  }

  return {
    sinceText,
    untilText,
    sinceTsMs: scrapeWindowStartTsMs(sinceText, timeZone),
    untilTsMs: endOfDayInTimeZone(Number(untilText.replace(/-/g, "")), timeZone),
    source,
  };
}
