import { dateRangePosition } from "../../core/time.ts";
import { activityIdsFromRsc, parseRscFeed } from "./rsc-parser.ts";
import { pageFetch } from "../../core/page-http.ts";
import { FatalPlatformError } from "../errors.ts";
import type { AccountContext, AccountScrapeResult, PlatformScraper } from "../types.ts";

type LinkedInArgs = {
  sinceTime: number | null;
  untilTime: number | null;
  rangeTimeZone: string;
  limit: number;
  waitTimeoutMs: number;
};

export function normalizeCompanyPostsUrl(input) {
  const url = new URL(input);
  // 国家子域（de/uk/fr...）和 www 是同一个公司页，但页面内 fetch 会变成跨源；
  // 统一到 www，保证分页请求和页面同源。
  if (/(^|\.)linkedin\.com$/i.test(url.hostname)) {
    url.hostname = "www.linkedin.com";
  }
  url.hash = "";
  url.search = "";
  const parts = url.pathname.split("/").filter(Boolean);
  const companyIndex = parts.indexOf("company");
  if (companyIndex >= 0 && parts[companyIndex + 1]) {
    url.pathname = `/company/${parts[companyIndex + 1]}/posts/`;
    url.searchParams.set("feedView", "all");
  } else if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }
  return url.toString();
}

function isFatalAccountError(error) {
  const message = String(error?.message || error || "");
  return /未登录|登录 LinkedIn|无法连接到 Chrome/i.test(message);
}

// ── 内容行构建（对齐 persistScrapeAccountResult 的字段） ──

function toContentRows(posts, source, args) {
  let rows = posts.map((post) => ({
    account: source.account,
    activityId: post.activityId,
    url: post.url,
    title: "",
    excerpt: post.excerpt || "",
    publishTime: post.publishIso,
    likeText: post.likeCount != null ? String(post.likeCount) : "",
    commentText: post.commentCount != null ? String(post.commentCount) : "",
    shareText: post.repostCount != null ? String(post.repostCount) : "",
    type: "帖子",
  }));
  // 只保留抓取窗口内的内容
  rows = rows.filter((row) => dateRangePosition(row.publishTime, args) === "inside");

  // 注意：之前加的“按正文去重”会误伤——正文抽取是按顺序对齐的，不同帖子可能被抽成同一段
  // 导致被当成重复删掉（BYD 213 → 203 就是被误删了 10 条）。这里先去掉这种不可靠的去重；
  // 真正要“只算当前帖、去掉转发”，需要更可靠的“转发关系”判断（activity 里嵌的 share/ugc
  // 指向另一条 activity），而不是按一个不可靠的正文键去重。

  if (args.limit && rows.length > args.limit) rows = rows.slice(0, args.limit);
  return rows;
}

// ── 账号资料（公司头） ──

// 只取公司页 HTML 里的资料，不渲染页面；这样跳过主页导航时也能拿到 followers。
async function collectProfileFromHtml(page, source) {
  const response = await pageFetch(page, source.link);
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const html = response.text;

  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const followers = text.match(/([\d.,]+\s*万?)\s*位关注者/) || text.match(/([\d.,]+[KMB]?)\s*followers/i);
  const title = html.match(/<title>([^<]*)<\/title>/i);
  const displayName = title ? title[1].split(/[:：]/)[0].trim() : "";

  return {
    ...source,
    displayName: displayName || source.account,
    followersText: followers ? followers[1].trim() : "",
    followingText: "",
    postsText: "",
  };
}

// ── RSC feed 抓取 ──

// 公司动态只需要文字和互动数，不需要图片/视频。整条 feed 滚下来会渲染几百条帖子，
// 图片和视频是页面内存的大头；在请求层直接拦掉，避免渲染进程内存被顶爆。
async function blockHeavyResources(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Fetch.enable", {
    patterns: [
      { urlPattern: "*", resourceType: "Image", requestStage: "Request" },
      { urlPattern: "*", resourceType: "Media", requestStage: "Request" },
      // 原生视频经常走 media.licdn.com 的 XHR/MSE 分片，resourceType 不一定是 Media；
      // 按域名再拦一层，图片/视频/封面都不会进渲染进程。
      { urlPattern: "*media.licdn.com*", requestStage: "Request" },
      { urlPattern: "*video.licdn.com*", requestStage: "Request" },
    ],
  });
  cdp.on("Fetch.requestPaused", (event) => {
    cdp.send("Fetch.failRequest", {
      requestId: event.requestId,
      errorReason: "BlockedByClient",
    }).catch(() => {});
  });
  console.log("已拦截图片/视频请求（只保留文字和互动数），降低页面内存占用。");
}

