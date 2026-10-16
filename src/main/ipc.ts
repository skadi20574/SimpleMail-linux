/**
 * IPC 层：渲染进程能做的所有事情都在这里显式列出。
 * 没有 `nodeIntegration`，渲染进程只能通过 preload 暴露的白名单通道访问主进程。
 */

import { ipcMain, dialog, shell, BrowserWindow, Menu, app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname as pathDirname } from 'node:path'
import { join } from 'node:path'
import type {
  AccountDraft,
  RuleDraft,
  AppSettings,
  ComposeAttachment,
  ComposePayload,
  ExportOptions,
  ImportOptions,
  MailListQuery,
  SyncProgress
} from '@shared/types'
import * as repo from './db/repo'
import { closeDb, getDb } from './db'
import { appPaths } from './paths'
import { closeMailWindow, openMailWindow } from './windows'
import { loadSettings, saveSettings } from './settings'
import { messageAttachmentDir, safeFilename } from './mail/attachments'
import { sendMail, testSmtp } from './mail/smtp'
import {
  accountSupportsImap,
  appendToSent,
  pushFlag,
  syncAccount,
  testImap,
  ingestSource
} from './mail/imap'
import { syncPop3Account, testPop3 } from './mail/pop3'
import { abortSync, isAborted, runningAccountIds } from './mail/sync-control'
import { applyRulesToMail, previewRule, runAllRules } from './rules'
import {
  createFolder,
  deleteFolder,
  deleteMailsPermanently,
  markMailsFlagged,
  markMailsRead,
  moveMailsToFolder,
  moveMailsToTrash,
  renameFolder
} from './mail/actions'
import { openArchive, inspectArchive } from './foxmail/archive'
import { importArchive } from './foxmail/importer'
import { exportArchive } from './foxmail/exporter'
import { mailtoStatus, setMailtoDefault } from './mailto'
import {
  checkDataDirTarget,
  dataDirInfo,
  migrateDataDir,
  removeOldDataDir
} from './data-dir'
import { takePendingMailto, ackMailto } from './mailto-queue'

type Sender = Electron.IpcMainInvokeEvent

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/* ─────────────────────────── 账户 ─────────────────────────── */

async function handleAccountSave(_e: Sender, draft: AccountDraft): Promise<unknown> {
  if (draft.id) {
    return repo.updateAccount({ ...draft, id: draft.id })
  }
  return repo.createAccount(draft)
}

async function handleAccountTest(
  _e: Sender,
  draft: AccountDraft
): Promise<{ receive: { ok: boolean; error?: string }; smtp: { ok: boolean; error?: string } }> {
  const account = {
    ...(draft as unknown as import('@shared/types').Account),
    id: draft.id ?? 0,
    createdAt: 0,
    lastSyncAt: null,
    isLocal: false
  }
  // 按所选协议测对应的收件通道；发信一律走 SMTP
  const receive =
    account.protocol === 'pop3' ? await testPop3(account) : await testImap(account)
  const smtp = await testSmtp(account)
  return { receive, smtp }
}

/* ─────────────────────────── 同步 ─────────────────────────── */

let syncRunning = new Map<number, Promise<void>>()
let lastProgress: SyncProgress | null = null

async function handleSyncStart(_e: Sender, accountId: number): Promise<unknown> {
  const account = repo.getAccount(accountId)
  if (!account) return { ok: false, error: '账户不存在' }
  if (account.isLocal) return { ok: false, error: '本地存档账户无需同步' }
  if (syncRunning.has(accountId)) return { ok: true, already: true }

  const settings = loadSettings()
  const onProgress = (p: SyncProgress): void => {
    lastProgress = p
    broadcast('sync:progress', p)
  }

  const task = (
    account.protocol === 'pop3'
      ? syncPop3Account(account, {
          // POP3 是「下载即完整」的模式，单次上限沿用同步批量设置，
          // 剩余部分下次同步继续拉，进度条不会长时间不动
          maxMessages: Math.max(settings.syncBatch, 200),
          onProgress
        })
      : syncAccount(account, {
          headerBatch: settings.syncBatch,
          bodyBatch: 200,
          onProgress
        })
  )
    .catch(() => {
      /* 错误已经通过 progress 事件上报 */
    })
    .finally(() => {
      syncRunning.delete(accountId)
      broadcast('sync:finished', { accountId, aborted: isAborted(accountId) })
    })

  syncRunning.set(accountId, task)
  return { ok: true }
}

