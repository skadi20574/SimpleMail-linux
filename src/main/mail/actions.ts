/**
 * 邮件批量操作（删除 / 移动 / 标记）。
 *
 * 集中在这里而不是散在 IPC 里，是因为「永久删除」牵扯到三件事，
 * 顺序错了就会留下垃圾文件或者让服务器上的邮件又同步回来：
 *   1. 先把附件文件从磁盘删掉（数据库里的行删了之后路径就查不到了）；
 *   2. 再删数据库行（FTS 索引随之清理）；
 *   3. IMAP 账户还要在服务器上把邮件移到垃圾箱，否则下次同步它又回来了。
 *
 * 本地操作是同步且立即的（界面马上有反馈），服务器操作在后台异步进行。
 */

import { existsSync, rmSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Account } from '@shared/types'
import * as repo from '../db/repo'
import {
  createMailboxOnServer,
  deleteMailboxOnServer,
  moveManyOnServer,
  renameMailboxOnServer
} from './imap'

export interface BatchOutcome {
  /** 本地实际处理成功的封数 */
  affected: number
  /** 永久删除时顺带删掉的附件文件数 */
  filesRemoved: number
  /** 因为找不到目标文件夹等原因跳过的封数 */
  skipped: number
  errors: string[]
}

/** 删除附件文件并清理空目录 */
function removeAttachmentFiles(mailIds: number[]): number {
  let removed = 0
  const rows = repo.listAttachmentPaths(mailIds)

  // 先删文件
  const dirs = new Set<string>()
  for (const row of rows) {
    if (!row.storedPath) continue
    dirs.add(dirname(row.storedPath))
    try {
      if (existsSync(row.storedPath)) {
        unlinkSync(row.storedPath)
        removed++
      }
    } catch {
      /* 单个文件删不掉不影响其它 */
    }
  }

  // 再尝试清理每个邮件自己的附件目录（目录名就是 mailId，互不共用）
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 目录非空或权限不足时忽略 */
    }
  }
  return removed
}

/**
 * 永久删除（对应 Shift+Delete）。
 *
 * 本机侧：附件文件 + 数据库记录一起删掉，不可恢复。
 * 服务器侧：IMAP 账户会把邮件移到垃圾箱（不是直接销毁），
 *           这样既满足「本机彻底删掉」，又不会下次同步又冒出来。
 */
