// YouTube Innertube HTTP 抓取。
//
// 设计：浏览器只负责一次“引导”——打开频道页拿到登录态、ytcfg（API key/context）和首屏列表；
// 之后的列表翻页、视频详情、评论数全部走 /youtubei/v1 接口，不再逐条打开页面。
// 请求在页面里用 fetch 发出，沿用浏览器的代理、cookie 和登录态。
// 任何引导/传输级失败都会抛出 YouTubeHttpError，由上层决定是否降级回纯页面抓取。
import { gotoWithRetry, pageFetch } from "../../core/page-http.ts";
import { approxRelativePublishedRange, parseLocalizedNumber } from "./parse.ts";
import { autoAcceptYouTubeConsent } from "./page.ts";

export class YouTubeHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YouTubeHttpError";
  }
}

type InnertubeConfig = {
  apiKey: string;
  clientName: string;
  clientVersion: string;
  visitorData: string;
  context: any;
};

export type YouTubeHttpListItem = {
  videoId: string;
  title: string;
  viewText: string;
  relativeText: string;
  duration: string;
  isShort: boolean;
};

export type YouTubeHttpChannel = {
  displayName: string;
  channelId: string;
  followersText: string;
  postsText: string;
  canonicalUrl: string;
  pageTitle: string;
};

export type YouTubeHttpSession = {
  page: any;
  config: InnertubeConfig;
  headers: Record<string, string>;
  channel: YouTubeHttpChannel;
  items: YouTubeHttpListItem[];
  continuation: string;
  /** 当前页是否真的是 Shorts 标签页（某些频道没有 Shorts，会落到视频标签页）。 */
  isShortsTab: boolean;
};

export type YouTubeHttpVideoDetail = {
  videoId: string;
  title: string;
  channel: string;
  channelId: string;
  durationSeconds: string;
  viewCount: string;
  viewCountText: string;
  likeText: string;
  commentText: string;
  publishDate: string;
  uploadDate: string;
  description: string;
  isLive: boolean | null;
};

export const YOUTUBE_MAX_LIST_PAGES = 40;

const SUBSCRIBER_PATTERNS = [
  /[\d.,]+\s*[KMBkmb万千亿]?\s*(?:位)?订阅者/i,
  /[\d.,]+\s*[KMBkmb万千亿]?\s*subscribers?/i,
];

const VIDEO_COUNT_PATTERNS = [
  /[\d.,]+\s*[KMBkmb万千亿]?\s*(?:个|部|条)?视频/i,
  /[\d.,]+\s*[KMBkmb万千亿]?\s*videos?/i,
];

const COMMENTS_DISABLED_PATTERN = /评论已关闭|comments are turned off/i;

export function textOf(value: any): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((item) => textOf(item)).join("");
  if (typeof value === "object") {
    if (typeof value.content === "string") return value.content;
    if (typeof value.simpleText === "string") return value.simpleText;
    if (typeof value.text === "string") return value.text;
    if (Array.isArray(value.runs)) return value.runs.map((run) => textOf(run)).join("");
  }
  return "";
}

function walk(node: any, visit: (node: any) => void): void {
  if (!node || typeof node !== "object") return;
  visit(node);
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  for (const value of Object.values(node)) walk(value, visit);
}

function walkWithPath(node: any, visit: (node: any, path: string) => void, path = ""): void {
  if (!node || typeof node !== "object") return;
  visit(node, path);
  if (Array.isArray(node)) {
    node.forEach((item, index) => walkWithPath(item, visit, `${path}[${index}]`));
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    walkWithPath(value, visit, path ? `${path}.${key}` : key);
  }
}

function matchMetric(source: unknown, patterns: RegExp[]): string {
  const text = String(source || "");
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0].trim();
  }
  return "";
}

