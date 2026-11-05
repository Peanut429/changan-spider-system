/**
 * LinkedIn 新版公司动态页（sdui / RSC）数据解析。
 *
 * LinkedIn 已把公司动态从老的 `/voyager/api/graphql`（JSON { data, meta, included }）
 * 迁移到 React Server Components（RSC / sdui）体系：
 *   - 首屏：`POST /flagship-web/feed/` 或初始 HTML（RSC 流）
 *   - 分页：`POST /flagship-web/rsc-action/actions/pagination?sduiid=com.linkedin.sdui.pagers.pages.organizationFeed`
 *
 * 这些响应 body 是 application/octet-stream 的 RSC 流（`1:I["hash",[],"Component"]`、
 * `["$","$Lxxx",null,{...}]`、`T<len>,{...}` 打标对象）。本文档只做「按字段抽取」，
 * 不做完整 RSC 反序列化。抽取时依赖以下可稳定出现的形态：
 *
 *   - 帖子主键：`urn:li:activity:<activityId>`（老 scraper 用的 externalContentId）
 *   - 互动计数：sdui state store 里的
 *       `commentCount-urn:li:activity:<id>` / `repostCount-urn:li:activity:<id>`
 *       `ReactionType_<TYPE>_urn:li:activity:<id>`（多种 ReactionType 求和 = 总回应数）
 *       这些键后面跟着 `"$case":"intValue","intValue":<n>`
 *       注意：视频/原创帖的计数键用的是 `urn:li:ugcPost:<ugcPostId>`，不是 activity URN，
 *       需要通过 `userGeneratedContentId -> activityId` 的共现关系映射回 activityId。
 *   - 帖子正文：RSC 里每个 feed 卡片（`update-card-focus<semanticId>FeedType_*`）内的
 *       `feed-commentary` 文本块。卡片里的 refs 指向 `feed-commentary`/`textProps` chunk，
 *       卡片的 semanticId 与 trackingScope 里的 `updateUrn`（activityId）配对。
 *       不能按正文块出现顺序硬对：卡片/正文 chunk 的顺序和 feed 顺序不一致，转发帖还会多块。
 *   - 发布时间：由 activityId 用 Snowflake 位运算推出（`id >> 22` 得到 UTC 毫秒），
 *       无需解析页面
 */

const REACTION_TYPES = ["LIKE", "PRAISE", "EMPATHY", "INTEREST", "APPRECIATION", "ENTERTAINMENT", "SUPER_LIKE"];

const ACTIVITY_URN_RE = /urn:li:activity:(\d+)/g;

// LinkedIn 帖子 activityId 是 19 位 Snowflake（`id >> 22` 即 UTC 毫秒时间戳）。
// 文档里会出现被截断的编号（例如 7521179981826310 是 7521179981826310146 的前 16 位），
// 右移 22 位会得到 1970/1975 这种非法发布时间。它们不是帖子编号，必须过滤掉，
// 否则 minPublishMs 会把它们当成“最早的帖子”，误判已滚过窗口起点。
const ACTIVITY_ID_MIN_PUBLISH_MS = Date.parse("2003-06-01T00:00:00.000Z");
const ACTIVITY_ID_MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

export function isPlausibleActivityId(activityId: string): boolean {
  if (!/^\d{18,19}$/.test(activityId)) return false;
  try {
    const publishMs = Number(BigInt(activityId) >> 22n);
    return publishMs >= ACTIVITY_ID_MIN_PUBLISH_MS && publishMs <= Date.now() + ACTIVITY_ID_MAX_FUTURE_MS;
  } catch {
    return false;
  }
}

export type RscPost = {
  activityId: string;
  url: string;
  publishIso: string;
  likeCount: number | null;
  commentCount: number | null;
  repostCount: number | null;
  excerpt: string | null;
};

/** 从 activityId 用 Snowflake 位运算推出发布时刻的 ISO 字符串（UTC）。 */
export function publishIsoFromActivityId(activityId: string): string {
  try {
    const utcMs = Number(BigInt(activityId) >> 22n);
    return new Date(utcMs).toISOString();
  } catch {
    return "";
  }
}

