/**
 * preload：把主进程能力以白名单方式暴露给渲染进程。
 * 渲染进程没有 Node 集成，只能调用这里列出的方法。
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { ExportProgress, ImportProgress, SyncProgress } from '@shared/types'
import type { DataDirProgress, MailtoDelivery } from '@shared/types'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

type IpcListener = (event: Electron.IpcRendererEvent, ...args: unknown[]) => void

const on = <T>(channel: string, listener: (payload: T) => void): (() => void) => {
  const wrapped: IpcListener = (_event, payload) => listener(payload as T)
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const api = {
  accounts: {
    list: () => invoke('accounts:list'),
    save: (draft: unknown) => invoke('accounts:save', draft),
    test: (draft: unknown) => invoke('accounts:test', draft),
    remove: (id: number) => invoke('accounts:delete', id)
  },
  folders: {
    list: (accountId?: number) => invoke('folders:list', accountId),
    create: (accountId: number, name: string, parentId?: number | null) =>
      invoke('folders:create', accountId, name, parentId ?? null),
    rename: (id: number, name: string) => invoke('folders:rename', id, name),
    remove: (id: number, mailMode: 'trash' | 'delete') => invoke('folders:delete', id, mailMode),
    info: (id: number) => invoke('folders:info', id),
    contextMenu: (folderId: number) => invoke('folders:contextMenu', folderId)
  },
  mails: {
    list: (query: unknown) => invoke('mails:list', query),
    get: (id: number) => invoke('mails:get', id),
    markRead: (id: number, unread: boolean) => invoke('mails:markRead', id, unread),
    markFlagged: (id: number, flagged: boolean) => invoke('mails:markFlagged', id, flagged),
    markFolderRead: (folderId: number) => invoke('mails:markFolderRead', folderId),
    move: (id: number, folderId: number) => invoke('mails:move', id, folderId),
    /** 批量：permanent=true 为永久删除（Shift+Delete），否则移到垃圾箱 */
    deleteMany: (ids: number[], permanent: boolean) =>
      invoke('mails:deleteMany', ids, permanent),
    markManyRead: (ids: number[], unread: boolean) => invoke('mails:markManyRead', ids, unread),
    markManyFlagged: (ids: number[], flagged: boolean) =>
      invoke('mails:markManyFlagged', ids, flagged),
    /** 批量移动到指定文件夹 */
    moveMany: (ids: number[], folderId: number) => invoke('mails:moveMany', ids, folderId),
    /** 在新窗口打开一封邮件 */
    openWindow: (mailId: number) => invoke('mails:openWindow', mailId),
    /** 弹出原生右键菜单，返回用户选择的动作 */
    contextMenu: (payload: unknown) => invoke('mails:contextMenu', payload),
    remove: (id: number) => invoke('mails:delete', id),
    send: (payload: unknown) => invoke('mails:send', payload),
    saveDraft: (payload: unknown) => invoke('mails:saveDraft', payload)
  },
  attachments: {
    saveAs: (id: number) => invoke('attachments:saveAs', id),
    open: (id: number) => invoke('attachments:open', id),
    reveal: (id: number) => invoke('attachments:reveal', id),
    pick: () => invoke('attachments:pick')
  },
  sync: {
    start: (accountId: number) => invoke('sync:start', accountId),
    abort: (accountId: number) => invoke('sync:abort', accountId),
    status: () => invoke('sync:status'),
    /** 自动收取的状态（开关、间隔、下次执行时间） */
    autoStatus: () => invoke('sync:autoStatus'),
    onProgress: (cb: (p: SyncProgress) => void) => on('sync:progress', cb),
    onFinished: (cb: (p: { accountId: number; aborted: boolean }) => void) => on('sync:finished', cb)
  },
  foxmail: {
    detect: (path: string) => invoke('foxmail:detect', path),
    inspect: (path: string, scan?: boolean) => invoke('foxmail:inspect', path, scan ?? true),
    import: (options: unknown) => invoke('foxmail:import', options),
    export: (options: unknown) => invoke('foxmail:export', options),
    onImportProgress: (cb: (p: ImportProgress) => void) => on('import:progress', cb),
    onExportProgress: (cb: (p: ExportProgress) => void) => on('export:progress', cb)
  },
  rules: {
    list: (accountId?: number) => invoke('rules:list', accountId),
    save: (draft: unknown) => invoke('rules:save', draft),
    remove: (id: number) => invoke('rules:delete', id),
    setEnabled: (id: number, enabled: boolean) => invoke('rules:setEnabled', id, enabled),
    preview: (draft: unknown, limit?: number) => invoke('rules:preview', draft, limit),
    runAll: (accountId?: number) => invoke('rules:runAll', accountId)
  },
  archives: {
    list: (accountId?: number) => invoke('archives:list', accountId),
    remove: (id: number) => invoke('archives:delete', id)
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch: unknown) => invoke('settings:set', patch)
  },
  app: {
    paths: () => invoke('app:paths'),
    stats: () => invoke('app:stats'),
    openPath: (path: string) => invoke('app:openPath', path),
    pickDirectory: (title?: string) => invoke('app:pickDirectory', title),
    pickArchive: () => invoke('app:pickArchive'),
    pickFile: (filters?: unknown) => invoke('app:pickFile', filters),
    openExternal: (url: string) => invoke('shell:openExternal', url),
    installInfo: () => invoke('app:installInfo'),
    uninstall: () => invoke('app:uninstall'),
    wipeData: () => invoke('app:wipeData'),
    restart: () => invoke('app:restart'),
    /** 默认邮件程序（mailto: 处理程序）的状态与切换 */
    mailtoStatus: () => invoke('app:mailtoStatus'),
    mailtoSetDefault: () => invoke('app:mailtoSetDefault'),
    /** 数据目录位置与迁移 */
    dataDir: () => invoke('app:dataDir'),
    dataDirCheck: (target: string) => invoke('app:dataDirCheck', target),
    dataDirMigrate: (target: string) => invoke('app:dataDirMigrate', target),
    dataDirRemoveOld: (dir: string) => invoke('app:dataDirRemoveOld', dir),
    onDataDirProgress: (cb: (p: DataDirProgress) => void) => on('datadir:progress', cb)
  },
  /**
   * 系统把 mailto: 链接交给我们时触发。
   * 首次启动带链接、以及程序已在运行时再点链接（由第二个实例转交）都会走这里。
   */
  mailto: {
    onOpen: (cb: (delivery: MailtoDelivery) => void) => on('mailto:open', cb),
    /** 挂载后主动拉取待处理的请求（推送可能早于订阅建立） */
    take: () => invoke('mailto:take'),
    ack: (id: number) => invoke('mailto:ack', id)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type SimpleMailApi = typeof api
