import { dateRangePosition, nowInDisplayTimeZone } from "../../core/time.ts";
import { pageFetch } from "../../core/page-http.ts";
import { extractFacebookUfiTexts } from "./ufi.ts";
import type { AccountContext, AccountScrapeResult, PlatformScraper } from "../types.ts";

const STOP_AFTER_BEFORE_RANGE = 3;

type FacebookArgs = {
  sinceTime: number | null;
  untilTime: number | null;
  rangeTimeZone: string;
  limitPages: number;
  maxContents: number;
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeJsonFragment(raw) {
  try { return JSON.parse(`"${raw}"`); } catch { return raw; }
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[1] || "";
  }
  return "";
}

function normalizeFacebookContentUrl(href) {
  try {
    const url = new URL(href, "https://www.facebook.com");
    if (!/(^|\.)facebook\.com$/i.test(url.hostname)) return "";
    if (/\/photo(\.php)?\/?$/i.test(url.pathname) && url.searchParams.get("fbid")) {
      return `${url.origin}${url.pathname}?fbid=${url.searchParams.get("fbid")}`;
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

function normalizeProfileUrl(href) {
  try {
    const url = new URL(href, "https://www.facebook.com");
    if (!/(^|\.)facebook\.com$/i.test(url.hostname)) return "";
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

function handleFromProfileUrl(href) {
  try {
    const url = new URL(href);
    if (/\/profile\.php$/i.test(url.pathname)) return url.searchParams.get("id") || "";
    return decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
  } catch {
    return "";
  }
}

function classifyStory(story) {
  for (const attachment of story.attachments || []) {
    const mediaType = attachment?.media?.__typename || attachment?.styles?.attachment?.media?.__typename || "";
    const styleType = attachment?.styles?.__typename || "";
    if (/Video/i.test(mediaType) || /Video/i.test(styleType)) return "视频";
    if (/Photo|Image/i.test(mediaType) || /Photo|Image/i.test(styleType)) return "图片帖";
  }
  return "帖子";
}

function collectStoryObjects(parsedLine) {
  const out = [];
  const data = parsedLine?.data;
  if (!data || typeof data !== "object") return out;
  if (Array.isArray(data)) {
    for (const item of data) {
      const node = item?.node;
      if (node && node.__typename === "Story") out.push(node);
    }
    return out;
  }
  const node = data.node;
  if (!node || typeof node !== "object") return out;
  if (node.__typename === "Story") out.push(node);
  const timeline = node.timeline_list_feed_units;
  if (timeline && Array.isArray(timeline.edges)) {
    for (const edge of timeline.edges) {
      const story = edge?.node;
      if (story && story.__typename === "Story") out.push(story);
    }
  }
  return out;
}

function findPageInfo(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findPageInfo(item);
      if (found) return found;
    }
    return null;
  }
  if (node.end_cursor && typeof node.has_next_page === "boolean") return node;
  if (node.page_info?.end_cursor) return node.page_info;
  for (const value of Object.values(node)) {
    const found = findPageInfo(value);
    if (found) return found;
  }
  return null;
}

function parseFeedResponse(text) {
  const stories = [];
  let pageInfo = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    const info = findPageInfo(parsed);
    if (info) pageInfo = info;
    stories.push(...collectStoryObjects(parsed));
  }
  return { stories, pageInfo };
}

function extractStoryRow(story, account) {
  const contentStory = story.comet_sections?.content?.story;
  const publishSeconds = Number(
    story.creation_time
    ?? story.comet_sections?.timestamp?.story?.creation_time,
  );
  const url = normalizeFacebookContentUrl(contentStory?.wwwURL || story.permalink_url || "");
  if (!Number.isFinite(publishSeconds) || !url) return null;

  const postId = String(story.post_id || contentStory?.post_id || "");
  const actors = contentStory?.actors || [];
  const ownerUrls = actors.map((a) => normalizeProfileUrl(String(a?.url || ""))).filter(Boolean);
  const ownerUrl = ownerUrls[0] || "";
  const ownerHandle = handleFromProfileUrl(ownerUrl);
  const excerpt = String(contentStory?.message?.text || "");
  const feedbackRoot = story.comet_sections?.feedback?.story?.story_ufi_container?.story
    ?.feedback_context?.feedback_target_with_context?.comet_ufi_summary_and_actions_renderer?.feedback;
  const metrics = extractFacebookUfiTexts(feedbackRoot);
  const publishTsMs = publishSeconds * 1000;

  return {
    account,
    index: 0,
    type: classifyStory(story),
    url,
    postId,
    relativeTimeText: "",
    isPinned: false,
    exposureText: "",
    readText: "",
    playText: metrics.playText,
    likeText: metrics.likeText,
    commentText: metrics.commentText,
    shareText: metrics.shareText,
    excerpt,
    visibleText: excerpt,
    publishTime: new Date(publishTsMs).toISOString(),
    publishTimePrecision: "second",
    publishTimeRaw: String(publishSeconds),
    scrapedAt: nowInDisplayTimeZone(),
    networkSource: "graphql",
    networkPublishTime: new Date(publishTsMs).toISOString(),
    networkPublishTsMs: publishTsMs,
    networkPublishTimeRaw: String(publishSeconds),
    networkPublishTimePrecision: "second",
    networkUrl: url,
    networkPostId: postId,
    ownerHandle,
    ownerUrl,
    ownerUrls,
    ownerName: "",
    error: "",
  };
}

function mergeStoryRow(current, incoming) {
  return {
    ...current,
    likeText: incoming.likeText || current.likeText,
    commentText: incoming.commentText || current.commentText,
    shareText: incoming.shareText || current.shareText,
    playText: incoming.playText || current.playText,
    excerpt: String(incoming.excerpt || "").length > String(current.excerpt || "").length ? incoming.excerpt : current.excerpt,
    visibleText: String(incoming.visibleText || "").length > String(current.visibleText || "").length ? incoming.visibleText : current.visibleText,
    isPinned: Boolean(current.isPinned || incoming.isPinned),
    type: current.type === "帖子" ? incoming.type : current.type,
  };
}

function normalizeFacebookLink(link: string): string {
  try {
    const url = new URL(link);
    if (url.hostname === "facebook.com") url.hostname = "www.facebook.com";
    return url.toString();
  } catch {
    return link;
  }
}

async function bootstrap(page, firstLink) {
  let captured = null;
  const onResponse = async (response) => {
    if (captured) return;
    const url = response.url();
    if (!/facebook\.com\/api\/graphql(?:\/|\?|$)/i.test(url)) return;
    let text = "";
    try { text = await response.text(); } catch { return; }
    if (!text.includes("timeline_list_feed_units")) return;
    const request = response.request();
    captured = {
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      postData: request.postData() || "",
    };
  };
  page.on("response", onResponse);
  try {
    await page.goto(normalizeFacebookLink(firstLink), { waitUntil: "domcontentloaded", timeout: 90000 });
    for (let i = 0; i < 60 && !captured; i++) await page.waitForTimeout(500);
  } finally {
    page.off("response", onResponse);
  }
  const cookies = await page.context().cookies("https://www.facebook.com").catch(() => []);
  if (!cookies.length) console.warn("[http] 未读取到 cookie 列表，继续使用页面当前登录态");
  if (!captured) throw new Error("未能捕获 Facebook feed 请求模板");
  if (!captured.postData.includes("ProfileCometTimelineFeedRefetchQuery")) {
    throw new Error("捕获到的请求模板不是 ProfileCometTimelineFeedRefetchQuery");
  }
  return { cookies, template: captured };
}

/**
 * 在已登录的 Facebook 页面里发 HTTP 请求：
 * - 继承浏览器已有的 cookie / 代理 / TLS；
 * - 不滚动页面、不创建新 DOM。
 */
function profileRequestHeaders() {
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "zh-CN,zh;q=0.9",
  };
}

function feedRequestHeaders(template, lsd) {
  const headers = {
    "content-type": "application/x-www-form-urlencoded",
    "x-fb-lsd": lsd,
    "x-fb-friendly-name": template.headers["x-fb-friendly-name"] || "ProfileCometTimelineFeedRefetchQuery",
    accept: "*/*",
    "accept-language": "zh-CN,zh;q=0.9",
  };
  if (template.headers["x-asbd-id"]) headers["x-asbd-id"] = template.headers["x-asbd-id"];
  return headers;
}

async function fetchProfilePage(page, link) {
  const result = await pageFetch(page, normalizeFacebookLink(link), { headers: profileRequestHeaders() });
  const html = result.text;
  if (result.status !== 200) throw new Error(`打开主页失败：HTTP ${result.status}`);
  if (/\/login|checkpoint/i.test(result.url)) throw new Error("Facebook 登录态失效或需要验证");
  const userId = firstMatch(html, [/"userID":"(\d+)"/]);
  const lsd = firstMatch(html, [/"LSD",\[\],\{"token":"([^"]+)"/]);
  const dtsg = firstMatch(html, [/"DTSGInitialData",\[\],\{"token":"([^"]+)"/]);
  if (!userId) throw new Error("主页 HTML 中没有找到 userID（登录态或页面结构异常）");
  if (!lsd || !dtsg) throw new Error("主页 HTML 中没有找到 LSD / DTSG token");
  const followersRaw = firstMatch(html, [/"text":"([^"]*\\u4f4d\\u7c89\\u4e1d)"/]);
  const followingRaw = firstMatch(html, [/"text":"([^"]*\\u5173\\u6ce8[^"]*\\u4eba)"/]);
  const title = firstMatch(html, [/<title[^>]*>([^<]*)<\/title>/i]);
  return {
    userId,
    lsd,
    dtsg,
    followersText: followersRaw ? decodeJsonFragment(followersRaw) : "",
    followingText: followingRaw ? decodeJsonFragment(followingRaw) : "",
    pageTitle: title ? decodeJsonFragment(title.replace(/&amp;/g, "&")) : "",
  };
}

function buildFeedBody(templatePostData, { userId, cursor, lsd, dtsg }) {
  const params = new URLSearchParams(templatePostData);
  const variables = JSON.parse(params.get("variables") || "{}");
  variables.id = userId;
  variables.cursor = cursor;
  if (!variables.count || variables.count < 10) variables.count = 10;
  params.set("variables", JSON.stringify(variables));
  params.set("lsd", lsd);
  params.set("fb_dtsg", dtsg);
  let sum = 0;
  for (const ch of dtsg) sum += ch.charCodeAt(0);
  params.set("jazoest", `2${sum}`);
  return params.toString();
}

async function fetchFeedPage(page, template, { userId, cursor, lsd, dtsg }) {
  const body = buildFeedBody(template.postData, { userId, cursor, lsd, dtsg });
  const result = await pageFetch(page, template.url, {
    method: "POST",
    headers: feedRequestHeaders(template, lsd),
    body,
  });
  const text = result.text;
  if (result.status !== 200) throw new Error(`GraphQL HTTP ${result.status}`);
  if (/"error":1357054/.test(text)) throw new Error("Facebook 拒绝了请求：1357054（cookie/token 或请求参数失效）");
  if (/"error":\d+/.test(text) && !text.includes("timeline_list_feed_units")) {
    const errorCode = firstMatch(text, [/"error":(\d+)/]);
    throw new Error(`Facebook GraphQL 返回错误 ${errorCode || ""}`.trim());
  }
  return parseFeedResponse(text);
}

async function scrapeFacebookAccount(page, accountRow, template, args) {
  const profile = await fetchProfilePage(page, accountRow.link);
  const rows = new Map();
  let cursor = null;
  let pageCount = 0;
  let consecutiveBefore = 0;
  let seenInside = false;
  let lastPageInfo = null;

  while (true) {
    if (args.limitPages && pageCount >= args.limitPages) break;
    const { stories, pageInfo } = await fetchFeedPage(page, template, {
      userId: profile.userId,
      cursor,
      lsd: profile.lsd,
      dtsg: profile.dtsg,
    });
    lastPageInfo = pageInfo;
    pageCount += 1;

    for (const story of stories) {
      const row = extractStoryRow(story, accountRow.account);
      if (!row) continue;
      const position = dateRangePosition(row.publishTime, args);
      if (position === "inside") {
        seenInside = true;
        consecutiveBefore = 0;
        const key = row.postId || row.url;
        const existing = rows.get(key);
        rows.set(key, existing ? mergeStoryRow(existing, row) : row);
      } else if (position === "before" && seenInside) {
        consecutiveBefore += 1;
      }
    }

    if (args.maxContents && rows.size >= args.maxContents) break;
    if (seenInside && consecutiveBefore >= STOP_AFTER_BEFORE_RANGE) break;
    if (!pageInfo?.end_cursor || pageInfo.has_next_page === false) break;
    cursor = pageInfo.end_cursor;
    await sleep(600 + Math.floor(Math.random() * 400));
  }

  return {
    profile,
    rows: [...rows.values()],
    pages: pageCount,
    hasNext: Boolean(lastPageInfo?.has_next_page),
  };
}

export function createFacebookScraper(): PlatformScraper {
  let template: any = null;

  return {
    code: "facebook",
    name: "Facebook",

    async prepare(ctx) {
      if (!ctx.accounts?.length) throw new Error("Facebook 缺少账号，无法 bootstrap");
      console.log("正在捕获 Facebook feed 请求模板...");
      const boot = await bootstrap(ctx.page, ctx.accounts[0].link);
      template = boot.template;
      console.log("Facebook feed 请求模板已捕获");
    },

    async scrapeAccount(ctx: AccountContext): Promise<AccountScrapeResult> {
      if (!template) throw new Error("Facebook feed 请求模板未初始化");
      const source = ctx.account;
      const args: FacebookArgs = {
        sinceTime: ctx.sinceTsMs,
        untilTime: ctx.untilTsMs,
        rangeTimeZone: process.env.SCRAPE_TIMEZONE || "Asia/Shanghai",
        limitPages: 0,
        maxContents: ctx.limit,
      };

      console.log(`[http] ${source.account} 开始抓取`);
      const result = await scrapeFacebookAccount(ctx.page, source, template, args);
      const accountRow = {
        account: source.account,
        link: source.link,
        profileUrl: source.link,
        followersText: result.profile.followersText,
        followingText: result.profile.followingText,
        externalAccountId: result.profile.userId,
        pageTitle: result.profile.pageTitle,
        scrapedAt: nowInDisplayTimeZone(),
        error: "",
      };
      console.log(`[http] ${source.account}: pages=${result.pages} contents=${result.rows.length}`);
      return { accountRow, contentRows: result.rows };
    },
  };
}
