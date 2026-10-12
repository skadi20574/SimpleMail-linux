/**
 * 通用 RFC822 报文雕刻（carving）。
 *
 * 背景：Foxmail 的存档格式跨版本差异很大 ——
 *   · 老版（5.x/6.x/7.0）是 `mail/<账户>/<文件夹>.box` + `.ind`；
 *   · 7.2 的「邮件存档」是单个 `.fox` 文件，且**格式未公开**。
 *
 * 与其为每个版本写一个解析器，这里采用「只要能定位报文就能导入」的策略：
 * 邮件正文在磁盘上一定是原始 RFC822 字节，所以可以按三种线索把它们抠出来：
 *   1. Foxmail 报文分隔符（16 字节 `10×7 11×6 53 0D 0A`）—— .box 的主路径；
 *   2. 行首的邮件头（`Return-Path:` / `Received:` / `X-*:` / `Message-ID:` …）
 *      并且后面紧跟一段合法头部块 —— 用于容器格式未知的 .fox；
 *   3. 内嵌的 zlib 流（部分版本会压缩存储）。
 *
 * 三条线索都失败时，还会尝试把内嵌的 ZIP 局部头抠出来。
 * 关键点：**任何一条成功即可导入**，因此新旧版本可以自动兼容。
 */

import { inflateRawSync, inflateSync } from 'node:zlib'

/** Foxmail 的报文分隔符 */
export const FOX_SEPARATOR = Buffer.from([
  0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x53, 0x0d, 0x0a
])

export type CarveStrategy =
  | 'fox-separator'
  | 'rfc822-headers'
  | 'zlib-stream'
  | 'mbox-from'
  | 'single-message'
  | 'none'

export interface CarvedMessage {
  start: number
  end: number
  data: Buffer
}

export interface CarveResult {
  strategy: CarveStrategy
  messages: CarvedMessage[]
}

/**
 * 头部里允许作为「报文起点」的字段名。
 * 用白名单是为了避免把正文里出现的 `From: xxx` 误判成新邮件。
 */
const START_HEADERS = new Set([
  'return-path',
  'received',
  'delivered-to',
  'authentication-results',
  'dkim-signature',
  'message-id',
  'from',
  'date',
  'subject',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
  'to',
  'cc',
  'reply-to',
  'sender',
  'x-mailer',
  'x-priority',
  'references',
  'in-reply-to'
])

/**
 * 只有这些字段才能证明「这里是一封完整邮件的开头」。
 * 这一点很关键：MIME 多段邮件的每个分段也是以 `Content-Type:` / 
 * `Content-Disposition:` 开头的合法头部块，如果只看「像不像头部」，
 * 一封带附件的邮件会被切成 3 封。加上这层强字段校验就不会了。
 */
const STRONG_HEADERS = new Set([
  'return-path',
  'received',
  'delivered-to',
  'message-id',
  'dkim-signature',
  'authentication-results'
])

function isStartHeader(name: string): boolean {
  const n = name.toLowerCase()
  return START_HEADERS.has(n) || n.startsWith('x-')
}

/**
 * 在 pos 处读取一行，判断是否是邮件头字段。返回字段名（小写）或 null。
 */
function headerNameAt(buf: Buffer, pos: number): string | null {
  if (pos >= buf.length) return null
  const lineEnd = buf.indexOf(0x0a, pos)
  const rawEnd = lineEnd === -1 ? buf.length : lineEnd
  const end = Math.min(rawEnd, pos + 160)
  const line = buf.toString('latin1', pos, end)
  const m = /^([A-Za-z][A-Za-z0-9-]{1,40}):[ \t]?/.exec(line)
  if (!m) return null
  return m[1]
}

/** 看 pos 前面最近的非空行是不是 MIME 分隔线（`--boundary`） */
function precededByMimeBoundary(buf: Buffer, pos: number): boolean {
  let cursor = pos
  // 回退跳过紧邻的换行
  while (cursor > 0 && (buf[cursor - 1] === 0x0a || buf[cursor - 1] === 0x0d)) cursor--
  if (cursor <= 0) return false
  // 找到上一行的起点
  const prevNl = buf.lastIndexOf(0x0a, cursor - 1)
  const lineStart = prevNl === -1 ? 0 : prevNl + 1
  const line = buf.toString('latin1', lineStart, Math.min(cursor, lineStart + 160))
  return /^--/.test(line.trimStart())
}

