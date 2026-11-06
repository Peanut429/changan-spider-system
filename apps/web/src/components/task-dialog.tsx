import { useEffect, useMemo, useState } from 'react'
import { LoaderCircle, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { subDays } from 'date-fns'

import { createTask } from '@/lib/api'
import type { Platform, Task } from '@/lib/types'
import { dateFromKey, dateKeyFromDate, todayKey } from '@/lib/format'
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
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  platforms: Platform[]
  accountTypes: string[]
  defaultDate: string
  onCreated: (task: Task) => void
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
    setPlatformId(platforms[0]?.id || '')
    setAccountType(accountTypes.includes('总部') ? '总部' : (accountTypes[0] || ''))
    setScheduledDate(defaultDate || todayKey())
    setScheduledTime('09:00')
    setWindowStart(defaults.start)
    setWindowEnd(defaults.end)
    setLimit('0')
  }, [open, platforms, accountTypes, defaultDate, defaults])

  const canSubmit = Boolean(platformId && accountType && scheduledDate && scheduledTime && windowStart && windowEnd && !saving)

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
      const result = await createTask({
        platformId,
        accountType: accountType.trim(),
        scheduledAt,
        windowStart,
        windowEnd,
        limit: limitNumber,
      })
      toast.success('任务已创建，进入待执行')
      onOpenChange(false)
      onCreated(result.task)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建任务失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="cx-portal max-h-[90vh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>创建任务</DialogTitle>
          <DialogDescription>设置平台、账号类型和抓取时间。</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label>平台</Label>
            <Select value={platformId} onValueChange={setPlatformId}>
              <SelectTrigger className="w-full"><SelectValue placeholder="选择平台" /></SelectTrigger>
              <SelectContent>
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
              <SelectContent>
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
          </div>

          <div className="grid gap-2">
            <Label>抓取时间范围</Label>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <Input type="date" value={windowStart} onChange={(event) => setWindowStart(event.target.value)} />
              <span className="text-xs text-muted-foreground">至</span>
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
            {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            创建任务
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
