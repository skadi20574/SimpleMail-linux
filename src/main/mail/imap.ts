/**
 * IMAP 同步引擎。
 *
 * 同步分两段，保证「打开就能看列表，正文慢慢补齐」：
 *   阶段 1（headers）：只抓 envelope + flags + 头部，速度快，列表立刻可用；
 *   阶段 2（bodies）  ：把还没抓到正文的邮件整封 source 拉下来，
 *                      解析后写入 SQLite，附件落到应用数据目录。
 *
 * 一旦落库就是永久的：没有任何过期清理逻辑。
 */

import { ImapFlow } from 'imapflow'
import type { Account, FolderRole, SyncProgress } from '@shared/types'
import * as repo from '../db/repo'
import { parseMessage } from './parser'
import { storeAttachment } from './attachments'

export interface SyncOptions {
  /** 本轮最多抓多少封新邮件的头部（防止首次同步卡死界面） */
  headerBatch?: number
  /** 本轮最多补齐多少封正文 */
  bodyBatch?: number
  onProgress?: (p: SyncProgress) => void
}

// 中断控制与 POP3 共用一套（见 sync-control.ts），否则界面上的「取消」
// 只能取消一种协议的同步。
import { clearSync, isAborted, registerSync } from './sync-control'
import { applyRulesToMail } from '../rules'

export { abortSync, isAborted } from './sync-control'

/** 只有非本地、且收件协议为 IMAP 的账户才走 IMAP 通道 */
export function accountSupportsImap(account: Account): boolean {
  return !account.isLocal && account.protocol === 'imap'
}

export function detectRole(path: string, name: string, specialUse?: string | null): FolderRole {
  const su = (specialUse ?? '').toLowerCase()
  if (su.includes('inbox')) return 'inbox'
  if (su.includes('sent')) return 'sent'
  if (su.includes('draft')) return 'drafts'
  if (su.includes('trash')) return 'trash'
  if (su.includes('junk') || su.includes('spam')) return 'junk'
  if (su.includes('archive') || su.includes('all')) return 'archive'

  const n = `${name} ${path}`.toLowerCase()
  if (/\binbox\b|收件箱/.test(n)) return 'inbox'
  if (/sent|已发送|发件箱|已发邮件|已发出/.test(n)) return 'sent'
  if (/draft|草稿/.test(n)) return 'drafts'
  if (/trash|deleted|已删除|垃圾箱|回收站/.test(n)) return 'trash'
  if (/junk|spam|垃圾邮件|广告邮件|疑似垃圾/.test(n)) return 'junk'
  if (/archive|存档|归档|所有邮件/.test(n)) return 'archive'
  return 'custom'
}

function makeClient(account: Account): ImapFlow {
  return new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    auth: { user: account.username || account.email, pass: account.password },
    logger: false,
    // 国内邮箱的证书链偶有缺失，这里放宽但仅限 IMAP 连接本身
    tls: { rejectUnauthorized: false },
    socketTimeout: 120_000,
    greetingTimeout: 30_000
  })
}