/**
 * 校验从 pos 开始是不是一个**完整邮件**的头部块。
 * 返回头部块结束（空行之后）的偏移；不合法返回 null。
 */
function headerBlockEnd(buf: Buffer, pos: number): { end: number; headerLines: number } | null {
  let cursor = pos
  let headerLines = 0
  const names = new Set<string>()
  const limit = Math.min(buf.length, pos + 512 * 1024)

  // MIME 分段的前面一定紧跟着分隔线，直接排除
  if (precededByMimeBoundary(buf, pos)) return null

  while (cursor < limit) {
    const lineEnd = buf.indexOf(0x0a, cursor)
    if (lineEnd === -1) return null
    const lineStart = cursor
    let lineStop = lineEnd
    if (lineStop > lineStart && buf[lineStop - 1] === 0x0d) lineStop--

    if (lineStop === lineStart) {
      // 空行 -> 头部结束
      if (headerLines < 2) return null
      const hasStrong = [...names].some((n) => STRONG_HEADERS.has(n))
      const hasFromAndDate = names.has('from') && names.has('date')
      if (!hasStrong && !hasFromAndDate) return null
      return { end: lineEnd + 1, headerLines }
    }

    const line = buf.toString('latin1', lineStart, Math.min(lineStop, lineStart + 200))
    if (/^[ \t]/.test(line)) {
      // 折行续行，合法
    } else {
      const m = /^([A-Za-z][A-Za-z0-9-]{0,40}):/.exec(line)
      if (!m) return null
      names.add(m[1].toLowerCase())
      headerLines++
    }
    if (headerLines > 4000) return null
    cursor = lineEnd + 1
  }
  return null
}

/** 查找 Foxmail 分隔符的所有出现位置 */
export function findFoxSeparators(buf: Buffer, limit = 5_000_000): number[] {
  const out: number[] = []
  let from = 0
  while (out.length < limit) {
    const idx = buf.indexOf(FOX_SEPARATOR, from)
    if (idx === -1) break
    out.push(idx)
    from = idx + FOX_SEPARATOR.length
  }
  return out
}

/** 按 Foxmail 分隔符切分 .box */
export function carveBySeparator(buf: Buffer): CarvedMessage[] {
  const seps = findFoxSeparators(buf)
  if (!seps.length) return []

  const messages: CarvedMessage[] = []
  // 第一段可能是文件头（Foxmail 会在 .box 开头写一小段元信息）
  for (let i = 0; i < seps.length; i++) {
    const bodyStart = seps[i] + FOX_SEPARATOR.length
    const bodyEnd = i + 1 < seps.length ? seps[i + 1] : buf.length
    if (bodyEnd <= bodyStart) continue
    const end = trimTrailingJunk(buf, bodyStart, bodyEnd)
    if (end <= bodyStart) continue
    messages.push({ start: bodyStart, end, data: buf.subarray(bodyStart, end) })
  }
  return messages
}

/** 去掉报文尾部的 NUL / 多余换行 / 下一个分隔符的残片 */
function trimTrailingJunk(buf: Buffer, start: number, end: number): number {
  let e = end
  while (e > start) {
    const b = buf[e - 1]
    if (
      b === 0x00 ||
      b === 0x0a ||
      b === 0x0d ||
      b === 0x20 ||
      b === 0x09 ||
      b === 0x1a ||
      b === 0x10 ||
      b === 0x11
    ) {
      e--
    } else break
  }
  return e
}

/** 扫描所有可能作为报文起点的偏移 */
function collectHeaderStarts(buf: Buffer, maxStarts = 2_000_000): number[] {
  const starts: number[] = []
  // 文件开头
  if (headerNameAt(buf, 0)) starts.push(0)

  let nl = buf.indexOf(0x0a, 0)
  let guard = 0
  while (nl !== -1 && starts.length < maxStarts && guard < 50_000_000) {
    guard++
    const pos = nl + 1
    if (pos >= buf.length) break
    const b = buf[pos]
    // 只有可见 ASCII 才可能是头部字段名开头
    if (b > 0x20 && b < 0x7f) {
      const name = headerNameAt(buf, pos)
      if (name && isStartHeader(name)) starts.push(pos)
    }
    nl = buf.indexOf(0x0a, pos)
  }
  return starts
}

