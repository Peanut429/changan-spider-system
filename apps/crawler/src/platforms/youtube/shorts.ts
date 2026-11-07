// YouTube Shorts 抓取逻辑。
import { gotoWithRetry } from "../../core/page-http.ts";
import { autoAcceptYouTubeConsent } from "./page.ts";
// Shorts 与普通视频的页面结构完全不同：
//   - 列表页 /@channel/shorts 用 shortsLockupViewModel 渲染，只有标题和播放量，没有发布时间
//   - 详情页 /shorts/<id> 没有 JSON-LD，但 ytInitialPlayerResponse.microformat.playerMicroformatRenderer
//     里有精确的 publishDate / uploadDate / viewCount
// 因此列表只负责收集 shortId，发布时间和各项指标都要到详情页读取。

export const SHORTS_CONTENT_TYPE = "短视频";

// Shorts 详情页对「不适用」的点赞数统一记为 -1，其他拿不到的字段留空。
export const SHORTS_LIKE_NOT_APPLICABLE = "-1";

const TAB_NAMES = new Set(["featured", "videos", "shorts", "streams", "playlists", "community", "channels", "about"]);

export function normalizeShortsUrl(input: string): string {
  const url = new URL(input);
  url.search = "";
  url.hash = "";
  const parts = url.pathname.split("/").filter(Boolean);
  const shortsIndex = parts.indexOf("shorts");
  if (shortsIndex >= 0) parts.splice(shortsIndex);
  while (parts.length && TAB_NAMES.has(parts.at(-1))) parts.pop();
  url.pathname = `/${parts.join("/")}/shorts`;
  return url.toString();
}

export function isShortsContentRow(row: any): boolean {
  return row?.type === SHORTS_CONTENT_TYPE;
}

export function shortRowNeedsRetry(row: any): boolean {
  return Boolean(row?.error) || !row?.playText || !row?.likeText || !row?.commentText;
}

function secondsToDuration(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return "";
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function waitForChannelReady(page, timeoutMs = 45000) {
  const ok = await page.waitForFunction(() => {
    const pageText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const header = document.querySelector("yt-page-header-renderer, ytd-c4-tabbed-header-renderer, #page-header");
    const headerText = (header?.innerText || header?.textContent || "").replace(/\s+/g, " ").trim();
    const hasChannelShell = !!document.querySelector('ytd-browse[page-subtype="channels"], yt-page-header-renderer, ytd-c4-tabbed-header-renderer, #page-header');
    const hasMetricText = /订阅者|subscribers?|个视频|videos?/i.test(headerText || pageText);
    const hasGrid = !!document.querySelector('ytd-rich-grid-renderer, ytd-grid-renderer, a[href*="/watch?v="], a[href^="/shorts/"]');
    const loginOrError = /sign in to confirm|登录以确认|This page isn't available|此页面无法使用/i.test(pageText);
    return hasChannelShell && !loginOrError && (hasMetricText || hasGrid);
  }, null, { timeout: timeoutMs }).catch(() => false);

  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  if (!ok) {
    const sample = await page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 400).replace(/[\uD800-\uDBFF]$/, "")).catch(() => "");
    throw new Error(`YouTube Shorts 频道页 ${Math.round(timeoutMs / 1000)} 秒内未完成加载。页面内容：${sample}`);
  }
}

// 频道没有 Shorts 标签页时（例如 changancaymanislands / ChanganChile），访问 /shorts 会落到视频 tab。
// 用 ytInitialData 里被选中的 tab 判断，避免把视频当 shorts 抓取。
async function readShortsTabState(page) {
  return page.evaluate(() => {
    function extractJsonFromScripts(name) {
      for (const s of [...document.scripts].map((x) => x.textContent || "")) {
        const idx = s.indexOf(name);
        if (idx < 0) continue;
        const eq = s.indexOf("=", idx);
        const start = s.indexOf("{", eq);
        if (start < 0) continue;
        let depth = 0;
        let inStr = false;
        let esc = false;
        for (let i = start; i < s.length; i++) {
          const ch = s[i];
          if (inStr) {
            if (esc) esc = false;
            else if (ch === "\\") esc = true;
            else if (ch === '"') inStr = false;
          } else if (ch === '"') inStr = true;
          else if (ch === "{") depth += 1;
          else if (ch === "}") {
            depth -= 1;
            if (depth === 0) {
              try {
                return JSON.parse(s.slice(start, i + 1));
              } catch {}
            }
          }
        }
      }
      return null;
    }

    const idata = extractJsonFromScripts("ytInitialData");
    const tabs = (idata?.contents?.twoColumnBrowseResultsRenderer?.tabs || []).map((t) => ({
      title: t?.tabRenderer?.title || "",
      selected: Boolean(t?.tabRenderer?.selected),
      url: t?.tabRenderer?.endpoint?.commandMetadata?.webCommandMetadata?.url || "",
    }));
    return {
      hasShortsTab: tabs.some((tab) => /\/shorts$/.test(tab.url) && tab.selected),
      tabs,
    };
  });
}

