#!/usr/bin/env node
/**
 * TikHub TikTok 接口连通性检查（会消耗 2 次接口调用）
 *
 * 用法（在 apps/crawler 目录下跑）：
 *   node --experimental-strip-types scripts/tiktok-api-check.mjs byd.spain
 *   node --experimental-strip-types scripts/tiktok-api-check.mjs byd.spain --raw
 *
 * 读 TIKHUB_API_KEY：优先环境变量，其次同目录 .env。
 */

import {
  createTikTokApiClient,
  fetchTikTokPostsPage,
  normalizeTikTokItem,
  resolveTikTokIdentity,
} from "../src/platforms/tiktok/api.ts";

const handle = String(process.argv[2] || "").replace(/^@/, "").trim();
const showRaw = process.argv.includes("--raw");

if (!handle) {
  console.log("用法: node --experimental-strip-types scripts/tiktok-api-check.mjs <用户名> [--raw]");
  process.exit(1);
}

const client = await createTikTokApiClient(process.cwd());
if (!client.enabled) {
  console.log("找不到 TIKHUB_API_KEY（环境变量或 apps/crawler/.env）");
  process.exit(1);
}

console.log(`用户: ${handle}`);
const identity = await resolveTikTokIdentity(client, handle);
console.log(`  解析结果: user_id=${identity.userId || "-"}  sec_user_id=${identity.secUid}`);
console.log("");

const page = await fetchTikTokPostsPage(client, {
  secUid: identity.secUid,
  uniqueId: handle,
  cursor: 0,
  count: 15,
});

console.log(`第 1 页: ${page.items.length} 条  hasMore=${page.hasMore}  cursor=${page.cursor || "-"}`);
console.log(`返回字段: ${page.topLevelKeys.join(", ") || "(空)"}  request_id=${page.requestId || "-"}`);
if (!page.items.length) {
  console.log("⚠️ 没有条目，说明返回结构和预期不一致，用 --raw 看原始结构。");
  process.exit(0);
}

const first = normalizeTikTokItem(page.items[0]);
console.log("");
console.log("第一条（归一化后）:");
console.log({
  id: first.id,
  desc: String(first.desc || "").slice(0, 40),
  createTime: first.createTime,
  publishTime: first.createTime ? new Date(first.createTime * 1000).toISOString() : "",
  author: first.author?.uniqueId,
  followerCount: first.author?.followerCount,
  play: first.statsV2?.playCount,
  like: first.statsV2?.diggCount,
  comment: first.statsV2?.commentCount,
  share: first.statsV2?.shareCount,
  collect: first.statsV2?.collectCount,
});

if (showRaw) {
  console.log("");
  console.log("原始第一条（截断 2000 字）:");
  console.log(JSON.stringify(page.items[0]).slice(0, 2000));
}
