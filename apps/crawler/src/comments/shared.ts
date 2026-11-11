import { numberOrNull, textOrNull, timestampOrNull } from "../core/coerce.ts";
import { TikHubError } from "../core/tikhub.ts";
import type { CommentApiClient, CommentFetchStats, FetchedComment } from "./types.ts";

export function textValue(value: unknown): string {
  return textOrNull(value) ?? "";
}

export function numberValue(value: unknown): number | null {
  return numberOrNull(value);
}

/** 拼接 TikHub 接口 URL；baseUrl 可被测试覆盖。 */
export function tikhubUrl(client: CommentApiClient, path: string): URL {
  return new URL(`${client.baseUrl}${path}`);
}

/** 从多个候选正则里取第一个匹配组。 */
export function firstMatch(text: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (match?.[1]) return match[1];
  }
  return "";
}

export function makeComment(fields: {
  id: unknown;
  userId?: unknown;
  username?: unknown;
  text?: unknown;
  createdAt?: unknown;
  likeCount?: unknown;
  replyCount?: unknown;
  parentCommentId?: string | null;
  rootCommentId?: string | null;
}): FetchedComment | null {
  const id = textValue(fields.id);
  if (!id) return null;
  return {
    id,
    userId: textValue(fields.userId),
    username: textValue(fields.username),
    text: textValue(fields.text),
    createdAtTsMs: timestampOrNull(fields.createdAt) ?? 0,
    likeCount: numberValue(fields.likeCount),
    replyCount: numberValue(fields.replyCount),
    parentCommentId: fields.parentCommentId ?? null,
    rootCommentId: fields.rootCommentId ?? null,
  };
}

/**
 * 收集器：按评论 ID 去重、统计一级/回复数、执行单帖总上限。
 * 达到上限后 push 返回 false 且 truncated=true，由 fetcher 停止翻页。
 */
export class CommentCollector {
  readonly comments: FetchedComment[] = [];
  readonly stats: CommentFetchStats = {
    topLevelCount: 0,
    replyCount: 0,
    pages: 0,
    replyPages: 0,
    apiCalls: 0,
    truncated: false,
  };
  private readonly seen = new Set<string>();
  private readonly maxComments: number;

  constructor(maxComments: number) {
    this.maxComments = maxComments;
  }

  get isFull(): boolean {
    return this.comments.length >= this.maxComments;
  }

  get size(): number {
    return this.comments.length;
  }

  push(comment: FetchedComment | null): boolean {
    if (!comment) return false;
    if (this.seen.has(comment.id)) return false;
    if (this.isFull) {
      this.stats.truncated = true;
      return false;
    }
    this.seen.add(comment.id);
    this.comments.push(comment);
    if (comment.parentCommentId === null) this.stats.topLevelCount += 1;
    else this.stats.replyCount += 1;
    return true;
  }

  /** 每次发起逻辑请求时调用（失败也算一次）。 */
  recordRequest(): void {
    this.stats.apiCalls += 1;
  }

  /** 成功拿到一页后调用。 */
  recordPage(kind: "top" | "reply"): void {
    if (kind === "top") this.stats.pages += 1;
    else this.stats.replyPages += 1;
  }

  /** X 的父子关系要等全部评论抓完才能确定，之后重新统计一级/回复数。 */
  recount(): void {
    this.stats.topLevelCount = this.comments.filter((comment) => comment.parentCommentId === null).length;
    this.stats.replyCount = this.comments.length - this.stats.topLevelCount;
  }
}

export function describeError(error: unknown): string {
  if (error instanceof TikHubError) {
    return `${error.label}：${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * 401/402/403 或缺少 API Key 属于全局失败：立即终止整个平台，
 * 不要为每个帖子重复写失败记录。
 */
export function isFatalTikHubError(error: unknown): boolean {
  if (!(error instanceof TikHubError)) return false;
  const status = error.httpStatus ?? error.responseCode;
  if (status === 401 || status === 402 || status === 403) return true;
  return /TIKHUB_API_KEY/.test(error.message);
}
