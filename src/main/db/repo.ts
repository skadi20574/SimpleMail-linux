/**
 * 数据仓储层：所有 SQL 都集中在这里。
 * 上层（IMAP 同步 / Foxmail 导入 / IPC）只调用这些方法，不直接写 SQL。
 */

import type {
  Account,
  AccountDraft,
  Rule,
  RuleCondition,
  RuleDraft,
  AttachmentMeta,
  Folder,
  FolderRole,
  MailDetail,
  MailListQuery,
  MailListResult,
  MailSource,
  MailSummary
} from '@shared/types'
import { plain, plainAll } from './sqlite'
import { getDb } from './index'
import { buildMatchQuery } from '../search'
import { indexMail as indexMailRowFts, unindexMail as unindexMailFts } from './fts'

/** node:sqlite 只接受 null/number/bigint/string/Uint8Array */
export type Param = null | number | string | Uint8Array

const now = (): number => Date.now()
const bool = (v: unknown): number => (v ? 1 : 0)
const toBool = (v: unknown): boolean => v === 1 || v === true

/* ─────────────────────────────── 账户 ─────────────────────────────── */

interface AccountRow {
  id: number
  email: string
  display_name: string
  protocol: string
  imap_host: string
  imap_port: number
  imap_secure: number
  pop3_host: string
  pop3_port: number
  pop3_secure: number
  pop3_delete_after_fetch: number
  smtp_host: string
  smtp_port: number
  smtp_secure: number
  username: string
  password: string
  signature: string
  color: string
  sync_enabled: number
  is_local: number
  created_at: number
  last_sync_at: number | null
}

function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    protocol: (row.protocol === 'pop3' ? 'pop3' : 'imap') as Account['protocol'],
    imapHost: row.imap_host,
    imapPort: row.imap_port,
    imapSecure: toBool(row.imap_secure),
    pop3Host: row.pop3_host,
    pop3Port: row.pop3_port,
    pop3Secure: toBool(row.pop3_secure),
    pop3DeleteAfterFetch: toBool(row.pop3_delete_after_fetch),
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    smtpSecure: toBool(row.smtp_secure),
    username: row.username,
    password: row.password,
    signature: row.signature,
    color: row.color,
    syncEnabled: toBool(row.sync_enabled),
    isLocal: toBool(row.is_local),
    createdAt: row.created_at,
    lastSyncAt: row.last_sync_at
  }
}

export function listAccounts(): Account[] {
  const rows = plainAll<AccountRow>(
    getDb().prepare('SELECT * FROM accounts ORDER BY is_local ASC, id ASC').all()
  )
  return rows.map(mapAccount)
}

export function getAccount(id: number): Account | undefined {
  const row = plain<AccountRow>(getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id))
  return row ? mapAccount(row) : undefined
}

export function findAccountByEmail(email: string): Account | undefined {
  const row = plain<AccountRow>(getDb().prepare('SELECT * FROM accounts WHERE email = ?').get(email))
  return row ? mapAccount(row) : undefined
}

