import { dateRangePosition, nowInDisplayTimeZone } from "../../core/time.ts";
import { classifyTikTokPageState, shouldRestartTikTokAccountScrape } from "../../core/tiktok-page-state.ts";
import { truncateText } from "../../core/strings.ts";
import { ensurePlatform } from "../../db/repositories/runs.ts";
import { saveTikTokIdentity } from "../../db/repositories/accounts.ts";
import { FatalPlatformError } from "../errors.ts";
import {
  createTikTokApiClient,
  fetchTikTokPostsPage,
  normalizeTikTokItem,
  resolveTikTokIdentity,
} from "./api.ts";
import type { TikTokApiClient } from "./api.ts";
import type { AccountContext, AccountScrapeResult, PlatformScraper } from "../types.ts";

class TikTokAccountRestartRequired extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TikTokAccountRestartRequired";
  }
}

type TikTokArgs = {
  sinceTime: number | null;
  untilTime: number | null;
  rangeTimeZone: string;
  limit: number;
  waitTimeoutMs: number;
  requireLogin: boolean;
  humanVerificationReloads: number;
  humanVerificationReloadDelayMs: number;
  stableRoundsToStop: number;
};

function accountKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function hasAccountContentMatching(
  contents: any[],
  account: unknown,
  predicate: (row: any) => boolean,
): boolean {
  const key = accountKey(account);
  return (contents || []).some((row) => accountKey(row.account) === key && predicate(row));
}

function normalizeHandle(value) {
  return String(value || "").trim().replace(/^@/, "");
}

function accountFromUrl(input) {
  try {
    const parts = new URL(input).pathname.split("/").filter(Boolean);
    return normalizeHandle((parts.find((p) => p.startsWith("@")) || parts[0] || "").replace(/^@/, ""));
  } catch {
    return normalizeHandle(input);
  }
}

function normalizeProfileUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://www.tiktok.com/@${normalizeHandle(raw)}`;
  const url = new URL(candidate);
  const handle = accountFromUrl(url.toString());
  url.protocol = "https:";
  url.hostname = "www.tiktok.com";
  url.pathname = `/@${handle}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function parseLocalizedNumber(value) {
  if (value == null) return "";
  let text = String(value).trim();
  if (!text || /^[-–—]$/.test(text)) return "";
  text = text.replace(/,/g, "").replace(/\s+/g, "");
  const match = text.match(/(\d+(?:\.\d+)?|\.\d+)(亿|万|千|billion|million|thousand|[kmb])?/i);
  if (!match) return "";
  const parsed = Number(match[1]);
  const unit = String(match[2] || "").toLowerCase();
  const multiplier =
    unit === "亿" ? 100000000 :
    unit === "万" ? 10000 :
    unit === "千" || unit === "thousand" || unit === "k" ? 1000 :
    unit === "million" || unit === "m" ? 1000000 :
    unit === "billion" || unit === "b" ? 1000000000 :
    1;
  return Number.isFinite(parsed) ? Math.round(parsed * multiplier) : "";
}

function idToIso(id) {
  try {
    const seconds = Number(BigInt(String(id)) >> 32n);
    if (!Number.isFinite(seconds) || seconds < 946684800) return "";
    return new Date(seconds * 1000).toISOString();
  } catch {
    return "";
  }
}

function titleFromCaption(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const beforeHash = text.split(/\s+#/)[0].trim();
  const firstSentence = (beforeHash.match(/^.{1,120}?(?:[.!?。！？]|$)/) || [beforeHash])[0].trim();
  return truncateText(firstSentence || beforeHash || text, 120);
}

async function readTikTokPageState(page) {
  const pageState = await page.evaluate(() => {
    const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const body = norm(document.body?.innerText || "");
    const title = document.title || "";
    const url = location.href;
    const hasContentLinks = !!document.querySelector('a[href*="/video/"], a[href*="/photo/"]');
    const userDetailScript = document.querySelector('script#__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent || "";
    const hasUserDetail = userDetailScript.includes("webapp.user-detail");
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
    };
    const attrs = [...document.querySelectorAll("iframe, [id], [class], [src], [data-e2e], [aria-label]")]
      .filter(visible)
      .slice(0, 500)
      .map((el) => [
        el.tagName,
        el.getAttribute("id"),
        el.getAttribute("class"),
        el.getAttribute("src"),
        el.getAttribute("data-e2e"),
        el.getAttribute("aria-label"),
      ].filter(Boolean).join(" "))
      .join(" ");
    const visibleButtons = [...document.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .map((el) => norm([
        el.getAttribute("id"),
        el.getAttribute("class"),
        el.getAttribute("aria-label"),
        el.textContent,
      ].filter(Boolean).join(" ")));
    const hasCaptchaModal = [...document.querySelectorAll("#captcha_close_button, .captcha-verify-container, #captcha-verify-container-main-page")].some(visible)
      || false;
    return {
      url,
      title,
      body,
      bodyLength: body.length,
      attrs,
      visibleButtons,
      hasContentLinks,
      hasUserDetail,
      hasCaptchaModal,
      sample: body.slice(0, 500).replace(/[\uD800-\uDBFF]$/, ""),
    };
  });
  const classification = classifyTikTokPageState(pageState);
  return {
    url: pageState.url,
    title: pageState.title,
    bodyLength: pageState.bodyLength,
    hasContentLinks: pageState.hasContentLinks,
    hasUserDetail: pageState.hasUserDetail,
    ...classification,
    sample: pageState.sample,
  };
}

function tikTokChallengeOptions(args: Record<string, any> = {}) {
  return {
    waitTimeoutMs: Number(args.waitTimeoutMs || 45000),
    reloads: Math.max(0, Number(args.humanVerificationReloads ?? 5)),
    delayMs: Math.max(0, Number(args.humanVerificationReloadDelayMs ?? 2500)),
  };
}

async function waitForTikTokReady(page, timeoutMs) {
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
  await page.waitForFunction(() => {
    const body = document.body?.innerText || "";
    const hasContent = document.querySelector('a[href*="/video/"], a[href*="/photo/"]');
    const hasChallengeText = /complete (the )?verification|verification (is )?required|security check|captcha|not a robot|请完成.*验证|安全验证|人机验证|验证码|拖动.*滑块/i
      .test(`${document.title}\n${body}`);
    const hasChallengeFrame = [...document.querySelectorAll("iframe")]
      .some((el) => /captcha|challenge|verification|verify/i.test(el.getAttribute("src") || ""));
    return /TikTok/i.test(document.title) && (body.length > 100 || hasContent || hasChallengeText || hasChallengeFrame);
  }, null, { timeout: timeoutMs }).catch(() => {});
  const state = await readTikTokPageState(page).catch(() => null);
  if (!state?.needsRecovery) await dismissTikTokLoginPopups(page);
  await page.waitForTimeout(2500);
  return state;
}

async function closeTikTokCaptchaModal(page) {
  const clicked = await page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
    };
    const candidates = [
      document.querySelector("#captcha_close_button"),
      ...document.querySelectorAll('.captcha-verify-container button[aria-label="Close"], #captcha-verify-container-main-page button[aria-label="Close"]'),
    ].filter(Boolean);
    const button = candidates.find(visible);
    if (!button) return false;
    (button as HTMLElement).click();
    return true;
  }).catch(() => false);
  if (clicked) await page.waitForTimeout(1200).catch(() => {});
  return clicked;
}

async function clickTikTokErrorRefresh(page) {
  const clicked = await page.evaluate(() => {
    const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
    };
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible);
    const button = buttons.find((el) => {
      const label = norm(`${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`);
      return /^(Refresh|刷新)$/i.test(label) || /\bRefresh\b/i.test(label);
    });
    if (!button) return false;
    (button as HTMLElement).click();
    return true;
  }).catch(() => false);
  if (clicked) await page.waitForTimeout(1800).catch(() => {});
  return clicked;
}

async function fallbackReloadTikTokPage(page, targetUrl, timeoutMs) {
  if (targetUrl) {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: Math.max(60000, timeoutMs) }).catch(async () => {
      await page.reload({ waitUntil: "domcontentloaded", timeout: Math.max(60000, timeoutMs) }).catch(() => {});
    });
    return;
  }
  await page.reload({ waitUntil: "domcontentloaded", timeout: Math.max(60000, timeoutMs) }).catch(async () => {
    await page.goto(page.url(), { waitUntil: "domcontentloaded", timeout: Math.max(60000, timeoutMs) }).catch(() => {});
  });
}

async function recoverTikTokBlockedPage(page, args, label, targetUrl = "") {
  const { waitTimeoutMs, reloads, delayMs } = tikTokChallengeOptions(args);
  let state = await readTikTokPageState(page).catch(() => null);
  let clickedRefreshDuringRecovery = false;
  for (let attempt = 1; state?.needsRecovery && attempt <= reloads; attempt++) {
    const reason = state.isHumanVerification ? "人机验证" : "错误刷新页";
    console.log(`TikTok ${label} 出现${reason}，恢复重试 ${attempt}/${reloads}。`);
    let acted = false;

    if (state.isHumanVerification) {
      acted = await closeTikTokCaptchaModal(page);
      if (acted) {
        console.log(`TikTok ${label} 已关闭验证弹窗，等待 Refresh 页面。`);
        state = await waitForTikTokReady(page, waitTimeoutMs);
      }
    }

    if (state?.hasRecoverableError) {
      const clickedRefresh = await clickTikTokErrorRefresh(page);
      acted = clickedRefresh || acted;
      if (clickedRefresh) {
        clickedRefreshDuringRecovery = true;
        console.log(`TikTok ${label} 已点击页面 Refresh。`);
      }
    }

    if (!acted) {
      if (delayMs) await page.waitForTimeout(delayMs).catch(() => {});
      await fallbackReloadTikTokPage(page, targetUrl, waitTimeoutMs);
    }

    state = await waitForTikTokReady(page, waitTimeoutMs);
  }
  if (state?.needsRecovery) {
    throw new Error([
      `TikTok ${label} 多次恢复后仍停留在${state.isHumanVerification ? "人机验证页" : "错误刷新页"}。`,
      `页面标题：${state.title || "(空)"}`,
      `页面地址：${state.url || page.url()}`,
      `页面片段：${state.sample || "(空)"}`,
    ].join("\n"));
  }
  return { ...state, clickedRefresh: clickedRefreshDuringRecovery };
}

async function gotoTikTokPage(page, url, args, label) {
  const { waitTimeoutMs, reloads, delayMs } = tikTokChallengeOptions(args);
  let state = null;
  for (let attempt = 0; attempt <= reloads; attempt++) {
    if (attempt > 0) {
      console.log(`TikTok ${label} 出现需恢复页面，重新打开页面 ${attempt}/${reloads}。`);
      if (delayMs) await page.waitForTimeout(delayMs).catch(() => {});
    }
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.max(60000, waitTimeoutMs) });
    state = await waitForTikTokReady(page, waitTimeoutMs);
    if (!state?.needsRecovery) return state;
    state = await recoverTikTokBlockedPage(page, args, label, url);
    if (!state?.needsRecovery) return state;
  }
  throw new Error([
    `TikTok ${label} 多次重新打开后仍停留在需恢复页面。`,
    `页面标题：${state?.title || "(空)"}`,
    `页面地址：${state?.url || page.url()}`,
    `页面片段：${state?.sample || "(空)"}`,
  ].join("\n"));
}

async function dismissTikTokLoginPopups(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(250).catch(() => {});
  for (let round = 0; round < 3; round++) {
    const clicked = await page.evaluate(() => {
      const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const buttonLike = [...document.querySelectorAll('button, [role="button"], [aria-label], [data-e2e]')].filter(visible);
      const labelledClose = buttonLike.find((el) => {
        const label = norm([
          el.getAttribute("aria-label"),
          el.getAttribute("title"),
          el.getAttribute("data-e2e"),
          el.textContent,
        ].filter(Boolean).join(" "));
        return /^(close|关闭|×|x)$/i.test(label)
          || /modal-close|browse-close|close-button/i.test(label)
          || /not now|maybe later|稍后|暂不|以后再说/i.test(label);
      });
      if (labelledClose) {
        (labelledClose as HTMLElement).click();
        return true;
      }

      const dialog = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].find(visible);
      if (!dialog) return false;
      const dialogRect = dialog.getBoundingClientRect();
      const closeByPosition = [...dialog.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .find((el) => {
          const rect = el.getBoundingClientRect();
          const text = norm(`${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`);
          const nearTopRight = rect.left > dialogRect.left + dialogRect.width * 0.62
            && rect.top < dialogRect.top + Math.min(100, dialogRect.height * 0.25);
          const looksIconOnly = text.length <= 8 || !!el.querySelector("svg");
          return nearTopRight && looksIconOnly;
        });
      if (!closeByPosition) return false;
      (closeByPosition as HTMLElement).click();
      return true;
    }).catch(() => false);
    if (!clicked) break;
    await page.waitForTimeout(900).catch(() => {});
  }
}

async function collectProfile(page, source) {
  const pageProfile = await page.evaluate((fallbackAccount) => {
    const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const readUserDetail = () => {
      const script = document.querySelector('script#__UNIVERSAL_DATA_FOR_REHYDRATION__');
      if (!script?.textContent) return null;
      try {
        const data = JSON.parse(script.textContent);
        return data?.__DEFAULT_SCOPE__?.["webapp.user-detail"] || null;
      } catch {
        return null;
      }
    };
    const body = norm(document.body?.innerText || "");
    const lines = body.split(" ").filter(Boolean);
    const pickBefore = (labelPattern) => {
      const match = new RegExp(`([\\d.,]+\\s*[KMBkmb万千亿]?)\\s*(?:位)?\\s*(?:${labelPattern.source})`, "i").exec(body);
      return match ? match[1].trim() : "";
    };
    const h1 = norm(document.querySelector("h1")?.innerText || "");
    const title = document.title.replace(/\| TikTok.*$/i, "").trim();
    const domProfile = {
      account: fallbackAccount,
      displayName: h1 || title || fallbackAccount,
      profileUrl: location.href,
      followersText: pickBefore(/粉丝|followers/),
      followingText: pickBefore(/已关注|following/),
      postsText: "",
      pageTitle: document.title,
      rawHeaderText: body.slice(0, 1200).replace(/[\uD800-\uDBFF]$/, ""),
      bodyTokenSample: lines.slice(0, 80).join(" "),
    };
    return {
      domProfile,
      userDetail: readUserDetail(),
    };
  }, source.account);
  const userDetailProfile = profileFromTikTokUserDetail(pageProfile?.userDetail, source, pageProfile?.domProfile?.profileUrl);
  return mergeTikTokProfile(source, userDetailProfile, pageProfile?.domProfile);
}

function statText(primary, fallback = "") {
  const value = primary ?? fallback ?? "";
  return value === "" ? "" : String(value);
}

function itemPublishTime(item) {
  const seconds = Number(item?.createTime);
  if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * 1000).toISOString();
  return idToIso(item?.id || "");
}

function isPhotoItem(item) {
  return Boolean(item?.imagePost || item?.imagePostInfo || item?.type === 2 || item?.itemType === "photo");
}

function profileFromTikTokApiItem(item, source) {
  const author = item?.author || {};
  const stats = item?.authorStatsV2 || item?.authorStats || {};
  const handle = normalizeHandle(author.uniqueId || source.account);
  return {
    account: source.account,
    displayName: author.nickname || source.account,
    profileUrl: handle ? `https://www.tiktok.com/@${handle}` : source.link,
    followersText: statText(stats.followerCount),
    followingText: statText(stats.followingCount),
    postsText: statText(stats.videoCount),
    pageTitle: author.nickname || source.account,
    rawHeaderText: author.signature || "",
    bodyTokenSample: "",
  };
}

