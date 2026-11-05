import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { loadEnvFile } from "../src/config/env.ts";
import { numberArg, parseArgs } from "../src/config/args.ts";
import { openBrowserSession } from "../src/core/browser.ts";

type HeaderMap = Record<string, string>;

function textOf(value: any): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value.content === "string") return value.content;
  if (typeof value.simpleText === "string") return value.simpleText;
  if (Array.isArray(value.runs)) return value.runs.map((r: any) => r.text || "").join("");
  return "";
}

function walk(obj: any, visit: (node: any, path: string) => void, path = "", seen = new Set<any>()): void {
  if (!obj || typeof obj !== "object" || seen.has(obj)) return;
  seen.add(obj);
  visit(obj, path);
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => walk(item, visit, `${path}[${index}]`, seen));
  } else {
    for (const [key, value] of Object.entries(obj)) walk(value, visit, path ? `${path}.${key}` : key, seen);
  }
}

function findTokens(obj: any): Array<{ path: string; token: string }> {
  const out: Array<{ path: string; token: string }> = [];
  walk(obj, (node, p) => {
    if (node.continuationCommand?.token) out.push({ path: p, token: node.continuationCommand.token });
  });
  return out;
}

function findLikeText(next: any): string {
  let result = "";
  walk(next, (node) => {
    if (result) return;
    if (node.accessibilityId === "id.video.like.button") {
      result = node.title || node.buttonViewModel?.title || "";
    }
  });
  return result;
}

function findCommentsToken(next: any): string {
  let token = "";
  walk(next, (node) => {
    if (token) return;
    if (node.itemSectionRenderer?.header?.commentsHeaderRenderer) {
      for (const item of node.itemSectionRenderer.contents || []) {
        const candidate = item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
        if (candidate) {
          token = candidate;
          break;
        }
      }
    }
  });
  return token;
}

function parseCommentsCount(next: any): string {
  let count = "";
  walk(next, (node) => {
    if (count) return;
    if (node.commentsHeaderRenderer?.countText) count = textOf(node.commentsHeaderRenderer.countText);
  });
  const match = count.match(/([\d][\d,.\s]*)\s*(?:条评论|comments?)/i);
  if (match) return match[1].replace(/[^\d]/g, "");
  if (/评论已关闭|comments are turned off/i.test(count)) return "0";
  return "";
}

function parseLockupItems(items: any[]): { videos: any[]; continuation: string } {
  const videos: any[] = [];
  let continuation = "";
  for (const item of items || []) {
    if (item.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
      continuation = item.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
      continue;
    }
    const lock = item?.richItemRenderer?.content?.lockupViewModel;
    if (!lock) continue;
    const title = lock.metadata?.lockupMetadataViewModel?.title?.content || "";
    const parts = (lock.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows || [])
      .flatMap((row: any) => row.metadataParts || [])
      .map((part: any) => part.text?.content || "")
      .filter(Boolean);
    const viewText = parts.find((part: string) => /观看|views?/i.test(part)) || "";
    const relative = parts.find((part: string) => !/观看|views?/i.test(part)) || "";
    const badges = (lock.contentImage?.thumbnailViewModel?.overlays || [])
      .flatMap((overlay: any) => overlay.thumbnailBottomOverlayViewModel?.badges || [])
      .map((badge: any) => badge.thumbnailBadgeViewModel?.text || "")
      .filter(Boolean);
    videos.push({
      videoId: lock.contentId || "",
      contentType: lock.contentType || "",
      title,
      viewText,
      relative,
      duration: badges.find((badge: string) => /^\d+:\d+/.test(badge)) || "",
    });
  }
  return { videos, continuation };
}

function parseShortsItems(items: any[]): { videos: any[]; continuation: string } {
  const videos: any[] = [];
  let continuation = "";
  for (const item of items || []) {
    if (item.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
      continuation = item.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
      continue;
    }
    const short = item?.richItemRenderer?.content?.shortsLockupViewModel;
    if (!short) continue;
    const videoId = short.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId
      || String(short.entityId || "").replace(/^shorts-shelf-item-/, "");
    const accessibility = String(short.accessibilityText || "");
    const title = accessibility.split(/,\s*[\d.,]+\s*(?:万|亿)?次观看/)[0]?.trim() || "";
    const viewText = accessibility.match(/([\d.,]+\s*(?:万|亿)?次观看)/)?.[1] || "";
    videos.push({ videoId, contentType: "短视频", title, viewText, relative: "", duration: "" });
  }
  return { videos, continuation };
}

