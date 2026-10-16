/**
 * 端到端自检（开发用）。
 *
 * 不依赖网络与真实邮箱，构造四种典型存档，跑完整的
 * 识别 → 导入 → 全文搜索 → 导出 → 再导入 的闭环，
 * 用来验证「新老版本自动兼容」和「中文全文检索」确实是通的。
 *
 * 运行：npm run selftest
 */

import { app } from 'electron'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import iconv from 'iconv-lite'

import { closeDb } from './db'
import { openDatabase } from './db/sqlite'
import { initSchema, migrate, SCHEMA_VERSION } from './db/schema'
import { hasVisibleAttachments } from './mail/parser'
import { nextAfterDelete } from '@shared/mail-nav'
import { checkDataDirTarget, legacyDataDir } from './data-dir'
import * as repo from './db/repo'
import { collectUnit, inMemoryLimit, iterateUnit, openArchive, inspectArchive } from './foxmail/archive'
import { importArchive, ensureLocalArchiveAccount } from './foxmail/importer'
import { exportArchive } from './foxmail/exporter'
import { FOX_SEPARATOR } from './foxmail/carve'
import { buildInd, DEFAULT_IND_LAYOUT } from './foxmail/boxind'
import { buildMatchQuery, buildMatchQueryMulti, compactCriteria, countCriteria } from './search'
import {
  parseMailto,
  parseMailtoFromArgv,
  buildMailto,
  isMailtoRequestEmpty
} from '@shared/mailto'
import {
  DESKTOP_ID,
  desktopFileBody,
  mailtoStatus,
  resolveMailtoAttachments,
  userDesktopPath
} from './mailto'
import { createAccountDraft } from '@shared/account-defaults'
import { Pop3Client, syncPop3Account, testPop3 } from './mail/pop3'
import { generateSelfSignedCert, startMockPop3 } from './testing/pop3-mock'
import { deleteMailsPermanently, markMailsFlagged, markMailsRead, moveMailsToTrash } from './mail/actions'
import { applyRulesToMail, previewRule, runAllRules } from './rules'
import {
  createFolder,
  deleteFolder,
  moveMailsToFolder,
  renameFolder
} from './mail/actions'
import {
  DEFAULT_SHORTCUTS,
  actionForEvent,
  bindingFromEvent,
  findShortcutConflicts,
  prettyBinding,
  resolveShortcuts
} from '@shared/shortcuts'
import { DEFAULT_SETTINGS, loadSettings, normalizeSettings, saveSettings } from './settings'
import { messageAttachmentDir } from './mail/attachments'
import { attachmentsRoot } from './paths'

/* ───────────────────── 测试数据构造 ───────────────────── */

const CRLF = '\r\n'

let uidCounter = 1

function rfc2047(text: string): string {
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

function makeMessage(opts: {
  index: number
  subject: string
  from: string
  to: string
  body: string
  date: Date
  messageId: string
  attachment?: { name: string; content: Buffer }
  gbkSubject?: string
}): Buffer {
  const id = opts.messageId
  const head: string[] = [
    `Return-Path: <${opts.from}>`,
    `Received: from smtp.example.com (smtp.example.com [10.0.0.${opts.index}])`,
    `\tby mx.example.com with ESMTP id TEST${opts.index};`,
    `\t${opts.date.toUTCString()}`,
    `From: ${rfc2047('张三')} <${opts.from}>`,
    `To: ${opts.to}`,
    `Subject: ${rfc2047(opts.subject)}`,
    `Date: ${opts.date.toUTCString()}`,
    `Message-ID: <${id}>`,
    `MIME-Version: 1.0`
  ]

  if (opts.attachment) {
    const boundary = `----bnd${opts.index}`
    head.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)
    const parts: string[] = []
    parts.push(
      `--${boundary}${CRLF}Content-Type: text/plain; charset=UTF-8${CRLF}Content-Transfer-Encoding: 8bit${CRLF}${CRLF}${opts.body}`
    )
    parts.push(
      `--${boundary}${CRLF}Content-Type: application/octet-stream; name="${opts.attachment.name}"${CRLF}` +
        `Content-Transfer-Encoding: base64${CRLF}` +
        `Content-Disposition: attachment; filename="${opts.attachment.name}"${CRLF}${CRLF}` +
        opts.attachment.content.toString('base64')
    )
    parts.push(`--${boundary}--`)
    return Buffer.from(head.join(CRLF) + CRLF + CRLF + parts.join(CRLF), 'utf8')
  }

  head.push('Content-Type: text/plain; charset=UTF-8')
  head.push('Content-Transfer-Encoding: 8bit')
  return Buffer.from(head.join(CRLF) + CRLF + CRLF + opts.body, 'utf8')
}

/** 构造一封头部是裸 GBK 编码的老邮件（Foxmail 时代很常见） */
function makeGbkMessage(index: number, messageId: string, subject: string, body: string): Buffer {
  const head =
    `Return-Path: <old@163.com>${CRLF}` +
    `Received: from 163.com by local${CRLF}` +
    `From: "李四" <old@163.com>${CRLF}` +
    `To: "王五" <wang@qq.com>${CRLF}` +
    `Subject: ${subject}${CRLF}` +
    `Date: Mon, 12 Mar 2012 09:30:00 +0800${CRLF}` +
    `Message-ID: <${messageId}>${CRLF}` +
    `MIME-Version: 1.0${CRLF}` +
    `Content-Type: text/plain; charset=gb2312${CRLF}` +
    `Content-Transfer-Encoding: 8bit${CRLF}${CRLF}`
  // 头部与正文都按 GB18030 编码写出去，模拟没有任何 RFC2047 声明的老邮件
  void index
  return Buffer.concat([
    iconv.encode(head, 'gb18030'),
    iconv.encode(body, 'gb18030')
  ])
}

function buildSampleMessages(tag: string, count: number, startIndex: number): Buffer[] {
  const subjects = [
    ['2024年度销售季度报告', '正文内容：这是第一季度的销售情况汇总，请查收。'],
    ['合同盖章件回传', '合同已经盖章，扫描件见附件。'],
    ['Invoice for March', 'Please find the invoice attached. Thanks.'],
    ['月会纪要 2024-03', '本次月会讨论了三个议题，纪要如下。'],
    ['技术方案评审邀请', '诚挚邀请您参加下周三的技术方案评审会。']
  ]
  const out: Buffer[] = []
  for (let i = 0; i < count; i++) {
    const [subject, body] = subjects[i % subjects.length]
    const date = new Date(2024, i % 12, (i % 27) + 1, 9 + (i % 8), (i * 7) % 60)
    out.push(
      makeMessage({
        index: startIndex + i,
        subject: `${subject} #${i + 1}`,
        from: `sender${i % 5}@example.com`,
        to: 'me@qq.com',
        body: `${body}\n\n本邮件属于批次 ${tag}，序号 ${i + 1}。`,
        date,
        messageId: `${tag}-${i + 1}@example.com`,
        attachment:
          i % 4 === 0
            ? { name: `附件${i + 1}.txt`, content: Buffer.from(`附件内容 ${tag} #${i + 1}`, 'utf8') }
            : undefined
      })
    )
  }
  return out
}

