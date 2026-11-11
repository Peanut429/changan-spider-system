import {
  CommentCollector,
  describeError,
  firstMatch,
  isFatalTikHubError,
  makeComment,
  textValue,
  tikhubUrl,
} from "../shared.ts";
import type {
  CommentFetcher,
  CommentFetchResult,
  CommentPost,
  FetchedComment,
} from "../types.ts";

const COMMENTS_PATH = "/api/v1/twitter/web/fetch_post_comments";

/** 帖子 URL / 外部 ID → tweet_id。 */
export function xPostKey(post: CommentPost): string {
  const fromUrl = firstMatch(post.url, [
    /\/status\/(\d+)/,
    /\/statuses\/(\d+)/,
  ]);
  const key = (fromUrl || String(post.externalContentId || "")).trim();
  if (!key || !/^\d+$/.test(key)) {
    throw new Error(`X 帖子缺少 tweet_id：${post.url || post.contentId}`);
  }
  return key;
}

/**
 * TikHub 的 X 评论接口实际返回（2026-11 实测）：
 *   data.thread: 整个会话的评论数组，字段为 id / text / created_at / likes /
 *   replies / author{rest_id,screen_name}，不带 in_reply_to，无法还原父子层级。
 * 为兼容接口变化，同时支持：
 *   1) 已清洗：data.thread / data.tweets / data.data / data.items 数组
 *   2) X Web GraphQL 原始结构：data.threaded_conversation_with_injections_v2.instructions
 */
function formattedItems(json: any): any[] | null {
  const data = json?.data;
  if (Array.isArray(data?.thread)) return data.thread;
  if (Array.isArray(data?.tweets)) return data.tweets;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(json?.tweets)) return json.tweets;
  return null;
}

function instructionsOf(json: any): any[] | null {
  const instructions = json?.data?.threaded_conversation_with_injections_v2?.instructions
    ?? json?.data?.instructions;
  return Array.isArray(instructions) ? instructions : null;
}

function validateComments(json: any): string | null {
  if (formattedItems(json) || instructionsOf(json)) return null;
  const apiError = Array.isArray(json?.errors) && json.errors.length
    ? String(json.errors[0]?.message || "unknown error")
    : "";
  return apiError
    ? `接口返回错误：${apiError}`
    : "无法识别的评论响应结构（data.thread / data.tweets / instructions 都缺失）";
}

function tweetResultNode(result: any): any {
  if (result?.__typename === "TweetWithVisibilityResults" && result.tweet) return result.tweet;
  return result;
}

function parseFormattedItem(item: any): FetchedComment | null {
  const user = item?.user || item?.author || {};
  const parent = textValue(item?.in_reply_to_status_id_str ?? item?.in_reply_to_status_id) || null;
  return makeComment({
    id: item?.id_str ?? item?.id,
    userId: user?.id_str ?? user?.id ?? user?.rest_id,
    username: user?.screen_name ?? user?.username,
    text: item?.full_text ?? item?.text ?? item?.display_text,
    createdAt: item?.created_at,
    likeCount: item?.favorite_count ?? item?.like_count ?? item?.likes,
    replyCount: item?.reply_count ?? item?.replies,
    parentCommentId: parent,
    rootCommentId: null,
  });
}

function parseTweetResult(result: any): FetchedComment | null {
  const node = tweetResultNode(result);
  const legacy = node?.legacy ?? node?.tweet?.legacy;
  if (!legacy) return null;
  const userResult = node?.core?.user_results?.result ?? node?.user_results?.result;
  const userCore = userResult?.core ?? null;
  const userLegacy = userResult?.legacy ?? null;
  const parent = textValue(legacy?.in_reply_to_status_id_str ?? legacy?.in_reply_to_status_id) || null;
  return makeComment({
    id: legacy?.id_str ?? legacy?.id,
    userId: userLegacy?.id_str ?? userResult?.rest_id ?? userLegacy?.id,
    username: userCore?.screen_name ?? userLegacy?.screen_name,
    text: legacy?.full_text ?? legacy?.text,
    createdAt: legacy?.created_at,
    likeCount: legacy?.favorite_count,
    replyCount: legacy?.reply_count,
    parentCommentId: parent,
    rootCommentId: null,
  });
}

