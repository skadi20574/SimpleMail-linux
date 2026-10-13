import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Account,
  AppSettings,
  Folder,
  MailDetail,
  MailSummary,
  SearchCriteria,
  SyncProgress
} from './api'
import { api } from './api'
import {
  compactCriteria,
  countCriteria,
  describeCriteria,
  hasAnyCriteria,
  splitHighlightTermsMulti,
  SEARCH_CRITERIA_FIELDS
} from '@shared/search-terms'
import { actionForEvent, resolveShortcuts, SHORTCUT_ACTIONS } from '@shared/shortcuts'
import type { MailtoRequest, MailtoDelivery } from '@shared/types'
import type { ThemeMode } from '@shared/types'
import { applyTheme, watchSystemTheme } from './theme'
import Sidebar from './components/Sidebar'
import MailList from './components/MailList'
import MailView from './components/MailView'
import Composer, { buildReplyInit, type ComposeInit } from './components/Composer'
import AccountDialog from './components/AccountDialog'
import SettingsDialog from './components/SettingsDialog'
import ArchiveDialog from './components/ArchiveDialog'
import RulesDialog from './components/RulesDialog'
import { ChoiceDialog, InputDialog } from './components/Dialogs'
import Icon from './components/Icon'

const DEFAULT_SETTINGS: AppSettings = {
  splitRatio: 0.42,
  pageSize: 200,
  syncBatch: 500,
  autoDownloadBodies: true,
  allowRemoteImages: false,
  theme: 'system',
  shortcuts: {},
  autoMarkRead: true,
  autoSyncOnStart: true,
  defaultArchiveTag: 'Foxmail存档'
}

type ArchiveMode = 'import' | 'export' | 'inspect'

/** 排序维度：搜索时多一个「相关度」（用 FTS5 的 bm25） */
type OrderBy = 'relevance' | 'date' | 'subject' | 'from'

