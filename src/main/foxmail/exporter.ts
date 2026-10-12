/**
 * 存档导出。
 *
 * 一次可以同时产出四种形态（用户选择「两边都要」）：
 *   · `.fox`      —— SimpleMail 自有容器，自带清单，本程序可 100% 无损读回；
 *   · `.box/.ind` —— 老版 Foxmail 的目录结构。若该文件夹当初就是从 Foxmail
 *                    导入的，会**沿用当时自标定出来的索引布局**写回，
 *                    保证「导出成同样格式」；否则用内置的兼容布局。
 *   · `.eml`      —— 每封一个文件，最通用的交换格式（Foxmail 可直接导入）；
 *   · `.mbox`     —— 标准 mbox，Thunderbird / mutt / Outlook 都能读。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExportOptions, ExportProgress, ExportResult, Folder } from '@shared/types'
import * as repo from '../db/repo'
import { buildRfc822 } from '../mail/parser'
import { safeFilename } from '../mail/attachments'
import { buildFoxContainer, type FoxManifestFolder } from './fox'
import { buildInd, DEFAULT_IND_LAYOUT, type IndLayout } from './boxind'
import { FOX_SEPARATOR } from './carve'

interface RawMail {
  id: number
  folder: Folder
  data: Buffer
  date: number
  subject: string
  fromAddr: string
  messageId: string | null
}

function readAttachmentData(path: string | null): Buffer | null {
  if (!path) return null
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}

function buildRawForMail(id: number): Buffer | null {
  const row = repo.getMailFull(id)
  if (!row) return null

  const attachments = row.attachments.map((a) => {
    const data = readAttachmentData(a.storedPath)
    return {
      filename: a.filename,
      contentType: a.contentType,
      contentId: a.contentId,
      data: data ?? Buffer.alloc(0)
    }
  })

  return buildRfc822({
    rawHeaders: row.raw_headers,
    subject: row.subject,
    fromName: row.from_name,
    fromAddr: row.from_addr,
    toText: row.to_text,
    ccText: row.cc_text,
    date: row.date,
    messageId: row.message_id,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    attachments
  })
}

function uniqueDir(base: string): string {
  let target = base
  let i = 1
  // 不覆盖已有导出：加序号
  for (;;) {
    try {
      mkdirSync(target, { recursive: false })
      return target
    } catch (err) {
      const e = err as { code?: string }
      if (e.code !== 'EEXIST') {
        mkdirSync(target, { recursive: true })
        return target
      }
      i++
      target = `${base}_${i}`
      if (i > 200) return target
    }
  }
}

export async function exportArchive(
  options: ExportOptions,
  onProgress: (p: ExportProgress) => void
): Promise<ExportResult> {
  const emit = (
    p: Partial<ExportProgress> & { phase: ExportProgress['phase']; message: string }
  ): void => {
    onProgress({
      phase: p.phase,
      current: p.current ?? 0,
      total: p.total ?? 0,
      message: p.message,
      error: p.error
    })
  }

  const errors: string[] = []
  const files: string[] = []

  const account = repo.getAccount(options.accountId)
  if (!account) throw new Error('账户不存在')

  const allFolders = repo.listFolders(options.accountId)
  const folders = options.folderIds.length
    ? allFolders.filter((f) => options.folderIds.includes(f.id))
    : allFolders

  if (!folders.length) throw new Error('没有选择要导出的文件夹')

  const jobs: { folder: Folder; ids: number[] }[] = []
  let total = 0
  for (const folder of folders) {
    const ids = repo.getMailsForExport([folder.id])
    if (ids.length) jobs.push({ folder, ids })
    total += ids.length
  }
  if (!total) throw new Error('所选文件夹里没有邮件')

  emit({ phase: 'collecting', current: 0, total, message: `准备导出 ${total} 封邮件…` })

  // 一次性把所有报文读进内存，避免四种格式重复读盘
  const rawsByFolder = new Map<number, RawMail[]>()
  let done = 0
  for (const job of jobs) {
    const list: RawMail[] = []
    for (const id of job.ids) {
      try {
        const data = buildRawForMail(id)
        if (!data) continue
        const row = repo.getMailFull(id)
        list.push({
          id,
          folder: job.folder,
          data,
          date: row?.date ?? 0,
          subject: row?.subject ?? '',
          fromAddr: row?.from_addr ?? '',
          messageId: row?.message_id ?? null
        })
      } catch (err) {
        if (errors.length < 50) {
          errors.push(`邮件 #${id} 导出失败：${err instanceof Error ? err.message : String(err)}`)
        }
      }
      done++
      if (done % 50 === 0) {
        emit({ phase: 'collecting', current: done, total, message: `已收集 ${done}/${total}` })
      }
    }
    rawsByFolder.set(job.folder.id, list)
  }

  const root = uniqueDir(join(options.outDir, options.baseName))
  mkdirSync(root, { recursive: true })

  const formats = new Set(options.formats)
  const baseName = safeFilename(options.baseName || 'SimpleMail存档')

  // ── 自有容器 .fox ────────────────────────────────────────────────
  if (formats.has('fox')) {
    emit({ phase: 'writing', current: 0, total, message: '正在写入 .fox 存档…' })
    const chunks: Buffer[] = []
    let offset = 0
    const manifestFolders: FoxManifestFolder[] = []

    for (const job of jobs) {
      const list = rawsByFolder.get(job.folder.id) ?? []
      const mails = list.map((m) => {
        const entry = {
          offset,
          length: m.data.length,
          date: m.date,
          subject: m.subject,
          fromAddr: m.fromAddr,
          messageId: m.messageId,
          accountEmail: account.email
        }
        chunks.push(m.data)
        offset += m.data.length
        return entry
      })
      manifestFolders.push({ name: job.folder.name, role: job.folder.role, mails })
    }

    const container = buildFoxContainer(
      {
        createdAt: new Date().toISOString(),
        account: { email: account.email, displayName: account.displayName },
        archiveTag: options.baseName,
        folders: manifestFolders
      },
      Buffer.concat(chunks)
    )
    const foxPath = join(root, `${baseName}.fox`)
    writeFileSync(foxPath, container)
    files.push(foxPath)
  }

  // ── 老版 Foxmail 目录 .box + .ind ────────────────────────────────
  if (formats.has('boxind')) {
    emit({ phase: 'writing', current: 0, total, message: '正在写入 .box / .ind…' })
    const dir = join(root, 'boxind')
    mkdirSync(dir, { recursive: true })
    for (const job of jobs) {
      const list = rawsByFolder.get(job.folder.id) ?? []
      if (!list.length) continue
      const layoutJson = repo.getFolderBoxLayout(job.folder.id)
      let layout: IndLayout = DEFAULT_IND_LAYOUT
      if (layoutJson) {
        try {
          layout = { ...DEFAULT_IND_LAYOUT, ...(JSON.parse(layoutJson) as IndLayout) }
        } catch {
          layout = DEFAULT_IND_LAYOUT
        }
      }
      const name = safeFilename(job.folder.name || `folder_${job.folder.id}`)
      const chunks: Buffer[] = []
      const entries: { id: number; offset: number; deleted: boolean }[] = []
      const head = Buffer.alloc(0x40)
      head.write('SimpleMail', 0, 'ascii')
      chunks.push(head)
      let offset = head.length
      list.forEach((m, i) => {
        entries.push({ id: i + 1, offset, deleted: false })
        chunks.push(FOX_SEPARATOR)
        chunks.push(m.data)
        offset += FOX_SEPARATOR.length + m.data.length
      })
      const boxPath = join(dir, `${name}.box`)
      const indPath = join(dir, `${name}.ind`)
      writeFileSync(boxPath, Buffer.concat(chunks))
      writeFileSync(indPath, buildInd(layout, entries))
      files.push(boxPath, indPath)
    }
  }

  // ── .eml 集合 ────────────────────────────────────────────────────
  if (formats.has('eml')) {
    emit({ phase: 'writing', current: 0, total, message: '正在写入 .eml 文件…' })
    const dir = join(root, 'eml')
    mkdirSync(dir, { recursive: true })
    for (const job of jobs) {
      const list = rawsByFolder.get(job.folder.id) ?? []
      if (!list.length) continue
      const sub = join(dir, safeFilename(job.folder.name || `folder_${job.folder.id}`))
      mkdirSync(sub, { recursive: true })
      list.forEach((m, i) => {
        const stamp = m.date ? new Date(m.date).toISOString().slice(0, 10) : 'nodate'
        const name = `${String(i + 1).padStart(6, '0')}_${stamp}_${safeFilename(
          m.subject || '无主题'
        ).slice(0, 60)}.eml`
        const p = join(sub, name)
        writeFileSync(p, m.data)
        files.push(p)
      })
    }
  }

  // ── .mbox ────────────────────────────────────────────────────────
  if (formats.has('mbox')) {
    emit({ phase: 'writing', current: 0, total, message: '正在写入 .mbox…' })
    const dir = join(root, 'mbox')
    mkdirSync(dir, { recursive: true })
    for (const job of jobs) {
      const list = rawsByFolder.get(job.folder.id) ?? []
      if (!list.length) continue
      const parts: Buffer[] = []
      for (const m of list) {
        const fromLine = `From ${m.fromAddr || 'unknown'} ${new Date(
          m.date || Date.now()
        ).toUTCString()}\n`
        parts.push(Buffer.from(fromLine, 'utf8'))
        parts.push(m.data)
        parts.push(Buffer.from('\n', 'utf8'))
      }
      const p = join(dir, `${safeFilename(job.folder.name || `folder_${job.folder.id}`)}.mbox`)
      writeFileSync(p, Buffer.concat(parts))
      files.push(p)
    }
  }

  emit({ phase: 'done', current: total, total, message: `导出完成，共 ${files.length} 个文件` })

  return { ok: true, files, exported: total, errors }
}
