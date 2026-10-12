/**
 * 测试用的 POP3 服务器（仅自检使用，不会进应用包）。
 *
 * 为什么值得单独写一个：POP3 有几个「看起来能跑、接真机就出错」的细节 ——
 * 点填充（dot-stuffing）、多行响应的结束标志、UIDL 可选、STLS 升级、
 * DELE 只在 QUIT 时提交。这些只有拿一个真服务器对着跑才能验证，
 * 而连真邮箱做自动化测试显然不现实（也没有账号）。
 */

import { createServer as createTcpServer, type Server, type Socket } from 'node:net'
import {
  createServer as createTlsServer,
  createSecureContext,
  TLSSocket,
  type SecureContext
} from 'node:tls'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export interface MockMessage {
  uid: string
  raw: Buffer
}

export interface MockPop3Options {
  messages: MockMessage[]
  username?: string
  password?: string
  /** false 时对 UIDL 返回 -ERR，用来模拟不支持 UIDL 的老服务器 */
  supportUidl?: boolean
  /**
   * 隐式 TLS：服务器从第一个字节就是 TLS（真实世界的 995 端口）。
   * ⚠️ 不要和 stls 混用同一个字段 —— 如果这里给了证书但客户端是明文连接，
   * 服务器会在等 ClientHello、客户端在等问候语，双方死等到超时。
   */
  tls?: { key: Buffer; cert: Buffer }
  /**
   * STLS 升级：服务器一开始是明文，在 CAPA 里公布 STLS，
   * 收到 STLS 命令后再升级（真实世界的 110 端口）。
   */
  stls?: { key: Buffer; cert: Buffer }
  /** true 时明文连接在升级 STLS 之前拒绝 USER/PASS */
  requireStls?: boolean
}

export interface MockState {
  commands: string[]
  logins: { user: string; pass: string }[]
  /** QUIT 时真正提交删除的消息序号（1 基） */
  committedDeletions: number[]
  /** 会话中被 DELE 过但最终未提交的（用来断言「取消不删」） */
  rolledBackDeletions: number[]
  retrieved: number[]
  connections: number
  tlsNegotiations: number
}

export interface MockPop3Server {
  port: number
  state: MockState
  close(): Promise<void>
}

const CRLF = '\r\n'

/**
 * POP3 点填充：行首的 `.` 传成 `..`。
 *
 * 发送前必须先把换行归一化成 CRLF —— 真实服务器就是这么做的（POP3 只有 CRLF
 * 一种行结束符）。如果跳过这一步，正文里 LF-only 的那一行 `.` 不会被填充，
 * 收信端就会把它误认成「多行响应结束」，邮件从那里被截断。
 */
export function dotStuffLines(raw: Buffer): string[] {
  const normalized = raw
    .toString('latin1')
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '\r\n')
  return normalized.split('\r\n').map((line) => (line.startsWith('.') ? `.${line}` : line))
}

class Session {
  private sock: Socket | TLSSocket
  private buffer: Buffer = Buffer.alloc(0)
  private authenticated = false
  private user = ''
  private upgraded = false
  private closed = false
  private readonly deleted = new Set<number>()
  private readonly onChunk = (chunk: Buffer): void => this.feed(chunk)

  get onStlsRequested(): (() => void) | undefined {
    return this._onStls
  }
  set onStlsRequested(fn: (() => void) | undefined) {
    this._onStls = fn
  }
  private _onStls?: () => void

  constructor(
    socket: Socket | TLSSocket,
    private readonly options: MockPop3Options,
    private readonly state: MockState
  ) {
    this.sock = socket
  }

  start(): void {
    this.bind(this.sock)
    this.send(`+OK SimpleMail POP3 mock ready <${Date.now()}@mock>`)
  }

  private bind(sock: Socket | TLSSocket): void {
    this.sock = sock
    sock.setNoDelay(true)
    sock.on('data', this.onChunk)
    sock.on('error', () => {
      /* 客户端主动断开很常见 */
    })
    sock.on('close', () => {
      this.closed = true
      this.finalize()
    })
  }

  private unbind(): void {
    this.sock.removeListener('data', this.onChunk)
  }