export function createAccount(draft: AccountDraft): Account {
  const db = getDb()
  const res = db
    .prepare(
      `INSERT INTO accounts
        (email, display_name, protocol, imap_host, imap_port, imap_secure,
         pop3_host, pop3_port, pop3_secure, pop3_delete_after_fetch,
         smtp_host, smtp_port, smtp_secure, username, password,
         signature, color, sync_enabled, is_local, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      draft.email,
      draft.displayName ?? '',
      draft.protocol === 'pop3' ? 'pop3' : 'imap',
      draft.imapHost ?? '',
      draft.imapPort ?? 993,
      bool(draft.imapSecure),
      draft.pop3Host ?? '',
      draft.pop3Port ?? 995,
      bool(draft.pop3Secure),
      bool(draft.pop3DeleteAfterFetch),
      draft.smtpHost ?? '',
      draft.smtpPort ?? 465,
      bool(draft.smtpSecure),
      draft.username ?? draft.email,
      draft.password ?? '',
      draft.signature ?? '',
      draft.color ?? '#2f7fd8',
      bool(draft.syncEnabled !== false),
      bool(draft.isLocal),
      now()
    )
  return getAccount(Number(res.lastInsertRowid))!
}

export function updateAccount(draft: AccountDraft & { id: number }): Account {
  getDb()
    .prepare(
      `UPDATE accounts SET
        email = ?, display_name = ?, protocol = ?,
        imap_host = ?, imap_port = ?, imap_secure = ?,
        pop3_host = ?, pop3_port = ?, pop3_secure = ?, pop3_delete_after_fetch = ?,
        smtp_host = ?, smtp_port = ?, smtp_secure = ?, username = ?, password = ?,
        signature = ?, color = ?, sync_enabled = ?, is_local = ?
       WHERE id = ?`
    )
    .run(
      draft.email,
      draft.displayName ?? '',
      draft.protocol === 'pop3' ? 'pop3' : 'imap',
      draft.imapHost ?? '',
      draft.imapPort ?? 993,
      bool(draft.imapSecure),
      draft.pop3Host ?? '',
      draft.pop3Port ?? 995,
      bool(draft.pop3Secure),
      bool(draft.pop3DeleteAfterFetch),
      draft.smtpHost ?? '',
      draft.smtpPort ?? 465,
      bool(draft.smtpSecure),
      draft.username ?? draft.email,
      draft.password ?? '',
      draft.signature ?? '',
      draft.color ?? '#2f7fd8',
      bool(draft.syncEnabled !== false),
      bool(draft.isLocal),
      draft.id
    )
  return getAccount(draft.id)!
}

export function deleteAccount(id: number): void {
  getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id)
}

export function touchAccountSync(id: number): void {
  getDb().prepare('UPDATE accounts SET last_sync_at = ? WHERE id = ?').run(now(), id)
}

/* ─────────────────────────────── 文件夹 ─────────────────────────────── */

interface FolderRow {
  id: number
  account_id: number
  name: string
  path: string
  role: string
  delimiter?: string
  unread?: number
  total?: number
}

function mapFolder(row: FolderRow): Folder {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    path: row.path,
    role: row.role as FolderRole,
    delimiter: row.delimiter || '/',
    unread: row.unread ?? 0,
    total: row.total ?? 0
  }
}

export function listFolders(accountId?: number): Folder[] {
  const db = getDb()
  const where = accountId ? 'WHERE f.account_id = ?' : ''
  const params: Param[] = accountId ? [accountId] : []
  const rows = plainAll<FolderRow>(
    db
      .prepare(
        `SELECT f.*,
                (SELECT COUNT(*) FROM mails m WHERE m.folder_id = f.id AND m.unread = 1) AS unread,
                (SELECT COUNT(*) FROM mails m WHERE m.folder_id = f.id) AS total
           FROM folders f ${where}
          ORDER BY f.account_id ASC, f.sort_order ASC, f.id ASC`
      )
      .all(...params)
  )
  return rows.map(mapFolder)
}

export function getFolder(id: number): Folder | undefined {
  const row = plain<FolderRow>(getDb().prepare('SELECT * FROM folders WHERE id = ?').get(id))
  return row ? mapFolder(row) : undefined
}

export function findFolderByPath(accountId: number, path: string): Folder | undefined {
  const row = plain<FolderRow>(
    getDb()
      .prepare('SELECT * FROM folders WHERE account_id = ? AND path = ?')
      .get(accountId, path)
  )
  return row ? mapFolder(row) : undefined
}

export function findFolderByRole(accountId: number, role: FolderRole): Folder | undefined {
  const row = plain<FolderRow>(
    getDb()
      .prepare('SELECT * FROM folders WHERE account_id = ? AND role = ? ORDER BY id LIMIT 1')
      .get(accountId, role)
  )
  return row ? mapFolder(row) : undefined
}

const ROLE_ORDER: Record<FolderRole, number> = {
  inbox: 0,
  drafts: 1,
  sent: 2,
  junk: 3,
  archive: 4,
  trash: 90,
  custom: 50
}

export function upsertFolder(
  accountId: number,
  path: string,
  name: string,
  role: FolderRole,
  delimiter = '/'
): Folder {
  const db = getDb()
  const existing = findFolderByPath(accountId, path)
  if (existing) {
    // 角色可能因为服务器 SPECIAL-USE 变化而更新；但不要把手动设置的 role 覆盖掉
    if (existing.role === 'custom' && role !== 'custom') {
      db.prepare('UPDATE folders SET role = ?, name = ?, delimiter = ? WHERE id = ?').run(
        role,
        name,
        delimiter,
        existing.id
      )
    } else {
      db.prepare('UPDATE folders SET name = ?, delimiter = ? WHERE id = ?').run(
        name,
        delimiter,
        existing.id
      )
    }
    return getFolder(existing.id)!
  }
  const res = db
    .prepare(
      'INSERT INTO folders (account_id, name, path, role, delimiter, sort_order) VALUES (?,?,?,?,?,?)'
    )
    .run(accountId, name, path, role, delimiter, ROLE_ORDER[role] ?? 50)
  return getFolder(Number(res.lastInsertRowid))!
}

export function renameFolder(id: number, name: string): void {
  getDb().prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, id)
}

/**
 * 改文件夹路径。
 * 重命名后必须同步改 path —— 否则下次 IMAP 同步会按路径匹配到「新」文件夹，
 * 把它当成两个不同的文件夹，邮件就散成两份了。
 */
export function updateFolderPath(id: number, path: string): void {
  getDb().prepare('UPDATE folders SET path = ? WHERE id = ?').run(path, id)
}

export function deleteFolder(id: number): void {
  getDb().prepare('DELETE FROM folders WHERE id = ?').run(id)
}

export function nextCustomSortOrder(accountId: number): number {
  const row = plain<{ mx: number | null }>(
    getDb()
      .prepare('SELECT MAX(sort_order) AS mx FROM folders WHERE account_id = ? AND role = ?')
      .get(accountId, 'custom')
  )
  return (row?.mx ?? 50) + 1
}

/** 读取当初从 .box/.ind 导入时自标定出的索引布局（JSON 字符串） */
export function getFolderBoxLayout(folderId: number): string | null {
  const row = plain<{ box_layout: string | null }>(
    getDb().prepare('SELECT box_layout FROM folders WHERE id = ?').get(folderId)
  )
  return row?.box_layout ?? null
}

/** 记录索引布局，导出时原样写回 */
export function setFolderBoxLayout(folderId: number, layoutJson: string): void {
  getDb().prepare('UPDATE folders SET box_layout = ? WHERE id = ?').run(layoutJson, folderId)
}

/* ─────────────────────────────── 邮件 ─────────────────────────────── */

export interface MailInsert {
  accountId: number
  folderId: number
  uid?: number | null
  /** POP3 的 UIDL；与 uid 互斥，两者都用于去重 */
  pop3Uid?: string | null
  messageId?: string | null
  subject: string
  fromName: string
  fromAddr: string
  toText: string
  ccText: string
  bccText: string
  replyTo: string
  date: number
  bodyText: string
  bodyHtml: string | null
  rawHeaders: string
  inReplyTo?: string | null
  references?: string | null
  size: number
  unread: boolean
  flagged: boolean
  hasAttachments: boolean
  source: MailSource
  archiveTag?: string | null
}

function makeSnippet(bodyText: string): string {
  const flat = bodyText.replace(/\s+/g, ' ').trim()
  return flat.length > 240 ? flat.slice(0, 240) : flat
}

/**
 * 写入全文索引。
 * 具体怎么切词、分几个字段，全部交给 db/fts.ts —— 那里才有「每个字段一组
 * CJK 列」的细节，repo 只负责把数据递过去。
 */
function indexMailRow(id: number, data: MailInsert): void {
  indexMailRowFts(getDb(), {
    id,
    subject: data.subject,
    fromName: data.fromName,
    fromAddr: data.fromAddr,
    toText: data.toText,
    ccText: data.ccText,
    bodyText: data.bodyText
  })
}

/**
 * 插入一封邮件。返回邮件 id；若命中唯一索引（重复导入）则返回 null。
 */
export function insertMail(data: MailInsert): number | null {
  const db = getDb()
  const ts = now()
  const res = db
    .prepare(
      `INSERT INTO mails
        (account_id, folder_id, uid, pop3_uid, message_id, subject, from_name, from_addr,
         to_text, cc_text, bcc_text, reply_to, date, body_text, body_html,
         raw_headers, snippet, in_reply_to, refs, size, unread, flagged,
         has_attachments, source, archive_tag, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT DO NOTHING`
    )
    .run(
      data.accountId,
      data.folderId,
      data.uid ?? null,
      data.pop3Uid ?? null,
      data.messageId ?? null,
      data.subject,
      data.fromName,
      data.fromAddr,
      data.toText,
      data.ccText,
      data.bccText,
      data.replyTo,
      data.date,
      data.bodyText,
      data.bodyHtml,
      data.rawHeaders,
      makeSnippet(data.bodyText),
      data.inReplyTo ?? null,
      data.references ?? null,
      data.size,
      bool(data.unread),
      bool(data.flagged),
      bool(data.hasAttachments),
      data.source,
      data.archiveTag ?? null,
      ts,
      ts
    )
  if (res.changes === 0) return null
  const id = Number(res.lastInsertRowid)
  indexMailRow(id, data)
  return id
}

export interface MailBodyUpdate {
  bodyText: string
  bodyHtml: string | null
  hasAttachments: boolean
  rawHeaders: string
  subject: string
  fromName: string
  fromAddr: string
  toText: string
  ccText: string
  size?: number
}

export function updateMailBody(id: number, data: MailBodyUpdate): void {
  getDb()
    .prepare(
      `UPDATE mails SET body_text = ?, body_html = ?, has_attachments = ?, raw_headers = ?,
              subject = ?, from_name = ?, from_addr = ?, to_text = ?, cc_text = ?,
              snippet = ?, size = COALESCE(?, size), updated_at = ?
        WHERE id = ?`
    )
    .run(
      data.bodyText,
      data.bodyHtml,
      bool(data.hasAttachments),
      data.rawHeaders,
      data.subject,
      data.fromName,
      data.fromAddr,
      data.toText,
      data.ccText,
      makeSnippet(data.bodyText),
      data.size ?? null,
      now(),
      id
    )
  indexMailRow(id, {
    accountId: 0,
    folderId: 0,
    subject: data.subject,
    fromName: data.fromName,
    fromAddr: data.fromAddr,
    toText: data.toText,
    ccText: data.ccText,
    bodyText: data.bodyText,
    bodyHtml: data.bodyHtml,
    rawHeaders: data.rawHeaders,
    date: 0,
    bccText: '',
    replyTo: '',
    size: data.size ?? 0,
    unread: false,
    flagged: false,
    hasAttachments: data.hasAttachments,
    source: 'local'
  })
}

interface MailRow {
  id: number
  account_id: number
  folder_id: number
  uid: number | null
  message_id: string | null
  subject: string
  from_name: string
  from_addr: string
  to_text: string
  cc_text: string
  bcc_text: string
  reply_to: string
  date: number
  body_text: string
  body_html: string | null
  raw_headers: string
  snippet: string
  in_reply_to: string | null
  refs: string | null
  size: number
  unread: number
  flagged: number
  has_attachments: number
  source: string
  archive_tag: string | null
  rules_fired?: string | null
  rules_done?: number
  folder_name?: string
  account_email?: string
}

function mapSummary(row: MailRow): MailSummary {
  return {
    id: row.id,
    accountId: row.account_id,
    folderId: row.folder_id,
    uid: row.uid,
    messageId: row.message_id,
    subject: row.subject,
    fromName: row.from_name,
    fromAddr: row.from_addr,
    toText: row.to_text,
    date: row.date,
    snippet: row.snippet,
    unread: toBool(row.unread),
    flagged: toBool(row.flagged),
    hasAttachments: toBool(row.has_attachments),
    size: row.size,
    source: row.source as MailSource,
    archiveTag: row.archive_tag,
    folderName: row.folder_name,
    accountEmail: row.account_email
  }
}

const SUMMARY_COLS = `m.id, m.account_id, m.folder_id, m.uid, m.message_id, m.subject,
  m.from_name, m.from_addr, m.to_text, m.date, m.snippet, m.unread, m.flagged,
  m.has_attachments, m.size, m.source, m.archive_tag, f.name AS folder_name,
  a.email AS account_email`

const DETAIL_COLS = `${SUMMARY_COLS}, m.cc_text, m.bcc_text, m.reply_to,
  m.body_text, m.body_html, m.raw_headers, m.in_reply_to, m.refs`

export function listMails(query: MailListQuery): MailListResult {
  const db = getDb()
  const where: string[] = []
  const params: Param[] = []

  if (query.folderId) {
    where.push('m.folder_id = ?')
    params.push(query.folderId)
  }
  if (query.accountId) {
    where.push('m.account_id = ?')
    params.push(query.accountId)
  }
  if (query.searchAccountId) {
    where.push('m.account_id = ?')
    params.push(query.searchAccountId)
  }
  if (query.unreadOnly) where.push('m.unread = 1')
  if (query.flaggedOnly) where.push('m.flagged = 1')
  if (query.hasAttachments) where.push('m.has_attachments = 1')

  const match = query.search ? buildMatchQuery(query.search, query.searchField ?? 'all') : null

  // 搜索时用 JOIN 把 FTS 表接进来，这样才能取到 bm25() 分数做相关度排序。
  // 不搜索时保持原来的 IN 子查询，少一次 join。
  const ftsJoin = match
    ? `JOIN (SELECT rowid AS rid, bm25(mails_fts) AS score
              FROM mails_fts WHERE mails_fts MATCH ?) fts ON fts.rid = m.id`
    : ''
  const ftsParams = match ? [match] : []

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  // 排序：搜索时默认按相关度（bm25 越负越相关，所以 ASC），
  // 用户显式点了时间/主题/发件人排序就按那个来，相关度只作为次级排序键。
  const orderCol =
    query.orderBy === 'subject'
      ? 'm.subject'
      : query.orderBy === 'from'
        ? 'm.from_addr'
        : 'm.date'
  const orderDir = query.orderDir === 'asc' ? 'ASC' : 'DESC'

  let orderSql: string
  if (match && query.orderBy === 'relevance') {
    orderSql = 'fts.score ASC, m.date DESC'
  } else if (match) {
    orderSql = `${orderCol} ${orderDir}, fts.score ASC`
  } else {
    orderSql = `${orderCol} ${orderDir}, m.id ${orderDir}`
  }

  const limit = Math.min(Math.max(query.limit ?? 100, 1), 2000)
  const offset = Math.max(query.offset ?? 0, 0)

  const totalRow = plain<{ c: number }>(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM mails m
           JOIN folders f ON f.id = m.folder_id
           JOIN accounts a ON a.id = m.account_id
           ${ftsJoin}
         ${whereSql}`
      )
      .get(...ftsParams, ...params)
  )

  const rows = plainAll<MailRow>(
    db
      .prepare(
        `SELECT ${SUMMARY_COLS} FROM mails m
           JOIN folders f ON f.id = m.folder_id
           JOIN accounts a ON a.id = m.account_id
           ${ftsJoin}
         ${whereSql}
         ORDER BY ${orderSql}
         LIMIT ? OFFSET ?`
      )
      .all(...ftsParams, ...params, limit, offset)
  )

  return { total: totalRow?.c ?? 0, items: rows.map(mapSummary) }
}