function profileFromTikTokUserDetail(userDetail, source, currentUrl = "") {
  const info = userDetail?.userInfo || {};
  const user = info.user || {};
  const stats = info.statsV2 || info.stats || {};
  const handle = normalizeHandle(user.uniqueId || source.account);
  if (!userDetail || (!user.uniqueId && !stats.followerCount && !stats.videoCount)) return null;
  return {
    account: source.account,
    displayName: user.nickname || source.account,
    profileUrl: handle ? `https://www.tiktok.com/@${handle}` : currentUrl || source.link,
    followersText: statText(stats.followerCount),
    followingText: statText(stats.followingCount),
    postsText: statText(stats.videoCount),
    pageTitle: user.nickname || source.account,
    rawHeaderText: user.signature || "",
    bodyTokenSample: "",
    userId: user.id || "",
    secUid: user.secUid || "",
    signature: user.signature || "",
    verified: user.verified ?? "",
    profileDataSource: "webapp.user-detail",
  };
}

function mergeTikTokProfile(source, domProfile, apiProfile) {
  const pick = (...values) => {
    for (const value of values) {
      if (value == null) continue;
      const text = String(value);
      if (text !== "") return text;
    }
    return "";
  };
  return {
    ...source,
    ...(domProfile || {}),
    ...(apiProfile || {}),
    account: source.account,
    link: source.link,
    profileUrl: pick(domProfile?.profileUrl, apiProfile?.profileUrl, source.link),
    displayName: pick(domProfile?.displayName, apiProfile?.displayName, source.account),
    followersText: pick(domProfile?.followersText, apiProfile?.followersText),
    followingText: pick(domProfile?.followingText, apiProfile?.followingText),
    postsText: pick(domProfile?.postsText, apiProfile?.postsText),
  };
}