function findDurationBadge(contentImage: any): string {
  const overlays = contentImage?.thumbnailViewModel?.overlays || [];
  for (const overlay of overlays) {
    const badges = overlay?.thumbnailBottomOverlayViewModel?.badges || [];
    for (const badge of badges) {
      const text = String(badge?.thumbnailBadgeViewModel?.text || "").trim();
      if (/^\d{1,2}(:\d{2}){1,2}$/.test(text)) return text;
    }
  }
  return "";
}

function parseShortViewText(accessibilityText: unknown): string {
  const source = String(accessibilityText || "");
  const match = source.match(/([\d.,]+\s*(?:thousand|million|billion|[KMB]|万|亿)?\s*(?:views?|次观看))/i);
  return match ? match[1].trim() : "";
}

function parseShortTitleFromAccessibility(accessibilityText: unknown): string {
  return String(accessibilityText || "")
    .replace(/,\s*[\d.,]+\s*(?:thousand|million|billion|[KMB]|万|亿)?\s*(?:views?|次观看).*$/i, "")
    .trim();
}

function fromLockup(lockup: any): YouTubeHttpListItem | null {
  const videoId = String(lockup?.contentId || "").trim();
  if (!videoId) return null;
  const contentType = String(lockup?.contentType || "");
  if (contentType && !/(VIDEO|SHORT)/i.test(contentType)) return null;

  const metadata = lockup?.metadata?.lockupMetadataViewModel || {};
  const rows = metadata?.metadata?.contentMetadataViewModel?.metadataRows || [];
  const parts: string[] = [];
  for (const row of rows) {
    for (const part of row?.metadataParts || []) {
      const text = textOf(part?.text);
      if (text) parts.push(text);
      if (part?.accessibilityLabel) parts.push(String(part.accessibilityLabel));
    }
  }

  return {
    videoId,
    title: textOf(metadata?.title),
    viewText: parts.find((part) => /观看|views?/i.test(part)) || "",
    relativeText: parts.find((part) => /前$|ago$/i.test(part.trim())) || "",
    duration: findDurationBadge(lockup?.contentImage),
    isShort: /SHORT/i.test(contentType),
  };
}

function fromVideoRenderer(video: any): YouTubeHttpListItem | null {
  const videoId = String(video?.videoId || "").trim();
  if (!videoId) return null;
  return {
    videoId,
    title: textOf(video?.title),
    viewText: textOf(video?.viewCountText),
    relativeText: textOf(video?.publishedTimeText),
    duration: textOf(video?.lengthText),
    isShort: false,
  };
}

function fromShortsLockup(short: any): YouTubeHttpListItem | null {
  const endpointId = short?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId;
  const entityId = String(short?.entityId || "").replace(/^shorts-shelf-item-/, "");
  const videoId = String(endpointId || entityId || "").trim();
  if (!videoId) return null;

  const overlay = short?.overlayMetadata || {};
  return {
    videoId,
    title: textOf(overlay?.primaryText) || parseShortTitleFromAccessibility(short?.accessibilityText),
    viewText: textOf(overlay?.secondaryText) || parseShortViewText(short?.accessibilityText),
    relativeText: "",
    duration: "",
    isShort: true,
  };
}

function fromReelItem(item: any): YouTubeHttpListItem | null {
  const videoId = String(item?.videoId || "").trim();
  if (!videoId) return null;
  return {
    videoId,
    title: textOf(item?.headline),
    viewText: textOf(item?.viewCountText),
    relativeText: "",
    duration: "",
    isShort: true,
  };
}

function parseListRenderer(node: any): YouTubeHttpListItem | null {
  if (node?.lockupViewModel) return fromLockup(node.lockupViewModel);
  if (node?.videoRenderer) return fromVideoRenderer(node.videoRenderer);
  if (node?.gridVideoRenderer) return fromVideoRenderer(node.gridVideoRenderer);
  if (node?.shortsLockupViewModel) return fromShortsLockup(node.shortsLockupViewModel);
  if (node?.reelItemRenderer) return fromReelItem(node.reelItemRenderer);
  return null;
}