export function getMail(id: number): MailDetail | undefined {
  const row = plain<MailRow>(getDb().prepare(`SELECT ${DETAIL_COLS} FROM mails m
      JOIN folders f ON f.id = m.folder_id
      JOIN accounts a ON a.id = m.account_id
     WHERE m.id = ?`).get(id))
  if (!row) return undefined
  const summary = mapSummary(row)
  return {
    ...summary,
    ccText: row.cc_text,
    bccText: row.bcc_text,
    replyTo: row.reply_to,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    rawHeaders: row.raw_headers,
    inReplyTo: row.in_reply_to,
    references: row.refs,
    attachments: listAttachments(id)
  }
}

/** 供导出使用：拿到重建 RFC822 所需的全部字段 */
export function getMailFull(id: number): (MailRow & { attachments: AttachmentMeta[] }) | undefined {
  const row = plain<MailRow>(
    getDb()
      .prepare(
        `SELECT m.*, f.name AS folder_name, a.email AS account_email
           FROM mails m
           JOIN folders f ON f.id = m.folder_id
           JOIN accounts a ON a.id = m.account_id
          WHERE m.id = ?`
      )
      .get(id)
  )
  if (!row) return undefined
  return { ...row, attachments: listAttachments(id) }
}

export function getMailsForExport(folderIds: number[], limit = 100000): number[] {
  const db = getDb()
  if (!folderIds.length) return []
  const marks = folderIds.map(() => '?').join(',')
  const rows = plainAll<{ id: number }>(
    db
      .prepare(
        `SELECT id FROM mails WHERE folder_id IN (${marks}) ORDER BY date ASC, id ASC LIMIT ?`
      )
      .all(...(folderIds as Param[]), limit)
  )
  return rows.map((r) => r.id)
}