function accountProfileNeedsRefresh(rawState, source) {
  const key = normalizeHandle(source.account).toLowerCase();
  const link = String(source.link || "").toLowerCase();
  const row = (rawState.accounts || []).find((account) => {
    const accountKey = normalizeHandle(account.account).toLowerCase();
    const profileUrl = String(account.profileUrl || account.link || "").toLowerCase();
    return accountKey === key || (link && profileUrl === link);
  });
  if (!row) return true;
  return row.profileDataSource !== "webapp.user-detail";
}

function tiktokApiItemToRow(item, account, scrapedAt) {
  const authorHandle = normalizeHandle(item?.author?.uniqueId || account);
  const photo = isPhotoItem(item);
  const id = String(item?.id || "");
  const stats = item?.statsV2 || item?.stats || {};
  const statsFallback = item?.stats || {};
  const caption = item?.desc || (item?.contents || []).map((part) => part?.desc || "").filter(Boolean).join(" ").trim();
  const publishTime = itemPublishTime(item);
  return {
    account,
    type: photo ? "photo" : "video",
    isPinned: Boolean(item?.isPinnedItem || item?.isPinned),
    url: id && authorHandle ? `https://www.tiktok.com/@${authorHandle}/${photo ? "photo" : "video"}/${id}` : "",
    authorHandle,
    id,
    videoId: id,
    publishTime,
    publishTimeRaw: item?.createTime ? String(item.createTime) : "",
    viewsRaw: statText(stats.playCount, statsFallback.playCount),
    playText: statText(stats.playCount, statsFallback.playCount),
    likeText: statText(stats.diggCount, statsFallback.diggCount),
    commentText: statText(stats.commentCount, statsFallback.commentCount),
    collectText: statText(stats.collectCount, statsFallback.collectCount),
    shareText: statText(stats.shareCount, statsFallback.shareCount),
    title: titleFromCaption(caption),
    caption,
    excerpt: caption,
    scrapedAt,
    error: "",
    raw: {
      source: "/api/post/item_list",
      item,
    },
  };
}

