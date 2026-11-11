/**
 * Excel 导出专用格式，页面展示仍用 format.ts。
 *
 * 规则：
 * - 时间统一按东八区（Asia/Shanghai）输出成 `YYYY-MM-DD HH:mm:ss` 文本，
 *   不写 ISO/UTC 原文，避免 Excel 按本机时区重新解析。
 * - 空值不写「—」：数字记 0，时间和文本留空单元格。
 */

/** 导出时间固定使用东八区，不跟随浏览器/服务器时区。 */
export const EXPORT_TIME_ZONE = 'Asia/Shanghai'

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const NAIVE_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/

const dateTimePartsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: EXPORT_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

function parseExportTime(value: string | number | Date | null | undefined): number {
  if (value === null || value === undefined || value === '') return Number.NaN
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN

  const text = String(value).trim()
  if (!text) return Number.NaN
  // 只有日期时按东八区当天零点算，而不是 Date.parse 默认的 UTC 零点。
  if (DATE_ONLY.test(text)) return Date.parse(`${text}T00:00:00+08:00`)
  // 没有时区的时间按业务时区（东八区）解释，避免浏览器时区影响结果。
  if (NAIVE_DATE_TIME.test(text)) {
    return Date.parse(`${text.replace(' ', 'T')}+08:00`)
  }
  return Date.parse(text)
}

/** 毫秒时间戳或时间字符串 → 东八区 `YYYY-MM-DD HH:mm:ss`，空/非法值返回 ''。 */
export function formatExportDateTime(value: string | number | Date | null | undefined): string {
  const time = parseExportTime(value)
  if (!Number.isFinite(time)) return ''

  const parts = dateTimePartsFormatter.formatToParts(new Date(time))
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''

  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`
}

/** 数值列：空值、非数字一律记 0。 */
export function exportNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

/** 文本列：空值返回 ''，并去掉 Excel 不允许的控制字符。 */
export function exportText(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}