function intValueAfter(text: string, needle: string): number | null {
  const i = text.indexOf(needle);
  if (i < 0) return null;
  const seg = text.slice(i, i + 400);
  const m = /intValue\\?":(\d+)/.exec(seg);
  return m ? Number(m[1]) : null;
}

/**
 * 抽取 `activityId -> ugcPostId` 映射。
 * 视频/原创帖的互动计数在 state store 里用 `urn:li:ugcPost:<ugcPostId>` 做键，
 * 而帖子主键仍是 `urn:li:activity:<activityId>`，两者在 reaction/分享动作 payload 里共现：
 *   "userGeneratedContentId":"<ugcId>" ... "activityId":"<actId>"
 */
function ugcPostIdByActivityId(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /userGeneratedContentId":"(\d+)"[\s\S]{0,400}?activityId":"(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!map.has(m[2])) map.set(m[2], m[1]);
  }
  return map;
}

function intValueAfterEither(text: string, aid: string, ugcId: string | undefined, keyPrefix: string): number | null {
  let v = intValueAfter(text, `${keyPrefix}-urn:li:activity:${aid}`);
  if (v == null && ugcId) v = intValueAfter(text, `${keyPrefix}-urn:li:ugcPost:${ugcId}`);
  return v;
}

function likeCount(text: string, aid: string, ugcId: string | undefined): number | null {
  let sum = 0;
  let any = false;
  for (const type of REACTION_TYPES) {
    let v = intValueAfter(text, `ReactionType_${type}_urn:li:activity:${aid}`);
    if (v == null && ugcId) v = intValueAfter(text, `ReactionType_${type}_urn:li:ugcPost:${ugcId}`);
    if (v != null) { sum += v; any = true; }
  }
  return any ? sum : null;
}

type RscChunkMap = Map<string, any>;

/** 把 RSC 流解析成 chunk map（只保留可 JSON 解析的顶层行）。 */
function parseRscChunkMap(text: string): RscChunkMap {
  const chunks: RscChunkMap = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]+):(.*)$/);
    if (!match) continue;
    let raw = match[2];
    if (raw.startsWith("I")) continue;
    if (raw[0] === "T" || raw[0] === "J") raw = raw.slice(raw.indexOf(",") + 1);
    try {
      chunks.set(match[1], JSON.parse(raw));
    } catch {
      // 非 JSON 的 chunk（图片/视频二进制等）跳过
    }
  }
  return chunks;
}

function activityIdFromChunk(node: any): string | null {
  let found: string | null = null;
  const walk = (value: any) => {
    if (found || !value || typeof value !== "object") return;
    const content = value.content;
    if (content?.type === "Buffer" && Array.isArray(content.data)) {
      try {
        const text = Buffer.from(content.data).toString("utf8");
        const match = text.match(/"updateUrn":"urn:li:activity:(\d+)"/);
        if (match) {
          found = match[1];
          return;
        }
      } catch {
        // 非 UTF-8 buffer 跳过
      }
    }
    for (const child of Object.values(value)) walk(child);
  };
  walk(node);
  return found;
}

