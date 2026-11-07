// YouTube 页面抓取与 HTTP 抓取共用的纯解析函数。
import { formatDateText } from "../../core/time.ts";

export function parseLocalizedNumber(value) {
  if (value == null) return null;
  let text = String(value).trim();
  if (!text) return null;
  text = text.replace(/,/g, "").replace(/\s+/g, "");
  const match = text.match(/(\d+(?:\.\d+)?|\.\d+)(亿|万|千|billion|million|thousand|[kmb])?/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  const unit = String(match[2] || "").toLowerCase();
  const multiplier =
    unit === "亿" ? 100000000 :
    unit === "万" ? 10000 :
    unit === "千" || unit === "thousand" || unit === "k" ? 1000 :
    unit === "million" || unit === "m" ? 1000000 :
    unit === "billion" || unit === "b" ? 1000000000 :
    1;
  return Number.isFinite(parsed) ? Math.round(parsed * multiplier) : null;
}

export function extractExactViewCount(text) {
  const source = String(text || "").trim();
  if (!source) return "";
  const match = source.match(/([0-9][\d,.\s]*)\s*(?:次观看|views?)/i);
  if (!match) return "";
  const digits = match[1].replace(/[^\d]/g, "");
  return digits || "";
}

export function normalizeExactViewCount(value) {
  const source = String(value || "").trim();
  if (/^\d+$/.test(source)) return source;
  return extractExactViewCount(source);
}

export function parseYouTubeDateText(text) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (!source) return "";

  const iso = source.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return `${iso[1]}-${String(Number(iso[2])).padStart(2, "0")}-${String(Number(iso[3])).padStart(2, "0")}`;

  const zh = source.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (zh) return `${zh[1]}-${String(Number(zh[2])).padStart(2, "0")}-${String(Number(zh[3])).padStart(2, "0")}`;

  const slash = source.match(/\b(\d{4})\/(\d{1,2})\/(\d{1,2})\b/);
  if (slash) return `${slash[1]}-${String(Number(slash[2])).padStart(2, "0")}-${String(Number(slash[3])).padStart(2, "0")}`;

  const chunks = source.split(/\s*[•|]\s*/).map((s) => s.trim()).filter(Boolean);
  for (const chunk of chunks.length ? chunks : [source]) {
    if (/观看|views?|#/.test(chunk)) continue;
    const cleaned = chunk
      .replace(/^(?:published|premiered|streamed live on|uploaded|发布于|首播开始于|直播开始于)\s*:?\s*/i, "")
      .trim();
    const time = Date.parse(cleaned);
    if (Number.isFinite(time)) return formatDateText(time);
  }
  return "";
}

export function extractListRelativePublished(listText) {
  const lines = String(listText || "").split("\n").map((s) => s.trim()).filter(Boolean);
  return lines.find((s) => /前$|ago$/i.test(s)) || "";
}

export function approxRelativePublishedTime(text, now = Date.now()) {
  const source = String(text || "").trim().toLowerCase();
  if (!source) return null;
  if (/刚刚|just now|seconds? ago/.test(source)) return now;
  if (/昨天|yesterday/.test(source)) return now - 24 * 60 * 60 * 1000;

  const match = source.match(/(\d+(?:\.\d+)?)\s*(秒|分钟|小时|天|周|星期|个月|月|年|seconds|secs|sec|second|minutes|mins|min|minute|hours|hrs|hr|hour|days|day|weeks|wks|wk|week|months|mos|mo|month|years|yrs|yr|year|s|d|w|h|y)/i);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const unit = match[2].toLowerCase();
  const day = 24 * 60 * 60 * 1000;
  const multiplier =
    /^(秒|second|seconds|sec|secs|s)$/.test(unit) ? 1000 :
    /^(分钟|minute|minutes|min|mins)$/.test(unit) ? 60 * 1000 :
    /^(小时|hour|hours|hr|hrs|h)$/.test(unit) ? 60 * 60 * 1000 :
    /^(天|day|days|d)$/.test(unit) ? day :
    /^(周|星期|week|weeks|wk|wks|w)$/.test(unit) ? 7 * day :
    /^(个月|月|month|months|mo|mos)$/.test(unit) ? 30 * day :
    /^(年|year|years|yr|yrs|y)$/.test(unit) ? 365 * day :
    0;
  return multiplier ? now - n * multiplier : null;
}

export function approxRelativePublishedRange(text, now = Date.now()) {
  const source = String(text || "").trim().toLowerCase();
  if (!source) return null;
  if (/刚刚|just now|seconds? ago/.test(source)) return { earliest: now - 60 * 1000, latest: now };
  if (/昨天|yesterday/.test(source)) {
    const day = 24 * 60 * 60 * 1000;
    return { earliest: now - 2 * day, latest: now - day };
  }

  const match = source.match(/(\d+(?:\.\d+)?)\s*(秒|分钟|小时|天|周|星期|个月|月|年|seconds|secs|sec|second|minutes|mins|min|minute|hours|hrs|hr|hour|days|day|weeks|wks|wk|week|months|mos|mo|month|years|yrs|yr|year|s|d|w|h|y)/i);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const unit = match[2].toLowerCase();
  const day = 24 * 60 * 60 * 1000;
  const multiplier =
    /^(秒|second|seconds|sec|secs|s)$/.test(unit) ? 1000 :
    /^(分钟|minute|minutes|min|mins)$/.test(unit) ? 60 * 1000 :
    /^(小时|hour|hours|hr|hrs|h)$/.test(unit) ? 60 * 60 * 1000 :
    /^(天|day|days|d)$/.test(unit) ? day :
    /^(周|星期|week|weeks|wk|wks|w)$/.test(unit) ? 7 * day :
    /^(个月|月|month|months|mo|mos)$/.test(unit) ? 30 * day :
    /^(年|year|years|yr|yrs|y)$/.test(unit) ? 365 * day :
    0;
  if (!multiplier) return null;
  return {
    earliest: now - (n + 1) * multiplier,
    latest: now - n * multiplier,
  };
}

export function approxRelativePublishedDate(text) {
  const time = approxRelativePublishedTime(text);
  if (time == null) return "";
  return formatDateText(time);
}

export function secondsToDuration(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return "";
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