export default function App(): JSX.Element {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [statsText, setStatsText] = useState('')
  const [appVersion, setAppVersion] = useState('')

  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null)
  const [mails, setMails] = useState<MailSummary[]>([])
  const [total, setTotal] = useState(0)
  const [listLoading, setListLoading] = useState(false)
  /** 下方面板显示的那封，同时也是键盘 ↑↓ 移动的游标 */
  const [selectedMailId, setSelectedMailId] = useState<number | null>(null)
  /** 多选高亮的集合（Ctrl / Shift 选择、Ctrl+A 全选都写在这里） */
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  /** Shift 范围选择的锚点：按下 Shift 时从这里拉到目标行 */
  const [anchorId, setAnchorId] = useState<number | null>(null)
  const [detail, setDetail] = useState<MailDetail | null>(null)
  const [allowRemoteImages, setAllowRemoteImages] = useState(false)

  /**
   * 搜索：工具栏那个通用框（对应 criteria.all）+ 展开面板里四个并列的字段框。
   * 每个框都可以留空 —— 留空即该字段不参与限制；多个非空字段之间是 AND。
   */
  const [searchInput, setSearchInput] = useState('')
  const [searchFields, setSearchFields] = useState<SearchCriteria>({})
  const [criteria, setCriteria] = useState<SearchCriteria>({})
  const [searchPanelOpen, setSearchPanelOpen] = useState(false)
  const [orderBy, setOrderBy] = useState<OrderBy>('date')
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('desc')

  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const [accountDialog, setAccountDialog] = useState<{ open: boolean; account: Account | null }>({
    open: false,
    account: null
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)

  /** 文件夹名输入对话框（新建 / 重命名共用） */
  const [folderDialog, setFolderDialog] = useState<{
    mode: 'create' | 'rename'
    title: string
    accountId: number
    parentId: number | null
    folderId?: number
    defaultValue: string
  } | null>(null)

  /** 删除文件夹的确认（要问里面的邮件怎么办） */
  const [folderDelete, setFolderDelete] = useState<{
    folder: Folder
    mailCount: number
  } | null>(null)

  /** 正在拖拽的邮件 id；拖到左侧文件夹上时用它 */
  const draggingIdsRef = useRef<number[]>([])
  const [archiveDialog, setArchiveDialog] = useState<{
    open: boolean
    mode: ArchiveMode
    accountId?: number
  }>({ open: false, mode: 'import' })
  const [composer, setComposer] = useState<ComposeInit | null>(null)

  const offsetRef = useRef(0)
  const searchRef = useRef<HTMLInputElement | null>(null)
  /** 供 mailto 监听读取最新的账户列表（订阅本身要保持稳定，不能每次账户变化都重订） */
  const accountsRef = useRef<Account[]>([])
  /** 账户还没加载完就先到了的 mailto 请求，先存着，等账户到位再打开 */
  const pendingMailtoRef = useRef<MailtoRequest | null>(null)
  /** 已经处理过的 mailto 投递 id：推送与挂载拉取可能重复投递同一条 */
  const handledMailtoIdRef = useRef(0)
  const toastTimer = useRef<number | null>(null)
  const splitRef = useRef(0.42)
  /** 事件回调（同步完成等）里必须调用「最新」的加载函数，
   *  否则会拿着旧闭包去查全库，把已经筛选好的列表覆盖掉。 */
  const loadMailsRef = useRef<(offset: number, replace: boolean) => Promise<void>>(async () => {})

  const notify = useCallback((message: string): void => {
    setToast(message)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 4200)
  }, [])

  /* ─────────────── 初始化 ─────────────── */

  const refreshAccountsAndFolders = useCallback(async (): Promise<void> => {
    const [accs, folds, st, paths] = await Promise.all([
      api.accounts.list(),
      api.folders.list(),
      api.app.stats(),
      api.app.paths()
    ])
    setAccounts(accs)
    setFolders(folds)
    setAppVersion(paths.version)
    setStatsText(`${accs.length} 个账户 · ${st.mails} 封邮件`)
    return undefined
  }, [])

  useEffect(() => {
    void (async () => {
      const s = await api.settings.get()
      setSettings(s)
      setAllowRemoteImages(s.allowRemoteImages)
      splitRef.current = s.splitRatio
      setSplitPct(Math.round(s.splitRatio * 100))
      await refreshAccountsAndFolders()

      const accs = await api.accounts.list()
      const folds = await api.folders.list()
      const firstInbox =
        folds.find((f) => f.role === 'inbox') ??
        folds.find((f) => f.accountId === accs[0]?.id) ??
        folds[0]
      if (firstInbox) setSelectedFolderId(firstInbox.id)

      if (s.autoSyncOnStart) {
        // 没填密码/授权码的账户跳过，避免一启动就弹一堆连接失败
        for (const a of accs) {
          if (!a.isLocal && a.syncEnabled && a.password) void api.sync.start(a.id)
        }
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const offProgress = api.sync.onProgress((p) => setSyncProgress(p))
    const offFinished = api.sync.onFinished(async () => {
      setSyncProgress(null)
      await refreshAccountsAndFolders()
      await loadMailsRef.current(0, true)
    })
    return () => {
      offProgress()
      offFinished()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshAccountsAndFolders])

  /* ─────────────── 列表加载 ─────────────── */

  const loadMails = useCallback(
    async (offset: number, replace: boolean): Promise<void> => {
      setListLoading(true)
      try {
        const active = hasAnyCriteria(criteria)
        const result = await api.mails.list({
          // 搜索跨全库：一旦有任何条件，就不再限定在当前文件夹里
          folderId: active ? undefined : (selectedFolderId ?? undefined),
          searchCriteria: active ? compactCriteria(criteria) : undefined,
          limit: settings.pageSize,
          offset,
          orderBy,
          orderDir
        })
        setTotal(result.total)
        offsetRef.current = offset
        setMails((prev) => (replace ? result.items : [...prev, ...result.items]))
      } finally {
        setListLoading(false)
      }
    },
    [selectedFolderId, criteria, settings.pageSize, orderBy, orderDir]
  )

  useEffect(() => {
    loadMailsRef.current = loadMails
  }, [loadMails])

  useEffect(() => {
    // 换了文件夹 / 搜索条件 / 排序，原来的选择已经没有意义了
    setSelectedIds(new Set())
    setAnchorId(null)
    void loadMails(0, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFolderId, criteria, orderBy, orderDir])

  // 搜索防抖。所有输入框（通用框 + 四个并列字段框）合并成一份条件，
  // 任一变化都重新查，避免每敲一个字就查一次库。
  // 开始搜索时自动切到「相关度」排序 —— 匹配度最高的排最前。
  // 之后用户如果点「时间」等排序按钮，不会被这里覆盖（本效果只在输入变化时跑）。
  useEffect(() => {
    const t = window.setTimeout(() => {
      const next = compactCriteria({ ...searchFields, all: searchInput.trim() })
      setCriteria(next)
      if (hasAnyCriteria(next)) setOrderBy('relevance')
    }, 320)
    return () => window.clearTimeout(t)
  }, [searchInput, searchFields])

  /* ─────────────── 系统邮件链接（mailto:） ─────────────── */

  /**
   * 发信优先用配好了 SMTP 的账户，其次任意在线账户。
   * 本地存档账户（isLocal）只能读不能发，必须排除掉。
   */
  const pickSendAccount = useCallback((list: Account[]): Account | undefined => {
    const online = list.filter((a) => !a.isLocal)
    return online.find((a) => a.smtpHost) ?? online[0]
  }, [])

  const openMailtoCompose = useCallback(
    (req: MailtoRequest, list: Account[]): void => {
      const account = pickSendAccount(list)
      if (!account) {
        notify('收到邮件链接，但还没有可发信的邮箱账户 —— 请先在「设置」里添加一个')
        return
      }
      const sig = account.signature ? `\n\n--\n${account.signature}` : ''
      setComposer({
        accountId: account.id,
        to: req.to,
        cc: req.cc,
        bcc: req.bcc,
        subject: req.subject,
        // 链接里带了正文就用链接的；没带才补上签名
        body: req.body || sig,
        attachments: []
      })
    },
    [notify, pickSendAccount]
  )

  /**
   * 处理一条 mailto 投递。
   *
   * 推送（mailto:open）与挂载时的主动拉取（mailto:take）可能把同一条送两次，
   * 所以按自增 id 去重 —— 否则用户会看到写信窗口被打开两次。
   */
  const handleMailto = useCallback(
    (delivery: MailtoDelivery): void => {
      if (delivery.id <= handledMailtoIdRef.current) return
      handledMailtoIdRef.current = delivery.id
      void api.mailto.ack(delivery.id)

      const list = accountsRef.current
      if (!list.length) {
        // 账户还没读回来：先记下，等账户到位再打开。
        // 直接丢弃的话，用户在程序没开着时点邮件链接就会「什么都不发生」。
        pendingMailtoRef.current = delivery.request
        return
      }
      openMailtoCompose(delivery.request, list)
    },
    [openMailtoCompose]
  )

  useEffect(() => {
    accountsRef.current = accounts
    // 账户到位了，把之前排队的那条 mailto 处理掉
    if (accounts.length && pendingMailtoRef.current) {
      const queued = pendingMailtoRef.current
      pendingMailtoRef.current = null
      openMailtoCompose(queued, accounts)
    }
  }, [accounts, openMailtoCompose])

  useEffect(() => api.mailto.onOpen(handleMailto), [handleMailto])

  /**
   * 挂载后主动拉一次。
   *
   * 主进程推送有可能早于本 effect 建立订阅（页面的 did-finish-load 先到），
   * 那条消息就丢了 —— 表现为「程序起来了但没打开写信窗口」。
   * 所以这里主动问一次；与推送重复时靠 id 去重。
   */
  useEffect(() => {
    void (async () => {
      try {
        const delivery = await api.mailto.take()
        if (delivery) handleMailto(delivery)
      } catch {
        /* 主进程还没注册好，等推送那条路 */
      }
    })()
  }, [handleMailto])

  /* ─────────────── 邮件详情 ─────────────── */

  useEffect(() => {
    if (selectedMailId === null) {
      setDetail(null)
      return
    }
    let cancelled = false
    void (async () => {
      const mail = await api.mails.get(selectedMailId)
      if (cancelled) return
      setDetail(mail ?? null)
      // 自动标记已读可以在设置里关掉（关掉后用右键菜单或 M 键手动改）
      if (mail?.unread && settingsRef.current.autoMarkRead) {
        await api.mails.markRead(mail.id, false)
        setMails((prev) => prev.map((m) => (m.id === mail.id ? { ...m, unread: false } : m)))
        setFolders((prev) =>
          prev.map((f) => (f.id === mail.folderId ? { ...f, unread: Math.max(0, f.unread - 1) } : f))
        )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedMailId])

  /* ─────────────── 分割条拖动 ─────────────── */

  const [splitPct, setSplitPct] = useState(42)
  const dragging = useRef(false)

  useEffect(() => {
    const move = (e: MouseEvent): void => {
      if (!dragging.current) return
      const container = document.getElementById('main-column')
      if (!container) return
      const rect = container.getBoundingClientRect()
      const ratio = Math.min(0.85, Math.max(0.12, (e.clientY - rect.top) / rect.height))
      splitRef.current = ratio
      setSplitPct(Math.round(ratio * 100))
    }
    const up = (): void => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ''
      void api.settings.set({ splitRatio: splitRef.current })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [])

  /* ─────────────── 操作 ─────────────── */

  const currentFolder = useMemo(
    () => folders.find((f) => f.id === selectedFolderId) ?? null,
    [folders, selectedFolderId]
  )

  const searching = hasAnyCriteria(criteria)
  const activeCount = countCriteria(criteria)
  const searchTerms = useMemo(
    () => splitHighlightTermsMulti(criteria),
    [criteria]
  )

  /** 一键清空全部搜索条件（工具栏的通用框 + 面板里四个字段框） */
  const clearSearch = useCallback((): void => {
    setSearchInput('')
    setSearchFields({})
    setCriteria({})
  }, [])

  /** 生效的快捷键表（用户设置覆盖默认值） */
  const shortcuts = useMemo(() => resolveShortcuts(settings), [settings])

  /* ─────────────── 主题 ─────────────── */

  /** 详情副作用里要读最新设置（避免闭包过期），也用于快捷键表 */
  const settingsRef = useRef(settings)
  const themeRef = useRef<ThemeMode>(settings.theme)

  useEffect(() => {
    settingsRef.current = settings
    themeRef.current = settings.theme
    applyTheme(settings.theme)
  }, [settings])

  // 跟随系统时，系统切换深浅要实时反映过来
  useEffect(() => {
    return watchSystemTheme(() => applyTheme(themeRef.current))
  }, [])

  const cycleTheme = (): void => {
    const order: ThemeMode[] = ['light', 'dark', 'system']
    const next = order[(order.indexOf(settings.theme) + 1) % order.length]
    void api.settings.set({ theme: next }).then((saved) => {
      setSettings(saved)
      applyTheme(saved.theme)
      const label = next === 'light' ? '浅色' : next === 'dark' ? '深色' : '跟随系统'
      notify(`主题已切换为「${label}」`)
    })
  }

  const syncAll = (): void => {
    const online = accounts.filter((a) => !a.isLocal && a.syncEnabled)
    if (!online.length) {
      notify('还没有配置邮箱账户，请先点「设置」添加')
      return
    }
    const targets = online.filter((a) => a.password)
    if (!targets.length) {
      notify('账户还没有填写密码/授权码，请在「设置」里补上后再同步')
      return
    }
    for (const a of targets) void api.sync.start(a.id)
    notify(
      `已开始同步 ${targets.length} 个账户` +
        (targets.length < online.length ? `（另有 ${online.length - targets.length} 个未配置密码，已跳过）` : '')
    )
  }

  const openComposerNew = (): void => {
    const account = accounts.find((a) => !a.isLocal) ?? accounts[0]
    if (!account) {
      notify('请先添加一个邮箱账户')
      return
    }
    if (account.isLocal) {
      notify('请先在设置里添加一个真实邮箱账户')
      return
    }
    const sig = account.signature ? `\n\n--\n${account.signature}` : ''
    setComposer({
      accountId: account.id,
      to: '',
      cc: '',
      bcc: '',
      subject: '',
      body: sig,
      attachments: []
    })
  }

  const openDraft = async (mail: MailSummary): Promise<void> => {
    const full = await api.mails.get(mail.id)
    if (!full) return
    setComposer({
      accountId: full.accountId,
      draftId: full.id,
      to: full.toText,
      cc: full.ccText,
      bcc: full.bccText,
      subject: full.subject === '(无主题)' ? '' : full.subject,
      body: full.bodyText,
      attachments: full.attachments
        .filter((a) => a.storedPath)
        .map((a) => ({ path: a.storedPath as string, filename: a.filename, contentType: a.contentType }))
    })
  }

  const reply = (mail: MailDetail, mode: 'reply' | 'replyAll' | 'forward'): void => {
    const account = accounts.find((a) => a.id === mail.accountId) ?? accounts[0]
    if (!account) return
    setComposer(buildReplyInit(account.id, mail, mode, account.signature))
  }

  /* ─────────────── 多选 ─────────────── */

  /** 只选中一封（普通单击） */
  const selectOnly = (id: number): void => {
    setSelectedIds(new Set([id]))
    setAnchorId(id)
    setSelectedMailId(id)
  }

  /** 切换一封的选中状态（Ctrl / Cmd + 单击，或点复选框） */
  const selectToggle = (id: number): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setAnchorId(id)
    setSelectedMailId(id)
  }

  /** 从锚点连选到目标（Shift + 单击 / Shift + ↑↓） */
  const selectRangeTo = (targetId: number): void => {
    const ids = mails.map((m) => m.id)
    const anchor = anchorId === null ? -1 : ids.indexOf(anchorId)
    const target = ids.indexOf(targetId)
    if (anchor === -1 || target === -1) {
      selectOnly(targetId)
      return
    }
    const [lo, hi] = anchor <= target ? [anchor, target] : [target, anchor]
    setSelectedIds(new Set(ids.slice(lo, hi + 1)))
    // 锚点保持不变，这样连续按 Shift+↑↓ 能不断调整范围
    setSelectedMailId(targetId)
  }

  const selectAll = (select: boolean): void => {
    setSelectedIds(select ? new Set(mails.map((m) => m.id)) : new Set())
    if (!select) setAnchorId(null)
  }

  /** 点击行：按修饰键决定是单选、切换还是范围选择 */
  const handleRowClick = (mail: MailSummary, e: React.MouseEvent): void => {
    const isDraftFolder = currentFolder?.role === 'drafts'

    if (e.shiftKey && anchorId !== null) {
      selectRangeTo(mail.id)
    } else if (e.ctrlKey || e.metaKey) {
      selectToggle(mail.id)
    } else {
      selectOnly(mail.id)
    }

    // 草稿箱里普通单击 = 继续编辑这封草稿；带修饰键时只做选择
    if (isDraftFolder && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      void openDraft(mail)
    }
  }

  /** 键盘上下移动游标；extend=true 时保持锚点做范围选择 */
  const moveActive = (delta: number, extend: boolean): void => {
    if (!mails.length) return
    const current = mails.findIndex((m) => m.id === selectedMailId)
    let next: number
    if (current === -1) next = delta >= 0 ? 0 : mails.length - 1
    else next = Math.min(mails.length - 1, Math.max(0, current + delta))

    const target = mails[next]
    if (!target) return

    if (extend && anchorId !== null) {
      selectRangeTo(target.id)
    } else {
      setSelectedIds(new Set([target.id]))
      setAnchorId(target.id)
      setSelectedMailId(target.id)
    }

    // 让移动的行始终可见
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-mail-id="${target.id}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    })
  }

  /* ─────────────── 批量操作 ─────────────── */

  /**
   * 删除选中的邮件。
   *   permanent=false → Delete 键，移到垃圾箱
   *   permanent=true  → Shift+Delete，本机彻底删除（附件文件一并清掉）
   */
  const deleteMails = async (targetIds: number[], permanent: boolean): Promise<void> => {
    const ids = targetIds
    if (!ids.length) {
      notify('先选中邮件再删除')
      return
    }
    const count = ids.length

    if (permanent) {
      const ok = confirm(
        `确定永久删除选中的 ${count} 封邮件吗？\n\n` +
          '· 本机邮件正文与附件文件都会被删除，无法从本机恢复\n' +
          '· IMAP 账户会同时在服务器上移到垃圾箱，避免下次同步又回来\n' +
          '· 此操作不可撤销'
      )
      if (!ok) return
    } else if (count >= 5) {
      // 少量邮件直接执行（可恢复，不打断操作节奏）；批量时先确认
      if (!confirm(`确定把选中的 ${count} 封邮件移到垃圾箱吗？`)) return
    }

    try {
      const r = permanent
        ? await api.mails.deleteMany(ids, true)
        : await api.mails.deleteMany(ids, false)
      const parts = [`${permanent ? '已永久删除' : '已移到垃圾箱'} ${r.affected} 封`]
      if (r.filesRemoved) parts.push(`清理附件文件 ${r.filesRemoved} 个`)
      if (r.skipped) parts.push(`跳过 ${r.skipped} 封`)
      if (r.errors.length) parts.push(`${r.errors.length} 项失败`)
      notify(parts.join('，'))
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    }

    setSelectedIds(new Set())
    setAnchorId(null)
    setSelectedMailId(null)
    setDetail(null)
    await refreshAccountsAndFolders()
    void loadMails(0, true)
  }

  /** Delete / Shift+Delete：对当前选择执行删除 */
  const deleteSelection = async (permanent: boolean): Promise<void> => {
    // 没有任何多选时，退化为「删除当前正在看的那封」
    const ids =
      selectedIds.size > 0
        ? [...selectedIds]
        : detail
          ? [detail.id]
          : selectedMailId
            ? [selectedMailId]
            : []
    await deleteMails(ids, permanent)
  }

  /** M 键：选中里有未读就全标已读，否则全标未读 */
  const toggleReadSelection = async (): Promise<void> => {
    const ids = [...selectedIds]
    if (!ids.length) return
    const anyUnread = mails.some((m) => selectedIds.has(m.id) && m.unread)
    const r = await api.mails.markManyRead(ids, anyUnread)
    setMails((prev) => prev.map((m) => (selectedIds.has(m.id) ? { ...m, unread: anyUnread } : m)))
    notify(anyUnread ? `已标记 ${r.affected} 封为已读` : `已标记 ${r.affected} 封为未读`)
    await refreshAccountsAndFolders()
  }

  /** S 键：批量星标 */
  const toggleFlagSelection = async (): Promise<void> => {
    const ids = [...selectedIds]
    if (!ids.length) return
    const anyUnflagged = mails.some((m) => selectedIds.has(m.id) && !m.flagged)
    const r = await api.mails.markManyFlagged(ids, anyUnflagged)
    setMails((prev) => prev.map((m) => (selectedIds.has(m.id) ? { ...m, flagged: anyUnflagged } : m)))
    notify(anyUnflagged ? `已给 ${r.affected} 封加星标` : `已取消 ${r.affected} 封的星标`)
  }

  const toggleFlag = async (mail: MailDetail): Promise<void> => {
    const next = !mail.flagged
    await api.mails.markFlagged(mail.id, next)
    setDetail({ ...mail, flagged: next })
    setMails((prev) => prev.map((m) => (m.id === mail.id ? { ...m, flagged: next } : m)))
  }

  /* ─────────────── 右键菜单与双击 ─────────────── */

  const handleRowDoubleClick = (mail: MailSummary): void => {
    // 草稿箱里双击 = 继续编辑，不开读信窗口
    if (currentFolder?.role === 'drafts') {
      void openDraft(mail)
      return
    }
    void api.mails.openWindow(mail.id)
  }

  const handleRowContextMenu = async (mail: MailSummary, e: React.MouseEvent): Promise<void> => {
    e.preventDefault()

    // 右键点在「没被选中」的行上时，先把它变成唯一选择 —— 和文件管理器一致
    let ids = [...selectedIds]
    if (!selectedIds.has(mail.id)) {
      ids = [mail.id]
      setSelectedIds(new Set([mail.id]))
      setAnchorId(mail.id)
      setSelectedMailId(mail.id)
    }

    const targets = ids
      .map((id) => mails.find((m) => m.id === id))
      .filter((m): m is MailSummary => Boolean(m))

    const result = await api.mails.contextMenu({
      mailIds: ids,
      activeMailId: mail.id,
      allRead: targets.length ? targets.every((m) => !m.unread) : null,
      allFlagged: targets.length ? targets.every((m) => m.flagged) : null,
      folders: folders.map((f) => ({ id: f.id, name: f.name, accountId: f.accountId })),
      currentFolderId: selectedFolderId
    })
    if (!result) return

    switch (result.action) {
      case 'open':
        void api.mails.openWindow(mail.id)
        return
      case 'markRead':
      case 'markUnread': {
        const unread = result.action === 'markUnread'
        const r = await api.mails.markManyRead(ids, unread)
        setMails((prev) => prev.map((m) => (ids.includes(m.id) ? { ...m, unread } : m)))
        notify(unread ? `已标记 ${r.affected} 封为未读` : `已标记 ${r.affected} 封为已读`)
        await refreshAccountsAndFolders()
        return
      }
      case 'flag':
      case 'unflag': {
        const flagged = result.action === 'flag'
        const r = await api.mails.markManyFlagged(ids, flagged)
        setMails((prev) => prev.map((m) => (ids.includes(m.id) ? { ...m, flagged } : m)))
        notify(flagged ? `已给 ${r.affected} 封加星标` : `已取消 ${r.affected} 封的星标`)
        return
      }
      case 'reply':
      case 'replyAll':
      case 'forward': {
        const target = await api.mails.get(mail.id)
        if (target) {
          reply(target, result.action === 'replyAll' ? 'replyAll' : result.action)
        }
        return
      }
      case 'move': {
        if (!result.folderId) return
        const r = await api.mails.moveMany(ids, result.folderId)
        notify(`已移动 ${r.affected} 封邮件`)
        setSelectedIds(new Set())
        setSelectedMailId(null)
        setDetail(null)
        await refreshAccountsAndFolders()
        void loadMails(0, true)
        return
      }
      case 'trash':
        await deleteMails(ids, false)
        return
      case 'delete':
        await deleteMails(ids, true)
        return
      default:
        return
    }
  }

  /* ─────────────── 文件夹管理 ─────────────── */

  const refreshAfterFolderOp = async (message: string): Promise<void> => {
    notify(message)
    await refreshAccountsAndFolders()
    void loadMails(0, true)
  }

  const doCreateFolder = async (value: string): Promise<void> => {
    const dialog = folderDialog
    if (!dialog) return
    setFolderDialog(null)
    const r = await api.folders.create(dialog.accountId, value, dialog.parentId)
    if (r.errors.length) {
      notify(r.errors[0])
      return
    }
    await refreshAfterFolderOp(`已创建文件夹「${value}」`)
  }

  const doRenameFolder = async (value: string): Promise<void> => {
    const dialog = folderDialog
    if (!dialog?.folderId) return
    setFolderDialog(null)
    const r = await api.folders.rename(dialog.folderId, value)
    if (r.errors.length) {
      notify(r.errors[0])
      return
    }
    await refreshAfterFolderOp(`已重命名为「${value}」`)
  }

  const doDeleteFolder = async (mailMode: 'trash' | 'delete'): Promise<void> => {
    const target = folderDelete
    if (!target) return
    setFolderDelete(null)
    const r = await api.folders.remove(target.folder.id, mailMode)
    if (r.errors.length && r.affected === 0) {
      notify(r.errors[0])
      return
    }
    if (selectedFolderId === target.folder.id) {
      setSelectedFolderId(null)
      setSelectedMailId(null)
      setDetail(null)
    }
    await refreshAfterFolderOp(
      `已删除文件夹「${target.folder.name}」` +
        (r.affected > 1 ? `，${r.affected - 1} 封邮件已${
          mailMode === 'trash' ? '移到垃圾箱' : '永久删除'
        }` : '')
    )
  }

  /** 右键文件夹 → 原生菜单 → 执行 */
  const handleFolderContextMenu = async (folder: Folder, e: React.MouseEvent): Promise<void> => {
    e.preventDefault()
    const result = await api.folders.contextMenu(folder.id)
    if (!result) return

    switch (result.action) {
      case 'createSub':
        setFolderDialog({
          mode: 'create',
          title: '新建子文件夹',
          accountId: folder.accountId,
          parentId: folder.id,
          defaultValue: ''
        })
        return
      case 'createSibling': {
        // 同级 = 父文件夹下；顶层文件夹则建在账户根下
        const parentPath = folder.path.includes(folder.delimiter)
          ? folder.path.slice(0, folder.path.lastIndexOf(folder.delimiter))
          : ''
        const parent = parentPath
          ? folders.find((f) => f.accountId === folder.accountId && f.path === parentPath)
          : undefined
        setFolderDialog({
          mode: 'create',
          title: '新建文件夹',
          accountId: folder.accountId,
          parentId: parent?.id ?? null,
          defaultValue: ''
        })
        return
      }
      case 'rename':
        setFolderDialog({
          mode: 'rename',
          title: '重命名文件夹',
          accountId: folder.accountId,
          parentId: null,
          folderId: folder.id,
          defaultValue: folder.name
        })
        return
      case 'delete': {
        const info = await api.folders.info(folder.id)
        setFolderDelete({ folder, mailCount: info?.mailCount ?? 0 })
        return
      }
      case 'sync': {
        const account = accounts.find((a) => a.id === folder.accountId)
        if (account && !account.password) {
          notify('这个账户还没有填写密码/授权码')
          return
        }
        void api.sync.start(folder.accountId)
        notify('已开始同步')
        return
      }
      default:
        return
    }
  }

  /** 把拖拽中的邮件放进目标文件夹 */
  const handleDropMails = async (folderId: number): Promise<void> => {
    const ids = draggingIdsRef.current
    draggingIdsRef.current = []
    if (!ids.length) return
    const target = folders.find((f) => f.id === folderId)
    const r = await api.mails.moveMany(ids, folderId)
    if (r.affected === 0) {
      notify(r.errors[0] ?? '没有邮件被移动')
      return
    }
    setSelectedIds(new Set())
    setSelectedMailId(null)
    setDetail(null)
    await refreshAfterFolderOp(`已移动 ${r.affected} 封邮件到「${target?.name ?? '目标文件夹'}」`)
  }

  /* ─────────────── 键盘快捷键 ─────────────── */

  // 用 ref 持有最新一版的处理器，监听器只注册一次 —— 既避免频繁解绑重绑，
  // 也避免闭包里读到过期的 mails / selectedIds。
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {})

  const onKeyDown = (e: KeyboardEvent): void => {
    const el = e.target as HTMLElement | null
    const inField =
      !!el &&
      (el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        el.tagName === 'SELECT' ||
        el.isContentEditable)

    const overlayOpen =
      accountDialog.open ||
      settingsOpen ||
      archiveDialog.open ||
      rulesOpen ||
      composer !== null ||
      folderDialog !== null ||
      folderDelete !== null

    const action = actionForEvent(e, shortcuts)
    if (!action) return

    const def = SHORTCUT_ACTIONS.find((a) => a.id === action)

    // Esc 要特殊处理：它同时承担「退出输入框」「清空搜索」「收回多选」三件事
    if (action === 'clearSelection') {
      if (inField) {
        ;(el as HTMLInputElement).blur()
        // 在搜索框里按 Esc：清掉这一处输入；如果整体已经没有任何条件了，
        // 顺手把面板也收起来，免得留一个空面板占地方。
        if (hasAnyCriteria(criteria)) {
          clearSearch()
        } else {
          setSearchPanelOpen(false)
        }
        return
      }
      if (selectedIds.size > 1) {
        setSelectedIds(selectedMailId !== null ? new Set([selectedMailId]) : new Set())
        setAnchorId(selectedMailId)
      }
      return
    }

    // 弹窗开着时只放行「跳到搜索框」，避免在写信界面里误触发列表操作
    if (overlayOpen && action !== 'search') return
    // 输入框里只放行标记了 allowInInput 的动作（写邮件、回复、搜索这些组合键）
    if (inField && !def?.allowInInput) return

    switch (action) {
      case 'newMail':
        e.preventDefault()
        openComposerNew()
        return
      case 'reply':
        if (!detail) return
        e.preventDefault()
        reply(detail, 'reply')
        return
      case 'replyAll':
        if (!detail) return
        e.preventDefault()
        reply(detail, 'replyAll')
        return
      case 'forward':
        if (!detail) return
        e.preventDefault()
        reply(detail, 'forward')
        return
      case 'search':
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      case 'sync':
        e.preventDefault()
        syncAll()
        return
      case 'openWindow':
        if (!selectedMailId) return
        e.preventDefault()
        void api.mails.openWindow(selectedMailId)
        return

      case 'nextMail':
        e.preventDefault()
        moveActive(1, false)
        return
      case 'prevMail':
        e.preventDefault()
        moveActive(-1, false)
        return
      case 'extendNext':
        e.preventDefault()
        moveActive(1, true)
        return
      case 'extendPrev':
        e.preventDefault()
        moveActive(-1, true)
        return
      case 'toFirst':
        e.preventDefault()
        moveActive(-mails.length, false)
        return
      case 'toLast':
        e.preventDefault()
        moveActive(mails.length, false)
        return
      case 'pageDown':
        e.preventDefault()
        moveActive(20, false)
        return
      case 'pageUp':
        e.preventDefault()
        moveActive(-20, false)
        return
      case 'selectAll':
        e.preventDefault()
        selectAll(true)
        return

      case 'delete':
        e.preventDefault()
        void deleteSelection(false)
        return
      case 'deletePermanent':
        e.preventDefault()
        void deleteSelection(true)
        return
      case 'toggleRead':
        void toggleReadSelection()
        return
      case 'toggleFlag':
        void toggleFlagSelection()
        return
      default:
        return
    }
  }

  keyHandlerRef.current = onKeyDown

  useEffect(() => {
    const listener = (e: KeyboardEvent): void => keyHandlerRef.current(e)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  const showWelcome = accounts.length === 0

  return (
    <div className="app">
      {/* ───────────── 工具栏 ───────────── */}
      <div className="toolbar">
        <button className="tbtn primary" onClick={openComposerNew} title="写邮件（Ctrl+N）">
          <Icon name="compose" size={15} /><span className="tlabel">写邮件</span>
        </button>
        <button className="tbtn" disabled={!detail} onClick={() => detail && reply(detail, 'reply')} title="回复（Ctrl+R）">
          <Icon name="reply" size={15} /><span className="tlabel">回复</span>
        </button>
        <button className="tbtn" disabled={!detail} onClick={() => detail && reply(detail, 'replyAll')} title="回复全部（Ctrl+Shift+R）">
          <Icon name="replyAll" size={15} /><span className="tlabel">回复全部</span>
        </button>
        <button className="tbtn" disabled={!detail} onClick={() => detail && reply(detail, 'forward')} title="转发（Ctrl+L）">
          <Icon name="forward" size={15} /><span className="tlabel">转发</span>
        </button>
        <button
          className="tbtn"
          disabled={selectedIds.size === 0 && !detail}
          onClick={() => void deleteSelection(false)}
          title="移到垃圾箱（Delete）"
        >
          <Icon name="trash" size={15} /><span className="tlabel">删除{selectedIds.size > 1 ? `（${selectedIds.size}）` : ''}</span>
        </button>
        <button
          className="tbtn danger"
          disabled={selectedIds.size === 0 && !detail}
          onClick={() => void deleteSelection(true)}
          title="永久删除，本机不可恢复（Shift+Delete）"
        >
          <Icon name="deleteForever" size={15} /><span className="tlabel">永久删除</span>
        </button>

        <span style={{ width: 8 }} />

        <button className="tbtn" onClick={syncAll} title="同步全部账户（F5）">
          <Icon name="sync" size={15} /><span className="tlabel">同步</span>
        </button>
        <button
          className="tbtn"
          onClick={() => setArchiveDialog({ open: true, mode: 'import' })}
          title="导入 Foxmail 存档（.fox / .box+.ind / 数据目录）"
        >
          <Icon name="import" size={15} /><span className="tlabel">导入存档</span>
        </button>
        <button
          className="tbtn"
          onClick={() => setArchiveDialog({ open: true, mode: 'export' })}
          title="导出为 .fox / .box+.ind / .eml / .mbox"
        >
          <Icon name="export" size={15} /><span className="tlabel">导出存档</span>
        </button>
        <button
          className="tbtn"
          onClick={() => setRulesOpen(true)}
          title="自动归类 / 自动删除规则"
        >
          <Icon name="rules" size={15} /><span className="tlabel">规则</span>
        </button>
        <button
          className="tbtn"
          onClick={cycleTheme}
          title={
            settings.theme === 'light'
              ? '当前：浅色主题（点击切换为深色）'
              : settings.theme === 'dark'
                ? '当前：深色主题（点击切换为跟随系统）'
                : '当前：跟随系统（点击切换为浅色）'
          }
        >
          <Icon
            name={settings.theme === 'light' ? 'sun' : settings.theme === 'dark' ? 'moon' : 'autoTheme'}
            size={15}
          />
          <span className="tlabel">主题</span>
        </button>
        <button className="tbtn" onClick={() => setSettingsOpen(true)} title="设置与快捷键">
          <Icon name="settings" size={15} /><span className="tlabel">设置</span>
        </button>

        <span className="spacer" />

        <div className="searchbox">
          <span className="mag"><Icon name="search" size={13} /></span>
          <input
            ref={searchRef}
            value={searchInput}
            placeholder="搜索邮件（全部字段）　Ctrl+F"
            onChange={(e) => setSearchInput(e.target.value)}
          />
          {searchInput && (
            <button className="clear" onClick={() => setSearchInput('')} title="清空">
              <Icon name="close" size={11} />
            </button>
          )}
        </div>
        {/* 展开/收起「按字段搜索」面板。带条件数角标，收起来也知道有几条限制在生效 */}
        <button
          className={`tbtn searchtoggle${searchPanelOpen ? ' on' : ''}`}
          onClick={() => setSearchPanelOpen((v) => !v)}
          title={searchPanelOpen ? '收起按字段搜索' : '按字段搜索：发件人 / 收件人 / 主题 / 正文，可同时满足多个条件'}
        >
          <Icon name="filter" size={15} />
          <span className="tlabel">字段</span>
          {activeCount > 0 && <span className="badge">{activeCount}</span>}
        </button>
      </div>

      {/* 按字段搜索：所有字段并列，留空即不限制，多个条件同时满足（AND） */}
      {searchPanelOpen && (
        <div className="searchpanel">
          {SEARCH_CRITERIA_FIELDS.filter((f) => f.key !== 'all').map((f) => (
            <label key={f.key} className="searchfield">
              <span className="flabel">{f.label}</span>
              <input
                value={searchFields[f.key] ?? ''}
                placeholder={f.placeholder}
                onChange={(e) =>
                  setSearchFields((prev) => ({ ...prev, [f.key]: e.target.value }))
                }
              />
            </label>
          ))}
          <span className="searchpanelhint">
            {activeCount > 1 ? `${activeCount} 个条件同时满足` : '留空即不限定'}
          </span>
          {activeCount > 0 && (
            <button className="btn small" onClick={clearSearch}>
              清空条件
            </button>
          )}
        </div>
      )}

      {syncProgress && (
        <div className="syncbar">
          <span className="busy dark" />
          <span>{syncProgress.message}</span>
          {syncProgress.total > 0 && (
            <span>
              （{syncProgress.current}/{syncProgress.total}）
            </span>
          )}
          {syncProgress.error && <span style={{ color: 'var(--danger)' }}>{syncProgress.error}</span>}
        </div>
      )}

      {/* ───────────── 主体 ───────────── */}
      <div className="body">
        {!showWelcome && (
          <Sidebar
            accounts={accounts}
            folders={folders}
            selectedFolderId={selectedFolderId}
            collapsed={collapsed}
            onToggleCollapse={(id) =>
              setCollapsed((prev) => {
                const next = new Set(prev)
                if (next.has(id)) next.delete(id)
                else next.add(id)
                return next
              })
            }
            onSelectFolder={(f) => {
              setSelectedFolderId(f.id)
              setSelectedMailId(null)
              setSelectedIds(new Set())
              setAnchorId(null)
              clearSearch()
            }}
            onAddAccount={() => setAccountDialog({ open: true, account: null })}
            onEditAccount={(a) => setAccountDialog({ open: true, account: a })}
            onSync={(id) => {
              const target = accounts.find((a) => a.id === id)
              if (target && !target.password) {
                notify('这个账户还没有填写密码/授权码，请在「设置」里补上')
                return
              }
              void api.sync.start(id)
              notify('已开始同步')
            }}
            onImportArchive={(accountId) =>
              setArchiveDialog({ open: true, mode: 'import', accountId })
            }
            onExportArchive={(accountId) =>
              setArchiveDialog({ open: true, mode: 'export', accountId })
            }
            onFolderContextMenu={(f, e) => void handleFolderContextMenu(f, e)}
            onDropMails={(folderId) => void handleDropMails(folderId)}
            onCreateFolder={(accountId, parentId) =>
              setFolderDialog({
                mode: 'create',
                title: parentId ? '新建子文件夹' : '新建文件夹',
                accountId,
                parentId,
                defaultValue: ''
              })
            }
            stats={statsText}
            version={appVersion}
          />
        )}

        <div className="main" id="main-column">
          {showWelcome ? (
            <div className="empty" style={{ flex: 1 }}>
              <div className="big">
                <Icon name="mailbox" size={48} />
              </div>
              <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>
                欢迎使用 SimpleMail
              </div>
              <div style={{ maxWidth: 520, textAlign: 'center', lineHeight: 1.8 }}>
                所有邮件都永久保存在这台电脑上，断网也能查看。
                <br />
                你可以添加邮箱账户在线收发，也可以直接导入以前的 Foxmail 存档。
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                <button className="btn primary" onClick={() => setAccountDialog({ open: true, account: null })}>
                  添加邮箱账户
                </button>
                <button
                  className="btn"
                  onClick={() => setArchiveDialog({ open: true, mode: 'import' })}
                >
                  导入 Foxmail 存档
                </button>
              </div>
            </div>
          ) : (
            <>
              <div
                className="listwrap"
                style={{ height: `${splitPct}%`, flex: '0 0 auto' }}
              >
                <MailList
                  title={
                    searching
                      ? `搜索 ${describeCriteria(criteria)}`
                      : currentFolder
                        ? `${currentFolder.name}`
                        : '全部邮件'
                  }
                  mails={mails}
                  total={total}
                  selectedIds={selectedIds}
                  activeId={selectedMailId}
                  loading={listLoading}
                  searchTerms={searchTerms}
                  showAccount={searching}
                  orderBy={orderBy}
                  orderDir={orderDir}
                  onChangeOrder={(by, dir) => {
                    setOrderBy(by)
                    setOrderDir(dir)
                  }}
                  isSearching={searching}
                  onRowClick={handleRowClick}
                  onRowDoubleClick={handleRowDoubleClick}
                  onRowContextMenu={(m, e) => void handleRowContextMenu(m, e)}
                  onRowDragStart={(m) => {
                    // 拖的是选中的某一封就整批拖，否则只拖这一封
                    draggingIdsRef.current = selectedIds.has(m.id)
                      ? [...selectedIds]
                      : [m.id]
                  }}
                  onToggle={(m) => selectToggle(m.id)}
                  onSelectAll={selectAll}
                  onLoadMore={() => {
                    if (mails.length < total && !listLoading) {
                      void loadMails(offsetRef.current + settings.pageSize, false)
                    }
                  }}
                />
              </div>

              <div
                className="splitter"
                onMouseDown={() => {
                  dragging.current = true
                  document.body.style.cursor = 'row-resize'
                }}
                title="拖动调整列表与预览的比例"
              />

              <MailView
                mail={detail}
                allowRemoteImages={allowRemoteImages}
                onToggleRemote={() => setAllowRemoteImages((v) => !v)}
                onReply={(m) => reply(m, 'reply')}
                onReplyAll={(m) => reply(m, 'replyAll')}
                onForward={(m) => reply(m, 'forward')}
                onOpenAttachment={(id) => void api.attachments.open(id)}
                onSaveAttachment={async (id) => {
                  const r = await api.attachments.saveAs(id)
                  if (r.ok) notify(`已保存到 ${r.path}`)
                  else if (!r.canceled) notify(r.error ?? '保存失败')
                }}
                onRevealAttachment={(id) => void api.attachments.reveal(id)}
                onToggleFlag={(m) => void toggleFlag(m)}
              />
            </>
          )}
        </div>
      </div>

      {/* ───────────── 弹窗 ───────────── */}

      {accountDialog.open && (
        <AccountDialog
          account={accountDialog.account}
          onClose={() => setAccountDialog({ open: false, account: null })}
          onSaved={async (msg) => {
            notify(msg)
            await refreshAccountsAndFolders()
            const accs = await api.accounts.list()
            const target = accs.find((a) => !a.isLocal && a.syncEnabled)
            if (target) void api.sync.start(target.id)
          }}
          onError={notify}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          accounts={accounts}
          settings={settings}
          onSettingsChange={(s) => {
            setSettings(s)
            setAllowRemoteImages(s.allowRemoteImages)
          }}
          onClose={() => setSettingsOpen(false)}
          onDone={notify}
          onError={notify}
        />
      )}

      {archiveDialog.open && (
        <ArchiveDialog
          accounts={accounts}
          folders={folders}
          initialMode={archiveDialog.mode}
          initialAccountId={archiveDialog.accountId}
          defaultArchiveTag={settings.defaultArchiveTag}
          onClose={() => setArchiveDialog({ open: false, mode: 'import' })}
          onDone={async (msg) => {
            notify(msg)
            await refreshAccountsAndFolders()
            const folds = await api.folders.list()
            if (!selectedFolderId && folds.length) {
              const inbox = folds.find((f) => f.role === 'inbox') ?? folds[0]
              setSelectedFolderId(inbox.id)
            } else {
              void loadMails(0, true)
            }
          }}
          onError={notify}
        />
      )}

      {rulesOpen && (
        <RulesDialog
          accounts={accounts}
          folders={folders}
          onClose={() => setRulesOpen(false)}
          onDone={notify}
          onError={notify}
          onChanged={async () => {
            await refreshAccountsAndFolders()
            void loadMails(0, true)
          }}
        />
      )}

      {composer && (
        <Composer
          accounts={accounts}
          init={composer}
          onClose={() => setComposer(null)}
          onSent={(msg) => {
            notify(msg)
            void refreshAccountsAndFolders()
            void loadMails(0, true)
          }}
          onError={notify}
        />
      )}

      {folderDialog && (
        <InputDialog
          title={folderDialog.title}
          label="文件夹名称"
          defaultValue={folderDialog.defaultValue}
          placeholder="例如：客户 / 2015 年"
          hint={
            folderDialog.mode === 'create'
              ? '新建的文件夹会出现在左侧；IMAP 账户会同时在服务器上创建，手机端也能看到。'
              : '重命名后路径会一起更新，下次同步不会变成两个文件夹。'
          }
          confirmText={folderDialog.mode === 'create' ? '创建' : '重命名'}
          onConfirm={(value) =>
            void (folderDialog.mode === 'create' ? doCreateFolder(value) : doRenameFolder(value))
          }
          onCancel={() => setFolderDialog(null)}
        />
      )}

      {folderDelete && (
        <ChoiceDialog
          title={`删除文件夹「${folderDelete.folder.name}」`}
          message={
            folderDelete.mailCount > 0 ? (
              <>
                这个文件夹里有 <b>{folderDelete.mailCount}</b> 封邮件，请选择怎么处理它们：
                <br />
                <br />
                · <b>移到垃圾箱</b>：邮件保留在本机垃圾箱里，可以随时找回（推荐）
                <br />
                · <b>连同邮件永久删除</b>：本机数据库记录与附件文件一并清掉，无法恢复
                <br />
                <br />
                IMAP 账户会同时在服务器上删除这个文件夹。
              </>
            ) : (
              <>这个文件夹是空的，删除后无法恢复。IMAP 账户会同时在服务器上删除它。</>
            )
          }
          choices={[
            ...(folderDelete.mailCount > 0
              ? [
                  { label: '移到垃圾箱并删除文件夹', value: 'trash', kind: 'primary' as const },
                  { label: '连同邮件永久删除', value: 'delete', kind: 'danger' as const }
                ]
              : [{ label: '删除文件夹', value: 'trash', kind: 'danger' as const }])
          ]}
          onChoose={(value) => void doDeleteFolder(value === 'delete' ? 'delete' : 'trash')}
          onCancel={() => setFolderDelete(null)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