export function markMailRead(id: number, unread: boolean): void {
  getDb().prepare('UPDATE mails SET unread = ?, updated_at = ? WHERE id = ?').run(bool(unread), now(), id)
}

export function markMailFlagged(id: number, flagged: boolean): void {
  getDb()
    .prepare('UPDATE mails SET flagged = ?, updated_at = ? WHERE id = ?')
    .run(bool(flagged), now(), id)
}

export function markFolderRead(folderId: number): void {
  getDb().prepare('UPDATE mails SET unread = 0 WHERE folder_id = ?').run(folderId)
}

export function moveMail(id: number, folderId: number): void {
  getDb()
    .prepare('UPDATE mails SET folder_id = ?, updated_at = ? WHERE id = ?')
    .run(folderId, now(), id)
}

/**
 * 批量取附件路径，供「永久删除」时清理磁盘文件。
 *
 * 注意：deleteMail 只删数据库行，附件文件**不会**被自动删掉。
 * 不查出来显式删除的话，永久删除掉的邮件其附件会永远留在磁盘上。
 */
export function listAttachmentPaths(mailIds: number[]): { mailId: number; storedPath: string | null }[] {
  if (!mailIds.length) return []
  const marks = mailIds.map(() => '?').join(',')
  return plainAll<{ mail_id: number; stored_path: string | null }>(
    getDb()
      .prepare(`SELECT mail_id, stored_path FROM attachments WHERE mail_id IN (${marks})`)
      .all(...(mailIds as Param[]))
  ).map((r) => ({ mailId: r.mail_id, storedPath: r.stored_path }))
}

