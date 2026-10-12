/**
 * POP3 客户端（RFC 1939）——自己实现，不引第三方库。
 *
 * 为什么自己写：POP3 本身是极简单的行协议，但有几个必须处理对的细节，
 * 交给不透明的库反而不好控制：
 *   · **多行响应的结束标志**：单独一行的 `.`；
 *   · **点填充（dot-stuffing）**：正文里行首的 `.` 在传输时会写成 `..`，
 *     收下来必须还原，否则邮件内容会多出一个点（历史上这类 bug 很常见）；
 *   · **字节透明**：报文里可能有任意 8bit 字节，全程按 Buffer 处理，
 *     绝不用 utf8 字符串中转，否则中文/二进制附件会被破坏；
 *   · **隐式 TLS 与 STLS 升级**两条路都要支持；
 *   · **超时与中断**要能真正打断一个卡住的 RETR。
 *
 * IMAP 与 POP3 的模型差异（见 shared/types.ts 的 MailProtocol 注释）：
 * POP3 只有收件箱，没有 UID，增量靠 UIDL。
 */

import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { Account, Folder, SyncProgress } from '@shared/types'
import * as repo from '../db/repo'
import { parseMessage } from './parser'
import { storeAttachment } from './attachments'
import { clearSync, registerSync } from './sync-control'
import { applyRulesToMail } from '../rules'

const CRLF = Buffer.from('\r\n')

/* ───────────────────────── 行读取器 ───────────────────────── */

interface LineWaiter {
  resolve: (line: Buffer) => void
  reject: (err: Error) => void
}

/**
 * 把 TCP 流切成「行」，全程基于 Buffer，不经过字符串，保证字节不被破坏。
 */
class LineReader {
  private buffer: Buffer = Buffer.alloc(0)
  private waiters: LineWaiter[] = []
  private failure: Error | null = null
  private finished = false

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    this.drain()
  }

  fail(err: Error): void {
    this.failure = err
    this.drain()
  }

  end(): void {
    this.finished = true
    this.drain()
  }

  private takeLine(): Buffer | null {
    const idx = this.buffer.indexOf(0x0a)
    if (idx === -1) return null
    let stop = idx
    if (stop > 0 && this.buffer[stop - 1] === 0x0d) stop--
    const line = this.buffer.subarray(0, stop)
    this.buffer = this.buffer.subarray(idx + 1)
    return line
  }

  private drain(): void {
    while (this.waiters.length) {
      if (this.failure) {
        this.waiters.shift()!.reject(this.failure)
        continue
      }
      const line = this.takeLine()
      if (line) {
        // 复制一份，避免后续 push 复用底层内存
        this.waiters.shift()!.resolve(Buffer.from(line))
        continue
      }
      if (this.finished) {
        if (this.buffer.length) {
          const rest = this.buffer
          this.buffer = Buffer.alloc(0)
          this.waiters.shift()!.resolve(Buffer.from(rest))
          continue
        }
        this.waiters.shift()!.reject(new Error('POP3 连接已被服务器关闭'))
        continue
      }
      break
    }
  }

  readLine(): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      this.waiters.push({ resolve, reject })
      this.drain()
    })
  }
}

/* ───────────────────────── 客户端 ───────────────────────── */

export interface Pop3Config {
  host: string
  port: number
  /** true = 隐式 TLS（995）；false = 明文，若服务器支持会自动尝试 STLS 升级 */
  secure: boolean
  username: string
  password: string
  timeoutMs?: number
}

export class Pop3Error extends Error {
  constructor(
    message: string,
    readonly serverResponse?: string
  ) {
    super(message)
    this.name = 'Pop3Error'
  }
}

export class Pop3Client {
  private socket: Socket | null = null
  private reader = new LineReader()
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  /** CAPA 返回的能力列表；null 表示服务器不支持 CAPA 或尚未查询 */
  private capabilities: string[] | null = null

  constructor(private readonly config: Pop3Config) {}

  /* ── 连接 ── */

