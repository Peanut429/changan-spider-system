import { instagramCommentFetcher } from "./fetchers/instagram.ts";
import { tiktokCommentFetcher } from "./fetchers/tiktok.ts";
import { xCommentFetcher } from "./fetchers/x.ts";
import { youtubeCommentFetcher } from "./fetchers/youtube.ts";
import type { CommentFetcher } from "./types.ts";

/**
 * 评论任务支持的平台。
 *
 * Facebook / LinkedIn 没有评论接口，不在这个注册表里；
 * 它们的帖子仍由每日任务抓，评论这期不做。
 */
export const COMMENT_FETCHERS: Record<string, CommentFetcher> = {
  instagram: instagramCommentFetcher,
  tiktok: tiktokCommentFetcher,
  youtube: youtubeCommentFetcher,
  x: xCommentFetcher,
};

export const COMMENT_PLATFORM_CODES = Object.keys(COMMENT_FETCHERS);

export function isSupportedCommentPlatform(code: string): boolean {
  return Boolean(COMMENT_FETCHERS[String(code || "").trim().toLowerCase()]);
}

export function getCommentFetcher(code: string): CommentFetcher {
  const normalized = String(code || "").trim().toLowerCase();
  const fetcher = COMMENT_FETCHERS[normalized];
  if (!fetcher) {
    throw new Error(
      `平台 ${code} 没有评论接口。支持：${COMMENT_PLATFORM_CODES.join(", ")}`
      + "（Facebook / LinkedIn 没有评论接口，本期不抓）",
    );
  }
  return fetcher;
}