function visitListNode(node: any, out: { items: YouTubeHttpListItem[]; continuation: string }): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) visitListNode(item, out);
    return;
  }

  const item = parseListRenderer(node);
  if (item) {
    out.items.push(item);
    return;
  }

  const continuation = node?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
    || node?.nextContinuationData?.continuation;
  if (typeof continuation === "string" && continuation && !out.continuation) {
    out.continuation = continuation;
  }

  for (const value of Object.values(node)) visitListNode(value, out);
}

/** 解析频道页/continuation 返回里的列表内容（兼容 lockup / videoRenderer / shortsLockup 等版式）。 */
export function parseYouTubeListContent(content: any): { items: YouTubeHttpListItem[]; continuation: string } {
  const parsed = { items: [] as YouTubeHttpListItem[], continuation: "" };
  visitListNode(content, parsed);

  const dedup = new Map<string, YouTubeHttpListItem>();
  for (const item of parsed.items) {
    if (item.videoId && !dedup.has(item.videoId)) dedup.set(item.videoId, item);
  }
  parsed.items = [...dedup.values()];
  return parsed;
}

function findContinuationItems(response: any): any[] | null {
  for (const collection of [response?.onResponseReceivedActions, response?.onResponseReceivedEndpoints]) {
    if (!Array.isArray(collection)) continue;
    for (const action of collection) {
      const items = action?.appendContinuationItemsAction?.continuationItems;
      if (Array.isArray(items)) return items;
    }
  }
  const gridItems = response?.continuationContents?.gridContinuation?.items;
  if (Array.isArray(gridItems)) return gridItems;
  const sectionItems = response?.continuationContents?.sectionListContinuation?.contents;
  if (Array.isArray(sectionItems)) return sectionItems;
  return null;
}

function captureAuthHeaders(page: any): { headers: Record<string, string>; stop: () => void } {
  const headers: Record<string, string> = {};
  const handler = (request: any) => {
    try {
      if (!String(request.url() || "").includes("/youtubei/v1/")) return;
      const source = request.headers();
      for (const name of ["authorization", "x-goog-authuser", "x-youtube-bootstrap-logged-in"]) {
        if (source[name] && !headers[name]) headers[name] = source[name];
      }
    } catch {}
  };
  page.on("request", handler);
  return {
    headers,
    stop: () => {
      try {
        page.off("request", handler);
      } catch {}
    },
  };
}

async function waitForInnertubeConfig(page: any, timeoutMs: number): Promise<boolean> {
  return page.waitForFunction(() => {
    const cfg = (window as any).ytcfg;
    const data = (window as any).ytInitialData;
    if (!cfg || typeof cfg.get !== "function") return false;
    if (!cfg.get("INNERTUBE_API_KEY")) return false;
    if (!cfg.get("INNERTUBE_CONTEXT_CLIENT_VERSION")) return false;
    return Boolean(data && data.contents);
  }, null, { timeout: timeoutMs }).then(() => true).catch(() => false);
}

function parseChannelSnapshot(raw: any): YouTubeHttpChannel {
  const metadataParts = Array.isArray(raw?.metadataParts) ? raw.metadataParts : [];
  const joined = metadataParts.join(" • ");
  return {
    displayName: String(raw?.displayName || ""),
    channelId: String(raw?.channelId || ""),
    followersText: matchMetric(joined, SUBSCRIBER_PATTERNS) || matchMetric(raw?.legacySubscribers, SUBSCRIBER_PATTERNS),
    postsText: matchMetric(joined, VIDEO_COUNT_PATTERNS) || String(raw?.legacyVideos || "").trim(),
    canonicalUrl: String(raw?.canonicalUrl || ""),
    pageTitle: String(raw?.pageTitle || ""),
  };
}

/**
 * 打开频道页做一次引导：拿 ytcfg、登录态请求头、频道首屏列表和频道指标。
 * 页面拿不到这些内容时抛 YouTubeHttpError，让上层降级。
 */
