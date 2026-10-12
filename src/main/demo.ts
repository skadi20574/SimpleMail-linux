/**
 * 演示数据种子（开发用）。
 *
 * 造一批贴近真实使用的中文邮件，用来在本机预览界面、验证三栏布局、
 * 中文全文搜索和附件显示。**不会**在正常运行中被调用。
 *
 * 运行：npm run demo
 */

import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as repo from './db/repo'
import { ensureLocalArchiveAccount } from './foxmail/importer'
import { messageAttachmentDir } from './mail/attachments'
import { createAccountDraft } from '@shared/account-defaults'

const SUBJECTS: [string, string][] = [
  ['2024年度销售季度报告', '附件是本年度第一季度的销售汇总，请各位查收并补充各自区域的数据。'],
  ['关于下周技术方案评审的通知', '定于下周三上午十点在 3 楼会议室进行技术方案评审，请提前准备好材料。'],
  ['合同盖章件回传', '合同双方已盖章，扫描件见附件，请归档留存。'],
  ['Invoice for March 2024', 'Please find the invoice for March attached. Payment due in 30 days.'],
  ['月会纪要（3月）', '本次月会讨论了三个议题：项目进度、人员安排、下季度目标。纪要如下。'],
  ['服务器磁盘告警处理结果', '磁盘使用率已从 92% 降到 61%，清理了历史日志与临时文件。'],
  ['报销单据已提交', '本月报销单据已在系统中提交，请审批。'],
  ['供应商报价对比表', '三家供应商的报价对比如附件，建议选择第二家。'],
  ['年会节目报名', '年会节目报名截止到本周五，请各部门尽快汇总。'],
  ['系统升级维护窗口通知', '计划本周六 22:00 - 24:00 进行系统升级，期间服务不可用。'],
  ['客户反馈问题跟进', '客户反馈的登录超时问题已定位，是会话过期时间配置过短导致。'],
  ['出差申请已批准', '你的出差申请已通过审批，请按流程预订机票与酒店。'],
  ['新同事入职介绍', '向大家介绍新同事小王，下周一开始加入我们团队。'],
  ['季度绩效考核安排', '本季度绩效考核面谈安排见附件，请按时间表进行。'],
  ['关于调整办公时间的通知', '自下月起，办公时间调整为 9:00 - 18:00，午休一小时。']
]

const SENDERS: [string, string][] = [
  ['张伟', 'zhangwei@qq.com'],
  ['李娜', 'lina@163.com'],
  ['王强', 'wangqiang@exmail.qq.com'],
  ['刘敏', 'liumin@126.com'],
  ['陈静', 'chenjing@example.com'],
  ['赵鹏', 'zhaopeng@sina.com']
]