/** 一次查出多封邮件的归属（账户 / 文件夹），批量操作用 */
export function getMailLocations(
  mailIds: number[]
): { id: number; accountId: number; folderId: number; uid: number | null; messageId: string | null }[] {
  if (!mailIds.length) return []
  const marks = mailIds.map(() => '?').join(',')
  return plainAll<{
    id: number
    account_id: number
    folder_id: number
    uid: number | null
    message_id: string | null
  }>(
    getDb()
      .prepare(
        `SELECT id, account_id, folder_id, uid, message_id FROM mails WHERE id IN (${marks})`
      )
      .all(...(mailIds as Param[]))
  ).map((r) => ({
    id: r.id,
    accountId: r.account_id,
    folderId: r.folder_id,
    uid: r.uid,
    messageId: r.message_id
  }))
}

/** 批量改已读状态，返回实际受影响的封数 */
export function markManyRead(mailIds: number[], unread: boolean): number {
  if (!mailIds.length) return 0
  const marks = mailIds.map(() => '?').join(',')
  const res = getDb()
    .prepare(`UPDATE mails SET unread = ?, updated_at = ? WHERE id IN (${marks})`)
    .run(bool(unread), now(), ...(mailIds as Param[]))
  return res.changes
}

/** 批量改星标，返回实际受影响的封数 */
export function markManyFlagged(mailIds: number[], flagged: boolean): number {
  if (!mailIds.length) return 0
  const marks = mailIds.map(() => '?').join(',')
  const res = getDb()
    .prepare(`UPDATE mails SET flagged = ?, updated_at = ? WHERE id IN (${marks})`)
    .run(bool(flagged), now(), ...(mailIds as Param[]))
  return res.changes
}

