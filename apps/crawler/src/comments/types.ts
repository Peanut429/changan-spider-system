import type { Logger } from "../core/logger.ts";
import type { TikHubJsonGetter } from "../core/tikhub.ts";

/** 从库里取出来的一条帖子（只包含评论任务需要的字段）。 */
export type CommentPost = {
  contentId: string;
  externalContentId: string | null;
  url: string;
  publishTsMs: number | null;
  contentType: string | null;
  title: string | null;
  /** 最近一次每日指标里的评论数，仅用于决定是否请求和汇总。 */
  commentCount: number | null;
};

/** 归一化后的评论，platform 字段由入库层补。 */
export type FetchedComment = {
  id: string;
  userId: string;
  username: string;
  text: string;
  /** 毫秒；平台不给精确时间（如 YouTube）时为 0。 */
  createdAtTsMs: number;
  likeCount: number | null;
  replyCount: number | null;
  /** 一级评论为 null；二级回复指向直接父评论。 */
  parentCommentId: string | null;
  /** 二级回复所属的一级评论。 */
  rootCommentId: string | null;
};

export type CommentFetchStats = {
  topLevelCount: number;
  replyCount: number;
  pages: number;
  replyPages: number;
  apiCalls: number;
  truncated: boolean;
};

export type CommentFetchOptions = {
  includeReplies: boolean;
  maxPagesPerPost: number;
  maxReplyPagesPerComment: number;
  maxRepliesPerComment: number;
  maxCommentsPerPost: number;
};

export type CommentFetchResult = {
  comments: FetchedComment[];
  stats: CommentFetchStats;
  /** 非致命错误：已经抓到的评论仍会入库，帖子记失败以便重试。 */
  errors: string[];
};

/**
 * fetcher 只依赖 baseUrl + getJson。
 * 单测可以传假 client，不需要真的发 HTTP。
 */
export type CommentApiClient = {
  baseUrl: string;
  getJson: TikHubJsonGetter;
};

export type CommentFetcherContext = {
  post: CommentPost;
  client: CommentApiClient;
  options: CommentFetchOptions;
  logger: Logger;
};

export type CommentFetcher = {
  code: string;
  name: string;
  fetchComments: (context: CommentFetcherContext) => Promise<CommentFetchResult>;
};
