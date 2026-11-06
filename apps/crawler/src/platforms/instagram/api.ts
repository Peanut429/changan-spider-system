import fs from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { dateRangePosition, nowInDisplayTimeZone } from "../../core/time.ts";
import { truncateText } from "../../core/strings.ts";

// 新项目不写本地 raw.json；保留 RawState 形状给 API 解析函数使用。
export type RawState = { contents: any[]; accounts?: any[]; [key: string]: any };
async function saveRawState(_path: string, _state: RawState, _extra?: Record<string, any>): Promise<void> {}


export type InstagramDataSource = "api" | "browser";

export type InstagramApiClient = {
  source: InstagramDataSource;
  workspace: string;
  apiKey: string;
  enabled: boolean;
};

const TIKHUB_USER_INFO_URL = "https://api.tikhub.io/api/v1/instagram/v1/fetch_user_info_by_username_v3";
const TIKHUB_USER_INFO_FALLBACK_URL = "https://api.tikhub.io/api/v1/instagram/v2/fetch_user_info";
const TIKHUB_USER_POSTS_URL = "https://api.tikhub.io/api/v1/instagram/v1/fetch_user_posts";
const TIKHUB_USER_POSTS_FALLBACK_URL = "https://api.tikhub.io/api/v1/instagram/v2/fetch_user_posts";
const TIKHUB_USER_REELS_URL = "https://api.tikhub.io/api/v1/instagram/v2/fetch_user_reels";
const TIKHUB_RATE_LIMIT_INTERVAL_MS = 100;
const TIKHUB_RETRY_BASE_DELAY_MS = 1000;
const TIKHUB_ERROR_BODY_LIMIT = 12000;
let lastTikHubRequestAt = 0;

export type TikHubJsonValidator = (json: any) => string | null;
export type TikHubFailureType = "request_failed" | "api_failed" | "invalid_payload";

export function isInstagramDataSource(value: unknown): value is InstagramDataSource {
  return value === "api" || value === "browser";
}

export async function createInstagramApiClient({
  workspace,
  source = "api",
}: {
  workspace: string;
  source?: InstagramDataSource;
}): Promise<InstagramApiClient> {
  const apiKey = source === "api" ? await getTikHubApiKey(workspace) : "";
  return {
    source,
    workspace,
    apiKey,
    enabled: source === "api" && Boolean(apiKey),
  };
}

export async function fetchInstagramApiUserInfo(username: string, client: InstagramApiClient): Promise<Record<string, any>> {
  if (!client.enabled) return { instagramApiSkipped: true };
  try {
    const url = new URL(TIKHUB_USER_INFO_URL);
    url.searchParams.set("username", username);
    const json = await fetchTikHubJson(url, client, "用户信息", validateTikHubUserInfoJson, username, 1);
    return normalizeTikHubUserInfo(json, username);
  } catch (primaryError: any) {
    console.log(`TikHub 用户信息接口失败，改用 v2 用户信息接口（账号 ${username}）：${primaryError.message || String(primaryError)}`);
    try {
      const url = new URL(TIKHUB_USER_INFO_FALLBACK_URL);
      url.searchParams.set("username", username);
      const json = await fetchTikHubJson(url, client, "用户信息v2", validateTikHubUserInfoFallbackJson, username, 1);
      return normalizeTikHubUserInfo(json, username, json?.data?.data || {});
    } catch (fallbackError: any) {
      return {
        tikhubUsername: username,
        tikhubFetchedAt: nowInDisplayTimeZone(),
        tikhubError: fallbackError.message || String(fallbackError),
      };
    }
  }
}

