import { nowInDisplayTimeZone } from "../../core/time.ts";
import { truncateText } from "../../core/strings.ts";
import { pageFetch } from "../../core/page-http.ts";
import { FatalPlatformError } from "../errors.ts";
import type { AccountContext, AccountScrapeResult, PlatformScraper } from "../types.ts";

const FORWARDED_HEADERS = [
  "authorization",
  "x-csrf-token",
  "x-twitter-active-user",
  "x-twitter-auth-type",
  "x-twitter-client-language",
  "x-client-transaction-id",
  "content-type",
  "accept",
];

type XArgs = {
  sinceTime: number | null;
  untilTime: number | null;
  limit: number;
  waitTimeoutMs: number;
  requireLogin: boolean;
};

function isFatalAccountError(error) {
  const message = String(error?.message || error || "");
  return /未登录|登录 X|无法连接到 Chrome/i.test(message);
}

async function assertLoggedIn(page) {
  const state = await page.evaluate(() => {
    const body = document.body?.innerText || "";
    const loginForm = !!document.querySelector('input[name="text"], input[name="password"], a[href="/login"], a[href*="/i/flow/login"]');
    const loginGate = /Sign in to X|Log in to X|登录 X|注册 X|Sign up for X/i.test(body);
    const loggedInNav = !!document.querySelector('a[href="/home"], a[href="/notifications"], a[href="/messages"], [data-testid="SideNav_AccountSwitcher_Button"]');
    return { loginForm, loginGate, loggedInNav, sample: body.split("\n").slice(0, 14).join(" / ") };
  });
  if ((state.loginForm || state.loginGate) && !state.loggedInNav) {
    throw new Error([
      "当前 X 浏览器未登录，已停止抓取。",
      "请先运行 pnpm run x:open-browser，在打开的窗口里登录 X。",
      `页面状态：${state.sample}`,
    ].join("\n"));
  }
}

// 账号资料沿用 x.ts 的 DOM 读取方式（JSON-LD + 页面文本），保证账号指标口径不变。
async function collectProfile(page, source) {
  return page.evaluate((fallbackAccount) => {
    function text(el) {
      return (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
    }
    function asArray(value) {
      if (Array.isArray(value)) return value;
      return value == null ? [] : [value];
    }
    function parseProfileSchema() {
      const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
      for (const script of scripts) {
        try {
          const json = JSON.parse(script.textContent || "{}");
          const entity = json.mainEntity || json;
          const stats = asArray(entity.interactionStatistic);
          const pickCount = (typePattern, namePattern) => {
            const stat = stats.find((item) => {
              const type = String(item?.interactionType || "");
              const name = String(item?.name || "");
              return typePattern.test(type) || namePattern.test(name);
            });
            const count = Number(stat?.userInteractionCount);
            return Number.isFinite(count) ? String(count) : "";
          };
          const followersText = pickCount(/FollowAction/i, /^Follows?$/i);
          const followingText = pickCount(/SubscribeAction/i, /^(Friends?|Following)$/i);
          if (followersText || followingText) {
            return {
              displayName: entity.name || "",
              profileUrl: entity.url || "",
              followersText,
              followingText,
            };
          }
        } catch {
          // 忽略异常 JSON-LD，回退到页面文本
        }
      }
      return null;
    }
    function pickNumberWithLabel(rootText, labelPattern) {
      const label = labelPattern.source;
      const before = new RegExp(`([\\d.,]+\\s*[KMBkmb万千亿]?)\\s*(?:${label})`, "i").exec(rootText);
      if (before) return before[1];
      const after = new RegExp(`(?:${label})\\s*([\\d.,]+\\s*[KMBkmb万千亿]?)`, "i").exec(rootText);
      if (after) return after[1];
      return "";
    }
    const header = document.querySelector('[data-testid="UserName"]')?.closest("div") || document.querySelector("main");
    const mainText = text(document.querySelector("main"));
    const title = text(document.querySelector('[data-testid="UserName"]')) || text(document.querySelector("main h2")) || fallbackAccount;
    const schema = parseProfileSchema();
    return {
      account: fallbackAccount,
      displayName: schema?.displayName || title.split("@")[0].trim() || fallbackAccount,
      profileUrl: schema?.profileUrl || location.href,
      followersText: schema?.followersText || pickNumberWithLabel(mainText, /Followers|粉丝|关注者/),
      followingText: schema?.followingText || pickNumberWithLabel(mainText, /Following|正在关注|关注/),
      pageTitle: document.title,
      rawHeaderText: text(header).slice(0, 1200).replace(/[\uD800-\uDBFF]$/, "") || mainText.slice(0, 1200).replace(/[\uD800-\uDBFF]$/, ""),
    };
  }, source.account);
}

// 先挂监听再导航：避免页面在监听挂上之前就发出时间线请求（会等成超时）。
// operation 名 / hash / features / 请求头都取自页面自己发出的那次真实请求。
async function captureTimelineTemplate(page, timeoutMs, navigate) {
  let captured = null;
  let failure = null;
  const handler = async (response) => {
    if (captured || failure) return;
    const url = response.url();
    if (!url.includes("/i/api/graphql/")) return;
    let body;
    try {
      body = await response.json();
    } catch {
      return;
    }
    const instructions = body?.data?.user?.result?.timeline?.timeline?.instructions;
    if (!Array.isArray(instructions)) return;
    const allHeaders = await response.request().allHeaders();
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(allHeaders)) {
      if (FORWARDED_HEADERS.includes(key.toLowerCase())) headers[key] = String(value);
    }
    if (!headers.authorization || !headers["x-csrf-token"]) {
      failure = new Error(`时间线接口请求头不完整（缺少 authorization 或 x-csrf-token）：${Object.keys(headers).join(", ")}`);
      return;
    }
    captured = { url, headers };
  };

  page.on("response", handler);
  try {
    await navigate();
    const deadline = Date.now() + timeoutMs;
    while (!captured && !failure && Date.now() < deadline) {
      await page.waitForTimeout(300);
    }
  } finally {
    page.off("response", handler);
  }
  if (failure) throw failure;
  if (!captured) {
    throw new Error(`等待 X 个人主页时间线接口响应超时（${timeoutMs}ms）：${page.url()}`);
  }
  return captured;
}

