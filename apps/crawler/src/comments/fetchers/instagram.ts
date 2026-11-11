import { TikHubError } from "../../core/tikhub.ts";
import {
  CommentCollector,
  describeError,
  firstMatch,
  isFatalTikHubError,
  makeComment,
  tikhubUrl,
} from "../shared.ts";
import type {
  CommentFetcher,
  CommentFetchResult,
  CommentPost,
  FetchedComment,
} from "../types.ts";

const COMMENTS_PATH = "/api/v1/instagram/v2/fetch_post_comments";
const REPLIES_PATH = "/api/v1/instagram/v2/fetch_comment_replies";
const COMMENTS_V3_PATH = "/api/v1/instagram/v3/get_post_comments";
const REPLIES_V3_PATH = "/api/v1/instagram/v3/get_comment_replies";

/** 帖子 URL / 外部 ID → shortcode。 */
export function instagramPostKey(post: CommentPost): string {
  const fromUrl = firstMatch(post.url, [
    /\/p\/([A-Za-z0-9_-]+)/,
    /\/reel\/([A-Za-z0-9_-]+)/,
    /\/tv\/([A-Za-z0-9_-]+)/,
  ]);
  const key = (fromUrl || String(post.externalContentId || "")).trim();
  if (!key || !/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error(`Instagram 帖子缺少 shortcode：${post.url || post.contentId}`);
  }
  return key;
}

function itemsOf(json: any): { items: any[]; paginationToken: string | null } | null {
  const inner = json?.data?.data && typeof json.data.data === "object"
    ? json.data.data
    : json?.data && Array.isArray(json.data.items)
      ? json.data
      : null;
  if (!inner || !Array.isArray(inner.items)) return null;
  // Instagram v2 的分页 token 在 data.pagination_token；个别版本放在 data.data 里，两个都认。
  const token = json?.data?.pagination_token
    ?? inner.pagination_token
    ?? inner.next_pagination_token
    ?? null;
  return { items: inner.items, paginationToken: token == null ? null : String(token) };
}

function validateComments(json: any): string | null {
  if (!itemsOf(json)) return "缺少评论列表 data.data.items";
  return null;
}

function parseItem(item: any, parentCommentId: string | null = null, rootCommentId: string | null = null): FetchedComment | null {
  return makeComment({
    id: item?.id,
    userId: item?.user?.id,
    username: item?.user?.username,
    text: item?.text,
    createdAt: item?.created_at,
    // Instagram 评论接口字段是 comment_like_count；兼容旧字段名。
    likeCount: item?.comment_like_count ?? item?.like_count,
    replyCount: item?.child_comment_count,
    parentCommentId,
    rootCommentId,
  });
}

async function fetchReplies(
  context: Parameters<CommentFetcher["fetchComments"]>[0],
  collector: CommentCollector,
  errors: string[],
  key: string,
  topLevel: FetchedComment,
): Promise<void> {
  const { client, options } = context;
  const parentId = topLevel.id;
  let token: string | null = null;
  let pages = 0;
  let added = 0;

  while (!collector.isFull) {
    if (pages >= options.maxReplyPagesPerComment || added >= options.maxRepliesPerComment) {
      if (token) collector.stats.truncated = true;
      break;
    }

    const url = tikhubUrl(client, REPLIES_PATH);
    url.searchParams.set("code_or_url", key);
    url.searchParams.set("comment_id", parentId);
    if (token) url.searchParams.set("pagination_token", token);

    collector.recordRequest();
    let json: any;
    try {
      json = await client.getJson(url, {
        label: `Instagram 子评论 ${key}/${parentId}`,
        validate: validateComments,
      });
    } catch (error) {
      if (isFatalTikHubError(error)) throw error;
      errors.push(`评论 ${parentId} 的回复：${describeError(error)}`);
      break;
    }
    collector.recordPage("reply");
    pages += 1;

    const page = itemsOf(json);
    if (!page || !page.items.length) break;
    for (const item of page.items) {
      // 回复行带 parent_comment_id（可能是另一条回复）；root 始终是本条一级评论。
      const directParent = String(item?.parent_comment_id || "").trim() || parentId;
      const reply = parseItem(item, directParent, parentId);
      if (collector.push(reply)) added += 1;
    }
    token = page.paginationToken;
    if (!token) break;
  }

}

