import type {
  Account,
  AccountInput,
  AccountListResponse,
  Platform,
  CreateTaskInput,
  Task,
  TaskDetailResponse,
  TaskListResponse,
} from './types'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
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

export function getPlatforms() {
  return request<{ platforms: Platform[] }>('/api/platforms')
}

export function getAccountTypes() {
  return request<{ accountTypes: string[] }>('/api/account-types')
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

export function createTask(input: CreateTaskInput) {
  return request<{ task: Task }>('/api/tasks', {
    method: 'POST',
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

export function retryTask(id: string) {
  return request<{ task: unknown }>(`/api/tasks/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
  })
}