export async function createYouTubeHttpSession(
  page: any,
  url: string,
  { waitTimeoutMs = 45000, headers: inheritedHeaders = null, requireItems = true }: {
    waitTimeoutMs?: number;
    headers?: Record<string, string> | null;
    requireItems?: boolean;
  } = {},
): Promise<YouTubeHttpSession> {
  if (!page) throw new YouTubeHttpError("HTTP 抓取需要浏览器页面来获取登录态");

  const captured = captureAuthHeaders(page);
  try {
    await gotoWithRetry(page, url, { waitUntil: "domcontentloaded", timeout: waitTimeoutMs });
    await autoAcceptYouTubeConsent(page);

    let ready = await waitForInnertubeConfig(page, waitTimeoutMs);
    if (!ready) {
      // 同意页点掉之后可能需要重新等一次。
      await autoAcceptYouTubeConsent(page);
      ready = await waitForInnertubeConfig(page, 5000);
    }
    if (!ready) {
      const sample = await page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 200)).catch(() => "");
      throw new YouTubeHttpError(`频道页没有加载出 YouTube 配置（${String(sample || "页面为空").slice(0, 160)}）`);
    }

    const snapshot: any = await page.evaluate(() => {
      const cfg = (window as any).ytcfg;
      const get = (key: string) => (cfg && typeof cfg.get === "function" ? cfg.get(key) : undefined);
      const pick = (value: any): string => {
        if (value == null) return "";
        if (typeof value === "string") return value;
        if (typeof value === "number") return String(value);
        if (typeof value === "object") {
          if (typeof value.content === "string") return value.content;
          if (typeof value.simpleText === "string") return value.simpleText;
          if (Array.isArray(value.runs)) return value.runs.map((run: any) => run?.text || "").join("");
        }
        return "";
      };
      const idata = (window as any).ytInitialData || {};
      const tabs = idata?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
      const tabUrlOf = (tab: any) => String(tab?.tabRenderer?.endpoint?.commandMetadata?.webCommandMetadata?.url || "");
      const selected = tabs.find((tab: any) => tab?.tabRenderer?.selected)?.tabRenderer
        || tabs.find((tab: any) => tabUrlOf(tab) && tabUrlOf(tab) === location.pathname)?.tabRenderer
        || tabs[0]?.tabRenderer
        || null;

      const channelMetadata = idata?.metadata?.channelMetadataRenderer || {};
      const pageHeader = idata?.header?.pageHeaderRenderer || {};
      const headerRows = pageHeader?.content?.pageHeaderViewModel?.metadata?.contentMetadataViewModel?.metadataRows || [];
      const metadataParts: string[] = [];
      for (const row of headerRows) {
        for (const part of row?.metadataParts || []) {
          const text = part?.text?.content;
          if (text) metadataParts.push(String(text));
          else if (part?.accessibilityLabel) metadataParts.push(String(part.accessibilityLabel));
        }
      }

      const legacy = idata?.header?.c4TabbedHeaderRenderer || {};
      return {
        config: {
          apiKey: String(get("INNERTUBE_API_KEY") || ""),
          clientName: String(get("INNERTUBE_CONTEXT_CLIENT_NAME") || ""),
          clientVersion: String(get("INNERTUBE_CONTEXT_CLIENT_VERSION") || ""),
          visitorData: String(get("VISITOR_DATA") || ""),
          context: get("INNERTUBE_CONTEXT") || null,
          hl: String(get("HL") || ""),
          gl: String(get("GL") || ""),
        },
        tabUrl: String(selected?.endpoint?.commandMetadata?.webCommandMetadata?.url || ""),
        content: selected?.content || null,
        channel: {
          displayName: pick(pageHeader?.pageTitle) || pick(channelMetadata.title) || pick(legacy?.title) || document.title.replace(/ - YouTube$/, ""),
          channelId: String(channelMetadata.externalId || legacy?.channelId || ""),
          metadataParts,
          legacySubscribers: pick(legacy?.subscriberCountText),
          legacyVideos: pick(legacy?.videosCountText),
          canonicalUrl: location.href,
          pageTitle: document.title,
        },
      };
    });

    const apiKey = String(snapshot?.config?.apiKey || "");
    const clientVersion = String(snapshot?.config?.clientVersion || "");
    if (!apiKey) throw new YouTubeHttpError("没有拿到 INNERTUBE_API_KEY");
    if (!clientVersion) throw new YouTubeHttpError("没有拿到 INNERTUBE_CLIENT_VERSION");

    const context = snapshot?.config?.context || {
      client: {
        clientName: "WEB",
        clientVersion,
        hl: snapshot?.config?.hl || "en",
        gl: snapshot?.config?.gl || "US",
        visitorData: snapshot?.config?.visitorData || "",
      },
    };
    const visitorData = String(snapshot?.config?.visitorData || context?.client?.visitorData || "");
    const config: InnertubeConfig = {
      apiKey,
      clientName: String(snapshot?.config?.clientName || "1"),
      clientVersion,
      visitorData,
      context,
    };

    if (!snapshot?.content) throw new YouTubeHttpError("频道页没有频道内容（可能是登录/同意/错误页）");
    const parsed = parseYouTubeListContent(snapshot.content);
    if (requireItems && !parsed.items.length && !parsed.continuation) {
      throw new YouTubeHttpError("频道页没有解析到视频列表（YouTube 可能改版了）");
    }

    const headers: Record<string, string> = {
      "x-youtube-client-name": config.clientName,
      "x-youtube-client-version": config.clientVersion,
    };
    if (visitorData) headers["x-goog-visitor-id"] = visitorData;
    const authHeaders = inheritedHeaders || captured.headers;
    for (const name of ["authorization", "x-goog-authuser", "x-youtube-bootstrap-logged-in"]) {
      if (authHeaders?.[name]) headers[name] = authHeaders[name];
    }

    return {
      page,
      config,
      headers,
      channel: parseChannelSnapshot(snapshot.channel),
      items: parsed.items,
      continuation: parsed.continuation,
      isShortsTab: /\/shorts$/.test(String(snapshot?.tabUrl || "")),
    };
  } finally {
    captured.stop();
  }
}

