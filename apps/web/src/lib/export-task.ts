import type { Task, TaskAccount, TaskContent } from './types'

const statusLabels: Record<string, string> = {
  success: '成功',
  failed: '失败',
  partial: '部分失败',
  pending: '新增待补',
  running: '执行中',
  disabled: '已禁用',
}

const clean = (value: unknown) => {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

const displayStatus = (account: TaskAccount) => {
  if (account.status === 'success' && Number(account.contentCountInWindow || 0) === 0) return '成功但 0 条'
  return statusLabels[account.status] || account.status
}

export async function downloadTaskExcel({
  task,
  accounts,
  contents,
}: {
  task: Task
  accounts: TaskAccount[]
  contents: TaskContent[]
}) {
  const XLSX = await import('xlsx')
  const workbook = XLSX.utils.book_new()

  const accountHeaders = [
    '平台', 'handle', '显示名称', '主页链接', '账号类型', '是否启用', '来源',
    '创建时间', '更新时间', '账号状态', '窗口内内容数', '粉丝数', '关注数',
    '帖子数', '最近执行', '最新 Run ID', '错误信息',
  ]
  const accountRows = accounts.map((account) => [
    clean(task.platformCode), clean(account.handle), clean(account.displayName),
    clean(account.profileUrl), clean(task.accountType), account.status === 'disabled' ? '否' : '是',
    clean(account.source), clean(account.createdAt), clean(account.updatedAt),
    displayStatus(account), account.contentCountInWindow ?? '',
    account.followersCount ?? '', account.followingCount ?? '', account.postsCount ?? '',
    clean(account.latestRunStartedAt), clean(account.latestRunId), clean(account.errorMessage),
  ])
  const accountSheet = XLSX.utils.aoa_to_sheet([accountHeaders, ...accountRows])
  accountSheet['!cols'] = [
    { wch: 12 }, { wch: 24 }, { wch: 24 }, { wch: 48 }, { wch: 10 }, { wch: 9 }, { wch: 14 },
    { wch: 20 }, { wch: 20 }, { wch: 14 }, { wch: 14 }, { wch: 11 }, { wch: 11 }, { wch: 10 },
    { wch: 20 }, { wch: 40 }, { wch: 45 },
  ]
  XLSX.utils.book_append_sheet(workbook, accountSheet, '账号数据')

  const postHeaders = [
    '平台', '账号', '账号显示名', '账号类型', '外部内容ID', '内容类型', '标题', '摘要',
    '链接', '发布时间', '播放数', '阅读数', '曝光数', '点赞数', '评论数', '转发数',
    '收藏数', '抓取时间', 'Run ID',
  ]
  const postRows = contents.map((content) => [
    clean(task.platformCode), clean(content.accountHandle), '',
    clean(task.accountType), clean(content.externalContentId), clean(content.contentType),
    clean(content.title), clean(content.summary), clean(content.url), clean(content.publishTime),
    content.playCount ?? '', content.readCount ?? '', content.exposureCount ?? '',
    content.likeCount ?? '', content.commentCount ?? '', content.shareCount ?? '',
    content.collectCount ?? '', clean(content.capturedAt), clean(content.runId),
  ])
  const postSheet = XLSX.utils.aoa_to_sheet([postHeaders, ...postRows])
  postSheet['!cols'] = [
    { wch: 12 }, { wch: 24 }, { wch: 22 }, { wch: 10 }, { wch: 26 }, { wch: 12 },
    { wch: 34 }, { wch: 60 }, { wch: 55 }, { wch: 20 }, { wch: 11 }, { wch: 10 },
    { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 20 }, { wch: 40 },
  ]
  XLSX.utils.book_append_sheet(workbook, postSheet, '帖子数据')

  const since = String(task.params.since || task.windowSince?.slice(0, 10) || '')
  const until = String(task.params.until || task.windowUntil?.slice(0, 10) || '')
  const safeName = `${task.platformName}_${task.accountType || '全部账号'}_${since}_${until}`
    .replace(/[\\/:*?"<>|]/g, '_')
  XLSX.writeFile(workbook, `${safeName}.xlsx`, { compression: true })
}