const PAGINATION_PAGE_SIZE = 10;
const PAGINATION_MIN_DELAY_MS = 3000;
const PAGINATION_MAX_DELAY_MS = 5000;
const PAGINATION_MAX_PAGES = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestPayload(request) {
  try {
    return JSON.parse(request.body).clientArguments?.payload ?? null;
  } catch {
    return null;
  }
}

function sanitizeHeaders(headers) {
  const copy = { ...headers };
  for (const key of ["cookie", "content-length", "host", "connection", "origin"]) {
    delete copy[key];
  }
  return copy;
}

async function waitForPaginationRequest(requests, predicate, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const found = [...requests].reverse().find(predicate);
    if (found) return found;
    await sleep(250);
  }
  return null;
}

function replaceOrganizationId(body, fromOrganizationId, toOrganizationId) {
  if (fromOrganizationId === toOrganizationId) return body;
  return body
    .split(`"organizationId":"${fromOrganizationId}"`).join(`"organizationId":"${toOrganizationId}"`)
    .split(`organizationFeed_${fromOrganizationId}_`).join(`organizationFeed_${toOrganizationId}_`);
}

async function fetchPagination(page, connection, body) {
  const result = await pageFetch(page, connection.url, {
    method: "POST",
    headers: connection.headers,
    body,
  });
  if (result.status !== 200) {
    throw new Error(`LinkedIn 分页请求失败：HTTP ${result.status}`);
  }
  return result.text;
}

function capturePaginationRequests(page, requests) {
  const handler = (req) => {
    if (!/rsc-action\/actions\/pagination/.test(req.url())) return;
    requests.push({
      url: req.url(),
      headers: req.headers(),
      body: req.postData() || "",
      at: Date.now(),
    });
  };
  page.on("request", handler);
  return () => page.off("request", handler);
}

const TEMPLATE_CAPTURE_ATTEMPTS = 3;
const ORGANIZATION_DISCOVERY_ATTEMPTS = 3;
const ACCOUNT_SCRAPE_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;

// 公司页顶卡组件的 componentkey 形如 pages.topCard.<organizationId> / pages.section.StickyTopCard.<organizationId>，
// 这是页面 SSR 里就带的结构化数据，不依赖文案，也不用等分页请求。
async function readCompanyOrganizationId(page) {
  return page.evaluate(() => {
    const keys = [...document.querySelectorAll("[componentkey]")].map((el) => el.getAttribute("componentkey"));
    for (const key of keys) {
      const match = String(key || "").match(/(?:pages\.topCard\.|StickyTopCard\.|organizationFollowDrawer[-.])(\d+)/);
      if (match) return match[1];
    }
    return null;
  });
}

// 打开一个公司页，切一次“最新”，抓一个 count=3 的分页请求作为模板：
//   - initialBody 用来请求每个 organization 的第一页并拿 token；
//   - pageBody 复用同一个结构，翻页时再改 count/startIndex/token。
async function captureTemplateOnce(page, source) {
  const requests = [];
  const detach = capturePaginationRequests(page, requests);
  try {
    await page.goto(source.link, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => null);
    await page.waitForTimeout(3000);
    await ensureSortRecent(page, 15000, () => {
      requests.length = 0;
    });

    const initial = await waitForPaginationRequest(requests, (request) => {
      const payload = requestPayload(request);
      return payload?.count === 3 && !payload.token;
    }, 15000);
    if (!initial) throw new Error("没有捕获到排序后的初始分页请求，无法生成 HTTP 分页模板。");
    const organizationId = String(requestPayload(initial).organizationId);

    console.log(`模板已就绪：organizationId=${organizationId}（count=3 模板，翻页时再改 count/startIndex/token）`);
    return {
      organizationId,
      initialBody: initial.body,
      // 翻页只需要这个结构，scrapeAccountViaHttp 会自己改 count/startIndex/token。
      // 不再等页面发出 count=10 请求，避免页面没滚动/没加载下一页时整条任务挂掉。
      pageBody: initial.body,
      connection: { url: initial.url, headers: sanitizeHeaders(initial.headers) },
    };
  } finally {
    detach();
  }
}