/** 批量移动到一个文件夹 */
export function moveMany(mailIds: number[], folderId: number): number {
  if (!mailIds.length) return 0
  const marks = mailIds.map(() => '?').join(',')
  const res = getDb()
    .prepare(`UPDATE mails SET folder_id = ?, updated_at = ? WHERE id IN (${marks})`)
    .run(folderId, now(), ...(mailIds as Param[]))
  return res.changes
}

export function deleteMail(id: number): void {
  const db = getDb()
  db.prepare('DELETE FROM attachments WHERE mail_id = ?').run(id)
  unindexMailFts(db, id)
  db.prepare('DELETE FROM mails WHERE id = ?').run(id)
}

export function setMailUid(id: number, uid: number): void {
  getDb().prepare('UPDATE mails SET uid = ? WHERE id = ?').run(uid, id)
}

export function findMailByMessageId(accountId: number, messageId: string): number | undefined {
  const row = plain<{ id: number }>(
    getDb()
      .prepare('SELECT id FROM mails WHERE account_id = ? AND message_id = ? LIMIT 1')
      .get(accountId, messageId)
  )
  return row?.id
}

/** 某个文件夹里已经下载过的 POP3 UIDL 集合（用于增量同步） */
export function listPop3Uids(folderId: number): string[] {
  const rows = plainAll<{ pop3_uid: string }>(
    getDb()
      .prepare('SELECT pop3_uid FROM mails WHERE folder_id = ? AND pop3_uid IS NOT NULL')
      .all(folderId)
  )
  return rows.map((r) => r.pop3_uid)
}

export function listUids(folderId: number): number[] {
  const rows = plainAll<{ uid: number }>(
    getDb()
      .prepare('SELECT uid FROM mails WHERE folder_id = ? AND uid IS NOT NULL')
      .all(folderId)
  )
  return rows.map((r) => r.uid)
}

/** 某个文件夹里尚未抓取正文的邮件（用于后台补齐） */
export function listMailsNeedingBody(folderId: number, limit: number): { id: number; uid: number }[] {
  return plainAll<{ id: number; uid: number }>(
    getDb()
      .prepare(
        `SELECT id, uid FROM mails
          WHERE folder_id = ? AND uid IS NOT NULL AND body_text = '' AND body_html IS NULL
          ORDER BY date DESC LIMIT ?`
      )
      .all(folderId, limit)
  )
}

/* ─────────────────────────────── 附件 ─────────────────────────────── */