export function deleteMailsPermanently(mailIds: number[]): BatchOutcome {
  const outcome: BatchOutcome = { affected: 0, filesRemoved: 0, skipped: 0, errors: [] }
  if (!mailIds.length) return outcome

  const locations = repo.getMailLocations(mailIds)
  const found = new Set(locations.map((l) => l.id))
  outcome.skipped = mailIds.length - found.size

  // 1) 磁盘文件
  outcome.filesRemoved = removeAttachmentFiles(locations.map((l) => l.id))

  // 2) 数据库（deleteMail 会级联删 attachments 与 FTS 行）
  for (const loc of locations) {
    try {
      repo.deleteMail(loc.id)
      outcome.affected++
    } catch (err) {
      outcome.errors.push(
        `邮件 #${loc.id} 删除失败：${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  // 3) 服务器（后台）
  void syncServerTrash(locations)
  return outcome
}

/**
 * 移到垃圾箱（对应 Delete）。
 * 已经在垃圾箱里的邮件直接永久删除 —— 和大多数客户端的习惯一致。
 */
export function moveMailsToTrash(mailIds: number[]): BatchOutcome {
  const outcome: BatchOutcome = { affected: 0, filesRemoved: 0, skipped: 0, errors: [] }
  if (!mailIds.length) return outcome

  const locations = repo.getMailLocations(mailIds)
  outcome.skipped = mailIds.length - locations.length

  const toDelete: number[] = []
  const toMove: { id: number; accountId: number; folderId: number; uid: number | null; messageId: string | null }[] = []

  for (const loc of locations) {
    const folder = repo.getFolder(loc.folderId)
    if (!folder || folder.role === 'trash') {
      // 已经在垃圾箱（或文件夹不存在）→ 视作永久删除
      toDelete.push(loc.id)
      continue
    }
    const trash = repo.findFolderByRole(loc.accountId, 'trash')
    if (!trash) {
      // 该账户没有垃圾箱文件夹，只能直接删
      toDelete.push(loc.id)
      continue
    }
    toMove.push(loc)
  }

  if (toDelete.length) {
    const sub = deleteMailsPermanently(toDelete)
    // affected 也要累加，否则「在垃圾箱里再按 Delete」会提示“已删除 0 封”，
    // 明明删掉了却报 0，用户会以为没生效（曾经就是这样）。
    outcome.affected += sub.affected
    outcome.filesRemoved += sub.filesRemoved
    outcome.errors.push(...sub.errors)
  }

  // 按「账户 + 垃圾箱」分组批量移动
  const byTrash = new Map<number, number[]>()
  for (const loc of toMove) {
    const trash = repo.findFolderByRole(loc.accountId, 'trash')
    if (!trash) continue
    const list = byTrash.get(trash.id) ?? []
    list.push(loc.id)
    byTrash.set(trash.id, list)
  }
  for (const [trashId, ids] of byTrash) {
    try {
      outcome.affected += repo.moveMany(ids, trashId)
    } catch (err) {
      outcome.errors.push(
        `移动到垃圾箱失败：${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  // 服务器侧同步（后台）
  void syncServerTrash(toMove)
  return outcome
}

/**
 * 在服务器上把邮件移到各自的垃圾箱。
 * 按 (账户, 原文件夹) 分组，每组复用一条连接，避免一封邮件开一次连接。
 */
async function syncServerTrash(
  locations: { id: number; accountId: number; folderId: number; uid: number | null }[]
): Promise<void> {
  const groups = new Map<
    string,
    { account: Account; fromPath: string; toPath: string; uids: number[] }
  >()

  for (const loc of locations) {
    if (loc.uid === null) continue
    const account = repo.getAccount(loc.accountId)
    // 只有 IMAP 账户才有服务器文件夹概念；POP3 与本地存档账户跳过
    if (!account || account.isLocal || account.protocol !== 'imap') continue

    const folder = repo.getFolder(loc.folderId)
    const trash = repo.findFolderByRole(loc.accountId, 'trash')
    if (!folder || !trash || folder.role === 'trash') continue

    const key = `${loc.accountId}:${folder.path}->${trash.path}`
    const entry =
      groups.get(key) ??
      { account, fromPath: folder.path, toPath: trash.path, uids: [] as number[] }
    entry.uids.push(loc.uid)
    groups.set(key, entry)
  }

  for (const group of groups.values()) {
    try {
      await moveManyOnServer(group.account, group.fromPath, group.uids, group.toPath)
    } catch {
      /* 服务器同步失败不阻塞本地操作，下次同步会体现差异 */
    }
  }
}

/** 批量标记已读/未读，IMAP 账户顺带回写服务器 */
export function markMailsRead(mailIds: number[], unread: boolean): BatchOutcome {
  const outcome: BatchOutcome = { affected: 0, filesRemoved: 0, skipped: 0, errors: [] }
  if (!mailIds.length) return outcome
  outcome.affected = repo.markManyRead(mailIds, unread)

  const locations = repo.getMailLocations(mailIds)
  void syncServerFlags(locations, unread ? 'unseen' : 'seen')
  return outcome
}

export function markMailsFlagged(mailIds: number[], flagged: boolean): BatchOutcome {
  const outcome: BatchOutcome = { affected: 0, filesRemoved: 0, skipped: 0, errors: [] }
  if (!mailIds.length) return outcome
  outcome.affected = repo.markManyFlagged(mailIds, flagged)

  const locations = repo.getMailLocations(mailIds)
  void syncServerFlags(locations, flagged ? 'flag' : 'unflag')
  return outcome
}

async function syncServerFlags(
  locations: { accountId: number; folderId: number; uid: number | null }[],
  action: 'seen' | 'unseen' | 'flag' | 'unflag'
): Promise<void> {
  const { pushFlag } = await import('./imap')
  for (const loc of locations) {
    if (loc.uid === null) continue
    const account = repo.getAccount(loc.accountId)
    if (!account || account.isLocal || account.protocol !== 'imap') continue
    const folder = repo.getFolder(loc.folderId)
    if (!folder) continue
    try {
      await pushFlag(account, folder.path, loc.uid, action)
    } catch {
      /* 忽略单封失败 */
    }
  }
}

/* ─────────────────────────── 文件夹管理 ─────────────────────────── */

export interface FolderOpResult extends BatchOutcome {
  folderId?: number
  /** 服务器同步是否已发起（IMAP 账户） */
  serverSynced: boolean
}

/** 收件箱不允许删除或改名 —— 它是 IMAP 的锚点，改名会让同步逻辑找不到入口 */
const PROTECTED_ROLES = new Set(['inbox'])

/**
 * 新建文件夹。
 *
 * 路径按账户的层级分隔符拼：给了父文件夹就 `父路径/名字`，否则就是顶层名字。
 * IMAP 账户还会在服务器上真正建一个 mailbox；POP3 与本地存档账户只有本地文件夹。
 */
export function createFolder(
  accountId: number,
  name: string,
  parentFolderId?: number | null
): FolderOpResult {
  const outcome: FolderOpResult = {
    affected: 0,
    filesRemoved: 0,
    skipped: 0,
    errors: [],
    serverSynced: false
  }

  const account = repo.getAccount(accountId)
  if (!account) {
    outcome.errors.push('账户不存在')
    return outcome
  }

  const clean = name.trim().replace(/[\r\n\t]/g, ' ')
  if (!clean) {
    outcome.errors.push('文件夹名不能为空')
    return outcome
  }
  if (clean.includes('/') && account.protocol === 'imap') {
    outcome.errors.push('文件夹名里不能带 “/”')
    return outcome
  }

  const parent = parentFolderId ? repo.getFolder(parentFolderId) : undefined
  const delimiter = parent?.delimiter || '/'
  const path = parent ? `${parent.path}${delimiter}${clean}` : clean

  if (repo.findFolderByPath(accountId, path)) {
    outcome.errors.push(`文件夹「${clean}」已存在`)
    return outcome
  }

  const folder = repo.upsertFolder(accountId, path, clean, 'custom', delimiter)
  outcome.folderId = folder.id
  outcome.affected = 1

  if (!account.isLocal && account.protocol === 'imap') {
    outcome.serverSynced = true
    void createMailboxOnServer(account, path)
  }
  return outcome
}

/** 重命名文件夹（IMAP 会同步改名） */
export function renameFolder(folderId: number, newName: string): FolderOpResult {
  const outcome: FolderOpResult = {
    affected: 0,
    filesRemoved: 0,
    skipped: 0,
    errors: [],
    serverSynced: false
  }

  const folder = repo.getFolder(folderId)
  if (!folder) {
    outcome.errors.push('文件夹不存在')
    return outcome
  }
  if (PROTECTED_ROLES.has(folder.role)) {
    outcome.errors.push('收件箱不支持重命名')
    return outcome
  }

  const clean = newName.trim().replace(/[\r\n\t]/g, ' ')
  if (!clean) {
    outcome.errors.push('文件夹名不能为空')
    return outcome
  }

  const account = repo.getAccount(folder.accountId)
  const delimiter = folder.delimiter || '/'
  const parentPath = folder.path.includes(delimiter)
    ? folder.path.slice(0, folder.path.lastIndexOf(delimiter))
    : ''
  const newPath = parentPath ? `${parentPath}${delimiter}${clean}` : clean

  repo.renameFolder(folderId, clean)
  // 路径要跟着改，否则下次同步会当成两个不同的文件夹
  repo.updateFolderPath(folderId, newPath)
  outcome.affected = 1

  if (account && !account.isLocal && account.protocol === 'imap') {
    outcome.serverSynced = true
    void renameMailboxOnServer(account, folder.path, newPath)
  }
  return outcome
}

/**
 * 删除文件夹。
 *
 * @param mailMode 'trash' = 先把里面的邮件移到垃圾箱（可恢复，默认）
 *                 'delete' = 连同邮件一起永久删除
 */
export function deleteFolder(folderId: number, mailMode: 'trash' | 'delete'): FolderOpResult {
  const outcome: FolderOpResult = {
    affected: 0,
    filesRemoved: 0,
    skipped: 0,
    errors: [],
    serverSynced: false
  }

  const folder = repo.getFolder(folderId)
  if (!folder) {
    outcome.errors.push('文件夹不存在')
    return outcome
  }
  if (PROTECTED_ROLES.has(folder.role)) {
    outcome.errors.push('收件箱不能删除')
    return outcome
  }

  const account = repo.getAccount(folder.accountId)
  const mailIds = repo.listMails({ folderId, limit: 100000 }).items.map((m) => m.id)

  // 服务器侧：先把邮件搬走，再删 mailbox。顺序不能反 ——
  // mailboxDelete 会连同里面的邮件一起删掉，反了就找不回来了。
  const isImap = Boolean(account && !account.isLocal && account.protocol === 'imap')
  if (isImap && account) {
    outcome.serverSynced = true
    const acc = account
    const trash = repo.findFolderByRole(folder.accountId, 'trash')
    void (async () => {
      try {
        if (mailMode === 'trash' && trash && folder.role !== 'trash') {
          const uids = repo
            .getMailLocations(mailIds)
            .map((l) => l.uid)
            .filter((u): u is number => u !== null)
          if (uids.length) await moveManyOnServer(acc, folder.path, uids, trash.path)
        }
        await deleteMailboxOnServer(acc, folder.path)
      } catch {
        /* 服务器失败不阻塞本地 */
      }
    })()
  }

  // 本地：处理邮件
  if (mailIds.length) {
    if (mailMode === 'trash' && folder.role !== 'trash') {
      const moved = moveMailsToTrash(mailIds)
      outcome.affected += moved.affected
      outcome.filesRemoved += moved.filesRemoved
      outcome.errors.push(...moved.errors)
    } else {
      const removed = deleteMailsPermanently(mailIds)
      outcome.affected += removed.affected
      outcome.filesRemoved += removed.filesRemoved
      outcome.errors.push(...removed.errors)
    }
  }

  repo.deleteFolder(folderId)
  outcome.affected += 1
  return outcome
}

/** 把邮件移动到一个指定文件夹（拖拽 / 右键「移动到」用） */
export function moveMailsToFolder(mailIds: number[], folderId: number): BatchOutcome {
  const outcome: BatchOutcome = { affected: 0, filesRemoved: 0, skipped: 0, errors: [] }
  if (!mailIds.length) return outcome

  const target = repo.getFolder(folderId)
  if (!target) {
    outcome.errors.push('目标文件夹不存在')
    return outcome
  }

  const locations = repo.getMailLocations(mailIds)
  const moving = locations.filter((l) => l.folderId !== folderId).map((l) => l.id)
  outcome.skipped = mailIds.length - moving.length
  if (!moving.length) return outcome

  outcome.affected = repo.moveMany(moving, folderId)

  // IMAP 服务器同步（按 账户+原文件夹 分组，一组一条连接）
  const groups = new Map<string, { account: Account; fromPath: string; uids: number[] }>()
  for (const loc of locations) {
    if (loc.folderId === folderId || loc.uid === null) continue
    const account = repo.getAccount(loc.accountId)
    if (!account || account.isLocal || account.protocol !== 'imap') continue
    const from = repo.getFolder(loc.folderId)
    if (!from) continue
    const key = `${loc.accountId}:${from.path}`
    const entry = groups.get(key) ?? { account, fromPath: from.path, uids: [] as number[] }
    entry.uids.push(loc.uid)
    groups.set(key, entry)
  }
  for (const g of groups.values()) {
    void moveManyOnServer(g.account, g.fromPath, g.uids, target.path)
  }
  return outcome
}