  async connect(): Promise<void> {
    const { host, port, secure, timeoutMs = 60_000 } = this.config

    this.socket = secure
      ? tlsConnect({ host, port, servername: host, rejectUnauthorized: false })
      : netConnect({ host, port })

    this.socket.setTimeout(timeoutMs)
    this.socket.setNoDelay(true)

    this.socket.on('data', (chunk: Buffer) => this.reader.push(chunk))
    this.socket.on('error', (err: Error) => this.reader.fail(err))
    this.socket.on('close', () => {
      this.closed = true
      this.reader.end()
    })
    this.socket.on('timeout', () => {
      const err = new Pop3Error(`POP3 操作超时（${timeoutMs} ms）`)
      this.reader.fail(err)
      this.socket?.destroy()
    })

    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => resolve()
      if (secure) this.socket!.once('secureConnect', onReady)
      else this.socket!.once('connect', onReady)
      this.socket!.once('error', reject)
    })

    // 服务器问候语
    await this.expectOk('连接问候')

    // 明文连接时，尽量升级到 TLS
    if (!secure) {
      await this.tryStartTls()
    }
  }

  private async tryStartTls(): Promise<void> {
    const caps = await this.capa()
    if (!caps || !caps.some((c) => c.toUpperCase() === 'STLS')) return

    await this.expectOk('STLS', 'STLS')
    // 升级现有 socket
    const plain = this.socket!
    plain.removeAllListeners('data')
    plain.removeAllListeners('timeout')
    // 必须暂停：明文阶段 socket 处于 flowing 模式，直接包成 TLS 会让
    // 服务端回过来的 ServerHello 因为没有 data 监听者而被丢掉，握手卡死到超时。
    plain.pause()

    const secured = tlsConnect({
      socket: plain,
      servername: this.config.host,
      rejectUnauthorized: false
    })
    this.socket = secured
    this.reader = new LineReader()
    secured.setTimeout(this.config.timeoutMs ?? 60_000)
    secured.on('data', (chunk: Buffer) => this.reader.push(chunk))
    secured.on('error', (err: Error) => this.reader.fail(err))
    secured.on('close', () => {
      this.closed = true
      this.reader.end()
    })
    secured.on('timeout', () => {
      this.reader.fail(new Pop3Error('POP3 操作超时'))
      secured.destroy()
    })

    await new Promise<void>((resolve, reject) => {
      secured.once('secureConnect', resolve)
      secured.once('error', reject)
    })
  }

  /* ── 命令收发 ── */

  private write(line: string): void {
    if (!this.socket || this.closed) throw new Pop3Error('POP3 连接不可用')
    this.socket.write(`${line}\r\n`)
  }

  /** 串行化命令，避免响应错位 */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async readStatusLine(): Promise<{ ok: boolean; text: string }> {
    const line = await this.reader.readLine()
    const text = line.toString('utf8')
    return { ok: text.startsWith('+OK'), text }
  }

  /** 发一条单行命令，返回 +OK 后面的文本 */
  async command(cmd: string, redact = false): Promise<string> {
    return this.serialize(async () => {
      this.write(cmd)
      const { ok, text } = await this.readStatusLine()
      if (!ok) {
        throw new Pop3Error(
          `服务器拒绝命令：${redact ? cmd.split(' ')[0] + ' ***' : cmd}`,
          text
        )
      }
      return text.slice(3).trim()
    })
  }

  /** 发一条命令并期待 +OK，不关心里面的内容 */
  private async expectOk(what: string, cmd?: string): Promise<string> {
    return this.serialize(async () => {
      if (cmd) this.write(cmd)
      const { ok, text } = await this.readStatusLine()
      if (!ok) throw new Pop3Error(`${what} 失败`, text)
      return text
    })
  }

  /** 读一段多行响应（以单独一行 `.` 结束），自动还原点填充 */
  private async readMultiline(): Promise<Buffer> {
    const parts: Buffer[] = []
    for (;;) {
      const line = await this.reader.readLine()
      if (line.length === 1 && line[0] === 0x2e) break
      // 点填充还原：行首的 ".." -> "."
      parts.push(line.length > 0 && line[0] === 0x2e ? line.subarray(1) : line)
      if (parts.length > 2_000_000) throw new Pop3Error('多行响应异常过长')
    }
    if (!parts.length) return Buffer.alloc(0)
    const out: Buffer[] = []
    parts.forEach((p, i) => {
      if (i > 0) out.push(CRLF)
      out.push(p)
    })
    return Buffer.concat(out)
  }

  private async commandMultiline(cmd: string): Promise<Buffer> {
    return this.serialize(async () => {
      this.write(cmd)
      const { ok, text } = await this.readStatusLine()
      if (!ok) throw new Pop3Error(`服务器拒绝命令：${cmd}`, text)
      return this.readMultiline()
    })
  }

  /* ── 认证 ── */

  async login(): Promise<void> {
    await this.command(`USER ${this.config.username}`)
    // PASS 里可能含授权码，日志里不要打出来
    await this.command(`PASS ${this.config.password}`, true)
  }

  /* ── 常用命令 ── */

  /** CAPA：可选命令。服务器不支持时返回 null。 */
  async capa(): Promise<string[] | null> {
    if (this.capabilities) return this.capabilities
    try {
      const body = await this.commandMultiline('CAPA')
      this.capabilities = body
        .toString('utf8')
        .split(/\r?\n/)
        .map((l) => l.trim().split(/\s+/)[0])
        .filter(Boolean)
      return this.capabilities
    } catch {
      this.capabilities = []
      return null
    }
  }

  async stat(): Promise<{ count: number; size: number }> {
    const text = await this.command('STAT')
    const m = /^(\d+)\s+(\d+)/.exec(text.trim())
    if (!m) throw new Pop3Error(`STAT 响应无法解析：${text}`)
    return { count: Number(m[1]), size: Number(m[2]) }
  }

  /** LIST：消息号 → 字节数 */
  async list(): Promise<Map<number, number>> {
    const body = await this.commandMultiline('LIST')
    const map = new Map<number, number>()
    for (const line of body.toString('utf8').split(/\r?\n/)) {
      const m = /^(\d+)\s+(\d+)/.exec(line.trim())
      if (m) map.set(Number(m[1]), Number(m[2]))
    }
    return map
  }

  /**
   * UIDL：消息号 → 唯一标识。
   * 服务器不支持 UIDL（RFC 里它是可选的）时返回 null，
   * 调用方需要退化为「全量下载 + 按 Message-ID 去重」。
   */
  async uidl(): Promise<Map<number, string> | null> {
    try {
      const body = await this.commandMultiline('UIDL')
      const map = new Map<number, string>()
      for (const line of body.toString('utf8').split(/\r?\n/)) {
        const m = /^(\d+)\s+(\S+)/.exec(line.trim())
        if (m) map.set(Number(m[1]), m[2])
      }
      return map.size ? map : null
    } catch {
      return null
    }
  }

  /** RETR：取回整封邮件的原始字节 */
  async retr(messageNumber: number): Promise<Buffer> {
    return this.commandMultiline(`RETR ${messageNumber}`)
  }

  /** TOP：只取头部 + 前 n 行正文（可选命令） */
  async top(messageNumber: number, lines = 0): Promise<Buffer> {
    return this.commandMultiline(`TOP ${messageNumber} ${lines}`)
  }

  /** DELE：标记删除，QUIT 时才真正生效 */
  async dele(messageNumber: number): Promise<void> {
    await this.command(`DELE ${messageNumber}`)
  }

  async rset(): Promise<void> {
    await this.command('RSET')
  }

  async noop(): Promise<void> {
    await this.command('NOOP')
  }

  /** QUIT：提交本会话里的所有 DELE */
  async quit(): Promise<void> {
    try {
      await this.command('QUIT')
    } catch {
      /* 服务器有时直接断连，忽略 */
    }
    this.close()
  }

  close(): void {
    this.closed = true
    try {
      this.socket?.destroy()
    } catch {
      /* ignore */
    }
    this.socket = null
  }
}