function createTikTokItemListCollector(page, source) {
  const rowsById = new Map();
  const orderedIds = [];
  let pending = 0;
  let latestCursor = "";
  let latestHasMore = null;
  let profile = null;
  let responseCount = 0;
  let lastError = "";

  const remember = (row) => {
    const key = row.id || row.url;
    if (!key) return false;
    if (!rowsById.has(key)) orderedIds.push(key);
    rowsById.set(key, { ...(rowsById.get(key) || {}), ...row });
    return true;
  };

  const ingest = (payload) => {
    if (!payload || !Array.isArray(payload.itemList)) return 0;
    responseCount += 1;
    latestCursor = payload.cursor == null ? latestCursor : String(payload.cursor);
    latestHasMore = typeof payload.hasMore === "boolean" ? payload.hasMore : latestHasMore;
    let added = 0;
    const scrapedAt = nowInDisplayTimeZone();
    for (const item of payload.itemList) {
      if (!profile && item?.author) profile = profileFromTikTokApiItem(item, source);
      const row = tiktokApiItemToRow(item, source.account, scrapedAt);
      if (!row.id && !row.url) continue;
      const existed = rowsById.has(row.id || row.url);
      if (remember(row) && !existed) added += 1;
    }
    return added;
  };

  const onResponse = async (response) => {
    const url = response.url();
    if (!url.includes("/api/post/item_list")) return;
    pending += 1;
    try {
      if (response.status() >= 400) {
        lastError = `item_list HTTP ${response.status()}`;
        return;
      }
      ingest(await response.json());
    } catch (error) {
      lastError = error.message || String(error);
    } finally {
      pending -= 1;
    }
  };

  page.on("response", onResponse);
  return {
    items: () => orderedIds.map((id) => rowsById.get(id)).filter(Boolean),
    profile: () => profile,
    meta: () => ({ latestCursor, latestHasMore, responseCount, pending, lastError }),
    waitForIdle: async (timeoutMs = 5000) => {
      const started = Date.now();
      while (pending > 0 && Date.now() - started < timeoutMs) {
        await page.waitForTimeout(100);
      }
    },
    dispose: () => page.off("response", onResponse),
  };
}

async function collectPostItemsFromApi(page, source, args, rawState, collector) {
  let stableRounds = 0;
  let inspected = 0;
  let lastSeenCount = 0;
  let seenInsideRange = hasAccountContentMatching(rawState?.contents || [], source.account, (row) => dateRangePosition(row.publishTime, args) === "inside");
  let consecutiveBeforeRange = 0;

  for (let round = 0; true; round++) {
    const pageState = await waitForTikTokReady(page, args.waitTimeoutMs);
    if (pageState?.needsRecovery) {
      const recoveredState = await recoverTikTokBlockedPage(page, args, `账号 ${source.account}`, source.link);
      if (shouldRestartTikTokAccountScrape(recoveredState)) {
        throw new TikTokAccountRestartRequired(`TikTok 账号 ${source.account} 点击页面 Refresh 后需要重新抓取账号。`);
      }
    }
    await dismissTikTokLoginPopups(page);
    await page.waitForTimeout(round === 0 ? 2200 : 1400);
    await collector.waitForIdle(8000);

    const items = collector.items();
    const freshItems = items.slice(inspected);
    inspected = items.length;
    for (const item of freshItems) {
      const position = dateRangePosition(item.publishTime, args);
      if (item.isPinned) {
        // 置顶内容不用于触发日期边界停止。
      } else if (position === "inside") {
        seenInsideRange = true;
        consecutiveBeforeRange = 0;
      } else if (position === "before") {
        consecutiveBeforeRange += 1;
      } else if (position === "after") {
        consecutiveBeforeRange = 0;
      }
    }

    const inRangeCount = items.filter((item) => dateRangePosition(item.publishTime, args) === "inside").length;
    const { latestHasMore, responseCount, lastError } = collector.meta();
    const added = items.length - lastSeenCount;
    console.log(`第 ${round + 1} 批：item_list 响应 ${responseCount} 次，累计 ${items.length} 条，本批新增 ${Math.max(0, added)} 条，周期内 ${inRangeCount} 条。${lastError ? ` 最近接口错误：${lastError}` : ""}`);

    if (args.sinceTime != null && args.stopAfterBeforeRange > 0 && consecutiveBeforeRange >= args.stopAfterBeforeRange) {
      const rangeContext = seenInsideRange ? "已越过筛选周期边界" : "未发现筛选周期内内容";
      console.log(`${rangeContext}，且连续遇到 ${consecutiveBeforeRange} 条早于周期的非置顶内容，停止滚动。`);
      break;
    }
    if (args.limit && inRangeCount >= args.limit) break;
    if (latestHasMore === false && round > 0) {
      console.log("item_list 返回 hasMore=false，停止滚动。");
      break;
    }
    if (items.length === lastSeenCount) stableRounds += 1;
    else stableRounds = 0;
    lastSeenCount = items.length;
    if (stableRounds >= args.stableRoundsToStop) break;

    const before = await page.evaluate(() => ({ y: window.scrollY, h: document.body.scrollHeight }));
    await page.evaluate(() => window.scrollBy(0, Math.max(900, window.innerHeight * 2.3)));
    await page.waitForTimeout(1800);
    const after = await page.evaluate(() => ({ y: window.scrollY, h: document.body.scrollHeight }));
    if (after.y === before.y && after.h === before.h) stableRounds += 1;
  }

  return collector.items()
    .filter((item) => dateRangePosition(item.publishTime, args) === "inside")
    .slice(0, args.limit || undefined);
}