export async function testImap(account: Account): Promise<{ ok: boolean; error?: string }> {
  const client = makeClient(account)
  try {
    await client.connect()
    await client.logout()
    return { ok: true }
  } catch (err) {
    try {
      await client.close()
    } catch {
      /* ignore */
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function firstAddress(list: unknown): { name: string; address: string } {
  if (!Array.isArray(list) || !list.length) return { name: '', address: '' }
  const first = list[0] as { name?: string; address?: string }
  return { name: first?.name ?? '', address: first?.address ?? '' }
}

function addrList(list: unknown): string {
  if (!Array.isArray(list) || !list.length) return ''
  return list
    .map((entry) => {
      const e = entry as { name?: string; address?: string }
      return e.name ? `${e.name} <${e.address ?? ''}>` : (e.address ?? '')
    })
    .filter(Boolean)
    .join(', ')
}

/** 从 imapflow 的 bodyStructure 里判断是否有附件 */
function structureHasAttachment(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false
  const n = node as { disposition?: string; childNodes?: unknown[]; type?: string }
  if (n.disposition && /attachment/i.test(n.disposition)) return true
  if (Array.isArray(n.childNodes)) return n.childNodes.some(structureHasAttachment)
  return false
}

/**
 * 同步一个账户。
 */
export async function syncAccount(account: Account, options: SyncOptions = {}): Promise<void> {
  const headerBatch = options.headerBatch ?? 500
  const bodyBatch = options.bodyBatch ?? 200
  const report = options.onProgress ?? ((): void => {})

  const state = registerSync(account.id)

  const emit = (p: Partial<SyncProgress> & { phase: SyncProgress['phase']; message: string }): void => {
    report({
      accountId: account.id,
      phase: p.phase,
      folderName: p.folderName,
      current: p.current ?? 0,
      total: p.total ?? 0,
      message: p.message,
      error: p.error
    })
  }

  if (account.isLocal || account.protocol !== 'imap') {
    emit({ phase: 'done', message: '该账户不走 IMAP 同步' })
    clearSync(account.id)
    return
  }

  const client = makeClient(account)
  try {
    emit({ phase: 'connecting', message: `正在连接 ${account.imapHost}…` })
    await client.connect()

    emit({ phase: 'folders', message: '正在读取文件夹列表…' })
    const boxes = await client.list()
    const folderMap = new Map<string, { id: number; role: FolderRole }>()
    for (const box of boxes) {
      const role = detectRole(box.path, box.name, box.specialUse ?? null)
      const folder = repo.upsertFolder(
        account.id,
        box.path,
        box.name || box.path,
        role,
        box.delimiter ?? '/'
      )
      folderMap.set(box.path, { id: folder.id, role: folder.role })
    }

    // ── 阶段 1：头部 ────────────────────────────────────────────────
    let newlyAdded = 0
    for (const box of boxes) {
      if (state.aborted) break
      const info = folderMap.get(box.path)
      if (!info) continue

      emit({ phase: 'headers', folderName: box.name || box.path, message: `同步 ${box.name || box.path}…` })

      const lock = await client.getMailboxLock(box.path)
      try {
        const mailbox = client.mailbox
        if (!mailbox) continue
        const uidValidity = Number(mailbox.uidValidity ?? 0)
        const prev = repo.getSyncState(account.id, info.id)

        // UIDVALIDITY 变化说明服务器重建了 UID 空间，只能重头来
        const startUid =
          prev.uidValidity !== null && prev.uidValidity !== uidValidity ? 0 : prev.lastUid

        const exists = Number(mailbox.exists ?? 0)
        if (exists === 0) {
          repo.setSyncState(account.id, info.id, uidValidity, startUid)
          continue
        }

        let range: string
        if (startUid === 0) {
          // 首次同步：只取最近 headerBatch 封，避免一次性拉几万封
          range = `${Math.max(1, exists - headerBatch + 1)}:*`
        } else {
          range = `${startUid + 1}:*`
        }

        let maxUid = startUid
        let batch = 0
        const rows: {
          uid: number
          messageId: string | null
          subject: string
          fromName: string
          fromAddr: string
          toText: string
          ccText: string
          date: number
          size: number
          unread: boolean
          flagged: boolean
          hasAttachments: boolean
          rawHeaders: string
        }[] = []

        for await (const msg of client.fetch(
          range,
          { uid: true, envelope: true, flags: true, size: true, headers: true, bodyStructure: true },
          { uid: true }
        )) {
          if (state.aborted) break
          const uid = Number(msg.uid)
          if (!Number.isFinite(uid)) continue
          if (uid > maxUid) maxUid = uid
          if (startUid !== 0 && uid <= startUid) continue

          const env = msg.envelope
          const from = firstAddress(env?.from)
          rows.push({
            uid,
            messageId: env?.messageId ?? null,
            subject: env?.subject ?? '',
            fromName: from.name,
            fromAddr: from.address,
            toText: addrList(env?.to),
            ccText: addrList(env?.cc),
            date: env?.date ? new Date(env.date).getTime() : Date.now(),
            size: Number(msg.size ?? 0),
            unread: !(msg.flags?.has('\\Seen') ?? false),
            flagged: msg.flags?.has('\\Flagged') ?? false,
            hasAttachments: structureHasAttachment(msg.bodyStructure),
            rawHeaders: msg.headers ? msg.headers.toString('utf8') : ''
          })
          batch++
          if (batch >= headerBatch && startUid === 0) break
        }

        for (const row of rows) {
          const id = repo.insertMail({
            accountId: account.id,
            folderId: info.id,
            uid: row.uid,
            messageId: row.messageId,
            subject: row.subject,
            fromName: row.fromName,
            fromAddr: row.fromAddr,
            toText: row.toText,
            ccText: row.ccText,
            bccText: '',
            replyTo: '',
            date: row.date,
            bodyText: '',
            bodyHtml: null,
            rawHeaders: row.rawHeaders,
            size: row.size,
            unread: row.unread,
            flagged: row.flagged,
            hasAttachments: row.hasAttachments,
            source: 'imap'
          })
          if (id !== null) {
            newlyAdded++
            // 信封阶段先跑一遍规则：只用邮件头判断的规则（比如按发件人归类）
            // 立刻生效，用户不用等正文下载完。依赖正文的规则会自动推迟。
            try {
              applyRulesToMail(id)
            } catch {
              /* 单封规则出错不影响同步 */
            }
          }
        }

        repo.setSyncState(account.id, info.id, uidValidity, maxUid)
      } finally {
        lock.release()
      }
    }

    // ── 阶段 2：正文补齐 ───────────────────────────────────────────
    for (const box of boxes) {
      if (state.aborted) break
      const info = folderMap.get(box.path)
      if (!info) continue
      if (info.role === 'trash' || info.role === 'junk') continue

      const pending = repo
        .listMailsNeedingBody(info.id, bodyBatch)
        .filter((row) => Number.isFinite(row.uid))
      if (!pending.length) continue

      emit({
        phase: 'bodies',
        folderName: box.name || box.path,
        current: 0,
        total: pending.length,
        message: `下载 ${box.name || box.path} 正文（${pending.length} 封）…`
      })

      const byUid = new Map<number, number>()
      for (const row of pending) byUid.set(row.uid, row.id)

      const lock = await client.getMailboxLock(box.path)
      try {
        let done = 0
        const uids = [...byUid.keys()]
        for (let i = 0; i < uids.length; i += 20) {
          if (state.aborted) break
          const slice = uids.slice(i, i + 20)
          const range = slice.join(',')
          for await (const msg of client.fetch(range, { uid: true, source: true }, { uid: true })) {
            if (state.aborted) break
            const uid = Number(msg.uid)
            const mailId = byUid.get(uid)
            if (!mailId || !msg.source) continue
            try {
              await ingestSource(account, mailId, msg.source)
            } catch {
              /* 单封失败不影响整体 */
            }
            done++
            emit({
              phase: 'bodies',
              folderName: box.name || box.path,
              current: done,
              total: pending.length,
              message: `下载正文 ${done}/${pending.length}`
            })
          }
        }
      } finally {
        lock.release()
      }
    }

    repo.touchAccountSync(account.id)
    emit({
      phase: 'done',
      message: state.aborted ? '同步已取消' : `同步完成，新增 ${newlyAdded} 封`
    })
  } catch (err) {
    emit({
      phase: 'error',
      message: '同步失败',
      error: err instanceof Error ? err.message : String(err)
    })
    throw err
  } finally {
    try {
      await client.logout()
    } catch {
      try {
        await client.close()
      } catch {
        /* ignore */
      }
    }
    clearSync(account.id)
  }
}

/** 解析一封原始报文并写回数据库（正文 + 附件） */
export async function ingestSource(
  account: Account,
  mailId: number,
  source: Buffer,
  /** 是否套用自动归类规则。自己发出去的邮件（已发送副本）不应被规则处理。 */
  runRules = true
): Promise<void> {
  const parsed = await parseMessage(source)
  repo.updateMailBody(mailId, {
    bodyText: parsed.bodyText,
    bodyHtml: parsed.bodyHtml,
    hasAttachments: parsed.attachments.length > 0,
    rawHeaders: parsed.rawHeaders || '',
    subject: parsed.subject,
    fromName: parsed.fromName,
    fromAddr: parsed.fromAddr,
    toText: parsed.toText,
    ccText: parsed.ccText,
    size: parsed.size
  })

  for (let i = 0; i < parsed.attachments.length; i++) {
    const att = parsed.attachments[i]
    let storedPath: string | null = null
    try {
      storedPath = storeAttachment(account.id, mailId, att, i + 1)
    } catch {
      storedPath = null
    }
    repo.insertAttachment({
      mailId,
      filename: att.filename,
      contentType: att.contentType,
      size: att.size,
      contentId: att.contentId,
      isInline: att.isInline,
      storedPath
    })
  }

  // 正文到手了，把之前因为「还没正文」而推迟的规则补评一次
  if (runRules) {
    try {
      applyRulesToMail(mailId, true)
    } catch {
      /* 规则出错不影响邮件落库 */
    }
  }
}

/** 在服务器上打已读/星标标记 */
export async function pushFlag(
  account: Account,
  folderPath: string,
  uid: number,
  action: 'seen' | 'unseen' | 'flag' | 'unflag'
): Promise<void> {
  if (!accountSupportsImap(account)) return
  const client = makeClient(account)
  try {
    await client.connect()
    const lock = await client.getMailboxLock(folderPath)
    try {
      const flags = action === 'seen' ? ['\\Seen'] : action === 'flag' ? ['\\Flagged'] : null
      if (flags) await client.messageFlagsAdd(String(uid), flags, { uid: true })
      else
        await client.messageFlagsRemove(
          String(uid),
          [action === 'unseen' ? '\\Seen' : '\\Flagged'],
          { uid: true }
        )
    } finally {
      lock.release()
    }
  } catch {
    /* 标记同步失败不阻塞本地操作 */
  } finally {
    try {
      await client.logout()
    } catch {
      /* ignore */
    }
  }
}

/** 把已发送邮件追加到服务器「已发送」文件夹 */
export async function appendToSent(
  account: Account,
  folderPath: string,
  source: Buffer,
  flagged = true
): Promise<void> {
  if (!accountSupportsImap(account)) return
  const client = makeClient(account)
  try {
    await client.connect()
    await client.append(folderPath, source, flagged ? ['\\Seen'] : [])
  } catch {
    /* 服务器副本失败不影响本地「已发送」 */
  } finally {
    try {
      await client.logout()
    } catch {
      /* ignore */
    }
  }
}

/**
 * 在服务器上批量移动邮件。
 *
 * 关键是：一个 (账户, 原文件夹) 分组只开**一条连接**、一次 messageMove。
 * 早先的做法是每封邮件调一次 moveOnServer，删 200 封就会开 200 次 IMAP
 * 连接，既慢又容易被服务器限流。
 */
export async function moveManyOnServer(
  account: Account,
  fromPath: string,
  uids: number[],
  toPath: string
): Promise<void> {
  if (!accountSupportsImap(account) || !uids.length) return
  const client = makeClient(account)
  try {
    await client.connect()
    const lock = await client.getMailboxLock(fromPath)
    try {
      // imapflow 支持逗号分隔的 UID 集合，一次请求搬完
      await client.messageMove(uids.join(','), toPath, { uid: true })
    } finally {
      lock.release()
    }
  } catch {
    /* 服务器同步失败不阻塞本地操作 */
  } finally {
    try {
      await client.logout()
    } catch {
      /* ignore */
    }
  }
}

/* ── 服务器端文件夹操作 ── */

/** 在服务器上新建文件夹 */
export async function createMailboxOnServer(account: Account, path: string): Promise<void> {
  if (!accountSupportsImap(account)) return
  const client = makeClient(account)
  try {
    await client.connect()
    await client.mailboxCreate(path)
  } catch {
    /* 服务器不支持或已存在时忽略，本地状态仍以程序为准 */
  } finally {
    try {
      await client.logout()
    } catch {
      /* ignore */
    }
  }
}

/** 在服务器上删除文件夹（连同里面的邮件） */
export async function deleteMailboxOnServer(account: Account, path: string): Promise<void> {
  if (!accountSupportsImap(account)) return
  const client = makeClient(account)
  try {
    await client.connect()
    await client.mailboxDelete(path)
  } catch {
    /* ignore */
  } finally {
    try {
      await client.logout()
    } catch {
      /* ignore */
    }
  }
}

/** 在服务器上重命名 / 移动文件夹 */
export async function renameMailboxOnServer(
  account: Account,
  oldPath: string,
  newPath: string
): Promise<void> {
  if (!accountSupportsImap(account)) return
  const client = makeClient(account)
  try {
    await client.connect()
    await client.mailboxRename(oldPath, newPath)
  } catch {
    /* ignore */
  } finally {
    try {
      await client.logout()
    } catch {
      /* ignore */
    }
  }
}

/** 在服务器上移动邮件（删除到垃圾箱 / 移动文件夹） */
export async function moveOnServer(
  account: Account,
  fromPath: string,
  uid: number,
  toPath: string
): Promise<void> {
  if (!accountSupportsImap(account)) return
  const client = makeClient(account)
  try {
    await client.connect()
    const lock = await client.getMailboxLock(fromPath)
    try {
      await client.messageMove(String(uid), toPath, { uid: true })
    } finally {
      lock.release()
    }
  } catch {
    /* ignore */
  } finally {
    try {
      await client.logout()
    } catch {
      /* ignore */
    }
  }
}
