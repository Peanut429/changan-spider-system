export type Platform = {
  id: string
  code: string
  name: string
  enabled: boolean
}

export type TaskSummary = {
  pending: number
  running: number
  success: number
  failed: number
  cancelled: number
  accountsSuccess: number
  accountsFailed: number
  contentsSuccess: number
}

export type Task = {
  id: string
  platformId: string
  platformCode: string
  platformName: string
  accountType: string | null
  params: Record<string, unknown>
  priority: number
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled' | string
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
  coverageTotal: number
  accountMetricCount: number
  contentMetricCount: number
  rawRecordCount: number
  runError: string | null
  windowSince: string | null
  windowUntil: string | null
}

export type TaskListResponse = {
  date: string
  summary: TaskSummary
  pending: Task[]
  executed: Task[]
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

export type TaskAccount = {
  id: string
  accountId: string
  handle: string
  displayName: string | null
  profileUrl: string
  platformCode: string
  status: string
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
  accountType: string | null
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
  accountType: string
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
