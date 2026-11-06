import { useEffect, useMemo, useRef, useState } from 'react'
import { CircleAlert, FileSpreadsheet, LoaderCircle, Upload, UploadCloud, X } from 'lucide-react'

import { toast } from 'sonner'

import { importAccounts } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

type FieldKey = 'platform' | 'profileUrl'
type Mapping = Record<FieldKey, string>
type Matrix = string[][]

type FieldDef = {
  key: FieldKey
  label: string
  required?: boolean
  synonyms: string[]
}

const FIELDS: FieldDef[] = [
  { key: 'platform', label: '平台', required: true, synonyms: ['platform', '平台', '渠道', '媒体', 'site', '网站'] },
  { key: 'profileUrl', label: '账号链接', required: true, synonyms: ['profileurl', 'url', 'link', '主页', '链接', '地址', 'profile', '主页链接', '账号链接'] },
]

const NONE = '__none__'

function norm(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-（）()【】[\]:：/\\]/g, '')
}

function cell(row: string[] | undefined, index: string): string {
  if (index === NONE || index === '') return ''
  const i = Number(index)
  return row && Number.isInteger(i) ? String(row[i] ?? '').trim() : ''
}

function guessHeaderRow(matrix: Matrix): number {
  const limit = Math.min(matrix.length, 12)
  let best = 0
  let bestScore = -1
  for (let i = 0; i < limit; i++) {
    const values = matrix[i] || []
    let score = 0
    for (const field of FIELDS) {
      if (values.some((value) => field.synonyms.some((syn) => {
        const n = norm(value)
        return n.length > 1 && (n.includes(norm(syn)) || norm(syn).includes(n))
      }))) score += 1
    }
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  }
  return bestScore >= 1 ? best : 0
}

function guessMapping(headers: string[]): Mapping {
  const mapping: Mapping = {
    platform: NONE,
    profileUrl: NONE,
  }
  const used = new Set<number>()
  for (const field of FIELDS) {
    let bestIndex = -1
    let bestScore = 0
    headers.forEach((header, index) => {
      if (used.has(index)) return
      const n = norm(header)
      if (!n) return
      for (const synonym of field.synonyms) {
        const s = norm(synonym)
        if (!s) continue
        let score = 0
        if (n === s) score = 3
        else if (n.includes(s) || s.includes(n)) score = Math.min(n.length, s.length) >= 2 ? 2 : 0
        if (score > bestScore) {
          bestScore = score
          bestIndex = index
        }
      }
    })
    if (bestIndex >= 0 && bestScore > 0) {
      mapping[field.key] = String(bestIndex)
      used.add(bestIndex)
    }
  }
  return mapping
}

function platformCode(value: string): string {
  const raw = value.trim().toLowerCase()
  const map: Record<string, string> = {
    youtube: 'youtube', yt: 'youtube', '油管': 'youtube',
    x: 'x', twitter: 'x',
    instagram: 'instagram', ig: 'instagram', ins: 'instagram',
    facebook: 'facebook', fb: 'facebook',
    tiktok: 'tiktok', tt: 'tiktok', '抖音': 'tiktok',
    linkedin: 'linkedin', li: 'linkedin', '领英': 'linkedin',
    '推特': 'x', '脸书': 'facebook', '照片墙': 'instagram',
  }
  return map[raw] || ''
}

function platformFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase()
    if (host.includes('youtube.com') || host.includes('youtu.be')) return 'youtube'
    if (host === 'x.com' || host.includes('twitter.com')) return 'x'
    if (host.includes('instagram.com')) return 'instagram'
    if (host.includes('facebook.com')) return 'facebook'
    if (host.includes('tiktok.com')) return 'tiktok'
    if (host.includes('linkedin.com')) return 'linkedin'
  } catch {
    return ''
  }
  return ''
}

