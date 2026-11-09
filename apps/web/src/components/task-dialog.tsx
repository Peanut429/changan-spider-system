import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, LoaderCircle, Pencil, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { subDays } from 'date-fns'

import { createTasks, updateTask } from '@/lib/api'
import type { Platform, Task } from '@/lib/types'
import { dateFromKey, dateKeyFromDate, timeKeyFromDate, todayKey } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PlatformMark } from '@/components/platform-mark'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export function TaskDialog({
  open,
  onOpenChange,
  platforms,
  accountTypes,
  platformCounts,
  defaultDate,
  task,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  platforms: Platform[]
  accountTypes: string[]
  /** 账号类型 → 平台 ID → 启用账号数；用于默认选中该类型下有账号的平台 */
  platformCounts: Record<string, Record<string, number>>
  defaultDate: string
  /** null / undefined means create a new task. */
  task?: Task | null
  onSaved: (tasks: Task[]) => void
}) {
  const [platformIds, setPlatformIds] = useState<string[]>([])
  const [accountType, setAccountType] = useState('')
  const [scheduledDate, setScheduledDate] = useState(defaultDate)
  const [scheduledTime, setScheduledTime] = useState('09:00')
  const [windowStart, setWindowStart] = useState('')
  const [windowEnd, setWindowEnd] = useState(defaultDate)
  const [limit, setLimit] = useState('0')
  const [saving, setSaving] = useState(false)

  const defaults = useMemo(() => {
    const end = defaultDate || todayKey()
    const start = dateKeyFromDate(subDays(dateFromKey(end), 14))
    return { start, end }
  }, [defaultDate])

  /**
   * Platforms that have at least one active account for the type. A task for a
   * platform without accounts would fail as soon as the worker claims it, so
   * "all platforms" means all of these, not all six blindly.
   */
  const supportedPlatformIds = useCallback(
    (type: string) => {
      const counts = platformCounts[type] || {}
      return platforms
        .filter((platform) => (counts[platform.id] || 0) > 0)
        .map((platform) => platform.id)
    },
    [platformCounts, platforms],
  )

  useEffect(() => {
    if (!open) return

    if (task) {
      setPlatformIds([task.platformId])
      setAccountType(task.accountType || '')

      const scheduled = task.scheduledAt ? new Date(task.scheduledAt) : null
      if (scheduled && !Number.isNaN(scheduled.getTime())) {
        setScheduledDate(dateKeyFromDate(scheduled))
        setScheduledTime(timeKeyFromDate(scheduled))
      } else {
        setScheduledDate(defaultDate || todayKey())
        setScheduledTime('09:00')
      }

      const since = typeof task.params.since === 'string'
        ? task.params.since
        : task.windowSince
          ? dateKeyFromDate(new Date(task.windowSince))
          : defaults.start
      const until = typeof task.params.until === 'string'
        ? task.params.until
        : task.windowUntil
          ? dateKeyFromDate(new Date(task.windowUntil))
          : defaults.end
      setWindowStart(since)
      setWindowEnd(until)
      setLimit(String(task.params.limit ?? 0))
      return
    }

    const initialType = accountTypes.includes('总部') ? '总部' : (accountTypes[0] || '')
    setAccountType(initialType)
    // Default is the whole account type: every platform that has accounts.
    setPlatformIds(supportedPlatformIds(initialType))
    setScheduledDate(defaultDate || todayKey())
    setScheduledTime('09:00')
    setWindowStart(defaults.start)
    setWindowEnd(defaults.end)
    setLimit('0')
  }, [open, task, accountTypes, defaultDate, defaults, supportedPlatformIds])

  const platformId = platformIds[0] || ''
  const selectedCount = platformIds.length
  const canSubmit = Boolean(
    (task ? platformId : selectedCount > 0)
    && accountType
    && scheduledDate
    && scheduledTime
    && windowStart
    && windowEnd
    && !saving,
  )

  const typeCounts = platformCounts[accountType] || {}
  const platformCount = (id: string) => typeCounts[id] || 0
  const hasCountsForType = Object.keys(typeCounts).length > 0
  // While editing, keep every platform available: the task may predate the
  // current account set, and moving it is a legitimate change.
  const isSelectable = (platform: Platform) => Boolean(task) || platformCount(platform.id) > 0
  const selectablePlatforms = platforms.filter(isSelectable)
  const selectedAccounts = platformIds.reduce((sum, id) => sum + platformCount(id), 0)

  const togglePlatform = (id: string) => {
    setPlatformIds((current) => current.includes(id)
      ? current.filter((value) => value !== id)
      : [...current, id])
  }

  const changeAccountType = (next: string) => {
    setAccountType(next)
    // Creating is account-type first: switching type re-selects every platform
    // that has accounts under it.
    if (!task) setPlatformIds(supportedPlatformIds(next))
  }

  const scheduledAtMs = useMemo(() => {
    if (!scheduledDate || !scheduledTime) return NaN
    const ms = Date.parse(`${scheduledDate}T${scheduledTime}:00+08:00`)
    return Number.isFinite(ms) ? ms : NaN
  }, [scheduledDate, scheduledTime])
  const scheduledInPast = Number.isFinite(scheduledAtMs) && scheduledAtMs <= Date.now()

  const pastWarning = task
    ? task.status === 'paused'
      ? '该时间已过；任务仍保持暂停，继续后会立即执行。'
      : '该时间已过，保存后 worker 会立即执行。'
    : '该时间已过，创建后 worker 会立即执行。'

  const submit = async () => {
    if (!canSubmit) return
    if (windowStart > windowEnd) {
      toast.error('抓取开始日期不能晚于结束日期')
      return
    }
    const limitNumber = Number(limit)
    if (!Number.isInteger(limitNumber) || limitNumber < 0) {
      toast.error('内容上限必须是非负整数')
      return
    }
    setSaving(true)
    try {
      const scheduledAt = new Date(`${scheduledDate}T${scheduledTime}:00+08:00`).toISOString()
      const input = {
        accountType: accountType.trim(),
        scheduledAt,
        windowStart,
        windowEnd,
        limit: limitNumber,
      }
      if (task) {
        const result = await updateTask(task.id, { ...input, platformId })
        toast.success('任务已更新')
        onOpenChange(false)
        onSaved([result.task])
        return
      }
      const result = await createTasks({ ...input, platformIds })
      toast.success(
        result.tasks.length > 1
          ? `已创建 ${result.tasks.length} 个任务，覆盖 ${result.tasks.length} 个平台，进入待执行`
          : '任务已创建，进入待执行',
      )
      onOpenChange(false)
      onSaved(result.tasks)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : task ? '保存任务失败' : '创建任务失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="cx-portal max-h-[90vh] overflow-y-auto sm:max-w-[580px]">
        <DialogHeader>
          <DialogTitle>{task ? '编辑任务' : '创建任务'}</DialogTitle>
          <DialogDescription>
            {task
              ? '修改未执行任务的参数；保存后仍保持原来的执行状态。'
              : '先选账号类型，再按平台批量创建；默认覆盖该类型下有账号的全部平台。'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label>账号类型</Label>
            <Select value={accountType} onValueChange={changeAccountType}>
              <SelectTrigger className="w-full"><SelectValue placeholder="选择账号类型" /></SelectTrigger>
              <SelectContent className="cx-portal">
                {accountTypes.map((type) => (
                  <SelectItem key={type} value={type}>{type}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {task ? (
            <div className="grid gap-2">
              <Label>平台</Label>
              <Select value={platformId} onValueChange={(value) => setPlatformIds([value])}>
                <SelectTrigger className="w-full"><SelectValue placeholder="选择平台" /></SelectTrigger>
                <SelectContent className="cx-portal">
                  {platforms.map((platform) => (
                    <SelectItem key={platform.id} value={platform.id}>{platform.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">一个任务只对应一个平台；其他平台请分别创建。</p>
            </div>
          ) : (
            <div className="grid gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <Label>平台</Label>
                <div className="flex items-center gap-2 text-[11px]">
                  <button
                    type="button"
                    className="text-primary transition-opacity hover:opacity-70"
                    disabled={selectablePlatforms.every((platform) => platformIds.includes(platform.id))}
                    onClick={() => setPlatformIds(selectablePlatforms.map((platform) => platform.id))}
                  >
                    全选
                  </button>
                  <span className="text-border">|</span>
                  <button
                    type="button"
                    className="text-muted-foreground transition-colors hover:text-foreground"
                    disabled={selectedCount === 0}
                    onClick={() => setPlatformIds([])}
                  >
                    清空
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3" role="group" aria-label="平台">
                {platforms.map((platform) => {
                  const count = platformCount(platform.id)
                  const selectable = isSelectable(platform)
                  const checked = platformIds.includes(platform.id)
                  return (
                    <button
                      key={platform.id}
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      aria-label={`${platform.name}${selectable ? `，${count} 个账号` : '，无账号'}`}
                      disabled={!selectable}
                      title={selectable ? `${count} 个账号` : '该账号类型下暂无账号'}
                      onClick={() => togglePlatform(platform.id)}
                      className={cn(
                        'flex items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors outline-none',
                        'focus-visible:ring-[3px] focus-visible:ring-ring/50',
                        selectable ? 'cursor-pointer' : 'cursor-not-allowed opacity-45',
                        checked
                          ? 'border-primary/45 bg-primary/[0.07]'
                          : 'border-border hover:border-muted-foreground/35',
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
                          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-transparent',
                        )}
                      >
                        {checked ? <Check className="size-3.5" /> : null}
                      </span>
                      <PlatformMark code={platform.code} name={platform.name} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{platform.name}</span>
                      <span className={cn(
                        'shrink-0 text-[11px] tabular-nums',
                        checked ? 'text-primary' : 'text-muted-foreground',
                      )}>
                        {selectable ? count : '0'}
                      </span>
                    </button>
                  )
                })}
              </div>
              <p className={cn('text-[11px]', selectedCount > 0 ? 'text-muted-foreground' : 'text-amber-600')}>
                {selectedCount > 0
                  ? `已选 ${selectedCount} 个平台 · ${selectedAccounts} 个账号；提交后每个平台生成一个任务。`
                  : hasCountsForType
                    ? '至少选择一个平台。'
                    : '该账号类型下没有启用中的账号，无法创建任务；请先在账号管理里添加或启用账号。'}
              </p>
              {hasCountsForType ? (
                <p className="text-[11px] text-muted-foreground">数字为该类型下的账号数；为 0 的平台不会创建任务。</p>
              ) : null}
            </div>
          )}

          <div className="grid gap-2">
            <Label>计划执行时间</Label>
            <div className="grid grid-cols-[1fr_120px] gap-2">
              <Input type="date" value={scheduledDate} onChange={(event) => setScheduledDate(event.target.value)} />
              <Input type="time" value={scheduledTime} onChange={(event) => setScheduledTime(event.target.value)} />
            </div>
            {task?.status === 'paused' ? (
              <p className="text-[11px] text-muted-foreground">任务当前已暂停，保存后仍保持暂停，不会自动执行。</p>
            ) : null}
            {scheduledInPast ? <p className="text-[11px] text-amber-600">{pastWarning}</p> : null}
          </div>

          <div className="grid gap-2">
            <Label>抓取时间范围</Label>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <Input type="date" value={windowStart} onChange={(event) => setWindowStart(event.target.value)} />
              <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">至</span>
              <Input type="date" value={windowEnd} onChange={(event) => setWindowEnd(event.target.value)} />
            </div>
            <p className="text-[11px] text-muted-foreground">按北京时间（UTC+8）计算：开始日 00:00:00，结束日 23:59:59。</p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="task-limit">内容上限</Label>
            <Input
              id="task-limit"
              type="number"
              min={0}
              step={1}
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">0 表示不限制{selectedCount > 1 ? '，每个任务各自计算' : ''}。</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
          <Button onClick={submit} disabled={!canSubmit} className="gap-1.5">
            {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : task ? <Pencil className="size-3.5" /> : <Plus className="size-3.5" />}
            {task ? '保存修改' : selectedCount > 1 ? `创建 ${selectedCount} 个任务` : '创建任务'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
