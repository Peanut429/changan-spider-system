import { textOrNull } from "../../core/coerce.ts";

export function contentExternalId(row: any): string | null {
  return textOrNull(
    row.externalContentId ||
    row.tweetId ||
    row.postId ||
    row.activityId ||
    row.videoId ||
    row.shortcode ||
    row.mediaId ||
    row.pk ||
    row.id ||
    row.url,
  );
}

export function contentUrl(row: any): string | null {
  return textOrNull(row.url || row.postUrl || row.link);
}

export function contentTitle(row: any): string | null {
  return textOrNull(row.title || row.videoTitle || row.listTitle);
}

export function contentSummary(row: any): string | null {
  return textOrNull(row.excerpt || row.caption || row.visibleText);
}

export function errorCodeForMessage(message: unknown): string | null {
  const text = String(message || "").trim();
  if (!text) return null;
  if (/login|登录|未登录/i.test(text)) return "LOGIN_REQUIRED";
  if (/timeout|超时/i.test(text)) return "TIMEOUT";
  return "SCRAPE_ERROR";
}
