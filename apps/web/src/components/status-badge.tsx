import { cn } from '@/lib/utils'

export type StatusTone = 'pending' | 'running' | 'success' | 'partial' | 'failed' | 'cancelled'

const META: Record<StatusTone, { label: string; className: string; dot: string }> = {
  pending: {
    label: '待执行',
    className: 'bg-amber-50 text-amber-800 ring-amber-200/80',
    dot: 'bg-amber-500',
  },
  running: {
    label: '执行中',
    className: 'bg-sky-50 text-sky-800 ring-sky-200/80',
    dot: 'bg-sky-500 animate-soft-pulse',
  },
  success: {
    label: '成功',
    className: 'bg-emerald-50 text-emerald-800 ring-emerald-200/80',
    dot: 'bg-emerald-500',
  },
  partial: {
    label: '部分失败',
    className: 'bg-orange-50 text-orange-800 ring-orange-200/80',
    dot: 'bg-orange-500',
  },
  failed: {
    label: '失败',
    className: 'bg-rose-50 text-rose-800 ring-rose-200/80',
    dot: 'bg-rose-500',
  },
  cancelled: {
    label: '已取消',
    className: 'bg-muted text-muted-foreground ring-border',
    dot: 'bg-muted-foreground/50',
  },
}

export function statusTone(status: string | null | undefined, runStatus?: string | null): StatusTone {
  if (runStatus === 'partial_failed') return 'partial'
  if (status === 'pending') return 'pending'
  if (status === 'running') return 'running'
  if (status === 'success') return 'success'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'partial_failed') return 'partial'
  return 'pending'
}

export function StatusBadge({
  status,
  runStatus,
  className,
}: {
  status: string | null | undefined
  runStatus?: string | null
  className?: string
}) {
  const tone = statusTone(status, runStatus)
  const meta = META[tone]
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset', meta.className, className)}>
      <span className={cn('size-1.5 rounded-full', meta.dot)} />
      {meta.label}
    </span>
  )
}
