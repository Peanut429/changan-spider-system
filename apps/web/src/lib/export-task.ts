import type { Task, TaskAccount, TaskContent } from './types'

const clean = (value: unknown) => {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
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

  const accountHeaders = ['平台', '账号', '主页链接', '账号类型', '粉丝数', '关注数', '帖子数']
  const accountRows = accounts.map((account) => [
    clean(task.platformCode), clean(account.handle), clean(account.profileUrl),
    clean(task.accountType), account.followersCount ?? '', account.followingCount ?? '',
    account.postsCount ?? '',
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
    clean(task.platformCode), clean(content.accountHandle), clean(content.contentType),
    clean(content.title), clean(content.summary), clean(content.url), clean(content.publishTime),
    content.playCount ?? '', content.readCount ?? '', content.exposureCount ?? '',
    content.likeCount ?? '', content.commentCount ?? '', content.shareCount ?? '',
    content.collectCount ?? '',
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
