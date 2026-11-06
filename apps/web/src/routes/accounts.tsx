import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import {
  ChevronLeft,
  ChevronRight,
  CirclePlus,
  FileSpreadsheet,
  FilterX,
  Pencil,
  Search,
  ShieldCheck,
  ShieldOff,
  UsersRound,
} from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { getAccountTypes, getAccounts, getPlatforms, updateAccountActive } from '@/lib/api'
import type { Account } from '@/lib/types'
import { formatDateTime } from '@/lib/format'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import ClickSpark from '@/components/ClickSpark/ClickSpark'
import { PlatformBadge } from '@/components/platform-badge'
import { AccountDialog } from '@/components/account-dialog'
import { ExcelImportPreview } from '@/components/excel-import-preview'
import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

export const Route = createFileRoute('/accounts')({
  component: AccountsPage,
})

function AccountsPage() {
  const reduceMotion = useReducedMotion()
  const queryClient = useQueryClient()
  const [platformId, setPlatformId] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [active, setActive] = useState('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [search, setSearch] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [editing, setEditing] = useState<Account | null>(null)
  const [switchingId, setSwitchingId] = useState<string | null>(null)

  const platformsQuery = useQuery({ queryKey: ['platforms'], queryFn: getPlatforms })
  const accountTypesQuery = useQuery({ queryKey: ['account-types'], queryFn: getAccountTypes })
  const accountsQuery = useQuery({
    queryKey: ['accounts', platformId, typeFilter, active, search, page, pageSize],
    placeholderData: keepPreviousData,
    queryFn: () => getAccounts({
      platformId: platformId === 'all' ? undefined : platformId,
      accountType: typeFilter === 'all' ? undefined : typeFilter,
      active: active === 'all' ? undefined : active,
      q: search.trim() || undefined,
      page,
      pageSize,
    }),
  })

  const accounts = accountsQuery.data?.accounts ?? []
  const platforms = platformsQuery.data?.platforms ?? []
  const accountTypes = accountTypesQuery.data?.accountTypes ?? []
  const total = accountsQuery.data?.total ?? 0
  const activeCount = accountsQuery.data?.activeCount ?? 0
  const inactiveCount = accountsQuery.data?.inactiveCount ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const hasFilters = platformId !== 'all' || typeFilter !== 'all' || active !== 'all' || search.trim().length > 0

  useEffect(() => {
    setPage(1)
  }, [platformId, typeFilter, active, search])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const resetFilters = () => {
    setPlatformId('all')
    setTypeFilter('all')
    setActive('all')
    setSearch('')
  }

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['accounts'] })
    void queryClient.invalidateQueries({ queryKey: ['account-types'] })
  }

  const toggleActive = async (account: Account, next: boolean) => {
    setSwitchingId(account.id)
    try {
      await updateAccountActive(account.id, next)
      toast.success(next ? '账号已启用' : '账号已停用')
      refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败')
    } finally {
      setSwitchingId(null)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="账号管理"
        description="管理各平台账号和账号类型。"
        actions={
          <>
            <Button variant="outline" className="gap-1.5 bg-card" onClick={() => setPreviewOpen(true)}>
              <FileSpreadsheet className="size-4" />
              Excel 导入预览
            </Button>
            <ClickSpark
              sparkColor={['#34d399', '#6ee7b7', '#a7f3d0']}
              sparkSize={7}
              sparkRadius={30}
              sparkCount={12}
              duration={520}
              easing="ease-out"
              shape="line"
              glow={0.7}
              className="inline-flex"
              style={{ width: 'auto', height: 'auto' }}
            >
              <Button
                className="gap-1.5"
                onClick={() => {
                  setEditing(null)
                  setDialogOpen(true)
                }}
                disabled={!platforms.length || !accountTypes.length}
              >
                <CirclePlus className="size-4" />
                添加账号
              </Button>
            </ClickSpark>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="当前结果" value={accounts.length} icon={UsersRound} />
        <StatCard label="启用" value={activeCount} icon={ShieldCheck} tone="success" delay={0.04} />
        <StatCard label="停用" value={inactiveCount} icon={ShieldOff} tone="muted" delay={0.08} />
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索账号或显示名称"
                className="h-9 pl-9"
              />
            </div>
            <div className="grid grid-cols-3 gap-2 lg:flex">
              <Select value={platformId} onValueChange={setPlatformId}>
                <SelectTrigger className="h-9 w-full lg:w-[132px]"><SelectValue placeholder="平台" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部平台</SelectItem>
                  {platforms.map((platform) => (
                    <SelectItem key={platform.id} value={platform.id}>{platform.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="h-9 w-full lg:w-[132px]"><SelectValue placeholder="类型" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部类型</SelectItem>
                  {accountTypes.map((type) => (
                    <SelectItem key={type} value={type}>{type}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={active} onValueChange={setActive}>
                <SelectTrigger className="h-9 w-full lg:w-[108px]"><SelectValue placeholder="状态" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  <SelectItem value="true">启用</SelectItem>
                  <SelectItem value="false">停用</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {hasFilters ? (
              <Button variant="ghost" size="sm" className="gap-1.5 lg:shrink-0" onClick={resetFilters}>
                <FilterX className="size-3.5" />清除
              </Button>
            ) : null}
          </div>

          {accountsQuery.isPending ? (
            <div className="space-y-2"><Skeleton className="h-12 rounded-lg" /><Skeleton className="h-12 rounded-lg" /><Skeleton className="h-12 rounded-lg" /></div>
          ) : accountsQuery.isError ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50/60 px-4 py-6 text-sm text-rose-800">
              账号加载失败：{accountsQuery.error.message}
              <Button variant="outline" size="sm" className="ml-3" onClick={() => accountsQuery.refetch()}>重试</Button>
            </div>
          ) : accounts.length ? (
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.28 }}
              className="overflow-x-auto rounded-2xl border border-border/70 shadow-[0_24px_60px_-52px_rgba(6,78,59,0.55)]"
            >
              <Table className="min-w-[820px]">
                <TableHeader>
                  <TableRow className="bg-emerald-50/60 hover:bg-emerald-50/60">
                    <TableHead className="min-w-[220px]">账号</TableHead>
                    <TableHead>平台</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead className="w-[90px]">状态</TableHead>
                    <TableHead className="w-[130px]">更新时间</TableHead>
                    <TableHead className="w-[90px] text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accounts.map((account) => (
                    <TableRow key={account.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">{account.handle}</span>
                          <span className="mt-0.5 max-w-[260px] truncate text-[11px] text-muted-foreground">{account.displayName || account.profileUrl}</span>
                        </div>
                      </TableCell>
                      <TableCell><PlatformBadge code={account.platformCode} /></TableCell>
                      <TableCell><span className="text-sm">{account.accountType || '—'}</span></TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={account.active}
                            disabled={switchingId === account.id}
                            onCheckedChange={(checked) => void toggleActive(account, checked)}
                          />
                          <span className={account.active ? 'text-xs text-emerald-700' : 'text-xs text-muted-foreground'}>
                            {account.active ? '启用' : '停用'}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-muted-foreground">{formatDateTime(account.updatedAt)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1"
                          onClick={() => {
                            setEditing(account)
                            setDialogOpen(true)
                          }}
                        >
                          <Pencil className="size-3.5" />编辑
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </motion.div>
          ) : (
            <EmptyState
              icon={UsersRound}
              title={hasFilters ? '没有匹配的账号' : '还没有账号'}
              description={hasFilters ? '调整筛选条件，或清除筛选查看全部账号。' : '添加第一个平台账号，之后任务会按账号类型选择账号。'}
            />
          )}

          {total > 0 ? (
            <div className="flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-xs text-muted-foreground">
                共 {total} 个账号，第 {page} / {totalPages} 页
              </span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">每页</span>
                <Select
                  value={String(pageSize)}
                  onValueChange={(value) => { setPageSize(Number(value)); setPage(1) }}
                >
                  <SelectTrigger className="h-8 w-[78px] text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="20">20</SelectItem>
                    <SelectItem value="50">50</SelectItem>
                    <SelectItem value="100">100</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  aria-label="上一页"
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <span className="min-w-[64px] text-center text-xs tabular-nums text-muted-foreground">{page} / {totalPages}</span>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  disabled={page >= totalPages}
                  onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                  aria-label="下一页"
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <ExcelImportPreview open={previewOpen} onOpenChange={setPreviewOpen} accountTypes={accountTypes} onImported={refresh} />

      <AccountDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        account={editing}
        platforms={platforms}
        accountTypes={accountTypes}
        onSaved={refresh}
      />
    </div>
  )
}