export function insertAttachment(a: {
  mailId: number
  filename: string
  contentType: string
  size: number
  contentId: string | null
  isInline: boolean
  storedPath: string | null
}): number {
  const res = getDb()
    .prepare(
      `INSERT INTO attachments
        (mail_id, filename, content_type, size, content_id, is_inline, stored_path, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      a.mailId,
      a.filename,
      a.contentType,
      a.size,
      a.contentId,
      bool(a.isInline),
      a.storedPath,
      now()
    )
  return Number(res.lastInsertRowid)
}

interface AttachmentRow {
  id: number
  mail_id: number
  filename: string
  content_type: string
  size: number
  content_id: string | null
  is_inline: number
  stored_path: string | null
}

export function listAttachments(mailId: number): AttachmentMeta[] {
  return plainAll<AttachmentRow>(
    getDb().prepare('SELECT * FROM attachments WHERE mail_id = ? ORDER BY id').all(mailId)
  ).map((r) => ({
    id: r.id,
    mailId: r.mail_id,
    filename: r.filename,
    contentType: r.content_type,
    size: r.size,
    contentId: r.content_id,
    isInline: toBool(r.is_inline),
    storedPath: r.stored_path
  }))
}

export function getAttachment(id: number): AttachmentMeta | undefined {
  const r = plain<AttachmentRow>(
    getDb().prepare('SELECT * FROM attachments WHERE id = ?').get(id)
  )
  if (!r) return undefined
  return {
    id: r.id,
    mailId: r.mail_id,
    filename: r.filename,
    contentType: r.content_type,
    size: r.size,
    contentId: r.content_id,
    isInline: toBool(r.is_inline),
    storedPath: r.stored_path
  }
}

/* ─────────────────────────────── 存档批次 ─────────────────────────────── */

export function insertArchive(a: {
  accountId: number
  tag: string
  sourcePath: string
  kind: string
  imported: number
  skipped: number
  failed: number
}): number {
  const res = getDb()
    .prepare(
      `INSERT INTO archives (account_id, tag, source_path, kind, imported, skipped, failed, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(a.accountId, a.tag, a.sourcePath, a.kind, a.imported, a.skipped, a.failed, now())
  return Number(res.lastInsertRowid)
}

export function listArchives(accountId?: number) {
  const db = getDb()
  const sql = accountId
    ? 'SELECT * FROM archives WHERE account_id = ? ORDER BY created_at DESC'
    : 'SELECT * FROM archives ORDER BY created_at DESC'
  const rows = accountId ? db.prepare(sql).all(accountId) : db.prepare(sql).all()
  return plainAll<{
    id: number
    account_id: number
    tag: string
    source_path: string
    kind: string
    imported: number
    skipped: number
    failed: number
    created_at: number
  }>(rows).map((r) => ({
    id: r.id,
    accountId: r.account_id,
    tag: r.tag,
    sourcePath: r.source_path,
    kind: r.kind,
    imported: r.imported,
    skipped: r.skipped,
    failed: r.failed,
    createdAt: r.created_at
  }))
}

export function deleteArchive(id: number): void {
  getDb().prepare('DELETE FROM archives WHERE id = ?').run(id)
}

/* ─────────────────────────────── 同步状态 ─────────────────────────────── */

export function getSyncState(
  accountId: number,
  folderId: number
): { uidValidity: number | null; lastUid: number } {
  const row = plain<{ uid_validity: number | null; last_uid: number }>(
    getDb()
      .prepare('SELECT uid_validity, last_uid FROM sync_state WHERE account_id = ? AND folder_id = ?')
      .get(accountId, folderId)
  )
  return { uidValidity: row?.uid_validity ?? null, lastUid: row?.last_uid ?? 0 }
}

export function setSyncState(
  accountId: number,
  folderId: number,
  uidValidity: number | null,
  lastUid: number
): void {
  getDb()
    .prepare(
      `INSERT INTO sync_state (account_id, folder_id, uid_validity, last_uid, last_sync_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(account_id, folder_id) DO UPDATE SET
         uid_validity = excluded.uid_validity,
         last_uid = excluded.last_uid,
         last_sync_at = excluded.last_sync_at`
    )
    .run(accountId, folderId, uidValidity, lastUid, now())
}

/* ─────────────────────────────── 自动规则 ─────────────────────────────── */

interface RuleRow {
  id: number
  name: string
  enabled: number
  priority: number
  account_id: number | null
  match_mode: string
  conditions: string
  action: string
  action_folder_id: number | null
  stop: number
  created_at: number
}

function mapRule(row: RuleRow): Rule {
  let conditions: RuleCondition[] = []
  try {
    const parsed = JSON.parse(row.conditions)
    if (Array.isArray(parsed)) conditions = parsed as RuleCondition[]
  } catch {
    conditions = []
  }
  return {
    id: row.id,
    name: row.name,
    enabled: toBool(row.enabled),
    priority: row.priority,
    accountId: row.account_id,
    matchMode: row.match_mode === 'any' ? 'any' : 'all',
    conditions,
    action: row.action as Rule['action'],
    actionFolderId: row.action_folder_id,
    stop: toBool(row.stop),
    createdAt: row.created_at
  }
}

export function listRules(accountId?: number): Rule[] {
  const db = getDb()
  const sql = accountId
    ? `SELECT * FROM rules WHERE account_id IS NULL OR account_id = ?
        ORDER BY priority ASC, id ASC`
    : 'SELECT * FROM rules ORDER BY priority ASC, id ASC'
  const rows = accountId
    ? db.prepare(sql).all(accountId)
    : db.prepare(sql).all()
  return plainAll<RuleRow>(rows).map(mapRule)
}

export function getRule(id: number): Rule | undefined {
  const row = plain<RuleRow>(getDb().prepare('SELECT * FROM rules WHERE id = ?').get(id))
  return row ? mapRule(row) : undefined
}

export function saveRule(draft: RuleDraft): Rule {
  const db = getDb()
  const conditions = JSON.stringify(draft.conditions ?? [])
  const matchMode = draft.matchMode === 'any' ? 'any' : 'all'
  const stop = bool(draft.stop !== false)
  const enabled = bool(draft.enabled !== false)
  const priority = Number.isFinite(draft.priority) ? draft.priority : 100
  const accountId = draft.accountId ?? null
  const actionFolderId =
    draft.action === 'move' || draft.action === 'mark_read_move'
      ? (draft.actionFolderId ?? null)
      : null

  if (draft.id) {
    db.prepare(
      `UPDATE rules SET name = ?, enabled = ?, priority = ?, account_id = ?,
              match_mode = ?, conditions = ?, action = ?, action_folder_id = ?, stop = ?
        WHERE id = ?`
    ).run(
      draft.name,
      enabled,
      priority,
      accountId,
      matchMode,
      conditions,
      draft.action,
      actionFolderId,
      stop,
      draft.id
    )
    return getRule(draft.id)!
  }

  const res = db
    .prepare(
      `INSERT INTO rules
         (name, enabled, priority, account_id, match_mode, conditions,
          action, action_folder_id, stop, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      draft.name,
      enabled,
      priority,
      accountId,
      matchMode,
      conditions,
      draft.action,
      actionFolderId,
      stop,
      now()
    )
  return getRule(Number(res.lastInsertRowid))!
}

export function deleteRule(id: number): void {
  getDb().prepare('DELETE FROM rules WHERE id = ?').run(id)
}

export function setRuleEnabled(id: number, enabled: boolean): void {
  getDb().prepare('UPDATE rules SET enabled = ? WHERE id = ?').run(bool(enabled), id)
}

/* ── 规则的执行状态 ── */

export function isRulesDone(mailId: number): boolean {
  const row = plain<{ rules_done: number }>(
    getDb().prepare('SELECT rules_done FROM mails WHERE id = ?').get(mailId)
  )
  return toBool(row?.rules_done)
}

export function setMailRulesDone(mailId: number, done: boolean): void {
  getDb().prepare('UPDATE mails SET rules_done = ? WHERE id = ?').run(bool(done), mailId)
}

/** 已经对哪些规则执行过动作（防止重复执行，见 schemas 里的注释） */
export function getMailRulesFired(mailId: number): number[] {
  const row = plain<{ rules_fired: string | null }>(
    getDb().prepare('SELECT rules_fired FROM mails WHERE id = ?').get(mailId)
  )
  if (!row?.rules_fired) return []
  try {
    const parsed = JSON.parse(row.rules_fired)
    return Array.isArray(parsed) ? (parsed as number[]) : []
  } catch {
    return []
  }
}

export function setMailRulesFired(mailId: number, ruleIds: number[]): void {
  getDb()
    .prepare('UPDATE mails SET rules_fired = ? WHERE id = ?')
    .run(JSON.stringify(ruleIds), mailId)
}

/** 列出所有还没跑过规则的邮件 id（按账户可过滤） */
export function listMailsPendingRules(accountId?: number, limit = 5000): number[] {
  const db = getDb()
  const sql = accountId
    ? `SELECT id FROM mails WHERE rules_done = 0 AND account_id = ? ORDER BY id ASC LIMIT ?`
    : `SELECT id FROM mails WHERE rules_done = 0 ORDER BY id ASC LIMIT ?`
  const rows = accountId
    ? db.prepare(sql).all(accountId, limit)
    : db.prepare(sql).all(limit)
  return plainAll<{ id: number }>(rows).map((r) => r.id)
}

/** 规则预览时要遍历现有邮件，这里按账户取一批 */
export function listMailsForRuleScan(accountId: number | null, limit: number): MailRow[] {
  const db = getDb()
  const sql = accountId
    ? `SELECT ${DETAIL_COLS} FROM mails m
         JOIN folders f ON f.id = m.folder_id
         JOIN accounts a ON a.id = m.account_id
        WHERE m.account_id = ? ORDER BY m.date DESC LIMIT ?`
    : `SELECT ${DETAIL_COLS} FROM mails m
         JOIN folders f ON f.id = m.folder_id
         JOIN accounts a ON a.id = m.account_id
        ORDER BY m.date DESC LIMIT ?`
  const rows = accountId
    ? db.prepare(sql).all(accountId, limit)
    : db.prepare(sql).all(limit)
  return plainAll<MailRow>(rows)
}

/* ─────────────────────────────── 统计 ─────────────────────────────── */

export function totalCounts(): { mails: number; accounts: number } {
  const db = getDb()
  const m = plain<{ c: number }>(db.prepare('SELECT COUNT(*) AS c FROM mails').get())
  const a = plain<{ c: number }>(db.prepare('SELECT COUNT(*) AS c FROM accounts').get())
  return { mails: m?.c ?? 0, accounts: a?.c ?? 0 }
}
