import { exportNumber, exportText, formatExportDateTime } from './export-format'
import type { Task, TaskAccount, TaskContent } from './types'

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

  const accountHeaders = ['平台', '账号', '主页链接', '账号类型', '粉丝数', '关注数', '帖子数']
  const accountRows = accounts.map((account) => [
    exportText(task.platformCode), exportText(account.handle), exportText(account.profileUrl),
    exportText(task.accountType), exportNumber(account.followersCount), exportNumber(account.followingCount),
    exportNumber(account.postsCount),
  ])
  const accountSheet = XLSX.utils.aoa_to_sheet([accountHeaders, ...accountRows])
  accountSheet['!cols'] = [
    { wch: 12 }, { wch: 24 }, { wch: 48 }, { wch: 10 }, { wch: 11 }, { wch: 11 }, { wch: 10 },
  ]
  XLSX.utils.book_append_sheet(workbook, accountSheet, '账号数据')

  const postHeaders = [
    '平台', '账号', '内容类型', '标题', '摘要', '链接', '发布时间',
    '播放数', '阅读数', '曝光数', '点赞数', '评论数', '转发数', '收藏数',
  ]
  const postRows = contents.map((content) => [
    exportText(task.platformCode), exportText(content.accountHandle), exportText(content.contentType),
    exportText(content.title), exportText(content.summary), exportText(content.url),
    formatExportDateTime(content.publishTime),
    exportNumber(content.playCount), exportNumber(content.readCount), exportNumber(content.exposureCount),
    exportNumber(content.likeCount), exportNumber(content.commentCount), exportNumber(content.shareCount),
    exportNumber(content.collectCount),
  ])
  const postSheet = XLSX.utils.aoa_to_sheet([postHeaders, ...postRows])
  postSheet['!cols'] = [
    { wch: 12 }, { wch: 24 }, { wch: 12 }, { wch: 34 }, { wch: 60 }, { wch: 55 },
    { wch: 20 }, { wch: 11 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
  ]
  XLSX.utils.book_append_sheet(workbook, postSheet, '帖子数据')

  const since = String(task.params.since || task.windowSince?.slice(0, 10) || '')
  const until = String(task.params.until || task.windowUntil?.slice(0, 10) || '')
  const safeName = `${task.platformName}_${task.accountType || '全部账号'}_${since}_${until}`
    .replace(/[\\/:*?"<>|]/g, '_')
  XLSX.writeFile(workbook, `${safeName}.xlsx`, { compression: true })
}
