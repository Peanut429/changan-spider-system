export type Platform = {
  id: string
  code: string
  name: string
  enabled: boolean
}

export type TaskSummary = {
  pending: number
  paused: number
  running: number
  success: number
  failed: number
  cancelled: number
  reruns: number
  accountsSuccess: number
  accountsFailed: number
  contentsSuccess: number
}

/** A child task that is waiting in (or currently running from) the rerun queue. */
export type TaskRerun = {
  id: string
  parentTaskId: string | null
  platformId: string
  platformCode: string
  platformName: string
  accountType: string | null
  kind: string
  accountCount: number
  status: string
  priority: number
  scheduledAt: string | null
  createdAt: string | null
  parentScheduledAt: string | null
  runId: string | null
  runStatus: string | null
  runStartedAt: string | null
  runFinishedAt: string | null
  successAccounts: number
  failedAccounts: number
}

/** Compact copy of the active rerun attached to its parent task. */
export type ActiveRerun = {
  id: string
  status: string
  kind: string
  accountCount: number
  scheduledAt: string | null
  createdAt: string | null
  runStartedAt: string | null
  runFinishedAt: string | null
  successAccounts: number
  failedAccounts: number
}

export type TaskYesterday = {
  /** Business day, YYYY-MM-DD in Asia/Shanghai. */
  date: string
  /** Accounts in today's scope; the denominator for accountsWithData. */
  total: number
  /** Accounts that produced a successful metric row yesterday. */
  accountsWithData: number
  /** Sum of yesterday's per-account window content counts. */
  contentCount: number
}

export type Task = {
  id: string
  platformId: string
  platformCode: string
  platformName: string
  accountType: string | null
  params: Record<string, unknown>
  /** Set only on child tasks created by a rerun. */
  parentTaskId: string | null
  taskKind: string | null
  priority: number
  status: 'pending' | 'paused' | 'running' | 'success' | 'failed' | 'cancelled' | string
  scheduledAt: string | null
  attempts: number
  runId: string | null
  lastError: string | null
  runStatus: string | null
  runErrorCode: string | null
  runStartedAt: string | null
  runFinishedAt: string | null
  totalAccounts: number
  plannedAccounts: number
  successAccounts: number
  failedAccounts: number
  newAccounts: number
  /** Accounts waiting in a queued/running rerun. */
  queuedAccounts: number
  /** The rerun that is pending, paused or running for this task. */
  activeRerun: ActiveRerun | null
  coverageTotal: number
  accountMetricCount: number
  contentMetricCount: number
  rawRecordCount: number
  runError: string | null
  windowSince: string | null
  windowUntil: string | null
  yesterday: TaskYesterday | null
}

export type TaskListResponse = {
  date: string
  summary: TaskSummary
  pending: Task[]
  executed: Task[]
  /** Active child tasks across all dates; the queue the operator can act on. */
  reruns: TaskRerun[]
}

export type Run = {
  id: string
  status: string
  triggerType: string
  windowSince: string | null
  windowUntil: string | null
  startedAt: string | null
  finishedAt: string | null
  rawRecordCount: number
  accountMetricCount: number
  contentMetricCount: number
  totalAccounts: number
  plannedAccounts: number
  successAccounts: number
  failedAccounts: number
  totalContents: number
  successContents: number
  failedContents: number
  errorCode: string | null
  errorMessage: string | null
}

export type AccountYesterday = {
  date: string
  runStartedAt: string | null
  followersCount: number | null
  postsCount: number | null
  contentCountInWindow: number | null
}

export type TaskAccountQueue = {
  taskId: string
  status: 'pending' | 'paused' | 'running' | string
  kind: string
  scheduledAt: string | null
  createdAt: string | null
  accountCount: number
}

export type TaskAccount = {
  id: string
  accountId: string
  handle: string
  displayName: string | null
  profileUrl: string
  platformCode: string
  status: string
  /** Overlay: the account is waiting for a queued/paused/running rerun. */
  queue: TaskAccountQueue | null
  startedAt: string | null
  finishedAt: string | null
  contentFoundCount: number
  contentSavedCount: number
  failedContentCount: number
  followersCount: number | null
  followingCount: number | null
  postsCount: number | null
  contentCountInWindow: number | null
  newContentCount: number | null
  errorCode: string | null
  errorMessage: string | null
  source: string | null
  createdAt: string | null
  updatedAt: string | null
  latestRunId: string | null
  latestRunStatus: string | null
  latestRunStartedAt: string | null
  latestSuccessRunId: string | null
  isNew: boolean
  /** Same account on the previous business day; null when it has no successful run. */
  yesterday: AccountYesterday | null
}

export type TaskContent = {
  id: string
  externalContentId: string | null
  url: string
  contentType: string | null
  title: string | null
  summary: string | null
  publishTime: string | null
  playCount: number | null
  likeCount: number | null
  commentCount: number | null
  shareCount: number | null
  collectCount: number | null
  readCount: number | null
  exposureCount: number | null
  errorMessage: string | null
  capturedAt: string | null
  runId: string
  accountId: string
  accountHandle: string
}

export type TaskCoverage = {
  total: number
  success: number
  failed: number
  newAccounts: number
  running: number
  queued: number
  zeroContent: number
  disabled: number
}

export type TaskChildRun = {
  id: string
  kind: string
  accountCount: number
  plannedAccounts: number
  successAccounts: number
  failedAccounts: number
  contentMetricCount: number
  status: string
  scheduledAt: string | null
  createdAt: string | null
  runId: string | null
  runStatus: string | null
  runStartedAt: string | null
  runFinishedAt: string | null
}