/* ───────────────────────── 账户级封装 ───────────────────────── */

function configFromAccount(account: Account): Pop3Config {
  return {
    host: account.pop3Host,
    port: account.pop3Port,
    secure: account.pop3Secure,
    username: account.username || account.email,
    password: account.password
  }
}

export async function testPop3(account: Account): Promise<{ ok: boolean; error?: string }> {
  const client = new Pop3Client(configFromAccount(account))
  try {
    await client.connect()
    await client.login()
    const stat = await client.stat()
    await client.quit()
    return { ok: true, error: `邮箱里有 ${stat.count} 封邮件` }
  } catch (err) {
    client.close()
    const e = err as Pop3Error
    return {
      ok: false,
      error: e.serverResponse ? `${e.message}（服务器说：${e.serverResponse}）` : e.message
    }
  }
}

/* ───────────────────────── 同步 ───────────────────────── */

export interface Pop3SyncOptions {
  /** 单次最多下载多少封（防止超大邮箱一次拉太久），默认不限 */
  maxMessages?: number
  onProgress?: (p: SyncProgress) => void
}

/** POP3 账户的本地文件夹（POP3 没有服务器文件夹，这些纯粹在本地） */
export function ensurePop3Folders(accountId: number): {
  inbox: Folder
  drafts: Folder
  sent: Folder
  trash: Folder
} {
  return {
    inbox: repo.upsertFolder(accountId, 'POP3/INBOX', '收件箱', 'inbox'),
    drafts: repo.upsertFolder(accountId, 'POP3/Drafts', '草稿箱', 'drafts'),
    sent: repo.upsertFolder(accountId, 'POP3/Sent', '已发送', 'sent'),
    trash: repo.upsertFolder(accountId, 'POP3/Trash', '垃圾箱', 'trash')
  }
}

