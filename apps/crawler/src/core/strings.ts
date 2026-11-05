export function sanitizeCellText(value: unknown): string {
  const input = String(value ?? "");
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x9 || code === 0xa || code === 0xd) {
      out += ch;
    } else if (code >= 0x20 && code <= 0xd7ff) {
      out += ch;
    } else if (code >= 0xe000 && code <= 0xfffd) {
      out += ch;
    } else if (code >= 0x10000 && code <= 0x10ffff) {
      out += ch;
    }
  }
  return out;
}

// 按 UTF-16 长度截断，但不能把 emoji 等代理对切成半个。
// 半个代理对经 JSON.stringify 会变成 "\ud83d" 这种孤立代理转义，
// PostgreSQL 的 jsonb 会直接拒绝（Unicode low surrogate must follow a high surrogate），
// 导致 scrape_raw_records 写入失败、整个账号/平台任务中断。
export function truncateText(value: unknown, maxLength: number): string {
  const text = String(value ?? "");
  if (!Number.isFinite(maxLength) || maxLength <= 0) return "";
  if (text.length <= maxLength) return text;
  let end = Math.floor(maxLength);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

export function normalizeAccountKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function sheetName(value: unknown, used: Set<string>): string {
  const raw = sanitizeCellText(value || "内容")
    .replace(/[\[\]:*?/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "内容";
  const base = raw.slice(0, 31);
  let candidate = base;
  let index = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` ${index}`;
    candidate = `${base.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`;
    index += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}