function platformLabel(value: string): string {
  const raw = value.trim().toLowerCase()
  const map: Record<string, string> = {
    youtube: 'YouTube', yt: 'YouTube', '油管': 'YouTube',
    x: 'X', twitter: 'X',
    instagram: 'Instagram', ig: 'Instagram', ins: 'Instagram',
    facebook: 'Facebook', fb: 'Facebook',
    tiktok: 'TikTok', tt: 'TikTok', '抖音': 'TikTok',
    linkedin: 'LinkedIn', li: 'LinkedIn',
  }
  return map[raw] || value.trim()
}

function handleFromUrl(url: string, platform: string): string {
  try {
    const parsed = new URL(url)
    const parts = parsed.pathname.split('/').filter(Boolean).map((part) => {
      try { return decodeURIComponent(part) } catch { return part }
    })
    if (!parts.length) return ''
    if (platform === 'youtube') {
      if (parts[0].startsWith('@')) return parts[0]
      if (parts[0] === 'channel' || parts[0] === 'c') return parts[1] ? `@${parts[1]}` : ''
      return parts[0]
    }
    if (platform === 'tiktok') {
      return parts.find((part) => part.startsWith('@')) || parts[0] || ''
    }
    if (platform === 'linkedin') {
      if (parts[0] === 'company' && parts[1]) return parts[1]
      if (parts[0] === 'in' && parts[1]) return parts[1]
      return parts[0] || ''
    }
    if (platform === 'facebook') {
      if (parts[0] === 'profile.php') return parsed.searchParams.get('id') || 'profile.php'
      if (parts[0] === 'p' && parts[1]) return parts[1]
      if (parts[0] === 'people' && parts[2]) return parts[2]
    }
    if (parts[0] === 'p' || parts[0] === 'reel' || parts[0] === 'reels' || parts[0] === 'stories') {
      return ''
    }
    return parts[0]
  } catch {
    return ''
  }
}

type LinkStatus = 'ok' | 'warning' | 'invalid'

const PLATFORM_HOSTS: Record<string, string[]> = {
  youtube: ['youtube.com', 'www.youtube.com'],
  instagram: ['instagram.com', 'www.instagram.com'],
  x: ['x.com', 'www.x.com'],
  facebook: ['facebook.com', 'www.facebook.com'],
  tiktok: ['tiktok.com', 'www.tiktok.com'],
  linkedin: ['linkedin.com', 'www.linkedin.com'],
}

const PLATFORM_LABEL: Record<string, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  x: 'X',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  linkedin: 'LinkedIn',
}

function isReservedPath(platform: string, path: string): boolean {
  const first = path.split('/').filter(Boolean)[0]?.toLowerCase() || ''
  const reserved: Record<string, string[]> = {
    instagram: ['p', 'reel', 'reels', 'stories', 'explore', 'share', 'accounts', 'direct'],
    x: ['i', 'home', 'search', 'intent', 'share', 'hashtag', 'login'],
    facebook: ['share', 'reel', 'reels', 'watch', 'groups', 'events', 'login', 'marketplace', 'photo'],
    linkedin: ['feed', 'posts', 'share', 'login', 'jobs'],
  }
  return (reserved[platform] || []).includes(first)
}

function pathMatches(platform: string, url: URL): boolean {
  const path = url.pathname.replace(/\/+$/, '') || '/'
  if (platform === 'youtube') {
    return /^\/@[^/]+$/.test(path) || /^\/(channel|c|user)\/[^/]+$/.test(path)
  }
  if (platform === 'instagram') {
    return /^\/[^/]+$/.test(path) && !isReservedPath(platform, path)
  }
  if (platform === 'x') {
    return /^\/[A-Za-z0-9_]{1,15}$/.test(path) && !isReservedPath(platform, path)
  }
  if (platform === 'facebook') {
    if (path === '/profile.php') return Boolean(url.searchParams.get('id'))
    if (/^\/p\/[^/]+$/.test(path)) return true
    if (/^\/people\/[^/]+\/[^/]+$/.test(path)) return true
    return /^\/[^/]+$/.test(path) && !isReservedPath(platform, path)
  }
  if (platform === 'tiktok') {
    return /^\/@[^/]+$/.test(path)
  }
  if (platform === 'linkedin') {
    return /^\/company\/[^/]+(?:\/posts)?$/.test(path) || /^\/in\/[^/]+$/.test(path)
  }
  return false
}

