import assert from "node:assert/strict";
import { test } from "node:test";
import { TikHubError } from "../../src/core/tikhub.ts";
import { instagramCommentFetcher, instagramPostKey } from "../../src/comments/fetchers/instagram.ts";
import { tiktokCommentFetcher, tiktokPostKey } from "../../src/comments/fetchers/tiktok.ts";
import { xCommentFetcher, xPostKey } from "../../src/comments/fetchers/x.ts";
import { youtubeCommentFetcher, youtubePostKey } from "../../src/comments/fetchers/youtube.ts";
import type { CommentApiClient, CommentFetchOptions, CommentPost } from "../../src/comments/types.ts";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function options(overrides: Partial<CommentFetchOptions> = {}): CommentFetchOptions {
  return {
    includeReplies: true,
    maxPagesPerPost: 10,
    maxReplyPagesPerComment: 3,
    maxRepliesPerComment: 50,
    maxCommentsPerPost: 500,
    ...overrides,
  };
}

function post(url: string, externalContentId = ""): CommentPost {
  return {
    contentId: "cont-test",
    externalContentId: externalContentId || null,
    url,
    publishTsMs: Date.now(),
    contentType: null,
    title: null,
    commentCount: 10,
  };
}

/** 按 URL 路由的假客户端：handler 收到 URL，返回该页 JSON。 */
function fakeClient(handler: (url: URL) => any): CommentApiClient & { calls: URL[] } {
  const calls: URL[] = [];
  return {
    baseUrl: "http://tikhub.test",
    calls,
    getJson: async (url: URL) => {
      const copy = new URL(url.toString());
      calls.push(copy);
      return handler(copy);
    },
  };
}

function fatalError(status = 403): TikHubError {
  return new TikHubError({
    kind: "business_error",
    label: "测试",
    requestUrl: "http://tikhub.test",
    message: "forbidden",
    httpStatus: status,
    retryable: false,
  });
}

const time = (seconds: number) => seconds;

test("帖子 ID 提取：URL 优先、外部 ID 兜底、非法输入报错", () => {
  assert.equal(instagramPostKey(post("https://www.instagram.com/p/ABC_123/")), "ABC_123");
  assert.equal(instagramPostKey(post("https://www.instagram.com/reel/XYZ-9/")), "XYZ-9");
  assert.equal(instagramPostKey(post("https://example.com/unknown", "fallback_1")), "fallback_1");
  assert.throws(() => instagramPostKey(post("https://example.com/unknown", "!!!")), /shortcode/);

  assert.equal(tiktokPostKey(post("https://www.tiktok.com/@brand/video/7412345678901234567")), "7412345678901234567");
  assert.equal(tiktokPostKey(post("https://www.tiktok.com/@brand/photo/7412345678901234567")), "7412345678901234567");
  assert.throws(() => tiktokPostKey(post("https://www.tiktok.com/@brand", "abc")), /aweme_id/);

  assert.equal(youtubePostKey(post("https://www.youtube.com/watch?v=abcdefghijk")), "abcdefghijk");
  assert.equal(youtubePostKey(post("https://www.youtube.com/shorts/shorts_123")), "shorts_123");
  assert.equal(youtubePostKey(post("https://youtu.be/be_12345678")), "be_12345678");
  assert.throws(() => youtubePostKey(post("https://www.youtube.com/@brand")), /video_id/);

  assert.equal(xPostKey(post("https://x.com/brand/status/1234567890")), "1234567890");
  assert.equal(xPostKey(post("https://example.com/unknown", "1234567890")), "1234567890");
  assert.throws(() => xPostKey(post("https://x.com/brand", "not-a-number")), /tweet_id/);
});

