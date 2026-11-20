// 发布时间的统一校验。
//
// 规则（来自业务）：
//   - 指标可以多接口/多字段互补：播放量拿不到拿收藏，少一部分好过一行都没有；
//   - 时间不行：时间不决定就无法判断这条数据属不属于当前窗口，宁可报错也不能丢；
//   - 报错时必须把当时的原始数据写进日志，否则线上只看到"失败了"，没法判断是上游改版还是偶发。
//
// 这里只管"发布时间"这一个字段，不碰任何指标。
import { FatalPlatformError } from "./errors.ts";

// 判断字段名是否和时间有关。先把 createTime / publishDate 这类驼峰拆成 create_time，
// 再按"整词"匹配 —— 否则 taken_at_ms 这种会漏掉，而它恰恰就是"字段改名"时的现场证据。
function looksTemporal(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return /(^|_)(time|times|date|dates|created|create|taken|publish|published|timestamp|stamp|ts)(_|$)/.test(normalized);
}

function shorten(value: unknown, max: number): string {
  if (value == null) return String(value);
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    try {
      const text = JSON.stringify(value);
      return text.length > max ? `${text.slice(0, max)}…` : text;
    } catch {
      return String(value);
    }
  }
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 把源数据里所有"时间有关"的字段捞出来。
 * 上游改版时，日志里能直接看到它把 created_time 改成了 createTime 之类。
 */
export function describeTimeFields(source: unknown, limit = 12): Record<string, string> {
  const out: Record<string, string> = {};
  const queue: Array<[any, number]> = [[source, 0]];
  while (queue.length && Object.keys(out).length < limit) {
    const [node, depth] = queue.shift()!;
    if (!node || typeof node !== "object" || depth > 3) continue;
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === "object") {
        if (depth < 3) queue.push([value, depth + 1]);
        continue;
      }
      if (!looksTemporal(key)) continue;
      out[`${depth ? "…." : ""}${key}`] = shorten(value, 60);
      if (Object.keys(out).length >= limit) break;
    }
  }
  return out;
}

export type PublishTimeContext = {
  platform: string;
  account: string;
  /** 内容类型，例如 视频 / 短视频 / 帖子 / 作品。 */
  kind?: string;
  url?: string;
  publishTime: unknown;
  /** 这条内容的原始响应对象，用来在报错时把现场数据打进日志。 */
  source?: unknown;
};

function parsePublishTime(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const text = String(value ?? "").trim();
  if (!text) return NaN;
  return Date.parse(text);
}

/**
 * 发布时间拿不到/解析不了时直接抛 FatalPlatformError：
 * 这是"上游结构变了、解析脚本要跟着改"的信号，不能静默跳过。
 * 抛之前先把原始数据打到日志里。
 */
export function assertPublishTime(ctx: PublishTimeContext): void {
  const parsed = parsePublishTime(ctx.publishTime);
  if (Number.isFinite(parsed)) return;

  const timeFields = describeTimeFields(ctx.source);
  const raw = shorten(ctx.source, 600);
  const where = [
    `platform=${ctx.platform}`,
    `account=${ctx.account || "(空)"}`,
    `type=${ctx.kind || "-"}`,
    `url=${ctx.url || "(空)"}`,
    `publishTime=${JSON.stringify(ctx.publishTime ?? null)}`,
    `时间字段=${JSON.stringify(timeFields)}`,
    `原始数据=${raw}`,
  ].join("\n  ");

  console.error(`[${ctx.platform}] 取不到发布时间，疑似上游结构变化，需要更新解析脚本：\n  ${where}`);
  throw new FatalPlatformError(
    `${ctx.platform} 取不到发布时间（account=${ctx.account || "-"}, type=${ctx.kind || "-"}, url=${ctx.url || "-"}）：`
    + `publishTime=${JSON.stringify(ctx.publishTime ?? null)}，`
    + `时间字段=${JSON.stringify(timeFields)}。上游结构可能已变化，需更新解析脚本`,
  );
}
