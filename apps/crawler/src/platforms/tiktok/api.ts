import fs from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";

/**
 * TikTok 走 TikHub App V3：
 *   1) 用户名 → user_id / sec_user_id（只在第一次解析，之后从数据库读）
 *   2) sec_user_id → 作品列表（按 max_cursor 翻页）
 *
 * 这里只负责传输和字段归一化，翻页/时间窗/入库在 scraper.ts 里。
 */

const TIKHUB_BASE = "https://api.tikhub.io";
const RESOLVE_URL = `${TIKHUB_BASE}/api/v1/tiktok/app/v3/get_user_id_and_sec_user_id_by_username`;
const POSTS_URL = `${TIKHUB_BASE}/api/v1/tiktok/app/v3/fetch_user_post_videos_v2`;
const PROFILE_URL = `${TIKHUB_BASE}/api/v1/tiktok/app/v3/handler_user_profile`;

const RATE_LIMIT_INTERVAL_MS = 120;
const RETRY_DELAYS_MS = [800, 2000, 5000];
const ERROR_BODY_LIMIT = 500;

let lastRequestAt = 0;

export type TikTokApiClient = {
  apiKey: string;
  enabled: boolean;
};

export type TikTokIdentity = {
  userId: string;
  secUid: string;
};

export type TikTokPostsPage = {
  items: any[];
  cursor: string;
  hasMore: boolean;
  requestId: string;
  topLevelKeys: string[];
};

export async function createTikTokApiClient(workspace: string): Promise<TikTokApiClient> {
  const apiKey = process.env.TIKHUB_API_KEY || await readEnvFileValue(workspace, "TIKHUB_API_KEY");
  return { apiKey, enabled: Boolean(apiKey) };
}

/** 用户名 → user_id / sec_user_id。一个账号只该调一次。 */
export async function resolveTikTokIdentity(client: TikTokApiClient, username: string): Promise<TikTokIdentity> {
  try {
    return await resolveByIdEndpoint(client, username);
  } catch (error: any) {
    console.log(`TikHub 用户名解析失败，改用 handler_user_profile 兜底（${username}）：${error.message}`);
    return await resolveByProfileEndpoint(client, username);
  }
}

async function resolveByIdEndpoint(client: TikTokApiClient, username: string): Promise<TikTokIdentity> {
  const url = new URL(RESOLVE_URL);
  url.searchParams.set("username", username);
  const json = await tikhubGet(client, url, `解析用户 ${username}`);
  const data = unwrapData(json);
  const identity = identityFrom(data);
  if (!identity.secUid) {
    throw new Error(
      `TikHub 没有返回 sec_user_id（${username}）：code=${json?.code ?? "-"} ${json?.message || json?.message_zh || ""}`
      + `｜data 字段：${Object.keys(data).join(", ") || "(空)"}`
      + `｜响应片段：${JSON.stringify(json).slice(0, ERROR_BODY_LIMIT)}`,
    );
  }
  return identity;
}

async function resolveByProfileEndpoint(client: TikTokApiClient, username: string): Promise<TikTokIdentity> {
  const url = new URL(PROFILE_URL);
  url.searchParams.set("unique_id", username);
  const json = await tikhubGet(client, url, `用户资料 ${username}`);
  const data = unwrapData(json);
  const identity = identityFrom(data.user || data);
  if (!identity.secUid) {
    throw new Error(
      `TikHub 用户资料也没有返回 sec_uid（${username}）：code=${json?.code ?? "-"} ${json?.message || json?.message_zh || ""}`
      + `｜data 字段：${Object.keys(data).join(", ") || "(空)"}`
      + `｜响应片段：${JSON.stringify(json).slice(0, ERROR_BODY_LIMIT)}`,
    );
  }
  return identity;
}

function identityFrom(data: any): TikTokIdentity {
  const user = data?.user || data || {};
  return {
    userId: text(user.uid ?? user.user_id ?? user.userId ?? data?.user_id ?? data?.uid),
    secUid: text(
      user.sec_uid
        ?? user.secUid
        ?? data?.sec_user_id
        ?? data?.secUid
        ?? data?.sec_uid,
    ),
  };
}

/** 作品列表单页。cursor 传 0 开始，返回值给下一页。 */
export async function fetchTikTokPostsPage(
  client: TikTokApiClient,
  { secUid, uniqueId, cursor, count = 15 }: { secUid: string; uniqueId?: string; cursor: string | number; count?: number },
): Promise<TikTokPostsPage> {
  const url = new URL(POSTS_URL);
  url.searchParams.set("sec_user_id", secUid);
  if (uniqueId) url.searchParams.set("unique_id", uniqueId);
  url.searchParams.set("max_cursor", String(cursor || 0));
  url.searchParams.set("count", String(count));
  url.searchParams.set("sort_type", "0");

  const json = await tikhubGet(client, url, `作品列表 ${secUid}`);
  const data = unwrapData(json);
  const items = pickItems(data);
  const nextCursor = text(
    data.max_cursor ?? data.maxCursor ?? data.cursor ?? data.next_cursor ?? data.nextCursor,
  );
  const hasMore = pickHasMore(data, items.length > 0);
  return {
    items,
    cursor: nextCursor,
    hasMore,
    requestId: text(json?.request_id),
    topLevelKeys: Object.keys(data),
  };
}