test("Instagram：分页、预览回复、回复接口、父子关系", async () => {
  const client = fakeClient((url) => {
    if (url.pathname.endsWith("/fetch_comment_replies")) {
      return {
        data: {
          data: {
            items: [{
              id: "r2",
              user: { id: 2, username: "bob" },
              text: "reply text",
              created_at: time(1700000200),
              comment_like_count: 1,
              parent_comment_id: "c1",
            }],
          },
          pagination_token: null,
        },
      };
    }
    const token = url.searchParams.get("pagination_token");
    if (token === "p2") {
      return {
        data: {
          data: {
            items: [{
              id: "c2",
              user: { id: 3, username: "carol" },
              text: "second",
              created_at: time(1700000300),
              child_comment_count: 0,
            }],
            pagination_token: null,
          },
        },
      };
    }
    return {
      data: {
        data: {
          items: [{
            id: "c1",
            user: { id: 1, username: "alice" },
            text: "first",
            created_at: time(1700000000),
            comment_like_count: 5,
            child_comment_count: 2,
            preview_child_comments: [{
              id: "r1",
              user: { id: 4, username: "dave" },
              text: "preview reply",
              created_at: time(1700000100),
            }],
          }],
        },
        pagination_token: "p2",
      },
    };
  });

  const result = await instagramCommentFetcher.fetchComments({
    post: post("https://www.instagram.com/p/ABC_123/"),
    client,
    options: options(),
    logger: silentLogger,
  });

  assert.deepEqual(result.comments.map((item) => item.id).sort(), ["c1", "c2", "r1", "r2"]);
  const byId = new Map(result.comments.map((item) => [item.id, item]));
  assert.equal(byId.get("c1")?.parentCommentId, null);
  assert.equal(byId.get("r1")?.parentCommentId, "c1");
  assert.equal(byId.get("r1")?.rootCommentId, "c1");
  assert.equal(byId.get("r2")?.parentCommentId, "c1");
  assert.equal(byId.get("r2")?.rootCommentId, "c1");
  assert.equal(byId.get("c1")?.createdAtTsMs, 1700000000000);
  assert.equal(byId.get("c1")?.likeCount, 5);
  assert.equal(result.stats.topLevelCount, 2);
  assert.equal(result.stats.replyCount, 2);
  assert.equal(result.stats.apiCalls, 3);
  assert.deepEqual(result.errors, []);

  const replyCall = client.calls.find((call) => call.pathname.endsWith("/fetch_comment_replies"));
  assert.equal(replyCall?.searchParams.get("comment_id"), "c1");
  assert.equal(replyCall?.searchParams.get("code_or_url"), "ABC_123");
});

test("Instagram：--no-replies 只请求一级评论", async () => {
  const client = fakeClient(() => ({
    data: {
      data: {
        items: [{
          id: "c1",
          user: { id: 1, username: "alice" },
          text: "first",
          created_at: time(1700000000),
          child_comment_count: 3,
        }],
        pagination_token: null,
      },
    },
  }));
  const result = await instagramCommentFetcher.fetchComments({
    post: post("https://www.instagram.com/p/ABC_123/"),
    client,
    options: options({ includeReplies: false }),
    logger: silentLogger,
  });
  assert.deepEqual(result.comments.map((item) => item.id), ["c1"]);
  assert.equal(client.calls.some((call) => call.pathname.endsWith("/fetch_comment_replies")), false);
});

test("Instagram：单帖条数上限会截断并记 truncated", async () => {
  const client = fakeClient(() => ({
    data: {
      data: {
        items: [
          { id: "c1", user: { id: 1, username: "a" }, text: "1", created_at: 1 },
          { id: "c2", user: { id: 1, username: "a" }, text: "2", created_at: 2 },
          { id: "c3", user: { id: 1, username: "a" }, text: "3", created_at: 3 },
        ],
        pagination_token: "next",
      },
    },
  }));
  const result = await instagramCommentFetcher.fetchComments({
    post: post("https://www.instagram.com/p/ABC_123/"),
    client,
    options: options({ maxCommentsPerPost: 2, includeReplies: false }),
    logger: silentLogger,
  });
  assert.equal(result.comments.length, 2);
  assert.equal(result.stats.truncated, true);
});

test("Instagram：回复页失败保留已抓内容并返回错误", async () => {
  let replyCalls = 0;
  const client = fakeClient((url) => {
    if (url.pathname.endsWith("/fetch_comment_replies")) {
      replyCalls += 1;
      throw new Error("reply endpoint down");
    }
    return {
      data: {
        data: {
          items: [{
            id: "c1",
            user: { id: 1, username: "alice" },
            text: "first",
            created_at: 1,
            child_comment_count: 1,
          }],
          pagination_token: null,
        },
      },
    };
  });
  const result = await instagramCommentFetcher.fetchComments({
    post: post("https://www.instagram.com/p/ABC_123/"),
    client,
    options: options(),
    logger: silentLogger,
  });
  assert.deepEqual(result.comments.map((item) => item.id), ["c1"]);
  assert.equal(replyCalls, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /reply endpoint down/);
});

