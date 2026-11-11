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

const COMMENTS_PATH = "/api/v1/youtube/web_v2/get_video_comments";
const REPLIES_PATH = "/api/v1/youtube/web_v2/get_video_comment_replies";
const LANGUAGE_CODE = "zh-CN";
const COUNTRY_CODE = "US";

/** 帖子 URL / 外部 ID → YouTube video_id。 */
export function youtubePostKey(post: CommentPost): string {
  const fromUrl = firstMatch(post.url, [
    /[?&]v=([A-Za-z0-9_-]{6,})/,
    /\/shorts\/([A-Za-z0-9_-]+)/,
    /\/live\/([A-Za-z0-9_-]+)/,
    /\/embed\/([A-Za-z0-9_-]+)/,
    /youtu\.be\/([A-Za-z0-9_-]+)/,
  ]);
  const key = (fromUrl || String(post.externalContentId || "")).trim();
  if (!key || !/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error(`YouTube 帖子缺少 video_id：${post.url || post.contentId}`);
  }
  return key;
}

function commentsPage(json: any): { items: any[]; token: string | null } | null {
  const data = json?.data;
  if (!data || typeof data !== "object" || !Array.isArray(data.comments)) return null;
  const token = data.continuation_token ?? data.next_continuation_token ?? null;
  return { items: data.comments, token: token == null ? null : String(token) };
}

function validateComments(json: any): string | null {
  if (!commentsPage(json)) return "缺少评论列表 data.comments";
  return null;
}

function parseItem(item: any, parentCommentId: string | null = null, rootCommentId: string | null = null): FetchedComment | null {
  return makeComment({
    id: item?.comment_id,
    userId: item?.author?.channel_id,
    username: item?.author?.display_name,
    text: item?.content,
    // YouTube 接口只给「1天前」这类相对时间，没有精确发布时间；和旧数据一致存 0。
    createdAt: undefined,
    likeCount: item?.like_count,
    replyCount: item?.reply_count,
    parentCommentId,
    rootCommentId,
  });
}

async function fetchReplies(
  context: Parameters<CommentFetcher["fetchComments"]>[0],
  collector: CommentCollector,
  errors: string[],
  videoId: string,
  parentId: string,
  firstToken: string,
): Promise<void> {
  const { client, options } = context;
  let token: string | null = firstToken;
  let pages = 0;
  let added = 0;

  while (!collector.isFull && token) {
    if (pages >= options.maxReplyPagesPerComment || added >= options.maxRepliesPerComment) {
      collector.stats.truncated = true;
      break;
    }

    const url = tikhubUrl(client, REPLIES_PATH);
    url.searchParams.set("reply_continuation_token", token);
    url.searchParams.set("language_code", LANGUAGE_CODE);
    url.searchParams.set("country_code", COUNTRY_CODE);
    url.searchParams.set("need_format", "true");

    collector.recordRequest();
    let json: any;
    try {
      json = await client.getJson(url, {
        label: `YouTube 子评论 ${videoId}/${parentId}`,
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
      const reply = parseItem(item, parentId, parentId);
      if (collector.push(reply)) added += 1;
    }
    token = page.token;
  }
}

export const youtubeCommentFetcher: CommentFetcher = {
  code: "youtube",
  name: "YouTube",
  fetchComments: async (context): Promise<CommentFetchResult> => {
    const { post, client, options } = context;
    const videoId = youtubePostKey(post);
    const collector = new CommentCollector(options.maxCommentsPerPost);
    const errors: string[] = [];
    let token: string | null = null;

    while (!collector.isFull) {
      if (collector.stats.pages >= options.maxPagesPerPost) {
        if (token) collector.stats.truncated = true;
        break;
      }

      const url = tikhubUrl(client, COMMENTS_PATH);
      url.searchParams.set("video_id", videoId);
      url.searchParams.set("language_code", LANGUAGE_CODE);
      url.searchParams.set("country_code", COUNTRY_CODE);
      url.searchParams.set("sort_by", "newest");
      url.searchParams.set("need_format", "true");
      if (token) url.searchParams.set("continuation_token", token);

      collector.recordRequest();
      let json: any;
      try {
        json = await client.getJson(url, {
          label: `YouTube 视频评论 ${videoId}`,
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
        const replyToken = item?.reply_continuation_token ? String(item.reply_continuation_token) : "";
        if (replyToken) {
          await fetchReplies(context, collector, errors, videoId, topLevel.id, replyToken);
        }
      }

      token = page.token;
      if (!token) break;
    }

    return { comments: collector.comments, stats: collector.stats, errors };
  },
};
