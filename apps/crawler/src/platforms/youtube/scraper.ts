import { dateRangePosition, nowInDisplayTimeZone } from "../../core/time.ts";
import {
  approxRelativePublishedDate,
  approxRelativePublishedRange,
  extractExactViewCount,
  extractListRelativePublished,
  normalizeExactViewCount,
  parseLocalizedNumber,
  parseYouTubeDateText,
  secondsToDuration,
} from "./parse.ts";
import { applyVideoUploadDate, extractVideoDescription, extractVideoUploadDate } from "./jsonld.ts";
import {
  collectShortsList,
  isShortsContentRow,
  normalizeShortsUrl,
  normalizeYouTubeShortResult,
  scrapeOneShort,
  shortRowNeedsRetry,
} from "./shorts.ts";
import type { AccountContext, AccountScrapeResult, PlatformScraper } from "../types.ts";
import { gotoWithRetry } from "../../core/page-http.ts";
import { autoAcceptYouTubeConsent } from "./page.ts";
import {
  collectYouTubeList,
  createYouTubeHttpSession,
  fetchYouTubeContinuation,
  fetchYouTubeVideoDetail,
  YouTubeHttpError,
  YOUTUBE_MAX_LIST_PAGES,
} from "./http.ts";
import type { YouTubeHttpSession, YouTubeHttpVideoDetail } from "./http.ts";

type YouTubeArgs = {
  sinceTime: number | null;
  untilTime: number | null;
  rangeTimeZone: string;
  limit: number;
  commentTimeoutMs: number;
};

function normalizeVideosUrl(input) {
  const url = new URL(input);
  url.search = "";
  url.hash = "";
  const parts = url.pathname.split("/").filter(Boolean);
  const videosIndex = parts.indexOf("videos");
  if (videosIndex >= 0) parts.splice(videosIndex);
  const tabNames = new Set(["featured", "shorts", "streams", "playlists", "community", "channels", "about"]);
  while (parts.length && tabNames.has(parts.at(-1))) parts.pop();
  url.pathname = `/${parts.join("/")}/videos`;
  return url.toString();
}

function slugFromChannelUrl(input) {
  const url = new URL(input);
  const parts = url.pathname.split("/").filter(Boolean);
  const raw = parts.find((p) => p.startsWith("@")) || parts.at(-1) || "youtube-channel";
  return raw.replace(/^@/, "").replace(/[^a-z0-9_-]+/gi, "_").toLowerCase();
}

async function waitForChannelReady(page, timeoutMs = 45000) {
  const ok = await page.waitForFunction(() => {
    const pageText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const header = document.querySelector("yt-page-header-renderer, ytd-c4-tabbed-header-renderer, #page-header");
    const headerText = (header?.innerText || header?.textContent || "").replace(/\s+/g, " ").trim();
    const hasChannelShell = !!document.querySelector('ytd-browse[page-subtype="channels"], yt-page-header-renderer, ytd-c4-tabbed-header-renderer, #page-header');
    const hasMetricText = /订阅者|subscribers?|个视频|videos?/i.test(headerText || pageText);
    const hasVideoGrid = !!document.querySelector('ytd-rich-grid-renderer, ytd-grid-renderer, a[href*="/watch?v="]');
    const loginOrError = /sign in to confirm|登录以确认|This page isn't available|此页面无法使用/i.test(pageText);
    return hasChannelShell && !loginOrError && (hasMetricText || hasVideoGrid);
  }, null, { timeout: timeoutMs }).catch(() => false);

  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  if (!ok) {
    const sample = await page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 400).replace(/[\uD800-\uDBFF]$/, "")).catch(() => "");
    throw new Error(`YouTube 频道页 ${Math.round(timeoutMs / 1000)} 秒内未完成加载。页面内容：${sample}`);
  }
}

