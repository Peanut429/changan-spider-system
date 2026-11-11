/**
 * 评论接口的错误分类。
 *
 * TikHub 的业务错误经常是 HTTP 200 / code=200，但 data.status=false，
 * message 里写「resource does not exist」。这通常不是帖子真的被删了，
 * 而是上游接口对这个资源不兼容/无权限/评论关闭；重试不会变好，
 * 而 TikHub 每次请求都计费，所以这类错误不能进入重试队列。
 */

const PERMANENT_PATTERNS: RegExp[] = [
  /does not exist/i,
  /not\s+found/i,
  /resource\s+(?:does\s+not\s+exist|not\s+found|unavailable)/i,
  /deleted/i,
  /private/i,
  /permission/i,
  /not\s+authori[sz]ed/i,
  /comments?\s+(?:are\s+)?(?:disabled|closed|turned\s+off)/i,
  /评论.*(?:不存在|已删除|已关闭|无权|私密)/,
  /资源不存在/,
  /帖子不存在/,
];

/** 资源不存在、私密、无权限、评论关闭等永久性错误。 */
export function isPermanentCommentError(message: string | null | undefined): boolean {
  const text = String(message || "").trim();
  if (!text) return false;
  return PERMANENT_PATTERNS.some((pattern) => pattern.test(text));
}

export const COMMENT_NOT_RETRYABLE = "COMMENT_NOT_RETRYABLE";
export const COMMENT_FETCH_FAILED = "COMMENT_FETCH_FAILED";

/** 写进 scrape_raw_records.error_code 的分类。 */
export function commentFailureCode(message: string | null | undefined): string {
  return isPermanentCommentError(message) ? COMMENT_NOT_RETRYABLE : COMMENT_FETCH_FAILED;
}
