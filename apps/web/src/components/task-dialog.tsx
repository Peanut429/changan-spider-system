import { useEffect, useMemo, useState } from 'react'
import { LoaderCircle, Pencil, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { subDays } from 'date-fns'

import { createTask, updateTask } from '@/lib/api'
import type { Platform, Task } from '@/lib/types'
import { dateFromKey, dateKeyFromDate, timeKeyFromDate, todayKey } from '@/lib/format'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export function TaskDialog({
  open,
  onOpenChange,
  platforms,
  accountTypes,
  defaultDate,
  task,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  platforms: Platform[]
  accountTypes: string[]
  defaultDate: string
  /** null / undefined means create a new task. */
  task?: Task | null
  onSaved: (task: Task) => void
}) {
  const [platformId, setPlatformId] = useState('')
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

  useEffect(() => {
    if (!open) return

    if (task) {
      setPlatformId(task.platformId)
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

    setPlatformId(platforms[0]?.id || '')
    setAccountType(accountTypes.includes('总部') ? '总部' : (accountTypes[0] || ''))
    setScheduledDate(defaultDate || todayKey())
    setScheduledTime('09:00')
    setWindowStart(defaults.start)
    setWindowEnd(defaults.end)
    setLimit('0')
  }, [open, task, platforms, accountTypes, defaultDate, defaults])

  const canSubmit = Boolean(platformId && accountType && scheduledDate && scheduledTime && windowStart && windowEnd && !saving)

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
        platformId,
        accountType: accountType.trim(),
        scheduledAt,
        windowStart,
        windowEnd,
        limit: limitNumber,
      }
      const result = task ? await updateTask(task.id, input) : await createTask(input)
      toast.success(task ? '任务已更新' : '任务已创建，进入待执行')
      onOpenChange(false)
      onSaved(result.task)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : task ? '保存任务失败' : '创建任务失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="cx-portal max-h-[90vh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{task ? '编辑任务' : '创建任务'}</DialogTitle>
          <DialogDescription>
            {task ? '修改未执行任务的参数；保存后仍保持原来的执行状态。' : '设置平台、账号类型和抓取时间。'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label>平台</Label>
            <Select value={platformId} onValueChange={setPlatformId}>
              <SelectTrigger className="w-full"><SelectValue placeholder="选择平台" /></SelectTrigger>
              <SelectContent className="cx-portal">
                {platforms.map((platform) => (
                  <SelectItem key={platform.id} value={platform.id}>{platform.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label>账号类型</Label>
            <Select value={accountType} onValueChange={setAccountType}>
              <SelectTrigger className="w-full"><SelectValue placeholder="选择账号类型" /></SelectTrigger>
              <SelectContent className="cx-portal">
                {accountTypes.map((type) => (
                  <SelectItem key={type} value={type}>{type}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

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
            <p className="text-[11px] text-muted-foreground">0 表示不限制。</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
          <Button onClick={submit} disabled={!canSubmit} className="gap-1.5">
            {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : task ? <Pencil className="size-3.5" /> : <Plus className="size-3.5" />}
            {task ? '保存修改' : '创建任务'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