function parseBrowse(browse: any): { videos: any[]; continuation: string } {
  const items = browse?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems || [];
  return parseLockupItems(items);
}

function parseShortsBrowse(browse: any): { videos: any[]; continuation: string } {
  const items = browse?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems || [];
  return parseShortsItems(items);
}

function parseNext(next: any): { title: string; views: string; publish: string; likes: string; commentsToken: string } {
  const contents = next?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
  const primary = contents.find((item: any) => item.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer || {};
  const viewCount = primary.viewCount?.videoViewCountRenderer;
  return {
    title: textOf(primary.title),
    views: String(viewCount?.originalViewCount || textOf(viewCount?.viewCount) || ""),
    publish: textOf(primary.dateText) || textOf(primary.relativeDateText),
    likes: findLikeText(next),
    commentsToken: findCommentsToken(next),
  };
}

async function postInnertube(apiKey: string, endpoint: string, body: any, headers: HeaderMap): Promise<any> {
  const url = `https://www.youtube.com/youtubei/v1/${endpoint}?key=${apiKey}&prettyPrint=false`;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`${endpoint} HTTP ${response.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${endpoint} 返回不是 JSON：${text.slice(0, 300)}`);
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const args = parseArgs(process.argv.slice(2));
  const shortsMode = args.flags.has("shorts") || args.values.get("shorts") === "true";
  const channelUrl = args.values.get("channel")
    || (shortsMode ? "https://www.youtube.com/@BYDAutoSpain/shorts" : "https://www.youtube.com/@BYDAutoSpain/videos");
  const limit = numberArg(args, "limit", 20);
  const videoIdArg = args.values.get("video-id") || "";
  const profileDir = args.values.get("profile")
    || process.env.SOCIAL_BROWSER_USER_DATA_DIR
    || path.join(process.cwd(), "../work/playwright-social-profile");
  const profileDirectory = args.values.get("profile-directory") || process.env.SOCIAL_BROWSER_PROFILE_DIRECTORY || "Profile 3";
  const executablePath = args.values.get("browser-executable")
    || process.env.SOCIAL_BROWSER_EXECUTABLE
    || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const outputPath = args.values.get("out") || path.join(process.cwd(), ".tmp-youtube-http-poc.json");

  const session = await openBrowserSession(chromium, {
    browserMode: "playwright",
    userDataDir: path.resolve(profileDir),
    profileDirectory,
    executablePath,
    waitTimeoutMs: 60000,
  }, { cdpLabel: "YouTube HTTP POC" });

  let authHeaders: HeaderMap | null = null;
  const captureHeaders = (request: any) => {
    const headers = request.headers();
    if (headers.authorization && !authHeaders) authHeaders = headers;
  };
  session.page.on("request", captureHeaders);

  try {
    await session.page.goto(channelUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    await session.page.waitForTimeout(5000);
    const channel = await session.page.evaluate(() => {
      const cfg = (window as any).ytcfg;
      const idata = (window as any).ytInitialData;
      const tabs = idata?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
      const selected = tabs.find((tab: any) => tab?.tabRenderer?.selected)?.tabRenderer
        || tabs.find((tab: any) => /视频|Videos/i.test(tab?.tabRenderer?.title || ""))?.tabRenderer
        || tabs[1]?.tabRenderer;
      const tokens: string[] = [];
      const seen = new Set<any>();
      const walk = (o: any) => {
        if (!o || typeof o !== "object" || seen.has(o)) return;
        seen.add(o);
        if (o.continuationCommand?.token) tokens.push(o.continuationCommand.token);
        for (const v of Object.values(o)) walk(v);
      };
      walk(selected);
      return {
        apiKey: cfg?.get?.("INNERTUBE_API_KEY") || "",
        clientName: cfg?.get?.("INNERTUBE_CONTEXT_CLIENT_NAME") || "",
        clientVersion: cfg?.get?.("INNERTUBE_CONTEXT_CLIENT_VERSION") || "",
        visitorData: cfg?.get?.("VISITOR_DATA") || "",
        context: cfg?.get?.("INNERTUBE_CONTEXT") || null,
        channelTitle: idata?.metadata?.channelMetadataRenderer?.title || "",
        continuation: tokens[0] || "",
        initialItems: selected?.content?.richGridRenderer?.contents || [],
        title: document.title,
      };
    });

    // 打开一次视频页，捕获带登录态的 next 请求头（authorization / x-goog-authuser 等）。
    await session.page.goto("https://www.youtube.com/watch?v=s-CT8bHha_g", { waitUntil: "domcontentloaded", timeout: 90000 });
    await session.page.waitForTimeout(4000);
    await session.page.evaluate(() => window.scrollTo(0, 4000));
    await session.page.waitForTimeout(3000);
    if (!authHeaders) throw new Error("没有捕获到带 authorization 的 YouTube 请求头；确认 Profile 已登录 YouTube");
    const cookies = await session.page.context().cookies("https://www.youtube.com");
    if (!channel.continuation && !videoIdArg) throw new Error("没有拿到频道视频 continuation");
    if (!channel.apiKey) throw new Error("没有拿到 INNERTUBE_API_KEY");

    const cookie = cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
    const headers: HeaderMap = {
      "content-type": "application/json",
      "x-youtube-client-name": String(channel.clientName || 1),
      "x-youtube-client-version": String(channel.clientVersion),
      "x-goog-visitor-id": String(channel.visitorData),
      "x-origin": "https://www.youtube.com",
      origin: "https://www.youtube.com",
      referer: "https://www.youtube.com/",
      "user-agent": String(authHeaders["user-agent"] || ""),
      cookie,
    };
    for (const name of ["authorization", "x-goog-authuser", "x-youtube-bootstrap-logged-in"]) {
      if (authHeaders[name]) headers[name] = authHeaders[name];
    }

    const initial = videoIdArg ? { videos: [], continuation: "" } : (shortsMode ? parseShortsItems(channel.initialItems) : parseLockupItems(channel.initialItems));
    const videos: any[] = videoIdArg
      ? [{ videoId: videoIdArg, contentType: "VIDEO_ID_ARG", title: "" }]
      : initial.videos
        .filter((video: any) => video.videoId && (shortsMode || video.contentType === "LOCKUP_CONTENT_TYPE_VIDEO" || !video.contentType))
        .slice(0, limit);
    let continuation = initial.continuation || channel.continuation;
    console.log(`initial: ${initial.videos.length}，已选视频 ${videos.length}`);
    while (!videoIdArg && videos.length < limit && continuation) {
      const browse = await postInnertube(channel.apiKey, "browse", { context: channel.context, continuation }, headers);
      const page = shortsMode ? parseShortsBrowse(browse) : parseBrowse(browse);
      for (const video of page.videos) {
        if (videos.length >= limit) break;
        if (video.videoId && (video.contentType === "LOCKUP_CONTENT_TYPE_VIDEO" || !video.contentType)) {
          videos.push(video);
        }
      }
      continuation = page.continuation;
      console.log(`browse: +${page.videos.length}，累计视频 ${videos.length}`);
    }

    const results: any[] = [];
    for (const [index, video] of videos.entries()) {
      const player = await postInnertube(channel.apiKey, "player", { context: channel.context, videoId: video.videoId }, headers);
      const playerStatus = player.playabilityStatus?.status || "";
      if (playerStatus !== "OK") throw new Error(`player ${video.videoId} 状态 ${playerStatus}：${player.playabilityStatus?.reason || ""}`);
      const micro = player.microformat?.playerMicroformatRenderer || {};
      const next = await postInnertube(channel.apiKey, "next", { context: channel.context, videoId: video.videoId }, headers);
      const metrics = parseNext(next);
      let comments = "";
      if (metrics.commentsToken) {
        const commentsResponse = await postInnertube(channel.apiKey, "next", { context: channel.context, continuation: metrics.commentsToken }, headers);
        comments = parseCommentsCount(commentsResponse);
      }
      results.push({
        ...video,
        title: player.videoDetails?.title || metrics.title,
        views: String(player.videoDetails?.viewCount || metrics.views || ""),
        publish: micro.publishDate || micro.uploadDate || metrics.publish,
        lengthSeconds: player.videoDetails?.lengthSeconds || "",
        likes: metrics.likes,
        comments,
      });
      console.log(`[${index + 1}/${videos.length}] ${video.videoId} 播放=${results.at(-1).views || "缺失"} 点赞=${metrics.likes || "缺失"} 评论=${comments || "缺失"} 发布=${results.at(-1).publish || "缺失"}`);
    }

    await fs.writeFile(outputPath, JSON.stringify({ channelTitle: channel.channelTitle, channelUrl, results }, null, 2));
    console.log(`POC 完成：${results.length} 条，输出 ${outputPath}`);
  } finally {
    session.page.off("request", captureHeaders);
    await session.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