export async function scrapeInstagramApiPosts({
  account,
  userId,
  client,
  args,
  rawState,
  rawPath,
  responseCollector,
}: {
  account: string;
  userId: string;
  client: InstagramApiClient;
  args: Record<string, any>;
  rawState: RawState;
  rawPath: string;
  responseCollector?: any[];
}): Promise<{ pages: number; fetched: number; kept: number; pageResponses: any[] }> {
  if (!client.enabled) throw new Error("Instagram API 未启用，无法通过 API 获取帖子列表。");
  if (!userId) throw new Error(`账号 ${account} 缺少用户ID，无法请求帖子列表。`);

  const seen = new Set(
    (rawState.contents || [])
      .filter((row) => accountKey(row.account) === accountKey(account))
      .map((row) => String(row.url || row.shortcode || row.pk || row.mediaId || ""))
      .filter(Boolean),
  );
  let maxId = "";
  let paginationToken = "";
  let postsEndpoint: "v1" | "v2" = "v1";
  let pages = 0;
  let fetched = 0;
  let kept = 0;
  const pageResponses: any[] = [];
  let seenInsideRange = (rawState.contents || []).some((row) => {
    return accountKey(row.account) === accountKey(account) && dateRangePosition(row.publishTime, args) === "inside";
  });
  let consecutiveBeforeRange = 0;
  let shouldStop = false;

  while (!shouldStop) {
    let page: { data: any; requestId: string; rawResponse: any };
    if (postsEndpoint === "v1") {
      try {
        page = await fetchInstagramApiPostsPage({ userId, maxId, client, account });
      } catch (error: any) {
        console.log(`TikHub 帖子列表接口失败，改用 v2 帖子列表接口从第一页重新拉取（账号 ${account}）：${error.message || String(error)}`);
        postsEndpoint = "v2";
        maxId = "";
        paginationToken = "";
        pages = 0;
        continue;
      }
    } else {
      page = await fetchInstagramApiPostsV2Page({ userId, paginationToken, client, account });
    }
    pages += 1;
    pageResponses.push(page.rawResponse);
    responseCollector?.push(page.rawResponse);
    const items = postsEndpoint === "v1"
      ? (Array.isArray(page.data?.items) ? page.data.items : [])
      : (Array.isArray(page.data?.data?.items) ? page.data.data.items : []);
    console.log(`API 帖子列表第 ${pages} 页：返回 ${items.length} 条。`);
    if (!items.length) break;

    for (const item of items) {
      fetched += 1;
      const row = instagramApiPostToContentRow({
        item,
        account,
        userId,
        requestId: page.requestId,
        api: postsEndpoint === "v1" ? "fetch_user_posts" : "v2_fetch_user_posts",
      });
      const identity = String(row.url || row.shortcode || row.pk || row.mediaId || "");
      const position = dateRangePosition(row.publishTime, args);
      const inRange = position === "inside";
      const duplicate = identity && seen.has(identity);

      if (inRange && !duplicate) {
        rawState.contents.push(row);
        seen.add(identity);
        kept += 1;
      }

      if (row.isPinned) {
        // 置顶内容不用于触发日期边界停止。
      } else if (inRange) {
        seenInsideRange = true;
        consecutiveBeforeRange = 0;
      } else if (position === "before") {
        consecutiveBeforeRange += 1;
      } else if (position === "after") {
        consecutiveBeforeRange = 0;
      }

      console.log(`${inRange ? "保留" : "跳过"}${duplicate ? " 重复=是" : ""}${row.isPinned ? " 置顶=是" : ""} ${row.type} ${row.url || row.shortcode || "缺失"} 发布时间=${row.publishTime || "缺失"} 点赞=${row.likeText || "缺失"} 评论=${row.commentText || "缺失"} 播放=${row.playText || "缺失"}`);

      if (args.limit && countAccountContents(rawState.contents, account) >= args.limit) {
        console.log(`已达到 --limit ${args.limit}，停止继续请求 API 帖子列表。`);
        shouldStop = true;
        break;
      }
      if (args.sinceTime != null && args.stopAfterBeforeRange > 0 && consecutiveBeforeRange >= args.stopAfterBeforeRange) {
        const rangeContext = seenInsideRange ? "已越过筛选周期边界" : "未发现筛选周期内内容";
        console.log(`${rangeContext}，且连续遇到 ${consecutiveBeforeRange} 条早于筛选周期的非置顶内容，停止继续请求 API 帖子列表。`);
        shouldStop = true;
        break;
      }
    }

    await saveRawState(rawPath, rawState, {
      apiPostsPagesFetched: {
        ...(rawState.apiPostsPagesFetched || {}),
        [account]: pages,
      },
    });

    if (shouldStop) break;
    if (postsEndpoint === "v1") {
      if (!page.data?.more_available || !page.data?.next_max_id) break;
      maxId = String(page.data.next_max_id);
    } else {
      if (!page.data?.pagination_token) break;
      paginationToken = String(page.data.pagination_token);
    }
  }

  return { pages, fetched, kept, pageResponses };
}

