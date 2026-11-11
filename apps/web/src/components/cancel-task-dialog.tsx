import { LoaderCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

export type CancelTaskTarget = {
  id: string
  accountCount: number
  title?: string
  description?: string
}

/**
 * Shared confirmation for the rerun queue. The dialog stays open while the
 * request is in flight so a failure is reported next to the action instead of
 * leaving the operator wondering whether the click landed.
 */
export function CancelTaskDialog({
  target,
  busy,
  onClose,
  onConfirm,
}: {
  target: CancelTaskTarget | null
  busy: boolean
  onClose: () => void
  onConfirm: (id: string) => void
}) {
  return (
    <AlertDialog
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <AlertDialogContent className="cx-portal">
        <AlertDialogHeader>
          <AlertDialogTitle>{target?.title || '取消这个补跑任务？'}</AlertDialogTitle>
          <AlertDialogDescription>
            {target?.description
              || `将取消 ${target?.accountCount ?? 0} 个账号的补跑。这些账号不会重新执行，已经抓到的数据不受影响。`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={onClose}>返回</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => {
              if (target) onConfirm(target.id)
            }}
          >
            {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
            {busy ? '取消中…' : '取消补跑'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