  /** 把明文连接升级为 TLS。必须先摘掉旧的 data 监听，否则加密字节会被当成 POP3 命令解析。 */
  upgradeToTls(ctx: SecureContext): void {
    const plain = this.sock
    this.unbind()
    // 关键：明文阶段 socket 处于 flowing 模式，若不暂停，
    // 客户端发来的 ClientHello 会被当作无监听者的数据直接丢弃，握手永远完不成。
    plain.pause()
    const secured = new TLSSocket(plain, { isServer: true, secureContext: ctx })
    this.upgraded = true
    this.bind(secured)
    secured.on('secure', () => {
      this.state.tlsNegotiations++
    })
  }

  private send(line: string): void {
    if (this.closed) return
    this.sock.write(`${line}${CRLF}`)
  }

  /**
   * 发送多行响应。传入的行**已经**做过点填充（只有 RETR/TOP 需要），
   * 且是 latin1 视角的字符串（一个字符 == 一个字节）。
   *
   * ⚠️ 这里必须用 Buffer + latin1 写出：socket.write(string) 默认按 UTF-8 编码，
   * 会把已经从 UTF-8 解码成 latin1 的正文再编码一次，收下来就是乱码。
   */
  private sendLines(lines: string[]): void {
    if (this.closed) return
    const parts: Buffer[] = [Buffer.from(`+OK ${lines.length} lines${CRLF}`, 'latin1')]
    for (const l of lines) {
      parts.push(Buffer.from(l, 'latin1'), Buffer.from(CRLF, 'latin1'))
    }
    parts.push(Buffer.from(`.${CRLF}`, 'latin1'))
    this.sock.write(Buffer.concat(parts))
  }

  private feed(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    for (;;) {
      const idx = this.buffer.indexOf(0x0a)
      if (idx === -1) break
      let stop = idx
      if (stop > 0 && this.buffer[stop - 1] === 0x0d) stop--
      const line = this.buffer.toString('utf8', 0, stop)
      this.buffer = this.buffer.subarray(idx + 1)
      try {
        this.handle(line.trim())
      } catch {
        this.send('-ERR internal mock error')
      }
    }
  }

  private handle(line: string): void {
    this.state.commands.push(line)
    const parts = line.split(/\s+/)
    const cmd = (parts[0] ?? '').toUpperCase()
    const arg = parts.slice(1).join(' ')

    switch (cmd) {
      case 'CAPA': {
        const caps = ['USER', 'UIDL', 'TOP', 'PIPELINING']
        if (this.options.stls && !this.upgraded) caps.push('STLS')
        this.sock.write(`+OK Capability list follows${CRLF}`)
        for (const c of caps) this.sock.write(`${c}${CRLF}`)
        this.sock.write(`.${CRLF}`)
        return
      }

      case 'STLS': {
        if (!this.options.stls || !this._onStls) {
          this.send('-ERR STLS not supported')
          return
        }
        this.send('+OK Begin TLS negotiation')
        // 必须在同一个 tick 内完成升级：客户端收到 +OK 后会立刻开始 TLS 握手
        this._onStls()
        return
      }

      case 'USER': {
        if (this.options.requireStls && !this.upgraded) {
          this.send('-ERR TLS required before authentication')
          return
        }
        this.user = arg
        this.send('+OK user accepted')
        return
      }

      case 'PASS': {
        this.state.logins.push({ user: this.user, pass: arg })
        const expectedUser = this.options.username ?? 'tester@example.com'
        const expectedPass = this.options.password ?? 'secret'
        if (this.user !== expectedUser || arg !== expectedPass) {
          this.authenticated = false
          this.send('-ERR [AUTH] authentication failed')
          return
        }
        this.authenticated = true
        this.send('+OK logged in')
        return
      }

      case 'STAT': {
        if (!this.requireAuth()) return
        const alive = this.aliveIndexes()
        const size = alive.reduce((sum, i) => sum + this.options.messages[i - 1].raw.length, 0)
        this.send(`+OK ${alive.length} ${size}`)
        return
      }

      case 'LIST': {
        if (!this.requireAuth()) return
        if (arg) {
          const n = Number(arg)
          if (!this.exists(n)) {
            this.send('-ERR no such message')
            return
          }
          this.send(`+OK ${n} ${this.options.messages[n - 1].raw.length}`)
          return
        }
        this.sendLines(
          this.aliveIndexes().map((i) => `${i} ${this.options.messages[i - 1].raw.length}`)
        )
        return
      }

      case 'UIDL': {
        if (!this.requireAuth()) return
        if (this.options.supportUidl === false) {
          this.send('-ERR UIDL not supported')
          return
        }
        this.sendLines(
          this.aliveIndexes().map((i) => `${i} ${this.options.messages[i - 1].uid}`)
        )
        return
      }

      case 'RETR':
      case 'TOP': {
        if (!this.requireAuth()) return
        const n = Number(parts[1])
        if (!this.exists(n)) {
          this.send('-ERR no such message')
          return
        }
        const msg = this.options.messages[n - 1]

        if (cmd === 'TOP') {
          const lineCount = Number(parts[2] ?? 0)
          const text = msg.raw.toString('latin1')
          const headerEnd = text.indexOf('\r\n\r\n')
          const header = headerEnd === -1 ? text : text.slice(0, headerEnd + 4)
          const body =
            headerEnd === -1
              ? ''
              : text
                  .slice(headerEnd + 4)
                  .split('\r\n')
                  .slice(0, lineCount)
                  .join('\r\n')
          this.sendLines(dotStuffLines(Buffer.from(header + body, 'latin1')))
          return
        }

        if (!this.state.retrieved.includes(n)) this.state.retrieved.push(n)
        this.sendLines(dotStuffLines(msg.raw))
        return
      }

      case 'DELE': {
        if (!this.requireAuth()) return
        const n = Number(arg)
        if (!this.exists(n)) {
          this.send('-ERR no such message')
          return
        }
        this.deleted.add(n)
        this.send(`+OK message ${n} deleted`)
        return
      }

      case 'RSET': {
        this.deleted.clear()
        this.send('+OK reset')
        return
      }

      case 'NOOP': {
        this.send('+OK')
        return
      }

      case 'QUIT': {
        if (this.deleted.size) {
          this.state.committedDeletions.push(...[...this.deleted].sort((a, b) => a - b))
        }
        this.send('+OK bye')
        this.sock.end()
        return
      }

      default:
        this.send(`-ERR unknown command ${cmd}`)
    }
  }