test("Instagram：v2 5xx 自动切 v3，并解析 v3 一级评论和回复", async () => {
  const client = fakeClient((url) => {
    if (url.pathname.endsWith("/v3/get_post_comments")) {
      return {
        data: {
          comments: [{
            pk: "v3c1",
            user: { id: "1", username: "alice" },
            text: "v3 first",
            created_at: 1,
            comment_like_count: 3,
            child_comment_count: 1,
            media_id: "media-1",
          }],
          comment_count: 2,
          has_more_comments: false,
        },
      };
    }
    if (url.pathname.endsWith("/v3/get_comment_replies")) {
      return {
        data: {
          child_comments: [{
            pk: "v3r1",
            user: { id: "2", username: "bob" },
            text: "v3 reply",
            created_at: 2,
            parent_comment_id: "v3c1",
          }],
          has_more_head_child_comments: false,
          has_more_tail_child_comments: false,
        },
      };
    }
    throw new TikHubError({
      kind: "http_error",
      label: "Instagram v2",
      requestUrl: url.toString(),
      message: "v2 500",
      httpStatus: 500,
      retryable: true,
    });
  });

  const result = await instagramCommentFetcher.fetchComments({
    post: post("https://www.instagram.com/reel/DeRyIgCgf59/"),
    client,
    options: options(),
    logger: silentLogger,
  });

  assert.deepEqual(result.comments.map((item) => item.id).sort(), ["v3c1", "v3r1"]);
  const byId = new Map(result.comments.map((item) => [item.id, item]));
  assert.equal(byId.get("v3c1")?.parentCommentId, null);
  assert.equal(byId.get("v3r1")?.parentCommentId, "v3c1");
  assert.equal(byId.get("v3r1")?.rootCommentId, "v3c1");
  assert.deepEqual(result.errors, []);
  assert.equal(client.calls.some((call) => call.pathname.endsWith("/v3/get_post_comments")), true);
  assert.equal(client.calls.some((call) => call.pathname.endsWith("/v3/get_comment_replies")), true);
});

test("Instagram：v2 的 resource-not-exist 业务错误也会切 v3（DeRy 场景）", async () => {
  const client = fakeClient((url) => {
    if (url.pathname.endsWith("/v3/get_post_comments")) {
      return { data: { comments: [], comment_count: 0, has_more_comments: false } };
    }
    throw new TikHubError({
      kind: "business_error",
      label: "Instagram v2",
      requestUrl: url.toString(),
      message: "TikHub Instagram 帖子评论失败：HTTP 200 code=200 The requested resource does not exist",
      httpStatus: 200,
      responseCode: 200,
      retryable: false,
    });
  });

  const result = await instagramCommentFetcher.fetchComments({
    post: post("https://www.instagram.com/reel/DeRyIgCgf59/"),
    client,
    options: options(),
    logger: silentLogger,
  });

  assert.deepEqual(result.comments, []);
  assert.deepEqual(result.errors, []);
  assert.equal(client.calls.filter((call) => call.pathname.endsWith("/v3/get_post_comments")).length, 1);
});

test("Instagram：429 不切 v3（同一账号限流，换版本没意义）", async () => {
  const client = fakeClient((url) => {
    if (url.pathname.endsWith("/v3/get_post_comments")) {
      return { data: { comments: [], comment_count: 0 } };
    }
    throw new TikHubError({
      kind: "http_error",
      label: "Instagram v2",
      requestUrl: url.toString(),
      message: "HTTP 429 Too Many Requests",
      httpStatus: 429,
      retryable: true,
    });
  });

  const result = await instagramCommentFetcher.fetchComments({
    post: post("https://www.instagram.com/p/ABC_123/"),
    client,
    options: options(),
    logger: silentLogger,
  });

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /429/);
  assert.equal(client.calls.some((call) => call.pathname.endsWith("/v3/get_post_comments")), false);
});

test("Instagram：401/403 立即抛出，不按帖子吞掉", async () => {
  const client = fakeClient(() => {
    throw fatalError(403);
  });
  await assert.rejects(
    () => instagramCommentFetcher.fetchComments({
      post: post("https://www.instagram.com/p/ABC_123/"),
      client,
      options: options(),
      logger: silentLogger,
    }),
    (error: unknown) => error instanceof TikHubError && error.httpStatus === 403,
  );
});