// 模板抓取失败通常是页面/接口还没就绪（15 秒内没等到分页请求），不是账号问题，重试同一页即可。
async function captureTemplate(page, source) {
  let lastError = null;
  for (let attempt = 1; attempt <= TEMPLATE_CAPTURE_ATTEMPTS; attempt++) {
    console.log(`LinkedIn 模板页（第 ${attempt}/${TEMPLATE_CAPTURE_ATTEMPTS} 次）：${source.link}`);
    try {
      return await captureTemplateOnce(page, source);
    } catch (error) {
      lastError = error;
      if (isFatalAccountError(error)) throw error;
      console.error(`模板抓取失败（第 ${attempt}/${TEMPLATE_CAPTURE_ATTEMPTS} 次）：${error.message}`);
      if (attempt < TEMPLATE_CAPTURE_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

// 只有账号还没有 organizationId 时才走这里：打开公司页，从顶卡组件的 componentkey 里读 organizationId。
// 读不到时再退回最早的方案：等页面发出一次分页请求，从 payload 里读。
async function discoverOrganizationIdOnce(page, source) {
  const requests = [];
  const detach = capturePaginationRequests(page, requests);
  try {
    await page.goto(source.link, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => null);
    // 等顶卡渲染出来（有 componentkey）；这是页面结构信号，不用固定 sleep 猜。
    await page.waitForFunction(() => {
      return [...document.querySelectorAll("[componentkey]")]
        .some((el) => /(?:pages\.topCard\.|StickyTopCard\.)/.test(el.getAttribute("componentkey") || ""));
    }, null, { timeout: 15000 }).catch(() => null);
    const organizationIdFromDom = await readCompanyOrganizationId(page);
    if (organizationIdFromDom) {
      return { organizationId: organizationIdFromDom, connection: null };
    }

    const hasOrganizationId = (item) => Boolean(requestPayload(item)?.organizationId);
    let request = await waitForPaginationRequest(requests, hasOrganizationId, 10000);
    if (!request) {
      await page.mouse.move(400, 400).catch(() => {});
      await page.mouse.wheel(0, 1200).catch(() => {});
      request = await waitForPaginationRequest(requests, hasOrganizationId, 10000);
    }
    if (!request) throw new Error(`账号 ${source.account} 没有捕获到分页请求，无法解析 organizationId。`);

    const organizationId = String(requestPayload(request).organizationId);
    return {
      organizationId,
      connection: { url: request.url, headers: sanitizeHeaders(request.headers) },
    };
  } finally {
    detach();
  }
}

async function discoverOrganizationId(page, source) {
  let lastError = null;
  for (let attempt = 1; attempt <= ORGANIZATION_DISCOVERY_ATTEMPTS; attempt++) {
    console.log(`账号 ${source.account} 没有 organizationId，打开主页解析（第 ${attempt}/${ORGANIZATION_DISCOVERY_ATTEMPTS} 次）：${source.link}`);
    try {
      return await discoverOrganizationIdOnce(page, source);
    } catch (error) {
      lastError = error;
      if (isFatalAccountError(error)) throw error;
      console.error(`账号 ${source.account} 解析 organizationId 失败（第 ${attempt}/${ORGANIZATION_DISCOVERY_ATTEMPTS} 次）：${error.message}`);
      if (attempt < ORGANIZATION_DISCOVERY_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

async function scrapeAccountViaHttp(page, source, organizationId, template, connection, args) {
  console.log(`正在抓取账号：${source.account} ${source.link}（organizationId=${organizationId}）`);

  await sleep(PAGINATION_MIN_DELAY_MS + Math.floor(Math.random() * (PAGINATION_MAX_DELAY_MS - PAGINATION_MIN_DELAY_MS)));
  const initialText = await fetchPagination(
    page,
    connection,
    replaceOrganizationId(template.initialBody, template.organizationId, organizationId),
  );

  const initialActivityIds = activityIdsFromRsc(initialText);
  const initialPosts = parseRscFeed(initialText, initialActivityIds);
  const posts = [];
  const seen = new Set();
  for (const post of initialPosts) {
    if (seen.has(post.activityId)) continue;
    seen.add(post.activityId);
    posts.push(post);
  }

  const tokenMatch = initialText.match(/"token":"([^"]+)"/);
  if (!tokenMatch) {
    // 某些公司页的分页 POST 会直接返回整页 RSC，而不是 feed + token；
    // 这种响应里仍然包含首屏帖子，可以按首屏解析，不能再因为缺少 token 失败。
    if (initialPosts.length > 0) {
      console.log(`账号 ${source.account} 没有分页 token，按整页首屏解析 ${initialPosts.length} 条。`);
      return initialPosts;
    }
    // 公司没有任何动态时，接口返回 200 + 空内容：没有 activityId、没有 token，
    // 但响应里会带“还没有动态”这类空状态文案。两者同时成立才是确定的 0 条，不是失败。
    const emptyFeed = /还没有动态|暂无企业快讯|No posts yet|No updates yet|No company updates/i.test(initialText);
    if (initialActivityIds.length === 0 && emptyFeed) {
      console.log(`账号 ${source.account} 没有企业动态，按 0 条记录。`);
      return [];
    }
    throw new Error(`账号 ${source.account} 初始分页响应里没有 token。`);
  }
  let token = tokenMatch[1];
  const expiryMatch = initialText.match(/"tokenExpiryTime":"?(\d+)"?/);
  let tokenExpiryTime = expiryMatch
    ? Number(expiryMatch[1])
    : JSON.parse(template.pageBody)?.clientArguments?.payload?.tokenExpiryTime;
  console.log(`账号 ${source.account} 初始页：${initialPosts.length} 条，token=${token.slice(0, 24)}...`);

  const initialPageSize = Number(JSON.parse(template.initialBody).clientArguments?.payload?.count || 3);
  let startIndex = initialPageSize;
  let emptyStreak = 0;

  for (let pageNo = 1; pageNo <= PAGINATION_MAX_PAGES; pageNo++) {
    const body = JSON.parse(replaceOrganizationId(template.pageBody, template.organizationId, organizationId));
    for (const payload of [
      body.clientArguments?.payload,
      body.paginationRequest?.requestedArguments?.payload,
    ]) {
      if (!payload) continue;
      payload.count = PAGINATION_PAGE_SIZE;
      payload.startIndex = startIndex;
      payload.token = token;
      payload.tokenExpiryTime = String(tokenExpiryTime ?? "");
    }

    await sleep(PAGINATION_MIN_DELAY_MS + Math.floor(Math.random() * (PAGINATION_MAX_DELAY_MS - PAGINATION_MIN_DELAY_MS)));
    const text = await fetchPagination(page, connection, JSON.stringify(body));

    const activityIds = activityIdsFromRsc(text);
    const pagePosts = parseRscFeed(text, activityIds);
    let added = 0;
    let oldestPublishMs = Infinity;
    for (const post of pagePosts) {
      const publishMs = Date.parse(post.publishIso);
      if (Number.isFinite(publishMs)) oldestPublishMs = Math.min(oldestPublishMs, publishMs);
      if (seen.has(post.activityId)) continue;
      seen.add(post.activityId);
      posts.push(post);
      added += 1;
    }

    console.log(
      `第 ${pageNo} 页：startIndex=${startIndex} 返回 ${pagePosts.length} 条，新增 ${added} 条，累计 ${posts.length} 条，`
      + `最早 ${Number.isFinite(oldestPublishMs) ? new Date(oldestPublishMs).toISOString() : "无"}`,
    );

    const nextToken = text.match(/"token":"([^"]+)"/);
    if (nextToken) token = nextToken[1];
    const nextExpiry = text.match(/"tokenExpiryTime":"?(\d+)"?/);
    if (nextExpiry) tokenExpiryTime = Number(nextExpiry[1]);

    if (added === 0) emptyStreak += 1;
    else emptyStreak = 0;

    if (args.sinceTime != null && Number.isFinite(oldestPublishMs) && oldestPublishMs < args.sinceTime) {
      console.log(`已到窗口起点（最早帖子早于 ${new Date(args.sinceTime).toISOString()}），停止。`);
      break;
    }
    if (emptyStreak >= 2) {
      console.log("连续两页没有新内容，停止。");
      break;
    }
    startIndex += PAGINATION_PAGE_SIZE;
  }

  return posts;
}

// 账号级抓取也可能因为慢/限流失败，重试几次再记为失败；不因为单个账号把整条任务带崩。
async function scrapeAccountWithRetry(page, source, organizationId, template, connection, args) {
  let lastError = null;
  for (let attempt = 1; attempt <= ACCOUNT_SCRAPE_ATTEMPTS; attempt++) {
    try {
      const accountRow = await collectProfileFromHtml(page, source);
      await sleep(1000);
      const posts = await scrapeAccountViaHttp(page, source, organizationId, template, connection, args);
      return { accountRow, posts };
    } catch (error) {
      lastError = error;
      if (isFatalAccountError(error)) throw error;
      console.error(`账号 ${source.account} 抓取失败（第 ${attempt}/${ACCOUNT_SCRAPE_ATTEMPTS} 次）：${error.message}`);
      if (attempt < ACCOUNT_SCRAPE_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

// 把公司动态排序切到「最新/最近」。默认是“热门”（相关性抽样，只给一小撮），
// 不切的话拿不到全量时间线。下拉里切“最新”的入口文案是“最近搜索”。
// 注意：sdui 下拉要真实鼠标点击（DOM .click() 不会触发），这里用 Playwright 的 locator.click()。
async function ensureSortRecent(page, waitTimeoutMs = 15000, onBeforeSelectRecent = null) {
  const trigger = page.locator('[role="button"]').filter({ hasText: /^排序条件/ }).first();
  if (!(await trigger.count().catch(() => 0))) {
    throw new Error("未找到 LinkedIn 动态排序控件，无法确认排序状态。");
  }
  const label = (await trigger.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (/最新|最近/.test(label)) {
    console.log("LinkedIn 动态排序已是“最新”。");
    return;
  }

  const recent = page.locator('[role="option"], [role="menuitem"]').filter({ hasText: /最近搜索|最新/ }).first();

  // 重试 3 次。是否切换成功只看排序按钮的文字有没有真的变成“最新/最近”，
  // 不用等待时长来判定成功；等待只用来避免抢跑，失败就抛错，不静默停在“热门”。
  for (let attempt = 1; attempt <= 3; attempt++) {
    await trigger.click();

    await recent.waitFor({ state: "visible", timeout: waitTimeoutMs }).catch(() => null);
    if (!(await recent.count().catch(() => 0))) {
      console.log(`第 ${attempt} 次切换排序：点开后没有出现“最近搜索”选项`);
      await page.keyboard.press("Escape").catch(() => {});
      continue;
    }

    onBeforeSelectRecent?.();
    await recent.click();

    await page.waitForFunction(() => {
      const el = [...document.querySelectorAll('[role="button"]')]
        .find((node) => /^排序条件/.test((node.innerText || "").replace(/\s+/g, " ").trim()));
      return !!el && /最新|最近/.test(el.innerText || "");
    }, null, { timeout: waitTimeoutMs }).catch(() => null);

    const current = (await trigger.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (/最新|最近/.test(current)) {
      console.log(`LinkedIn 动态排序已切换为“最新”（${current}）`);
      await page.waitForTimeout(3000);
      return;
    }
    console.log(`第 ${attempt} 次切换排序：点击后排序按钮仍是“${current}”`);
    await page.keyboard.press("Escape").catch(() => {});
  }

  throw new Error("LinkedIn 动态排序切换失败：点击“最近搜索”后排序按钮没有变成“最新”。");
}

// ── main ──


export function createLinkedInScraper(): PlatformScraper {
  let template: any = null;
  let templateAccount: string | null = null;

  return {
    code: "linkedin",
    name: "LinkedIn",

    async prepare(ctx) {
      if (!ctx.accounts?.length) throw new Error("LinkedIn 缺少账号");
      const companies = ctx.accounts
        .map((account) => ({ ...account, link: normalizeCompanyPostsUrl(account.link) }))
        .filter((account) => /\/company\//i.test(account.link));
      if (!companies.length) throw new Error("LinkedIn 账号列表里没有公司主页（/company/）");
      console.log(`LinkedIn 模板页：${companies[0].link}`);
      template = await captureTemplate(ctx.page, companies[0]);
      templateAccount = companies[0].account;
      console.log(`LinkedIn 模板已就绪：organizationId=${template.organizationId}`);
    },

    async scrapeAccount(ctx: AccountContext): Promise<AccountScrapeResult> {
      if (!template) throw new Error("LinkedIn 模板未初始化");
      const source = { ...ctx.account, link: normalizeCompanyPostsUrl(ctx.account.link) };
      if (!/\/company\//i.test(source.link)) {
        throw new Error(`非公司主页（/company/），RSC 公司动态抓取不支持：${source.link}`);
      }

      const args: LinkedInArgs = {
        sinceTime: ctx.sinceTsMs,
        untilTime: ctx.untilTsMs,
        rangeTimeZone: process.env.SCRAPE_TIMEZONE || "Asia/Shanghai",
        limit: ctx.limit,
        waitTimeoutMs: 45000,
      };

      try {
        let organizationId = source.account === templateAccount ? template.organizationId : "";
        if (!organizationId) {
          const discovered = await discoverOrganizationId(ctx.page, source);
          organizationId = discovered.organizationId;
        }

        const { accountRow, posts } = await scrapeAccountWithRetry(
          ctx.page,
          source,
          organizationId,
          template,
          template.connection,
          args,
        );
        const contentRows = toContentRows(posts, source, args);
        console.log(`账号 ${source.account} 检测完成：发现 ${posts.length} 条帖子，周期内保留 ${contentRows.length} 条。`);
        return { accountRow, contentRows };
      } catch (error: any) {
        if (isFatalAccountError(error)) {
          throw new FatalPlatformError(`LinkedIn 抓取已停止：${error.message}`);
        }
        throw error;
      }
    },
  };
}
