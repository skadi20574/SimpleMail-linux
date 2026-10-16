/**
 * SimpleMail 共享类型定义
 * 主进程 / preload / 渲染进程三端共用；只包含可结构化克隆的纯数据。
 */

import type { SearchField, SearchCriteria } from './search-terms'
import type { MailtoRequest } from './mailto'

export type { SearchField, SearchCriteria, MailtoRequest }

export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'custom'

export type MailSource = 'imap' | 'pop3' | 'foxmail' | 'local'

/**
 * 收件协议。
 *
 * IMAP 与 POP3 是两套完全不同的模型，程序里到处都要区分：
 *   · IMAP：有服务器文件夹树、UID、已读/星标状态，可增量同步、可回写服务器；
 *   · POP3：**只有收件箱**，没有文件夹、没有已读状态，靠 UIDL 做增量。
 * 因此 POP3 账户的「已发送 / 草稿箱 / 垃圾箱」都是**纯本地文件夹**，
 * 发信仍然走 SMTP。
 */
export type MailProtocol = 'imap' | 'pop3'

export interface Account {
  id: number
  email: string
  displayName: string
  /** 收件协议：imap 或 pop3 */
  protocol: MailProtocol
  imapHost: string
  imapPort: number
  imapSecure: boolean
  /** POP3 收件服务器（protocol === 'pop3' 时生效） */
  pop3Host: string
  pop3Port: number
  pop3Secure: boolean
  /** 下载成功后是否从服务器删除。默认 false —— 保留副本更安全。 */
  pop3DeleteAfterFetch: boolean
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  username: string
  /** 授权码 / 密码。仅存放在本地 userData 目录，绝不上传。 */
  password: string
  signature: string
  color: string
  syncEnabled: boolean
  createdAt: number
  lastSyncAt: number | null
  /** 该账户是否为「本地存档账户」（仅承载 Foxmail 导入的邮件，无服务器） */
  isLocal: boolean
}

export type AccountDraft = Omit<Account, 'id' | 'createdAt' | 'lastSyncAt'> & {
  id?: number
}

export interface Folder {
  id: number
  accountId: number
  name: string
  /** IMAP 路径；本地文件夹则为内部键 */
  path: string
  role: FolderRole
  /** 层级分隔符（IMAP 通常 '/'，个别服务器是 '.'）。新建子文件夹时用它拼路径 */
  delimiter: string
  unread: number
  total: number
}

export interface AttachmentMeta {
  id: number
  mailId: number
  filename: string
  contentType: string
  size: number
  contentId: string | null
  isInline: boolean
  /** 附件在应用数据目录中的绝对路径；未落盘时为 null */
  storedPath: string | null
}

export interface MailSummary {
  id: number
  accountId: number
  folderId: number
  uid: number | null
  messageId: string | null
  subject: string
  fromName: string
  fromAddr: string
  toText: string
  date: number
  snippet: string
  unread: boolean
  flagged: boolean
  hasAttachments: boolean
  size: number
  source: MailSource
  archiveTag: string | null
  folderName?: string
  accountEmail?: string
}

export interface MailDetail extends MailSummary {
  ccText: string
  bccText: string
  replyTo: string
  bodyText: string
  bodyHtml: string | null
  rawHeaders: string
  inReplyTo: string | null
  references: string | null
  attachments: AttachmentMeta[]
}

export interface MailListQuery {
  folderId?: number
  accountId?: number
  /** 全库搜索关键字 */
  search?: string
  /** 搜索范围：全部字段 / 发件人 / 收件人 / 主题 / 正文 */
  searchField?: SearchField
  /**
   * 多字段并列搜索条件：每个字段各自一个关键字，留空即不限制，
   * 多个非空字段之间是 AND。给了这个就以它为准，忽略上面的 search/searchField。
   */
  searchCriteria?: SearchCriteria
  limit?: number
  offset?: number
  /** relevance = 按匹配度（bm25）排序，搜索时默认用它 */
  orderBy?: 'relevance' | 'date' | 'subject' | 'from'
  orderDir?: 'asc' | 'desc'
  unreadOnly?: boolean
  flaggedOnly?: boolean
  hasAttachments?: boolean
  /** 只搜索某一个账户（搜索模式下有效） */
  searchAccountId?: number
}

export interface MailListResult {
  total: number
  items: MailSummary[]
}

export interface ComposePayload {
  accountId: number
  /** 编辑已有草稿时传入 */
  draftId?: number
  to: string
  cc: string
  bcc: string
  subject: string
  text: string
  /** 正文以 HTML 形式保存（富文本编辑器） */
  html?: string | null
  inReplyTo?: string | null
  references?: string | null
  attachments: ComposeAttachment[]
  /** true = 仅保存草稿 */
  saveAsDraft?: boolean
}

export interface ComposeAttachment {
  /** 已存在于附件目录中的文件路径 */
  path: string
  filename: string
  contentType?: string
}

