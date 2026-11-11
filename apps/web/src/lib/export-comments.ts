import { exportNumber, exportText, formatExportDateTime } from './export-format'

export type CommentExportRow = {
  postTitle: string | null
  postUrl: string
  postPublishTime: string | null
  commentId: string
  username: string
  userId: string
  text: string
  likeCount: number | null
  replyCount: number | null
  parentCommentId: string | null
  rootCommentId: string | null
  createdAt: string | null
  isReply: boolean
}

const safeFileName = (value: string) =>
  String(value || '评论')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || '评论'

/**
 * 评论导出：一个 sheet，一行一条评论。
 * 时间列固定按东八区（UTC+8）格式化成文本，避免 Excel 把时区/日期解析错；
 * 空值不写「—」，数字记 0，文本/时间留空。
 */
export async function downloadCommentsExcel({
  platformName,
  accountHandle,
  rows,
  fileBaseName,
}: {
  platformName: string
  accountHandle: string
  rows: CommentExportRow[]
  fileBaseName: string
}): Promise<void> {
  const XLSX = await import('xlsx')
  const headers = [
    '平台', '账号', '帖子标题', '帖子链接', '帖子发布时间',
    '评论ID', '用户昵称', '用户ID', '评论内容', '点赞数', '回复数',
    '评论层级', '父评论ID', '根评论ID', '评论时间',
  ]
  const body = rows.map((row) => [
    exportText(platformName),
    exportText(accountHandle),
    exportText(row.postTitle),
    exportText(row.postUrl),
    formatExportDateTime(row.postPublishTime),
    exportText(row.commentId),
    exportText(row.username),
    exportText(row.userId),
    exportText(row.text),
    exportNumber(row.likeCount),
    exportNumber(row.replyCount),
    row.isReply ? '回复' : '一级',
    exportText(row.parentCommentId),
    exportText(row.rootCommentId),
    formatExportDateTime(row.createdAt),
  ])
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...body])
  sheet['!cols'] = [
    { wch: 12 }, { wch: 24 }, { wch: 34 }, { wch: 55 }, { wch: 19 },
    { wch: 22 }, { wch: 20 }, { wch: 22 }, { wch: 70 }, { wch: 9 }, { wch: 9 },
    { wch: 9 }, { wch: 22 }, { wch: 22 }, { wch: 19 },
  ]
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, '评论数据')
  XLSX.writeFile(workbook, `${safeFileName(fileBaseName)}.xlsx`, { compression: true })
}