function v3CommentsPage(json: any): {
  items: any[];
  nextToken: string | null;
  mediaId: string | null;
} | null {
  const data = json?.data;
  if (!data || !Array.isArray(data.comments)) return null;
  const next = data.next_min_id ?? data.next_max_id ?? data.next_cursor ?? null;
  const mediaId = data.caption?.media_id ?? data.media_id ?? null;
  return {
    items: data.comments,
    nextToken: next == null ? null : String(next),
    mediaId: mediaId == null ? null : String(mediaId),
  };
}

function validateV3Comments(json: any): string | null {
  return v3CommentsPage(json) ? null : "缺少评论列表 data.comments";
}

function v3RepliesPage(json: any): { items: any[]; nextToken: string | null } | null {
  const data = json?.data;
  if (!data || !Array.isArray(data.child_comments)) return null;
  const next = data.next_min_child_cursor ?? data.next_min_id ?? data.next_max_id ?? null;
  return {
    items: data.child_comments,
    nextToken: next == null ? null : String(next),
  };
}

function parseV3Item(
  item: any,
  parentCommentId: string | null = null,
  rootCommentId: string | null = null,
): FetchedComment | null {
  return makeComment({
    id: item?.pk ?? item?.id ?? item?.strong_id__,
    userId: item?.user?.id,
    username: item?.user?.username,
    text: item?.text,
    createdAt: item?.created_at,
    likeCount: item?.comment_like_count ?? item?.like_count,
    replyCount: item?.child_comment_count,
    parentCommentId,
    rootCommentId,
  });
}

function shouldTryV3(error: unknown): boolean {
  if (!(error instanceof TikHubError)) return true;
  if (isFatalTikHubError(error)) return false;
  const status = error.httpStatus ?? error.responseCode;
  // 429 是账号/套餐级限流，换版本也一样；402/401/403 已按 fatal 处理。
  if (status === 429) return false;
  // 5xx、网络错误、响应结构异常、业务错误（含 v2 的 resource not exist 误报）都试 v3。
  return true;
}

async function fetchV3Replies(
  context: Parameters<CommentFetcher["fetchComments"]>[0],
  collector: CommentCollector,
  errors: string[],
  mediaId: string,
  topLevel: FetchedComment,
): Promise<void> {
  const { client, options } = context;
  let token: string | null = null;
  let pages = 0;
  let added = 0;

  while (!collector.isFull) {
    if (pages >= options.maxReplyPagesPerComment || added >= options.maxRepliesPerComment) {
      if (token) collector.stats.truncated = true;
      break;
    }

    const url = tikhubUrl(client, REPLIES_V3_PATH);
    url.searchParams.set("media_id", mediaId);
    url.searchParams.set("comment_id", topLevel.id);
    if (token) url.searchParams.set("min_id", token);

    collector.recordRequest();
    let json: any;
    try {
      json = await client.getJson(url, {
        label: `Instagram v3 子评论 ${topLevel.id}`,
        validate: (value) => (v3RepliesPage(value) ? null : "缺少 data.child_comments"),
        maxAttempts: 1,
      });
    } catch (error) {
      if (isFatalTikHubError(error)) throw error;
      errors.push(`评论 ${topLevel.id} 的 v3 回复：${describeError(error)}`);
      break;
    }
    collector.recordPage("reply");
    pages += 1;

    const page = v3RepliesPage(json);
    if (!page || !page.items.length) break;
    for (const item of page.items) {
      const directParent = String(item?.parent_comment_id || "").trim() || topLevel.id;
      if (collector.push(parseV3Item(item, directParent, topLevel.id))) added += 1;
    }
    token = page.nextToken;
    if (!token) break;
  }
}

