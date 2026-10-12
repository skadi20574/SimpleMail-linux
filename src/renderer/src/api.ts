/** 渲染进程对 preload 暴露的 API 的类型化包装 */

import type {
  Account,
  AccountDraft,
  AppPaths,
  AppSettings,
  ArchiveDetection,
  ArchiveInspection,
  ComposeAttachment,
  ComposePayload,
  ExportFormat,
  ExportOptions,
  ExportProgress,
  ExportResult,
  Folder,
  FolderRole,
  ImportOptions,
  ImportProgress,
  ImportResult,
  MailDetail,
  MailListQuery,
  MailListResult,
  SearchField,
  SearchCriteria,
  Rule,
  RuleDraft,
  RulePreview,
  SyncProgress
} from '@shared/types'

export interface FolderOpResult extends BatchOutcome {
  folderId?: number
  serverSynced?: boolean
}

export interface BatchOutcome {
  affected: number
  filesRemoved: number
  skipped: number
  errors: string[]
}

interface RawApi {
  accounts: {
    list(): Promise<Account[]>
    save(draft: AccountDraft): Promise<Account>
    /** 按 draft.protocol 测对应的收件通道，发信统一测 SMTP */
    test(draft: AccountDraft): Promise<{
      receive: { ok: boolean; error?: string }
      smtp: { ok: boolean; error?: string }
    }>
    remove(id: number): Promise<{ ok: boolean }>
  }
  folders: {
    list(accountId?: number): Promise<Folder[]>
    create(accountId: number, name: string, parentId?: number | null): Promise<FolderOpResult>
    rename(id: number, name: string): Promise<FolderOpResult>
    remove(id: number, mailMode: 'trash' | 'delete'): Promise<FolderOpResult>
    info(id: number): Promise<(Folder & { mailCount: number }) | null>
    /** 弹出原生右键菜单，返回用户选择的动作 */
    contextMenu(folderId: number): Promise<{ action: string } | null>
  }
  mails: {
    list(query: MailListQuery): Promise<MailListResult>
    get(id: number): Promise<MailDetail | undefined>
    markRead(id: number, unread: boolean): Promise<{ ok: boolean }>
    markFlagged(id: number, flagged: boolean): Promise<{ ok: boolean }>
    markFolderRead(folderId: number): Promise<{ ok: boolean }>
    move(id: number, folderId: number): Promise<{ ok: boolean }>
    /** 批量：permanent=true 为永久删除（Shift+Delete），否则移到垃圾箱 */
    deleteMany(ids: number[], permanent: boolean): Promise<BatchOutcome>
    markManyRead(ids: number[], unread: boolean): Promise<BatchOutcome>
    markManyFlagged(ids: number[], flagged: boolean): Promise<BatchOutcome>
    moveMany(ids: number[], folderId: number): Promise<BatchOutcome>
    openWindow(mailId: number): Promise<{ ok: boolean }>
    contextMenu(payload: {
      mailIds: number[]
      activeMailId: number
      allRead: boolean | null
      allFlagged: boolean | null
      folders: { id: number; name: string; accountId: number }[]
      currentFolderId: number | null
    }): Promise<{ action: string; folderId?: number } | null>
    remove(id: number): Promise<{ ok: boolean }>
    send(payload: ComposePayload): Promise<{ ok: boolean; error?: string; mailId?: number }>
    saveDraft(payload: ComposePayload): Promise<{ ok: boolean; error?: string; mailId?: number }>
  }
  attachments: {
    saveAs(id: number): Promise<{ ok: boolean; path?: string; error?: string; canceled?: boolean }>
    open(id: number): Promise<{ ok: boolean; error?: string }>
    reveal(id: number): Promise<{ ok: boolean }>
    pick(): Promise<(ComposeAttachment & { size: number })[]>
  }
  sync: {
    start(accountId: number): Promise<{ ok: boolean; error?: string; already?: boolean }>
    abort(accountId: number): Promise<{ ok: boolean }>
    status(): Promise<{ running: boolean; accountId: number | null; lastProgress: SyncProgress | null }>
    onProgress(cb: (p: SyncProgress) => void): () => void
    onFinished(cb: (p: { accountId: number; aborted: boolean }) => void): () => void
  }
  foxmail: {
    detect(path: string): Promise<ArchiveDetection>
    inspect(path: string, scan?: boolean): Promise<ArchiveInspection>
    import(options: ImportOptions): Promise<ImportResult>
    export(options: ExportOptions): Promise<ExportResult>
    onImportProgress(cb: (p: ImportProgress) => void): () => void
    onExportProgress(cb: (p: ExportProgress) => void): () => void
  }
  rules: {
    list(accountId?: number): Promise<Rule[]>
    save(draft: RuleDraft): Promise<Rule>
    remove(id: number): Promise<{ ok: boolean }>
    setEnabled(id: number, enabled: boolean): Promise<{ ok: boolean }>
    /** 试运行：只统计匹配结果，不执行任何动作 */
    preview(draft: RuleDraft, limit?: number): Promise<RulePreview>
    /** 对现有邮件重新套用全部规则 */
    runAll(accountId?: number): Promise<{ scanned: number; acted: number }>
  }
  archives: {
    list(accountId?: number): Promise<
      {
        id: number
        accountId: number
        tag: string
        sourcePath: string
        kind: string
        imported: number
        skipped: number
        failed: number
        createdAt: number
      }[]
    >
    remove(id: number): Promise<{ ok: boolean }>
  }
  settings: {
    get(): Promise<AppSettings>
    set(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  app: {
    paths(): Promise<AppPaths>
    stats(): Promise<{
      mails: number
      accounts: number
      attachmentBytes: number
      attachmentCount: number
      dbBytes: number
      version: string
    }>
    openPath(path: string): Promise<{ ok: boolean; error?: string }>
    pickDirectory(title?: string): Promise<string | null>
    pickArchive(): Promise<string | null>
    pickFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>
    openExternal(url: string): Promise<{ ok: boolean; error?: string }>
    installInfo(): Promise<{
      kind: 'deb' | 'appimage' | 'portable' | 'unknown'
      appPath: string
      packageName: string
      dataDir: string
      manualCommand: string
      hasPkexec: boolean
    }>
    uninstall(): Promise<{ ok: boolean; error?: string }>
    wipeData(): Promise<{ ok: boolean; error?: string }>
    restart(): Promise<{ ok: boolean; relaunched: boolean }>
  }
}

declare global {
  interface Window {
    api: RawApi
  }
  /** 由 electron.vite.config.ts 在编译期注入的应用版本号 */
  const __APP_VERSION__: string
}

export const api: RawApi = window.api

export type {
  Account,
  AccountDraft,
  AppSettings,
  ArchiveDetection,
  ArchiveInspection,
  ComposeAttachment,
  ComposePayload,
  ExportFormat,
  ExportOptions,
  ExportProgress,
  ExportResult,
  Folder,
  FolderRole,
  ImportOptions,
  ImportProgress,
  ImportResult,
  MailDetail,
  MailListQuery,
  MailListResult,
  MailProtocol,
  MailSummary,
  SearchField,
  SearchCriteria,
  Rule,
  RuleDraft,
  RulePreview,
  RuleCondition,
  RuleField,
  RuleOperator,
  RuleAction,
  AttachmentMeta,
  SyncProgress
} from '@shared/types'