/**
 * 同步一个 POP3 账户。
 *
 * 流程：UIDL 比对本地已有集合 → 只下载新的 → 解析入库 → 视配置决定是否 DELE。
 * 注意 DELE 只在**同一会话内成功入库之后**才发出，且 abort 时不会提交删除。
 */
export async function syncPop3Account(
  account: Account,
  options: Pop3SyncOptions = {}
): Promise<void> {
  const report = options.onProgress ?? ((): void => {})
  const flag = registerSync(account.id)

  const emit = (
    p: Partial<SyncProgress> & { phase: SyncProgress['phase']; message: string }
  ): void => {
    report({
      accountId: account.id,
      phase: p.phase,
      folderName: p.folderName ?? '收件箱',
      current: p.current ?? 0,
      total: p.total ?? 0,
      message: p.message,
      error: p.error
    })
  }

  const folders = ensurePop3Folders(account.id)
  const client = new Pop3Client(configFromAccount(account))

  try {
    emit({ phase: 'connecting', message: `正在连接 ${account.pop3Host}:${account.pop3Port}…` })
    await client.connect()
    await client.login()

    emit({ phase: 'folders', message: '正在读取邮箱状态…' })
    const stat = await client.stat()

    const uidl = await client.uidl()
    const list = await client.list()

    if (!uidl) {
      emit({
        phase: 'headers',
        message:
          '该服务器不支持 UIDL，无法做增量判断，将尝试下载全部邮件并依靠 Message-ID 去重…'
      })
    }

    const known = new Set(repo.listPop3Uids(folders.inbox.id))

    // 消息号升序 = 从旧到新，先下旧的更符合直觉
    const numbers = [...list.keys()].sort((a, b) => a - b)
    let targets: number[]
    if (uidl) {
      targets = numbers.filter((n) => !known.has(uidl.get(n) ?? ''))
    } else {
      targets = numbers
    }

    const max = options.maxMessages && options.maxMessages > 0 ? options.maxMessages : targets.length
    const batch = targets.slice(0, max)
    const remaining = targets.length - batch.length

    emit({
      phase: 'bodies',
      current: 0,
      total: batch.length,
      message:
        batch.length === 0
          ? `没有新邮件（服务器上共 ${stat.count} 封）`
          : `开始下载 ${batch.length} 封新邮件…`
    })

    let imported = 0
    let skipped = 0
    let failed = 0
    const storedNumbers: number[] = []

    for (let i = 0; i < batch.length; i++) {
      if (flag.aborted) break
      const n = batch[i]
      try {
        const raw = await client.retr(n)
        const parsed = await parseMessage(raw)

        const mailId = repo.insertMail({
          accountId: account.id,
          folderId: folders.inbox.id,
          uid: null,
          pop3Uid: uidl ? (uidl.get(n) ?? null) : null,
          messageId: parsed.messageId,
          subject: parsed.subject,
          fromName: parsed.fromName,
          fromAddr: parsed.fromAddr,
          toText: parsed.toText,
          ccText: parsed.ccText,
          bccText: parsed.bccText,
          replyTo: parsed.replyTo,
          date: parsed.date,
          bodyText: parsed.bodyText,
          bodyHtml: parsed.bodyHtml,
          rawHeaders: parsed.rawHeaders,
          inReplyTo: parsed.inReplyTo,
          references: parsed.references,
          size: parsed.size,
          unread: true,
          flagged: false,
          hasAttachments: parsed.attachments.length > 0,
          source: 'pop3'
        })

        if (mailId === null) {
          skipped++
        } else {
          for (let a = 0; a < parsed.attachments.length; a++) {
            const att = parsed.attachments[a]
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
          storedNumbers.push(n)
          try {
            applyRulesToMail(mailId, true)
          } catch {
            /* 规则出错不影响收信 */
          }
        }
      } catch (err) {
        failed++
        emit({
          phase: 'bodies',
          current: i + 1,
          total: batch.length,
          message: `第 ${n} 封下载失败：${err instanceof Error ? err.message : String(err)}`
        })
      }

      if (i % 5 === 0 || i === batch.length - 1) {
        emit({
          phase: 'bodies',
          current: i + 1,
          total: batch.length,
          message: `已下载 ${i + 1}/${batch.length}（新增 ${imported}）`
        })
      }
    }

    // 删除服务器副本：只在用户显式开启、且没有中断时执行。
    //
    // ⚠️ POP3 的 DELE 只是「标记」，真正生效发生在 QUIT 时；如果不发 QUIT
    // 就直接断开，服务器会回滚全部删除标记。所以下面每条路径都必须明确收尾：
    //   · 中断 → RSET 显式回滚 + 直接断开（不 QUIT）；
    //   · 正常 → 需要删则先 DELE，最后统一 QUIT 提交。
    let deleted = 0
    if (flag.aborted) {
      try {
        await client.rset()
      } catch {
        /* ignore */
      }
      client.close()
    } else {
      if (account.pop3DeleteAfterFetch && storedNumbers.length) {
        emit({ phase: 'bodies', message: `正在从服务器删除 ${storedNumbers.length} 封已下载邮件…` })
        for (const n of storedNumbers) {
          try {
            await client.dele(n)
            deleted++
          } catch {
            /* 单封删除失败不影响其它 */
          }
        }
      }
      // QUIT：提交上面的 DELE（若没有 DELE 则只是优雅结束会话）
      await client.quit()
    }

    repo.touchAccountSync(account.id)

    const parts = [`新增 ${imported} 封`]
    if (skipped) parts.push(`跳过重复 ${skipped} 封`)
    if (failed) parts.push(`失败 ${failed} 封`)
    if (deleted) parts.push(`已从服务器删除 ${deleted} 封`)
    if (remaining > 0) parts.push(`还有 ${remaining} 封未下载，可再次同步`)
    if (flag.aborted) parts.push('（已取消）')

    emit({ phase: 'done', message: `同步完成：${parts.join('，')}` })
  } catch (err) {
    const e = err as Pop3Error
    const detail = e.serverResponse ? `${e.message}（服务器说：${e.serverResponse}）` : e.message
    emit({ phase: 'error', message: '同步失败', error: detail })
    throw err
  } finally {
    client.close()
    clearSync(account.id)
  }
}