function seed(): void {
  ensureLocalArchiveAccount()

  const work = repo.createAccount(
    createAccountDraft({
      email: 'zhangsan@qq.com',
      displayName: '张三',
      imapHost: 'imap.qq.com',
      imapSecure: true,
      smtpHost: 'smtp.qq.com',
      signature: '此致\n张三\n研发部 · 138-0000-0000',
      color: '#2f7fd8',
      syncEnabled: true
    })
  )

  const personal = repo.createAccount(
    createAccountDraft({
      email: 'zhangsan@163.com',
      displayName: '个人邮箱',
      imapHost: 'imap.163.com',
      imapSecure: true,
      smtpHost: 'smtp.163.com',
      signature: '张三',
      color: '#2e9c5a',
      syncEnabled: true
    })
  )

  // 一个 POP3 账户：只有收件箱是「服务器来的」，其余都是本地文件夹
  const pop3 = repo.createAccount(
    createAccountDraft({
      email: 'laoyouxiang@163.com',
      displayName: '老邮箱（POP3）',
      protocol: 'pop3',
      imapHost: 'imap.163.com',
      pop3Host: 'pop.163.com',
      pop3Secure: true,
      smtpHost: 'smtp.163.com',
      signature: '张三',
      color: '#c8860d',
      syncEnabled: true,
      pop3DeleteAfterFetch: false
    })
  )

  const foldersOf = (accountId: number): Record<string, number> => {
    const inbox = repo.upsertFolder(accountId, 'INBOX', '收件箱', 'inbox')
    const sent = repo.upsertFolder(accountId, 'Sent', '已发送', 'sent')
    const drafts = repo.upsertFolder(accountId, 'Drafts', '草稿箱', 'drafts')
    const junk = repo.upsertFolder(accountId, 'Junk', '垃圾邮件', 'junk')
    const trash = repo.upsertFolder(accountId, 'Trash', '垃圾箱', 'trash')
    repo.upsertFolder(accountId, 'Archive/2024', '2024 归档', 'archive')
    return { inbox: inbox.id, sent: sent.id, drafts: drafts.id, junk: junk.id, trash: trash.id }
  }

  const workFolders = foldersOf(work.id)
  const personalFolders = foldersOf(personal.id)

  const localAccount = repo.listAccounts().find((a) => a.isLocal)!
  const localFolders = foldersOf(localAccount.id)

  const now = Date.now()
  let n = 0

  const add = (
    accountId: number,
    folderId: number,
    i: number,
    opts: { unread: boolean; flagged?: boolean; source?: 'imap' | 'pop3' | 'foxmail'; tag?: string | null; withAttachment: boolean }
  ): void => {
    const [subject, body] = SUBJECTS[i % SUBJECTS.length]
    const [fromName, fromAddr] = SENDERS[i % SENDERS.length]
    const date = now - i * 5.5 * 3600 * 1000

    const id = repo.insertMail({
      accountId,
      folderId,
      uid: opts.source === 'foxmail' ? null : 1000 + i,
      messageId: `${accountId}-${folderId}-${i}@demo.simplemail`,
      subject,
      fromName,
      fromAddr,
      toText: '张三 <zhangsan@qq.com>',
      ccText: i % 5 === 0 ? '李娜 <lina@163.com>' : '',
      bccText: '',
      replyTo: '',
      date,
      bodyText: `${body}\n\n${'—— 本邮件为演示数据，用于预览界面效果。'.repeat(1)}\n\n如需回复请直接点击上方「回复」按钮。`,
      bodyHtml: null,
      rawHeaders:
        `Return-Path: <${fromAddr}>\r\nFrom: "${fromName}" <${fromAddr}>\r\nTo: "张三" <zhangsan@qq.com>\r\n` +
        `Subject: ${subject}\r\nDate: ${new Date(date).toUTCString()}\r\n` +
        `Message-ID: <${accountId}-${folderId}-${i}@demo.simplemail>\r\nMIME-Version: 1.0\r\n` +
        `Content-Type: text/plain; charset=UTF-8`,
      inReplyTo: null,
      references: null,
      size: body.length + 900,
      unread: opts.unread,
      flagged: opts.flagged ?? false,
      hasAttachments: opts.withAttachment,
      source: opts.source ?? 'imap',
      archiveTag: opts.tag ?? null
    })

    if (id !== null && opts.withAttachment) {
      const dir = messageAttachmentDir(accountId, id)
      const files: [string, string, string][] = [
        ['季度数据汇总.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '演示用表格内容'],
        ['合同扫描件.pdf', 'application/pdf', '%PDF-1.4 演示用 PDF 内容']
      ]
      files.forEach(([name, type, content], k) => {
        const full = join(dir, `${k + 1}_${name}`)
        writeFileSync(full, content)
        repo.insertAttachment({
          mailId: id,
          filename: name,
          contentType: type,
          size: content.length,
          contentId: null,
          isInline: false,
          storedPath: full
        })
      })
    }
    n++
  }

  // 工作邮箱收件箱：混合已读/未读、部分带附件
  for (let i = 0; i < 34; i++) {
    add(work.id, workFolders.inbox, i, {
      unread: i < 9,
      flagged: i % 7 === 0,
      withAttachment: i % 4 === 0
    })
  }
  for (let i = 0; i < 9; i++) {
    add(work.id, workFolders.sent, i + 3, { unread: false, withAttachment: i % 5 === 0 })
  }
  add(work.id, workFolders.drafts, 6, { unread: false, withAttachment: false })
  add(work.id, workFolders.junk, 8, { unread: true, withAttachment: false })
  add(work.id, workFolders.trash, 12, { unread: false, withAttachment: false })

  // 个人邮箱
  for (let i = 0; i < 11; i++) {
    add(personal.id, personalFolders.inbox, i + 5, {
      unread: i < 3,
      withAttachment: i % 6 === 0
    })
  }
  for (let i = 0; i < 4; i++) {
    add(personal.id, personalFolders.sent, i + 1, { unread: false, withAttachment: false })
  }

  // 本地存档（模拟从 Foxmail 导入的历史邮件）
  for (let i = 0; i < 26; i++) {
    add(localAccount.id, localFolders.inbox, i + 2, {
      unread: false,
      withAttachment: i % 5 === 0,
      source: 'foxmail',
      tag: i < 13 ? 'Foxmail存档2022' : 'Foxmail存档2023'
    })
  }
  for (let i = 0; i < 8; i++) {
    add(localAccount.id, localFolders.sent, i + 4, {
      unread: false,
      withAttachment: false,
      source: 'foxmail',
      tag: 'Foxmail存档2023'
    })
  }

  // POP3 账户：文件夹路径用 POP3/ 前缀，与实际同步逻辑保持一致
  const pop3Folders = {
    inbox: repo.upsertFolder(pop3.id, 'POP3/INBOX', '收件箱', 'inbox').id,
    sent: repo.upsertFolder(pop3.id, 'POP3/Sent', '已发送', 'sent').id,
    drafts: repo.upsertFolder(pop3.id, 'POP3/Drafts', '草稿箱', 'drafts').id,
    trash: repo.upsertFolder(pop3.id, 'POP3/Trash', '垃圾箱', 'trash').id
  }
  for (let i = 0; i < 14; i++) {
    add(pop3.id, pop3Folders.inbox, i + 7, {
      unread: i < 4,
      withAttachment: i % 6 === 0,
      source: 'pop3'
    })
  }
  for (let i = 0; i < 3; i++) {
    add(pop3.id, pop3Folders.sent, i + 9, { unread: false, withAttachment: false })
  }

  repo.insertArchive({
    accountId: localAccount.id,
    tag: 'Foxmail存档2023',
    sourcePath: 'D:\\Foxmail存档\\FoxmailBackup2023.fox',
    kind: 'foxmail-fox',
    imported: 21,
    skipped: 0,
    failed: 0
  })

  console.log(`演示数据已写入：${n} 封邮件`)
}

app
  .whenReady()
  .then(() => {
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      seed()
    } catch (err) {
      console.error('播种失败：', err)
      app.exit(1)
      return
    }
    app.exit(0)
  })
  .catch((err) => {
    console.error(err)
    app.exit(2)
  })