export async function scrapeInstagramApiReels({
  account,
  userId,
  client,
  args,
  rawState,
  rawPath,
  responseCollector,
}: {
  account: string;
  userId: string;
  client: InstagramApiClient;
  args: Record<string, any>;
  rawState: RawState;
  rawPath: string;
  responseCollector?: any[];
}): Promise<{ pages: number; fetched: number; kept: number; pageResponses: any[] }> {
  if (!client.enabled) throw new Error("Instagram API 未启用，无法通过 API 获取 Reels 列表。");
  if (!userId) throw new Error(`账号 ${account} 缺少用户ID，无法请求 Reels 列表。`);

  const seen = new Set(
    (rawState.contents || [])
      .filter((row) => accountKey(row.account) === accountKey(account))
      .map((row) => String(row.url || row.shortcode || row.pk || row.mediaId || ""))
      .filter(Boolean),
  );
  let paginationToken = "";
  let pages = 0;
  let fetched = 0;
  let kept = 0;
  const pageResponses: any[] = [];
  let seenInsideRange = (rawState.contents || []).some((row) => {
    return accountKey(row.account) === accountKey(account) && dateRangePosition(row.publishTime, args) === "inside";
  });
  let consecutiveBeforeRange = 0;
  let shouldStop = false;

  while (!shouldStop) {
    pages += 1;
    let page;
    try {
      page = await fetchInstagramApiReelsPage({ userId, paginationToken, client, account });
    } catch (error: any) {
      console.warn(`账号 ${account} Reels 接口不可用，按当前已抓取结果处理：${error?.message || String(error)}`);
      if (pages === 1) return { pages: 0, fetched: 0, kept: 0, pageResponses };
      break;
    }
    pageResponses.push(page.rawResponse);
    responseCollector?.push(page.rawResponse);
    const items = Array.isArray(page.data?.data?.items) ? page.data.data.items : [];
    console.log(`API Reels列表第 ${pages} 页：返回 ${items.length} 条。`);
    if (!items.length) break;

    for (const item of items) {
      fetched += 1;
      const row = instagramApiPostToContentRow({ item, account, userId, requestId: page.requestId, api: "fetch_user_reels" });
      const identity = String(row.url || row.shortcode || row.pk || row.mediaId || "");
      const position = dateRangePosition(row.publishTime, args);
      const inRange = position === "inside";
      const duplicate = identity && seen.has(identity);

      if (inRange && !duplicate) {
        rawState.contents.push(row);
        seen.add(identity);
        kept += 1;
      }

      if (row.isPinned) {
        // 置顶内容不用于触发日期边界停止。
      } else if (inRange) {
        seenInsideRange = true;
        consecutiveBeforeRange = 0;
      } else if (position === "before") {
        consecutiveBeforeRange += 1;
      } else if (position === "after") {
        consecutiveBeforeRange = 0;
      }

      console.log(`${inRange ? "保留" : "跳过"}${duplicate ? " 重复=是" : ""}${row.isPinned ? " 置顶=是" : ""} ${row.type} ${row.url || row.shortcode || "缺失"} 发布时间=${row.publishTime || "缺失"} 点赞=${row.likeText || "缺失"} 评论=${row.commentText || "缺失"} 分享=${row.shareText || "缺失"} 播放=${row.playText || "缺失"}`);

      if (args.limit && countAccountContents(rawState.contents, account) >= args.limit) {
        console.log(`已达到 --limit ${args.limit}，停止继续请求 API Reels列表。`);
        shouldStop = true;
        break;
      }
      if (args.sinceTime != null && args.stopAfterBeforeRange > 0 && consecutiveBeforeRange >= args.stopAfterBeforeRange) {
        const rangeContext = seenInsideRange ? "已越过筛选周期边界" : "未发现筛选周期内内容";
        console.log(`${rangeContext}，且连续遇到 ${consecutiveBeforeRange} 条早于筛选周期的非置顶内容，停止继续请求 API Reels列表。`);
        shouldStop = true;
        break;
      }
    }

    await saveRawState(rawPath, rawState, {
      apiReelsPagesFetched: {
        ...(rawState.apiReelsPagesFetched || {}),
        [account]: pages,
      },
    });

    if (shouldStop) break;
    if (!page.data?.pagination_token) break;
    paginationToken = String(page.data.pagination_token);
  }

  return { pages, fetched, kept, pageResponses };
}