/** 按头部特征雕刻 */
export function carveByHeaders(buf: Buffer): CarvedMessage[] {
  const rawStarts = collectHeaderStarts(buf)
  if (!rawStarts.length) return []

  // 验证每一条候选，保留头部块合法的
  const validated: { start: number; end: number }[] = []
  let lastEnd = -1
  for (const start of rawStarts) {
    if (start < lastEnd) continue // 落在上一封邮件内部，直接跳过
    const block = headerBlockEnd(buf, start)
    if (!block) continue
    validated.push({ start, end: block.end })
    lastEnd = block.end
  }

  if (!validated.length) return []

  const messages: CarvedMessage[] = []
  for (let i = 0; i < validated.length; i++) {
    const bodyStart = validated[i].start
    const bodyEnd = i + 1 < validated.length ? validated[i + 1].start : buf.length
    if (bodyEnd <= bodyStart) continue
    const end = trimTrailingJunk(buf, bodyStart, bodyEnd)
    if (end <= bodyStart) continue
    messages.push({ start: bodyStart, end, data: buf.subarray(bodyStart, end) })
  }
  return messages
}

/** 按 mbox 的 `From ` 行雕刻 */
export function carveByMbox(buf: Buffer): CarvedMessage[] {
  const messages: CarvedMessage[] = []
  const marker = Buffer.from('\nFrom ')
  let from = 0
  const starts: number[] = []
  if (buf.length > 5 && buf.toString('latin1', 0, 5) === 'From ') starts.push(0)
  while (true) {
    const idx = buf.indexOf(marker, from)
    if (idx === -1) break
    starts.push(idx + 1)
    from = idx + marker.length
    if (starts.length > 2_000_000) break
  }
  if (starts.length < 2) return []
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]
    const e = i + 1 < starts.length ? starts[i + 1] : buf.length
    const firstNl = buf.indexOf(0x0a, s)
    if (firstNl === -1 || firstNl > e) continue
    const data = buf.subarray(firstNl + 1, e)
    if (data.length < 32) continue
    messages.push({ start: firstNl + 1, end: e, data })
  }
  return messages
}

/** 尝试把内嵌的 zlib 流解压成报文 */
export function carveByZlib(buf: Buffer, maxAttempts = 4000): CarvedMessage[] {
  const messages: CarvedMessage[] = []
  const seen = new Set<number>()

  const attempt = (offset: number, chunk: Buffer): boolean => {
    if (seen.has(offset)) return false
    for (const fn of [inflateSync, inflateRawSync]) {
      try {
        const out = fn(chunk, { maxOutputLength: 64 * 1024 * 1024 })
        if (out.length > 64 && looksLikeRfc822(out)) {
          seen.add(offset)
          const nested = carveGeneric(out)
          if (nested.messages.length) messages.push(...nested.messages)
          else messages.push({ start: offset, end: offset + chunk.length, data: out })
          return true
        }
      } catch {
        /* 不是有效的压缩流，继续尝试 */
      }
    }
    return false
  }

  // 第一轮：容器只是加了个很短的头部的情况（偏移 0~255 都试一遍）
  const headLimit = Math.min(buf.length, 256)
  for (let off = 0; off < headLimit; off++) {
    attempt(off, buf.subarray(off))
    if (messages.length) break
  }

  // 第二轮：扫描 zlib 魔数（0x78 后面跟合法的 FLG 字节）
  let attempts = 0
  for (let i = 0; i + 2 < buf.length && attempts < maxAttempts; i++) {
    if (buf[i] !== 0x78) continue
    const b1 = buf[i + 1]
    if (b1 !== 0x01 && b1 !== 0x9c && b1 !== 0xda && b1 !== 0x5e) continue
    attempts++
    attempt(i, buf.subarray(i, Math.min(buf.length, i + 32 * 1024 * 1024)))
  }

  return messages
}

