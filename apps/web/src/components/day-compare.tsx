import { cn } from '@/lib/utils'

/**
 * Percent change from yesterday to today. Null means there is no usable
 * baseline (yesterday missing or zero), so no delta is shown at all.
 */
function changePercent(
  today: number | null | undefined,
  yesterday: number | null | undefined,
): number | null {
  if (today == null || yesterday == null || yesterday <= 0) return null
  const percent = ((today - yesterday) / yesterday) * 100
  return Math.abs(percent) < 0.05 ? 0 : percent
}

function formatPercent(percent: number): string {
  const absolute = Math.abs(percent)
  return `${absolute >= 10 ? Math.round(absolute) : absolute.toFixed(1)}%`
}

/**
 * Day-over-day delta for a count. Only a drop that is both proportionally and
 * absolutely meaningful is coloured, so ordinary daily noise (and small counts
 * moving by one) stays quiet; a big percentage on a tiny count is not an alarm.
 */
export function ChangeBadge({
  today,
  yesterday,
  className,
}: {
  today: number | null | undefined
  yesterday: number | null | undefined
  className?: string
}) {
  const percent = changePercent(today, yesterday)
  if (percent == null) return null

  const drop = Number(yesterday) - Number(today)
  const severe = percent <= -20 && drop >= 10
  const notable = percent <= -5 && drop >= 3
  const tone = percent === 0 ? 'flat' : severe ? 'bad' : notable ? 'down' : 'flat'

  return (
    <span
      className={cn('cx-delta', className)}
      data-tone={tone}
      title={`今日较昨日 ${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`}
    >
      {percent === 0 ? '持平' : `${percent > 0 ? '↑' : '↓'}${formatPercent(percent)}`}
    </span>
  )
}