export function mergeInstagramApiUserInfo(row: Record<string, any>, userInfo: Record<string, any>): Record<string, any> {
  if (!userInfo || userInfo.instagramApiSkipped) return row;
  const merged = { ...row, ...userInfo };
  if (userInfo.tikhubFollowerCount !== "" && userInfo.tikhubFollowerCount != null) {
    merged.followersText = String(userInfo.tikhubFollowerCount);
  }
  if (userInfo.tikhubFollowingCount !== "" && userInfo.tikhubFollowingCount != null) {
    merged.followingText = String(userInfo.tikhubFollowingCount);
  }
  if (userInfo.tikhubMediaCount !== "" && userInfo.tikhubMediaCount != null) {
    merged.postsText = String(userInfo.tikhubMediaCount);
  }
  if (userInfo.tikhubFullName && !merged.displayName) merged.displayName = userInfo.tikhubFullName;
  return merged;
}

export function hasInstagramApiUserInfo(row: Record<string, any>): boolean {
  return Boolean(row?.tikhubUserId || row?.tikhubUsername || row?.tikhubError);
}

export async function enrichCompletedAccountWithInstagramApi({
  rawState,
  account,
  client,
  rawPath,
}: {
  rawState: RawState;
  account: string;
  client: InstagramApiClient;
  rawPath: string;
}): Promise<boolean> {
  if (!client.enabled) return false;
  const existing = (rawState.accounts || []).find((row) => accountKey(row.account) === accountKey(account));
  if (!existing || hasInstagramApiUserInfo(existing)) return false;
  process.stdout.write(`补充已完成账号 API 用户信息：${account} ... `);
  const userInfo = await fetchInstagramApiUserInfo(account, client);
  Object.assign(existing, mergeInstagramApiUserInfo(existing, userInfo));
  await saveRawState(rawPath, rawState);
  console.log(userInfo.tikhubError ? `失败 ${userInfo.tikhubError}` : "完成");
  return true;
}

async function fetchInstagramApiPostsPage({
  userId,
  maxId,
  client,
  account,
}: {
  userId: string;
  maxId?: string;
  client: InstagramApiClient;
  account: string;
}): Promise<{ data: any; requestId: string; rawResponse: any }> {
  const url = new URL(TIKHUB_USER_POSTS_URL);
  url.searchParams.set("user_id", userId);
  if (maxId) url.searchParams.set("max_id", maxId);
  const json = await fetchTikHubJson(url, client, "用户帖子列表", validateTikHubPostsJson, account, 1);
  return { data: json.data || {}, requestId: json.request_id || "", rawResponse: json };
}

async function fetchInstagramApiPostsV2Page({
  userId,
  paginationToken,
  client,
  account,
}: {
  userId: string;
  paginationToken?: string;
  client: InstagramApiClient;
  account: string;
}): Promise<{ data: any; requestId: string; rawResponse: any }> {
  const url = new URL(TIKHUB_USER_POSTS_FALLBACK_URL);
  url.searchParams.set("user_id", userId);
  if (paginationToken) url.searchParams.set("pagination_token", paginationToken);
  const json = await fetchTikHubJson(url, client, "用户帖子列表v2", validateTikHubPostsV2Json, account, 1);
  return { data: json.data || {}, requestId: json.request_id || "", rawResponse: json };
}

async function fetchInstagramApiReelsPage({
  userId,
  paginationToken,
  client,
  account,
}: {
  userId: string;
  paginationToken?: string;
  client: InstagramApiClient;
  account: string;
}): Promise<{ data: any; requestId: string; rawResponse: any }> {
  const url = new URL(TIKHUB_USER_REELS_URL);
  url.searchParams.set("user_id", userId);
  if (paginationToken) url.searchParams.set("pagination_token", paginationToken);
  const json = await fetchTikHubJson(url, client, "用户Reels列表", validateTikHubReelsJson, account, 3);
  return { data: json.data || {}, requestId: json.request_id || "", rawResponse: json };
}

