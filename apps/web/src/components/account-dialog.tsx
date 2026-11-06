import { useEffect, useMemo, useState } from 'react'
import { LoaderCircle, Plus, Save } from 'lucide-react'
import { toast } from 'sonner'

import { createAccount, updateAccount } from '@/lib/api'
import type { Account, Platform } from '@/lib/types'
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
import { Switch } from '@/components/ui/switch'

type FormState = {
  platformId: string
  handle: string
  displayName: string
  profileUrl: string
  accountType: string
  active: boolean
}

const EMPTY_FORM: FormState = {
  platformId: '',
  handle: '',
  displayName: '',
  profileUrl: '',
  accountType: '总部',
  active: true,
}

export function AccountDialog({
  open,
  onOpenChange,
  account,
  platforms,
  accountTypes,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: Account | null
  platforms: Platform[]
  accountTypes: string[]
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const editing = Boolean(account)

  useEffect(() => {
    if (!open) return
    if (account) {
      setForm({
        platformId: account.platformId,
        handle: account.handle,
        displayName: account.displayName || '',
        profileUrl: account.profileUrl,
        accountType: account.accountType || (accountTypes.includes('总部') ? '总部' : (accountTypes[0] || '')),
        active: account.active,
      })
    } else {
      setForm({ ...EMPTY_FORM, platformId: platforms[0]?.id || '', accountType: accountTypes.includes('总部') ? '总部' : (accountTypes[0] || '') })
    }
  }, [open, account, platforms, accountTypes])

  const canSubmit = useMemo(
    () => Boolean(form.platformId && form.handle.trim() && form.profileUrl.trim() && form.accountType && !saving),
    [form, saving],
  )

  const submit = async () => {
    if (!canSubmit) return
    setSaving(true)
    try {
      const input = {
        platformId: form.platformId,
        handle: form.handle.trim(),
        displayName: form.displayName.trim(),
        profileUrl: form.profileUrl.trim(),
        accountType: form.accountType.trim(),
        active: form.active,
      }
      if (editing && account) {
        await updateAccount(account.id, input)
        toast.success('账号已更新')
      } else {
        await createAccount(input)
        toast.success('账号已添加')
      }
      onOpenChange(false)
      onSaved()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="cx-portal max-h-[90vh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑账号' : '添加账号'}</DialogTitle>
          <DialogDescription>
            {editing ? '修改后不会影响历史数据。' : '填写账号信息。'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="account-platform">平台</Label>
            <Select
              value={form.platformId}
              onValueChange={(value) => setForm((current) => ({ ...current, platformId: value }))}
              disabled={editing}
            >
              <SelectTrigger id="account-platform" className="w-full">
                <SelectValue placeholder="选择平台" />
              </SelectTrigger>
              <SelectContent className="cx-portal">
                {platforms.map((platform) => (
                  <SelectItem key={platform.id} value={platform.id}>{platform.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="account-handle">账号标识</Label>
              <Input
                id="account-handle"
                value={form.handle}
                onChange={(event) => setForm((current) => ({ ...current, handle: event.target.value }))}
                placeholder="例如 BYD España"
              />
            </div>
            <div className="grid gap-2">
              <Label>账号类型</Label>
              <Select
                value={form.accountType || accountTypes[0] || ''}
                onValueChange={(value) => setForm((current) => ({ ...current, accountType: value }))}
              >
                <SelectTrigger className="w-full"><SelectValue placeholder="选择账号类型" /></SelectTrigger>
                <SelectContent className="cx-portal">
                  {accountTypes.map((type) => (
                    <SelectItem key={type} value={type}>{type}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="account-display">显示名称</Label>
            <Input
              id="account-display"
              value={form.displayName}
              onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))}
              placeholder="可选，业务侧展示名"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="account-url">主页 URL</Label>
            <Input
              id="account-url"
              value={form.profileUrl}
              onChange={(event) => setForm((current) => ({ ...current, profileUrl: event.target.value }))}
              placeholder="https://..."
            />
          </div>

          <div className="flex items-center justify-between rounded-xl border border-border/80 bg-muted/20 px-3 py-2.5">
            <div>
              <p className="text-sm font-medium">启用账号</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">停用后不会进入新的抓取任务。</p>
            </div>
            <Switch
              checked={form.active}
              onCheckedChange={(checked) => setForm((current) => ({ ...current, active: checked }))}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
          <Button onClick={submit} disabled={!canSubmit} className="gap-1.5">
            {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : editing ? <Save className="size-3.5" /> : <Plus className="size-3.5" />}
            {editing ? '保存' : '添加账号'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
