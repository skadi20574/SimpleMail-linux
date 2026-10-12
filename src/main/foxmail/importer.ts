/**
 * Foxmail 存档导入。
 *
 * 流程：识别（archive.ts）→ 逐单元解析 → 落库 → 建全文索引。
 * 全程对用户透明：不需要选择「新版还是老版」，识别器自己判断。
 */

import type { Account, ImportOptions, ImportProgress, ImportResult } from '@shared/types'
import * as repo from '../db/repo'
import { getDb } from '../db'
import { iterateUnit, openArchive } from './archive'
import { storeAttachment } from '../mail/attachments'
import { createAccountDraft } from '@shared/account-defaults'
import { applyRulesToMail } from '../rules'
import { parseMessage } from '../mail/parser'

const LOCAL_ARCHIVE_COLOR = '#8a6d3b'

/** 找到一个（或创建一个）用于承载本地存档的账户 */
export function ensureLocalArchiveAccount(existingId?: number): Account {
  if (existingId) {
    const found = repo.getAccount(existingId)
    if (found) return found
  }
  const all = repo.listAccounts()
  const local = all.find((a) => a.isLocal)
  if (local) return local

  return repo.createAccount(
    createAccountDraft({
      email: 'local-archive@simplemail.local',
      displayName: '本地存档',
      color: LOCAL_ARCHIVE_COLOR,
      syncEnabled: false,
      isLocal: true
    })
  )
}

export async function importArchive(
  options: ImportOptions,
  onProgress: (p: ImportProgress) => void
): Promise<ImportResult> {
  const emit = (p: Partial<ImportProgress> & { phase: ImportProgress['phase']; message: string }): void => {
    onProgress({
      phase: p.phase,
      current: p.current ?? 0,
      total: p.total ?? 0,
      message: p.message,
      imported: p.imported ?? 0,
      skipped: p.skipped ?? 0,
      failed: p.failed ?? 0,
      error: p.error
    })
  }

  const errors: string[] = []
  let imported = 0
  let skipped = 0
  let failed = 0

  emit({ phase: 'detecting', message: '正在识别存档格式…' })
  const opened = await openArchive(options.sourcePath)

  const account = ensureLocalArchiveAccount(options.targetAccountId)
  const tag = options.archiveTag?.trim() || new Date().toISOString().slice(0, 10)

  let units = opened.units
  if (options.includeUnits?.length) {
    const wanted = new Set(options.includeUnits)
    units = units.filter((u) => wanted.has(u.info.name))
  }

  emit({
    phase: 'scanning',
    message: `识别完成：${opened.detection.detail}`,
    total: units.length
  })

  for (let ui = 0; ui < units.length; ui++) {
    const unit = units[ui]
    emit({
      phase: 'parsing',
      current: ui + 1,
      total: units.length,
      message: `正在读取「${unit.info.name}」（${ui + 1}/${units.length}）…`,
      imported,
      skipped,
      failed
    })

    const folder = repo.upsertFolder(
      account.id,
      unit.info.name,
      unit.info.name,
      unit.info.role,
      '/'
    )

    // 记下自标定出来的 .ind 布局，将来导出时可以原样写回
    if (unit.layout) {
      repo.setFolderBoxLayout(folder.id, JSON.stringify(unit.layout))
    }

    // 流式逐封处理：峰值内存只与单封邮件有关，
    // 不再需要先把整个存档（可能是几个 GB）全读进内存。
    let i = 0
    try {
      for await (const raw of iterateUnit(unit)) {
        try {
          // 先插入信封（body 为空），拿到 id 后再写正文与附件
          const probe = await parseMessage(raw)
          const mailId = repo.insertMail({
            accountId: account.id,
            folderId: folder.id,
            uid: null,
            messageId: probe.messageId,
            subject: probe.subject,
            fromName: probe.fromName,
            fromAddr: probe.fromAddr,
            toText: probe.toText,
            ccText: probe.ccText,
            bccText: probe.bccText,
            replyTo: probe.replyTo,
            date: probe.date,
            bodyText: probe.bodyText,
            bodyHtml: probe.bodyHtml,
            rawHeaders: probe.rawHeaders,
            inReplyTo: probe.inReplyTo,
            references: probe.references,
            size: probe.size,
            unread: false,
            flagged: false,
            hasAttachments: probe.attachments.length > 0,
            source: 'foxmail',
            archiveTag: tag
          })

          if (mailId === null) {
            skipped++
          } else {
            for (let a = 0; a < probe.attachments.length; a++) {
              const att = probe.attachments[a]
              let storedPath: string | null = null
              try {
                storedPath = storeAttachment(account.id, mailId, att, a + 1)
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
            imported++
            // 导入的历史邮件同样走一遍规则，方便一次性整理好归档
            try {
              applyRulesToMail(mailId, true)
            } catch {
              /* 规则出错不影响导入 */
            }
          }
        } catch (err) {
          failed++
          if (errors.length < 50) {
            errors.push(`第 ${i + 1} 封解析失败：${err instanceof Error ? err.message : String(err)}`)
          }
        }

        if (i % 25 === 0) {
          emit({
            phase: 'storing',
            current: ui + 1,
            total: units.length,
            message:
              `「${unit.info.name}」已处理 ${i + 1}` +
              (unit.info.estimatedCount > 0 ? `/${unit.info.estimatedCount}` : ''),
            imported,
            skipped,
            failed
          })
        }
        i++
      }
    } catch (err) {
      // 流式读取中途失败（比如扫描到坏块）：保留已经导入的部分，记录错误继续下一个单元
      const msg = `「${unit.info.name}」读取中断：${err instanceof Error ? err.message : String(err)}`
      errors.push(msg)
      failed++
    }

    if (unit.info.estimatedCount < 0) unit.info.estimatedCount = i
  }

  emit({ phase: 'indexing', message: '正在整理全文索引…', imported, skipped, failed })
  try {
    getDb().exec("INSERT INTO mails_fts(mails_fts) VALUES('optimize')")
  } catch {
    /* optimize 失败不影响数据 */
  }

  repo.insertArchive({
    accountId: account.id,
    tag,
    sourcePath: options.sourcePath,
    kind: opened.detection.kind,
    imported,
    skipped,
    failed
  })

  emit({
    phase: 'done',
    message: `导入完成：新增 ${imported} 封，跳过重复 ${skipped} 封，失败 ${failed} 封`,
    imported,
    skipped,
    failed
  })

  return {
    ok: true,
    detection: opened.detection,
    imported,
    skipped,
    failed,
    accountId: account.id,
    errors
  }
}