/** 嵌入的 ZIP 局部文件头（PK\x03\x04）—— 应对「存档其实是个改了扩展名的 zip」 */
export function carveEmbeddedZip(buf: Buffer, maxEntries = 2000): { name: string; data: Buffer }[] {
  const out: { name: string; data: Buffer }[] = []
  const PK = Buffer.from([0x50, 0x4b, 0x03, 0x04])
  let from = 0
  while (out.length < maxEntries) {
    const idx = buf.indexOf(PK, from)
    if (idx === -1) break
    from = idx + 4
    if (idx + 30 > buf.length) break
    const method = buf.readUInt16LE(idx + 8)
    const compSize = buf.readUInt32LE(idx + 18)
    const nameLen = buf.readUInt16LE(idx + 26)
    const extraLen = buf.readUInt16LE(idx + 28)
    if (nameLen === 0 || nameLen > 4096) continue
    const nameStart = idx + 30
    if (nameStart + nameLen > buf.length) continue
    const name = buf.toString('utf8', nameStart, nameStart + nameLen)
    let dataStart = nameStart + nameLen + extraLen
    // 有 data descriptor（bit 3）时 compSize 可能为 0，跳过这种条目
    if (compSize === 0 && method === 8) continue
    if (dataStart + compSize > buf.length) continue
    const raw = buf.subarray(dataStart, dataStart + compSize)
    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: 128 * 1024 * 1024 })
      } catch {
        continue
      }
    } else continue
    out.push({ name, data })
  }
  return out
}

/** 判断一段字节是否像 RFC822 报文 */
export function looksLikeRfc822(buf: Buffer): boolean {
  if (buf.length < 32) return false
  const head = buf.subarray(0, Math.min(buf.length, 8192))
  const text = head.toString('latin1')
  if (!/^[A-Za-z][A-Za-z0-9-]{0,40}:/m.test(text)) return false
  if (!/\r?\n\r?\n/.test(text)) return false
  const hits = (text.match(/^(Return-Path|Received|From|To|Subject|Date|Message-ID|MIME-Version|Content-Type|X-[A-Za-z0-9-]+):/gim) ?? []).length
  return hits >= 2
}

export interface GenericCarveOptions {
  /** 是否尝试 zlib 与 zip 兜底（较慢，默认只在主策略失败时开启） */
  deep?: boolean
}

/**
 * 通用雕刻入口：按可靠性从高到低依次尝试。
 */
export function carveGeneric(buf: Buffer, options: GenericCarveOptions = {}): CarveResult {
  const deep = options.deep ?? true

  // 0. 整段就是一个报文
  if (looksLikeRfc822(buf) && findFoxSeparators(buf, 1).length === 0) {
    const headerStarts = collectHeaderStarts(buf)
    if (headerStarts.length <= 1) {
      return { strategy: 'single-message', messages: [{ start: 0, end: buf.length, data: buf }] }
    }
  }

  // 1. Foxmail 分隔符
  const bySep = carveBySeparator(buf)
  if (bySep.length) return { strategy: 'fox-separator', messages: bySep }

  // 2. 头部特征
  const byHead = carveByHeaders(buf)
  if (byHead.length) return { strategy: 'rfc822-headers', messages: byHead }

  // 3. mbox
  const byMbox = carveByMbox(buf)
  if (byMbox.length) return { strategy: 'mbox-from', messages: byMbox }

  if (deep) {
    // 4. 内嵌 zip
    const zipped = carveEmbeddedZip(buf)
    if (zipped.length) {
      const collected: CarvedMessage[] = []
      for (const entry of zipped) {
        const inner = carveGeneric(entry.data, { deep: false })
        if (inner.messages.length) collected.push(...inner.messages)
      }
      if (collected.length) return { strategy: 'zlib-stream', messages: collected }
    }

    // 5. 内嵌 zlib
    const byZlib = carveByZlib(buf)
    if (byZlib.length) return { strategy: 'zlib-stream', messages: byZlib }
  }

  return { strategy: 'none', messages: [] }
}

/** 给「存档体检」用的头部十六进制 dump */
export function headDump(buf: Buffer, bytes = 64): { hex: string; ascii: string } {
  const slice = buf.subarray(0, Math.min(bytes, buf.length))
  const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ')
  const ascii = [...slice].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')
  return { hex, ascii }
}