async function readChannelMetrics(page, source) {
  return page.evaluate((fallback) => {
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
      if (x.content) return x.content;
      if (x.simpleText) return x.simpleText;
      if (Array.isArray(x.runs)) return x.runs.map((r) => r.text || "").join("");
      return "";
    }

    function clean(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function matchMetric(sourceText, patterns) {
      const chunks = clean(sourceText).split(/\s*[•|]\s*|\n+/).map(clean).filter(Boolean);
      const candidates = chunks.concat(clean(sourceText));
      for (const pattern of patterns) {
        for (const candidate of candidates) {
          const match = candidate.match(pattern);
          if (match) return clean(match[0]);
        }
      }
      return "";
    }

    function metricStringsFromInitialData(idata) {
      const rows = idata?.header?.pageHeaderRenderer?.content?.pageHeaderViewModel?.metadata?.contentMetadataViewModel?.metadataRows || [];
      const parts = [];
      for (const row of rows) {
        for (const part of row.metadataParts || []) {
          const value = textOf(part.text) || part.accessibilityLabel || "";
          if (value) parts.push(value);
        }
      }
      return parts;
    }

    function findJsonMetric(idata, patterns) {
      const preferred = metricStringsFromInitialData(idata).join(" • ");
      const fromHeader = matchMetric(preferred, patterns);
      if (fromHeader) return fromHeader;

      const out = [];
      const seen = new Set();
      function walk(o, path) {
        if (!o || typeof o !== "object" || seen.has(o) || out.length >= 80) return;
        seen.add(o);
        for (const [key, value] of Object.entries(o)) {
          const nextPath = path ? `${path}.${key}` : key;
          if (typeof value === "string" && /(订阅者|subscribers?|个视频|videos?)/i.test(value) && value.length < 160) {
            out.push({ path: nextPath, value });
          } else if (value && typeof value === "object") {
            walk(value, nextPath);
          }
        }
      }
      walk(idata?.header || idata, "");
      out.sort((a, b) => {
        const score = (item) => /header|metadata|pageHeader|contentMetadata/i.test(item.path) ? 0 : 1;
        return score(a) - score(b);
      });
      return matchMetric(out.map((item) => item.value).join(" • "), patterns);
    }

    const idata = extractJsonFromScripts("ytInitialData");
    const header = document.querySelector("yt-page-header-renderer, ytd-c4-tabbed-header-renderer, #page-header");
    const headerText = clean(header?.innerText || header?.textContent || "");
    const bodyHead = clean((document.querySelector('ytd-browse[page-subtype="channels"]')?.innerText || document.body?.innerText || "").slice(0, 2500));
    const subscriberPatterns = [
      /[\d.,]+\s*[KMBkmb万千亿]?\s*(?:位)?订阅者/i,
      /[\d.,]+\s*[KMBkmb万千亿]?\s*subscribers?/i,
    ];
    const videoPatterns = [
      /[\d.,]+\s*[KMBkmb万千亿]?\s*(?:个|部|条)?视频/i,
      /[\d.,]+\s*[KMBkmb万千亿]?\s*videos?/i,
    ];
    const metadata = idata?.metadata?.channelMetadataRenderer || {};
    const displayName = idata?.header?.pageHeaderRenderer?.pageTitle
      || textOf(idata?.header?.pageHeaderRenderer?.content?.pageHeaderViewModel?.title?.dynamicTextViewModel?.text)
      || metadata.title
      || document.title.replace(/ - YouTube$/, "");

    return {
      account: fallback.account,
      profileUrl: fallback.link,
      canonicalUrl: location.href,
      displayName,
      channelId: metadata.externalId || "",
      followersText: matchMetric(headerText, subscriberPatterns) || findJsonMetric(idata, subscriberPatterns) || matchMetric(bodyHead, subscriberPatterns),
      followingText: "",
      postsText: matchMetric(headerText, videoPatterns) || findJsonMetric(idata, videoPatterns) || matchMetric(bodyHead, videoPatterns),
      rawHeaderText: headerText,
      pageTitle: document.title,
    };
  }, source);
}