  private requireAuth(): boolean {
    if (this.authenticated) return true
    this.send('-ERR not authenticated')
    return false
  }

  private aliveIndexes(): number[] {
    const out: number[] = []
    for (let i = 1; i <= this.options.messages.length; i++) {
      if (!this.deleted.has(i)) out.push(i)
    }
    return out
  }

  private exists(n: number): boolean {
    return (
      Number.isInteger(n) && n >= 1 && n <= this.options.messages.length && !this.deleted.has(n)
    )
  }

  /** 会话结束时登记未提交的删除，用于断言「中断时不删服务器邮件」 */
  private finalize(): void {
    for (const n of this.deleted) {
      if (!this.state.committedDeletions.includes(n) && !this.state.rolledBackDeletions.includes(n)) {
        this.state.rolledBackDeletions.push(n)
      }
    }
  }
}

export async function startMockPop3(options: MockPop3Options): Promise<MockPop3Server> {
  const state: MockState = {
    commands: [],
    logins: [],
    committedDeletions: [],
    rolledBackDeletions: [],
    retrieved: [],
    connections: 0,
    tlsNegotiations: 0
  }

  const stlsContext: SecureContext | null = options.stls
    ? createSecureContext({ key: options.stls.key, cert: options.stls.cert })
    : null

  const onConnection = (socket: Socket | TLSSocket): void => {
    state.connections++
    const session = new Session(socket, options, state)
    if (stlsContext) {
      session.onStlsRequested = (): void => session.upgradeToTls(stlsContext)
    }
    session.start()
  }

  const server: Server = options.tls
    ? (createTlsServer({ key: options.tls.key, cert: options.tls.cert }, (socket) =>
        onConnection(socket)
      ) as unknown as Server)
    : createTcpServer((socket) => onConnection(socket))

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    port,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}

/** 用 openssl 生成一张自签证书，供隐式 TLS / STLS 测试使用 */
export function generateSelfSignedCert(dir: string): { key: Buffer; cert: Buffer } {
  const keyPath = `${dir}/mock-pop3.key`
  const certPath = `${dir}/mock-pop3.crt`
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '2',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1'
    ],
    { stdio: 'ignore' }
  )
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) }
}