test("TikTok：一级评论 + 回复分页 + 父子关系", async () => {
  const client = fakeClient((url) => {
    if (url.pathname.endsWith("/fetch_video_comment_replies")) {
      return {
        data: {
          comments: [
            {
              cid: "r1",
              user: { uid: "u2", nickname: "bob" },
              text: "reply",
              create_time: 1700000200,
              reply_id: "c1",
              reply_to_reply_id: "0",
            },
            {
              cid: "r2",
              user: { uid: "u4", nickname: "dave" },
              text: "nested reply",
              create_time: 1700000250,
              reply_id: "c1",
              reply_to_reply_id: "r1",
            },
          ],
          has_more: false,
          cursor: 0,
        },
      };
    }
    const cursor = url.searchParams.get("cursor");
    if (cursor === "100") {
      return {
        data: {
          comments: [{
            cid: "c2",
            user: { uid: "u3", nickname: "carol" },
            text: "second",
            create_time: 1700000300,
            reply_comment_total: 0,
          }],
          has_more: false,
          cursor: 0,
        },
      };
    }
    return {
      data: {
        comments: [{
          cid: "c1",
          user: { uid: "u1", nickname: "alice" },
          text: "first",
          create_time: 1700000000,
          digg_count: 9,
          reply_comment_total: 1,
        }],
        has_more: true,
        cursor: 100,
      },
    };
  });

  const result = await tiktokCommentFetcher.fetchComments({
    post: post("https://www.tiktok.com/@brand/video/7412345678901234567"),
    client,
    options: options(),
    logger: silentLogger,
  });

  assert.deepEqual(result.comments.map((item) => item.id).sort(), ["c1", "c2", "r1", "r2"]);
  const reply = result.comments.find((item) => item.id === "r1");
  assert.equal(reply?.parentCommentId, "c1");
  assert.equal(reply?.rootCommentId, "c1");
  const nested = result.comments.find((item) => item.id === "r2");
  assert.equal(nested?.parentCommentId, "r1");
  assert.equal(nested?.rootCommentId, "c1");
  assert.equal(result.stats.topLevelCount, 2);
  assert.equal(result.stats.replyCount, 2);
  assert.equal(result.comments.find((item) => item.id === "c1")?.createdAtTsMs, 1700000000000);
});

test("YouTube：回复 continuation_token 分页，时间存 0", async () => {
  const client = fakeClient((url) => {
    if (url.pathname.endsWith("/get_video_comment_replies")) {
      const token = url.searchParams.get("reply_continuation_token");
      if (token === "r2") {
        return {
          data: {
            comments: [{
              comment_id: "r2",
              author: { channel_id: "ch3", display_name: "carol" },
              content: "second reply",
              like_count: "1",
              reply_count: "0",
            }],
            continuation_token: null,
          },
        };
      }
      return {
        data: {
          comments: [{
            comment_id: "r1",
            author: { channel_id: "ch2", display_name: "bob" },
            content: "first reply",
            like_count: "2",
            reply_count: "0",
          }],
          continuation_token: "r2",
        },
      };
    }
    return {
      data: {
        comments: [{
          comment_id: "c1",
          author: { channel_id: "ch1", display_name: "alice" },
          content: "top",
          like_count: "5",
          reply_count: "2",
          reply_continuation_token: "r1",
        }],
        continuation_token: null,
      },
    };
  });

  const result = await youtubeCommentFetcher.fetchComments({
    post: post("https://www.youtube.com/watch?v=abcdefghijk"),
    client,
    options: options(),
    logger: silentLogger,
  });

  assert.deepEqual(result.comments.map((item) => item.id).sort(), ["c1", "r1", "r2"]);
  const top = result.comments.find((item) => item.id === "c1");
  assert.equal(top?.createdAtTsMs, 0);
  assert.equal(top?.likeCount, 5);
  assert.equal(result.comments.find((item) => item.id === "r2")?.parentCommentId, "c1");
  assert.equal(result.stats.replyPages, 2);
});

function graphqlPage(entries: any[], cursor: string | null): any {
  return {
    data: {
      threaded_conversation_with_injections_v2: {
        instructions: [{
          type: "TimelineAddEntries",
          entries: [
            ...entries,
            ...(cursor ? [{ content: { entryType: "TimelineTimelineCursor", cursorType: "Bottom", value: cursor } }] : []),
          ],
        }],
      },
    },
  };
}