function tweetFromItemContent(itemContent) {
  const result = itemContent?.tweet_results?.result;
  if (!result || result.__typename !== "Tweet") return null;
  const source = result.retweeted_status_result?.result || result;
  const legacy = source.legacy || {};
  if (!legacy.id_str) return null;
  const screenName = source.core?.user_results?.result?.core?.screen_name || "";
  return {
    id: legacy.id_str,
    createdAt: legacy.created_at,
    ts: Date.parse(legacy.created_at),
    screenName,
    isRetweet: !!result.retweeted_status_result,
    isQuote: !!legacy.is_quote_status,
    mediaType: legacy.extended_entities?.media?.[0]?.type || legacy.entities?.media?.[0]?.type || "",
    text: String(source.note_tweet?.note_tweet_results?.result?.text || legacy.full_text || "").replace(/\s+/g, " ").trim(),
    likeText: String(legacy.favorite_count ?? ""),
    commentText: String(legacy.reply_count ?? ""),
    shareText: String(legacy.retweet_count ?? ""),
    collectText: String(legacy.bookmark_count ?? ""),
    readText: source.views?.count ? String(source.views.count) : "",
  };
}

function parseTimelineInstructions(instructions) {
  const tweets = [];
  let bottomCursor = null;
  const cursors = [];
  const pushContent = (content, isPinned) => {
    if (content?.cursorType) cursors.push(content.cursorType);
    if (content?.cursorType === "Bottom") bottomCursor = content.value;
    const top = tweetFromItemContent(content?.itemContent);
    if (top) tweets.push({ ...top, isPinned: !!isPinned });
    for (const item of content?.items || []) {
      const tweet = tweetFromItemContent(item?.item?.itemContent);
      if (tweet) tweets.push({ ...tweet, isPinned: false });
    }
  };
  for (const instruction of instructions || []) {
    if (instruction.type === "TimelineAddToModule") {
      for (const item of instruction.moduleItems || []) {
        const tweet = tweetFromItemContent(item?.item?.itemContent);
        if (tweet) tweets.push({ ...tweet, isPinned: false });
      }
    }
    // TimelinePinEntry 用单数 entry 承载置顶帖，其余时间线用 entries 数组。
    if (instruction.entry) pushContent(instruction.entry.content, true);
    for (const entry of instruction.entries || []) pushContent(entry.content, false);
  }
  return { tweets, bottomCursor, cursors };
}

async function fetchTimelinePage(page, template, cursor) {
  const base = new URL(template.url);
  const variables = JSON.parse(base.searchParams.get("variables") || "{}");
  if (cursor) variables.cursor = cursor;
  else delete variables.cursor;
  base.searchParams.set("variables", JSON.stringify(variables));

  const response = await pageFetch(page, base.toString(), { headers: template.headers });

  if (response.status !== 200) {
    throw new Error(`X 时间线接口返回 HTTP ${response.status}：${truncateText(response.text, 300)}`);
  }
  let body;
  try {
    body = JSON.parse(response.text);
  } catch (error) {
    throw new Error(`X 时间线接口响应不是 JSON：${truncateText(response.text, 300)}`);
  }
  const instructions = body?.data?.user?.result?.timeline?.timeline?.instructions;
  if (!Array.isArray(instructions)) {
    throw new Error(`X 时间线接口响应结构不含 timeline instructions：${truncateText(JSON.stringify(body), 300)}`);
  }
  return parseTimelineInstructions(instructions);
}

