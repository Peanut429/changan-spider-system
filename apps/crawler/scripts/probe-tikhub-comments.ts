import { loadEnvFile } from "../src/config/env.ts";
import { parseArgs } from "../src/config/args.ts";
import { createTikHubClient } from "../src/core/tikhub.ts";
import { instagramPostKey } from "../src/comments/fetchers/instagram.ts";
import { tiktokPostKey } from "../src/comments/fetchers/tiktok.ts";
import { xPostKey } from "../src/comments/fetchers/x.ts";
import { youtubePostKey } from "../src/comments/fetchers/youtube.ts";
import type { CommentPost } from "../src/comments/types.ts";

/**
 * 评论接口探针：只读、不写库。
 *
 * 用法：
 *   node --experimental-strip-types scripts/probe-tikhub-comments.ts \
 *     --platform instagram --post-url https://www.instagram.com/p/XXXX/
 *
 * 可选：
 *   --comment-id <id>     Instagram / TikTok 的回复接口要一级评论 ID
 *   --reply-token <token> YouTube 的回复接口要 reply_continuation_token
 *   --max-sample 3000     响应片段截断长度
 *   --base-url           覆盖 TikHub 地址（默认读 TIKHUB_BASE_URL）
 *
 * 用来在实现/排障时确认接口真实字段；不用把完整响应写进日志。
 */

const PLATFORMS = ["instagram", "tiktok", "youtube", "x"] as const;
type Platform = typeof PLATFORMS[number];

function postOf(platform: Platform, url: string, key: string): CommentPost {
  return {
    contentId: "probe",
    externalContentId: key || null,
    url,
    publishTsMs: Date.now(),
    contentType: null,
    title: null,
    commentCount: null,
  };
}

function isObject(value: unknown): value is Record<string, any> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function preview(json: any, limit: number): string {
  const text = JSON.stringify(json?.data ?? json);
  return text.length > limit ? `${text.slice(0, limit)}...<truncated>` : text;
}

function expectedUrl(platform: Platform, key: string, commentId: string, replyToken: string): { url: URL; label: string } | null {
  const queries = (params: Record<string, string>) => {
    const search = new URLSearchParams(params).toString();
    return search ? `?${search}` : "";
  };
  switch (platform) {
    case "instagram":
      return commentId
        ? {
            url: new URL(`/api/v1/instagram/v2/fetch_comment_replies${queries({ code_or_url: key, comment_id: commentId })}`, "http://probe"),
            label: "Instagram 回复",
          }
        : {
            url: new URL(`/api/v1/instagram/v2/fetch_post_comments${queries({ code_or_url: key, sort_by: "recent" })}`, "http://probe"),
            label: "Instagram 评论",
          };
    case "tiktok":
      return commentId
        ? {
            url: new URL(`/api/v1/tiktok/app/v3/fetch_video_comment_replies${queries({ item_id: key, comment_id: commentId, count: "20" })}`, "http://probe"),
            label: "TikTok 回复",
          }
        : {
            url: new URL(`/api/v1/tiktok/app/v3/fetch_video_comments${queries({ aweme_id: key, count: "20" })}`, "http://probe"),
            label: "TikTok 评论",
          };
    case "youtube":
      return replyToken
        ? {
            url: new URL(`/api/v1/youtube/web_v2/get_video_comment_replies${queries({
              reply_continuation_token: replyToken,
              language_code: "zh-CN",
              country_code: "US",
              need_format: "true",
            })}`, "http://probe"),
            label: "YouTube 回复",
          }
        : {
            url: new URL(`/api/v1/youtube/web_v2/get_video_comments${queries({
              video_id: key,
              language_code: "zh-CN",
              country_code: "US",
              sort_by: "newest",
              need_format: "true",
            })}`, "http://probe"),
            label: "YouTube 评论",
          };
    case "x":
      if (commentId) {
        throw new Error("X 的回复已包含在 fetch_post_comments 时间线里，不需要单独的回复接口");
      }
      return {
        url: new URL(`/api/v1/twitter/web/fetch_post_comments${queries({ tweet_id: key })}`, "http://probe"),
        label: "X 评论",
      };
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const args = parseArgs(process.argv.slice(2));
  const platform = String(args.values.get("platform") || "").trim().toLowerCase() as Platform;
  if (!PLATFORMS.includes(platform)) {
    throw new Error(`--platform 只能是 ${PLATFORMS.join(" / ")}`);
  }
  const postUrl = String(args.values.get("post-url") || "").trim();
  const explicitKey = String(args.values.get("post-key") || "").trim();
  const commentId = String(args.values.get("comment-id") || "").trim();
  const replyToken = String(args.values.get("reply-token") || "").trim();
  const maxSample = Number(args.values.get("max-sample") || 3000);

  const keyExtractor = platform === "instagram"
    ? instagramPostKey
    : platform === "tiktok"
      ? tiktokPostKey
      : platform === "youtube"
        ? youtubePostKey
        : xPostKey;
  const key = explicitKey || (postUrl ? keyExtractor(postOf(platform, postUrl, "")) : "");
  if (!key) throw new Error("需要 --post-url 或 --post-key");

  const request = expectedUrl(platform, key, commentId, replyToken);
  if (!request) throw new Error("无法构造请求");
  const url = new URL(request.url.pathname + request.url.search, String(args.values.get("base-url") || process.env.TIKHUB_BASE_URL || "https://api.tikhub.io"));

  const client = createTikHubClient();
  if (!client.enabled) throw new Error("缺少 TIKHUB_API_KEY");

  console.log(`[probe] ${request.label}`);
  console.log(`[probe] GET ${url.toString()}`);
  const json = await client.getJson(url, { label: request.label });
  console.log(`[probe] code=${json?.code ?? "-"} message=${json?.message || json?.message_zh || ""}`);
  if (isObject(json?.data)) {
    const data: Record<string, any> = json.data;
    console.log(`[probe] data keys: ${Object.keys(data).join(", ") || "(空)"}`);
    const printArray = (label: string, value: unknown) => {
      if (!Array.isArray(value)) return;
      console.log(`[probe] ${label}: ${value.length} 条`);
      if (isObject(value[0])) console.log(`[probe] ${label} 第一条字段: ${Object.keys(value[0]).join(", ")}`);
    };
    printArray("data.thread", data.thread);
    printArray("data.tweets", data.tweets);
    printArray("data.comments", data.comments);
    if (isObject(data.data)) {
      console.log(`[probe] data.data keys: ${Object.keys(data.data).join(", ") || "(空)"}`);
      printArray("data.data.items", data.data.items);
      printArray("data.data.comments", data.data.comments);
    }
    const instructions = data.threaded_conversation_with_injections_v2?.instructions;
    if (Array.isArray(instructions)) {
      console.log(`[probe] instructions: ${instructions.map((item: any) => item?.type).join(", ")}`);
    }
    if (data.pagination_token) console.log("[probe] data.pagination_token: <有>");
    if (data.continuation_token) console.log("[probe] data.continuation_token: <有>");
    if (data.cursor) console.log("[probe] data.cursor: <有>");
  }
  console.log(`[probe] data 片段：${preview(json, maxSample)}`);

  const tokens = (json?.data?.comments || [])
    .slice(0, 3)
    .map((item: any) => ({
      id: item?.comment_id ?? item?.cid ?? item?.id,
      replyToken: item?.reply_continuation_token ? "<有>" : "",
    }))
    .filter((item: any) => item.id);
  if (tokens.length) console.log(`[probe] 一级评论样例：${JSON.stringify(tokens)}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