async function postInnertube(
  session: YouTubeHttpSession,
  endpoint: string,
  body: any,
  { timeoutMs = 30000 }: { timeoutMs?: number } = {},
): Promise<any> {
  const url = `/youtubei/v1/${endpoint}?key=${encodeURIComponent(session.config.apiKey)}&prettyPrint=false`;
  let response;
  try {
    response = await pageFetch(session.page, url, {
      method: "POST",
      headers: { ...session.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs,
      attempts: 3,
    });
  } catch (error: any) {
    throw new YouTubeHttpError(`${endpoint} 请求失败：${error?.message || error}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new YouTubeHttpError(`${endpoint} 返回 HTTP ${response.status}，登录态可能已失效`);
  }
  if (response.status !== 200) {
    throw new YouTubeHttpError(`${endpoint} 返回 HTTP ${response.status}：${String(response.text || "").slice(0, 200)}`);
  }

  let json: any;
  try {
    json = JSON.parse(response.text);
  } catch {
    throw new YouTubeHttpError(`${endpoint} 返回的不是 JSON：${String(response.text || "").slice(0, 200)}`);
  }
  if (json?.error && !json?.contents && !json?.videoDetails) {
    throw new YouTubeHttpError(`${endpoint} 返回错误：${json.error?.message || JSON.stringify(json.error).slice(0, 200)}`);
  }
  return json;
}

export async function fetchYouTubeContinuation(
  session: YouTubeHttpSession,
  continuation: string,
): Promise<{ items: YouTubeHttpListItem[]; continuation: string }> {
  const response = await postInnertube(session, "browse", { context: session.config.context, continuation });
  const items = findContinuationItems(response);
  if (!items) throw new YouTubeHttpError("browse 响应结构不认识，可能是 YouTube 改了返回格式");
  return parseYouTubeListContent(items);
}

function reachedBeforeRange(items: YouTubeHttpListItem[], sinceTime: number, threshold = 3): boolean {
  let trailing = 0;
  for (let index = items.length - 1; index >= 0 && trailing < threshold; index -= 1) {
    const range = approxRelativePublishedRange(items[index]?.relativeText);
    if (!range || range.latest >= sinceTime) return false;
    trailing += 1;
  }
  return trailing >= threshold;
}

/**
 * 拉取频道列表。limit > 0 时最多取 limit 条；带 since 时按列表里的相对时间提前停止翻页。
 */
export async function collectYouTubeList(
  session: YouTubeHttpSession,
  { limit = 0, sinceTime = null, maxPages = YOUTUBE_MAX_LIST_PAGES }: {
    limit?: number;
    sinceTime?: number | null;
    maxPages?: number;
  } = {},
): Promise<YouTubeHttpListItem[]> {
  const items = [...session.items];
  const seen = new Set(items.map((item) => item.videoId));
  let continuation = session.continuation;
  let pages = 0;

  while (continuation && pages < maxPages) {
    if (limit > 0 && items.length >= limit) break;
    if (sinceTime != null && reachedBeforeRange(items, sinceTime)) break;

    const page = await fetchYouTubeContinuation(session, continuation);
    for (const item of page.items) {
      if (seen.has(item.videoId)) continue;
      seen.add(item.videoId);
      items.push(item);
    }
    continuation = page.continuation;
    pages += 1;
  }

  if (continuation && pages >= maxPages) {
    console.warn(`[YouTube] 列表达到 ${maxPages} 页上限，可能还有更早的内容没有抓取。`);
  }

  return limit > 0 ? items.slice(0, limit) : items;
}

function findPrimaryInfo(next: any): any {
  const contents = next?.contents?.twoColumnWatchNextResults?.results?.results?.contents;
  if (!Array.isArray(contents)) return null;
  return contents.find((node: any) => node?.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer || null;
}

function findSecondaryInfo(next: any): any {
  const contents = next?.contents?.twoColumnWatchNextResults?.results?.results?.contents;
  if (!Array.isArray(contents)) return null;
  return contents.find((node: any) => node?.videoSecondaryInfoRenderer)?.videoSecondaryInfoRenderer || null;
}

function findLikeButton(next: any): any {
  const candidates: Array<{ node: any; path: string }> = [];
  walkWithPath(next, (node, path) => {
    if (node?.accessibilityId === "id.video.like.button") candidates.push({ node, path });
  });
  const preferred = candidates.find((item) => item.path.includes("defaultButtonViewModel") && !item.path.includes("toggledButtonViewModel"));
  return (preferred || candidates[0])?.node || null;
}

function extractLikeCountFromAccessibility(accessibilityText: unknown): string {
  const source = String(accessibilityText || "");
  const english = source.match(/(?:along with|with)\s+([\d,.]+)\s+(?:other people|likes?)/i);
  if (english) return english[1].replace(/[^\d]/g, "");
  const localized = source.match(/([\d.,]+\s*(?:亿|万|千|[KMB])?)\s*(?:人|位)?\s*(?:赞过|点赞|likes?)/i);
  if (localized) {
    const parsed = parseLocalizedNumber(localized[1]);
    return parsed == null ? "" : String(parsed);
  }
  return "";
}

/** 取评论区的 continuation token（视频和 Shorts 的 next 结构一致）。 */
export function findCommentsToken(next: any): string {
  let token = "";
  walk(next, (node) => {
    if (token) return;
    const section = node?.itemSectionRenderer;
    if (!section?.header?.commentsHeaderRenderer) return;
    for (const item of section.contents || []) {
      const candidate = item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
      if (candidate) {
        token = candidate;
        return;
      }
    }
  });
  return token;
}

export function parseCommentsCount(response: any): string {
  let countText = "";
  walk(response, (node) => {
    if (countText) return;
    const text = textOf(node?.commentsHeaderRenderer?.countText);
    if (text) countText = text;
  });
  if (!countText) return "";
  const match = countText.match(/([\d][\d,.\s]*(?:亿|万|千|[KMB])?)\s*(?:条评论|comments?)/i);
  if (match) {
    const parsed = parseLocalizedNumber(match[1]);
    return parsed == null ? "" : String(parsed);
  }
  return /^\d+$/.test(countText.trim()) ? countText.trim() : "";
}

function detectCommentsDisabled(next: any): string {
  let result = "";
  walk(next, (node) => {
    if (result) return;
    const text = textOf(node?.messageRenderer?.text) || textOf(node?.alertRenderer?.text);
    if (COMMENTS_DISABLED_PATTERN.test(text)) result = text.trim();
  });
  return result;
}

/** 从 player/next 响应里取视频指标。player 缺字段时尽量用 next 兜底。 */
export function parseYouTubeVideoDetail(player: any, next: any, videoId: string): YouTubeHttpVideoDetail {
  const details = player?.videoDetails || {};
  const micro = player?.microformat?.playerMicroformatRenderer || {};
  const primary = findPrimaryInfo(next);
  const secondary = findSecondaryInfo(next);
  const viewCountText = textOf(primary?.viewCount?.videoViewCountRenderer?.viewCount);
  const localizedViews = parseLocalizedNumber(viewCountText);

  const microLike = micro?.likeCount;
  let likeText = "";
  if (microLike != null && String(microLike).trim() !== "" && Number(microLike) > 0) {
    likeText = String(Math.trunc(Number(microLike)));
  } else {
    const button = findLikeButton(next);
    likeText = String(button?.title || "").trim() || extractLikeCountFromAccessibility(button?.accessibilityText);
  }

  return {
    videoId,
    title: String(details.title || textOf(micro.title) || textOf(primary?.title) || ""),
    channel: String(details.author || micro.ownerChannelName || ""),
    channelId: String(details.channelId || micro.externalChannelId || ""),
    durationSeconds: String(details.lengthSeconds || micro.lengthSeconds || ""),
    viewCount: String(details.viewCount || micro.viewCount || (localizedViews == null ? "" : String(localizedViews)) || ""),
    viewCountText,
    likeText,
    commentText: "",
    publishDate: String(micro.publishDate || ""),
    uploadDate: String(micro.uploadDate || ""),
    description: textOf(micro.description) || textOf(secondary?.attributedDescription),
    isLive: details.isLiveContent ?? null,
  };
}

/**
 * 取单条视频/Shorts 的详情：player（标题/播放/发布时间/描述）+ next（点赞/评论）。
 * 评论数需要再请求一次 next continuation。
 */
export async function fetchYouTubeVideoDetail(
  session: YouTubeHttpSession,
  videoId: string,
  { commentTimeoutMs = 30000 }: { commentTimeoutMs?: number } = {},
): Promise<YouTubeHttpVideoDetail> {
  const context = session.config.context;
  const player = await postInnertube(session, "player", { context, videoId });
  const next = await postInnertube(session, "next", { context, videoId });
  const detail = parseYouTubeVideoDetail(player, next, videoId);

  if (!detail.title) {
    const status = player?.playabilityStatus?.status || "";
    const reason = player?.playabilityStatus?.reason || "";
    throw new Error(`视频不可用${status ? `（${status}${reason ? `：${reason}` : ""}）` : ""}`);
  }

  const token = findCommentsToken(next);
  if (token) {
    try {
      const comments = await postInnertube(
        session,
        "next",
        { context, continuation: token },
        { timeoutMs: Math.max(5000, Math.min(commentTimeoutMs, 30000)) },
      );
      detail.commentText = parseCommentsCount(comments);
    } catch (error: any) {
      console.warn(`[YouTube] 评论数获取失败 ${videoId}：${error?.message || error}`);
    }
  } else {
    detail.commentText = detectCommentsDisabled(next);
  }

  return detail;
}
