/**
 * 全文索引层。
 *
 * 设计要点（都是为了「按字段专项搜索」和「相关度排序」）：
 *
 * 1. **每个字段一组 CJK 列**。原来只有一列 `cjk` 把所有汉字混在一起，
 *    能搜但没法限定「只在发件人里找」。现在拆成
 *    `cjk_subject / cjk_sender / cjk_recipients / cjk_body`，
 *    于是 `cjk_sender:"张 三"` 这样的限定查询就能用了。
 *
 * 2. **相关度排序用 bm25()**。实测 contentless 的 FTS5 表也能用 bm25()
 *    （它只需要索引里的词频与文档长度，不需要原文），
 *    返回值越负越相关，所以 `ORDER BY bm25(mails_fts) ASC` 就是最佳匹配在前。
 *
 * 3. 仍然优先使用 contentless 表（content='' + contentless_delete=1），
 *    不重复保存一份正文。
 */

import type { Db } from './sqlite'

export const FTS_TABLE = 'mails_fts'

/** 索引列的固定顺序，插入时必须与建表语句一致 */
export const FTS_COLUMNS = [
  'subject',
  'sender',
  'recipients',
  'body',
  'cjk_subject',
  'cjk_sender',
  'cjk_recipients',
  'cjk_body'
] as const

/** cjk 列的体积上限，防止极端长正文把索引撑爆 */
const CJK_LIMIT = 400_000

/** 需要逐字索引的字符：CJK 表意文字、扩展区、假名、谚文、全角符号 */
const CJK_CHAR_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f\uac00-\ud7af]/

/** 把一段文本里的逐字检索字符用空格分开（只保留这些字符，西文不进 cjk 列） */
export function cjkIndexText(text: string | null | undefined, limit = CJK_LIMIT): string {
  if (!text) return ''
  const out: string[] = []
  for (const ch of text) {
    if (CJK_CHAR_RE.test(ch)) out.push(ch)
    if (out.length >= limit) break
  }
  return out.join(' ')
}

export interface IndexableMail {
  id: number
  subject: string
  fromName: string
  fromAddr: string
  toText: string
  ccText: string
  bodyText: string
}

function insertRow(db: Db, mail: IndexableMail): void {
  const sender = `${mail.fromName} ${mail.fromAddr}`.trim()
  const recipients = `${mail.toText} ${mail.ccText}`.trim()
  db.prepare(
    `INSERT INTO ${FTS_TABLE}
       (rowid, subject, sender, recipients, body,
        cjk_subject, cjk_sender, cjk_recipients, cjk_body)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    mail.id,
    mail.subject ?? '',
    sender,
    recipients,
    mail.bodyText ?? '',
    cjkIndexText(mail.subject),
    cjkIndexText(sender),
    cjkIndexText(recipients),
    cjkIndexText(mail.bodyText)
  )
}

/** 写入 / 更新一封邮件的索引 */
export function indexMail(db: Db, mail: IndexableMail): void {
  db.prepare(`DELETE FROM ${FTS_TABLE} WHERE rowid = ?`).run(mail.id)
  insertRow(db, mail)
}

export function unindexMail(db: Db, mailId: number): void {
  db.prepare(`DELETE FROM ${FTS_TABLE} WHERE rowid = ?`).run(mailId)
}

/* ───────────────────────── 建表与重建 ───────────────────────── */

const FTS_CONTENTLESS = `
CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
  subject, sender, recipients, body,
  cjk_subject, cjk_sender, cjk_recipients, cjk_body,
  content='',
  contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);
`

const FTS_PLAIN = `
CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
  subject, sender, recipients, body,
  cjk_subject, cjk_sender, cjk_recipients, cjk_body,
  tokenize='unicode61 remove_diacritics 2'
);
`

/** 现有的 FTS 表是否还是「单列 cjk」的老结构 */
export function ftsNeedsRebuild(db: Db): boolean {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
    .get(FTS_TABLE) as { sql: string | null } | undefined
  if (!row) return true
  const sql = String(row.sql ?? '')
  // 老结构里没有 cjk_subject 这类分字段列
  return !sql.includes('cjk_subject')
}

export function dropFts(db: Db): void {
  db.exec(`DROP TABLE IF EXISTS ${FTS_TABLE}`)
}

/**
 * 创建 FTS 表。优先用 contentless，当前 SQLite 不支持时退回普通表。
 * @returns true 表示用的是 contentless 表
 */
export function createFts(db: Db): boolean {
  try {
    db.exec(FTS_CONTENTLESS)
    return true
  } catch {
    db.exec(FTS_PLAIN)
    return false
  }
}

/**
 * 重建整个索引。
 *
 * 迁移时必须要走这一步：FTS 表结构变了（多出分字段的 cjk 列），
 * 老索引没法沿用。**只重建索引，不碰 mails 表** —— 邮件一封都不会丢。
 */
export interface RebuildResult {
  indexed: number
  contentless: boolean
}

export function rebuildFts(
  db: Db,
  onProgress?: (done: number, total: number) => void
): RebuildResult {
  const totalRow = db.prepare('SELECT COUNT(*) AS c FROM mails').get() as { c: number }
  const total = totalRow?.c ?? 0

  dropFts(db)
  const contentless = createFts(db)

  const BATCH = 500
  let done = 0
  for (let offset = 0; offset < total; offset += BATCH) {
    const rows = db
      .prepare(
        `SELECT id, subject, from_name, from_addr, to_text, cc_text, body_text
           FROM mails ORDER BY id LIMIT ? OFFSET ?`
      )
      .all(BATCH, offset) as {
      id: number
      subject: string
      from_name: string
      from_addr: string
      to_text: string
      cc_text: string
      body_text: string
    }[]

    db.exec('BEGIN')
    try {
      for (const r of rows) {
        insertRow(db, {
          id: r.id,
          subject: r.subject ?? '',
          fromName: r.from_name ?? '',
          fromAddr: r.from_addr ?? '',
          toText: r.to_text ?? '',
          ccText: r.cc_text ?? '',
          bodyText: r.body_text ?? ''
        })
        done++
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    onProgress?.(done, total)
  }

  return { indexed: done, contentless }
}

/** 索引里的行数（体检 / 自检用） */
export function ftsRowCount(db: Db): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${FTS_TABLE}`).get() as { c: number }
  return row?.c ?? 0
}