export type TaskDetailResponse = {
  task: Task
  run: Run | null
  accounts: TaskAccount[]
  contents: TaskContent[]
  coverage: TaskCoverage
  childTasks: TaskChildRun[]
  yesterday: TaskYesterday | null
}

export type Account = {
  id: string
  platformId: string
  platformCode: string
  platformName: string
  handle: string
  displayName: string | null
  profileUrl: string
  externalAccountId: string | null
  active: boolean
  /** Primary/legacy type. New code reads `accountTypes`. */
  accountType: string | null
  accountTypes: string[]
  createdAt: string | null
  updatedAt: string | null
}

export type AccountListResponse = {
  accounts: Account[]
  total: number
  activeCount: number
  inactiveCount: number
  page: number
  pageSize: number
}

export type AccountInput = {
  platformId: string
  handle: string
  displayName: string
  profileUrl: string
  accountTypes: string[]
  active: boolean
}

export type CreateTaskInput = {
  platformId: string
  accountType: string
  scheduledAt: string
  windowStart: string
  windowEnd: string
  limit: number
}

/** One create submission can fan out into one task per selected platform. */
export type CreateTasksInput = Omit<CreateTaskInput, 'platformId'> & {
  platformIds: string[]
}

export type AccountTypesResponse = {
  accountTypes: string[]
  /** 账号类型 → 平台 ID → 启用账号数，用于默认选中“有账号的平台” */
  platformCounts: Record<string, Record<string, number>>
}

export type AccountMetrics = {
  followersCount: number | null
  followingCount: number | null
  postsCount: number | null
  capturedAt: string | null
}

export type AccountDetail = Account & { metrics: AccountMetrics | null }

export type AccountPost = {
  id: string
  externalContentId: string | null
  url: string
  contentType: string | null
  title: string | null
  summary: string | null
  publishTime: string | null
  /** 每日指标里的平台评论数；没有指标时为 null。 */
  platformCommentCount: number | null
  /** comment 表里实际抓到的评论数（一级 + 回复）。 */
  fetchedCommentCount: number
  topLevelCommentCount: number
  replyCommentCount: number
  lastCommentSeenAt: string | null
}

export type AccountPostSummary = {
  posts: number
  postsWithComments: number
  fetchedComments: number
  topLevelComments: number
  replyComments: number
  platformComments: number
}

export type AccountPostsResponse = {
  account: AccountDetail
  window: { since: string | null; until: string | null }
  posts: AccountPost[]
  total: number
  page: number
  pageSize: number
  summary: AccountPostSummary
}

export type AccountCommentRow = {
  id: string
  username: string
  userId: string
  text: string
  likeCount: number | null
  replyCount: number | null
  parentCommentId: string | null
  rootCommentId: string | null
  createdAt: string | null
  runId: string | null
  postId: string
  postUrl: string
  postTitle: string | null
  postPublishTime: string | null
}

export type AccountCommentsResponse = {
  account: AccountDetail
  window: { since: string | null; until: string | null }
  comments: AccountCommentRow[]
  total: number
  truncated: boolean
}

export type PostComment = {
  id: string
  username: string
  userId: string
  text: string
  likeCount: number | null
  replyCount: number | null
  parentCommentId: string | null
  rootCommentId: string | null
  createdAt: string | null
  runId: string | null
  lastSeenAt: string | null
}

export type PostDetailPost = AccountPost & {
  platformId: string
  platformCode: string
  platformName: string
  account: {
    id: string
    handle: string
    displayName: string | null
    profileUrl: string
    active: boolean
    platformCode: string
    platformName: string
  }
}

export type PostDetailResponse = {
  post: PostDetailPost
  comments: PostComment[]
  counts: { total: number; topLevel: number; replies: number; platform: number | null }
}

export type CommentJobOptions = {
  includeReplies: boolean
  maxCommentsPerPost: number
  maxRepliesPerComment: number
  maxPostsPerAccount: number
  includeZeroComments: boolean
  maxPagesPerPost?: number
  maxReplyPagesPerComment?: number
  contentIds?: string[]
  retryOfJobId?: string
}

export type CommentJob = {
  id: string
  status: 'pending' | 'running' | 'success' | 'partial_failed' | 'failed' | 'cancelled' | string
  accountIds: string[]
  platformCodes: string[]
  window: { since: string | null; until: string | null; sinceTsMs: number; untilTsMs: number }
  options: CommentJobOptions
  totalAccounts: number
  processedAccounts: number
  successAccounts: number
  failedAccounts: number
  totalPosts: number
  processedPosts: number
  fetchedComments: number
  insertedComments: number
  updatedComments: number
  failedPosts: number
  retryableFailedPosts: number
  runIds: string[]
  errorMessage: string | null
  createdAt: string | null
  startedAt: string | null
  finishedAt: string | null
  updatedAt: string | null
}

export type CommentJobFailedPost = {
  contentId: string
  url: string
  accountHandle: string
  platformCode: string
  errorMessage: string | null
  retryable: boolean
  attemptedAt: string | null
}

export type CommentJobListResponse = {
  jobs: CommentJob[]
  tikHubConfigured: boolean
  database?: { database: string; host: string; remote: boolean }
}

export type CreateCommentJobInput = {
  accountIds: string[]
  since: string
  until: string
  includeReplies: boolean
  maxCommentsPerPost: number
  maxRepliesPerComment: number
  maxPostsPerAccount?: number
  includeZeroComments?: boolean
}
