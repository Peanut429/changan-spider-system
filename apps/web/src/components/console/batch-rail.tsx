import { Link } from '@tanstack/react-router'
import { formatClock, formatNumber } from '@/lib/format'
import type { Task } from '@/lib/types'

type Tone = 'ok' | 'warn' | 'fail' | 'running'

const TONE_LABEL: Record<Tone, string> = {
  ok: '正常',
  warn: '部分失败',
  fail: '失败',
  running: '执行中',
}

/** Lower is calmer; used to pick the tone of a platform that ran more than once. */
const TONE_RANK: Record<Tone, number> = { ok: 0, warn: 1, fail: 2, running: 3 }

export type Lane = {
  code: string
  name: string
  total: number
  success: number
  failed: number
  pending: number
  contents: number
  startedAt: string | null
  finishedAt: string | null
  tone: Tone
  taskId: string
  taskCount: number
}

function toneOf(task: Task): Tone {
  if (task.status === 'running' || task.runStatus === 'running') return 'running'
  if (task.runStatus === 'partial_failed') return 'warn'
  if (task.status === 'failed' || task.status === 'cancelled') return 'fail'
  if (task.failedAccounts > 0) return 'fail'
  return 'ok'
}

function accountsOf(task: Task): number {
  return task.coverageTotal || task.plannedAccounts || task.totalAccounts
}

/**
 * One lane per platform. A platform can be crawled more than once on the same
 * day, so counts are summed and the worst tone wins.
 */
export function buildLanes(tasks: Task[]): Lane[] {
  const lanes = new Map<string, Lane>()

  for (const task of tasks) {
    const current = lanes.get(task.platformCode)
    const tone = toneOf(task)
    if (!current) {
      lanes.set(task.platformCode, {
        code: task.platformCode,
        name: task.platformName || task.platformCode,
        total: accountsOf(task),
        success: task.successAccounts,
        failed: task.failedAccounts,
        pending: task.newAccounts,
        contents: task.contentMetricCount,
        startedAt: task.runStartedAt,
        finishedAt: task.runFinishedAt,
        tone,
        taskId: task.id,
        taskCount: 1,
      })
      continue
    }

    current.total += accountsOf(task)
    current.success += task.successAccounts
    current.failed += task.failedAccounts
    current.pending += task.newAccounts
    current.contents += task.contentMetricCount
    current.taskCount += 1
    if (task.runStartedAt && (!current.startedAt || task.runStartedAt < current.startedAt)) {
      current.startedAt = task.runStartedAt
    }
    if (task.runFinishedAt && (!current.finishedAt || task.runFinishedAt > current.finishedAt)) {
      current.finishedAt = task.runFinishedAt
    }
    if (TONE_RANK[tone] > TONE_RANK[current.tone]) {
      current.tone = tone
      current.taskId = task.id
    }
  }

  return [...lanes.values()]
}

/**
 * One mark per account: covered, failed, still waiting, or untouched. Above 120
 * accounts the marks stop being visible, so the lane falls back to three
 * proportional segments.
 */
function CoverageMarks({ lane }: { lane: Lane }) {
  const { total, success, failed, pending } = lane

  if (total <= 0) {
    return <span className="cx-lane-bar" aria-hidden="true" />
  }

  if (total > 120) {
    const pct = (value: number) => `${(value / total) * 100}%`
    return (
      <span className="cx-lane-bar" data-dense="true" aria-hidden="true">
        <span className="cx-tick" data-state="ok" style={{ flex: `0 0 ${pct(success)}` }} />
        <span className="cx-tick" data-state="fail" style={{ flex: `0 0 ${pct(failed)}` }} />
        <span className="cx-tick" data-state="new" style={{ flex: `0 0 ${pct(pending)}` }} />
        <span className="cx-tick" data-state="idle" style={{ flex: '1 1 0' }} />
      </span>
    )
  }

  return (
    <span className="cx-lane-bar" aria-hidden="true">
      {Array.from({ length: total }, (_, index) => (
        <span
          key={index}
          className="cx-tick"
          data-state={
            index < success
              ? 'ok'
              : index < success + failed
                ? 'fail'
                : index < success + failed + pending
                  ? 'new'
                  : 'idle'
          }
        />
      ))}
    </span>
  )
}

function LaneRow({ lane, date }: { lane: Lane; date: string }) {
  const accounts = `${lane.success}/${lane.total}`
  const time =
    lane.startedAt && lane.finishedAt
      ? `${formatClock(lane.startedAt)} → ${formatClock(lane.finishedAt)}`
      : lane.startedAt
        ? `${formatClock(lane.startedAt)} → 进行中`
        : '—'

  return (
    <li className="cx-lane">
      <Link
        to="/tasks/$taskId"
        params={{ taskId: lane.taskId }}
        search={{ date }}
        className="cx-lane-link"
        aria-label={`${lane.name}：${accounts} 个账号，${TONE_LABEL[lane.tone]}，查看执行明细`}
      >
        <span className="cx-lane-name">{lane.name}</span>
        <CoverageMarks lane={lane} />
        <span className="cx-lane-num">{accounts}</span>
        <span className="cx-lane-sub">{formatNumber(lane.contents)} 条</span>
        <span className="cx-lane-time">{time}</span>
        <span className="cx-state" data-tone={lane.tone}>
          {TONE_LABEL[lane.tone]}
        </span>
      </Link>
    </li>
  )
}

export function BatchRail({ lanes, date }: { lanes: Lane[]; date: string }) {
  const accounts = lanes.reduce((sum, lane) => sum + lane.total, 0)
  const contents = lanes.reduce((sum, lane) => sum + lane.contents, 0)
  const attention = lanes.filter((lane) => lane.tone === 'warn' || lane.tone === 'fail')

  return (
    <section className="cx-rail" aria-label="今日批次覆盖">
      <div className="cx-rail-head">
        <p className="cx-rail-sum">
          <strong>{lanes.length} 个批次</strong> · {formatNumber(accounts)} 个账号 · {formatNumber(contents)} 条内容
        </p>
        <p className="cx-rail-flag">
          {attention.length > 0 ? `${attention.length} 个批次需要复核` : '全部批次正常'}
        </p>
      </div>

      <div className="cx-rail-head-row" aria-hidden="true">
        <span>平台</span>
        <span>覆盖</span>
        <span>账号</span>
        <span className="cx-col-sub">内容</span>
        <span>时段</span>
        <span>状态</span>
      </div>

      <ul className="cx-lanes">
        {lanes.map((lane) => (
          <LaneRow key={lane.code} lane={lane} date={date} />
        ))}
      </ul>
    </section>
  )
}