function toContentRow(tweet, account, index) {
  const type = tweet.isRetweet ? "转帖" : tweet.mediaType === "video" || tweet.mediaType === "animated_gif" ? "视频" : tweet.mediaType === "photo" ? "图片帖" : "帖子";
  return {
    account,
    index,
    type,
    url: `https://x.com/${tweet.screenName}/status/${tweet.id}`,
    tweetId: tweet.id,
    authorHandle: tweet.screenName,
    publishTime: new Date(tweet.ts).toISOString(),
    publishTimePrecision: "second",
    isPinned: !!tweet.isPinned,
    isRetweet: tweet.isRetweet,
    isQuote: tweet.isQuote,
    exposureText: "",
    readText: tweet.readText,
    playText: "",
    likeText: tweet.likeText,
    commentText: tweet.commentText,
    collectText: tweet.collectText,
    shareText: tweet.shareText,
    excerpt: tweet.text,
    visibleText: tweet.text,
    scrapedAt: nowInDisplayTimeZone(),
    error: Number.isFinite(tweet.ts) ? "" : "未识别发布时间",
  };
}

async function scrapeAccountTimeline({ page, account, args, timelineTemplate }) {
  const rows = [];
  const seen = new Set();
  let cursor = null;
  let pages = 0;

  while (true) {
    pages += 1;
    const { tweets, bottomCursor, cursors } = await fetchTimelinePage(page, timelineTemplate, cursor);
    if (!tweets.length && !bottomCursor) {
      console.log(`账号 ${account} 第 ${pages} 页没有帖子且没有下一页 cursor，停止。`);
      break;
    }

    let pageNewest = -Infinity;
    let addedThisPage = 0;
    for (const tweet of tweets) {
      if (!Number.isFinite(tweet.ts)) continue;
      // 置顶帖会被 X 在每一页重复下发，且发布时间可能很早，不能参与「是否已翻到周期起点」的判断。
      if (!tweet.isPinned && tweet.ts > pageNewest) pageNewest = tweet.ts;
      if (seen.has(tweet.id)) continue;
      seen.add(tweet.id);
      addedThisPage += 1;

      if (args.sinceTime != null && tweet.ts < args.sinceTime) {
        console.log(`跳过 早于周期 ${tweet.createdAt} https://x.com/${tweet.screenName}/status/${tweet.id}`);
        continue;
      }
      if (args.untilTime != null && tweet.ts >= args.untilTime) {
        console.log(`跳过 晚于周期 ${tweet.createdAt} https://x.com/${tweet.screenName}/status/${tweet.id}`);
        continue;
      }
      const row = toContentRow(tweet, account, rows.length);
      rows.push(row);
      console.log(`保留 ${row.type} ${row.url} 发布时间=${row.publishTime} 点赞=${row.likeText} 阅读=${row.readText} 评论=${row.commentText} 收藏=${row.collectText} 转帖=${row.shareText}`);
      if (args.limit && rows.length >= args.limit) {
        console.log(`已达到 --limit ${args.limit}，停止翻页。`);
        return { rows, pages };
      }
    }

    console.log(`账号 ${account} 第 ${pages} 页：本页 ${tweets.length} 条，新增 ${addedThisPage} 条，累计保留 ${rows.length} 条，cursor=${cursors.join("/") || "无"}`);
    if (args.sinceTime != null && pageNewest !== -Infinity && pageNewest < args.sinceTime) {
      break;
    }
    if (!bottomCursor || bottomCursor === cursor) {
      break;
    }
    cursor = bottomCursor;
    await page.waitForTimeout(700);
  }

  return { rows, pages };
}

export function createXScraper(): PlatformScraper {
  return {
    code: "x",
    name: "X",
    async scrapeAccount(ctx: AccountContext): Promise<AccountScrapeResult> {
      const source = ctx.account;
      const args: XArgs = {
        sinceTime: ctx.sinceTsMs,
        untilTime: ctx.untilTsMs,
        limit: ctx.limit,
        waitTimeoutMs: 45000,
        requireLogin: true,
      };

      console.log(`正在抓取账号：${source.account} ${source.link}`);
      try {
        const timelineTemplate = await captureTimelineTemplate(ctx.page, args.waitTimeoutMs, async () => {
          await ctx.page.goto(source.link, { waitUntil: "domcontentloaded", timeout: 90000 });
          if (args.requireLogin) await assertLoggedIn(ctx.page);
        });
        console.log(`已捕获时间线接口：${new URL(timelineTemplate.url).pathname.split("/").pop()}`);

        const profile = await collectProfile(ctx.page, source);
        const accountRow = { ...profile, error: "" };
        const stats = await scrapeAccountTimeline({
          page: ctx.page,
          account: source.account,
          args,
          timelineTemplate,
        });
        console.log(`账号 ${source.account} 检测完成：翻页 ${stats.pages} 页，周期内保留 ${stats.rows.length} 条。`);
        return { accountRow, contentRows: stats.rows };
      } catch (error: any) {
        const message = error?.message || String(error);
        if (isFatalAccountError(error)) {
          throw new FatalPlatformError(`X 抓取已停止：${message}`);
        }
        throw error;
      }
    },
  };
}