export interface SendResult {
  ok: boolean
  error?: string
  /** 发送成功后落库的「已发送」邮件 id */
  mailId?: number
}

export interface SyncProgress {
  accountId: number
  phase: 'connecting' | 'folders' | 'headers' | 'bodies' | 'idle' | 'error' | 'done'
  folderName?: string
  current: number
  total: number
  message: string
  error?: string
}

export interface SyncStatus {
  running: boolean
  accountId: number | null
  lastProgress: SyncProgress | null
}

/* ─────────────────────────── Foxmail 存档 ─────────────────────────── */

export type ArchiveKind =
  | 'foxmail-fox'      // Foxmail 7.2 单文件存档 .fox
  | 'foxmail-boxind'   // 老版 Foxmail mail/<账户>/*.box + *.ind
  | 'foxmail-storage'  // Foxmail 7.2 数据目录 Storage/ + FMStorage.list
  | 'zip'              // 压缩包（内含以上任意结构）
  | 'mbox'             // 标准 mbox
  | 'eml-tree'         // 目录/压缩包里的 .eml 集合
  | 'opaque'           // 无法识别容器，但可能是邮件数据的二进制
  | 'unknown'

export interface ArchiveDetection {
  kind: ArchiveKind
  /** 用于展示的说明 */
  detail: string
  /** 识别到的存储单元（每个对应一个邮件文件夹） */
  units: ArchiveUnit[]
  warnings: string[]
}

export interface ArchiveUnit {
  /** 文件夹显示名，如「收件箱」 */
  name: string
  role: FolderRole
  /** 单元来源（文件路径或容器内条目） */
  origin: string
  /** 预估邮件数量（-1 表示未知） */
  estimatedCount: number
}

export interface ImportOptions {
  /** 存档路径（文件或目录） */
  sourcePath: string
  /** 导入到哪个账户；为空表示新建一个「本地存档」账户 */
  targetAccountId?: number
  /** 存档批次标签，便于之后按年份检索 */
  archiveTag?: string
  /** 只导入指定单元（按 name 匹配）；为空表示全部 */
  includeUnits?: string[]
}

export interface ImportProgress {
  phase: 'detecting' | 'scanning' | 'parsing' | 'storing' | 'indexing' | 'done' | 'error'
  current: number
  total: number
  message: string
  imported: number
  skipped: number
  failed: number
  error?: string
}

export interface ImportResult {
  ok: boolean
  detection: ArchiveDetection
  imported: number
  skipped: number
  failed: number
  accountId: number
  errors: string[]
}

export type ExportFormat = 'fox' | 'boxind' | 'eml' | 'mbox'

export interface ExportOptions {
  accountId: number
  folderIds: number[]
  /** 输出目录 */
  outDir: string
  /** 存档文件名（不含扩展名） */
  baseName: string
  formats: ExportFormat[]
}

export interface ExportProgress {
  phase: 'collecting' | 'writing' | 'done' | 'error'
  current: number
  total: number
  message: string
  error?: string
}

export interface ExportResult {
  ok: boolean
  files: string[]
  exported: number
  errors: string[]
}

/** 对存档做「体检」，不导入，只报告结构，便于把报告发回来定位格式 */
export interface ArchiveInspection {
  path: string
  size: number
  kind: ArchiveKind
  detail: string
  /** 文件头 64 字节的十六进制 */
  headHex: string
  headAscii: string
  units: ArchiveUnit[]
  /** 每个单元实际扫描到的报文数（-1 表示未扫描） */
  scanned: { name: string; origin: string; messages: number; strategy: string }[]
  warnings: string[]
}

/* ─────────────────────────── 自动归类规则 ─────────────────────────── */

/**
 * 规则可匹配的字段。
 * `header` 用来匹配任意邮件头：值写成 `X-Mailer: PHPMailer` 这样，
 * 于是「自定义字段」也能作为归类依据（比如 `List-Id`、`X-Spam-Flag`）。
 */
export type RuleField =
  | 'from'
  | 'fromName'
  | 'to'
  | 'cc'
  | 'subject'
  | 'body'
  | 'header'
  | 'any'

/** 匹配方式 */
export type RuleOperator =
  | 'contains'
  | 'notContains'
  | 'equals'
  | 'startsWith'
  | 'endsWith'
  | 'regex'

/** 命中后执行的动作 */
export type RuleAction =
  | 'trash'
  | 'delete'
  | 'move'
  | 'mark_read'
  | 'flag'
  | 'mark_read_move'

export interface RuleCondition {
  field: RuleField
  op: RuleOperator
  value: string
}

export interface Rule {
  id: number
  name: string
  enabled: boolean
  /** 数值小的先执行 */
  priority: number
  /** null = 对所有账户生效 */
  accountId: number | null
  /** all = 全部条件满足，any = 满足任一 */
  matchMode: 'all' | 'any'
  conditions: RuleCondition[]
  action: RuleAction
  /** action 为 move / mark_read_move 时的目标文件夹 */
  actionFolderId: number | null
  /** 命中后是否停止匹配后续规则 */
  stop: boolean
  createdAt: number
}

