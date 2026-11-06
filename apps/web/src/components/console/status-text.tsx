import { statusTone, type StatusTone } from '@/components/status-badge'

const LABEL: Record<StatusTone, string> = {
  pending: '待执行',
  running: '执行中',
  success: '成功',
  partial: '部分失败',
  failed: '失败',
  cancelled: '已取消',
}

const TONE: Record<StatusTone, 'ok' | 'warn' | 'fail' | 'running' | 'idle'> = {
  pending: 'idle',
  running: 'running',
  success: 'ok',
  partial: 'warn',
  failed: 'fail',
  cancelled: 'idle',
}

/**
 * Status as a word plus a 6px mark. Same information as the old pill badge,
 * without adding a third container to every row.
 */
export function StatusText({
  status,
  runStatus,
}: {
  status: string | null | undefined
  runStatus?: string | null
}) {
  const tone = statusTone(status, runStatus)
  return (
    <span className="cx-status" data-tone={TONE[tone]}>
      {LABEL[tone]}
    </span>
  )
}