/* ─────────────────────────── 发信 ─────────────────────────── */

async function handleSend(_e: Sender, payload: ComposePayload): Promise<unknown> {
  const account = repo.getAccount(payload.accountId)
  if (!account) return { ok: false, error: '账户不存在' }

  if (account.isLocal) {
    return { ok: false, error: '「本地存档」账户没有配置 SMTP，无法发信。请先在设置里添加一个邮箱账户。' }
  }

  const attachments = (payload.attachments ?? []).filter((a) => existsSync(a.path))
  const outcome = await sendMail(
    account,
    payload,
    attachments.map((a) => ({
      filename: a.filename,
      path: a.path,
      contentType: a.contentType
    }))
  )

  if (!outcome.ok || !outcome.raw) {
    return { ok: false, error: outcome.error ?? '发送失败' }
  }

  // 落库到「已发送」
  const sentFolder = repo.findFolderByRole(account.id, 'sent')
  const folder = sentFolder ?? repo.upsertFolder(account.id, '已发送', '已发送', 'sent')

  const mailId = repo.insertMail({
    accountId: account.id,
    folderId: folder.id,
    uid: null,
    messageId: null,
    subject: payload.subject,
    fromName: account.displayName,
    fromAddr: account.email,
    toText: payload.to,
    ccText: payload.cc,
    bccText: payload.bcc,
    replyTo: '',
    date: Date.now(),
    bodyText: '',
    bodyHtml: null,
    rawHeaders: '',
    inReplyTo: payload.inReplyTo ?? null,
    references: payload.references ?? null,
    size: outcome.raw.length,
    unread: false,
    flagged: false,
    hasAttachments: attachments.length > 0,
    source: 'local'
  })

  if (mailId !== null) {
    // 自己发出的邮件不套用自动规则（runRules = false）
    await ingestSource(account, mailId, outcome.raw, false)
  }

  // 编辑已有草稿时，把草稿删掉
  if (payload.draftId) repo.deleteMail(payload.draftId)

  // 服务器「已发送」也留一份
  if (sentFolder) {
    void appendToSent(account, sentFolder.path, outcome.raw)
  }

  return { ok: true, mailId: mailId ?? undefined }
}