async function collectVideoList(page, videosUrl, limit, args) {
  await gotoWithRetry(page, videosUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await autoAcceptYouTubeConsent(page);
  await waitForChannelReady(page);
  await page.waitForTimeout(1000);

  const videoMap = new Map();
  let stable = 0;
  let lastCount = 0;
  let consecutiveBeforeRange = 0;

  for (let i = 0; i < 260; i++) {
    const items = await page.evaluate(() => {
      function normalize(href) {
        try {
          const u = new URL(href, location.href);
          const id = u.searchParams.get("v");
          return id ? { id, url: `https://www.youtube.com/watch?v=${id}` } : null;
        } catch {
          return null;
        }
      }

      const out = [];
      const anchors = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/watch?v="]')];
      for (const a of anchors) {
        const n = normalize(a.href);
        if (!n) continue;
        const container = a.closest("ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-rich-grid-media, ytd-video-renderer") || a.parentElement;
        const title = (a.getAttribute("title") || a.getAttribute("aria-label") || a.textContent || "").trim();
        const listText = (container?.innerText || "").trim();
        if (!title && !listText) continue;
        out.push({ ...n, title, listText });
      }

      const dedup = new Map();
      for (const item of out) if (!dedup.has(item.id)) dedup.set(item.id, item);
      return [...dedup.values()];
    });

    let newBeforeRange = 0;
    for (const item of items) {
      if (videoMap.has(item.id)) continue;
      videoMap.set(item.id, item);
      if (args?.sinceTime != null) {
        const relativeText = extractListRelativePublished(item.listText);
        const approxRange = approxRelativePublishedRange(relativeText);
        if (approxRange != null && approxRange.latest < args.sinceTime) newBeforeRange += 1;
        else newBeforeRange = 0;
      }
    }
    consecutiveBeforeRange = newBeforeRange ? consecutiveBeforeRange + newBeforeRange : 0;

    if (limit && videoMap.size >= limit) break;
    if (args?.sinceTime != null && consecutiveBeforeRange >= 3) {
      console.log(`列表中连续遇到 ${consecutiveBeforeRange} 条早于筛选周期的视频，停止继续滚动。`);
      break;
    }
    if (videoMap.size === lastCount) stable += 1;
    else stable = 0;
    lastCount = videoMap.size;
    if (stable >= 16) break;

    await page.evaluate(() => window.scrollBy(0, Math.max(900, window.innerHeight * 2.5)));
    await page.waitForTimeout(1000);
  }

  const mapped = [...videoMap.values()].map((item, index) => {
    const lines = (item.listText || "").split("\n").map((s) => s.trim()).filter(Boolean);
    const duration = /^\d{1,2}:\d{2}(?::\d{2})?$/.test(lines[0] || "") ? lines[0] : "";
    const listTitle = duration ? (lines[1] || item.title || "") : (lines[0] || item.title || "");
    return {
      index: index + 1,
      videoId: item.id,
      url: item.url,
      listTitle,
      durationFromList: duration,
      listViewText: lines.find((s) => s.includes("观看") || /views?/i.test(s)) || "",
      listRelativePublished: lines.find((s) => /前$|ago$/i.test(s)) || "",
      listText: item.listText || "",
    };
  });
  return mapped.filter((item) => {
    if (args?.sinceTime == null) return true;
    const approxRange = approxRelativePublishedRange(item.listRelativePublished);
    return approxRange == null || approxRange.latest >= args.sinceTime;
  }).slice(0, limit || undefined);
}

async function readInitialMetrics(page) {
  const result = await page.evaluate(() => {
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
      if (Array.isArray(x.runs)) return x.runs.map((r) => r.text || "").join("");
      return "";
    }

    function walkFind(obj, pred, limit = 12) {
      const out = [];
      const seen = new Set();
      function walk(o, p) {
        if (!o || typeof o !== "object" || seen.has(o) || out.length >= limit) return;
        seen.add(o);
        if (pred(o, p)) out.push({ path: p, value: o });
        for (const [k, v] of Object.entries(o)) walk(v, p ? `${p}.${k}` : k);
      }
      walk(obj, "");
      return out;
    }

    const pr = extractJsonFromScripts("ytInitialPlayerResponse");
    const idata = extractJsonFromScripts("ytInitialData");
    const primary = idata?.contents?.twoColumnWatchNextResults?.results?.results?.contents?.find((x) => x.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer;
    const likeCandidates = walkFind(primary || idata, (o) => o.iconName === "LIKE" && o.title != null);
    const defaultLike = likeCandidates.find((x) => x.path.includes("defaultButtonViewModel")) || likeCandidates[0] || null;
    const micro = idata?.microformat?.microformatDataRenderer || {};
    const owner = idata?.contents?.twoColumnWatchNextResults?.results?.results?.contents?.find((x) => x.videoSecondaryInfoRenderer)?.videoSecondaryInfoRenderer?.owner?.videoOwnerRenderer;

    return {
      pageTitle: document.title.replace(/ - YouTube$/, ""),
      canonicalUrl: location.href,
      videoTitle: pr?.videoDetails?.title || textOf(primary?.title) || document.title.replace(/ - YouTube$/, ""),
      channel: pr?.videoDetails?.author || textOf(owner?.title) || "",
      channelId: pr?.videoDetails?.channelId || "",
      durationSeconds: pr?.videoDetails?.lengthSeconds || "",
      viewCount: pr?.videoDetails?.viewCount || "",
      viewCountText: textOf(primary?.viewCount?.videoViewCountRenderer?.viewCount) || "",
      shortViewCountText: textOf(primary?.viewCount?.videoViewCountRenderer?.shortViewCount) || "",
      likeText: defaultLike?.value?.title || "",
      likeAccessibilityText: defaultLike?.value?.accessibilityText || "",
      publishDate: micro.publishDate || "",
      uploadDate: micro.uploadDate || "",
      isLiveContent: pr?.videoDetails?.isLiveContent ?? null,
      isPrivate: pr?.videoDetails?.isPrivate ?? null,
      allowRatings: pr?.videoDetails?.allowRatings ?? null,
      jsonLdRaw: Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
        .map((s) => s.textContent || s.innerText || "")
        .filter(Boolean),
    };
  });
  const jsonLdUploadDate = extractVideoUploadDate(result.jsonLdRaw || []);
  const merged = applyVideoUploadDate(result, jsonLdUploadDate);
  delete merged.jsonLdRaw;
  merged.jsonLdUploadDate = jsonLdUploadDate;
  merged.jsonLdDescription = extractVideoDescription(result.jsonLdRaw || []);
  return merged;
}

async function readHoverWatchInfo(page) {
  const target = await page.evaluate(() => {
    function clean(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    const containers = [
      ...document.querySelectorAll("ytd-watch-info-text #info, ytd-watch-info-text yt-formatted-string, #description-inline-expander #info"),
    ];
    const container = containers.find((el) => /观看|views?/i.test(clean(el.textContent || el.innerText || ""))) || null;
    if (!container) return null;

    const viewNode = [...container.querySelectorAll("span, yt-formatted-string")]
      .find((el) => /观看|views?/i.test(clean(el.textContent || el.innerText || ""))) || container;
    viewNode.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = viewNode.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: Math.max(1, Math.min(window.innerWidth - 1, rect.left + Math.min(rect.width / 2, 40))),
      y: Math.max(1, Math.min(window.innerHeight - 1, rect.top + rect.height / 2)),
      watchInfoText: clean(container.textContent || container.innerText || ""),
    };
  }).catch(() => null);

  if (!target) return { hoverMetadataText: "", hoverViewCount: "", hoverPublishDate: "", watchInfoText: "" };

  await page.mouse.move(target.x, target.y).catch(() => {});
  await page.waitForTimeout(900);

  const hoverMetadataText = await page.evaluate(() => {
    function clean(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }
    const tooltips = [...document.querySelectorAll('tp-yt-paper-tooltip, [role="tooltip"], #tooltip')]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: clean(el.textContent || el.innerText || ""),
          visible: rect.width > 0 && rect.height > 0 && !el.hasAttribute("hidden") && !el.classList.contains("hidden"),
        };
      })
      .filter((item) => item.visible && /观看|views?/i.test(item.text));
    return tooltips.find((item) => /\d/.test(item.text) && /[•|]/.test(item.text))?.text || tooltips[0]?.text || "";
  }).catch(() => "");

  return {
    hoverMetadataText,
    hoverViewCount: extractExactViewCount(hoverMetadataText),
    hoverPublishDate: parseYouTubeDateText(hoverMetadataText),
    watchInfoText: target.watchInfoText || "",
  };
}