async function collectPostLinks(page, account, args, rawState = null) {
  const seen = new Map();
  let stableRounds = 0;
  let seenInsideRange = hasAccountContentMatching(rawState?.contents || [], account, (row) => dateRangePosition(row.publishTime, args) === "inside");
  let consecutiveBeforeRange = 0;

  for (let round = 0; true; round++) {
    const pageState = await waitForTikTokReady(page, args.waitTimeoutMs);
    if (pageState?.needsRecovery) {
      const recoveredState = await recoverTikTokBlockedPage(page, args, `账号 ${account}`);
      if (shouldRestartTikTokAccountScrape(recoveredState)) {
        throw new TikTokAccountRestartRequired(`TikTok 账号 ${account} 点击页面 Refresh 后需要重新抓取账号。`);
      }
    }
    const items = await page.evaluate((account) => {
      const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const out = [];
      for (const a of [...document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]')]) {
        const href = (a as HTMLAnchorElement).href.split("?")[0];
        const match = href.match(/\/@(.*?)\/(video|photo)\/(\d+)/);
        if (!match) continue;
        const text = norm(a.innerText || a.textContent || "");
        const labelled = norm(`${a.getAttribute("aria-label") || ""} ${a.getAttribute("title") || ""} ${text}`);
        out.push({
          account,
          url: `https://www.tiktok.com/@${match[1]}/${match[2]}/${match[3]}`,
          authorHandle: match[1],
          type: match[2],
          id: match[3],
          viewsRaw: (text.match(/[\d.,]+\s*[KMBkmb万千亿]?/) || [""])[0].trim(),
          isPinned: /置顶|pinned/i.test(labelled),
          listText: text,
        });
      }
      return out;
    }, account);

    let added = 0;
    for (const item of items) {
      if (seen.has(item.id)) continue;
      item.publishTime = idToIso(item.id);
      item.publishTimeRaw = "";
      const position = dateRangePosition(item.publishTime, args);
      seen.set(item.id, item);
      added += 1;
      if (item.isPinned) {
        // 置顶内容不用于触发日期边界停止。
      } else if (position === "inside") {
        seenInsideRange = true;
        consecutiveBeforeRange = 0;
      } else if (position === "before") {
        consecutiveBeforeRange += 1;
      } else if (position === "after") {
        consecutiveBeforeRange = 0;
      }
    }

    console.log(`第 ${round + 1} 批：当前发现 ${items.length} 条，累计 ${seen.size} 条，本批新增 ${added} 条。`);
    if (args.sinceTime != null && args.stopAfterBeforeRange > 0 && consecutiveBeforeRange >= args.stopAfterBeforeRange) {
      const rangeContext = seenInsideRange ? "已越过筛选周期边界" : "未发现筛选周期内内容";
      console.log(`${rangeContext}，且连续遇到 ${consecutiveBeforeRange} 条早于周期的非置顶内容，停止滚动。`);
      break;
    }
    if (args.limit && [...seen.values()].filter((x) => dateRangePosition(x.publishTime, args) === "inside").length >= args.limit) break;
    if (!added) stableRounds += 1;
    else stableRounds = 0;
    if (stableRounds >= args.stableRoundsToStop) break;

    const before = await page.evaluate(() => ({ y: window.scrollY, h: document.body.scrollHeight }));
    await page.evaluate(() => window.scrollBy(0, Math.max(900, window.innerHeight * 2.3)));
    await page.waitForTimeout(1800);
    const after = await page.evaluate(() => ({ y: window.scrollY, h: document.body.scrollHeight }));
    if (after.y === before.y && after.h === before.h) stableRounds += 1;
  }

  return [...seen.values()].filter((item) => dateRangePosition(item.publishTime, args) === "inside").slice(0, args.limit || undefined);
}

