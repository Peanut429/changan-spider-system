import { parseDateOnlyInTimeZone, parseDateTimeInTimeZone } from "./time.ts";

export function nowTsMs(): number {
  return Date.now();
}

/**
 * 业务时区下的 day_key，格式 YYYYMMDD 整数，例如 20260623。
 * 用作 scrape_runs.task_date_key / account_daily_metrics.metric_day_key / content_daily_metrics.metric_day_key 的值。
 *
 * 跟 PG 列保持 integer 类型（YYYYMMDD），跟"用字符串"在功能上完全等价：
 *   - 等值：where day_key = 20260623
 *   - 范围：where day_key between 20260601 and 20260630  ✓ 数值序与日期序一致
 *   - 排序：order by day_key desc                         ✓ 数值序就是日期序
 *   - 索引：b-tree 索引正常使用
 */
export function dayKeyInTimeZone(time: number | Date = Date.now(), timeZone = "Asia/Shanghai"): number {
  // sv-SE 输出 YYYY-MM-DD，去掉连字符再转 number
  const text = new Date(time).toLocaleDateString("sv-SE", { timeZone }).replace(/-/g, "");
  return Number(text);
}

export function dateTextInTimeZone(time = Date.now(), timeZone = "Asia/Shanghai"): number {
  return dayKeyInTimeZone(time, timeZone);
}

export function scrapeWindowStartTsMs(dateText: string, timeZone = "Asia/Shanghai"): number {
  const time = parseDateOnlyInTimeZone(dateText, timeZone);
  if (!Number.isFinite(time)) throw new Error(`SCRAPE_WINDOW_START 无效：${dateText}`);
  return time;
}

/**
 * 给定业务时区下某天（YYYYMMDD 整数，例如 20260623）的最后一毫秒（23:59:59.999）的 UTC 毫秒。
 * 用于把"业务日"严格收敛到当天 23:59:59.999。
 */
export function endOfDayInTimeZone(dayKey: number, timeZone = "Asia/Shanghai"): number {
  const text = String(dayKey || "").padStart(8, "0");
  const match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) throw new Error(`day_key 格式无效（需要 YYYYMMDD 整数）：${dayKey}`);
  return parseDateTimeInTimeZone({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: 23,
    minute: 59,
    second: 59,
    millisecond: 999,
    timeZone,
  });
}

/**
 * 在业务时区里返回"昨天"的 YYYYMMDD dayKey（整数）。
 * 例：Asia/Shanghai 在 6-24 凌晨 0~8 点仍算业务时区 6-24 的"今天"，
 * 所以 yesterday = 20260623。
 */
export function yesterdayDayKeyInTimeZone(timeZone = "Asia/Shanghai"): number {
  const today = dayKeyInTimeZone(Date.now(), timeZone);
  // 把 YYYYMMDD 整数拆开当日期算
  const year = Math.floor(today / 10000);
  const month = Math.floor((today % 10000) / 100);
  const day = today % 100;
  const todayMs = parseDateTimeInTimeZone({ year, month, day, timeZone });
  const yesterday = new Date(todayMs - 24 * 60 * 60 * 1000);
  return dayKeyInTimeZone(yesterday, timeZone);
}