/* ───────────────────── 断言 ───────────────────── */

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
    console.log(`  ✅ ${name}${detail ? `  (${detail})` : ''}`)
  } else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ❌ ${name}${detail ? `  (${detail})` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

/* ───────────────────── 主流程 ───────────────────── */

async function run(root: string): Promise<void> {

  /* ---------- 1. 构造老版 .box + .ind ---------- */
  section('1. 构造老版 Foxmail 存档（mail/<账户>/*.box + .ind）')
  const boxRoot = join(root, 'foxmail-old', 'mail', 'myaccount')
  mkdirSync(boxRoot, { recursive: true })

  const inboxMsgs = buildSampleMessages('old-inbox', 12, 1)
  const sentMsgs = buildSampleMessages('old-sent', 6, 100)

  const writeBox = (dir: string, name: string, msgs: Buffer[]): void => {
    const chunks: Buffer[] = []
    const head = Buffer.alloc(0x40)
    head.write('Foxmail', 0, 'ascii')
    chunks.push(head)
    const entries: { id: number; offset: number; deleted: boolean }[] = []
    let offset = head.length
    msgs.forEach((m, i) => {
      entries.push({ id: i + 1, offset, deleted: false })
      chunks.push(FOX_SEPARATOR)
      chunks.push(m)
      offset += FOX_SEPARATOR.length + m.length
    })
    writeFileSync(join(dir, `${name}.box`), Buffer.concat(chunks))
    writeFileSync(join(dir, `${name}.ind`), buildInd(DEFAULT_IND_LAYOUT, entries))
  }

  writeBox(boxRoot, 'Inbox', inboxMsgs)
  writeBox(boxRoot, 'Sent', sentMsgs)
  console.log(`  已写出 Inbox.box(${inboxMsgs.length} 封)、Sent.box(${sentMsgs.length} 封)`)

  const det1 = await openArchive(join(root, 'foxmail-old'))
  check('目录被识别为 Foxmail 存档', det1.detection.kind === 'foxmail-boxind', det1.detection.kind)
  check('识别出 2 个文件夹', det1.detection.units.length === 2, `实际 ${det1.detection.units.length}`)
  check(
    '文件夹名归一化为中文',
    det1.detection.units.some((u) => u.name === '收件箱') &&
      det1.detection.units.some((u) => u.name === '已发送'),
    det1.detection.units.map((u) => u.name).join(' / ')
  )

  /* ---------- 2. 构造 .fox 形态的不透明容器 ---------- */
  section('2. 构造 .fox 形态的不透明容器（无分隔符，只能靠报文头雕刻）')
  const opaqueMsgs = buildSampleMessages('fox-file', 7, 200)
  const opaqueParts: Buffer[] = [Buffer.from('FOXMAILARCHIVE\u0000\u0001\u0002\xff\xfe', 'latin1')]
  opaqueMsgs.forEach((m, i) => {
    opaqueParts.push(Buffer.from(`\x00\x00\x00${String(m.length).padStart(6, '0')}\x00`, 'latin1'))
    opaqueParts.push(m)
    opaqueParts.push(Buffer.from('\x00\x00', 'latin1'))
    void i
  })
  const foxPath = join(root, 'FoxmailBackup2024.fox')
  writeFileSync(foxPath, Buffer.concat(opaqueParts))
  console.log(`  已写出 ${foxPath}（${(Buffer.concat(opaqueParts).length / 1024).toFixed(1)} KB）`)

  const det2 = await openArchive(foxPath)
  check('.fox 被识别', det2.detection.kind === 'foxmail-fox', det2.detection.kind)
  const foxUnit = det2.units[0]
  const foxMsgs = await collectUnit(foxUnit)
  check(
    '.fox 里雕刻出全部 7 封邮件',
    foxMsgs.length === 7,
    `实际 ${foxMsgs.length}，策略 ${foxUnit.strategy}`
  )

  /* ---------- 3. 构造 .eml 目录 + zip ---------- */
  section('3. 构造 .eml 目录与 ZIP 存档')
  const emlDir = join(root, 'eml-export', '收件箱')
  mkdirSync(emlDir, { recursive: true })
  const emlMsgs = buildSampleMessages('eml-tree', 4, 300)
  emlMsgs.forEach((m, i) => writeFileSync(join(emlDir, `${i + 1}.eml`), m))

  const det3 = await openArchive(join(root, 'eml-export'))
  check('.eml 目录被识别', det3.detection.units.length >= 1, `单元数 ${det3.detection.units.length}`)
  const emlCount = (await collectUnit(det3.units[0])).length
  check('.eml 目录读到 4 封', emlCount === 4, `实际 ${emlCount}`)

  // 手工拼一个最小 ZIP（store 模式），里面放一个 .box
  const zipMsgs = buildSampleMessages('zip-box', 5, 400)
  const zipBoxContent = (() => {
    const head = Buffer.alloc(0x40)
    const chunks: Buffer[] = [head]
    let offset = head.length
    const entries: { id: number; offset: number; deleted: boolean }[] = []
    zipMsgs.forEach((m, i) => {
      entries.push({ id: i + 1, offset, deleted: false })
      chunks.push(FOX_SEPARATOR)
      chunks.push(m)
      offset += FOX_SEPARATOR.length + m.length
    })
    return { box: Buffer.concat(chunks), ind: buildInd(DEFAULT_IND_LAYOUT, entries) }
  })()

  const makeZip = (files: { name: string; data: Buffer }[]): Buffer => {
    const locals: Buffer[] = []
    const centrals: Buffer[] = []
    let offset = 0
    for (const f of files) {
      const nameBuf = Buffer.from(f.name, 'utf8')
      const crc = crc32(f.data)
      const lh = Buffer.alloc(30)
      lh.writeUInt32LE(0x04034b50, 0)
      lh.writeUInt16LE(20, 4)
      lh.writeUInt16LE(0, 6)
      lh.writeUInt16LE(0, 8) // store
      lh.writeUInt32LE(0, 10) // time/date
      lh.writeUInt32LE(crc, 14)
      lh.writeUInt32LE(f.data.length, 18)
      lh.writeUInt32LE(f.data.length, 22)
      lh.writeUInt16LE(nameBuf.length, 26)
      lh.writeUInt16LE(0, 28)
      locals.push(lh, nameBuf, f.data)

      const ch = Buffer.alloc(46)
      ch.writeUInt32LE(0x02014b50, 0)
      ch.writeUInt16LE(20, 4)
      ch.writeUInt16LE(20, 6)
      ch.writeUInt16LE(0, 8)
      ch.writeUInt16LE(0, 10)
      ch.writeUInt32LE(0, 12)
      ch.writeUInt32LE(crc, 16)
      ch.writeUInt32LE(f.data.length, 20)
      ch.writeUInt32LE(f.data.length, 24)
      ch.writeUInt16LE(nameBuf.length, 28)
      ch.writeUInt16LE(0, 30)
      ch.writeUInt16LE(0, 32)
      ch.writeUInt16LE(0, 34)
      ch.writeUInt16LE(0, 36)
      ch.writeUInt32LE(0, 38)
      ch.writeUInt32LE(offset, 42)
      centrals.push(ch, nameBuf)
      offset += lh.length + nameBuf.length + f.data.length
    }
    const centralBuf = Buffer.concat(centrals)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(files.length, 8)
    eocd.writeUInt16LE(files.length, 10)
    eocd.writeUInt32LE(centralBuf.length, 12)
    eocd.writeUInt32LE(offset, 16)
    return Buffer.concat([...locals, centralBuf, eocd])
  }

  const zipPath = join(root, 'FoxmailBackup2023.zip')
  writeFileSync(
    zipPath,
    makeZip([
      { name: 'mail/account/Inbox.box', data: zipBoxContent.box },
      { name: 'mail/account/Inbox.ind', data: zipBoxContent.ind }
    ])
  )
  const det4 = await openArchive(zipPath)
  check('ZIP 被识别', det4.detection.kind === 'zip', det4.detection.kind)
  const zipLoaded = det4.units.length ? await collectUnit(det4.units[0]) : []
  check('ZIP 内 .box 读出 5 封', zipLoaded.length === 5, `实际 ${zipLoaded.length}`)

  /* ---------- 4. GBK 老邮件 ---------- */
  section('4. 裸 GBK 头部的老邮件')
  const gbkPath = join(root, 'gbk-only.box')
  const gbkMsgs = [
    makeGbkMessage(1, 'gbk-1@163.com', '关于年会的通知', '请大家准时参加年会。'),
    makeGbkMessage(2, 'gbk-2@163.com', '发票已寄出', '发票已于今日寄出，请注意查收。')
  ]
  const gbkChunks: Buffer[] = []
  gbkMsgs.forEach((m) => {
    gbkChunks.push(FOX_SEPARATOR, m)
  })
  writeFileSync(gbkPath, Buffer.concat(gbkChunks))
  const det5 = await openArchive(gbkPath)
  const gbkLoaded = (await collectUnit(det5.units[0])).length
  check('GBK .box 读出 2 封', gbkLoaded === 2, `实际 ${gbkLoaded}`)

  /* ---------- 5. 导入到本地数据库 ---------- */
  section('5. 导入到本地数据库')
  ensureLocalArchiveAccount()
  const account = repo.listAccounts().find((a) => a.isLocal)!
  check('本地存档账户已建立', Boolean(account), account?.email)

  const importOne = async (path: string, tag: string) => {
    const result = await importArchive({ sourcePath: path, archiveTag: tag }, () => {})
    return result
  }

  const r1 = await importOne(join(root, 'foxmail-old'), '存档2022')
  check(
    '老版存档导入 18 封',
    r1.imported === 18,
    `新增 ${r1.imported}，跳过 ${r1.skipped}，失败 ${r1.failed}`
  )

  const r2 = await importOne(foxPath, '存档2024')
  check('.fox 导入 7 封', r2.imported === 7, `新增 ${r2.imported}，失败 ${r2.failed}`)

  const r3 = await importOne(zipPath, '存档2023')
  check('ZIP 导入 5 封', r3.imported === 5, `新增 ${r3.imported}，失败 ${r3.failed}`)

  const r4 = await importOne(gbkPath, '存档2012')
  check('GBK 存档导入 2 封', r4.imported === 2, `新增 ${r4.imported}，失败 ${r4.failed}`)

  const r5 = await importOne(join(root, 'eml-export'), '存档2021')
  check('.eml 目录导入 4 封', r5.imported === 4, `新增 ${r5.imported}，失败 ${r5.failed}`)

  const counts = repo.totalCounts()
  check('库内总邮件数 36', counts.mails === 36, `实际 ${counts.mails}`)

  /* ---------- 6. 重复导入去重 ---------- */
  section('6. 重复导入应全部跳过')
  const r6 = await importOne(join(root, 'foxmail-old'), '存档2022-重复')
  check('重复导入 0 新增', r6.imported === 0, `新增 ${r6.imported}，跳过 ${r6.skipped}`)
  check('重复导入全部识别为重复', r6.skipped === 18, `跳过 ${r6.skipped}`)
  check('库内总数不变', repo.totalCounts().mails === 36, `实际 ${repo.totalCounts().mails}`)

  /* ---------- 7. GBK 主题是否正确解码 ---------- */
  section('7. GBK 邮件主题解码')
  const gbkFolder = repo.listFolders(account.id).find((f) => f.name.includes('gbk-only'))
  if (gbkFolder) {
    const list = repo.listMails({ folderId: gbkFolder.id, limit: 10 })
    const subjects = list.items.map((m) => m.subject).join(' | ')
    check(
      'GBK 主题被正确解码为中文',
      list.items.some((m) => m.subject.includes('年会')) ||
        list.items.some((m) => m.subject.includes('发票')),
      subjects
    )
  } else {
    check('找到 GBK 文件夹', false, repo.listFolders(account.id).map((f) => f.name).join(','))
  }

  /* ---------- 8. 中文全文搜索 ---------- */
  section('8. FTS5 中文与英文全文搜索')
  check(
    '搜索表达式生成正确',
    buildMatchQuery('季度报告') === '"季 度 报 告"',
    String(buildMatchQuery('季度报告'))
  )
  check(
    '中英混合表达式正确',
    buildMatchQuery('发票 invoice') === '"发 票" AND "invoice"',
    String(buildMatchQuery('发票 invoice'))
  )
  check(
    '混合 token「发票PDF」被拆成中文+英文两段',
    buildMatchQuery('发票PDF') === '("发 票" AND "PDF")',
    String(buildMatchQuery('发票PDF'))
  )

  const s1 = repo.listMails({ search: '季度报告', limit: 50 })
  check('中文搜「季度报告」有结果', s1.total > 0, `命中 ${s1.total}`)

  const s2 = repo.listMails({ search: '发票', limit: 50 })
  check('中文两字词「发票」能命中', s2.total > 0, `命中 ${s2.total}`)

  const s3 = repo.listMails({ search: '合同', limit: 50 })
  check('中文两字词「合同」能命中', s3.total > 0, `命中 ${s3.total}`)

  const s4 = repo.listMails({ search: 'invoice', limit: 50 })
  check('英文搜「invoice」有结果', s4.total > 0, `命中 ${s4.total}`)

  const s5 = repo.listMails({ search: '不存在的词xyzzy', limit: 50 })
  check('无关词不返回结果', s5.total === 0, `命中 ${s5.total}`)

  const s6 = repo.listMails({ search: '年会', limit: 50 })
  check('GBK 邮件正文可被搜索到', s6.total > 0, `命中 ${s6.total}`)

  /* ---------- 9. 导出 ---------- */
  section('9. 导出四种格式')
  const outDir = join(root, 'exports')
  mkdirSync(outDir, { recursive: true })
  const folderIds = repo.listFolders(account.id).map((f) => f.id)
  const exp = await exportArchive(
    {
      accountId: account.id,
      folderIds,
      outDir,
      baseName: '完整存档',
      formats: ['fox', 'boxind', 'eml', 'mbox']
    },
    () => {}
  )
  check('导出无致命错误', exp.ok, exp.errors.slice(0, 3).join(' / '))
  check('导出覆盖全部 36 封', exp.exported === 36, `实际 ${exp.exported}`)
  check(
    '产出了 .fox 文件',
    exp.files.some((f) => f.endsWith('.fox')),
    exp.files.filter((f) => f.endsWith('.fox')).join(',')
  )
  check(
    '产出了 .box/.ind',
    exp.files.some((f) => f.endsWith('.box')) && exp.files.some((f) => f.endsWith('.ind'))
  )
  check('产出了 .eml 文件', exp.files.filter((f) => f.endsWith('.eml')).length === 36)
  check('产出了 .mbox 文件', exp.files.some((f) => f.endsWith('.mbox')))

  /* ---------- 10. 导出物可被自己读回 ---------- */
  section('10. 导出的 .fox 与 .box 可被自己无损读回')
  const exportRoot = exp.files[0].slice(0, exp.files[0].lastIndexOf('/'))
  const foxFile = exp.files.find((f) => f.endsWith('.fox'))!
  const detFox = await openArchive(foxFile)
  check('导出的 .fox 被识别为自有容器', detFox.detection.kind === 'foxmail-fox')
  const totalFromFox = (
    await Promise.all(detFox.units.map((u) => collectUnit(u).then((m) => m.length)))
  ).reduce((a, b) => a + b, 0)
  check('导出的 .fox 读回 36 封', totalFromFox === 36, `实际 ${totalFromFox}`)

  const detBox = await openArchive(join(exportRoot, 'boxind'))
  const totalFromBox = (
    await Promise.all(detBox.units.map((u) => collectUnit(u).then((m) => m.length)))
  ).reduce((a, b) => a + b, 0)
  check('导出的 .box/.ind 读回 36 封', totalFromBox === 36, `实际 ${totalFromBox}`)
  check(
    '.box 的 .ind 布局被自标定识别',
    detBox.units.some((u) => u.strategy.includes('ind')),
    detBox.units.map((u) => u.strategy).join(' | ')
  )

  /* ---------- 11. 再导入到新账户，验证往返 ---------- */
  section('11. 导出的存档再导入（往返一致性）')
  const roundTripAccount = repo.createAccount(
    createAccountDraft({
      email: 'roundtrip@simplemail.local',
      displayName: '往返测试',
      color: '#888888',
      syncEnabled: false,
      isLocal: true
    })
  )
  const r7 = await importArchive(
    { sourcePath: foxFile, targetAccountId: roundTripAccount.id, archiveTag: '往返' },
    () => {}
  )
  check('往返导入 36 封', r7.imported === 36, `新增 ${r7.imported}，跳过 ${r7.skipped}，失败 ${r7.failed}`)

  const rtList = repo.listMails({ accountId: roundTripAccount.id, limit: 500 })
  const withBody = rtList.items.filter((m) => m.snippet.length > 0).length
  check('往返后正文非空', withBody === 36, `${withBody}/${rtList.items.length} 有正文`)
  const withAttach = rtList.items.filter((m) => m.hasAttachments).length
  // 附件数：old-inbox 3 + old-sent 2 + fox-file 2 + zip-box 2 + eml-tree 1 = 10
  check('往返后附件标记保留', withAttach === 10, `${withAttach} 封带附件`)
  const placeholders = rtList.items.filter((m) => m.subject === '' && m.fromAddr === '').length
  check('没有把 MIME 分段误当成邮件', placeholders === 0, `${placeholders} 个空壳`)

  /* ---------- 12. 体检报告 ---------- */
  section('12. 存档体检')
  const report = await inspectArchive(foxPath, true)
  check('体检报告有文件头', report.headHex.length > 0, report.headHex.slice(0, 32))
  check('体检报告含扫描结果', report.scanned.length > 0)
  console.log(
    `  体检：kind=${report.kind} size=${report.size} units=${report.units.length} scanned=${report.scanned
      .map((s) => `${s.name}:${s.messages}`)
      .join(',')}`
  )

  /* ---------- 13. 压缩流兜底 ---------- */
  section('13. zlib 压缩存档兜底')
  const inner = buildSampleMessages('deflated', 3, 900)
  const deflated = deflateSync(Buffer.concat(inner))
  // 外面套一层不透明头，让主策略全部失败，只能靠 zlib 兜底
  const deflatePath = join(root, 'compressed.fox')
  writeFileSync(deflatePath, Buffer.concat([Buffer.from('\x7fELF\x02\x01\x01\x00', 'latin1'), deflated]))
  const det6 = await openArchive(deflatePath)
  const deflatedMsgs = await collectUnit(det6.units[0])
  check(
    '压缩存档被兜底解析出 3 封',
    deflatedMsgs.length === 3,
    `实际 ${deflatedMsgs.length}，策略 ${det6.units[0].strategy}`
  )


  /* ---------- 14. POP3 端到端（本地 mock 服务器） ---------- */
  section('14. POP3 收件（对着本地 mock 服务器跑真实协议）')

  // 构造 3 封用于 POP3 的邮件，其中一封刻意让正文里出现以 "." 开头的行，
  // 用来验证点填充（dot-stuffing）还原是否正确。
  const pop3Messages = [
    {
      uid: 'UID-0001',
      raw: makeMessage({
        index: 5001,
        subject: 'POP3 第一封：季度报告',
        from: 'pop3sender@example.com',
        to: 'tester@example.com',
        body: '这是通过 POP3 收到的第一封邮件，正文包含中文。',
        date: new Date(2024, 4, 1, 10, 0),
        messageId: 'pop3-1@example.com'
      })
    },
    {
      uid: 'UID-0002',
      raw: makeMessage({
        index: 5002,
        subject: 'POP3 第二封：带附件',
        from: 'pop3sender@example.com',
        to: 'tester@example.com',
        body: '第二封邮件带一个附件。',
        date: new Date(2024, 4, 2, 11, 30),
        messageId: 'pop3-2@example.com',
        attachment: { name: 'pop3附件.txt', content: Buffer.from('POP3 附件内容', 'utf8') }
      })
    },
    {
      uid: 'UID-0003',
      raw: makeMessage({
        index: 5003,
        subject: 'POP3 第三封：点填充测试',
        from: 'pop3sender@example.com',
        to: 'tester@example.com',
        // 关键：正文里有以 "." 开头的行，POP3 传输时会被写成 ".."
        body: '下面一行以点开头，必须原样还原：\n.\n...这是三个点开头\n正常结束。',
        date: new Date(2024, 4, 3, 9, 15),
        messageId: 'pop3-3@example.com'
      })
    }
  ]

  // 14.1 明文 + UIDL
  const mock1 = await startMockPop3({ messages: pop3Messages, supportUidl: true })
  const pop3Account = repo.createAccount(
    createAccountDraft({
      email: 'tester@example.com',
      displayName: 'POP3 测试',
      protocol: 'pop3',
      pop3Host: '127.0.0.1',
      pop3Port: mock1.port,
      pop3Secure: false,
      smtpHost: '127.0.0.1',
      username: 'tester@example.com',
      password: 'secret',
      syncEnabled: true
    })
  )

  const pop3Test = await testPop3(pop3Account)
  check('POP3 连通性测试通过', pop3Test.ok, pop3Test.error ?? '')

  const popInbox = () =>
    repo.listFolders(pop3Account.id).find((f) => f.role === 'inbox')!

  await syncPop3Account(pop3Account, { onProgress: () => {} })
  const afterFirst = repo.listMails({ folderId: popInbox().id, limit: 100 })
  check('首次 POP3 同步导入 3 封', afterFirst.total === 3, `实际 ${afterFirst.total}`)
  check(
    'POP3 账户自动建好了本地文件夹',
    ['inbox', 'drafts', 'sent', 'trash'].every((r) =>
      repo.listFolders(pop3Account.id).some((f) => f.role === r)
    ),
    repo.listFolders(pop3Account.id).map((f) => f.name).join('/')
  )
  check('服务器收到了 RETR 命令', mock1.state.retrieved.length === 3, `实际 ${mock1.state.retrieved.length}`)
  check(
    '默认不删除服务器邮件（全程没有 DELE）',
    mock1.state.commands.filter((c) => c.toUpperCase().startsWith('DELE')).length === 0
  )

  // 14.2 点填充还原
  const dotMail = afterFirst.items.find((m) => m.subject.includes('点填充'))
  check('找到点填充测试邮件', Boolean(dotMail))
  if (dotMail) {
    const detail = repo.getMail(dotMail.id)!
    const body = detail.bodyText
    const hasSingleDotLine = /(^|\n)\.(\r?\n|$)/.test(body)
    const hasTripleDots = body.includes('...这是三个点开头')
    const hasQuadDots = body.includes('....这是三个点开头')
    check('正文里单独的 "." 行被正确还原', hasSingleDotLine)
    check('三个点开头的内容没有被多还原（无四个点）', hasTripleDots && !hasQuadDots, JSON.stringify(body.slice(-60)))
  }

  // 14.3 UIDL 去重：再同步一次应当 0 新增
  await syncPop3Account(pop3Account, { onProgress: () => {} })
  const afterSecond = repo.listMails({ folderId: popInbox().id, limit: 100 })
  check('再次同步不产生重复（UIDL 去重生效）', afterSecond.total === 3, `实际 ${afterSecond.total}`)

  // 14.4 中文编码与附件
  const attMail = afterSecond.items.find((m) => m.subject.includes('带附件'))
  check('POP3 邮件的中文主题正确', Boolean(attMail), afterSecond.items.map((m) => m.subject).join(' | '))
  if (attMail) {
    const detail = repo.getMail(attMail.id)!
    check('POP3 附件已落盘并登记', detail.attachments.length === 1 && Boolean(detail.attachments[0].storedPath))
  }

  // 14.5 增量：服务器新增一封，只下这一封
  mock1.close()
  const mock2 = await startMockPop3({
    messages: [
      ...pop3Messages,
      {
        uid: 'UID-0004',
        raw: makeMessage({
          index: 5004,
          subject: 'POP3 第四封：增量',
          from: 'pop3sender@example.com',
          to: 'tester@example.com',
          body: '这是后加的第四封。',
          date: new Date(2024, 4, 4, 8, 0),
          messageId: 'pop3-4@example.com'
        })
      }
    ],
    supportUidl: true
  })
  const account2 = repo.updateAccount({ ...pop3Account, pop3Port: mock2.port })
  await syncPop3Account(account2, { onProgress: () => {} })
  const afterThird = repo.listMails({ folderId: popInbox().id, limit: 100 })
  check('增量同步只新增 1 封', afterThird.total === 4, `实际 ${afterThird.total}`)
  check('增量只 RETR 了新邮件', mock2.state.retrieved.length === 1, `实际 RETR ${mock2.state.retrieved.length} 次`)
  mock2.close()

  // 14.6 服务器不支持 UIDL：退化为全量下载 + Message-ID 去重
  const mockNoUidl = await startMockPop3({ messages: pop3Messages, supportUidl: false })
  const noUidlAccount = repo.createAccount(
    createAccountDraft({
      email: 'nouidl@example.com',
      displayName: '无 UIDL',
      protocol: 'pop3',
      pop3Host: '127.0.0.1',
      pop3Port: mockNoUidl.port,
      pop3Secure: false,
      smtpHost: '127.0.0.1',
      username: 'tester@example.com',
      password: 'secret'
    })
  )
  await syncPop3Account(noUidlAccount, { onProgress: () => {} })
  const noUidlFolder = repo.listFolders(noUidlAccount.id).find((f) => f.role === 'inbox')!
  const noUidlFirst = repo.listMails({ folderId: noUidlFolder.id, limit: 100 })
  check('无 UIDL 服务器首次导入 3 封', noUidlFirst.total === 3, `实际 ${noUidlFirst.total}`)

  await syncPop3Account(noUidlAccount, { onProgress: () => {} })
  const noUidlSecond = repo.listMails({ folderId: noUidlFolder.id, limit: 100 })
  check(
    '无 UIDL 服务器重复同步靠 Message-ID 去重',
    noUidlSecond.total === 3,
    `实际 ${noUidlSecond.total}（应仍为 3）`
  )
  mockNoUidl.close()

  // 14.7 deleteAfterFetch：QUIT 时才提交删除
  const mockDelete = await startMockPop3({ messages: pop3Messages, supportUidl: true })
  const deleteAccount = repo.createAccount(
    createAccountDraft({
      email: 'delete@example.com',
      displayName: '下载后删除',
      protocol: 'pop3',
      pop3Host: '127.0.0.1',
      pop3Port: mockDelete.port,
      pop3Secure: false,
      smtpHost: '127.0.0.1',
      username: 'tester@example.com',
      password: 'secret',
      pop3DeleteAfterFetch: true
    })
  )
  await syncPop3Account(deleteAccount, { onProgress: () => {} })
  check(
    '开启「下载后删除」时确实提交了 DELE',
    mockDelete.state.committedDeletions.length === 3,
    `提交删除 ${mockDelete.state.committedDeletions.join(',')}`
  )
  mockDelete.close()

  // 14.8 中断语义：DELE 之后不 QUIT，服务器不应提交删除
  const mockAbort = await startMockPop3({ messages: pop3Messages, supportUidl: true })
  const abortClient = new Pop3Client({
    host: '127.0.0.1',
    port: mockAbort.port,
    secure: false,
    username: 'tester@example.com',
    password: 'secret'
  })
  await abortClient.connect()
  await abortClient.login()
  await abortClient.dele(1)
  await abortClient.dele(2)
  abortClient.close() // 不调用 quit()
  await new Promise((resolve) => setTimeout(resolve, 200))
  check(
    '中断（不发 QUIT）时服务器不提交删除',
    mockAbort.state.committedDeletions.length === 0,
    `提交删除 ${mockAbort.state.committedDeletions.join(',')}`
  )
  check(
    '被 DELE 的消息记为已回滚',
    mockAbort.state.rolledBackDeletions.length === 2,
    mockAbort.state.rolledBackDeletions.join(',')
  )
  mockAbort.close()

  // 14.9 密码错误要有可读报错
  const mockBadPass = await startMockPop3({ messages: pop3Messages, supportUidl: true })
  const badAccount = repo.createAccount(
    createAccountDraft({
      email: 'bad@example.com',
      displayName: '密码错误',
      protocol: 'pop3',
      pop3Host: '127.0.0.1',
      pop3Port: mockBadPass.port,
      pop3Secure: false,
      smtpHost: '127.0.0.1',
      username: 'tester@example.com',
      password: 'wrong-password'
    })
  )
  const badResult = await testPop3(badAccount)
  check('密码错误时测试连接返回失败', badResult.ok === false)
  check(
    '报错里带上了服务器的说明',
    (badResult.error ?? '').includes('authentication failed'),
    badResult.error ?? ''
  )
  mockBadPass.close()

  // 14.10 隐式 TLS（对应真实世界的 995 端口）
  const cert = generateSelfSignedCert(root)
  const mockTls = await startMockPop3({ messages: pop3Messages, supportUidl: true, tls: cert })
  const tlsAccount = repo.createAccount(
    createAccountDraft({
      email: 'tls@example.com',
      displayName: '隐式 TLS',
      protocol: 'pop3',
      pop3Host: '127.0.0.1',
      pop3Port: mockTls.port,
      pop3Secure: true,
      smtpHost: '127.0.0.1',
      username: 'tester@example.com',
      password: 'secret'
    })
  )
  const tlsTest = await testPop3(tlsAccount)
  check('隐式 TLS（995）连接成功', tlsTest.ok, tlsTest.error ?? '')
  await syncPop3Account(tlsAccount, { onProgress: () => {} })
  const tlsFolder = repo.listFolders(tlsAccount.id).find((f) => f.role === 'inbox')!
  check(
    '隐式 TLS 下能正常收信',
    repo.listMails({ folderId: tlsFolder.id, limit: 10 }).total === 3
  )
  mockTls.close()

  // 14.11 STLS 升级（对应真实世界的 110 端口）
  const mockStls = await startMockPop3({
    messages: pop3Messages,
    supportUidl: true,
    stls: cert // 明文起步 + STLS 升级，对应 110 端口
  })
  const stlsAccount = repo.createAccount(
    createAccountDraft({
      email: 'stls@example.com',
      displayName: 'STLS',
      protocol: 'pop3',
      pop3Host: '127.0.0.1',
      pop3Port: mockStls.port,
      pop3Secure: false, // 明文端口，客户端应自动 STLS 升级
      smtpHost: '127.0.0.1',
      username: 'tester@example.com',
      password: 'secret'
    })
  )
  const stlsTest = await testPop3(stlsAccount)
  check('明文端口自动 STLS 升级成功', stlsTest.ok, stlsTest.error ?? '')
  check(
    '服务器侧确认走了 TLS 协商',
    mockStls.state.tlsNegotiations >= 1,
    `tlsNegotiations=${mockStls.state.tlsNegotiations}`
  )
  await syncPop3Account(stlsAccount, { onProgress: () => {} })
  const stlsFolder = repo.listFolders(stlsAccount.id).find((f) => f.role === 'inbox')!
  check(
    'STLS 升级后能正常收信',
    repo.listMails({ folderId: stlsFolder.id, limit: 10 }).total === 3
  )
  mockStls.close()

  // 14.12 POP3 账户不应该被 IMAP 通道处理
  const supportsImap = (await import('./mail/imap')).accountSupportsImap
  check('POP3 账户被 IMAP 通道正确排除', supportsImap(pop3Account) === false)


  /* ---------- 15. 数据库迁移（老版本升级不能丢邮件） ---------- */
  section('15. 从 v1 数据库升级（只支持 IMAP 的老版本）')

  const v1Path = join(root, 'v1-simplemail.db')
  const v1 = openDatabase(v1Path)
  // 完全按 v1 的建表语句来：accounts 没有 protocol/pop3_*，mails 没有 pop3_uid
  v1.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      imap_host TEXT NOT NULL DEFAULT '',
      imap_port INTEGER NOT NULL DEFAULT 993,
      imap_secure INTEGER NOT NULL DEFAULT 1,
      smtp_host TEXT NOT NULL DEFAULT '',
      smtp_port INTEGER NOT NULL DEFAULT 465,
      smtp_secure INTEGER NOT NULL DEFAULT 1,
      username TEXT NOT NULL DEFAULT '',
      password TEXT NOT NULL DEFAULT '',
      signature TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#2f7fd8',
      sync_enabled INTEGER NOT NULL DEFAULT 1,
      is_local INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      last_sync_at INTEGER
    );
    CREATE TABLE folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'custom',
      delimiter TEXT NOT NULL DEFAULT '/',
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE (account_id, path)
    );
    CREATE TABLE mails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      folder_id INTEGER NOT NULL,
      uid INTEGER,
      message_id TEXT,
      subject TEXT NOT NULL DEFAULT '',
      from_name TEXT NOT NULL DEFAULT '',
      from_addr TEXT NOT NULL DEFAULT '',
      to_text TEXT NOT NULL DEFAULT '',
      cc_text TEXT NOT NULL DEFAULT '',
      bcc_text TEXT NOT NULL DEFAULT '',
      reply_to TEXT NOT NULL DEFAULT '',
      date INTEGER NOT NULL DEFAULT 0,
      body_text TEXT NOT NULL DEFAULT '',
      body_html TEXT,
      raw_headers TEXT NOT NULL DEFAULT '',
      snippet TEXT NOT NULL DEFAULT '',
      in_reply_to TEXT,
      refs TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      unread INTEGER NOT NULL DEFAULT 1,
      flagged INTEGER NOT NULL DEFAULT 0,
      has_attachments INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'imap',
      archive_tag TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO meta(key, value) VALUES('schema_version', '1');
    INSERT INTO meta(key, value) VALUES('initialized', '2024-01-01T00:00:00.000Z');
    INSERT INTO accounts(email, display_name, imap_host, smtp_host, username, password)
      VALUES('old@qq.com', '老账户', 'imap.qq.com', 'smtp.qq.com', 'old@qq.com', 'authcode');
    INSERT INTO folders(account_id, name, path, role) VALUES(1, '收件箱', 'INBOX', 'inbox');
    INSERT INTO mails(account_id, folder_id, uid, message_id, subject, from_addr, date, body_text, source)
      VALUES(1, 1, 42, 'old-1@qq.com', '升级前就存在的邮件', 'someone@example.com', 1700000000000, '这封邮件在迁移后必须还在。', 'imap');
  `)
  v1.close()

  // 用正式流程打开：initSchema 会先建表（IF NOT EXISTS，对已有表无影响）再跑迁移
  const migrated = openDatabase(v1Path)
  initSchema(migrated)

  const migratedAccount = migrated
    .prepare('SELECT email, display_name, protocol, pop3_host, pop3_port, pop3_secure, pop3_delete_after_fetch FROM accounts WHERE id = 1')
    .get() as Record<string, unknown>
  const migratedMail = migrated
    .prepare('SELECT subject, body_text, message_id FROM mails WHERE id = 1')
    .get() as Record<string, unknown>

  check('迁移后老账户还在', migratedAccount?.email === 'old@qq.com', String(migratedAccount?.email))
  check('老账户默认协议为 imap', migratedAccount?.protocol === 'imap', String(migratedAccount?.protocol))
  check('POP3 列已补齐且默认端口为 995', Number(migratedAccount?.pop3_port) === 995, String(migratedAccount?.pop3_port))
  check('老邮件正文完好', migratedMail?.body_text === '这封邮件在迁移后必须还在。', String(migratedMail?.body_text))
  check('老邮件 Message-ID 完好', migratedMail?.message_id === 'old-1@qq.com')
  check(
    'schema_version 已升到最新',
    String((migrated.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string })?.value) ===
      String(SCHEMA_VERSION)
  )

  // 迁移后应当能往老库写 POP3 邮件
  const pop3Folder = migrated
    .prepare("SELECT id FROM folders WHERE account_id = 1 AND role = 'inbox'")
    .get() as { id: number }
  let pop3InsertOk = false
  try {
    migrated
      .prepare(
        `INSERT INTO mails(account_id, folder_id, pop3_uid, message_id, subject, source)
         VALUES(?,?,?,?,?,?)`
      )
      .run(1, pop3Folder.id, 'UID-MIGRATED-1', 'migrated-1@example.com', '迁移后写入的 POP3 邮件', 'pop3')
    pop3InsertOk = true
  } catch (err) {
    check('迁移后可以写入 POP3 邮件', false, String(err))
  }
  if (pop3InsertOk) {
    check('迁移后可以写入 POP3 邮件', true)
    // 唯一索引要真的生效
    let dupBlocked = false
    try {
      migrated
        .prepare(
          `INSERT INTO mails(account_id, folder_id, pop3_uid, message_id, subject, source)
           VALUES(?,?,?,?,?,?)`
        )
        .run(1, pop3Folder.id, 'UID-MIGRATED-1', 'migrated-2@example.com', '重复 UIDL', 'pop3')
    } catch {
      dupBlocked = true
    }
    check('POP3 UIDL 唯一索引在迁移后的库上生效', dupBlocked)
  }

  // 重复执行迁移应当幂等
  let idempotent = true
  try {
    migrate(migrated)
    migrate(migrated)
  } catch (err) {
    idempotent = false
    check('迁移可重复执行（幂等）', false, String(err))
  }
  if (idempotent) check('迁移可重复执行（幂等）', true)
  migrated.close()


  /* ---------- 16. 批量操作与永久删除的文件清理 ---------- */
  section('16. 批量删除 / 移动（含磁盘附件清理）')

  const bulkAccount = repo.createAccount(
    createAccountDraft({
      email: 'bulk@simplemail.local',
      displayName: '批量操作测试',
      color: '#666666',
      syncEnabled: false,
      isLocal: true
    })
  )
  const bulkInbox = repo.upsertFolder(bulkAccount.id, 'BULK/INBOX', '收件箱', 'inbox')
  const bulkTrash = repo.upsertFolder(bulkAccount.id, 'BULK/Trash', '垃圾箱', 'trash')

  /** 造一封带真实附件文件的邮件，返回 {id, files} */
  const makeBulkMail = (n: number): { id: number; files: string[] } => {
    const id = repo.insertMail({
      accountId: bulkAccount.id,
      folderId: bulkInbox.id,
      uid: null,
      messageId: `bulk-${n}@simplemail.local`,
      subject: `批量测试邮件 ${n}`,
      fromName: 'Tester',
      fromAddr: 'tester@example.com',
      toText: 'me@example.com',
      ccText: '',
      bccText: '',
      replyTo: '',
      date: Date.now() - n * 1000,
      bodyText: `第 ${n} 封批量测试邮件`,
      bodyHtml: null,
      rawHeaders: '',
      size: 100,
      unread: true,
      flagged: false,
      hasAttachments: true,
      source: 'local'
    })!
    const dir = messageAttachmentDir(bulkAccount.id, id)
    const files: string[] = []
    for (let k = 0; k < 2; k++) {
      const file = join(dir, `${k + 1}_附件${n}_${k}.txt`)
      writeFileSync(file, `邮件 ${n} 的第 ${k} 个附件`, 'utf8')
      files.push(file)
      repo.insertAttachment({
        mailId: id,
        filename: `附件${n}_${k}.txt`,
        contentType: 'text/plain',
        size: 20,
        contentId: null,
        isInline: false,
        storedPath: file
      })
    }
    return { id, files }
  }

  const bulkMails = [makeBulkMail(1), makeBulkMail(2), makeBulkMail(3), makeBulkMail(4)]
  check(
    '批量测试数据准备完毕（4 封邮件，各 2 个附件文件）',
    bulkMails.every((m) => m.files.every((f) => existsSync(f))),
    bulkMails.map((m) => m.files.length).join('+')
  )

  // 16.1 移到垃圾箱：邮件换文件夹，附件文件必须还在（可恢复）
  const trashOutcome = moveMailsToTrash([bulkMails[0].id, bulkMails[1].id])
  check('移到垃圾箱影响 2 封', trashOutcome.affected === 2, `affected=${trashOutcome.affected}`)
  check(
    '移入垃圾箱后附件文件仍在磁盘上',
    bulkMails[0].files.every((f) => existsSync(f)) && bulkMails[1].files.every((f) => existsSync(f))
  )
  const inTrash = repo.listMails({ folderId: bulkTrash.id, limit: 10 })
  check('这 2 封确实出现在垃圾箱里', inTrash.total === 2, `实际 ${inTrash.total}`)
  check(
    '垃圾箱里的邮件没有丢附件记录',
    inTrash.items.every((m) => m.hasAttachments)
  )

  // 16.2 垃圾箱里按 Delete 等同于永久删除
  const fromTrash = moveMailsToTrash([bulkMails[0].id])
  check('在垃圾箱里删除会永久删掉（affected=1）', fromTrash.affected === 1, `affected=${fromTrash.affected}`)
  check(
    '永久删除后附件文件已从磁盘清理',
    bulkMails[0].files.every((f) => !existsSync(f)),
    bulkMails[0].files.map((f) => `${f.split('/').pop()}:${existsSync(f)}`).join(',')
  )

  // 16.3 直接永久删除（对应 Shift+Delete）
  const permOutcome = deleteMailsPermanently([bulkMails[1].id, bulkMails[2].id])
  check('永久删除 2 封', permOutcome.affected === 2, `affected=${permOutcome.affected}`)
  check(
    '永久删除清理了 4 个附件文件',
    permOutcome.filesRemoved === 4,
    `filesRemoved=${permOutcome.filesRemoved}`
  )
  check(
    '被永久删除邮件的附件文件确实不在了',
    [...bulkMails[1].files, ...bulkMails[2].files].every((f) => !existsSync(f))
  )
  check('数据库里查不到已永久删除的邮件', repo.getMail(bulkMails[1].id) === undefined)
  check(
    '已永久删除的邮件不再出现在列表里',
    repo.listMails({ folderId: bulkInbox.id, limit: 10 }).items.every((m) => m.id !== bulkMails[1].id)
  )
  check(
    '剩余那封（第 4 封）没有受影响',
    existsSync(bulkMails[3].files[0]) && repo.getMail(bulkMails[3].id) !== undefined
  )

  // 16.4 不入库的邮件 id 应当被安全跳过
  const ghost = deleteMailsPermanently([999999, 888888])
  check('删除不存在的邮件时安全跳过', ghost.affected === 0 && ghost.skipped === 2, JSON.stringify(ghost))

  // 16.5 批量标记已读 / 星标
  const readOutcome = markMailsRead([bulkMails[3].id], false)
  check('批量标记已读生效', readOutcome.affected === 1)
  check('标记后该邮件 unread 为 false', repo.getMail(bulkMails[3].id)?.unread === false)

  const flagOutcome = markMailsFlagged([bulkMails[3].id], true)
  check('批量星标生效', flagOutcome.affected === 1)
  check('标记后该邮件 flagged 为 true', repo.getMail(bulkMails[3].id)?.flagged === true)

  // 16.6 附件目录也应当被清掉，不留空壳
  const orphanDir = join(attachmentsRoot(), String(bulkAccount.id), String(bulkMails[1].id))
  check('永久删除后该邮件的附件目录也被移除', !existsSync(orphanDir), orphanDir)


  /* ---------- 17. 按字段搜索与相关度排序 ---------- */
  section('17. 按字段搜索 + 相关度排序')

  const searchAccount = repo.createAccount(
    createAccountDraft({
      email: 'search@simplemail.local',
      displayName: '搜索测试',
      color: '#3355aa',
      syncEnabled: false,
      isLocal: true
    })
  )
  const searchFolder = repo.upsertFolder(searchAccount.id, 'SEARCH/INBOX', '收件箱', 'inbox')

  const addSearchMail = (
    n: number,
    subject: string,
    fromAddr: string,
    body: string
  ): number =>
    repo.insertMail({
      accountId: searchAccount.id,
      folderId: searchFolder.id,
      uid: null,
      messageId: `search-${n}@simplemail.local`,
      subject,
      fromName: '发件人' + n,
      fromAddr,
      toText: 'me@example.com',
      ccText: '',
      bccText: '',
      replyTo: '',
      date: Date.now() - n * 1000,
      bodyText: body,
      bodyHtml: null,
      rawHeaders: `From: ${fromAddr}\r\nSubject: ${subject}`,
      size: body.length,
      unread: false,
      flagged: false,
      hasAttachments: false,
      source: 'local'
    })!

  const alphaId = addSearchMail(1, '季度报告阿尔法', 'alpha@example.com', '这封邮件正文里没有那个词')
  const betaId = addSearchMail(2, '另一个主题', 'beta@example.com', '正文里出现了季度报告阿尔法这个词')
  // 词频更高的一封，相关度应当排最前
  const hotId = addSearchMail(
    3,
    '无关主题',
    'gamma@example.com',
    '季度报告阿尔法 季度报告阿尔法 季度报告阿尔法 反复出现'
  )

  check(
    '字段表达式生成正确（主题）',
    buildMatchQuery('季度', 'subject') === 'cjk_subject:"季 度"',
    String(buildMatchQuery('季度', 'subject'))
  )
  check(
    '字段表达式生成正确（发件人）',
    buildMatchQuery('alpha', 'from') === 'sender:"alpha"',
    String(buildMatchQuery('alpha', 'from'))
  )

  const bySubject = repo.listMails({ search: '季度报告阿尔法', searchField: 'subject', limit: 20 })
  check(
    '限定主题搜索只命中主题里有的那封',
    bySubject.total === 1 && bySubject.items[0].id === alphaId,
    `命中 ${bySubject.total}：${bySubject.items.map((m) => m.subject).join('|')}`
  )

  const byBody = repo.listMails({ search: '季度报告阿尔法', searchField: 'body', limit: 20 })
  check(
    '限定正文搜索只命中正文里有的两封',
    byBody.total === 2 && byBody.items.every((m) => m.id !== alphaId),
    `命中 ${byBody.total}：${byBody.items.map((m) => m.subject).join('|')}`
  )

  const byFrom = repo.listMails({ search: 'alpha@example.com', searchField: 'from', limit: 20 })
  check(
    '限定发件人搜索只命中对应那封',
    byFrom.total === 1 && byFrom.items[0].id === alphaId,
    `命中 ${byFrom.total}`
  )

  const byAll = repo.listMails({ search: '季度报告阿尔法', searchField: 'all', limit: 20 })
  check('不限字段时三封都能命中', byAll.total === 3, `命中 ${byAll.total}`)

  const byRelevance = repo.listMails({
    search: '季度报告阿尔法',
    searchField: 'body',
    orderBy: 'relevance',
    limit: 20
  })
  check(
    '相关度排序把匹配度最高的放最前',
    byRelevance.items[0]?.id === hotId,
    `第一名 subject=${byRelevance.items[0]?.subject}`
  )

  // 三封的 date 是 now - n*1000，n 越小越新。按时间倒序应当最新那封在前，
  // 而它在相关度排序里并不是第一 —— 这样才验证得了「两种排序确实不同」。
  const byDate = repo.listMails({
    search: '季度报告阿尔法',
    searchField: 'body',
    orderBy: 'date',
    orderDir: 'desc',
    limit: 20
  })
  check(
    '切回时间排序后按时间排（不再是相关度顺序）',
    byDate.items[0]?.id === betaId && byDate.items[0]?.id !== hotId,
    `第一名 subject=${byDate.items[0]?.subject}`
  )

  /* ---------- 17b. 多字段并列搜索（AND） ---------- */
  //
  // 界面从「下拉选一个字段」改成了「每个字段一个并列输入框」。
  // 这里要钉住三件事：留空即不限制、多个字段是 AND、只有一个字段时
  // 表达式与旧的单字段形式完全一致（行为不能因为改界面而变化）。

  check(
    '单字段时表达式与旧的单字段形式一致',
    buildMatchQueryMulti({ subject: '季度' }) === buildMatchQuery('季度', 'subject'),
    `${buildMatchQueryMulti({ subject: '季度' })} vs ${buildMatchQuery('季度', 'subject')}`
  )

  check(
    '两个字段用 AND 连接，各自加括号',
    buildMatchQueryMulti({ subject: '季度', from: 'alpha' }) ===
      '(sender:"alpha") AND (cjk_subject:"季 度")',
    String(buildMatchQueryMulti({ subject: '季度', from: 'alpha' }))
  )

  check(
    '字段顺序固定（不受对象字面量书写顺序影响）',
    buildMatchQueryMulti({ from: 'alpha', subject: '季度' }) ===
      '(sender:"alpha") AND (cjk_subject:"季 度")',
    String(buildMatchQueryMulti({ from: 'alpha', subject: '季度' }))
  )
  check('全部字段都空 → null（调用方退化成普通列表）', buildMatchQueryMulti({}) === null)
  check(
    '只有空白字符也算空',
    buildMatchQueryMulti({ subject: '   ', from: '\t' }) === null,
    String(buildMatchQueryMulti({ subject: '   ', from: '\t' }))
  )
  check(
    '空字段被跳过，不影响有内容的字段',
    buildMatchQueryMulti({ all: 'invoice', subject: '  ' }) === '"invoice"',
    String(buildMatchQueryMulti({ all: 'invoice', subject: '  ' }))
  )
  check(
    '同一字段里的多个词仍用 AND（与旧行为一致）',
    buildMatchQueryMulti({ all: '发票 invoice' }) === '"发 票" AND "invoice"',
    String(buildMatchQueryMulti({ all: '发票 invoice' }))
  )
  check(
    'compactCriteria 去掉空字段并去空白',
    JSON.stringify(compactCriteria({ subject: ' 季度 ', from: '', body: '   ' })) ===
      JSON.stringify({ subject: '季度' }),
    JSON.stringify(compactCriteria({ subject: ' 季度 ', from: '', body: '   ' }))
  )
  check(
    'countCriteria 只数有内容的字段',
    countCriteria({ subject: 'a', from: '', to: '  ', body: 'b' }) === 2,
    String(countCriteria({ subject: 'a', from: '', to: '  ', body: 'b' }))
  )

  const idsOf = (r: { items: { id: number }[] }): number[] =>
    r.items.map((m) => m.id).sort((a, b) => a - b)

  const onlySubject = repo.listMails({ searchCriteria: { subject: '季度报告阿尔法' }, limit: 20 })
  const onlyFromBeta = repo.listMails({
    searchCriteria: { from: 'beta@example.com' },
    limit: 20
  })
  const subjectAndFromBeta = repo.listMails({
    searchCriteria: { subject: '季度报告阿尔法', from: 'beta@example.com' },
    limit: 20
  })

  check(
    '限定主题只命中主题里有的那封（多字段接口）',
    idsOf(onlySubject).length === 1 && onlySubject.items[0].id === alphaId,
    `命中 ${onlySubject.total}`
  )
  check(
    '两个条件都单独有命中，但交集为空 → 结果是 0（证明是 AND 而不是 OR）',
    onlySubject.total === 1 && onlyFromBeta.total === 1 && subjectAndFromBeta.total === 0,
    `主题=${onlySubject.total} 发件人=${onlyFromBeta.total} 同时=${subjectAndFromBeta.total}`
  )

  // 交集性质的通用断言：两条件同时用 → 结果恰好等于各自结果的交集
  const allHits = repo.listMails({ searchCriteria: { all: '季度报告阿尔法' }, limit: 20 })
  const bothHits = repo.listMails({
    searchCriteria: { all: '季度报告阿尔法', from: 'beta@example.com' },
    limit: 20
  })
  const expectIntersect = idsOf(allHits).filter((id) => idsOf(onlyFromBeta).includes(id))
  check(
    '多字段结果 = 各字段结果的交集',
    JSON.stringify(idsOf(bothHits)) === JSON.stringify(expectIntersect),
    `实际 ${JSON.stringify(idsOf(bothHits))} vs 交集 ${JSON.stringify(expectIntersect)}`
  )

  const threeWay = repo.listMails({
    searchCriteria: { subject: '季度报告阿尔法', from: 'alpha', to: 'me@example.com' },
    limit: 20
  })
  check(
    '三个字段同时限定也生效',
    threeWay.total === 1 && threeWay.items[0].id === alphaId,
    `命中 ${threeWay.total}`
  )

  const noneMatch = repo.listMails({
    searchCriteria: { from: 'nobody@nowhere.invalid' },
    limit: 20
  })
  check('条件匹配不到任何邮件时返回 0', noneMatch.total === 0, `命中 ${noneMatch.total}`)

  const emptyCriteria = repo.listMails({ searchCriteria: {}, limit: 500 })
  const noCriteria = repo.listMails({ limit: 500 })
  check(
    '空条件等价于不过滤（不会把所有邮件筛没）',
    emptyCriteria.total === noCriteria.total && noCriteria.total > 5,
    `空条件 ${emptyCriteria.total} / 无条件 ${noCriteria.total}`
  )

  const relMulti = repo.listMails({
    searchCriteria: { all: '季度报告阿尔法' },
    orderBy: 'relevance',
    limit: 20
  })
  check(
    '多字段接口下相关度排序依然把匹配度最高的放最前',
    relMulti.items[0]?.id === hotId,
    `第一名 subject=${relMulti.items[0]?.subject}`
  )

  /* ---------- 18. 自动归类规则 ---------- */
  section('18. 自动归类 / 自动删除规则')

  const ruleAccount = repo.createAccount(
    createAccountDraft({
      email: 'rules@simplemail.local',
      displayName: '规则测试',
      color: '#aa5533',
      syncEnabled: false,
      isLocal: true
    })
  )
  const ruleInbox = repo.upsertFolder(ruleAccount.id, 'RULES/INBOX', '收件箱', 'inbox')
  const ruleTrash = repo.upsertFolder(ruleAccount.id, 'RULES/Trash', '垃圾箱', 'trash')
  const ruleArchive = repo.upsertFolder(ruleAccount.id, 'RULES/Archive', '归档', 'archive')
  const ruleSpam = repo.upsertFolder(ruleAccount.id, 'RULES/Spam', '广告', 'junk')

  const addRuleMail = (
    n: number,
    fromAddr: string,
    subject: string,
    body: string,
    headers = ''
  ): number =>
    repo.insertMail({
      accountId: ruleAccount.id,
      folderId: ruleInbox.id,
      uid: null,
      messageId: `rule-${n}@simplemail.local`,
      subject,
      fromName: '',
      fromAddr,
      toText: 'me@example.com',
      ccText: '',
      bccText: '',
      replyTo: '',
      date: Date.now() - n * 1000,
      bodyText: body,
      bodyHtml: null,
      rawHeaders: headers || `From: ${fromAddr}`,
      size: 100,
      unread: true,
      flagged: false,
      hasAttachments: false,
      source: 'local'
    })!

  // 18.1 按发件人归类（只用邮件头，插入时即可判定）
  const moveRule = repo.saveRule({
    name: '客户邮件归档',
    enabled: true,
    priority: 10,
    accountId: ruleAccount.id,
    matchMode: 'all',
    conditions: [{ field: 'from', op: 'contains', value: 'customer.com' }],
    action: 'move',
    actionFolderId: ruleArchive.id,
    stop: true
  })
  repo.saveRule({
    name: '促销邮件进广告',
    enabled: true,
    priority: 20,
    accountId: ruleAccount.id,
    matchMode: 'any',
    conditions: [
      { field: 'subject', op: 'contains', value: '促销' },
      { field: 'subject', op: 'contains', value: '限时' }
    ],
    action: 'move',
    actionFolderId: ruleSpam.id,
    stop: true
  })

  const customerId = addRuleMail(1, 'boss@customer.com', '合同确认', '合同内容')
  const promoId = addRuleMail(2, 'noreply@shop.com', '限时促销来了', '买它')
  const normalId = addRuleMail(3, 'friend@example.com', '周末聚聚', '老地方见')

  applyRulesToMail(customerId)
  applyRulesToMail(promoId)
  applyRulesToMail(normalId)

  check(
    '按发件人规则把客户邮件移到了归档',
    repo.getMail(customerId)?.folderId === ruleArchive.id,
    String(repo.getFolder(repo.getMail(customerId)!.folderId)?.name)
  )
  check(
    '「满足任一条件」的规则命中了「限时」',
    repo.getMail(promoId)?.folderId === ruleSpam.id,
    String(repo.getFolder(repo.getMail(promoId)!.folderId)?.name)
  )
  check(
    '不相干的邮件留在收件箱',
    repo.getMail(normalId)?.folderId === ruleInbox.id
  )

  // 18.2 关键：重复评估不能再次执行（否则「移到垃圾箱」会变成永久删除）
  const trashRule = repo.saveRule({
    name: '黑名单直接进垃圾箱',
    enabled: true,
    priority: 5,
    accountId: ruleAccount.id,
    matchMode: 'all',
    conditions: [{ field: 'from', op: 'contains', value: 'spammer.net' }],
    action: 'trash',
    actionFolderId: null,
    stop: true
  })
  const spamId = addRuleMail(4, 'x@spammer.net', '垃圾邮件', '内容')
  applyRulesToMail(spamId)
  check('黑名单邮件第一次被移入垃圾箱', repo.getMail(spamId)?.folderId === ruleTrash.id)

  // 再评估两次
  applyRulesToMail(spamId, true)
  applyRulesToMail(spamId, true)
  check(
    '重复评估不会把垃圾箱里的邮件永久删掉',
    repo.getMail(spamId) !== undefined,
    repo.getMail(spamId) ? '仍在' : '被误删了'
  )
  check(
    '记录里确实记下了已经执行过的规则',
    repo.getMailRulesFired(spamId).includes(trashRule.id),
    JSON.stringify(repo.getMailRulesFired(spamId))
  )

  // 18.3 依赖正文的规则：正文没到时推迟，正文到了再补评
  const bodyRule = repo.saveRule({
    name: '正文含发票关键词则归档',
    enabled: true,
    priority: 30,
    accountId: ruleAccount.id,
    matchMode: 'all',
    conditions: [{ field: 'body', op: 'contains', value: '发票号' }],
    action: 'move',
    actionFolderId: ruleArchive.id,
    stop: true
  })

  const pendingId = repo.insertMail({
    accountId: ruleAccount.id,
    folderId: ruleInbox.id,
    uid: null,
    messageId: 'rule-pending@simplemail.local',
    subject: '待补正文的邮件',
    fromName: '',
    fromAddr: 'billing@example.com',
    toText: '',
    ccText: '',
    bccText: '',
    replyTo: '',
    date: Date.now(),
    bodyText: '',
    bodyHtml: null,
    rawHeaders: 'From: billing@example.com',
    size: 10,
    unread: true,
    flagged: false,
    hasAttachments: false,
    source: 'imap'
  })!

  const postponed = applyRulesToMail(pendingId)
  check('正文未到时依赖正文的规则会被推迟', postponed.postponed === true)
  check('推迟时邮件没有被移动', repo.getMail(pendingId)?.folderId === ruleInbox.id)
  check('推迟时不记录已执行（好让正文到了再评）', !repo.getMailRulesFired(pendingId).includes(bodyRule.id))

  repo.updateMailBody(pendingId, {
    bodyText: '这是补下来的正文，里面有发票号 12345',
    bodyHtml: null,
    hasAttachments: false,
    rawHeaders: 'From: billing@example.com',
    subject: '待补正文的邮件',
    fromName: '',
    fromAddr: 'billing@example.com',
    toText: '',
    ccText: ''
  })
  applyRulesToMail(pendingId, true)
  check(
    '正文补下来后依赖正文的规则生效了',
    repo.getMail(pendingId)?.folderId === ruleArchive.id,
    String(repo.getFolder(repo.getMail(pendingId)!.folderId)?.name)
  )

  // 18.4 标记已读 / 加星标
  repo.saveRule({
    name: '订阅邮件直接标已读',
    enabled: true,
    priority: 40,
    accountId: ruleAccount.id,
    matchMode: 'any',
    conditions: [{ field: 'subject', op: 'startsWith', value: '[订阅]' }],
    action: 'mark_read',
    actionFolderId: null,
    stop: true
  })
  const subId = addRuleMail(5, 'news@example.com', '[订阅] 本周更新', '内容')
  applyRulesToMail(subId)
  check('规则可以把邮件自动标为已读', repo.getMail(subId)?.unread === false)

  // 18.5 指定邮件头（自定义字段）
  repo.saveRule({
    name: '带 List-Id 的邮件归档',
    enabled: true,
    priority: 50,
    accountId: ruleAccount.id,
    matchMode: 'all',
    conditions: [{ field: 'header', op: 'contains', value: 'List-Id: dev.lists' }],
    action: 'move',
    actionFolderId: ruleArchive.id,
    stop: true
  })
  const listId = addRuleMail(
    6,
    'dev@lists.example.com',
    '技术讨论',
    '内容',
    'From: dev@lists.example.com\r\nList-Id: dev.lists.example.com'
  )
  applyRulesToMail(listId)
  check(
    '按自定义邮件头归类生效',
    repo.getMail(listId)?.folderId === ruleArchive.id,
    String(repo.getFolder(repo.getMail(listId)!.folderId)?.name)
  )

  // 18.6 未启用 / 不匹配的规则不动数据
  const disabledRule = repo.saveRule({
    name: '停用的规则',
    enabled: false,
    priority: 1,
    accountId: ruleAccount.id,
    matchMode: 'all',
    conditions: [{ field: 'from', op: 'contains', value: 'disabled.test' }],
    action: 'delete',
    actionFolderId: null,
    stop: true
  })
  const keepId = addRuleMail(7, 'someone@disabled.test', '不该被删', '内容')
  applyRulesToMail(keepId)
  check('停用的规则不会执行', repo.getMail(keepId) !== undefined)
  check('停用的规则没有记录到已执行列表', !repo.getMailRulesFired(keepId).includes(disabledRule.id))

  // 18.7 试运行绝不改数据
  const beforeCount = repo.listMails({ accountId: ruleAccount.id, limit: 100 }).total
  const preview = previewRule(
    {
      name: '试运行',
      enabled: true,
      priority: 1,
      accountId: ruleAccount.id,
      matchMode: 'all',
      conditions: [{ field: 'from', op: 'contains', value: 'example.com' }],
      action: 'delete',
      actionFolderId: null,
      stop: true
    },
    500
  )
  const afterCount = repo.listMails({ accountId: ruleAccount.id, limit: 100 }).total
  check('试运行有匹配结果', preview.matched > 0, `命中 ${preview.matched}`)
  check('试运行前后邮件总数不变（没有真的删）', beforeCount === afterCount, `${beforeCount} → ${afterCount}`)
  check('试运行会给出样例', preview.samples.length > 0)

  // 18.8 坏正则不能让规则崩溃
  const badRegex = repo.saveRule({
    name: '坏正则',
    enabled: true,
    priority: 60,
    accountId: ruleAccount.id,
    matchMode: 'all',
    conditions: [{ field: 'subject', op: 'regex', value: '([unclosed' }],
    action: 'trash',
    actionFolderId: null,
    stop: true
  })
  const badRegexMail = addRuleMail(8, 'x@example.com', '随便什么主题', '内容')
  let crashed = false
  try {
    applyRulesToMail(badRegexMail)
  } catch {
    crashed = true
  }
  check('正则写错时不会抛异常', !crashed)
  check('正则写错时该邮件保持原样', repo.getMail(badRegexMail)?.folderId === ruleInbox.id)
  void badRegex
  void moveRule

  /* ---------- 18.9 手动运行规则必须扫全量，而不是只扫没评估过的 ---------- */
  //
  // 这个 bug 的表现：「试运行能匹配到一些，实际运行说什么都没匹配」。
  // 根因是两条路用了不同的查询 ——
  //   试运行 previewRule → listMailsForRuleScan（全量）
  //   实际运行 runAllRules → listMailsPendingRules（只取 rules_done = 0）
  // 而 rules_done 的含义是「当前规则集已经评估过这封」，用户新建规则时
  // 老邮件早就是 1 了，于是永远扫 0 封。

  // 专门造一封"待屏蔽"的邮件，先让它被评估过（rules_done = 1）
  const banishId = addRuleMail(9, 'spammer@example.com', '屏蔽回归专用词XYZ 出现了', '内容')
  applyRulesToMail(banishId) // 此时还没有匹配它的规则 → 评估完就标记 done
  const banishBefore = repo.getMail(banishId)?.folderId

  // 再把其余邮件也标记成"已评估"，模拟用了一段时间的老库
  for (const m of repo.listMailsForRuleScan(ruleAccount.id, 500)) {
    repo.setMailRulesDone(m.id, true)
  }
  const pendingNow = repo.listMailsPendingRules(ruleAccount.id).length
  check('前提：已经没有任何「待评估」的邮件', pendingNow === 0, String(pendingNow))

  // 用户新建一条屏蔽规则 —— 要屏蔽的正是那封早已评估过的邮件
  repo.saveRule({
    name: '屏蔽·回归测试',
    enabled: true,
    priority: 5,
    accountId: ruleAccount.id,
    matchMode: 'all',
    conditions: [{ field: 'subject', op: 'contains', value: '屏蔽回归专用词XYZ' }],
    action: 'trash',
    actionFolderId: null,
    stop: true
  })

  const run = runAllRules(ruleAccount.id)
  // ⚠️ 关键断言：旧实现只扫 rules_done = 0，此时必然是 0 封 → 这里会失败。
  // 这条断言写成 scanned > 0 就够，因为此刻确实没有任何待评估的邮件。
  check('手动运行会扫描全部邮件（旧实现会扫 0 封）', run.scanned > 0, `scanned=${run.scanned}`)
  check(
    '新建的规则命中并处理了「早已评估过」的邮件',
    repo.getMail(banishId)?.folderId !== banishBefore,
    `folderBefore=${banishBefore} folderAfter=${repo.getMail(banishId)?.folderId}`
  )

  // 再跑一遍：rules_fired 应当挡住重复执行
  const again = runAllRules(ruleAccount.id)
  check('重复运行不会重复执行已动过手的规则', again.acted === 0, `第二次 acted=${again.acted}`)

  // scope='pending' 仍然保留给「同步后的增量评估」
  check(
    "scope='pending' 仍然只扫没评估过的",
    runAllRules(ruleAccount.id, { scope: 'pending' }).scanned === 0
  )

  /* ---------- 19. v2 → v3 迁移（全文索引重建 + 规则表） ---------- */
  section('19. 从 v2 数据库升级（单列 cjk 索引的老库）')

  const v2Path = join(root, 'v2-simplemail.db')
  const v2 = openDatabase(v2Path)
  v2.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '', protocol TEXT NOT NULL DEFAULT 'imap',
      imap_host TEXT NOT NULL DEFAULT '', imap_port INTEGER NOT NULL DEFAULT 993,
      imap_secure INTEGER NOT NULL DEFAULT 1, pop3_host TEXT NOT NULL DEFAULT '',
      pop3_port INTEGER NOT NULL DEFAULT 995, pop3_secure INTEGER NOT NULL DEFAULT 1,
      pop3_delete_after_fetch INTEGER NOT NULL DEFAULT 0,
      smtp_host TEXT NOT NULL DEFAULT '', smtp_port INTEGER NOT NULL DEFAULT 465,
      smtp_secure INTEGER NOT NULL DEFAULT 1, username TEXT NOT NULL DEFAULT '',
      password TEXT NOT NULL DEFAULT '', signature TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#2f7fd8', sync_enabled INTEGER NOT NULL DEFAULT 1,
      is_local INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0,
      last_sync_at INTEGER
    );
    CREATE TABLE folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL,
      name TEXT NOT NULL, path TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'custom',
      delimiter TEXT NOT NULL DEFAULT '/', sort_order INTEGER NOT NULL DEFAULT 0,
      box_layout TEXT, UNIQUE (account_id, path)
    );
    CREATE TABLE mails (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL,
      folder_id INTEGER NOT NULL, uid INTEGER, pop3_uid TEXT, message_id TEXT,
      subject TEXT NOT NULL DEFAULT '', from_name TEXT NOT NULL DEFAULT '',
      from_addr TEXT NOT NULL DEFAULT '', to_text TEXT NOT NULL DEFAULT '',
      cc_text TEXT NOT NULL DEFAULT '', bcc_text TEXT NOT NULL DEFAULT '',
      reply_to TEXT NOT NULL DEFAULT '', date INTEGER NOT NULL DEFAULT 0,
      body_text TEXT NOT NULL DEFAULT '', body_html TEXT, raw_headers TEXT NOT NULL DEFAULT '',
      snippet TEXT NOT NULL DEFAULT '', in_reply_to TEXT, refs TEXT,
      size INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 1,
      flagged INTEGER NOT NULL DEFAULT 0, has_attachments INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'imap', archive_tag TEXT,
      created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
    );
    -- 老版本的单列 cjk 全文索引
    CREATE VIRTUAL TABLE mails_fts USING fts5(
      subject, sender, recipients, body, cjk,
      content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2'
    );
    INSERT INTO meta(key, value) VALUES('schema_version', '2');
    INSERT INTO accounts(email, display_name, imap_host, smtp_host, username, password)
      VALUES('v2@qq.com', 'v2 账户', 'imap.qq.com', 'smtp.qq.com', 'v2@qq.com', 'x');
    INSERT INTO folders(account_id, name, path, role) VALUES(1, '收件箱', 'INBOX', 'inbox');
    INSERT INTO mails(account_id, folder_id, uid, message_id, subject, from_name, from_addr, to_text, date, body_text, source)
      VALUES(1, 1, 1, 'v2-1@qq.com', '升级前的中文主题', '老张', 'laozhang@example.com', 'me@qq.com', 1700000000000, '升级前的正文内容，含关键词：发票', 'imap');
    INSERT INTO mails(account_id, folder_id, uid, message_id, subject, from_name, from_addr, to_text, date, body_text, source)
      VALUES(1, 1, 2, 'v2-2@qq.com', 'second mail', 'Alice', 'alice@example.com', 'me@qq.com', 1700000001000, 'body of second mail', 'imap');
    INSERT INTO mails_fts(rowid, subject, sender, recipients, body, cjk)
      VALUES(1, '升级前的中文主题', '老张 laozhang@example.com', 'me@qq.com', '升级前的正文内容，含关键词：发票', '升 级 前 的 中 文 主 题 老 张 升 级 前 的 正 文 内 容 含 关 键 词 发 票');
    INSERT INTO mails_fts(rowid, subject, sender, recipients, body, cjk)
      VALUES(2, 'second mail', 'Alice alice@example.com', 'me@qq.com', 'body of second mail', '');
  `)
  v2.close()

  const v2Db = openDatabase(v2Path)
  const v3Info = initSchema(v2Db)
  check('v2 库升级后仍能打开', Boolean(v3Info))
  const v2MailCount = (v2Db.prepare('SELECT COUNT(*) c FROM mails').get() as { c: number }).c
  check('升级后邮件一封没少', v2MailCount === 2, `实际 ${v2MailCount}`)
  const v2Body = (
    v2Db.prepare('SELECT body_text FROM mails WHERE id = 1').get() as { body_text: string }
  ).body_text
  check('升级后老邮件正文完好', v2Body.includes('发票'), v2Body)
  check(
    'schema_version 已升到最新（v2 库也一并升到位）',
    String((v2Db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string })?.value) ===
      String(SCHEMA_VERSION)
  )
  check('规则表已建立', Boolean(v2Db.prepare("SELECT name FROM sqlite_master WHERE name='rules'").get()))
  check(
    'mails 表补上了 rules_fired 列',
    (v2Db.prepare('PRAGMA table_info(mails)').all() as { name: string }[]).some(
      (c) => c.name === 'rules_fired'
    )
  )

  // 重建后的索引应当支持分字段检索
  const v2FtsCols = String(
    (v2Db.prepare("SELECT sql FROM sqlite_master WHERE name='mails_fts'").get() as { sql: string }).sql
  )
  check('索引已重建为分字段结构', v2FtsCols.includes('cjk_subject'), v2FtsCols.slice(0, 120))
  const v2Hits = v2Db
    .prepare(
      `SELECT rowid FROM mails_fts WHERE mails_fts MATCH ?`
    )
    .all('cjk_body:"发 票"') as { rowid: number }[]
  check('升级后按字段搜索可用', v2Hits.length === 1 && v2Hits[0].rowid === 1, JSON.stringify(v2Hits))
  const v2FromHits = v2Db
    .prepare(`SELECT rowid FROM mails_fts WHERE mails_fts MATCH ?`)
    .all('sender:"alice"') as { rowid: number }[]
  check('升级后发件人字段检索可用', v2FromHits.length === 1 && v2FromHits[0].rowid === 2)
  v2Db.close()


  /* ---------- 20. 快捷键解析 ---------- */
  section('20. 自定义快捷键的解析与冲突检测')

  const key = (
    k: string,
    mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}
  ): Parameters<typeof bindingFromEvent>[0] => ({
    key: k,
    ctrlKey: Boolean(mods.ctrl),
    metaKey: false,
    altKey: Boolean(mods.alt),
    shiftKey: Boolean(mods.shift)
  })

  check('Ctrl+N 解析正确', bindingFromEvent(key('n', { ctrl: true })) === 'Ctrl+N')
  check(
    'Shift+Delete 解析正确',
    bindingFromEvent(key('Delete', { shift: true })) === 'Shift+Delete'
  )
  check(
    'Ctrl+Shift+R 顺序归一化',
    bindingFromEvent(key('R', { ctrl: true, shift: true })) === 'Ctrl+Shift+R'
  )
  check('单独按 Shift 不产生绑定', bindingFromEvent(key('Shift', { shift: true })) === '')
  check('单键 m 归一化成大写 M', bindingFromEvent(key('m')) === 'M')
  check('方向键名保留', bindingFromEvent(key('ArrowDown')) === 'ArrowDown')

  // 默认表里不应有冲突
  const defaultConflicts = findShortcutConflicts(DEFAULT_SHORTCUTS)
  check('默认快捷键没有冲突', defaultConflicts.size === 0, [...defaultConflicts].join(','))

  // 反查动作
  const defaults = resolveShortcuts({ shortcuts: {} })
  check(
    'Delete 反查到「移到垃圾箱」',
    actionForEvent(key('Delete'), defaults) === 'delete'
  )
  check(
    'Shift+Delete 反查到「永久删除」（不会误判成 Delete）',
    actionForEvent(key('Delete', { shift: true }), defaults) === 'deletePermanent'
  )
  check('F5 反查到同步', actionForEvent(key('F5'), defaults) === 'sync')
  check('未分配的按键返回 null', actionForEvent(key('F9'), defaults) === null)

  // 用户改键后按新键生效、旧键失效
  const custom = resolveShortcuts({ shortcuts: { delete: 'Ctrl+D' } })
  check('改键后新按键生效', actionForEvent(key('D', { ctrl: true }), custom) === 'delete')
  check('改键后旧按键不再触发删除', actionForEvent(key('Delete'), custom) === null)
  check('未改动的动作仍走默认值', custom.sync === 'F5')

  // 冲突检测
  const conflicting = { ...DEFAULT_SHORTCUTS, toggleFlag: 'M' } // 与 toggleRead 撞车
  const found = findShortcutConflicts(conflicting)
  check('冲突能被检测出来', found.has('toggleRead') && found.has('toggleFlag'), [...found].join(','))

  // 展示用的键名
  check('箭头键显示成符号', prettyBinding('Shift+ArrowDown') === 'Shift + ↓', prettyBinding('Shift+ArrowDown'))
  check('Delete 显示成 Del', prettyBinding('Delete') === 'Del')
  check('空绑定显示未设置', prettyBinding('') === '未设置')

  /* ---------- 21. 主题设置与设置文件健壮性 ---------- */
  section('21. 主题设置')

  const settingsFile = join(app.getPath('userData'), 'settings.json')
  const loadedSettings = loadSettings()
  check('默认主题为跟随系统', loadedSettings.theme === 'system', String(loadedSettings.theme))
  check(
    '默认快捷键表为空（走内置默认值）',
    Object.keys(loadedSettings.shortcuts).length === 0
  )

  const savedDark = saveSettings({ theme: 'dark' })
  check('主题可以存成深色', savedDark.theme === 'dark')
  check('重新读回仍是深色', loadSettings().theme === 'dark')

  const savedLight = saveSettings({ theme: 'light' })
  check('主题可以存成浅色', savedLight.theme === 'light')

  // 写一个坏掉的设置文件，看看能不能自愈
  writeFileSync(
    settingsFile,
    JSON.stringify({ theme: 'rainbow', shortcuts: 'not-an-object', pageSize: 200 }),
    'utf8'
  )
  // 清掉缓存需要重新进程；这里直接构造同样会被 normalize 处理的对象做断言
  const bad = { ...DEFAULT_SETTINGS, theme: 'rainbow' as unknown as 'dark', shortcuts: 'x' as unknown as Record<string, string> }
  const fixed = normalizeSettings(bad)
  check('非法主题值被纠正为跟随系统', fixed.theme === 'system', String(fixed.theme))
  check('非法快捷键值被纠正为空对象', typeof fixed.shortcuts === 'object' && !Array.isArray(fixed.shortcuts))

  // 复位，避免影响后续断言
  saveSettings({ theme: 'system', shortcuts: {} })


  /* ---------- 22. 界面资源自检 ---------- */
  section('22. 界面资源自检（样式类名与禁用 API）')

  /**
   * 这一节的由来：出现过两个只有跑起来才看得见、单测完全覆盖不到的 bug ——
   *   1. 多选改造时把行的类名从 .flags 改成 .rowlead，但未读圆点的样式
   *      还挂在 .flags 上，于是圆点变成一个无样式的空 span（看不见），
   *      表现为「已读未读分不出来」；
   *   2. 用 window.prompt() 做清除数据的确认词 —— Electron 根本没实现 prompt()，
   *      它直接返回 null，按钮点了没反应。
   * 这里直接检查**构建产物**里的样式与 JS，把这两类问题挡住。
   */
  const assetsDir = join(process.cwd(), 'out', 'renderer', 'assets')
  if (!existsSync(assetsDir)) {
    console.log('  （还没构建渲染层，跳过这一节；先跑 npm run build）')
  } else {
    const cssFile = readdirSync(assetsDir).find((f) => f.endsWith('.css'))
    const jsFile = readdirSync(assetsDir).find((f) => f.endsWith('.js'))
    const css = cssFile ? readFileSync(join(assetsDir, cssFile), 'utf8') : ''
    const js = jsFile ? readFileSync(join(assetsDir, jsFile), 'utf8') : ''

    /**
     * 取某个选择器的规则体。
     * 注意产物里的 CSS **没有压缩**，选择器和 `{` 之间有空格，
     * 所以这里用正则做空白容忍的匹配，不能直接 indexOf('.x{')。
     */
    const ruleOf = (selector: string): string | null => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const m = new RegExp(`${escaped}\\s*\\{`).exec(css)
      if (!m) return null
      const end = css.indexOf('}', m.index)
      return end === -1 ? null : css.slice(m.index, end)
    }

    const dotRule = ruleOf('.unread-dot')
    check('未读圆点有样式规则', dotRule !== null, dotRule ?? '找不到 .unread-dot')
    check(
      '未读圆点有实际尺寸（不是 0×0 的隐形元素）',
      Boolean(dotRule && /width:\s*[1-9]/.test(dotRule) && /height:\s*[1-9]/.test(dotRule)),
      dotRule ?? ''
    )
    check(
      '未读圆点带背景色（否则看不见）',
      Boolean(dotRule && /background:/.test(dotRule)),
      dotRule ?? ''
    )

    check('行首状态格子有样式', ruleOf('.rowlead .slot-state') !== null)
    check('行首星标格子有样式', ruleOf('.rowlead .slot-star') !== null)
    // 行首第三格从「选中复选框」改成了「附件标记」
    check('行首附件格子有样式', ruleOf('.rowlead .slot-attach') !== null)
    check('行首状态格子有样式', ruleOf('.rowlead .slot-state') !== null)

    // 已读的「小对勾」也要有样式，否则已读邮件在列表里没有任何标记
    const readCheckRule = ruleOf('.read-check')
    check('已读对勾有样式', readCheckRule !== null, readCheckRule ?? '找不到 .read-check')

    // 未读用绿色（用户明确要求），不是原来的主题蓝
    check(
      '未读圆点用的是绿色变量',
      Boolean(dotRule && /background:\s*var\(--unread\)/.test(dotRule)),
      dotRule ?? ''
    )
    check('定义了 --unread 绿色变量', /--unread:\s*#/.test(css))

    const btnRule = ruleOf('.btn')
    check(
      '按钮文字禁止换行（否则「浏览…」会被压成两行）',
      Boolean(btnRule && /white-space:\s*nowrap/.test(btnRule)),
      btnRule ?? ''
    )
    check(
      '按钮不参与 flex 压缩',
      Boolean(btnRule && /flex:\s*0 0 auto/.test(btnRule)),
      btnRule ?? ''
    )

    check('快捷键按键样式存在', ruleOf('.kbd') !== null)
    check(
      '深色主题变量块存在',
      css.includes(":root[data-theme='dark']") || css.includes(':root[data-theme="dark"]')
    )

    // Electron 不支持 prompt()，误用会让按钮静默失效
    check(
      '渲染产物里没有调用 window.prompt / 裸 prompt',
      !/\bwindow\.prompt\(/.test(js) && !/[^.\w]prompt\(/.test(js),
      /[^.\w]prompt\(/.test(js) ? '发现 prompt( 调用' : ''
    )

    // 齿轮与太阳必须是两个不同的图形，否则工具栏上分不出来
    const gearIdx = js.indexOf('M6.40 1.49')
    const sunIdx = js.indexOf('M8 1.4v1.8')
    check('设置用的是齿轮路径', gearIdx !== -1)
    check('主题用的是太阳路径', sunIdx !== -1)
    check('齿轮与太阳是两个不同图形', gearIdx !== -1 && sunIdx !== -1)

    // ── 按字段搜索面板 ──
    //
    // 1.1.6 把「下拉选一个字段」改成了「每个字段一个并列输入框」。
    // 这里钉住面板与输入框的样式真的进了产物 —— 否则改完界面看起来
    // 「什么都没发生」，而单测管不到 CSS。
    const panelRule = ruleOf('.searchpanel')
    check('按字段搜索面板有样式', panelRule !== null, panelRule ?? '找不到 .searchpanel')
    check(
      '面板允许折行（窄窗口下字段框不会被裁掉）',
      Boolean(panelRule && /flex-wrap:\s*wrap/.test(panelRule)),
      panelRule ?? ''
    )

    const fieldInputRule = ruleOf('.searchfield input')
    check(
      '字段输入框有样式与宽度',
      Boolean(fieldInputRule && /width:/.test(fieldInputRule)),
      fieldInputRule ?? ''
    )
    check('字段标签有样式', ruleOf('.searchfield .flabel') !== null)

    // 漏斗图标：与放大镜必须是不同图形，否则「搜索」和「按字段搜索」看起来一样
    const filterIdx = js.indexOf('M2.2 3.1h11.6')
    const magIdx = js.indexOf('M10 10l3.6 3.6')
    check('筛选用的是漏斗路径', filterIdx !== -1)
    check('漏斗与放大镜是两个不同图形', filterIdx !== -1 && magIdx !== -1 && filterIdx !== magIdx)

    // 渲染层必须真的把多字段条件发给主进程（而不是退回旧的单字段参数）
    check(
      '渲染产物里带上了 searchCriteria 参数',
      js.includes('searchCriteria'),
      js.includes('searchCriteria') ? '' : '产物里找不到 searchCriteria，界面可能没接上多字段搜索'
    )
  }


  /* ---------- 23. 大文件流式导入 ---------- */
  section('23. 大文件流式导入（2.94GB 存档那条路）')

  /**
   * 把内存阈值调到极小，强制走流式路径。
   * 这样用几十条报文的小样本就能真实覆盖流式代码，不需要造一个几百 MB 的文件。
   */
  const buildStreamingBox = (name: string, count: number, startIndex: number): string => {
    const msgs = buildSampleMessages(name, count, startIndex)
    const chunks: Buffer[] = []
    const head = Buffer.alloc(0x40)
    head.write('Foxmail', 0, 'ascii')
    chunks.push(head)
    const entries: { id: number; offset: number; deleted: boolean }[] = []
    let offset = head.length
    msgs.forEach((m, i) => {
      entries.push({ id: i + 1, offset, deleted: false })
      chunks.push(FOX_SEPARATOR)
      chunks.push(m)
      offset += FOX_SEPARATOR.length + m.length
    })
    const boxPath = join(root, `${name}.box`)
    writeFileSync(boxPath, Buffer.concat(chunks))
    writeFileSync(join(root, `${name}.ind`), buildInd(DEFAULT_IND_LAYOUT, entries))
    return boxPath
  }

  const streamBoxPath = buildStreamingBox('stream-sample', 40, 7000)
  const streamBoxSize = statSync(streamBoxPath).size

  // 先确认默认阈值下走的是内存路径
  process.env.SIMPLEMAIL_IN_MEMORY_LIMIT = undefined
  check(
    '默认阈值（256MB）下小文件走内存路径',
    streamBoxSize < inMemoryLimit(),
    `${(streamBoxSize / 1024).toFixed(1)} KB < ${(inMemoryLimit() / 1024 / 1024).toFixed(0)} MB`
  )

  const memoryDetect = await openArchive(streamBoxPath)
  const memoryMsgs = await collectUnit(memoryDetect.units[0])
  check('内存路径读出 40 封', memoryMsgs.length === 40, `实际 ${memoryMsgs.length}`)

  // 再把阈值压到 1KB，强制流式
  process.env.SIMPLEMAIL_IN_MEMORY_LIMIT = '1024'
  check('阈值已压到 1KB，接下来强制走流式', inMemoryLimit() === 1024)

  const streamDetect = await openArchive(streamBoxPath)
  const streamUnit = streamDetect.units[0]
  const streamMsgs: Buffer[] = []
  for await (const m of iterateUnit(streamUnit)) streamMsgs.push(m)

  check('流式路径读出同样 40 封', streamMsgs.length === 40, `实际 ${streamMsgs.length}`)
  check(
    '流式路径识别出分隔符策略',
    streamUnit.strategy.startsWith('fox-separator'),
    streamUnit.strategy
  )
  check(
    '流式路径也能自标定 .ind 布局',
    streamUnit.strategy.includes('ind(records='),
    streamUnit.strategy
  )
  check(
    '流式读出的第一封与内存路径逐字节一致',
    streamMsgs[0].length === memoryMsgs[0].length &&
      streamMsgs[0].equals(memoryMsgs[0]),
    `流式 ${streamMsgs[0].length}B vs 内存 ${memoryMsgs[0].length}B`
  )
  check(
    '流式读出的最后一封也一致',
    streamMsgs[39].equals(memoryMsgs[39]),
    `流式 ${streamMsgs[39].length}B vs 内存 ${memoryMsgs[39].length}B`
  )
  const allSame = streamMsgs.every((m, idx) => m.equals(memoryMsgs[idx]))
  check('40 封全部逐字节一致', allSame)
  check(
    '流式扫描能预估出准确封数（进度条要用）',
    streamUnit.info.estimatedCount === 40,
    String(streamUnit.info.estimatedCount)
  )

  // 跨块边界：把小样本按 1 字节阈值跑一遍，等价于「每块都很小」，能覆盖回退去重逻辑
  const bigBoxPath = buildStreamingBox('stream-boundary', 25, 7100)
  process.env.SIMPLEMAIL_IN_MEMORY_LIMIT = '0'
  const boundaryDetect = await openArchive(bigBoxPath)
  const boundaryMsgs: Buffer[] = []
  for await (const m of iterateUnit(boundaryDetect.units[0])) boundaryMsgs.push(m)
  check('阈值置 0 时全部走流式，封数正确', boundaryMsgs.length === 25, `实际 ${boundaryMsgs.length}`)

  // 没有分隔符的不透明容器：走报文头扫描的流式路径
  const opaqueChunks: Buffer[] = [Buffer.from('OPAQUEHEADER\x00\x01\x02\xff', 'latin1')]
  buildSampleMessages('stream-opaque', 12, 7200).forEach((m) => {
    opaqueChunks.push(m)
    opaqueChunks.push(Buffer.from('\x00\x00', 'latin1'))
  })
  const opaquePath = join(root, 'stream-opaque.fox')
  writeFileSync(opaquePath, Buffer.concat(opaqueChunks))
  const streamOpaqueDetect = await openArchive(opaquePath)
  const streamOpaqueUnit = streamOpaqueDetect.units[0]
  const streamOpaqueMsgs: Buffer[] = []
  for await (const m of iterateUnit(streamOpaqueUnit)) streamOpaqueMsgs.push(m)
  check(
    '无分隔符容器的流式路径靠报文头定位，读出 12 封',
    streamOpaqueMsgs.length === 12,
    `实际 ${streamOpaqueMsgs.length}，策略 ${streamOpaqueUnit.strategy}`
  )

  // 把这条流式存档真的导入一遍，确认端到端可用
  const streamImport = await importArchive(
    { sourcePath: streamBoxPath, archiveTag: '流式导入测试' },
    () => {}
  )
  check(
    '流式存档能完整导入',
    streamImport.imported === 40,
    `新增 ${streamImport.imported}，失败 ${streamImport.failed}`
  )

  // 恢复阈值，别影响后续断言
  delete process.env.SIMPLEMAIL_IN_MEMORY_LIMIT
  check('阈值已恢复默认', inMemoryLimit() > 1024)


  /* ---------- 24. 文件夹管理 ---------- */
  section('24. 文件夹新建 / 重命名 / 删除（像文件管理器一样）')

  const folderAccount = repo.createAccount(
    createAccountDraft({
      email: 'folders@simplemail.local',
      displayName: '文件夹测试',
      color: '#556677',
      syncEnabled: false,
      isLocal: true
    })
  )
  const fInbox = repo.upsertFolder(folderAccount.id, 'INBOX', '收件箱', 'inbox')
  const fTrash = repo.upsertFolder(folderAccount.id, 'Trash', '垃圾箱', 'trash')

  const addFolderMail = (n: number, folderId: number): number =>
    repo.insertMail({
      accountId: folderAccount.id,
      folderId,
      uid: null,
      messageId: `folder-${n}@simplemail.local`,
      subject: `文件夹测试邮件 ${n}`,
      fromName: '',
      fromAddr: 'x@example.com',
      toText: '',
      ccText: '',
      bccText: '',
      replyTo: '',
      date: Date.now() - n * 1000,
      bodyText: '内容',
      bodyHtml: null,
      rawHeaders: '',
      size: 10,
      unread: true,
      flagged: false,
      hasAttachments: false,
      source: 'local'
    })!

  // 24.1 新建
  const created = createFolder(folderAccount.id, '客户')
  check('新建文件夹成功', created.affected === 1 && Boolean(created.folderId), JSON.stringify(created.errors))
  const customerFolder = repo.getFolder(created.folderId!)!
  check('文件夹名与路径正确', customerFolder.name === '客户' && customerFolder.path === '客户', `${customerFolder.name} / ${customerFolder.path}`)
  check('本地账户不需要同步服务器', created.serverSynced === false)

  // 24.2 重名要拦住
  const dup = createFolder(folderAccount.id, '客户')
  check('同名文件夹被拒绝', Boolean(dup.errors.length) && dup.affected === 0, dup.errors.join(','))

  // 24.3 空名字要拦住
  const empty = createFolder(folderAccount.id, '   ')
  check('空名字被拒绝', Boolean(empty.errors.length), empty.errors.join(','))

  // 24.4 建子文件夹：路径要带上父级
  const sub = createFolder(folderAccount.id, '2015', customerFolder.id)
  const subFolder = repo.getFolder(sub.folderId!)!
  check(
    '子文件夹路径包含父级',
    subFolder.path === '客户/2015',
    subFolder.path
  )

  // 24.5 放几封邮件进去，然后重命名
  for (let i = 0; i < 5; i++) addFolderMail(i + 1, customerFolder.id)
  addFolderMail(99, subFolder.id)
  check(
    '文件夹里能看到邮件',
    repo.listMails({ folderId: customerFolder.id, limit: 10 }).total === 5,
    String(repo.listMails({ folderId: customerFolder.id, limit: 10 }).total)
  )

  const renamed = renameFolder(customerFolder.id, '重要客户')
  check('重命名成功', renamed.affected === 1, renamed.errors.join(','))
  const renamedFolder = repo.getFolder(customerFolder.id)!
  check('名称已更新', renamedFolder.name === '重要客户', renamedFolder.name)
  check(
    '路径也一起更新了（否则下次同步会当成两个文件夹）',
    renamedFolder.path === '重要客户',
    renamedFolder.path
  )
  check(
    '重命名不影响文件夹里的邮件',
    repo.listMails({ folderId: customerFolder.id, limit: 10 }).total === 5
  )

  // 24.6 保护收件箱
  check('收件箱不能删除', Boolean(deleteFolder(fInbox.id, 'trash').errors.length))
  check('收件箱不能重命名', Boolean(renameFolder(fInbox.id, '新收件箱').errors.length))

  // 24.7 删除文件夹（邮件移到垃圾箱）
  const beforeTrash = repo.listMails({ folderId: fTrash.id, limit: 100 }).total
  const delTrash = deleteFolder(customerFolder.id, 'trash')
  check('删除文件夹成功', delTrash.affected >= 1, JSON.stringify(delTrash.errors))
  check('文件夹确实没了', repo.getFolder(customerFolder.id) === undefined)
  check(
    '里面的 5 封邮件被移到垃圾箱（不是删掉）',
    repo.listMails({ folderId: fTrash.id, limit: 100 }).total === beforeTrash + 5,
    `${beforeTrash} → ${repo.listMails({ folderId: fTrash.id, limit: 100 }).total}`
  )

  // 24.8 删除文件夹（连同邮件永久删除）
  const doomed = createFolder(folderAccount.id, '临时')
  const doomedId = doomed.folderId!
  for (let i = 0; i < 3; i++) addFolderMail(200 + i, doomedId)
  const doomedMails = repo.listMails({ folderId: doomedId, limit: 10 }).items.map((m) => m.id)
  const delPerm = deleteFolder(doomedId, 'delete')
  check(
    '连同邮件永久删除',
    delPerm.affected >= 1 &&
      doomedMails.every((id) => repo.getMail(id) === undefined),
    `affected=${delPerm.affected}`
  )

  // 24.9 拖拽移动：moveMailsToFolder
  const dragMail = addFolderMail(300, fInbox.id)
  const dragFolder = createFolder(folderAccount.id, '拖拽目标').folderId!
  const moved = moveMailsToFolder([dragMail], dragFolder)
  check('把邮件移动到另一个文件夹', moved.affected === 1, JSON.stringify(moved.errors))
  check(
    '邮件的 folder_id 已改变',
    repo.getMail(dragMail)?.folderId === dragFolder,
    String(repo.getMail(dragMail)?.folderId)
  )
  const movedAgain = moveMailsToFolder([dragMail], dragFolder)
  check('移到已经在的文件夹时跳过（affected=0）', movedAgain.affected === 0 && movedAgain.skipped === 1)

  const badMove = moveMailsToFolder([dragMail], 999999)
  check('移动到不存在的文件夹时报错', Boolean(badMove.errors.length))

  /* ---------- 24b. 删除后自动跳到下一封 ---------- */
  section('24b. 删除后自动跳到下一封')

  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]

  check(
    '删中间一封 → 选原来位置的下一个',
    nextAfterDelete(rows, [3], 3)?.id === 4,
    String(nextAfterDelete(rows, [3], 3)?.id)
  )
  check(
    '删最后一封 → 退回上一个',
    nextAfterDelete(rows, [5], 5)?.id === 4,
    String(nextAfterDelete(rows, [5], 5)?.id)
  )
  check(
    '删第一封 → 选新的第一封',
    nextAfterDelete(rows, [1], 1)?.id === 2,
    String(nextAfterDelete(rows, [1], 1)?.id)
  )
  check(
    '多选删除 → 跳到这一批之后的第一个',
    nextAfterDelete(rows, [2, 3, 4], 4)?.id === 5,
    String(nextAfterDelete(rows, [2, 3, 4], 4)?.id)
  )
  check(
    '多选删到末尾 → 退回这一批之前',
    nextAfterDelete(rows, [3, 4, 5], 5)?.id === 2,
    String(nextAfterDelete(rows, [3, 4, 5], 5)?.id)
  )
  check(
    '锚点为 null（没在看具体某封）→ 取列表第一封没被删的',
    nextAfterDelete(rows, [1], null)?.id === 2,
    String(nextAfterDelete(rows, [1], null)?.id)
  )
  check(
    '锚点不在列表里（比如已被删）→ 从头找第一封没被删的',
    nextAfterDelete(rows, [1], 999)?.id === 2,
    String(nextAfterDelete(rows, [1], 999)?.id)
  )
  check('全部删光 → null', nextAfterDelete(rows, [1, 2, 3, 4, 5], 3) === null)
  check('空列表 → null', nextAfterDelete([], [1], 1) === null)
  check(
    '没有删除时保持不动',
    nextAfterDelete(rows, [], 3)?.id === 3,
    String(nextAfterDelete(rows, [], 3)?.id)
  )

  /* ---------- 25-pre. 附件标记：内嵌图片不算「有附件」 ---------- */
  //
  // 曾经的 bug：列表图标按「解析出的附件总数」算（含内嵌图片），
  // 而详情页会把内嵌图片过滤掉。于是「只有签名 logo 这类内嵌图」的邮件
  // 在列表里显示了回形针图标，点开却一个附件都没有。
  section('25-pre. 附件标记（内嵌图片不算附件）')

  check(
    'hasVisibleAttachments：普通附件算',
    hasVisibleAttachments([{ isInline: false }]) === true
  )
  check(
    'hasVisibleAttachments：只有内嵌图片不算',
    hasVisibleAttachments([{ isInline: true }]) === false
  )
  check(
    'hasVisibleAttachments：内嵌 + 普通混合算',
    hasVisibleAttachments([{ isInline: true }, { isInline: false }]) === true
  )
  check('hasVisibleAttachments：空列表不算', hasVisibleAttachments([]) === false)
  check(
    'hasVisibleAttachments：缺 isInline 字段按普通附件处理',
    hasVisibleAttachments([{}]) === true
  )

  // 迁移：老库里「只有内嵌附件」的邮件要把标记清掉
  const v3Path = join(root, 'v3-attach.db')
  const v3 = openDatabase(v3Path)
  v3.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE mails (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL DEFAULT 1,
      folder_id INTEGER NOT NULL DEFAULT 1, subject TEXT NOT NULL DEFAULT '',
      has_attachments INTEGER NOT NULL DEFAULT 0,
      rules_done INTEGER NOT NULL DEFAULT 0, rules_fired TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, mail_id INTEGER NOT NULL,
      filename TEXT NOT NULL DEFAULT '', content_type TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0, content_id TEXT,
      is_inline INTEGER NOT NULL DEFAULT 0, stored_path TEXT,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO meta (key, value) VALUES ('schema_version', '3');
    -- 1 号：只有内嵌图（标记是错的，应清成 0）
    INSERT INTO mails (id, has_attachments) VALUES (1, 1);
    INSERT INTO attachments (mail_id, filename, is_inline) VALUES (1, 'logo.png', 1);
    -- 2 号：有普通附件（标记正确，应保持 1）
    INSERT INTO mails (id, has_attachments) VALUES (2, 1);
    INSERT INTO attachments (mail_id, filename, is_inline) VALUES (2, 'report.pdf', 0);
    -- 3 号：内嵌 + 普通混合（应保持 1）
    INSERT INTO mails (id, has_attachments) VALUES (3, 1);
    INSERT INTO attachments (mail_id, filename, is_inline) VALUES (3, 'logo.png', 1);
    INSERT INTO attachments (mail_id, filename, is_inline) VALUES (3, 'real.docx', 0);
    -- 4 号：正文还没下来、没有附件记录（BODYSTRUCTURE 的推测值，应保留）
    INSERT INTO mails (id, has_attachments) VALUES (4, 1);
    -- 5 号：本来就没附件
    INSERT INTO mails (id, has_attachments) VALUES (5, 0);
  `)
  migrate(v3)
  const flagOf = (id: number): number =>
    (v3.prepare('SELECT has_attachments AS h FROM mails WHERE id = ?').get(id) as { h: number }).h
  check('迁移后：只有内嵌图的邮件标记被清掉', flagOf(1) === 0, String(flagOf(1)))
  check('迁移后：有普通附件的保持不变', flagOf(2) === 1, String(flagOf(2)))
  check('迁移后：混合的保持不变', flagOf(3) === 1, String(flagOf(3)))
  check(
    '迁移后：正文未下载（无附件记录）的保留推测值，不误清',
    flagOf(4) === 1,
    String(flagOf(4))
  )
  check('迁移后：本来就没附件的仍是 0', flagOf(5) === 0, String(flagOf(5)))
  check(
    '迁移后 schema_version 升到最新',
    (v3.prepare("SELECT value AS v FROM meta WHERE key='schema_version'").get() as { v: string })
      .v === String(SCHEMA_VERSION)
  )
  v3.close()

  /* ---------- 25. mailto: 链接解析（系统邮件程序） ---------- */
  //
  // 把 SimpleMail 设为系统默认邮件程序后，网页里的「发送邮件」链接会以
  // 命令行参数的形式传进来。这里覆盖 RFC 6068 的各种写法 ——
  // 解析错了用户看到的就是「收件人/主题串了」或者「点了没反应」。
  section('25. mailto: 链接解析（系统邮件程序）')

  check(
    '只有收件人',
    (() => {
      const r = parseMailto('mailto:someone@example.com')
      return r?.to === 'someone@example.com' && !r.subject && !r.body
    })(),
    JSON.stringify(parseMailto('mailto:someone@example.com'))
  )

  check(
    '多个收件人（逗号分隔，顺手去重与去空白）',
    parseMailto('mailto:a@x.com, b@x.com ,a@x.com')?.to === 'a@x.com, b@x.com',
    String(parseMailto('mailto:a@x.com, b@x.com ,a@x.com')?.to)
  )

  check(
    '主题与正文的解码（含中文与空格）',
    (() => {
      const r = parseMailto('mailto:a@x.com?subject=%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A&body=%E4%BD%A0%E5%A5%BD%20world')
      return r?.subject === '季度报告' && r?.body === '你好 world'
    })(),
    JSON.stringify(parseMailto('mailto:a@x.com?subject=%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A&body=%E4%BD%A0%E5%A5%BD%20world'))
  )

  check(
    'cc / bcc 也能带',
    (() => {
      const r = parseMailto('mailto:a@x.com?cc=c@x.com&bcc=d@x.com')
      return r?.cc === 'c@x.com' && r?.bcc === 'd@x.com'
    })(),
    JSON.stringify(parseMailto('mailto:a@x.com?cc=c@x.com&bcc=d@x.com'))
  )

  check(
    '?to= 与路径里的收件人合并',
    parseMailto('mailto:a@x.com?to=b@x.com')?.to === 'a@x.com, b@x.com',
    String(parseMailto('mailto:a@x.com?to=b@x.com')?.to)
  )

  check(
    '正文里的 & 和 ? 不会被当成参数分隔符',
    (() => {
      const r = parseMailto('mailto:a@x.com?subject=A%26B&body=%22x%3Fy%22')
      return r?.subject === 'A&B' && r?.body === '"x?y"'
    })(),
    JSON.stringify(parseMailto('mailto:a@x.com?subject=A%26B&body=%22x%3Fy%22'))
  )

  // 保留字段大小写不敏感；未知字段忽略（写信窗口没有对应输入框，
  // 硬塞进正文只会让人困惑）
  check(
    '字段名大小写不敏感、未知字段被忽略',
    (() => {
      const r = parseMailto('mailto:a@x.com?SUBJECT=Hi&In-Reply-To=%3Cx%40y%3E')
      return r?.subject === 'Hi' && r?.body === ''
    })(),
    JSON.stringify(parseMailto('mailto:a@x.com?SUBJECT=Hi&In-Reply-To=%3Cx%40y%3E'))
  )

  // RFC 6068：`+` 是普通字符，不像 form-urlencoded 那样代表空格
  check(
    '+ 保持为普通字符（RFC 6068，不做空格转换）',
    parseMailto('mailto:a@x.com?subject=a+b')?.subject === 'a+b',
    String(parseMailto('mailto:a@x.com?subject=a+b')?.subject)
  )

  check(
    '畸形的百分号转义不会让整条链接作废',
    parseMailto('mailto:a@x.com?subject=100%off')?.subject === '100%off',
    String(parseMailto('mailto:a@x.com?subject=100%off')?.subject)
  )

  check(
    '空 mailto: 也合法（打开空白写信窗口）',
    (() => {
      const r = parseMailto('mailto:')
      return r !== null && isMailtoRequestEmpty(r)
    })(),
    JSON.stringify(parseMailto('mailto:'))
  )

  check('大小写与前后空白都能容忍', parseMailto('  MAILTO:a@x.com  ')?.to === 'a@x.com')

  check('不是 mailto 的字符串返回 null', parseMailto('https://example.com') === null)
  check('非字符串返回 null', parseMailto(undefined as unknown as string) === null)

  check(
    '从命令行参数里挑出 mailto（登录/开关参数混在一起）',
    (() => {
      const r = parseMailtoFromArgv(['/opt/SimpleMail/simplemail', '--no-sandbox', 'mailto:a@x.com?subject=Hi'])
      return r?.to === 'a@x.com' && r?.subject === 'Hi'
    })(),
    JSON.stringify(parseMailtoFromArgv(['/opt/SimpleMail/simplemail', '--no-sandbox', 'mailto:a@x.com?subject=Hi']))
  )

  check(
    '没有 mailto 参数时返回 null（普通启动不该弹出写信窗口）',
    parseMailtoFromArgv(['/opt/SimpleMail/simplemail', '--no-sandbox']) === null
  )

  // 往返：拼出来的链接必须能被自己解析回去
  check(
    'build → parse 往返一致',
    (() => {
      const src = { to: 'a@x.com, b@x.com', cc: 'c@x.com', subject: '季度报告', body: '第一行\n第二行 & 特殊字符' }
      const back = parseMailto(buildMailto(src))
      return (
        back?.to === src.to &&
        back?.cc === src.cc &&
        back?.subject === src.subject &&
        back?.body === src.body
      )
    })(),
    JSON.stringify(parseMailto(buildMailto({ to: 'a@x.com', subject: '季度报告', body: '第一行\n第二行 & 特殊字符' })))
  )

  /* ---------- 25a. 附件（右键文件 →「邮件发送」） ---------- */
  //
  // 文件管理器里「邮件发送…」执行的是 `xdg-email --attach <文件>`，
  // 而 xdg-email 对非 Thunderbird 的客户端只会把附件塞进 mailto URL：
  //   mailto:addr?subject=...&attach=%2Ftmp%2F%E6%96%87%E4%BB%B6.txt
  // 所以「拿得到附件」的关键就是把 attach 参数解析出来。

  check(
    '单个 attach 参数',
    (() => {
      const r = parseMailto('mailto:a@x.com?attach=%2Ftmp%2F%25E6%2596%2587.txt')
      return r?.attachments.length === 1
    })(),
    JSON.stringify(parseMailto('mailto:a@x.com?attach=%2Ftmp%2F%25E6%2596%2587.txt')?.attachments)
  )

  check(
    '多个 attach 参数按顺序保留',
    (() => {
      const r = parseMailto('mailto:a@x.com?attach=%2Ftmp%2Fa.txt&attach=%2Ftmp%2Fb.pdf')
      return r?.attachments.join('|') === '/tmp/a.txt|/tmp/b.pdf'
    })(),
    String(parseMailto('mailto:a@x.com?attach=%2Ftmp%2Fa.txt&attach=%2Ftmp%2Fb.pdf')?.attachments.join('|'))
  )

  check(
    '带空格与中文的路径能正确解码',
    (() => {
      const url = buildMailto({ to: 'a@x.com', attachments: ['/tmp/我的 文件.txt'] })
      return parseMailto(url)?.attachments[0] === '/tmp/我的 文件.txt'
    })(),
    String(parseMailto(buildMailto({ to: 'a@x.com', attachments: ['/tmp/我的 文件.txt'] }))?.attachments[0])
  )

  check(
    'file:// 形式的附件路径被还原成普通路径',
    (() => {
      const r = parseMailto('mailto:a@x.com?attach=file%3A%2F%2F%2Ftmp%2Fx.txt')
      return r?.attachments[0] === '/tmp/x.txt'
    })(),
    String(parseMailto('mailto:a@x.com?attach=file%3A%2F%2F%2Ftmp%2Fx.txt')?.attachments[0])
  )

  check(
    '重复的附件只保留一次',
    (() => {
      const r = parseMailto('mailto:a@x.com?attach=%2Ftmp%2Fa.txt&attach=%2Ftmp%2Fa.txt')
      return r?.attachments.length === 1
    })(),
    JSON.stringify(parseMailto('mailto:a@x.com?attach=%2Ftmp%2Fa.txt&attach=%2Ftmp%2Fa.txt')?.attachments)
  )

  check(
    '只有附件、没有收件人时不算「空请求」',
    (() => {
      const r = parseMailto('mailto:?attach=%2Ftmp%2Fa.txt')
      return r !== null && !isMailtoRequestEmpty(r)
    })(),
    JSON.stringify(parseMailto('mailto:?attach=%2Ftmp%2Fa.txt'))
  )

  check(
    '链接里既没有收件人也没有附件才算空',
    isMailtoRequestEmpty(parseMailto('mailto:')!)
  )

  check(
    'attach 与其它字段可以共存',
    (() => {
      const r = parseMailto(
        'mailto:a@x.com?subject=%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A&body=%E8%AF%B7%E7%9C%8B&attach=%2Ftmp%2Fa.txt'
      )
      return r?.subject === '季度报告' && r?.body === '请看' && r?.attachments[0] === '/tmp/a.txt'
    })(),
    JSON.stringify(parseMailto('mailto:a@x.com?subject=%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A&body=%E8%AF%B7%E7%9C%8B&attach=%2Ftmp%2Fa.txt'))
  )

  // 有的文件管理器把文件当裸参数传进来，而不是走 attach=
  const fakeExisting = (p: string): boolean => ['/tmp/one.txt', '/tmp/two.pdf'].includes(p)
  check(
    '裸文件参数也会被收作附件',
    (() => {
      const r = parseMailtoFromArgv(
        ['/opt/SimpleMail/simplemail', '--no-sandbox', '/tmp/one.txt', '/tmp/two.pdf'],
        fakeExisting
      )
      return r?.attachments.join('|') === '/tmp/one.txt|/tmp/two.pdf'
    })(),
    String(parseMailtoFromArgv(['x', '/tmp/one.txt', '/tmp/two.pdf'], fakeExisting)?.attachments.join('|'))
  )
  check(
    '不存在的裸参数不会被当成附件',
    (() => {
      const r = parseMailtoFromArgv(['x', '/tmp/nope.txt', '--flag'], fakeExisting)
      return r === null
    })()
  )
  // argv[0] 是程序自身路径（打包后是 simplemail.bin）—— 它确实是个存在的
  // 文件，所以必须显式跳过。曾经就是这么把程序二进制当成附件带上的。
  check(
    'argv[0]（程序自身）不会被当成附件',
    (() => {
      const r = parseMailtoFromArgv(
        ['/opt/SimpleMail/simplemail.bin', 'mailto:a@x.com', '/tmp/one.txt'],
        fakeExisting
      )
      return r?.attachments.join('|') === '/tmp/one.txt'
    })(),
    JSON.stringify(
      parseMailtoFromArgv(
        ['/opt/SimpleMail/simplemail.bin', 'mailto:a@x.com', '/tmp/one.txt'],
        fakeExisting
      )?.attachments
    )
  )
  check(
    '开关参数不会被误当成文件（即使同名文件存在）',
    (() => {
      const r = parseMailtoFromArgv(['x', '--user-data-dir=/tmp/one.txt'], fakeExisting)
      return r === null
    })()
  )
  check(
    'mailto 与裸文件参数可以同时出现',
    (() => {
      const r = parseMailtoFromArgv(
        ['x', 'mailto:a@x.com?subject=Hi', '/tmp/one.txt'],
        fakeExisting
      )
      return r?.to === 'a@x.com' && r?.attachments.join('|') === '/tmp/one.txt'
    })(),
    JSON.stringify(parseMailtoFromArgv(['x', 'mailto:a@x.com?subject=Hi', '/tmp/one.txt'], fakeExisting))
  )
  check(
    'mailto 里已有同一附件时不重复添加',
    (() => {
      const r = parseMailtoFromArgv(
        ['x', 'mailto:a@x.com?attach=%2Ftmp%2Fone.txt', '/tmp/one.txt'],
        fakeExisting
      )
      return r?.attachments.length === 1
    })(),
    JSON.stringify(parseMailtoFromArgv(['x', 'mailto:a@x.com?attach=%2Ftmp%2Fone.txt', '/tmp/one.txt'], fakeExisting)?.attachments)
  )

  // 主进程的附件校验：找不到的必须单独报出来，不能默默丢
  const attProbe = join(root, 'attachment-probe.txt')
  writeFileSync(attProbe, '附件内容')
  const attRes = resolveMailtoAttachments([attProbe, join(root, 'no-such-file.bin')])
  check(
    '附件校验：存在的进列表、不存在的单独报出',
    attRes.files.length === 1 &&
      attRes.files[0].filename === 'attachment-probe.txt' &&
      attRes.missing.length === 1,
    JSON.stringify({ files: attRes.files.map((f) => f.filename), missing: attRes.missing })
  )
  check('附件校验会带上文件大小', attRes.files[0]?.size > 0, String(attRes.files[0]?.size))

  /* ---------- 25b. 系统注册（desktop 文件与 xdg 路径） ---------- */

  const desktopBody = desktopFileBody()
  check(
    '生成的 desktop 声明了 mailto 处理能力',
    /^MimeType=x-scheme-handler\/mailto;$/m.test(desktopBody),
    desktopBody.split('\n').find((l) => l.startsWith('MimeType')) ?? '（没有 MimeType 行）'
  )
  check(
    '生成的 desktop 里 Exec 带 %U（系统靠它把链接当参数传进来）',
    /^Exec=.*%U$/m.test(desktopBody),
    desktopBody.split('\n').find((l) => l.startsWith('Exec')) ?? '（没有 Exec 行）'
  )
  check(
    '生成的 desktop 分类为 Network;Email; 且只有一个主分类',
    /^Categories=Network;Email;$/m.test(desktopBody)
  )
  check('desktop 文件 id 固定', DESKTOP_ID === 'simplemail.desktop', DESKTOP_ID)

  // XDG_DATA_HOME 必须被尊重：用户把它指到别处时，桌面环境只去那里找
  check(
    '免安装形态的 desktop 落点跟随 XDG_DATA_HOME',
    (() => {
      const prev = process.env.XDG_DATA_HOME
      process.env.XDG_DATA_HOME = '/tmp/simplemail-xdg-probe'
      const p = userDesktopPath()
      if (prev === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prev
      return p === '/tmp/simplemail-xdg-probe/applications/simplemail.desktop'
    })()
  )
  check(
    '未设置 XDG_DATA_HOME 时退回 ~/.local/share',
    (() => {
      const prev = process.env.XDG_DATA_HOME
      delete process.env.XDG_DATA_HOME
      const p = userDesktopPath()
      if (prev !== undefined) process.env.XDG_DATA_HOME = prev
      return /\/\.local\/share\/applications\/simplemail\.desktop$/.test(p)
    })()
  )

  /* ── 数据目录命名（防止 1.1.7 那个「升级后邮件不见了」的回归重演）──
   *
   * 事故经过：1.1.7 为了写诊断日志，把一个 app.getPath('userData') 的调用
   * 提到了模块加载期，而 app.setName('SimpleMail') 还在文件末尾，
   * 于是 userData 按 package.json 的 name（小写 simplemail）算，
   * 从 `~/.config/SimpleMail` 变成了 `~/.config/simplemail` ——
   * 1.1.6 及更早的用户升级后邮件就"不见了"。
   *
   * 断言在**真实启动环境**里检查默认目录名，这样只要有人再把 getPath
   * 提到 setName 之前，自检立刻失败。
   */
  // 注意：这里**不能**断言 defaultDataDir() 的结尾是 SimpleMail ——
  // 自检自己会把 userData 指到临时目录，那样断言恒假。
  // 「打包产物真的用了大写目录」由 scripts/verify-package.sh 起真程序验证。
  check(
    '兼容目录的名字确实是小写 simplemail（1.1.7–1.2.0 用过的那个）',
    basename(legacyDataDir()) === 'simplemail',
    legacyDataDir()
  )

  /* 目标目录校验：这几点拦不住的话，用户能把数据搬进自己里面去 */
  check(
    '数据目录校验：拒绝当前正在使用的目录',
    checkDataDirTarget(app.getPath('userData')).ok === false
  )
  check(
    '数据目录校验：拒绝当前数据目录的子目录',
    checkDataDirTarget(join(app.getPath('userData'), 'sub')).ok === false
  )
  check('数据目录校验：拒绝根目录', checkDataDirTarget('/').ok === false)
  check(
    '数据目录校验：接受一个正常的独立目录',
    (() => {
      const target = join(root, 'datadir-target-ok')
      const r = checkDataDirTarget(target)
      return r.ok === true
    })()
  )

  // mailtoStatus 在真实环境里也要能跑通（不抛异常、字段齐全）
  const mtStatus = mailtoStatus()
  check(
    'mailtoStatus 返回完整状态',
    ['desktopFile', 'currentDefault', 'isDefault', 'canSetAutomatically', 'manualCommand'].every(
      (k) => k in mtStatus
    ),
    JSON.stringify(mtStatus)
  )
  check(
    '手动命令是标准写法',
    mtStatus.manualCommand === 'xdg-mime default simplemail.desktop x-scheme-handler/mailto',
    mtStatus.manualCommand
  )

  /* ---------- 收尾 ---------- */
  closeDb()
  if (existsSync(root)) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* 临时目录删不掉无所谓 */
    }
  }

  section('结果')
  console.log(`通过 ${passed} 项，失败 ${failed} 项`)
  if (failures.length) {
    console.log('\n失败明细：')
    for (const f of failures) console.log(`  · ${f}`)
  }
  return Promise.resolve()
}

/* ───────────────────── CRC32（构造 ZIP 用） ───────────────────── */

let crcTable: number[] | null = null
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/* ───────────────────── 入口 ───────────────────── */

app
  .whenReady()
  .then(async () => {
    // 关键：必须在任何 getDb() 之前把 userData 指到临时目录，
    // 避免自检污染真实的邮件数据库。
    const root = mkdtempSync(join(tmpdir(), 'simplemail-selftest-'))
    app.setPath('userData', join(root, 'userData'))
    mkdirSync(join(root, 'userData'), { recursive: true })
    console.log(`临时工作目录：${root}`)
    try {
      await run(root)
    } catch (err) {
      console.error('\n自检过程中抛出异常：', err)
      failed++
      failures.push(`异常：${err instanceof Error ? err.stack : String(err)}`)
    }
    console.log(`\nSELFTEST_RESULT passed=${passed} failed=${failed}`)
    app.exit(failed === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error(err)
    app.exit(2)
  })