async function scrapeDetail(page, item) {
  const startedAt = nowInDisplayTimeZone();
  try {
    await gotoTikTokPage(page, item.url, { waitTimeoutMs: 30000 }, `详情页 ${item.url}`);
    const data = await page.evaluate(() => {
      const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const meta = (name) => (document.querySelector(`meta[property="${name}"], meta[name="${name}"]`) as HTMLMetaElement | null)?.content || "";
      const buttons = [...document.querySelectorAll('button,[role="button"],[aria-label]')]
        .map((el) => ({ text: norm(el.innerText || el.textContent || ""), aria: norm(el.getAttribute("aria-label") || "") }))
        .filter((x) => x.text || x.aria);
      const pick = (patterns) => {
        for (const b of buttons) {
          const hay = `${b.aria} ${b.text}`;
          if (patterns.some((p) => p.test(hay))) {
            const fromAria = hay.match(/([\d.,]+\s*[KMBkmb万千亿]?)/);
            if (fromAria) return fromAria[1].trim();
            if (b.text) return b.text;
          }
        }
        return "";
      };
      const caption = meta("og:description") || meta("description") || meta("twitter:description");
      const body = norm(document.body?.innerText || "");
      const relativeTimeText = (body.match(/(?:\d+\s*(?:秒|分钟|小时|天|周|月|年)前|\d{1,2}-\d{1,2}|\d{4}-\d{1,2}-\d{1,2})/) || [""])[0];
      return {
        caption,
        title: meta("og:title") || document.title.replace(/\| TikTok.*$/i, "").trim(),
        relativeTimeText,
        likeText: pick([/点赞视频|likes?|个赞/i]),
        commentText: pick([/评论|comments?/i]),
        collectText: pick([/收藏|favorite|收藏。/i]),
        shareText: pick([/分享|shares?/i]),
      };
    });
    return { ...item, ...data, title: titleFromCaption(data.caption) || data.title || "", caption: data.caption || "", scrapedAt: startedAt, error: "" };
  } catch (error) {
    return { ...item, scrapedAt: startedAt, error: error.message };
  }
}


async function scrapeTikTokViaBrowser(ctx: AccountContext): Promise<AccountScrapeResult> {
  const source = ctx.account;
  const args: TikTokArgs = {
    sinceTime: ctx.sinceTsMs,
    untilTime: ctx.untilTsMs,
    rangeTimeZone: process.env.SCRAPE_TIMEZONE || "Asia/Shanghai",
    limit: ctx.limit,
    waitTimeoutMs: 45000,
    requireLogin: false,
    humanVerificationReloads: 5,
    humanVerificationReloadDelayMs: 2500,
    stableRoundsToStop: 8,
  };

  const maxAttempts = Math.max(1, tikTokChallengeOptions(args).reloads + 1);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const rawState: { contents: any[] } = { contents: [] };
    const collector = createTikTokItemListCollector(ctx.page, source);
    try {
      console.log(`正在抓取账号：${source.account} ${source.link}（第 ${attempt}/${maxAttempts} 次）`);
      const gotoState = await gotoTikTokPage(ctx.page, source.link, args, `账号 ${source.account}`);
      if (shouldRestartTikTokAccountScrape(gotoState)) {
        throw new TikTokAccountRestartRequired(`TikTok 账号 ${source.account} 点击页面 Refresh 后需要重新抓取账号。`);
      }
      await dismissTikTokLoginPopups(ctx.page);
      const domProfile = await collectProfile(ctx.page, source);
      const list = await collectPostItemsFromApi(ctx.page, source, args, rawState, collector);
      const profile = mergeTikTokProfile(source, domProfile, collector.profile());
      console.log(`账号 ${source.account} 周期内通过 item_list 发现 ${list.length} 条`);
      return {
        accountRow: { ...profile, error: "" },
        contentRows: list,
      };
    } catch (error) {
      if (error instanceof TikTokAccountRestartRequired && attempt < maxAttempts) {
        console.log(`${error.message} 重新开始 ${attempt}/${maxAttempts - 1}。`);
        continue;
      }
      throw error;
    } finally {
      collector.dispose();
    }
  }

  throw new Error("TikTok 账号重试次数耗尽");
}

function apiProfileFromAuthor(source, author, secUid, userId) {
  const handle = normalizeHandle(author?.uniqueId || source.account);
  return {
    account: source.account,
    displayName: author?.nickname || source.account,
    profileUrl: handle ? `https://www.tiktok.com/@${handle}` : source.link,
    followersText: statText(author?.followerCount),
    followingText: statText(author?.followingCount),
    postsText: statText(author?.awemeCount),
    pageTitle: author?.nickname || source.account,
    rawHeaderText: author?.signature || "",
    bodyTokenSample: "",
    userId: userId || "",
    secUid,
    signature: author?.signature || "",
    verified: author?.verified ?? "",
    profileDataSource: "tikhub-app-v3",
  };
}