/**
 * 把 App API 的条目（aweme_id / statistics / create_time）归一成
 * TikTok Web 的 item 形状（id / statsV2 / createTime），这样入库逻辑只有一套。
 * 已经是 Web 形状的直接原样返回。
 */
export function normalizeTikTokItem(item: any): any {
  const id = item?.aweme_id ?? item?.awemeId;
  if (!id) return item;

  const author = item.author || {};
  const stats = item.statistics || item.stats || item.statsV2 || {};
  const images = item.image_post_info?.images ?? item.images ?? item.imagePostInfo?.images;

  return {
    id: text(id),
    desc: text(item.desc ?? item.description),
    createTime: Number(item.create_time ?? item.createTime ?? 0) || 0,
    isPinned: Boolean(item.is_pinned_item ?? item.isPinnedItem ?? item.is_top),
    author: {
      uniqueId: text(author.unique_id ?? author.uniqueId),
      nickname: text(author.nickname),
      secUid: text(author.sec_uid ?? author.secUid),
      signature: text(author.signature),
      verified: author.verified ?? "",
      followerCount: author.follower_count ?? author.followerCount ?? "",
      followingCount: author.following_count ?? author.followingCount ?? "",
      awemeCount: author.aweme_count ?? author.awemeCount ?? "",
    },
    statsV2: {
      playCount: stats.play_count ?? stats.playCount ?? "",
      diggCount: stats.digg_count ?? stats.diggCount ?? "",
      commentCount: stats.comment_count ?? stats.commentCount ?? "",
      shareCount: stats.share_count ?? stats.shareCount ?? "",
      collectCount: stats.collect_count ?? stats.collectCount ?? "",
    },
    // 2 = 图文，1 = 视频
    type: Array.isArray(images) && images.length ? 2 : 1,
  };
}

// ---------- 内部 ----------

async function tikhubGet(client: TikTokApiClient, url: URL, label: string): Promise<any> {
  if (!client.enabled) throw new Error("TikHub 未启用：缺少 TIKHUB_API_KEY");

  let lastError = "";
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await delay(RETRY_DELAYS_MS[attempt - 1]);
    await waitForRateLimit();
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${client.apiKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(45000),
      });
      const body = await response.text();
      if (response.status === 429 || response.status >= 500) {
        lastError = `HTTP ${response.status}：${body.slice(0, ERROR_BODY_LIMIT)}`;
        continue;
      }
      if (!response.ok) {
        throw new Error(`TikHub ${label} 失败：HTTP ${response.status} ${body.slice(0, ERROR_BODY_LIMIT)}`);
      }
      let json: any;
      try {
        json = JSON.parse(body);
      } catch {
        throw new Error(`TikHub ${label} 返回非 JSON：${body.slice(0, ERROR_BODY_LIMIT)}`);
      }
      if (json?.code && Number(json.code) !== 200) {
        throw new Error(`TikHub ${label} 业务失败：code=${json.code} ${json.message || json.message_zh || ""}`);
      }
      return json;
    } catch (error: any) {
      lastError = error?.message || String(error);
      // 业务错误不重试，只有网络/超时/5xx 才重试
      if (/业务失败|非 JSON|HTTP 4\d\d/.test(lastError)) throw error;
    }
  }
  throw new Error(`TikHub ${label} 重试后仍失败：${lastError}`);
}

/** 有些接口把 data 序列化成字符串，这里统一解包成对象。 */
function unwrapData(json: any): any {
  let data = json?.data;
  for (let i = 0; i < 2 && typeof data === "string"; i++) {
    try {
      data = JSON.parse(data);
    } catch {
      break;
    }
  }
  // 有的接口 data 是数组（["命中项"]），取第一条
  if (Array.isArray(data)) return data[0] ?? {};
  if (data == null) return {};
  return typeof data === "object" ? data : {};
}

function pickItems(data: any): any[] {
  const candidates = [
    data.itemList,
    data.item_list,
    data.aweme_list,
    data.awemeList,
    data.items,
    data.list,
    data.data?.itemList,
    data.data?.aweme_list,
    data.data?.items,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function pickHasMore(data: any, fallback: boolean): boolean {
  const value = data.hasMore ?? data.has_more ?? data.has_more_value ?? data.data?.hasMore;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
  }
  return fallback;
}

function text(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRateLimit(): Promise<void> {
  const waitMs = Math.max(0, RATE_LIMIT_INTERVAL_MS - (Date.now() - lastRequestAt));
  if (waitMs > 0) await delay(waitMs);
  lastRequestAt = Date.now();
}

async function readEnvFileValue(workspace: string, name: string): Promise<string> {
  const envPath = path.join(workspace, ".env");
  try {
    const env = parseEnv(await fs.readFile(envPath, "utf8"));
    return env[name] || "";
  } catch (error: any) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}