export async function collectShortsList(page, shortsUrl, limit, args) {
  await gotoWithRetry(page, shortsUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await autoAcceptYouTubeConsent(page);
  await waitForChannelReady(page);
  await page.waitForTimeout(1000);

  const tabState = await readShortsTabState(page);
  if (!tabState.hasShortsTab) return { hasShortsTab: false, items: [] };

  const shortMap = new Map();
  let stable = 0;
  let lastCount = 0;

  for (let i = 0; i < 260; i++) {
    const items = await page.evaluate(() => {
      const out = [];
      for (const a of document.querySelectorAll('a[href^="/shorts/"]')) {
        const match = String(a.getAttribute("href") || "").match(/^\/shorts\/([A-Za-z0-9_-]{5,})$/);
        if (!match) continue;
        const container = a.closest("ytm-shorts-lockup-view-model, ytd-rich-item-renderer, ytd-reel-item-renderer") || a.parentElement;
        out.push({
          id: match[1],
          title: (a.getAttribute("title") || "").trim(),
          listText: (container?.innerText || "").trim(),
        });
      }

      const dedup = new Map();
      for (const item of out) {
        const prev = dedup.get(item.id);
        if (!prev) dedup.set(item.id, item);
        else if (!prev.title && item.title) dedup.set(item.id, { ...prev, title: item.title });
      }
      return [...dedup.values()];
    });

    for (const item of items) if (!shortMap.has(item.id)) shortMap.set(item.id, item);

    if (limit && shortMap.size >= limit) break;
    if (shortMap.size === lastCount) stable += 1;
    else stable = 0;
    lastCount = shortMap.size;
    if (stable >= 16) break;

    await page.evaluate(() => window.scrollBy(0, Math.max(900, window.innerHeight * 2.5)));
    await page.waitForTimeout(1000);
  }

  const mapped = [...shortMap.values()].map((item, index) => {
    const lines = (item.listText || "").split("\n").map((s) => s.trim()).filter(Boolean);
    const viewLine = lines.find((s) => s.includes("观看") || /views?/i.test(s)) || "";
    const titleLine = lines.find((s) => s !== viewLine) || "";
    return {
      index: index + 1,
      shortId: item.id,
      url: `https://www.youtube.com/shorts/${item.id}`,
      listTitle: item.title || titleLine || "",
      listViewText: viewLine,
      listText: item.listText || "",
    };
  });
  return { hasShortsTab: true, items: mapped.slice(0, limit || undefined) };
}

async function readShortsMetrics(page) {
  return page.evaluate(() => {
    function extractJsonFromScripts(name) {
      for (const s of [...document.scripts].map((x) => x.textContent || "")) {
        const idx = s.indexOf(name);
        if (idx < 0) continue;
        const eq = s.indexOf("=", idx);
        const start = s.indexOf("{", eq);
        if (start < 0) continue;
        let depth = 0;
        let inStr = false;
        let esc = false;
        for (let i = start; i < s.length; i++) {
          const ch = s[i];
          if (inStr) {
            if (esc) esc = false;
            else if (ch === "\\") esc = true;
            else if (ch === '"') inStr = false;
          } else if (ch === '"') inStr = true;
          else if (ch === "{") depth += 1;
          else if (ch === "}") {
            depth -= 1;
            if (depth === 0) {
              try {
                return JSON.parse(s.slice(start, i + 1));
              } catch {}
            }
          }
        }
      }
      return null;
    }

    function textOf(x) {
      if (!x) return "";
      if (typeof x === "string") return x;
      if (x.simpleText) return x.simpleText;
      if (x.content) return x.content;
      if (Array.isArray(x.runs)) return x.runs.map((r) => r.text || "").join("");
      return "";
    }

    const pr = extractJsonFromScripts("ytInitialPlayerResponse");
    const idata = extractJsonFromScripts("ytInitialData");
    const microformat = pr?.microformat?.playerMicroformatRenderer || {};
    const overlay = idata?.overlay?.reelPlayerOverlayRenderer;
    const reelHeader = overlay?.reelPlayerHeaderSupportedRenderers?.reelPlayerHeaderRenderer;
    const actionBar = overlay?.playerOverlay?.reelPlayerOverlayViewModel?.actionBar?.reelActionBarViewModel?.buttonViewModels || [];
    const likeButton = actionBar
      .find((b) => b.likeButtonViewModel)
      ?.likeButtonViewModel?.toggleButtonViewModel?.toggleButtonViewModel?.defaultButtonViewModel?.buttonViewModel;
    const commentButton = actionBar.find((b) => b.buttonViewModel?.iconName === "SHORTS_COMMENT")?.buttonViewModel;
    const descriptionHeader = (idata?.engagementPanels || [])
      .map((panel) => panel?.engagementPanelSectionListRenderer?.content?.structuredDescriptionContentRenderer?.items?.[0]?.videoDescriptionHeaderRenderer)
      .find(Boolean);
    const factoids = (descriptionHeader?.factoid || [])
      .map((item) => {
        const renderer = item?.factoidRenderer || item?.viewCountFactoidRenderer?.factoid?.factoidRenderer;
        if (!renderer) return null;
        return {
          label: textOf(renderer.label),
          value: textOf(renderer.value),
          accessibilityText: renderer.accessibilityText || "",
        };
      })
      .filter(Boolean);
    const likeFactoid = factoids.find((item) => /^(赞|like|likes)$/i.test(item.label.trim())) || null;

    return {
      pageTitle: document.title,
      canonicalUrl: location.href,
      shortTitle: textOf(microformat.title) || textOf(descriptionHeader?.title),
      channel: microformat.ownerChannelName || "",
      channelId: microformat.externalChannelId || "",
      durationSeconds: microformat.lengthSeconds || "",
      viewCount: microformat.viewCount || "",
      viewCountText: textOf(descriptionHeader?.views),
      publishDate: microformat.publishDate || "",
      uploadDate: microformat.uploadDate || "",
      relativePublishedText: reelHeader?.timestampText?.simpleText || "",
      description: textOf(microformat.description),
      likeButtonTitle: likeButton?.title || "",
      likeButtonAccessibility: likeButton?.accessibilityText || "",
      likeFactoid,
      commentButtonTitle: commentButton?.title || "",
      commentButtonAccessibility: commentButton?.accessibilityText || "",
      isLiveContent: pr?.videoDetails?.isLiveContent ?? null,
    };
  });
}

export async function scrapeOneShort(page, meta) {
  const startedAt = new Date().toISOString();
  try {
    await gotoWithRetry(page, meta.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    const metrics = await readShortsMetrics(page);
    return { ...meta, ...metrics, scrapedAt: startedAt, error: "" };
  } catch (error) {
    return { ...meta, scrapedAt: startedAt, error: error.message };
  }
}

function extractCommentCount(result) {
  const accessibility = String(result.commentButtonAccessibility || "");
  const matched = accessibility.match(/([\d][\d,.\s]*)\s*(?:条评论|comments?)/i);
  if (matched) return matched[1].replace(/[^\d]/g, "");
  const title = String(result.commentButtonTitle || "").trim();
  if (/^\d[\d,.]*\s*[KMBkmb万]?$/i.test(title)) return title;
  return "";
}

function extractLikeText(result) {
  const factoid = result.likeFactoid;
  if (factoid) {
    const value = String(factoid.value || "").trim();
    const accessibility = String(factoid.accessibilityText || "");
    if (/^(不适用|不可用|n\/?a|not applicable)$/i.test(value) || /没有赞|no likes?|likes? (are )?(hidden|unavailable)/i.test(accessibility)) {
      return SHORTS_LIKE_NOT_APPLICABLE;
    }
  }
  for (const candidate of [result.likeButtonTitle, factoid?.value, result.likeButtonAccessibility]) {
    const text = String(candidate || "").trim();
    if (/\d/.test(text) && !/^(赞|like|likes)$/i.test(text)) return text;
  }
  return "";
}

export function normalizeYouTubeShortResult(result, account, scrapedAt) {
  return {
    account,
    index: result.index,
    videoId: result.shortId,
    type: SHORTS_CONTENT_TYPE,
    isPinned: false,
    title: result.shortTitle || result.listTitle || "",
    url: result.url,
    publishTime: result.publishDate || result.uploadDate || "",
    publishTimeRaw: result.uploadDate || result.publishDate || result.relativePublishedText || "",
    exposureText: "",
    readText: "",
    playText: result.viewCount || result.viewCountText || result.listViewText || "",
    likeText: extractLikeText(result),
    commentText: extractCommentCount(result),
    collectText: "",
    shareText: "",
    excerpt: result.description || "",
    duration: secondsToDuration(result.durationSeconds),
    channel: result.channel || "",
    scrapedAt: result.scrapedAt || scrapedAt,
    error: result.error || "",
  };
}