/** v2 失败时的备用通道；只有一级评论首屏失败才会走到这里。 */
async function fetchV3Comments(
  context: Parameters<CommentFetcher["fetchComments"]>[0],
  key: string,
): Promise<CommentFetchResult> {
  const { client, options } = context;
  const collector = new CommentCollector(options.maxCommentsPerPost);
  const errors: string[] = [];
  let token: string | null = null;
  let fallbackMediaId: string | null = null;

  while (!collector.isFull) {
    if (collector.stats.pages >= options.maxPagesPerPost) {
      if (token) collector.stats.truncated = true;
      break;
    }

    const url = tikhubUrl(client, COMMENTS_V3_PATH);
    url.searchParams.set("code", key);
    url.searchParams.set("sort_order", "newest");
    if (token) url.searchParams.set("min_id", token);

    collector.recordRequest();
    let json: any;
    try {
      json = await client.getJson(url, {
        label: `Instagram v3 帖子评论 ${key}`,
        validate: validateV3Comments,
        maxAttempts: 1,
      });
    } catch (error) {
      if (isFatalTikHubError(error) || collector.stats.pages === 0) throw error;
      errors.push(describeError(error));
      break;
    }
    collector.recordPage("top");

    const page = v3CommentsPage(json);
    if (!page) break;
    if (!fallbackMediaId) fallbackMediaId = page.mediaId;

    for (const item of page.items) {
      const topLevel = parseV3Item(item);
      if (!topLevel) continue;
      if (!collector.push(topLevel)) {
        if (collector.isFull) break;
        continue;
      }
      if (!options.includeReplies) continue;

      const expected = Number(item?.child_comment_count ?? topLevel.replyCount ?? 0);
      if (expected <= 0 || collector.isFull) continue;
      const mediaId = String(item?.media_id || page.mediaId || fallbackMediaId || "").trim();
      if (!mediaId) {
        errors.push(`帖子 ${key} 缺少 media_id，跳过评论 ${topLevel.id} 的回复`);
        continue;
      }
      await fetchV3Replies(context, collector, errors, mediaId, topLevel);
    }

    token = page.nextToken;
    if (!token) break;
  }

  return { comments: collector.comments, stats: collector.stats, errors };
}

export const instagramCommentFetcher: CommentFetcher = {
  code: "instagram",
  name: "Instagram",
  fetchComments: async (context): Promise<CommentFetchResult> => {
    const { post, client, options } = context;
    const key = instagramPostKey(post);
    const collector = new CommentCollector(options.maxCommentsPerPost);
    const errors: string[] = [];
    let token: string | null = null;

    while (!collector.isFull) {
      if (collector.stats.pages >= options.maxPagesPerPost) {
        if (token) collector.stats.truncated = true;
        break;
      }

      const url = tikhubUrl(client, COMMENTS_PATH);
      url.searchParams.set("code_or_url", key);
      url.searchParams.set("sort_by", "recent");
      if (token) url.searchParams.set("pagination_token", token);

      collector.recordRequest();
      let json: any;
      try {
        json = await client.getJson(url, {
          label: `Instagram 帖子评论 ${key}`,
          validate: validateComments,
          // 首屏失败会切 v3；先只打一次，避免 v2 重试三次再 fallback。
          maxAttempts: collector.stats.pages === 0 ? 1 : undefined,
        });
      } catch (error) {
        if (isFatalTikHubError(error)) throw error;
        if (collector.stats.pages === 0 && collector.comments.length === 0 && shouldTryV3(error)) {
          context.logger.warn(`Instagram v2 评论失败，切换 v3：${describeError(error)}`);
          return fetchV3Comments(context, key);
        }
        errors.push(describeError(error));
        break;
      }
      collector.recordPage("top");

      const page = itemsOf(json);
      if (!page || !page.items.length) break;

      for (const item of page.items) {
        const topLevel = parseItem(item);
        if (!topLevel) continue;
        if (!collector.push(topLevel)) {
          if (collector.isFull) break;
          continue;
        }
        if (!options.includeReplies) continue;

        const preview = Array.isArray(item?.preview_child_comments) ? item.preview_child_comments : [];
        for (const child of preview) {
          const directParent = String(child?.parent_comment_id || "").trim() || topLevel.id;
          collector.push(parseItem(child, directParent, topLevel.id));
        }

        const expected = topLevel.replyCount ?? 0;
        if (expected > preview.length && !collector.isFull) {
          await fetchReplies(context, collector, errors, key, topLevel);
        }
      }

      token = page.paginationToken;
      if (!token) break;
    }

    return { comments: collector.comments, stats: collector.stats, errors };
  },
};