export async function fetchTikHubJson(
  url: URL,
  client: InstagramApiClient,
  label: string,
  validateJson: TikHubJsonValidator,
  account?: string,
  maxAttempts: number = Number.POSITIVE_INFINITY,
): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      await waitForTikHubRateLimit();
      const json = await fetchTikHubJsonOnce(url, client, label, validateJson, account);
      if (attempt > 0) console.log(`TikHub ${label}接口第 ${attempt + 1} 次请求成功。`);
      return json;
    } catch (error: any) {
      if (error?.retryable === false) throw error;
      if (attempt + 1 >= maxAttempts) throw error;
      const waitMs = TIKHUB_RETRY_BASE_DELAY_MS * (attempt + 1);
      const context = error?.tikhub;
      const responseText = context?.responseText || (context?.responseJson != null ? JSON.stringify(context.responseJson) : "");
      const detailLines = [
        `TikHub ${label}接口失败${account ? `（账号 ${account}）` : ""}，第 ${attempt + 1} 次重试将在 ${waitMs}ms 后执行：${error.message || String(error)}`,
        context?.requestUrl ? `  请求 URL：${context.requestUrl}` : "",
        context?.requestParams ? `  请求参数：${JSON.stringify(context.requestParams)}` : "",
        responseText ? `  响应内容：${truncateTikHubErrorText(responseText)}` : "",
      ].filter(Boolean).join("\n");
      console.log(detailLines);
      await delay(waitMs);
    }
  }
}

export async function fetchTikHubJsonOnce(url: URL, client: InstagramApiClient, label: string, validateJson: TikHubJsonValidator, account?: string): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${client.apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30000),
    });
  } catch (cause: any) {
    const error: any = new Error(`TikHub ${label}接口请求失败：${cause?.message || String(cause)}`);
    error.cause = cause;
    error.retryable = true;
    attachTikHubErrorContext(error, {
      url,
      label,
      account,
      failureType: "request_failed",
    });
    throw error;
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    const error: any = new Error(`TikHub ${label}接口返回非 JSON 响应：HTTP ${response.status}`);
    error.status = response.status;
    error.retryable = true;
    attachTikHubErrorContext(error, {
      url,
      label,
      account,
      response,
      responseText: text,
      failureType: "invalid_payload",
    });
    throw error;
  }
  if (!response.ok || Number(json?.code ?? 200) !== 200 || json?.data?.status === false) {
    const apiCode = json?.code ?? json?.detail?.code ?? "";
    const businessFailed = json?.data?.status === false;
    const charged = isTikHubChargedResponse(json);
    const businessMessage = businessFailed ? (json?.data?.errorMessage || "") : "";
    const apiMessage = businessMessage || json?.message || json?.message_zh || json?.detail?.message || "";
    const error: any = new Error(`TikHub ${label}接口失败：HTTP ${response.status} code=${apiCode} message=${apiMessage}`.trim());
    error.status = response.status;
    error.code = apiCode;
    const resourceMissing = /requested resource does not exist/i.test(apiMessage);
    error.retryable = !(charged || businessFailed || resourceMissing);
    attachTikHubErrorContext(error, {
      url,
      label,
      account,
      response,
      responseJson: json,
      responseText: text,
      failureType: "api_failed",
    });
    throw error;
  }
  const validationError = validateJson(json);
  if (validationError) {
    const error: any = new Error(`TikHub ${label}接口响应内容异常：${validationError}`);
    error.status = response.status;
    error.retryable = isTikHubChargedResponse(json) ? false : true;
    attachTikHubErrorContext(error, {
      url,
      label,
      account,
      response,
      responseJson: json,
      responseText: text,
      failureType: "invalid_payload",
    });
    throw error;
  }
  return json;
}

export function tikHubErrorDetails(error: any): Record<string, any> | null {
  if (!error?.tikhub) return null;
  return error.tikhub;
}

function attachTikHubErrorContext(
  error: any,
  {
    url,
    label,
    account,
    failureType,
    response,
    responseJson,
    responseText,
  }: {
    url: URL;
    label: string;
    account?: string;
    failureType: TikHubFailureType;
    response?: Response;
    responseJson?: any;
    responseText?: string;
  },
): void {
  error.tikhub = {
    account: account || "",
    label,
    failureType,
    requestUrl: url.toString(),
    requestParams: Object.fromEntries(url.searchParams.entries()),
    httpStatus: response?.status ?? null,
    httpStatusText: response?.statusText ?? null,
    responseCode: responseJson?.code ?? responseJson?.detail?.code ?? null,
    responseMessage: responseJson?.data?.errorMessage || responseJson?.message || responseJson?.detail?.message || null,
    responseMessageZh: responseJson?.message_zh ?? null,
    responseRequestId: responseJson?.request_id ?? responseJson?.detail?.request_id ?? null,
    responseJson: responseJson ?? null,
    responseText: truncateTikHubErrorText(responseText),
    capturedAt: nowInDisplayTimeZone(),
  };
}