function tweetResult({ id, parentId, username = "alice", text = "hi" }: { id: string; parentId?: string; username?: string; text?: string }): any {
  return {
    item: {
      itemContent: {
        tweet_results: {
          result: {
            __typename: "Tweet",
            legacy: {
              id_str: id,
              full_text: text,
              created_at: "2026-01-02T03:04:05.000Z",
              favorite_count: 7,
              reply_count: 1,
              in_reply_to_status_id_str: parentId || null,
            },
            core: {
              user_results: {
                result: {
                  rest_id: `u-${username}`,
                  core: { screen_name: username },
                },
              },
            },
          },
        },
      },
    },
  };
}

test("X：GraphQL 结构、cursor 翻页、回复上溯到一级评论", async () => {
  const client = fakeClient((url) => {
    const cursor = url.searchParams.get("cursor");
    if (cursor === "bottom-2") {
      return graphqlPage([
        { content: { entryType: "TimelineTimelineModule", items: [tweetResult({ id: "4", parentId: "1", username: "dana" })] } },
      ], null);
    }
    return graphqlPage([
      { content: { entryType: "TimelineTimelineModule", items: [tweetResult({ id: "2", parentId: "1", username: "bob" })] } },
      { content: { entryType: "TimelineTimelineModule", items: [tweetResult({ id: "3", parentId: "2", username: "carol" })] } },
    ], "bottom-2");
  });

  const result = await xCommentFetcher.fetchComments({
    post: post("https://x.com/brand/status/1"),
    client,
    options: options(),
    logger: silentLogger,
  });

  assert.deepEqual(result.comments.map((item) => item.id).sort(), ["2", "3", "4"]);
  const byId = new Map(result.comments.map((item) => [item.id, item]));
  assert.equal(byId.get("2")?.parentCommentId, null);
  assert.equal(byId.get("3")?.parentCommentId, "2");
  assert.equal(byId.get("3")?.rootCommentId, "2");
  assert.equal(byId.get("4")?.parentCommentId, null);
  assert.equal(result.stats.topLevelCount, 2);
  assert.equal(result.stats.replyCount, 1);
  assert.equal(byId.get("2")?.createdAtTsMs, Date.parse("2026-01-02T03:04:05.000Z"));
});

test("X：data.thread 清洗结构（接口实测结构）", async () => {
  const client = fakeClient(() => ({
    data: {
      id: "1",
      replies: 3,
      thread: [
        {
          id: "2",
          text: "@brand hi",
          created_at: "Fri Oct 30 11:03:48 +0000 2026",
          likes: 4,
          replies: 1,
          conversation_id: "1",
          author: { rest_id: "u2", screen_name: "bob" },
        },
        {
          id: "3",
          text: "another",
          created_at: "Fri Oct 30 12:00:00 +0000 2026",
          likes: 0,
          replies: 0,
          conversation_id: "1",
          author: { rest_id: "u3", screen_name: "carol" },
        },
      ],
    },
  }));

  const result = await xCommentFetcher.fetchComments({
    post: post("https://x.com/brand/status/1"),
    client,
    options: options(),
    logger: silentLogger,
  });

  assert.deepEqual(result.comments.map((item) => item.id), ["2", "3"]);
  const first = result.comments[0];
  assert.equal(first.username, "bob");
  assert.equal(first.userId, "u2");
  assert.equal(first.likeCount, 4);
  assert.equal(first.createdAtTsMs, Date.parse("Fri Oct 30 11:03:48 +0000 2026"));
  assert.equal(first.parentCommentId, null);
  assert.equal(result.stats.topLevelCount, 2);
});

test("X：--no-replies 过滤时间线里的回复；清洗结构也能解析", async () => {
  const client = fakeClient(() => ({
    data: {
      tweets: [
        { id_str: "2", full_text: "top", created_at: "2026-01-02T03:04:05.000Z", user: { id_str: "u1", screen_name: "alice" }, in_reply_to_status_id_str: "1" },
        { id_str: "3", full_text: "nested", created_at: "2026-01-02T03:04:06.000Z", user: { id_str: "u2", screen_name: "bob" }, in_reply_to_status_id_str: "2" },
      ],
      cursor: null,
    },
  }));

  const result = await xCommentFetcher.fetchComments({
    post: post("https://x.com/brand/status/1"),
    client,
    options: options({ includeReplies: false }),
    logger: silentLogger,
  });

  assert.deepEqual(result.comments.map((item) => item.id), ["2"]);
  assert.equal(result.stats.topLevelCount, 1);
  assert.equal(result.stats.replyCount, 0);
});