async function waitForCommentCount(page, maxMs) {
  const start = Date.now();
  const positions = [800, 1100, 1400, 1800, 2300, 3000, 3900, 5100, 6600, 8200];
  let i = 0;
  let last = { commentText: "", commentCandidates: [], y: 0 };
  while (Date.now() - start < maxMs) {
    const y = positions[Math.min(i, positions.length - 1)] + Math.max(0, i - positions.length + 1) * 1200;
    await page.evaluate((scrollY) => window.scrollTo(0, scrollY), y);
    await page.waitForTimeout(i < 2 ? 2200 : 2800);
    last = await page.evaluate(() => {
      const candidates = [...document.querySelectorAll("ytd-comments-header-renderer #count, ytd-comments-header-renderer .count-text, ytd-comments-header-renderer, #comments, ytd-engagement-panel-title-header-renderer #contextual-info")]
        .map((el) => (el.innerText || el.textContent || "").trim())
        .filter(Boolean);
      const lines = document.body.innerText.split("\n").map((s) => s.trim()).filter(Boolean);
      const all = candidates.concat(lines);
      const numeric = all.find((s) => /^\d[\d,.\s]*(条)?评论$/.test(s) || /^[\d,.]+\s+comments?$/i.test(s) || /^[\d.]+\s*[万亿千百KMB]?\s*(条)?评论$/.test(s));
      const disabled = all.find((s) => /评论已关闭|comments are turned off/i.test(s)) || "";
      const generic = all.find((s) => /^评论$|^comments$/i.test(s)) || "";
      return { commentText: numeric || disabled || generic || "", commentCandidates: candidates.slice(0, 6), y: window.scrollY };
    });
    if (/\d/.test(last.commentText) || /评论已关闭|comments are turned off/i.test(last.commentText)) break;
    i += 1;
  }
  return last;
}

