export function parseLocalizedNumber(value: unknown): number | "" {
  if (value == null) return "";
  let text = String(value).trim();
  if (!text || /^[-–—]$/.test(text)) return "";
  // 保留负数（例如 YouTube Shorts 点赞数「不适用」记为 -1），避免被下面的正则吞掉负号。
  if (/^-?\d+$/.test(text)) return Number(text);
  text = text.replace(/,/g, "").replace(/\s+/g, "");
  const match = text.match(/(\d+(?:\.\d+)?|\.\d+)(亿|万|千|billion|million|thousand|[kmb])?/i);
  if (!match) return "";
  const parsed = Number(match[1]);
  const unit = String(match[2] || "").toLowerCase();
  const multiplier =
    unit === "亿" ? 100000000 :
    unit === "万" ? 10000 :
    unit === "千" || unit === "thousand" || unit === "k" ? 1000 :
    unit === "million" || unit === "m" ? 1000000 :
    unit === "billion" || unit === "b" ? 1000000000 :
    1;
  return Number.isFinite(parsed) ? Math.round(parsed * multiplier) : "";
}