function graphqlComments(instructions: any[]): any[] {
  const results: any[] = [];
  const readItem = (entry: any) => {
    const itemContent = entry?.item?.itemContent ?? entry?.itemContent;
    const result = itemContent?.tweet_results?.result;
    if (result) results.push(result);
  };
  for (const instruction of instructions) {
    if (Array.isArray(instruction?.entries)) {
      for (const entry of instruction.entries) {
        const content = entry?.content;
        if (!content) continue;
        if (content.entryType === "TimelineTimelineModule") {
          for (const moduleItem of content.items || []) readItem(moduleItem);
        } else if (content.itemContent) {
          readItem(content);
        }
      }
    }
    if (Array.isArray(instruction?.moduleItems)) {
      for (const moduleItem of instruction.moduleItems) readItem(moduleItem);
    }
  }
  return results;
}

function cursorOf(json: any, instructions: any[] | null): string | null {
  const data = json?.data;
  const candidates = [
    data?.cursor,
    data?.next_cursor,
    data?.bottom_cursor,
    json?.cursor,
    json?.next_cursor,
  ];
  for (const candidate of candidates) {
    const text = textValue(candidate);
    if (text) return text;
  }
  if (!instructions) return null;
  for (const instruction of instructions) {
    for (const entry of instruction?.entries || []) {
      const content = entry?.content;
      if (content?.entryType === "TimelineTimelineCursor" && content?.cursorType === "Bottom") {
        const value = textValue(content.value);
        if (value) return value;
      }
    }
  }
  return null;
}

function pageComments(json: any): FetchedComment[] {
  const formatted = formattedItems(json);
  if (formatted) return formatted.map(parseFormattedItem).filter(Boolean) as FetchedComment[];
  const instructions = instructionsOf(json);
  if (!instructions) return [];
  return graphqlComments(instructions).map(parseTweetResult).filter(Boolean) as FetchedComment[];
}

/**
 * X 的回复层级来自 in_reply_to_status_id_str：
 *   - 直接回复帖子 → 一级评论（parent/root 置空）
 *   - 回复某条评论 → parent 指向该评论，root 上溯到一级评论
 * 父评论没被这次翻页抓到时，root 退化为 parent。
 */
function linkReplies(comments: FetchedComment[], tweetId: string): void {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  for (const comment of comments) {
    const parent = comment.parentCommentId;
    if (!parent || parent === tweetId) {
      comment.parentCommentId = null;
      comment.rootCommentId = null;
      continue;
    }
    let root = parent;
    let cursor: string | null = parent;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      if (cursor === tweetId) break;
      const parentComment = byId.get(cursor);
      if (!parentComment) break;
      const grandParent = parentComment.parentCommentId;
      if (!grandParent || grandParent === tweetId) {
        root = cursor;
        break;
      }
      cursor = grandParent;
    }
    comment.rootCommentId = root;
  }
}

export const xCommentFetcher: CommentFetcher = {
  code: "x",
  name: "X",
  fetchComments: async (context): Promise<CommentFetchResult> => {
    const { post, client, options } = context;
    const tweetId = xPostKey(post);
    const collector = new CommentCollector(options.maxCommentsPerPost);
    const errors: string[] = [];
    let cursor: string | null = null;
    let previousCursor: string | null = null;

    while (!collector.isFull) {
      if (collector.stats.pages >= options.maxPagesPerPost) {
        if (cursor) collector.stats.truncated = true;
        break;
      }

      const url = tikhubUrl(client, COMMENTS_PATH);
      url.searchParams.set("tweet_id", tweetId);
      if (cursor) url.searchParams.set("cursor", cursor);

      collector.recordRequest();
      let json: any;
      try {
        json = await client.getJson(url, {
          label: `X 帖子评论 ${tweetId}`,
          validate: validateComments,
        });
      } catch (error) {
        if (isFatalTikHubError(error)) throw error;
        errors.push(describeError(error));
        break;
      }
      collector.recordPage("top");

      const comments = pageComments(json);
      for (const comment of comments) {
        if (!options.includeReplies) {
          const isTopLevel = !comment.parentCommentId || comment.parentCommentId === tweetId;
          if (!isTopLevel) continue;
        }
        collector.push(comment);
      }

      previousCursor = cursor;
      cursor = cursorOf(json, instructionsOf(json));
      // cursor 没变化说明接口没有下一页，避免死循环。
      if (!cursor || cursor === previousCursor) break;
    }

    linkReplies(collector.comments, tweetId);
    collector.recount();

    return { comments: collector.comments, stats: collector.stats, errors };
  },
};