function truncateTikHubErrorText(text: unknown): string {
  const value = String(text ?? "");
  return value.length > TIKHUB_ERROR_BODY_LIMIT ? `${truncateText(value, TIKHUB_ERROR_BODY_LIMIT)}...<truncated>` : value;
}

function isTikHubChargedResponse(json: any): boolean {
  const message = String(json?.message || "");
  const messageZh = String(json?.message_zh || "");
  return /Request successful\. This request will incur a charge\./i.test(message)
    || /请求成功，本次请求将被计费/.test(messageZh);
}

function validateTikHubUserInfoJson(json: any): string | null {
  const data = json?.data;
  if (!isObjectRecord(data)) return "data 不是对象";
  if (!hasValue(data.pk) && !hasValue(data.id)) return "缺少用户ID字段 data.pk/data.id";
  return null;
}

function validateTikHubUserInfoFallbackJson(json: any): string | null {
  const data = json?.data;
  if (!isObjectRecord(data)) return "data 不是对象";
  if (!isObjectRecord(data.data)) return "缺少用户数据对象 data.data";
  if (!hasValue(data.data.pk) && !hasValue(data.data.id)) return "缺少用户ID字段 data.data.pk/data.data.id";
  return null;
}

function validateTikHubPostsJson(json: any): string | null {
  const data = json?.data;
  if (!isObjectRecord(data)) return "data 不是对象";
  if (!Array.isArray(data.items)) return "缺少帖子列表数组 data.items";
  const invalidItemIndex = data.items.findIndex((item: any) => {
    return !isObjectRecord(item) || !hasValue(item.code) || !Number.isFinite(Number(item.taken_at));
  });
  if (invalidItemIndex >= 0) return `data.items[${invalidItemIndex}] 缺少关键字段 code/taken_at`;
  if (data.more_available && !hasValue(data.next_max_id)) return "more_available=true 但缺少 next_max_id";
  return null;
}

function validateTikHubPostsV2Json(json: any): string | null {
  const data = json?.data;
  if (!isObjectRecord(data)) return "data 不是对象";
  if (!isObjectRecord(data.data)) return "缺少帖子数据对象 data.data";
  if (!Array.isArray(data.data.items)) return "缺少帖子列表数组 data.data.items";
  const invalidItemIndex = data.data.items.findIndex((item: any) => {
    return !isObjectRecord(item) || !hasValue(item.code) || !Number.isFinite(Number(item.taken_at));
  });
  if (invalidItemIndex >= 0) return `data.data.items[${invalidItemIndex}] 缺少关键字段 code/taken_at`;
  return null;
}

function validateTikHubReelsJson(json: any): string | null {
  const data = json?.data;
  if (!isObjectRecord(data)) return "data 不是对象";
  if (!isObjectRecord(data.data)) return "缺少 Reels 数据对象 data.data";
  if (!Array.isArray(data.data.items)) return "缺少 Reels 列表数组 data.data.items";
  const invalidItemIndex = data.data.items.findIndex((item: any) => {
    return !isObjectRecord(item) || !hasValue(item.code) || !Number.isFinite(Number(item.taken_at));
  });
  if (invalidItemIndex >= 0) return `data.data.items[${invalidItemIndex}] 缺少关键字段 code/taken_at`;
  return null;
}

function isObjectRecord(value: unknown): value is Record<string, any> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasValue(value: unknown): boolean {
  return String(value ?? "").trim() !== "";
}

