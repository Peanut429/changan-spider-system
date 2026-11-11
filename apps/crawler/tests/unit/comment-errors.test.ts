import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COMMENT_FETCH_FAILED,
  COMMENT_NOT_RETRYABLE,
  commentFailureCode,
  isPermanentCommentError,
} from "../../src/core/comment-errors.ts";

describe("comment error classification", () => {
  it("marks the TikHub resource-not-exist business error as permanent", () => {
    const message =
      "Instagram 帖子评论 DeRyIgCgf59：TikHub Instagram 帖子评论 DeRyIgCgf59失败："
      + "HTTP 200 code=200 The requested resource does not exist. Please check the input parameters";
    assert.equal(isPermanentCommentError(message), true);
    assert.equal(commentFailureCode(message), COMMENT_NOT_RETRYABLE);
  });

  it("marks permission/private/deleted messages as permanent", () => {
    assert.equal(isPermanentCommentError("The post is private"), true);
    assert.equal(isPermanentCommentError("permission denied"), true);
    assert.equal(isPermanentCommentError("评论已关闭"), true);
  });

  it("keeps transient errors retryable", () => {
    for (const message of [
      "TikHub Instagram 帖子评论失败：HTTP 429 Too Many Requests",
      "TikHub Instagram 帖子评论请求失败：fetch failed",
      "TikHub Instagram 帖子评论失败：HTTP 502 Bad Gateway",
      "写入评论失败：connection reset",
    ]) {
      assert.equal(isPermanentCommentError(message), false);
      assert.equal(commentFailureCode(message), COMMENT_FETCH_FAILED);
    }
  });

  it("does not classify an empty message as permanent", () => {
    assert.equal(isPermanentCommentError(null), false);
    assert.equal(isPermanentCommentError(""), false);
  });
});
