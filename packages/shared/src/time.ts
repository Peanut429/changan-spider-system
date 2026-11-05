// Change this one value to move date-range input, Excel display, and scrape timestamps together.
export const DEFAULT_TIME_ZONE = "Asia/Shanghai";
export const DEFAULT_DATE_RANGE_TIME_ZONE = DEFAULT_TIME_ZONE;
export const EXCEL_DISPLAY_TIME_ZONE = DEFAULT_TIME_ZONE;
export const TIME_ZONE_LABEL = DEFAULT_TIME_ZONE;
export const SHANGHAI_TIME_ZONE = DEFAULT_TIME_ZONE;

export type DateRangePosition = "before" | "inside" | "after" | "unknown";

export function todayInDisplayTimeZone(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: EXCEL_DISPLAY_TIME_ZONE });
}

export function nowInDisplayTimeZone(): string {
  return `${new Date().toLocaleString("sv-SE", {
    timeZone: EXCEL_DISPLAY_TIME_ZONE,
    hour12: false,
  })} ${TIME_ZONE_LABEL}`;
}

export function todayInShanghai(): string {
  return todayInDisplayTimeZone();
}

export function nowInShanghai(): string {
  return nowInDisplayTimeZone();
}

export function formatDateTimeText(value: unknown): string {
  const time = Date.parse(String(value || ""));
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleString("sv-SE", {
    timeZone: EXCEL_DISPLAY_TIME_ZONE,
    hour12: false,
  });
}

export function formatDateText(value: unknown): string {
  const time = typeof value === "number" ? value : Date.parse(String(value || ""));
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleDateString("sv-SE", { timeZone: EXCEL_DISPLAY_TIME_ZONE });
}

export function yearInDisplayTimeZone(value: unknown = new Date()): number {
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value || ""));
  if (!Number.isFinite(time)) return NaN;
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: EXCEL_DISPLAY_TIME_ZONE,
    year: "numeric",
  }).format(new Date(time)));
}

export function normalizeDateRangeTimeZone(value: unknown = DEFAULT_DATE_RANGE_TIME_ZONE): string {
  const raw = String(value || DEFAULT_DATE_RANGE_TIME_ZONE).trim();
  const normalized =
    /^(shanghai|asia\/shanghai|beijing|china)$/i.test(raw) ? "Asia/Shanghai" :
    /^(utc|z)$/i.test(raw) ? "UTC" :
    raw;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date());
    return normalized;
  } catch {
    throw new Error(`日期范围时区无效：${raw}`);
  }
}

function zonedParts(time: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(time));
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
    second: pick("second"),
  };
}

function zonedDateTimeToUtcTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
  timeZone: string,
): number {
  const wantedAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  let utc = wantedAsUtc;
  for (let i = 0; i < 3; i++) {
    const parts = zonedParts(utc, timeZone);
    const actualAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, millisecond);
    const next = wantedAsUtc - (actualAsUtc - utc);
    if (next === utc) break;
    utc = next;
  }
  return utc;
}

export function parseDateOnlyInTimeZone(dateText: string, timeZone = DEFAULT_DATE_RANGE_TIME_ZONE): number {
  const match = String(dateText || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return NaN;
  return parseDateTimeInTimeZone({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
    timeZone,
  });
}

function parseDateRangeBoundary(value: unknown, timeZone = DEFAULT_DATE_RANGE_TIME_ZONE): number {
  const source = String(value || "").trim();
  if (!source) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(source)) return parseDateOnlyInTimeZone(source, timeZone);
  const parsed = Date.parse(source);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function parseDateTimeInTimeZone({
  year,
  month,
  day,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
  timeZone = DEFAULT_DATE_RANGE_TIME_ZONE,
}: {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  millisecond?: number;
  timeZone?: string;
}): number {
  return zonedDateTimeToUtcTime(
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond,
    normalizeDateRangeTimeZone(timeZone),
  );
}

export function applyDateRange(args: Record<string, any>, timeZone: string = DEFAULT_DATE_RANGE_TIME_ZONE): void {
  const rangeTimeZone = normalizeDateRangeTimeZone(args.rangeTimeZone || args.timeZone || timeZone);
  if (args.month) {
    const match = String(args.month).match(/^(\d{4})-(\d{2})$/);
    if (!match) throw new Error("--month 必须是 YYYY-MM 格式，例如 2026-05");
    const year = Number(match[1]);
    const month = Number(match[2]);
    args.since = `${match[1]}-${match[2]}-01`;
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    args.until = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
    args.outputDate = args.month;
  }
  args.rangeTimeZone = rangeTimeZone;
  args.sinceTime = args.since ? parseDateRangeBoundary(args.since, rangeTimeZone) : null;
  args.untilTime = args.until ? parseDateRangeBoundary(args.until, rangeTimeZone) : null;
  if (args.since && !Number.isFinite(args.sinceTime)) throw new Error("--since 必须是 YYYY-MM-DD 或 ISO 时间格式");
  if (args.until && !Number.isFinite(args.untilTime)) throw new Error("--until 必须是 YYYY-MM-DD 或 ISO 时间格式");
  if (args.sinceTime != null && args.untilTime != null && args.sinceTime >= args.untilTime) {
    throw new Error("--since 必须早于 --until");
  }
}

export function dateRangePosition(publishTime: unknown, args: Record<string, any>, dateOnlyAsShanghai = false): DateRangePosition {
  if (typeof publishTime === "number" && Number.isFinite(publishTime)) {
    const time = publishTime < 100000000000 ? publishTime * 1000 : publishTime;
    if (args.sinceTime != null && time < args.sinceTime) return "before";
    if (args.untilTime != null && time >= args.untilTime) return "after";
    return "inside";
  }
  const source = String(publishTime || "").trim();
  const dateOnlyTimeZone = dateOnlyAsShanghai ? SHANGHAI_TIME_ZONE : args.rangeTimeZone || DEFAULT_DATE_RANGE_TIME_ZONE;
  const time = /^\d{4}-\d{2}-\d{2}$/.test(source)
    ? parseDateOnlyInTimeZone(source, dateOnlyTimeZone)
    : Date.parse(source);
  if (!Number.isFinite(time)) return "unknown";
  if (args.sinceTime != null && time < args.sinceTime) return "before";
  if (args.untilTime != null && time >= args.untilTime) return "after";
  return "inside";
}

export function isInDateRange(publishTime: unknown, args: Record<string, any>): boolean {
  if (args.sinceTime == null && args.untilTime == null) return true;
  return dateRangePosition(publishTime, args) === "inside";
}
