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

const COMMENTS_PATH = "/api/v1/tiktok/app/v3/fetch_video_comments";
const REPLIES_PATH = "/api/v1/tiktok/app/v3/fetch_video_comment_replies";
const PAGE_COUNT = "20";

/** 帖子 URL / 外部 ID → aweme_id。 */
export function tiktokPostKey(post: CommentPost): string {
  const fromUrl = firstMatch(post.url, [
    /\/video\/(\d+)/,
    /\/photo\/(\d+)/,
    /\/v\/(\d+)\.html/,
  ]);
  const key = (fromUrl || String(post.externalContentId || "")).trim();
  if (!key || !/^\d+$/.test(key)) {
    throw new Error(`TikTok 帖子缺少 aweme_id：${post.url || post.contentId}`);
  }
  return key;
}

function commentsPage(json: any): { items: any[]; cursor: string | null } | null {
  const data = json?.data;
  if (!data || typeof data !== "object" || !Array.isArray(data.comments)) return null;
  const hasMore = Boolean(data.has_more);
  const cursor = data.cursor == null ? null : String(data.cursor);
  return { items: data.comments, cursor: hasMore ? cursor : null };
}

function validateComments(json: any): string | null {
  if (!commentsPage(json)) return "缺少评论列表 data.comments";
  return null;
}

function parseItem(item: any, parentCommentId: string | null = null, rootCommentId: string | null = null): FetchedComment | null {
  return makeComment({
    id: item?.cid,
    userId: item?.user?.uid,
    username: item?.user?.nickname,
    text: item?.text,
    createdAt: item?.create_time,
    likeCount: item?.digg_count,
    replyCount: item?.reply_comment_total,
    parentCommentId,
    rootCommentId,
  });
}

async function fetchReplies(
  context: Parameters<CommentFetcher["fetchComments"]>[0],
  collector: CommentCollector,
  errors: string[],
  awemeId: string,
  topLevel: FetchedComment,
): Promise<void> {
  const { client, options } = context;
  const parentId = topLevel.id;
  let cursor: string | null = null;
  let pages = 0;
  let added = 0;

  while (!collector.isFull) {
    if (pages >= options.maxReplyPagesPerComment || added >= options.maxRepliesPerComment) {
      if (cursor) collector.stats.truncated = true;
      break;
    }

    const url = tikhubUrl(client, REPLIES_PATH);
    url.searchParams.set("item_id", awemeId);
    url.searchParams.set("comment_id", parentId);
    url.searchParams.set("count", PAGE_COUNT);
    if (cursor) url.searchParams.set("cursor", cursor);

    collector.recordRequest();
    let json: any;
    try {
      json = await client.getJson(url, {
        label: `TikTok 子评论 ${awemeId}/${parentId}`,
        validate: validateComments,
      });
    } catch (error) {
      if (isFatalTikHubError(error)) throw error;
      errors.push(`评论 ${parentId} 的回复：${describeError(error)}`);
      break;
    }
    collector.recordPage("reply");
    pages += 1;

    const page = commentsPage(json);
    if (!page || !page.items.length) break;
    for (const item of page.items) {
      // reply_id 是线程根（一级评论）；reply_to_reply_id 非 0 时才是直接父评论。
      const rootId = String(item?.reply_id || "").trim() || parentId;
      const directParent = String(item?.reply_to_reply_id || "").trim();
      const parent = directParent && directParent !== "0" ? directParent : rootId;
      const reply = parseItem(item, parent, rootId);
      if (collector.push(reply)) added += 1;
    }
    cursor = page.cursor;
    if (!cursor) break;
  }
}

export const tiktokCommentFetcher: CommentFetcher = {
  code: "tiktok",
  name: "TikTok",
  fetchComments: async (context): Promise<CommentFetchResult> => {
    const { post, client, options } = context;
    const awemeId = tiktokPostKey(post);
    const collector = new CommentCollector(options.maxCommentsPerPost);
    const errors: string[] = [];
    let cursor: string | null = null;

    while (!collector.isFull) {
      if (collector.stats.pages >= options.maxPagesPerPost) {
        if (cursor) collector.stats.truncated = true;
        break;
      }

      const url = tikhubUrl(client, COMMENTS_PATH);
      url.searchParams.set("aweme_id", awemeId);
      url.searchParams.set("count", PAGE_COUNT);
      if (cursor) url.searchParams.set("cursor", cursor);

      collector.recordRequest();
      let json: any;
      try {
        json = await client.getJson(url, {
          label: `TikTok 作品评论 ${awemeId}`,
          validate: validateComments,
        });
      } catch (error) {
        if (isFatalTikHubError(error)) throw error;
        errors.push(describeError(error));
        break;
      }
      collector.recordPage("top");

      const page = commentsPage(json);
      if (!page || !page.items.length) break;

      for (const item of page.items) {
        const topLevel = parseItem(item);
        if (!topLevel) continue;
        if (!collector.push(topLevel)) {
          if (collector.isFull) break;
          continue;
        }
        if (!options.includeReplies) continue;
        if ((topLevel.replyCount ?? 0) > 0 && !collector.isFull) {
          await fetchReplies(context, collector, errors, awemeId, topLevel);
        }
      }

      cursor = page.cursor;
      if (!cursor) break;
    }

    return { comments: collector.comments, stats: collector.stats, errors };
  },
};