export type RuleDraft = Omit<Rule, 'id' | 'createdAt'> & { id?: number }

export interface RulePreviewItem {
  mailId: number
  subject: string
  fromAddr: string
  date: number
  /** 命中的是哪些条件 */
  matchedConditions: string[]
}

export interface RulePreview {
  /** 命中封数 */
  matched: number
  /** 未应用任何动作，只是预览 */
  samples: RulePreviewItem[]
  error?: string
}

/* ─────────────────────────── 设置 ─────────────────────────── */

export type ThemeMode = 'light' | 'dark' | 'system'

export interface AppSettings {
  /** 邮件列表与正文的宽度比例（左栏占主区域的多少） */
  splitRatio: number
  /** 最左侧文件夹栏的宽度（像素） */
  sidebarWidth: number
  /** 每页加载数量 */
  pageSize: number
  /** 同步时每个文件夹一次抓取的头部数量 */
  syncBatch: number
  /** 正文自动下载（后台补齐） */
  autoDownloadBodies: boolean
  /** 允许外部图片（HTML 邮件里的远程图片） */
  allowRemoteImages: boolean
  /** 界面主题：浅色 / 深色 / 跟随系统 */
  theme: ThemeMode
  /**
   * 自定义快捷键：动作 id → 绑定字符串（如 'Ctrl+N'）。
   * 只存用户改过的项，未出现的动作走 shared/shortcuts.ts 里的默认值，
   * 这样以后新增动作时老用户的设置不会缺项。
   */
  shortcuts: Record<string, string>
  /** 启动时是否自动同步 */
  autoSyncOnStart: boolean
  /** 是否按下面的间隔自动收取新邮件 */
  autoSyncEnabled: boolean
  /** 自动收取的间隔（分钟） */
  syncIntervalMinutes: number
  /** 从 Foxmail 导入时默认的批次标签前缀 */
  defaultArchiveTag: string
  /**
   * 打开邮件后自动标记为已读。
   * 关掉之后需要自己用右键菜单或 M 键改状态。
   */
  autoMarkRead: boolean
}

export interface AppPaths {
  userData: string
  database: string
  attachments: string
  exports: string
  logs: string
  version: string
  platform: string
}

/* ─────────────── 系统邮件程序（mailto: 处理程序） ─────────────── */

export type InstallKind = 'deb' | 'appimage' | 'portable' | 'unknown'

export interface MailtoStatus {
  installKind: InstallKind
  /** 实际生效的 desktop 文件路径 */
  desktopFile: string
  /** 是不是包管理器安装的（deb），这种不用我们写文件 */
  systemWide: boolean
  desktopFileExists: boolean
  /** 该 desktop 文件里有没有声明 x-scheme-handler/mailto */
  declaresMailto: boolean
  /** 系统当前的默认邮件程序，例如 firefox.desktop */
  currentDefault: string
  isDefault: boolean
  xdgAvailable: boolean
  canSetAutomatically: boolean
  /** 界面上展示给用户复制的手动命令 */
  manualCommand: string
  /** 免安装形态回退用的用户级 desktop 文件路径 */
  userDesktopFile: string
}

export interface MailtoSetResult {
  ok: boolean
  message: string
  status: MailtoStatus
}

/**
 * 投递给渲染进程的一条 mailto 请求。
 * id 用于去重：推送和「挂载时主动拉取」可能把同一条送两次。
 */
export interface MailtoDelivery {
  id: number
  request: MailtoRequest
  /** 已经校验过存在性的附件（右键文件 →「邮件发送」带过来的） */
  attachments: ResolvedAttachment[]
  /** 想附但找不到、或不是普通文件的路径 —— 必须明确告诉用户，不能默默丢掉 */
  missingAttachments: string[]
}

/** 主进程校验过、可以直接放进写信窗口的附件 */
export interface ResolvedAttachment {
  path: string
  filename: string
  size: number
}

/* ─────────────── 数据目录位置与迁移 ─────────────── */

export interface DataDirInfo {
  /** 当前实际使用的数据目录 */
  dataDir: string
  /** Electron 的默认数据目录（指针文件就放在这里） */
  defaultDataDir: string
  /** 是否已经用了自定义目录 */
  custom: boolean
  /** 指针文件路径（界面上展示，便于用户知道它不会被迁移走） */
  pointerFile: string
  /** 数据库当前占多少字节 */
  dbBytes: number
}

export interface DataDirProgress {
  phase: 'copy' | 'verify' | 'switch' | 'done'
  message: string
  current: number
  total: number
}

export interface DataDirMigrationResult {
  ok: boolean
  error?: string
  /** 迁移后的数据目录 */
  dataDir?: string
  /** 迁移前的数据目录（用于「删除旧数据」） */
  from?: string
}