/**
 * TikHub 路径：
 *   - secUid 只解析一次，写进 social_accounts.metadata_json，下次直接读
 *   - 作品按 max_cursor 翻页，按 createTime 命中时间窗即停
 *   - 失败直接抛错，不 fallback 到浏览器（避免两边都跑一遍）
 */
async function scrapeTikTokViaApi(ctx: AccountContext, client: TikTokApiClient): Promise<AccountScrapeResult> {
  const source = ctx.account;
  const username = normalizeHandle(source.account) || source.account;
  const cached = source.metadata?.tiktok || {};
  let secUid = String(cached.secUid || "");
  let userId = String(cached.userId || source.externalAccountId || "");

  if (!secUid) {
    const identity = await resolveTikTokIdentity(client, username);
    secUid = identity.secUid;
    userId = identity.userId || userId;
    const platformId = await ensurePlatform(ctx.db, { code: "tiktok", name: "TikTok" });
    await saveTikTokIdentity(ctx.db, { platformId, handle: source.account, userId, secUid });
    console.log(`TikTok ${username} 首次解析并写入数据库：user_id=${userId || "-"} sec_user_id=${secUid.slice(0, 16)}…`);
  } else {
    console.log(`TikTok ${username} 使用数据库缓存的 sec_user_id。`);
  }

  const args = {
    sinceTime: ctx.sinceTsMs,
    untilTime: ctx.untilTsMs,
    rangeTimeZone: process.env.SCRAPE_TIMEZONE || "Asia/Shanghai",
    limit: ctx.limit,
  };
  const scrapedAt = nowInDisplayTimeZone();
  const rows = new Map<string, any>();
  let author: any = null;
  let cursor: string | number = 0;
  let pages = 0;
  let reachedBefore = false;

  while (pages < 80) {
    const page = await fetchTikTokPostsPage(client, {
      secUid,
      uniqueId: username,
      cursor,
      count: 15,
    });
    pages += 1;
    if (pages === 1) console.log(`TikTok API 返回字段：${page.topLevelKeys.join(", ") || "(空)"}｜请求 ${page.requestId || "-"}`);
    console.log(`TikTok ${username} 第 ${pages} 页：${page.items.length} 条，hasMore=${page.hasMore}`);

    if (!page.items.length) break;

    for (const raw of page.items) {
      const item = normalizeTikTokItem(raw);
      if (!author && item?.author) author = item.author;
      const row = tiktokApiItemToRow(item, source.account, scrapedAt);
      if (!row.id || rows.has(row.id)) continue;
      rows.set(row.id, row);
      if (!row.isPinned && dateRangePosition(row.publishTime, args) === "before") reachedBefore = true;
    }

    if (reachedBefore) {
      console.log(`TikTok ${username} 已越过起始时间，停止翻页。`);
      break;
    }
    if (args.limit && countInsideRange(rows, args) >= args.limit) break;
    if (!page.hasMore) break;
    if (!page.cursor || String(page.cursor) === String(cursor)) break;
    cursor = page.cursor;
  }

  const contentRows = [...rows.values()]
    .filter((row) => dateRangePosition(row.publishTime, args) === "inside")
    .slice(0, args.limit || undefined);
  const accountRow = {
    ...apiProfileFromAuthor(source, author, secUid, userId),
    error: "",
    tikhubPages: pages,
    tikhubFetched: rows.size,
  };
  console.log(`TikTok ${username} API 完成：${pages} 页，共 ${rows.size} 条，周期内 ${contentRows.length} 条。`);
  return { accountRow, contentRows };
}

function countInsideRange(rows: Map<string, any>, args: Record<string, any>): number {
  let count = 0;
  for (const row of rows.values()) {
    if (dateRangePosition(row.publishTime, args) === "inside") count += 1;
  }
  return count;
}

export function createTikTokScraper(): PlatformScraper {
  // 默认：有 TIKHUB_API_KEY 就走 API；TIKTOK_SOURCE=browser 可强制回浏览器。
  const apiPreferred = process.env.TIKTOK_SOURCE === "api"
    || (process.env.TIKTOK_SOURCE !== "browser" && Boolean(process.env.TIKHUB_API_KEY));
  let client: TikTokApiClient | null = null;

  return {
    code: "tiktok",
    name: "TikTok",
    requiresBrowser: !apiPreferred,

    async prepare() {
      if (!apiPreferred) return;
      client = await createTikTokApiClient(process.cwd());
      if (!client.enabled) {
        throw new FatalPlatformError("TikTok API 未启用：缺少 TIKHUB_API_KEY");
      }
      console.log("已启用 TikTok 数据源：TikHub App V3（不需要浏览器）");
    },

    async scrapeAccount(ctx: AccountContext): Promise<AccountScrapeResult> {
      if (apiPreferred) {
        if (!client) throw new Error("TikTok API client 未初始化");
        return scrapeTikTokViaApi(ctx, client);
      }
      return scrapeTikTokViaBrowser(ctx);
    },
  };
}
