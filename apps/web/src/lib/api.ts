import type {
  Account,
  AccountInput,
  AccountListResponse,
  AccountTypesResponse,
  Platform,
  CreateTaskInput,
  CreateTasksInput,
  Task,
  TaskDetailResponse,
  TaskListResponse,
  AccountPostsResponse,
  AccountCommentsResponse,
  PostDetailResponse,
  CommentJob,
  CommentJobListResponse,
  CreateCommentJobInput,
} from './types'

// 部署在子路径时（BASE_PATH=/changan-data），接口也要带前缀
const base = import.meta.env.BASE_URL.replace(/\/$/, '')

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  })
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body
      ? String((body as { error: unknown }).error)
      : `请求失败（HTTP ${response.status}）`
    throw new Error(message)
  }
  return body as T
}

export function getTasks(date: string) {
  return request<TaskListResponse>(`/api/tasks?date=${encodeURIComponent(date)}`)
}

export function getTask(id: string) {
  return request<TaskDetailResponse>(`/api/tasks/${encodeURIComponent(id)}`)
}

export function rerunTask(
  id: string,
  mode: 'failed' | 'new' | 'selected',
  accountIds?: string[],
) {
  return request<{ task: Task; accountCount: number; mode: string }>(
    `/api/tasks/${encodeURIComponent(id)}/rerun`,
    {
      method: 'POST',
      body: JSON.stringify({ mode, accountIds }),
    },
  )
}

export function getPlatforms() {
  return request<{ platforms: Platform[] }>('/api/platforms')
}

export function getAccountTypes() {
  return request<AccountTypesResponse>('/api/account-types')
}

export function getAccounts(filters: {
  platformId?: string
  accountType?: string
  active?: string
  q?: string
  page?: number
  pageSize?: number
}) {
  const params = new URLSearchParams()
  if (filters.platformId) params.set('platformId', filters.platformId)
  if (filters.accountType) params.set('accountType', filters.accountType)
  if (filters.active) params.set('active', filters.active)
  if (filters.q) params.set('q', filters.q)
  if (filters.page) params.set('page', String(filters.page))
  if (filters.pageSize) params.set('pageSize', String(filters.pageSize))
  const query = params.toString()
  return request<AccountListResponse>(`/api/accounts${query ? `?${query}` : ''}`)
}

export function createAccount(input: AccountInput) {
  return request<{ account: Account }>('/api/accounts', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateAccount(id: string, input: AccountInput) {
  return request<{ account: Account }>(`/api/accounts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function updateAccountActive(id: string, active: boolean) {
  return request<{ ok: boolean }>(`/api/accounts/${encodeURIComponent(id)}/active`, {
    method: 'PATCH',
    body: JSON.stringify({ active }),
  })
}

export function createTasks(input: CreateTasksInput) {
  return request<{ task: Task; tasks: Task[] }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateTask(id: string, input: CreateTaskInput) {
  return request<{ task: Task }>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export type ImportAccountRow = {
  platformCode: string
  handle: string
  profileUrl: string
  displayName?: string
}

export function importAccounts(accounts: ImportAccountRow[], accountType: string) {
  return request<{ created: number; updated: number; skipped: number; errors: string[] }>('/api/accounts/import', {
    method: 'POST',
    body: JSON.stringify({ accounts, accountType }),
  })
}

export function deleteTask(id: string) {
  return request<{ ok: boolean; id: string }>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export function pauseTask(id: string) {
  return request<{ ok: boolean; id: string; status: string; already?: boolean }>(
    `/api/tasks/${encodeURIComponent(id)}/pause`,
    { method: 'POST' },
  )
}

export function resumeTask(id: string) {
  return request<{ ok: boolean; id: string; status: string; immediate?: boolean; already?: boolean }>(
    `/api/tasks/${encodeURIComponent(id)}/resume`,
    { method: 'POST' },
  )
}

export function retryTask(id: string) {
  return request<{ task: unknown }>(`/api/tasks/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
  })
}

export type AccountPostsFilters = {
  since?: string
  until?: string
  page?: number
  pageSize?: number
}

export function getAccountPosts(id: string, filters: AccountPostsFilters = {}) {
  const params = new URLSearchParams()
  if (filters.since) params.set('since', filters.since)
  if (filters.until) params.set('until', filters.until)
  if (filters.page) params.set('page', String(filters.page))
  if (filters.pageSize) params.set('pageSize', String(filters.pageSize))
  const query = params.toString()
  return request<AccountPostsResponse>(
    `/api/accounts/${encodeURIComponent(id)}/posts${query ? `?${query}` : ''}`,
  )
}

export function getAccountComments(
  id: string,
  filters: { since?: string; until?: string } = {},
) {
  const params = new URLSearchParams()
  if (filters.since) params.set('since', filters.since)
  if (filters.until) params.set('until', filters.until)
  const query = params.toString()
  return request<AccountCommentsResponse>(
    `/api/accounts/${encodeURIComponent(id)}/comments${query ? `?${query}` : ''}`,
  )
}

export function getPostDetail(id: string) {
  return request<PostDetailResponse>(
    `/api/posts/${encodeURIComponent(id)}`,
  )
}

export function getAccount(id: string) {
  return request<{ account: Account }>(`/api/accounts/${encodeURIComponent(id)}`)
}

export function getCommentJobs(limit = 20) {
  return request<CommentJobListResponse>(`/api/comment-jobs?limit=${limit}`)
}

export function getCommentJob(id: string) {
  return request<{ job: CommentJob }>(`/api/comment-jobs/${encodeURIComponent(id)}`)
}

export function createCommentJob(input: CreateCommentJobInput) {
  return request<{ job: CommentJob }>('/api/comment-jobs', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function getCommentJobFailedPosts(id: string) {
  return request<{ posts: import('./types').CommentJobFailedPost[] }>(
    `/api/comment-jobs/${encodeURIComponent(id)}/failed-posts`,
  )
}

export function retryCommentJob(id: string) {
  return request<{ job: CommentJob }>(`/api/comment-jobs/${encodeURIComponent(id)}/retry-failed`, {
    method: 'POST',
  })
}