async function scrapeOneVideo(page, meta, commentTimeoutMs) {
  const startedAt = new Date().toISOString();
  try {
    await gotoWithRetry(page, meta.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    const top = await readInitialMetrics(page);
    const jsonLdUploadDate = top.jsonLdUploadDate || "";
    delete top.jsonLdUploadDate;
    const jsonLdDescription = top.jsonLdDescription || "";
    delete top.jsonLdDescription;
    let hoverInfo = { hoverMetadataText: "", hoverViewCount: "", hoverPublishDate: "", watchInfoText: "" };
    if (jsonLdUploadDate) {
      console.log(`[JSON-LD] ${meta.index}/${meta.listTitle || ""} 发布时间=${jsonLdUploadDate}`);
    } else {
      console.log(`[JSON-LD] ${meta.index}/${meta.listTitle || ""} 未获取到 uploadDate，走 hover 兜底 ${meta.url}`);
      hoverInfo = await readHoverWatchInfo(page);
    }
    const comments = await waitForCommentCount(page, commentTimeoutMs);
    return { ...meta, ...top, description: jsonLdDescription, ...hoverInfo, ...comments, scrapedAt: startedAt, error: "" };
  } catch (error) {
    return { ...meta, scrapedAt: startedAt, error: error.message };
  }
}

function normalizeYouTubeResult(result, account, scrapedAt) {
  const publishTime = result.uploadDate || result.publishDate || result.hoverPublishDate || parseYouTubeDateText(result.hoverMetadataText) || approxRelativePublishedDate(result.listRelativePublished) || "";
  const exactViewCount = normalizeExactViewCount(result.viewCount) || normalizeExactViewCount(result.hoverViewCount) || extractExactViewCount(result.hoverMetadataText);
  return {
    account,
    index: result.index,
    videoId: result.videoId,
    type: "视频",
    isPinned: false,
    title: result.videoTitle || result.listTitle || "",
    url: result.url,
    publishTime,
    publishTimeRaw: result.publishDate || result.uploadDate || result.hoverMetadataText || result.listRelativePublished || "",
    exposureText: "",
    readText: "",
    playText: exactViewCount || result.viewCountText || result.shortViewCountText || result.listViewText || "",
    likeText: result.likeText || result.likeAccessibilityText || "",
    commentText: result.commentText || "",
    collectText: "",
    shareText: "",
    excerpt: result.description || "",
    duration: secondsToDuration(result.durationSeconds) || result.durationFromList || "",
    channel: result.channel || "",
    scrapedAt: result.scrapedAt || scrapedAt,
    error: result.error || "",
  };
}

type HttpRowMeta = {
  index: number;
  videoId: string;
  url: string;
  listTitle: string;
  durationFromList: string;
  listViewText: string;
  listRelativePublished: string;
};

type HttpRetryTarget = {
  meta: HttpRowMeta;
  session: YouTubeHttpSession;
  isShort: boolean;
};

function httpDetailToBrowserResult(detail: YouTubeHttpVideoDetail) {
  return {
    videoTitle: detail.title,
    viewCount: detail.viewCount,
    viewCountText: detail.viewCountText,
    likeText: detail.likeText,
    commentText: detail.commentText,
    publishDate: detail.publishDate,
    uploadDate: detail.uploadDate,
    description: detail.description,
    durationSeconds: detail.durationSeconds,
    channel: detail.channel,
    isLiveContent: detail.isLive,
  };
}

function shortResultFromDetail(meta: HttpRowMeta, detail: YouTubeHttpVideoDetail, scrapedAt: string) {
  return {
    index: meta.index,
    shortId: meta.videoId,
    url: meta.url,
    shortTitle: detail.title,
    listTitle: meta.listTitle,
    listViewText: meta.listViewText,
    viewCount: detail.viewCount,
    viewCountText: detail.viewCountText,
    likeButtonTitle: detail.likeText,
    commentButtonTitle: detail.commentText,
    publishDate: detail.publishDate,
    uploadDate: detail.uploadDate,
    description: detail.description,
    durationSeconds: detail.durationSeconds,
    channel: detail.channel,
    scrapedAt,
    error: "",
  };
}

/**
 * HTTP 抓取：浏览器打开频道页做一次引导，列表翻页、视频详情和评论数全部走 youtubei 接口。
 * 任何环节失败都会抛出，由 createYouTubeScraper 决定是否降级到页面抓取。
 */
async function scrapeAccountViaHttp(ctx: AccountContext): Promise<AccountScrapeResult> {
  const source = ctx.account;
  const args: YouTubeArgs = {
    sinceTime: ctx.sinceTsMs,
    untilTime: ctx.untilTsMs,
    rangeTimeZone: process.env.SCRAPE_TIMEZONE || "Asia/Shanghai",
    limit: ctx.limit,
    commentTimeoutMs: ctx.commentTimeoutMs ?? 30000,
  };
  const scrapedAt = nowInDisplayTimeZone();
  const waitTimeoutMs = ctx.browserOptions.waitTimeoutMs || 45000;
  const contentRows: any[] = [];
  const retryTargets = new Map<string, HttpRetryTarget>();
  const listLimit = args.sinceTime != null || args.untilTime != null ? 0 : args.limit;

  const videosUrl = normalizeVideosUrl(source.link);
  console.log(`[YouTube] HTTP 打开频道视频页：${source.account} ${videosUrl}`);
  const session = await createYouTubeHttpSession(ctx.page, videosUrl, { waitTimeoutMs });
  const list = (await collectYouTubeList(session, { limit: listLimit, sinceTime: args.sinceTime }))
    .filter((item) => !item.isShort);

  const accountRow: any = {
    account: source.account,
    profileUrl: source.link,
    displayName: session.channel.displayName,
    channelId: session.channel.channelId,
    canonicalUrl: session.channel.canonicalUrl,
    pageTitle: session.channel.pageTitle,
    followersText: session.channel.followersText,
    followingText: "",
    postsText: session.channel.postsText,
    error: "",
    scrapeMode: "http",
  };
  console.log(`[YouTube] HTTP 频道指标：粉丝=${accountRow.followersText || "缺失"} 视频总数=${accountRow.postsText || "缺失"}`);
  console.log(`[YouTube] HTTP 频道 ${source.account} 找到 ${list.length} 个普通视频。`);

  let failedVideos = 0;
  let consecutiveBeforeRange = 0;
  for (const [offset, item] of list.entries()) {
    const meta: HttpRowMeta = {
      index: offset + 1,
      videoId: item.videoId,
      url: `https://www.youtube.com/watch?v=${item.videoId}`,
      listTitle: item.title,
      durationFromList: item.duration,
      listViewText: item.viewText,
      listRelativePublished: item.relativeText,
    };
    retryTargets.set(meta.url, { meta, session, isShort: false });
    process.stdout.write(`[HTTP ${meta.index}/${list.length}] ${String(meta.listTitle || "").slice(0, 90)} ... `);
    try {
      const detail = await fetchYouTubeVideoDetail(session, item.videoId, { commentTimeoutMs: args.commentTimeoutMs });
      const row = normalizeYouTubeResult({ ...meta, ...httpDetailToBrowserResult(detail), scrapedAt }, source.account, scrapedAt);
      const keep = (args.sinceTime == null && args.untilTime == null) || dateRangePosition(row.publishTime, args) === "inside";
      if (keep) contentRows.push(row);
      consecutiveBeforeRange = args.sinceTime != null && !row.error && dateRangePosition(row.publishTime, args) === "before" ? consecutiveBeforeRange + 1 : 0;
      console.log(`${keep ? "保留" : "跳过"} 观看=${detail.viewCount || "缺失"} 点赞=${detail.likeText || "缺失"} 评论=${detail.commentText || "缺失"}`);
      if (args.sinceTime != null && consecutiveBeforeRange >= 3) {
        console.log(`连续遇到 ${consecutiveBeforeRange} 条早于筛选周期的视频，停止继续抓取。`);
        break;
      }
    } catch (error: any) {
      failedVideos += 1;
      consecutiveBeforeRange = 0;
      const message = error?.message || String(error);
      const row = normalizeYouTubeResult({ ...meta, scrapedAt, error: message }, source.account, scrapedAt);
      const keep = (args.sinceTime == null && args.untilTime == null) || dateRangePosition(row.publishTime, args) === "inside";
      if (keep) contentRows.push(row);
      console.log(`错误=${message}`);
    }
  }
  if (list.length > 0 && failedVideos === list.length) {
    throw new YouTubeHttpError("所有普通视频的详情请求都失败了");
  }

  const shortsUrl = normalizeShortsUrl(source.link);
  console.log(`[YouTube] HTTP 打开频道 Shorts 页：${source.account} ${shortsUrl}`);
  const shortsSession = await createYouTubeHttpSession(ctx.page, shortsUrl, {
    waitTimeoutMs,
    headers: session.headers,
    requireItems: false,
  });
  if (!shortsSession.isShortsTab) {
    console.log(`[YouTube] 频道 ${source.account} 没有 Shorts 标签页，跳过 Shorts 抓取。`);
  } else {
    const shortCap = listLimit;
    const shortItems = shortsSession.items.filter((item) => item.isShort);
    const shortSeen = new Set(shortItems.map((item) => item.videoId));
    let shortContinuation = shortsSession.continuation;
    let shortPages = 0;
    let shortIndex = 0;
    let shortAttempted = 0;
    let shortFailed = 0;
    let stopShorts = false;
    let consecutiveBeforeRange = 0;

    if (!shortItems.length && !shortContinuation) {
      throw new YouTubeHttpError("Shorts 标签页没有解析到任何 Shorts");
    }
    console.log(`[YouTube] HTTP 频道 ${source.account} 首批找到 ${shortItems.length} 个 Shorts。`);

    while (!stopShorts) {
      for (; shortIndex < shortItems.length; shortIndex += 1) {
        if (shortCap > 0 && shortAttempted >= shortCap) {
          stopShorts = true;
          break;
        }

        const item = shortItems[shortIndex];
        const meta: HttpRowMeta = {
          index: shortIndex + 1,
          videoId: item.videoId,
          url: `https://www.youtube.com/shorts/${item.videoId}`,
          listTitle: item.title,
          durationFromList: "",
          listViewText: item.viewText,
          listRelativePublished: "",
        };

        const existing = contentRows.find((row) => row.account === source.account && row.url === meta.url && !row.error);
        if (existing) {
          console.log(`[Shorts ${meta.index}/${shortItems.length}] 已存在，跳过 ${meta.url}`);
          consecutiveBeforeRange = args.sinceTime != null && dateRangePosition(existing.publishTime, args) === "before" ? consecutiveBeforeRange + 1 : 0;
          if (args.sinceTime != null && consecutiveBeforeRange >= 3) {
            console.log(`连续遇到 ${consecutiveBeforeRange} 条早于筛选周期的 Shorts，停止继续抓取。`);
            stopShorts = true;
            break;
          }
          continue;
        }

        shortAttempted += 1;
        retryTargets.set(meta.url, { meta, session: shortsSession, isShort: true });
        process.stdout.write(`[Shorts ${meta.index}/${shortItems.length}] ${String(meta.listTitle || "").slice(0, 90)} ... `);
        try {
          const detail = await fetchYouTubeVideoDetail(shortsSession, item.videoId, { commentTimeoutMs: args.commentTimeoutMs });
          const row = normalizeYouTubeShortResult(shortResultFromDetail(meta, detail, scrapedAt), source.account, scrapedAt);
          const keep = (args.sinceTime == null && args.untilTime == null) || dateRangePosition(row.publishTime, args) === "inside";
          if (keep) contentRows.push(row);
          consecutiveBeforeRange = args.sinceTime != null && !row.error && dateRangePosition(row.publishTime, args) === "before" ? consecutiveBeforeRange + 1 : 0;
          console.log(`${keep ? "保留" : "跳过"} 播放=${detail.viewCount || "缺失"} 点赞=${row.likeText || "缺失"} 评论=${row.commentText || "缺失"}`);
          if (args.sinceTime != null && consecutiveBeforeRange >= 3) {
            console.log(`连续遇到 ${consecutiveBeforeRange} 条早于筛选周期的 Shorts，停止继续抓取。`);
            stopShorts = true;
            break;
          }
        } catch (error: any) {
          shortFailed += 1;
          const message = error?.message || String(error);
          const row = normalizeYouTubeShortResult({ ...meta, shortId: meta.videoId, scrapedAt, error: message }, source.account, scrapedAt);
          const keep = (args.sinceTime == null && args.untilTime == null) || dateRangePosition(row.publishTime, args) === "inside";
          if (keep) contentRows.push(row);
          consecutiveBeforeRange = 0;
          console.log(`错误=${message}`);
        }
      }

      if (stopShorts) break;
      if (shortCap > 0 && shortAttempted >= shortCap) break;
      if (!shortContinuation || shortPages >= YOUTUBE_MAX_LIST_PAGES) break;

      const page = await fetchYouTubeContinuation(shortsSession, shortContinuation);
      let added = 0;
      for (const item of page.items) {
        if (!item.isShort || shortSeen.has(item.videoId)) continue;
        shortSeen.add(item.videoId);
        shortItems.push(item);
        added += 1;
      }
      shortContinuation = page.continuation;
      shortPages += 1;
      if (!added && !shortContinuation) break;
    }

    if (shortAttempted > 0 && shortFailed === shortAttempted) {
      throw new YouTubeHttpError("所有 Shorts 的详情请求都失败了");
    }
    if (shortContinuation && shortPages >= YOUTUBE_MAX_LIST_PAGES) {
      console.warn(`[YouTube] Shorts 列表达到 ${YOUTUBE_MAX_LIST_PAGES} 页上限，可能还有更早的 Shorts 没有抓取。`);
    }
  }

  console.log(`[YouTube] HTTP 正在重试 ${source.account} 缺失数据的行，如果没有缺失会自动跳过。`);
  for (let round = 1; round <= 2; round++) {
    const retryRows = contentRows.filter((row) => {
      if (row.account !== source.account) return false;
      if (isShortsContentRow(row)) return shortRowNeedsRetry(row);
      return Boolean(row.error)
        || parseLocalizedNumber(row.playText) == null
        || parseLocalizedNumber(row.likeText) == null
        || parseLocalizedNumber(row.commentText) == null;
    });
    if (!retryRows.length) break;
    console.log(`[YouTube] HTTP 第 ${round} 轮重试：${retryRows.length} 行`);
    for (const row of retryRows) {
      const target = retryTargets.get(row.url);
      if (!target) continue;
      try {
        const detail = await fetchYouTubeVideoDetail(target.session, target.meta.videoId, {
          commentTimeoutMs: args.commentTimeoutMs + 15000,
        });
        const normalized = target.isShort
          ? normalizeYouTubeShortResult(shortResultFromDetail(target.meta, detail, row.scrapedAt), source.account, row.scrapedAt)
          : normalizeYouTubeResult({ ...target.meta, ...httpDetailToBrowserResult(detail), scrapedAt: row.scrapedAt }, source.account, row.scrapedAt);
        const index = contentRows.indexOf(row);
        if (index >= 0) contentRows[index] = normalized;
      } catch {}
    }
  }

  const visibleRows = contentRows.filter((row) => !row.error);
  if (visibleRows.length && visibleRows.every((row) => parseLocalizedNumber(row.playText) == null)) {
    throw new YouTubeHttpError("HTTP 没有取到任何播放量，YouTube 接口字段可能已变化");
  }

  if (!accountRow.postsText) accountRow.postsText = String(contentRows.filter((row) => row.account === source.account).length);
  return { accountRow, contentRows };
}

export function createYouTubeScraper(): PlatformScraper {
  return {
    code: "youtube",
    name: "YouTube",
    async scrapeAccount(ctx: AccountContext): Promise<AccountScrapeResult> {
      const mode = youtubeHttpMode();
      if (mode !== "browser") {
        try {
          const result = await scrapeAccountViaHttp(ctx);
          console.log(`[YouTube] HTTP 抓取完成：${ctx.account.account}`);
          return result;
        } catch (error: any) {
          if (mode === "http") throw error;
          console.warn(`[YouTube] HTTP 抓取失败，降级到浏览器页面抓取：${error?.message || error}`);
        }
      }
      return scrapeAccountViaBrowser(ctx);
    },
  };
}

function youtubeHttpMode(): "auto" | "http" | "browser" {
  const raw = String(process.env.YOUTUBE_HTTP_MODE || "").trim().toLowerCase();
  if (!raw || raw === "auto") return "auto";
  if (raw === "http" || raw === "only" || raw === "innertube") return "http";
  if (raw === "browser" || raw === "page" || raw === "off") return "browser";
  console.warn(`[YouTube] 未知 YOUTUBE_HTTP_MODE=${raw}，按 auto 处理`);
  return "auto";
}

async function scrapeAccountViaBrowser(ctx: AccountContext): Promise<AccountScrapeResult> {
  const source = ctx.account;
  const args: YouTubeArgs = {
    sinceTime: ctx.sinceTsMs,
    untilTime: ctx.untilTsMs,
    rangeTimeZone: process.env.SCRAPE_TIMEZONE || "Asia/Shanghai",
    limit: ctx.limit,
    commentTimeoutMs: ctx.commentTimeoutMs ?? 30000,
  };
  const scrapedAt = nowInDisplayTimeZone();
  const contentRows: any[] = [];
  const accountRow: any = {
    account: source.account,
    profileUrl: source.link,
    followersText: "",
    followingText: "",
    postsText: "",
    error: "",
  };

  const videosUrl = normalizeVideosUrl(source.link);
  console.log(`正在打开频道视频页：${source.account} ${videosUrl}`);
  const listLimit = args.sinceTime != null || args.untilTime != null ? 0 : args.limit;
  const list = await collectVideoList(ctx.page, videosUrl, listLimit, args);
  const channelMetrics = await readChannelMetrics(ctx.page, source).catch((error) => ({ error: error.message }));
  Object.assign(accountRow, {
    ...channelMetrics,
    account: source.account,
    profileUrl: source.link,
    error: channelMetrics.error || "",
  });
  console.log(`频道指标：粉丝=${accountRow.followersText || "缺失"} 视频总数=${accountRow.postsText || "缺失"}`);
  console.log(`频道 ${source.account} 找到 ${list.length} 个普通视频。`);

  for (const meta of list) {
    process.stdout.write(`[${meta.index}/${list.length}] ${String(meta.listTitle || "").slice(0, 90)} ... `);
    const result = await scrapeOneVideo(ctx.page, meta, args.commentTimeoutMs);
    const row = normalizeYouTubeResult(result, source.account, scrapedAt);
    const keep = (args.sinceTime == null && args.untilTime == null) || dateRangePosition(row.publishTime, args) === "inside";
    if (keep) contentRows.push(row);
    const views = result.viewCount || "缺失";
    const likes = result.likeText || "缺失";
    const comments = result.commentText || "缺失";
    console.log(`${keep ? "保留" : "跳过"} 观看=${views} 点赞=${likes} 评论=${comments}${result.error ? ` 错误=${result.error}` : ""}`);
  }

  const shortsUrl = normalizeShortsUrl(source.link);
  console.log(`正在打开频道 Shorts 页：${source.account} ${shortsUrl}`);
  const shortsList = await collectShortsList(ctx.page, shortsUrl, listLimit, args);
  if (!shortsList.hasShortsTab) {
    console.log(`频道 ${source.account} 没有 Shorts 标签页，跳过 Shorts 抓取。`);
  } else {
    console.log(`频道 ${source.account} 找到 ${shortsList.items.length} 个 Shorts。`);
    let consecutiveBeforeRange = 0;
    for (const meta of shortsList.items) {
      const existing = contentRows.find((row) => row.account === source.account && row.url === meta.url && !row.error);
      if (existing) {
        console.log(`[Shorts ${meta.index}/${shortsList.items.length}] 已存在，跳过 ${meta.url}`);
        consecutiveBeforeRange = args.sinceTime != null && dateRangePosition(existing.publishTime, args) === "before" ? consecutiveBeforeRange + 1 : 0;
        if (args.sinceTime != null && consecutiveBeforeRange >= 3) {
          console.log(`连续遇到 ${consecutiveBeforeRange} 条早于筛选周期的 Shorts，停止继续抓取。`);
          break;
        }
        continue;
      }
      process.stdout.write(`[Shorts ${meta.index}/${shortsList.items.length}] ${String(meta.listTitle || "").slice(0, 90)} ... `);
      const result = await scrapeOneShort(ctx.page, meta);
      const row = normalizeYouTubeShortResult(result, source.account, scrapedAt);
      const keep = (args.sinceTime == null && args.untilTime == null) || dateRangePosition(row.publishTime, args) === "inside";
      if (keep) contentRows.push(row);
      consecutiveBeforeRange = args.sinceTime != null && !row.error && dateRangePosition(row.publishTime, args) === "before" ? consecutiveBeforeRange + 1 : 0;
      console.log(`${keep ? "保留" : "跳过"} 播放=${result.viewCount || "缺失"} 点赞=${row.likeText || "缺失"} 评论=${row.commentText || "缺失"}${result.error ? ` 错误=${result.error}` : ""}`);
      if (args.sinceTime != null && consecutiveBeforeRange >= 3) {
        console.log(`连续遇到 ${consecutiveBeforeRange} 条早于筛选周期的 Shorts，停止继续抓取。`);
        break;
      }
    }
  }

  console.log(`正在重试 ${source.account} 缺失数据的行，如果没有缺失会自动跳过。`);
  for (let round = 1; round <= 2; round++) {
    const retryRows = contentRows.filter((row) =>
      row.account === source.account &&
      !isShortsContentRow(row) &&
      (row.error || parseLocalizedNumber(row.playText) == null || parseLocalizedNumber(row.likeText) == null || parseLocalizedNumber(row.commentText) == null)
    );
    if (!retryRows.length) break;
    console.log(`第 ${round} 轮重试：${retryRows.length} 行`);
    for (const row of retryRows) {
      const fresh = await scrapeOneVideo(ctx.page, row, args.commentTimeoutMs + 15000);
      const normalized = normalizeYouTubeResult(fresh, source.account, scrapedAt);
      const index = contentRows.findIndex((item) => item.account === source.account && item.url === row.url);
      if (index >= 0) contentRows[index] = normalized;
    }
  }

  if (shortsList.hasShortsTab) {
    console.log(`正在重试 ${source.account} 缺失数据的 Shorts，如果没有缺失会自动跳过。`);
    for (let round = 1; round <= 2; round++) {
      const retryRows = contentRows.filter((row) => row.account === source.account && isShortsContentRow(row) && shortRowNeedsRetry(row));
      if (!retryRows.length) break;
      console.log(`Shorts 第 ${round} 轮重试：${retryRows.length} 行`);
      for (const row of retryRows) {
        const fresh = await scrapeOneShort(ctx.page, row);
        const normalized = normalizeYouTubeShortResult(fresh, source.account, scrapedAt);
        const index = contentRows.findIndex((item) => item.account === source.account && item.url === row.url);
        if (index >= 0) contentRows[index] = normalized;
      }
    }
  }

  if (!accountRow.postsText) accountRow.postsText = String(contentRows.filter((row) => row.account === source.account).length);
  accountRow.scrapeMode = "browser";
  return { accountRow, contentRows };
}
