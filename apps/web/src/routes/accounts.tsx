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
  UsersRound,
} from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { getAccountTypes, getAccounts, getPlatforms, updateAccountActive } from '@/lib/api'
import type { Account } from '@/lib/types'
import { formatDateTime, formatNumber } from '@/lib/format'
import { ConsoleBar } from '@/components/console/console-bar'
import { ConsolePage } from '@/components/console/console-page'
import { platformColor } from '@/components/console/platform-color'
import { AccountDialog } from '@/components/account-dialog'
import { ExcelImportPreview } from '@/components/excel-import-preview'
import StarBorder from '@/components/StarBorder/StarBorder'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import SquishSwitch from '@/components/SquishSwitch/SquishSwitch'
import '@/components/console/console.css'

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
    <ConsolePage>
      <ConsoleBar title="账号管理" description="管理各平台账号和账号类型。">
        <Button variant="outline" className="gap-1.5" onClick={() => setPreviewOpen(true)}>
          <FileSpreadsheet className="size-4" />
          Excel 导入预览
        </Button>
        <StarBorder
          as="button"
          className="cx-cta h-9 px-4 text-[13.5px]"
          radius={6}
          thickness={1}
          color="#ffffff"
          trailColor="#d7fff0"
          backgroundColor="var(--primary)"
          textColor="var(--primary-foreground)"
          borderColor="color-mix(in oklab, var(--primary) 70%, transparent)"
          duration={4}
          stars={1}
          trailLength={0.3}
          glow={0.6}
          hover="lap"
          disabled={!platforms.length || !accountTypes.length}
          onClick={() => {
            setEditing(null)
            setDialogOpen(true)
          }}
        >
          <CirclePlus className="size-4" />
          添加账号
        </StarBorder>
      </ConsoleBar>

      <section className="cx-toolbar">
        <div className="cx-search">
          <Search className="size-3.5" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索账号或显示名称"
          />
        </div>
        <div className="cx-filters">
          <Select value={platformId} onValueChange={setPlatformId}>
            <SelectTrigger className="h-9 w-full"><SelectValue placeholder="平台" /></SelectTrigger>
            <SelectContent className="cx-portal">
              <SelectItem value="all">全部平台</SelectItem>
              {platforms.map((platform) => (
                <SelectItem key={platform.id} value={platform.id}>{platform.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="h-9 w-full"><SelectValue placeholder="类型" /></SelectTrigger>
            <SelectContent className="cx-portal">
              <SelectItem value="all">全部类型</SelectItem>
              {accountTypes.map((type) => (
                <SelectItem key={type} value={type}>{type}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={active} onValueChange={setActive}>
            <SelectTrigger className="h-9 w-full"><SelectValue placeholder="状态" /></SelectTrigger>
            <SelectContent className="cx-portal">
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="true">启用</SelectItem>
              <SelectItem value="false">停用</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {hasFilters ? (
          <Button variant="ghost" size="sm" className="cx-clear gap-1.5" onClick={resetFilters}>
            <FilterX className="size-3.5" />清除
          </Button>
        ) : null}
      </section>

      <section className="cx-section">
        <div className="cx-section-head">
          <h2 className="cx-h2">账号</h2>
          <span className="cx-count">{formatNumber(total)} 个</span>
          <span className="cx-count">· 启用 {formatNumber(activeCount)}</span>
          <span className="cx-count">· 停用 {formatNumber(inactiveCount)}</span>
          {accounts.length !== total ? (
            <span className="cx-count">· 本页 {accounts.length}</span>
          ) : null}
        </div>

        <motion.div
          className="cx-surface"
          initial={reduceMotion ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28 }}
        >
          {accountsQuery.isPending ? (
            <div className="cx-loading">
              <div className="cx-skel" style={{ height: 56 }} />
              <div className="cx-skel" style={{ height: 56 }} />
              <div className="cx-skel" style={{ height: 56 }} />
            </div>
          ) : accountsQuery.isError ? (
            <div className="cx-error" style={{ margin: 16 }}>
              <p>账号加载失败：{accountsQuery.error.message}</p>
              <Button variant="outline" size="sm" onClick={() => accountsQuery.refetch()}>重试</Button>
            </div>
          ) : accounts.length ? (
            <table className="cx-table cx-table--dense">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>平台</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th data-hide-mobile="true">更新时间</th>
                  <th className="cx-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={account.id}>
                    <td data-block="true">
                      <div className="cx-handle">{account.handle}</div>
                      <div className="cx-cell-sub">{account.displayName || account.profileUrl}</div>
                    </td>
                    <td data-label="平台">
                      <span className="cx-plat">
                        <i style={{ color: platformColor(account.platformCode) }} aria-hidden="true" />
                        <span>{account.platformName}</span>
                      </span>
                    </td>
                    <td data-label="类型">{account.accountType || '—'}</td>
                    <td data-label="状态">
                      <span className="cx-switch">
                        <SquishSwitch
                          checked={account.active}
                          disabled={switchingId === account.id}
                          onChange={(checked) => void toggleActive(account, checked)}
                          width={34}
                          height={20}
                          trackColor="color-mix(in oklab, var(--cx-ink) 16%, transparent)"
                          trackOnColor="color-mix(in oklab, var(--cx-accent) 78%, transparent)"
                          thumbColor="var(--cx-ink)"
                          thumbOnColor="#04211a"
                          ariaLabel={`${account.handle} 启用状态`}
                        />
                        <span data-on={account.active ? 'true' : undefined}>
                          {account.active ? '启用' : '停用'}
                        </span>
                      </span>
                    </td>
                    <td data-label="更新时间" data-hide-mobile="true">
                      <span className="cx-when">{formatDateTime(account.updatedAt)}</span>
                    </td>
                    <td data-label="操作" className="cx-right">
                      <div className="cx-row-actions">
                        <button
                          type="button"
                          className="cx-link"
                          onClick={() => {
                            setEditing(account)
                            setDialogOpen(true)
                          }}
                        >
                          <Pencil className="size-3.5" />编辑
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="cx-empty">
              <span className="cx-empty-icon">
                <UsersRound className="size-4" strokeWidth={1.7} />
              </span>
              <div className="cx-empty-body">
                <p className="cx-empty-title">{hasFilters ? '没有匹配的账号' : '还没有账号'}</p>
                <p className="cx-empty-hint">
                  {hasFilters ? '调整筛选条件，或清除筛选查看全部账号。' : '添加第一个平台账号，之后任务会按账号类型选择账号。'}
                </p>
              </div>
            </div>
          )}
        </motion.div>

        {total > 0 ? (
          <div className="cx-pager">
            <span className="cx-pager-meta">
              共 {formatNumber(total)} 个账号 · 第 {page} / {totalPages} 页
            </span>
            <div className="cx-pager-controls">
              <span className="cx-pager-meta">每页</span>
              <Select
                value={String(pageSize)}
                onValueChange={(value) => { setPageSize(Number(value)); setPage(1) }}
              >
                <SelectTrigger className="h-8 w-[74px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent className="cx-portal">
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
              <span className="cx-pager-current">{page} / {totalPages}</span>
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
      </section>

      <ExcelImportPreview open={previewOpen} onOpenChange={setPreviewOpen} accountTypes={accountTypes} onImported={refresh} />

      <AccountDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        account={editing}
        platforms={platforms}
        accountTypes={accountTypes}
        onSaved={refresh}
      />
    </ConsolePage>
  )
}
