import type { Task } from '@/lib/types'
import { formatNumber } from '@/lib/format'

export type DaySummary = {
  batches: number
  accounts: number
  success: number
  failed: number
  pending: number
  contents: number
  attention: number
  ticks: Array<'ok' | 'fail' | 'new' | 'idle'>
}

function accountsOf(task: Task): number {
  return task.coverageTotal || task.plannedAccounts || task.totalAccounts
}

function needsReview(task: Task): boolean {
  return task.runStatus === 'partial_failed' || task.status === 'failed'
}

/**
 * The whole day in one measure. Deliberately aggregate only: the per-batch
 * breakdown lives in the table, and repeating it here would be the same list
 * twice.
 */
export function summariseDay(tasks: Task[]): DaySummary {
  const summary: DaySummary = {
    batches: tasks.length,
    accounts: 0,
    success: 0,
    failed: 0,
    pending: 0,
    contents: 0,
    attention: 0,
    ticks: [],
  }

  for (const task of tasks) {
    summary.accounts += accountsOf(task)
    summary.success += task.successAccounts
    summary.failed += task.failedAccounts
    summary.pending += task.newAccounts
    summary.contents += task.contentMetricCount
    if (needsReview(task)) summary.attention += 1
  }

  // Above ~600 the marks stop resolving; the bar then reads as a solid line.
  if (summary.accounts <= 600) {
    for (const task of tasks) {
      const total = accountsOf(task)
      const success = Math.min(task.successAccounts, total)
      const failed = Math.min(task.failedAccounts, Math.max(0, total - success))
      const pending = Math.min(task.newAccounts, Math.max(0, total - success - failed))
      for (let index = 0; index < total; index += 1) {
        summary.ticks.push(
          index < success ? 'ok' : index < success + failed ? 'fail' : index < success + failed + pending ? 'new' : 'idle',
        )
      }
    }
  }

  return summary
}

export function DayStrip({ summary }: { summary: DaySummary }) {
  const coverage = summary.accounts > 0 ? Math.round((summary.success / summary.accounts) * 100) : 0

  return (
    <section className="cx-day" aria-label="今日抓取总量">
      <div className="cx-day-stats">
        <div className="cx-day-stat">
          <p className="cx-day-value">{formatNumber(summary.accounts)}</p>
          <p className="cx-day-label">个账号</p>
        </div>
        <div className="cx-day-stat">
          <p className="cx-day-value">{formatNumber(summary.contents)}</p>
          <p className="cx-day-label">条内容</p>
        </div>
        <div className="cx-day-stat" data-alert={summary.attention > 0 ? 'true' : undefined}>
          <p className="cx-day-value">{summary.attention}</p>
          <p className="cx-day-label">{summary.attention > 0 ? '个批次需复核' : '全部批次正常'}</p>
        </div>
      </div>

      <div className="cx-day-meter">
        <div
          className="cx-day-gauge"
          role="img"
          aria-label={`覆盖 ${summary.success} / ${summary.accounts} 个账号：${summary.failed} 个失败，${summary.pending} 个待补`}
        >
          {summary.ticks.length > 0 ? (
            summary.ticks.map((state, index) => (
              <i key={index} className="cx-day-tick" data-state={state} />
            ))
          ) : (
            <i className="cx-day-tick" data-state="idle" style={{ flex: '1 1 auto' }} />
          )}
        </div>
        <p className="cx-day-meter-label">覆盖 {coverage}%</p>
      </div>
    </section>
  )
}