async function handleSaveDraft(_e: Sender, payload: ComposePayload): Promise<unknown> {
  const account = repo.getAccount(payload.accountId)
  if (!account) return { ok: false, error: '账户不存在' }

  const folder = repo.findFolderByRole(account.id, 'drafts') ??
    repo.upsertFolder(account.id, '草稿箱', '草稿箱', 'drafts')

  const bodyText = payload.text ?? ''

  if (payload.draftId) {
    getDb()
      .prepare(
        `UPDATE mails SET subject = ?, to_text = ?, cc_text = ?, bcc_text = ?,
                body_text = ?, body_html = ?, date = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(
        payload.subject,
        payload.to,
        payload.cc,
        payload.bcc,
        bodyText,
        payload.html ?? null,
        Date.now(),
        Date.now(),
        payload.draftId
      )
    await attachPickedFiles(account.id, payload.draftId, payload.attachments ?? [])
    return { ok: true, mailId: payload.draftId }
  }

  const mailId = repo.insertMail({
    accountId: account.id,
    folderId: folder.id,
    uid: null,
    messageId: null,
    subject: payload.subject || '(无主题)',
    fromName: account.displayName,
    fromAddr: account.email,
    toText: payload.to,
    ccText: payload.cc,
    bccText: payload.bcc,
    replyTo: '',
    date: Date.now(),
    bodyText,
    bodyHtml: payload.html ?? null,
    rawHeaders: '',
    inReplyTo: payload.inReplyTo ?? null,
    references: payload.references ?? null,
    size: bodyText.length,
    unread: false,
    flagged: false,
    hasAttachments: (payload.attachments ?? []).length > 0,
    source: 'local'
  })

  if (mailId !== null) {
    await attachPickedFiles(account.id, mailId, payload.attachments ?? [])
  }
  return { ok: true, mailId: mailId ?? undefined }
}

/** 把撰写界面上选择的本地文件复制进附件目录并登记 */
async function attachPickedFiles(
  accountId: number,
  mailId: number,
  files: ComposeAttachment[]
): Promise<void> {
  if (!files.length) return
  const existing = repo.listAttachments(mailId)
  const existingNames = new Set(existing.map((a) => `${a.filename}|${a.size}`))
  const dir = messageAttachmentDir(accountId, mailId)

  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    if (!existsSync(f.path)) continue
    let size = 0
    try {
      size = statSync(f.path).size
    } catch {
      continue
    }
    if (existingNames.has(`${f.filename}|${size}`)) continue

    const target = join(dir, `${existing.length + i + 1}_${safeFilename(f.filename)}`)
    try {
      copyFileSync(f.path, target)
    } catch {
      continue
    }
    repo.insertAttachment({
      mailId,
      filename: f.filename,
      contentType: f.contentType ?? 'application/octet-stream',
      size,
      contentId: null,
      isInline: false,
      storedPath: target
    })
  }
}

/* ─────────────────────────── Foxmail 存档 ─────────────────────────── */

async function handleFoxmailImport(_e: Sender, options: ImportOptions): Promise<unknown> {
  return importArchive(options, (p) => broadcast('import:progress', p))
}

async function handleFoxmailExport(_e: Sender, options: ExportOptions): Promise<unknown> {
  return exportArchive(options, (p) => broadcast('export:progress', p))
}

/* ─────────────────────────── 重启 ─────────────────────────── */

/**
 * 重启应用。
 *
 * ⚠️ 必须走**启动器脚本**，不能用默认的 app.relaunch()。
 *
 * deb / tar.gz 安装后，可执行文件其实是一层 shell 启动器（simplemail），
 * 它负责在没有 setuid 的场景下补 --no-sandbox，然后再 exec 真正的
 * simplemail.bin。运行期 process.execPath 指向的是 .bin，而 app.relaunch()
 * 默认就拿它去启动 —— 沙箱开关被绕过，新进程在 Ubuntu 24.04+ 上立刻 abort。
 * 用户看到的现象就是「清除数据后软件闪退，重新打开又正常」。
 */
export function relaunchApp(): { ok: boolean; relaunched: boolean } {
  if (process.env.APPIMAGE) {
    // AppImage 的挂载路径重启后可能失效，交给用户手动打开更稳妥
    app.quit()
    return { ok: true, relaunched: false }
  }

  const launcher = join(pathDirname(process.execPath), 'simplemail')
  try {
    if (existsSync(launcher) && launcher !== process.execPath) {
      app.relaunch({ execPath: launcher })
    } else {
      app.relaunch()
    }
  } catch {
    app.relaunch()
  }
  app.exit(0)
  return { ok: true, relaunched: true }
}

/* ─────────────────────────── 注册 ─────────────────────────── */

export function registerIpc(): void {
  ipcMain.handle('accounts:list', () => repo.listAccounts())
  ipcMain.handle('accounts:save', handleAccountSave)
  ipcMain.handle('accounts:test', handleAccountTest)
  ipcMain.handle('accounts:delete', (_e, id: number) => {
    repo.deleteAccount(id)
    return { ok: true }
  })

  ipcMain.handle('folders:list', (_e, accountId?: number) => repo.listFolders(accountId))

  /** 新建文件夹；给了 parentId 就是建子文件夹 */
  ipcMain.handle(
    'folders:create',
    (_e, accountId: number, name: string, parentId?: number | null) =>
      createFolder(accountId, name, parentId ?? null)
  )
  ipcMain.handle('folders:rename', (_e, id: number, name: string) => renameFolder(id, name))
  ipcMain.handle('folders:delete', (_e, id: number, mailMode: 'trash' | 'delete') =>
    deleteFolder(id, mailMode)
  )
  ipcMain.handle('folders:info', (_e, id: number) => {
    const folder = repo.getFolder(id)
    if (!folder) return null
    return { ...folder, mailCount: repo.listMails({ folderId: id, limit: 1 }).total }
  })

  /**
   * 文件夹右键菜单。和邮件列表那套一样用系统原生菜单，
   * 渲染层只说明「右键的是哪个文件夹」，点了哪项再回传执行。
   */
  ipcMain.handle(
    'folders:contextMenu',
    async (_e, folderId: number): Promise<{ action: string } | null> => {
      const folder = repo.getFolder(folderId)
      if (!folder) return null
      const account = repo.getAccount(folder.accountId)
      const isInbox = folder.role === 'inbox'
      const count = repo.listMails({ folderId, limit: 1 }).total

      let settled = false
      let finish: (v: { action: string } | null) => void = () => {}
      const pick = (action: string): void => {
        if (settled) return
        settled = true
        finish({ action })
      }

      const template: Electron.MenuItemConstructorOptions[] = [
        { label: '在此文件夹下新建子文件夹…', click: () => pick('createSub') },
        { label: '新建同级文件夹…', click: () => pick('createSibling') },
        { type: 'separator' },
        {
          label: '重命名…',
          enabled: !isInbox,
          click: () => pick('rename')
        },
        {
          label: `删除文件夹${count ? `（含 ${count} 封邮件）` : ''}`,
          enabled: !isInbox,
          click: () => pick('delete')
        },
        { type: 'separator' },
        {
          label: `${account?.displayName || account?.email || '账户'}：立即同步`,
          enabled: Boolean(account && !account.isLocal),
          click: () => pick('sync')
        }
      ]

      return await new Promise((resolve) => {
        finish = resolve
        const menu = Menu.buildFromTemplate(template)
        const win = BrowserWindow.fromWebContents(_e.sender) ?? undefined
        menu.popup({
          window: win,
          callback: () => {
            setTimeout(() => {
              if (!settled) {
                settled = true
                resolve(null)
              }
            }, 0)
          }
        })
      })
    }
  )

  ipcMain.handle('mails:list', (_e, query: MailListQuery) => repo.listMails(query))
  ipcMain.handle('mails:get', (_e, id: number) => repo.getMail(id))
  ipcMain.handle('mails:markRead', (_e, id: number, unread: boolean) => {
    repo.markMailRead(id, unread)
    const mail = repo.getMail(id)
    if (mail && mail.uid) {
      const account = repo.getAccount(mail.accountId)
      const folder = repo.getFolder(mail.folderId)
      if (account && folder && accountSupportsImap(account)) {
        void pushFlag(account, folder.path, mail.uid, unread ? 'unseen' : 'seen')
      }
    }
    return { ok: true }
  })
  ipcMain.handle('mails:markFlagged', (_e, id: number, flagged: boolean) => {
    repo.markMailFlagged(id, flagged)
    const mail = repo.getMail(id)
    if (mail && mail.uid) {
      const account = repo.getAccount(mail.accountId)
      const folder = repo.getFolder(mail.folderId)
      if (account && folder && accountSupportsImap(account)) {
        void pushFlag(account, folder.path, mail.uid, flagged ? 'flag' : 'unflag')
      }
    }
    return { ok: true }
  })
  ipcMain.handle('mails:markFolderRead', (_e, folderId: number) => {
    repo.markFolderRead(folderId)
    return { ok: true }
  })
  ipcMain.handle('mails:move', (_e, id: number, folderId: number) => {
    repo.moveMail(id, folderId)
    return { ok: true }
  })
  ipcMain.handle('mails:delete', (_e, id: number) => {
    repo.deleteMail(id)
    return { ok: true }
  })
  /** 双击邮件：开一个独立窗口读信 */
  ipcMain.handle('mails:openWindow', (_e, mailId: number) => {
    const mail = repo.getMail(mailId)
    openMailWindow(mailId, mail?.subject ? `SimpleMail — ${mail.subject}` : undefined)
    return { ok: true }
  })

  /**
   * 邮件列表右键菜单。
   *
   * 用 Electron 的原生菜单而不是自绘 HTML 菜单：位置、键盘导航、点击外部关闭
   * 这些都由系统处理，长得也和系统一致。渲染层只负责说明「当前选中了什么」，
   * 菜单点了哪一项再回传给它执行 —— 动作逻辑只留在渲染层一份。
   */
  ipcMain.handle(
    'mails:contextMenu',
    async (
      _e,
      payload: {
        mailIds: number[]
        activeMailId: number
        allRead: boolean | null
        allFlagged: boolean | null
        folders: { id: number; name: string; accountId: number }[]
        currentFolderId: number | null
      }
    ): Promise<{ action: string; folderId?: number } | null> => {
      const { mailIds, allFlagged, folders, currentFolderId } = payload
      const multi = mailIds.length > 1
      const suffix = multi ? `（${mailIds.length} 封）` : ''

      const senders = new Set(
        mailIds
          .map((id) => repo.getMail(id)?.accountId)
          .filter((v): v is number => typeof v === 'number')
      )
      // 只有一个账户时才给「移动到」子菜单，避免跨账户乱移
      const movableFolders =
        senders.size === 1
          ? folders.filter((f) => f.accountId === [...senders][0] && f.id !== currentFolderId)
          : []

      const template: Electron.MenuItemConstructorOptions[] = [
        {
          label: multi ? `打开 ${mailIds.length} 封中的第一封` : '在新窗口打开',
          click: () => resolveOnce({ action: 'open' })
        },
        { type: 'separator' },
        // 两个方向都列出来，而不是按当前状态二选一 —— 多选时状态可能混杂，
        // 而且用户明确希望能「已读改未读 / 未读改已读」双向切换。
        {
          label: `标记为已读${suffix}`,
          click: () => resolveOnce({ action: 'markRead' })
        },
        {
          label: `标记为未读${suffix}`,
          click: () => resolveOnce({ action: 'markUnread' })
        },
        {
          label: allFlagged === true ? `取消星标${suffix}` : `加星标${suffix}`,
          click: () => resolveOnce({ action: allFlagged === true ? 'unflag' : 'flag' })
        },
        { type: 'separator' },
        { label: '回复', enabled: !multi, click: () => resolveOnce({ action: 'reply' }) },
        { label: '回复全部', enabled: !multi, click: () => resolveOnce({ action: 'replyAll' }) },
        { label: '转发', enabled: !multi, click: () => resolveOnce({ action: 'forward' }) },
        { type: 'separator' },
        {
          label: '移动到',
          enabled: movableFolders.length > 0,
          submenu: movableFolders.map((f) => ({
            label: f.name,
            click: () => resolveOnce({ action: 'move', folderId: f.id })
          }))
        },
        { type: 'separator' },
        {
          label: `移到垃圾箱${suffix}`,
          click: () => resolveOnce({ action: 'trash' })
        },
        {
          label: `永久删除${suffix}`,
          click: () => resolveOnce({ action: 'delete' })
        }
      ]

      let settled = false
      // resolve 只能在 Promise 执行器内部拿到，所以先留一个引用，
      // 让上面的菜单项 click 回调在真正点击时能回调到它。
      let finish: (value: { action: string; folderId?: number } | null) => void = () => {}
      const resolveOnce = (value: { action: string; folderId?: number } | null): void => {
        if (settled) return
        settled = true
        finish(value)
      }

      return await new Promise((resolve) => {
        finish = resolve
        const menu = Menu.buildFromTemplate(template)
        const win = BrowserWindow.fromWebContents(_e.sender) ?? undefined
        menu.popup({
          window: win,
          callback: () => {
            // 菜单关闭时如果还没选中任何项，说明用户点了别处
            setTimeout(() => resolveOnce(null), 0)
          }
        })
      })
    }
  )

  // ── 批量操作（键盘多选 / 快捷键用） ──
  ipcMain.handle('mails:deleteMany', (_e, ids: number[], permanent: boolean) => {
    const result = permanent ? deleteMailsPermanently(ids) : moveMailsToTrash(ids)
    // 已经被删掉的邮件，如果开着独立窗口就一起关掉
    for (const id of ids) {
      if (!repo.getMail(id)) closeMailWindow(id)
    }
    return result
  })
  ipcMain.handle('mails:markManyRead', (_e, ids: number[], unread: boolean) =>
    markMailsRead(ids, unread)
  )
  ipcMain.handle('mails:markManyFlagged', (_e, ids: number[], flagged: boolean) =>
    markMailsFlagged(ids, flagged)
  )

  /** 批量移动到指定文件夹（右键菜单的「移动到」、拖拽都用它，IMAP 会同步服务器） */
  ipcMain.handle('mails:moveMany', (_e, ids: number[], folderId: number) =>
    moveMailsToFolder(ids, folderId)
  )

  ipcMain.handle('mails:send', handleSend)
  ipcMain.handle('mails:saveDraft', handleSaveDraft)

  ipcMain.handle('attachments:saveAs', async (_e, attachmentId: number) => {
    const att = repo.getAttachment(attachmentId)
    if (!att?.storedPath || !existsSync(att.storedPath)) {
      return { ok: false, error: '附件文件不存在' }
    }
    const result = await dialog.showSaveDialog({ defaultPath: att.filename })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    copyFileSync(att.storedPath, result.filePath)
    return { ok: true, path: result.filePath }
  })
  ipcMain.handle('attachments:open', async (_e, attachmentId: number) => {
    const att = repo.getAttachment(attachmentId)
    if (!att?.storedPath || !existsSync(att.storedPath)) {
      return { ok: false, error: '附件文件不存在' }
    }
    const err = await shell.openPath(att.storedPath)
    return err ? { ok: false, error: err } : { ok: true }
  })
  ipcMain.handle('attachments:reveal', (_e, attachmentId: number) => {
    const att = repo.getAttachment(attachmentId)
    if (!att?.storedPath) return { ok: false }
    shell.showItemInFolder(att.storedPath)
    return { ok: true }
  })
  ipcMain.handle('attachments:pick', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择附件',
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled) return []
    return result.filePaths.map((p) => {
      let size = 0
      try {
        size = statSync(p).size
      } catch {
        /* ignore */
      }
      return { path: p, filename: p.split('/').pop() ?? 'attachment', size }
    })
  })

  ipcMain.handle('sync:start', handleSyncStart)
  ipcMain.handle('sync:abort', (_e, accountId: number) => {
    abortSync(accountId)
    return { ok: true }
  })
  ipcMain.handle('sync:status', () => {
    const running = runningAccountIds()
    return {
      running: syncRunning.size > 0,
      accountId: running.length ? running[0] : null,
      lastProgress
    }
  })

  ipcMain.handle('foxmail:detect', async (_e, path: string) => {
    const opened = await openArchive(path)
    return opened.detection
  })
  ipcMain.handle('foxmail:inspect', async (_e, path: string, scan = true) =>
    inspectArchive(path, scan)
  )
  ipcMain.handle('foxmail:import', handleFoxmailImport)
  ipcMain.handle('foxmail:export', handleFoxmailExport)
  // ── 自动归类规则 ──
  ipcMain.handle('rules:list', (_e, accountId?: number) => repo.listRules(accountId))
  ipcMain.handle('rules:save', (_e, draft: RuleDraft) => repo.saveRule(draft))
  ipcMain.handle('rules:delete', (_e, id: number) => {
    repo.deleteRule(id)
    return { ok: true }
  })
  ipcMain.handle('rules:setEnabled', (_e, id: number, enabled: boolean) => {
    repo.setRuleEnabled(id, enabled)
    return { ok: true }
  })
  ipcMain.handle('rules:preview', (_e, draft: RuleDraft, limit?: number) =>
    previewRule(draft, limit ?? 200)
  )
  ipcMain.handle('rules:runAll', (_e, accountId?: number) => runAllRules(accountId))
  /** 对某封已存在的邮件立即套用规则（调试用） */
  ipcMain.handle('rules:applyToMail', (_e, mailId: number) => applyRulesToMail(mailId, true))

  ipcMain.handle('archives:list', (_e, accountId?: number) => repo.listArchives(accountId))
  ipcMain.handle('archives:delete', (_e, id: number) => {
    repo.deleteArchive(id)
    return { ok: true }
  })

  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => saveSettings(patch))

  /**
   * 判断当前是怎么装上的 —— 决定「卸载」按钮该做什么。
   *   deb      → /opt/SimpleMail，可以用 pkexec + apt 卸载
   *   appimage → 单个 AppImage 文件，删掉文件即可
   *   portable → tar.gz 解压出来的目录，删掉目录即可
   */
  ipcMain.handle('app:installInfo', () => {
    const execPath = process.execPath
    const appImage = process.env.APPIMAGE
    let kind: 'deb' | 'appimage' | 'portable' | 'unknown' = 'unknown'
    let appPath = execPath

    if (appImage) {
      kind = 'appimage'
      appPath = appImage
    } else if (execPath.startsWith('/opt/SimpleMail')) {
      kind = 'deb'
      appPath = '/opt/SimpleMail'
    } else {
      kind = 'portable'
      appPath = pathDirname(execPath)
    }

    return {
      kind,
      appPath,
      packageName: 'simplemail',
      dataDir: appPaths().userData,
      /** 手动卸载命令（界面上展示，用户也可以自己复制去执行） */
      manualCommand:
        kind === 'deb'
          ? 'sudo apt remove simplemail'
          : kind === 'appimage'
            ? `rm -f "${appPath}"`
            : `rm -rf "${appPath}"`,
      hasPkexec: existsSync('/usr/bin/pkexec') || existsSync('/bin/pkexec')
    }
  })

  /**
   * 默认邮件程序（mailto: 处理程序）的状态与设置。
   *
   * 不给「安装时自动抢」：默认程序是用户的选择，安装包擅自换掉不礼貌，
   * 用户往往过很久才发现点邮件链接跳到了别处。只提供查询 + 用户主动切换。
   */
  /* ── 数据目录位置与迁移 ── */
  ipcMain.handle('app:dataDir', () => dataDirInfo())
  ipcMain.handle('app:dataDirCheck', (_e, target: string) => checkDataDirTarget(target))
  ipcMain.handle('app:dataDirMigrate', async (_e, target: string) => {
    // 迁移过程可能很久（GB 级），进度通过广播发回界面
    return migrateDataDir(target, (p) => broadcast('datadir:progress', p))
  })
  ipcMain.handle('app:dataDirRemoveOld', (_e, dir: string) => removeOldDataDir(dir))

  ipcMain.handle('app:mailtoStatus', () => mailtoStatus())
  ipcMain.handle('app:mailtoSetDefault', () => setMailtoDefault())

  /**
   * 渲染进程挂载后主动拉取待处理的 mailto 请求。
   *
   * 不能只靠主进程推送：页面加载完成（did-finish-load）可能早于 React 的
   * effect 建立订阅，那条消息就丢了 —— 表现为「程序起来了但没打开写信窗口」。
   * 拉取 + 推送两条路都送到同一条时，渲染进程按 id 去重。
   */
  ipcMain.handle('mailto:take', () => takePendingMailto())
  ipcMain.handle('mailto:ack', (_e, id: number) => {
    ackMailto(id)
    return { ok: true }
  })

  /**
   * 卸载 .deb 安装的版本。
   *
   * 用 pkexec 拉起系统授权对话框来执行 apt remove —— 卸载系统包必须有 root，
   * 这是最标准也最透明的做法（用户能看到并拒绝授权）。
   * 不能直接删 /opt 下的文件：那样 dpkg 数据库里还留着记录，会变成「半卸载」状态。
   */
  ipcMain.handle('app:uninstall', async () => {
    const isDeb = process.execPath.startsWith('/opt/SimpleMail')
    if (!isDeb) {
      return { ok: false, error: '当前不是通过 .deb 安装的，请参考界面上的路径自行删除' }
    }
    const pkexec = existsSync('/usr/bin/pkexec') ? '/usr/bin/pkexec' : existsSync('/bin/pkexec') ? '/bin/pkexec' : null
    if (!pkexec) {
      return { ok: false, error: '系统里没有 pkexec，请在终端执行：sudo apt remove simplemail' }
    }

    return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const child = spawn(pkexec, ['apt-get', 'remove', '-y', 'simplemail'], {
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let output = ''
      child.stdout?.on('data', (d: Buffer) => {
        output += d.toString()
      })
      child.stderr?.on('data', (d: Buffer) => {
        output += d.toString()
      })
      child.on('error', (err) => resolve({ ok: false, error: err.message }))
      child.on('close', (code) => {
        if (code === 0) {
          resolve({ ok: true })
          // 程序文件已经被删掉了，稍等片刻让界面把提示显示完再退出
          setTimeout(() => app.quit(), 1200)
        } else {
          resolve({
            ok: false,
            error: `卸载未完成（退出码 ${code}）。可能是取消了授权。\n${output.slice(-400)}`
          })
        }
      })
    })
  })

  /**
   * 清除全部本地数据（邮件数据库 + 附件 + 导出）。
   *
   * 这是不可撤销的，界面上要求用户手动输入确认词。清完直接重启应用，
   * 免得继续跑在一个「数据库文件已经被删掉」的状态里。
   */
  ipcMain.handle('app:wipeData', async () => {
    try {
      const paths = appPaths()
      closeDb()
      for (const suffix of ['', '-wal', '-shm']) {
        const f = `${paths.database}${suffix}`
        if (existsSync(f)) rmSync(f, { force: true })
      }
      if (existsSync(paths.attachments)) rmSync(paths.attachments, { recursive: true, force: true })
      if (existsSync(paths.exports)) rmSync(paths.exports, { recursive: true, force: true })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** 清空数据后重启，让程序从干净的数据库开始 */
  ipcMain.handle('app:restart', () => relaunchApp())

  ipcMain.handle('app:paths', () => appPaths())
  ipcMain.handle('app:stats', () => {
    const counts = repo.totalCounts()
    let attachmentBytes = 0
    let attachmentCount = 0
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else {
          try {
            attachmentBytes += statSync(full).size
            attachmentCount++
          } catch {
            /* ignore */
          }
        }
      }
    }
    walk(appPaths().attachments)

    let dbBytes = 0
    for (const suffix of ['', '-wal', '-shm']) {
      const p = `${appPaths().database}${suffix}`
      if (existsSync(p)) {
        try {
          dbBytes += statSync(p).size
        } catch {
          /* ignore */
        }
      }
    }

    return { ...counts, attachmentBytes, attachmentCount, dbBytes, version: app.getVersion() }
  })
  ipcMain.handle('app:openPath', async (_e, path: string) => {
    if (!existsSync(path)) return { ok: false, error: '路径不存在' }
    const err = await shell.openPath(path)
    return err ? { ok: false, error: err } : { ok: true }
  })
  ipcMain.handle('app:pickDirectory', async (_e, title?: string) => {
    const result = await dialog.showOpenDialog({
      title: title ?? '选择目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })
  ipcMain.handle('app:pickArchive', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 Foxmail 存档（.fox 文件，或 Foxmail 数据目录）',
      properties: ['openFile', 'openDirectory']
    })
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })
  ipcMain.handle('app:pickFile', async (_e, filters?: Electron.FileFilter[]) => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters
    })
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })

  ipcMain.handle('shell:openExternal', async (_e, url: string) => {
    if (/^https?:/i.test(url)) {
      await shell.openExternal(url)
      return { ok: true }
    }
    return { ok: false, error: '只允许打开 http/https 链接' }
  })

  // 启动时确保导出目录存在
  mkdirSync(appPaths().exports, { recursive: true })
}