function collectSemanticIds(node: any, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectSemanticIds(item, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  if (typeof node.semanticId === "string") out.push(node.semanticId);
  for (const child of Object.values(node)) collectSemanticIds(child, out);
  return out;
}

/** semanticId（卡片的 update tracking id）-> activityId。 */
function buildSemanticActivityMap(chunks: RscChunkMap): Map<string, string> {
  const map = new Map<string, string>();
  for (const value of chunks.values()) {
    const activityId = activityIdFromChunk(value);
    if (!activityId) continue;
    for (const semanticId of collectSemanticIds(value)) {
      if (!map.has(semanticId)) map.set(semanticId, activityId);
    }
  }
  return map;
}

/** 只收集真正的文本节点，跳过 className/url/actionLabel 等属性值。 */
function collectTextNodes(node: any, out: string[]): void {
  if (typeof node === "string") {
    // Flight 属性引用（例如 $20f:props:children:props:textProps）不是正文
    if (!/^\$[0-9a-f]+:props:/.test(node)) out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    if (node[0] === "$") {
      const props = node[3];
      if (props && typeof props === "object" && props.children !== undefined) {
        collectTextNodes(props.children, out);
      }
      return;
    }
    for (const item of node) collectTextNodes(item, out);
    return;
  }
  if (node && typeof node === "object" && node.children !== undefined) {
    collectTextNodes(node.children, out);
  }
}

function normalizeExcerpt(parts: string[]): string {
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** 从 feed-commentary 组件里收集正文文本块。 */
function extractCommentaryTexts(node: any, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) extractCommentaryTexts(item, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (node.viewTrackingSpecs?.viewName === "feed-commentary") {
    const walk = (value: any) => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (!value || typeof value !== "object") return;
      if (value.textProps?.children) {
        const parts: string[] = [];
        collectTextNodes(value.textProps.children, parts);
        const text = normalizeExcerpt(parts);
        if (text) out.push(text);
      }
      for (const child of Object.values(value)) walk(child);
    };
    walk(node.children);
  }
  for (const child of Object.values(node)) extractCommentaryTexts(child, out);
}

function walkChunkRefs(node: any, chunks: RscChunkMap, visited: Set<string>, out: string[]): void {
  if (typeof node === "string") {
    const match = node.match(/^\$L?([0-9a-f]+)$/);
    if (match && chunks.has(match[1]) && !visited.has(match[1])) {
      visited.add(match[1]);
      const value = chunks.get(match[1]);
      if (value != null) {
        extractCommentaryTexts(value, out);
        walkChunkRefs(value, chunks, visited, out);
      }
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) walkChunkRefs(item, chunks, visited, out);
    return;
  }
  if (node && typeof node === "object") {
    for (const child of Object.values(node)) walkChunkRefs(child, chunks, visited, out);
  }
}

function extractBalancedArray(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "[") depth++;
    else if (char === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 从 RSC 响应里按卡片抽正文：activityId -> excerpt。
 *
 * 每张 feed 卡的正文在它自己的 refs 里（update-card-focus -> feed-commentary -> textProps），
 * 卡片根上有 `update-card-focus<semanticId>FeedType_*`；semanticId 再通过 trackingScope 的
 * `updateUrn` 对到 activityId。这样不依赖正文块出现顺序，也不受转发帖多块影响。
 */
export function extractExcerptsByActivity(text: string): Map<string, string> {
  const result = new Map<string, string>();
  const marker = "update-card-focus";
  if (!text.includes(marker)) return result;

  const chunks = parseRscChunkMap(text);
  const semanticToActivity = buildSemanticActivityMap(chunks);
  const seen = new Set<string>();
  let index = 0;
  while ((index = text.indexOf(marker, index)) >= 0) {
    const hint = text.slice(index, index + 300);
    const hintSemanticId = (hint.match(/update-card-focus(.+?)FeedType_/) || [])[1] || null;
    if (hintSemanticId && seen.has(hintSemanticId)) {
      index += marker.length;
      continue;
    }

    const start = text.lastIndexOf('["$","$', index);
    const jsonText = start >= 0 ? extractBalancedArray(text, start) : null;
    if (jsonText) {
      const semanticId = (jsonText.match(/update-card-focus(.+?)FeedType_/) || [])[1] || null;
      if (semanticId && !seen.has(semanticId)) {
        seen.add(semanticId);
        const activityId = semanticToActivity.get(semanticId);
        if (activityId) {
          let card: any = null;
          try {
            card = JSON.parse(jsonText);
          } catch {
            card = null;
          }
          if (card) {
            const texts: string[] = [];
            extractCommentaryTexts(card, texts);
            walkChunkRefs(card, chunks, new Set(), texts);
            const unique = [...new Set(texts)].filter(Boolean);
            // 转发帖可能有两个正文块（转发者 caption + 原帖正文），取第一个。
            if (unique.length) result.set(activityId, unique[0]);
          }
        }
      }
    }
    index += marker.length;
  }
  return result;
}

/** 按出现顺序去重列出所有 activityId（顺序与 SSR 渲染的帖子顺序一致）。 */
export function activityIdsInOrder(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  ACTIVITY_URN_RE.lastIndex = 0;
  while ((m = ACTIVITY_URN_RE.exec(text))) {
    if (!isPlausibleActivityId(m[1])) continue;
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

/**
 * 从单个 RSC 响应（分页响应或首屏文档）里提取所有帖子的 activityId。
 *
 * 老格式（带根 chunk `0`）：feed item 的 `viewTrackingSpecs.trackingScope[0].breadcrumb.content`（Buffer），
 * 解码后是 `{"updateUrn":"urn:li:activity:<id>"}`。
 * 新格式（sdui，没有根 chunk `0`）：activityId 以 `feedUpdateUrn…activityId` / `urn:li:activity:<id>`
 * 的形式散在 chunk 里，按出现顺序去重抽取。
 */
export function activityIdsFromRsc(text: string): string[] {
  const chunks = new Map<string, any>();
  const re = /^([0-9a-f]+):(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let raw = m[2];
    if (raw.startsWith("I")) raw = raw.slice(1);
    else if (raw[0] === "T" || raw[0] === "J") raw = raw.slice(raw.indexOf(",") + 1);
    try { chunks.set(m[1], JSON.parse(raw)); } catch { /* ignore */ }
  }
  const root = chunks.get("0");
  if (!Array.isArray(root)) return activityIdsInOrder(text);

  const extractUrn = (node: any): string | null => {
    let found: string | null = null;
    const walk = (n: any, d: number) => {
      if (d > 40 || n == null || found) return;
      if (typeof n === "string") return;
      if (Array.isArray(n)) { for (const x of n) walk(x, d + 1); return; }
      if (typeof n === "object") {
        if (n.content && n.content.type === "Buffer" && Array.isArray(n.content.data)) {
          try {
            const o = JSON.parse(Buffer.from(n.content.data).toString("utf8"));
            if (o.updateUrn) found = String(o.updateUrn);
          } catch { /* ignore */ }
        }
        for (const k of Object.keys(n)) walk(n[k], d + 1);
      }
    };
    walk(node, 0);
    return found ? found.replace("urn:li:activity:", "") : null;
  };

  // 在 root 里找「feed items 数组」：第一个其元素能抽到 updateUrn 的数组
  for (const el of root) {
    if (!Array.isArray(el) || el.length === 0) continue;
    const urns: string[] = [];
    for (const it of el) {
      const u = extractUrn(it);
      if (u) urns.push(u);
    }
    if (urns.length >= 1) return urns;
  }
  return [];
}

/**
 * 从 RSC 文本抽取帖子列表。
 * 正文按卡片归属抽取（见 extractExcerptsByActivity）；卡片对不上 activityId 时 excerpt 为 null，
 * 不会把别的帖子正文硬塞进来。
 */
export function parseRscFeed(text: string, activityIds: string[]): RscPost[] {
  const ugcByActivity = ugcPostIdByActivityId(text);
  const excerptsByActivity = extractExcerptsByActivity(text);
  return activityIds.map((aid) => {
    const ugcId = ugcByActivity.get(aid);
    return {
      activityId: aid,
      url: `https://www.linkedin.com/feed/update/urn:li:activity:${aid}/`,
      publishIso: publishIsoFromActivityId(aid),
      likeCount: likeCount(text, aid, ugcId),
      commentCount: intValueAfterEither(text, aid, ugcId, "commentCount"),
      repostCount: intValueAfterEither(text, aid, ugcId, "repostCount"),
      excerpt: excerptsByActivity.get(aid) || null,
    };
  });
}


