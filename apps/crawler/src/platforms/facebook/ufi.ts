/**
 * Facebook 帖子互动指标（点赞 / 评论 / 分享 / 播放）在 GraphQL 里的取数逻辑。
 *
 * 旧结构（2026-10-30 之前，renderer = DefaultCometUFISummaryAndActionsRenderer）：
 *   feedback.reaction_count.count
 *   feedback.share_count.count
 *   feedback.comments_count_summary_renderer.feedback.comment_rendering_instance.comments.total_count
 *   feedback.video_view_count_renderer.feedback.play_count
 *
 * 新结构（2026-10-31 起，renderer = DefaultModernCometUFISummaryAndActionsRenderer）：
 *   根上的 reaction_count / share_count / comments_count_summary_renderer 都没了，
 *   计数拆进 adaptive_ufi_action_renderers[]，每个 action 一个 renderer：
 *     UFIStoryReactActionRenderer.feedback.reaction_count.count
 *     UFICommentActionRenderer.feedback.comment_rendering_instance.comments.total_count
 *     XFBUFIAdaptiveShareActionRenderer.feedback.share_count.count
 *
 * 新结构优先，旧结构保留（Facebook 可能回滚）。两边都取不到时返回空字符串。
 */

function firstTruthyText(...values) {
  for (const value of values) {
    if (!value) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function findAdaptiveFeedback(feedbackRoot, field) {
  const renderers = feedbackRoot?.adaptive_ufi_action_renderers;
  if (!Array.isArray(renderers)) return null;
  for (const renderer of renderers) {
    const feedback = renderer?.feedback;
    if (feedback && feedback[field] != null) return feedback;
  }
  return null;
}

export function extractFacebookUfiTexts(feedbackRoot) {
  const reactionFeedback = findAdaptiveFeedback(feedbackRoot, "reaction_count");
  const commentFeedback = findAdaptiveFeedback(feedbackRoot, "comment_rendering_instance");
  const shareFeedback = findAdaptiveFeedback(feedbackRoot, "share_count");
  const playFeedback = findAdaptiveFeedback(feedbackRoot, "play_count");

  return {
    likeText: firstTruthyText(
      reactionFeedback?.reaction_count?.count,
      feedbackRoot?.reaction_count?.count,
      feedbackRoot?.if_viewer_cannot_see_seen_by_member_list?.reaction_count?.count,
    ),
    commentText: firstTruthyText(
      commentFeedback?.comment_rendering_instance?.comments?.total_count,
      feedbackRoot?.comments_count_summary_renderer?.feedback?.comment_rendering_instance?.comments?.total_count,
    ),
    shareText: firstTruthyText(
      shareFeedback?.share_count?.count,
      feedbackRoot?.share_count?.count,
    ),
    playText: firstTruthyText(
      playFeedback?.play_count,
      feedbackRoot?.video_view_count_renderer?.feedback?.play_count,
    ),
  };
}
