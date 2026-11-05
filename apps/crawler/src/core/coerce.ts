import { parseLocalizedNumber } from "./numbers.ts";

export function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = parseLocalizedNumber(value);
  return parsed === "" || !Number.isFinite(parsed) ? null : parsed;
}

export function timestampOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 100000000000 ? value * 1000 : value;
  }
  const text = String(value || "").trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function textOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const text = value.trim();
    return text || null;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    const text = String(value).trim();
    return text || null;
  }
  if (value instanceof Date) {
    const text = value.toISOString().trim();
    return text || null;
  }
  if (Array.isArray(value)) {
    const text = value.map((item) => textOrNull(item)).filter(Boolean).join(" ").trim();
    return text || null;
  }
  if (typeof value === "object") {
    const candidate = (value as Record<string, unknown>).text
      ?? (value as Record<string, unknown>).plainText
      ?? (value as Record<string, unknown>).value
      ?? null;
    return textOrNull(candidate);
  }
  return null;
}