function instagramApiPostToContentRow({
  item,
  account,
  userId,
  requestId,
  api = "fetch_user_posts",
}: {
  item: any;
  account: string;
  userId: string;
  requestId: string;
  api?: string;
}): Record<string, any> {
  const code = item?.code || "";
  const isVideo = item?.media_type === 2 || item?.product_type === "clips";
  const marker = isVideo ? "reel" : "p";
  const publishTime = Number.isFinite(Number(item?.taken_at)) ? new Date(Number(item.taken_at) * 1000).toISOString() : "";
  return {
    account,
    shortcode: code,
    url: code ? `https://www.instagram.com/${marker}/${code}/` : "",
    type: isVideo ? "reel" : "post",
    isPinned: Array.isArray(item?.timeline_pinned_user_ids)
      ? item.timeline_pinned_user_ids.map(String).includes(String(userId))
      : false,
    pk: mediaPk(item),
    mediaId: item?.id || item?.strong_id__ || "",
    publishTime,
    exposureText: "",
    readText: "",
    playText: item?.play_count ?? item?.ig_play_count ?? item?.fb_play_count ?? item?.view_count ?? "",
    likeText: item?.like_count ?? item?.fb_like_count ?? "",
    commentText: item?.comment_count ?? "",
    // 收藏：帖子列表接口只有视频/Reels 类条目带 save_count，图片帖/轮播帖没有该字段，留空。
    collectText: item?.save_count ?? "",
    // 分享：只有 Reels 列表接口(v2/fetch_user_reels)返回 share_count；帖子列表接口没有这个字段，留空。
    shareText: api === "fetch_user_reels" ? (item?.share_count ?? "") : "",
    excerpt: item?.caption?.text || "",
    scrapedAt: nowInDisplayTimeZone(),
    error: "",
    raw: {
      api,
      requestId,
      media: item,
    },
  };
}

function mediaPk(item: any): string {
  const strongId = String(item?.id || item?.strong_id__ || "");
  const fromStrongId = strongId.split("_")[0];
  if (fromStrongId) return fromStrongId;
  return item?.pk == null ? "" : String(item.pk);
}

function countAccountContents(contents: any[], account: unknown): number {
  const key = accountKey(account);
  return (contents || []).filter((row) => accountKey(row.account) === key).length;
}

function accountKey(value: unknown): string {
  return String(value || "").trim().toLowerCase();
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

async function getTikHubApiKey(workspace: string): Promise<string> {
  if (process.env.TIKHUB_API_KEY) return process.env.TIKHUB_API_KEY;
  return await readEnvFileValue(workspace, "TIKHUB_API_KEY");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTikHubRateLimit(): Promise<void> {
  const waitMs = Math.max(0, TIKHUB_RATE_LIMIT_INTERVAL_MS - (Date.now() - lastTikHubRequestAt));
  if (waitMs > 0) await delay(waitMs);
  lastTikHubRequestAt = Date.now();
}

function formatTikHubBioLinks(links: unknown): string {
  if (!Array.isArray(links)) return "";
  return links.map((link) => {
    const title = String(link?.title || "").trim();
    const url = String(link?.url || "").trim();
    return [title, url].filter(Boolean).join(" ");
  }).filter(Boolean).join("\n");
}

function finiteNumberOrBlank(value: unknown): number | "" {
  if (value === "" || value == null) return "";
  const number = Number(value);
  return Number.isFinite(number) ? number : "";
}

function normalizeTikHubUserInfo(responseJson: any, username: string, data: any = responseJson?.data || {}): Record<string, any> {
  const hdProfilePicUrl = typeof data?.hd_profile_pic_url_info === "object" ? data.hd_profile_pic_url_info?.url || "" : "";
  return {
    tikhubUserId: data.pk || data.id || "",
    tikhubUsername: data.username || username,
    tikhubFullName: data.full_name || "",
    tikhubBiography: data.biography || "",
    tikhubBioLinks: formatTikHubBioLinks(data.bio_links),
    tikhubFollowerCount: finiteNumberOrBlank(data.follower_count),
    tikhubFollowingCount: finiteNumberOrBlank(data.following_count),
    tikhubMediaCount: finiteNumberOrBlank(data.media_count),
    tikhubProfilePicUrl: data.profile_pic_url || "",
    tikhubHdProfilePicUrl: hdProfilePicUrl,
    tikhubIsPrivate: typeof data.is_private === "boolean" ? data.is_private : "",
    tikhubIsVerified: typeof data.is_verified === "boolean" ? data.is_verified : "",
    tikhubExternalUrl: data.external_url || "",
    tikhubCategory: data.category || "",
    tikhubRequestId: responseJson?.request_id || "",
    tikhubFetchedAt: nowInDisplayTimeZone(),
    tikhubError: "",
    tikhubRawResponse: responseJson,
    tikhubRawData: data,
  };
}
