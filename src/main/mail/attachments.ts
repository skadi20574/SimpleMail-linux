/**
 * 附件落盘。
 *
 * 约定（需求 8）：附件**不入库**，只把路径和元数据写进 SQLite。
 * 目录结构：<userData>/attachments/<accountId>/<mailId>/<序号>_<安全文件名>
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { attachmentsRoot } from '../paths'
import type { ParsedAttachment } from './parser'

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g

export function safeFilename(name: string): string {
  const cleaned = (name || 'unnamed')
    .replace(ILLEGAL, '_')
    .replace(/^\.+/, '')
    .trim()
  const trimmed = cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned
  return trimmed || 'unnamed'
}

export function messageAttachmentDir(accountId: number, mailId: number): string {
  const dir = join(attachmentsRoot(), String(accountId), String(mailId))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 把附件写到磁盘。已经存在同名文件时自动加序号，绝不覆盖。
 * @returns 落盘的绝对路径
 */
export function storeAttachment(
  accountId: number,
  mailId: number,
  att: ParsedAttachment,
  index: number
): string {
  const dir = messageAttachmentDir(accountId, mailId)
  const base = safeFilename(att.filename)
  const ext = extname(base)
  const stem = base.slice(0, base.length - ext.length) || 'attachment'

  let target = join(dir, `${index}_${base}`)
  let attempt = 1
  while (existsSync(target)) {
    target = join(dir, `${index}_${stem}_${attempt}${ext}`)
    attempt++
    if (attempt > 500) break
  }
  writeFileSync(target, att.content)
  return target
}

/** 把「撰写邮件」时用户选择的本地文件复制进附件目录，交给发送流程使用 */
export function importExternalFile(
  accountId: number,
  mailId: number,
  srcPath: string,
  index: number,
  filename?: string
): string {
  const dir = messageAttachmentDir(accountId, mailId)
  const base = safeFilename(filename ?? srcPath.split('/').pop() ?? 'attachment')
  let target = join(dir, `${index}_${base}`)
  let attempt = 1
  while (existsSync(target)) {
    target = join(dir, `${index}_${base}_${attempt}`)
    attempt++
    if (attempt > 500) break
  }
  copyFileSync(srcPath, target)
  return target
}

/** 草稿附件暂存目录（草稿还没落库时用的中转） */
export function draftAttachmentDir(draftKey: string): string {
  const dir = join(attachmentsRoot(), 'drafts', safeFilename(draftKey))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
