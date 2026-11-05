import { dateRangePosition, formatDateText, nowInDisplayTimeZone } from "../../core/time.ts";
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


function parseLocalizedNumber(value) {
  if (value == null) return null;
  let text = String(value).trim();
  if (!text) return null;
  text = text.replace(/,/g, "").replace(/\s+/g, "");
  const match = text.match(/(\d+(?:\.\d+)?|\.\d+)(亿|万|千|billion|million|thousand|[kmb])?/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  const unit = String(match[2] || "").toLowerCase();
  const multiplier =
    unit === "亿" ? 100000000 :
    unit === "万" ? 10000 :
    unit === "千" || unit === "thousand" || unit === "k" ? 1000 :
    unit === "million" || unit === "m" ? 1000000 :
    unit === "billion" || unit === "b" ? 1000000000 :
    1;
  return Number.isFinite(parsed) ? Math.round(parsed * multiplier) : null;
}

function extractExactViewCount(text) {
  const source = String(text || "").trim();
  if (!source) return "";
  const match = source.match(/([0-9][\d,.\s]*)\s*(?:次观看|views?)/i);
  if (!match) return "";
  const digits = match[1].replace(/[^\d]/g, "");
  return digits || "";
}

function normalizeExactViewCount(value) {
  const source = String(value || "").trim();
  if (/^\d+$/.test(source)) return source;
  return extractExactViewCount(source);
}

function parseYouTubeDateText(text) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (!source) return "";

  const iso = source.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return `${iso[1]}-${String(Number(iso[2])).padStart(2, "0")}-${String(Number(iso[3])).padStart(2, "0")}`;

  const zh = source.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (zh) return `${zh[1]}-${String(Number(zh[2])).padStart(2, "0")}-${String(Number(zh[3])).padStart(2, "0")}`;

  const slash = source.match(/\b(\d{4})\/(\d{1,2})\/(\d{1,2})\b/);
  if (slash) return `${slash[1]}-${String(Number(slash[2])).padStart(2, "0")}-${String(Number(slash[3])).padStart(2, "0")}`;

  const chunks = source.split(/\s*[•|]\s*/).map((s) => s.trim()).filter(Boolean);
  for (const chunk of chunks.length ? chunks : [source]) {
    if (/观看|views?|#/.test(chunk)) continue;
    const cleaned = chunk
      .replace(/^(?:published|premiered|streamed live on|uploaded|发布于|首播开始于|直播开始于)\s*:?\s*/i, "")
      .trim();
    const time = Date.parse(cleaned);
    if (Number.isFinite(time)) return formatDateText(time);
  }
  return "";
}

function extractListRelativePublished(listText) {
  const lines = String(listText || "").split("\n").map((s) => s.trim()).filter(Boolean);
  return lines.find((s) => /前$|ago$/i.test(s)) || "";
}

function approxRelativePublishedTime(text, now = Date.now()) {
  const source = String(text || "").trim().toLowerCase();
  if (!source) return null;
  if (/刚刚|just now|seconds? ago/.test(source)) return now;
  if (/昨天|yesterday/.test(source)) return now - 24 * 60 * 60 * 1000;

  const match = source.match(/(\d+(?:\.\d+)?)\s*(秒|分钟|小时|天|周|星期|个月|月|年|seconds|secs|sec|second|minutes|mins|min|minute|hours|hrs|hr|hour|days|day|weeks|wks|wk|week|months|mos|mo|month|years|yrs|yr|year|s|d|w|h|y)/i);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const unit = match[2].toLowerCase();
  const day = 24 * 60 * 60 * 1000;
  const multiplier =
    /^(秒|second|seconds|sec|secs|s)$/.test(unit) ? 1000 :
    /^(分钟|minute|minutes|min|mins)$/.test(unit) ? 60 * 1000 :
    /^(小时|hour|hours|hr|hrs|h)$/.test(unit) ? 60 * 60 * 1000 :
    /^(天|day|days|d)$/.test(unit) ? day :
    /^(周|星期|week|weeks|wk|wks|w)$/.test(unit) ? 7 * day :
    /^(个月|月|month|months|mo|mos)$/.test(unit) ? 30 * day :
    /^(年|year|years|yr|yrs|y)$/.test(unit) ? 365 * day :
    0;
  return multiplier ? now - n * multiplier : null;
}

function approxRelativePublishedRange(text, now = Date.now()) {
  const source = String(text || "").trim().toLowerCase();
  if (!source) return null;
  if (/刚刚|just now|seconds? ago/.test(source)) return { earliest: now - 60 * 1000, latest: now };
  if (/昨天|yesterday/.test(source)) {
    const day = 24 * 60 * 60 * 1000;
    return { earliest: now - 2 * day, latest: now - day };
  }

  const match = source.match(/(\d+(?:\.\d+)?)\s*(秒|分钟|小时|天|周|星期|个月|月|年|seconds|secs|sec|second|minutes|mins|min|minute|hours|hrs|hr|hour|days|day|weeks|wks|wk|week|months|mos|mo|month|years|yrs|yr|year|s|d|w|h|y)/i);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const unit = match[2].toLowerCase();
  const day = 24 * 60 * 60 * 1000;
  const multiplier =
    /^(秒|second|seconds|sec|secs|s)$/.test(unit) ? 1000 :
    /^(分钟|minute|minutes|min|mins)$/.test(unit) ? 60 * 1000 :
    /^(小时|hour|hours|hr|hrs|h)$/.test(unit) ? 60 * 60 * 1000 :
    /^(天|day|days|d)$/.test(unit) ? day :
    /^(周|星期|week|weeks|wk|wks|w)$/.test(unit) ? 7 * day :
    /^(个月|月|month|months|mo|mos)$/.test(unit) ? 30 * day :
    /^(年|year|years|yr|yrs|y)$/.test(unit) ? 365 * day :
    0;
  if (!multiplier) return null;
  return {
    earliest: now - (n + 1) * multiplier,
    latest: now - n * multiplier,
  };
}

function approxRelativePublishedDate(text) {
  const time = approxRelativePublishedTime(text);
  if (time == null) return "";
  return formatDateText(time);
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

async function autoAcceptYouTubeConsent(page) {
  for (const text of ["Accept all", "I agree", "全部接受", "接受全部"]) {
    const button = page.getByRole("button", { name: text, exact: true });
    if (await button.count().catch(() => 0)) {
      await button.click().catch(() => {});
      await page.waitForTimeout(1000);
      return;
    }
  }
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

export function createYouTubeScraper(): PlatformScraper {
  return {
    code: "youtube",
    name: "YouTube",
    async scrapeAccount(ctx: AccountContext): Promise<AccountScrapeResult> {
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
      return { accountRow, contentRows };
    },
  };
}