function validateLink(raw: string, platform: string): {
  url: string
  platform: string
  status: LinkStatus
  message: string
} {
  const value = raw.trim()
  if (!value) return { url: '', platform, status: 'invalid', message: '缺少账号链接' }
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`
  let parsed: URL
  try {
    parsed = new URL(withProtocol)
  } catch {
    return { url: value, platform, status: 'invalid', message: '链接格式无效' }
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { url: value, platform, status: 'invalid', message: '链接必须是 http/https' }
  }

  parsed.hash = ''
  const urlPlatform = platformFromUrl(parsed.toString())
  const resolvedPlatform = platform || urlPlatform
  if (!resolvedPlatform) {
    return { url: parsed.toString(), platform: '', status: 'invalid', message: '无法从链接识别平台' }
  }
  if (platform && urlPlatform && platform !== urlPlatform) {
    return {
      url: parsed.toString(),
      platform,
      status: 'invalid',
      message: `链接域名属于 ${PLATFORM_LABEL[urlPlatform] || urlPlatform}，与平台不一致`,
    }
  }

  const host = parsed.hostname.toLowerCase()
  if (resolvedPlatform === 'linkedin') {
    const linkedinHost = host === 'linkedin.com' || host === 'www.linkedin.com' || /^[a-z]{2}\.linkedin\.com$/i.test(host)
    if (!linkedinHost) {
      return {
        url: parsed.toString(),
        platform: resolvedPlatform,
        status: 'invalid',
        message: '不是 LinkedIn 的标准域名',
      }
    }
    // 地区域名统一成 www，避免同一账号出现多种主机名。
    if (host !== 'www.linkedin.com') parsed.hostname = 'www.linkedin.com'
  } else if (!(PLATFORM_HOSTS[resolvedPlatform] || []).includes(host)) {
    return {
      url: parsed.toString(),
      platform: resolvedPlatform,
      status: 'invalid',
      message: `不是 ${PLATFORM_LABEL[resolvedPlatform] || resolvedPlatform} 的标准域名`,
    }
  }

  let cleaned = false
  if (resolvedPlatform === 'facebook' && parsed.pathname === '/profile.php') {
    const id = parsed.searchParams.get('id')
    for (const key of [...parsed.searchParams.keys()]) {
      if (key !== 'id') { parsed.searchParams.delete(key); cleaned = true }
    }
    if (!id) {
      return { url: parsed.toString(), platform: resolvedPlatform, status: 'invalid', message: 'Facebook 主页缺少 id' }
    }
  } else {
    for (const key of [...parsed.searchParams.keys()]) {
      parsed.searchParams.delete(key)
      cleaned = true
    }
  }

  // LinkedIn 的 /about、/home、/posts 等只是主页下的 tab，统一回主页。
  if (resolvedPlatform === 'linkedin') {
    const company = parsed.pathname.match(/^\/company\/([^/]+)(?:\/.*)?$/)
    const person = parsed.pathname.match(/^\/in\/([^/]+)(?:\/.*)?$/)
    if (company) parsed.pathname = `/company/${company[1]}/`
    else if (person) parsed.pathname = `/in/${person[1]}/`
  }

  if (!pathMatches(resolvedPlatform, parsed)) {
    return {
      url: parsed.toString(),
      platform: resolvedPlatform,
      status: 'invalid',
      message: '不是标准账号主页链接（可能是分享链接、帖子链接或短链）',
    }
  }

  const handle = handleFromUrl(parsed.toString(), resolvedPlatform)
  if (!handle) {
    return { url: parsed.toString(), platform: resolvedPlatform, status: 'invalid', message: '无法从链接提取账号标识' }
  }

  return {
    url: parsed.toString(),
    platform: resolvedPlatform,
    status: cleaned ? 'warning' : 'ok',
    message: cleaned ? '已清理链接中的跟踪参数' : '',
  }
}

function normalizeRow(row: string[], mapping: Mapping) {
  const issues: string[] = []
  const rawPlatform = platformCode(cell(row, mapping.platform))
  const link = validateLink(cell(row, mapping.profileUrl), rawPlatform)
  const platform = rawPlatform || link.platform
  const handle = link.url ? handleFromUrl(link.url, platform) : ''

  if (!platform) issues.push('缺少平台')
  if (link.status === 'invalid') issues.push(link.message)
  if (!handle) issues.push('无法从链接提取账号标识')

  return {
    platform,
    platformText: platform ? platformLabel(platform) : '',
    handle,
    displayName: '',
    profileUrl: link.url,
    accountType: '',
    active: true,
    issues,
    linkStatus: link.status,
    linkMessage: link.message,
  }
}

export function ExcelImportPreview({
  open,
  onOpenChange,
  accountTypes,
  onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  accountTypes: string[]
  onImported: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [sheetNames, setSheetNames] = useState<string[]>([])
  const [activeSheet, setActiveSheet] = useState('')
  const [matrix, setMatrix] = useState<Matrix>([])
  const [headerRow, setHeaderRow] = useState(0)
  const [mapping, setMapping] = useState<Mapping>({
    platform: NONE, profileUrl: NONE,
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [platformFilter, setPlatformFilter] = useState('all')
  const [importing, setImporting] = useState(false)
  const [accountType, setAccountType] = useState('')
  const [newAccountType, setNewAccountType] = useState('')

  useEffect(() => {
    if (!open) return
    setAccountType(accountTypes.includes('总部') ? '总部' : (accountTypes[0] || '__new__'))
    setNewAccountType('')
  }, [open, accountTypes])

  const headers = useMemo(
    () => (matrix[headerRow] || []).map((value, index) => String(value || '').trim() || `第 ${index + 1} 列`),
    [matrix, headerRow],
  )
  const dataRows = useMemo(
    () => matrix.slice(headerRow + 1).filter((row) => row.some((value) => String(value || '').trim() !== '')),
    [matrix, headerRow],
  )
  const normalizedRows = useMemo(
    () => dataRows.map((row) => normalizeRow(row, mapping)),
    [dataRows, mapping],
  )
  const preview = useMemo(() => normalizedRows.slice(0, 50), [normalizedRows])
  const validRows = useMemo(() => normalizedRows.filter((row) => row.issues.length === 0), [normalizedRows])
  const invalidRows = useMemo(() => normalizedRows.filter((row) => row.issues.length > 0), [normalizedRows])
  const resolvedAccountType = accountType === '__new__' ? newAccountType.trim() : accountType
  const platformOptions = useMemo(() => {
    const options = new Map<string, string>()
    for (const row of normalizedRows) {
      const code = row.platform || '__unknown__'
      if (!options.has(code)) options.set(code, row.platformText || '未识别平台')
    }
    return [...options.entries()].map(([code, label]) => ({ code, label }))
  }, [normalizedRows])
  const filteredPreview = useMemo(
    () => platformFilter === 'all'
      ? preview
      : preview.filter((row) => (row.platform || '__unknown__') === platformFilter),
    [preview, platformFilter],
  )
  const issueCount = useMemo(() => filteredPreview.filter((row) => row.issues.length > 0).length, [filteredPreview])
  const invalidLinkCount = useMemo(() => filteredPreview.filter((row) => row.linkStatus === 'invalid').length, [filteredPreview])
  const otherIssueCount = issueCount - invalidLinkCount
  const headerOptions = useMemo(
    () => matrix.slice(0, 12).map((row, index) => ({
      index,
      label: `第 ${index + 1} 行：${row.filter((value) => String(value || '').trim()).slice(0, 5).join(' | ') || '（空行）'}`,
    })),
    [matrix],
  )

  const applySheet = (name: string, workbook: any, utils: any) => {
    const sheet = workbook.Sheets[name]
    if (!sheet) return
    const rows = utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false }) as Matrix
    const selectedHeader = guessHeaderRow(rows)
    setActiveSheet(name)
    setMatrix(rows)
    setHeaderRow(selectedHeader)
    setMapping(guessMapping((rows[selectedHeader] || []).map((value) => String(value ?? ''))))
  }

  const loadFile = async (file: File) => {
    setError('')
    if (file.size > 20 * 1024 * 1024) {
      setError('文件超过 20MB，请拆分后再试')
      return
    }
    setLoading(true)
    try {
      const XLSX = await import('xlsx')
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const names = workbook.SheetNames || []
      if (!names.length) throw new Error('工作簿里没有可读的工作表')
      setFileName(file.name)
      setSheetNames(names)
      setPlatformFilter('all')
      applySheet(names[0], workbook, XLSX.utils)
    } catch (cause) {
      setFileName('')
      setSheetNames([])
      setMatrix([])
      setError(cause instanceof Error ? cause.message : 'Excel 解析失败')
    } finally {
      setLoading(false)
    }
  }

  const selectSheet = async (name: string) => {
    if (!fileName) return
    setLoading(true)
    try {
      // 重新解析当前文件需要保留原始 workbook；这里从 input 文件重新读取。
      const file = inputRef.current?.files?.[0]
      if (!file) return
      const XLSX = await import('xlsx')
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      applySheet(name, workbook, XLSX.utils)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '工作表读取失败')
    } finally {
      setLoading(false)
    }
  }

  const changeHeaderRow = (value: string) => {
    const index = Number(value)
    setHeaderRow(index)
    setMapping(guessMapping((matrix[index] || []).map((cellValue) => String(cellValue ?? ''))))
  }

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault()
    setDragOver(false)
    const file = event.dataTransfer.files?.[0]
    if (file) void loadFile(file)
  }

  const resetFile = () => {
    setFileName('')
    setPlatformFilter('all')
    setSheetNames([])
    setActiveSheet('')
    setMatrix([])
    setHeaderRow(0)
    setError('')
    if (inputRef.current) inputRef.current.value = ''
  }

  const submitImport = async () => {
    if (!validRows.length || importing) return
    if (!resolvedAccountType) {
      toast.error('请填写账号类型')
      return
    }
    setImporting(true)
    try {
      const result = await importAccounts(validRows.map((row) => ({
        platformCode: row.platform,
        handle: row.handle,
        profileUrl: row.profileUrl,
        displayName: row.handle,
      })), resolvedAccountType)
      if (result.errors.length) {
        toast.warning(`新增 ${result.created} 个，更新 ${result.updated} 个，跳过 ${result.skipped} 个`, {
          description: result.errors.slice(0, 2).join('；'),
        })
      } else {
        toast.success(`导入完成：新增 ${result.created} 个，更新 ${result.updated} 个，跳过 ${result.skipped} 个`)
      }
      onOpenChange(false)
      onImported()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导入失败')
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="cx-portal max-h-[92vh] overflow-y-auto sm:max-w-[1180px]">
        <DialogHeader>
          <DialogTitle>Excel 导入预览</DialogTitle>
          <DialogDescription>
            文件只在浏览器本地解析，不会上传。先确认表头、列对应关系和预览结果。
          </DialogDescription>
        </DialogHeader>

        {!fileName ? (
          <div
            onDragOver={(event) => { event.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            className={cn(
              'flex flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-16 text-center transition-colors',
              dragOver ? 'border-primary bg-accent/40' : 'border-border bg-muted/20',
            )}
          >
            <div className="grid size-12 place-items-center rounded-2xl bg-card text-primary shadow-sm ring-1 ring-border">
              {loading ? <LoaderCircle className="size-5 animate-spin" /> : <FileSpreadsheet className="size-5" />}
            </div>
            <p className="mt-4 text-sm font-medium">拖入 Excel 文件，或选择文件</p>
            <p className="mt-1 text-xs text-muted-foreground">支持 .xlsx / .xls / .csv，最大 20MB</p>
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void loadFile(file)
              }}
            />
            <Button variant="outline" className="mt-5 gap-2" onClick={() => inputRef.current?.click()} disabled={loading}>
              <UploadCloud className="size-4" />选择文件
            </Button>
            {error ? <p className="mt-4 text-xs text-rose-700">{error}</p> : null}
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/80 bg-muted/20 px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <FileSpreadsheet className="size-4 shrink-0 text-primary" />
                <span className="truncate font-medium">{fileName}</span>
                <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[10px]">{dataRows.length} 行</Badge>
              </div>
              <Button variant="ghost" size="sm" className="gap-1" onClick={resetFile}>
                <X className="size-3.5" />重新选择
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <p className="text-xs font-medium">导入到账号类型</p>
                <Select value={accountType} onValueChange={setAccountType}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="选择账号类型" /></SelectTrigger>
                  <SelectContent className="cx-portal">
                    {accountTypes.map((type) => (
                      <SelectItem key={type} value={type}>{type}</SelectItem>
                    ))}
                    <SelectItem value="__new__">+ 新建账号类型</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {accountType === '__new__' ? (
                <div className="grid gap-1.5">
                  <p className="text-xs font-medium">新账号类型</p>
                  <Input
                    value={newAccountType}
                    onChange={(event) => setNewAccountType(event.target.value)}
                    placeholder="例如 中东非"
                    maxLength={100}
                  />
                </div>
              ) : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <p className="text-xs font-medium">工作表</p>
                <Select value={activeSheet} onValueChange={(value) => void selectSheet(value)}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent className="cx-portal">
                    {sheetNames.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <p className="text-xs font-medium">表头行</p>
                <Select value={String(headerRow)} onValueChange={changeHeaderRow}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent className="cx-portal">
                    {headerOptions.map((option) => (
                      <SelectItem key={option.index} value={String(option.index)}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium">列对应关系</p>
              <p className="mb-2 text-[11px] text-muted-foreground">只需映射平台和账号链接；账号标识会从链接自动提取。</p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {FIELDS.map((field) => (
                  <div key={field.key} className="grid gap-1.5 rounded-xl border border-border/70 bg-card px-3 py-2.5">
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {field.label}{field.required ? <span className="ml-1 text-rose-500">*</span> : null}
                    </p>
                    <Select
                      value={mapping[field.key]}
                      onValueChange={(value) => setMapping((current) => ({ ...current, [field.key]: value }))}
                    >
                      <SelectTrigger className="h-8 w-full text-xs"><SelectValue placeholder="不映射" /></SelectTrigger>
                      <SelectContent className="cx-portal">
                        <SelectItem value={NONE}>不映射</SelectItem>
                        {headers.map((header, index) => (
                          <SelectItem key={`${header}-${index}`} value={String(index)}>{header}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>共 {dataRows.length} 行，当前显示 {filteredPreview.length} 行</span>
                {invalidLinkCount ? (
                  <Badge variant="outline" className="border-rose-200 bg-rose-50 text-rose-700">{invalidLinkCount} 个链接不符合标准</Badge>
                ) : null}
                {otherIssueCount > 0 ? (
                  <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-800">{otherIssueCount} 行其他问题</Badge>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">平台</span>
                <Select value={platformFilter} onValueChange={setPlatformFilter}>
                  <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent className="cx-portal">
                    <SelectItem value="all">全部平台</SelectItem>
                    {platformOptions.map((option) => (
                      <SelectItem key={option.code} value={option.code}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {invalidLinkCount ? (
              <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs text-rose-800">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>有 {invalidLinkCount} 个账号链接不是平台标准主页格式，已在表格中整行标红；请先处理这些链接。</span>
              </div>
            ) : null}

            <div className="max-h-[360px] overflow-auto rounded-xl border border-border/80">
              <Table className="min-w-[980px]">
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead className="w-[92px]">平台</TableHead>
                    <TableHead>提取的账号标识</TableHead>
                    <TableHead>显示名称</TableHead>
                    <TableHead className="min-w-[230px]">账号链接</TableHead>
                    <TableHead>账号类型</TableHead>
                    <TableHead className="w-[80px]">状态</TableHead>
                    <TableHead className="w-[150px]">检查</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredPreview.map((row, index) => (
                    <TableRow
                      key={index}
                      className={cn(
                        row.linkStatus === 'invalid' && 'bg-rose-50/60 hover:bg-rose-50',
                        row.linkStatus === 'warning' && 'bg-amber-50/35 hover:bg-amber-50/60',
                      )}
                    >
                      <TableCell className="text-xs">{row.platformText || <span className="text-rose-600">缺失</span>}</TableCell>
                      <TableCell className="text-xs font-medium">{row.handle || <span className="text-rose-600">缺失</span>}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{row.displayName || '—'}</TableCell>
                      <TableCell className={cn('max-w-[340px]', row.linkStatus === 'invalid' && 'bg-rose-100/50')}>
                        <span
                          className={cn(
                            'block truncate text-xs',
                            row.linkStatus === 'invalid' && 'font-medium text-rose-700',
                            row.linkStatus === 'warning' && 'text-amber-700',
                            row.linkStatus === 'ok' && 'text-muted-foreground',
                          )}
                          title={row.profileUrl || undefined}
                        >
                          {row.profileUrl || '—'}
                        </span>
                        {row.linkStatus === 'invalid' ? (
                          <span className="mt-0.5 flex items-center gap-1 text-[10px] font-medium text-rose-600">
                            <CircleAlert className="size-3" />
                            链接不符合平台标准
                          </span>
                        ) : null}
                        {row.linkStatus === 'warning' ? (
                          <span className="mt-0.5 block text-[10px] text-amber-700">已清理链接参数</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-xs">{row.accountType || '—'}</TableCell>
                      <TableCell>
                        <Badge variant={row.active ? 'secondary' : 'outline'} className="text-[10px]">
                          {row.active ? '启用' : '停用'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {row.linkStatus === 'invalid' ? (
                          <span className="text-[11px] font-medium text-rose-700">{row.linkMessage}</span>
                        ) : row.issues.length ? (
                          <span className="text-[11px] text-amber-700">{row.issues.join('，')}</span>
                        ) : (
                          <span className="text-[11px] text-emerald-700">可预览</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {!filteredPreview.length ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-10 text-center text-xs text-muted-foreground">
                        当前平台没有可预览的数据
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </div>

            {error ? <p className="text-xs text-rose-700">{error}</p> : null}
          </div>
        )}

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <p className="mr-auto hidden text-[11px] text-muted-foreground sm:block">
            有效链接会写入账号库并分配所选账号类型；已存在账号会更新类型，不覆盖其他信息。
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={importing}>关闭</Button>
            {fileName ? (
              <Button onClick={submitImport} disabled={!validRows.length || !resolvedAccountType || importing} className="gap-1.5">
                {importing ? <LoaderCircle className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                导入 {validRows.length} 个有效账号{invalidRows.length ? `（跳过 ${invalidRows.length} 行）` : ''}
              </Button>
            ) : null}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
