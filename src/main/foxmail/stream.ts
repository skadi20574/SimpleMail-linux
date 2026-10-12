/**
 * 大文件流式读取与报文定位。
 *
 * 背景：原来导入是把整个存档一次性读进内存再切分。这在 1GB 以下没问题，
 * 但用户的 Foxmail 存档有 **2.94GB** 的 .box，直接触发「文件过大」拒绝导入。
 *
 * 这里的做法是把「定位」和「读取」拆开：
 *   1. **流式扫描**：按 8MB 分块扫文件，只记录每条报文在文件里的 [start, end)
 *      区间。内存占用是「区间数组」，与邮件正文大小无关
 *      （300 万封也才几十 MB）。
 *   2. **按需读取**：真正要处理某一封时，只 read 那一段。
 *      峰值内存 = 最大的一封邮件，而不是整个存档。
 *
 * 小文件（< 256MB）仍然走原来的「全量读入 + 五条线索深度雕刻」路径 ——
 * 那条路对畸形容器更宽容，是对小文件更划算的策略。
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { FOX_SEPARATOR } from './carve'

/** 单次读取的块大小 */
const CHUNK = 8 * 1024 * 1024
/** 扫描报文头时的回退窗口：要保证头部块校验能用块内数据完成 */
const HEADER_OVERLAP = 256 * 1024
/** 分隔符跨块时的回退字节数 */
const SEP_OVERLAP = FOX_SEPARATOR.length - 1
/** 区间数量上限，防止异常文件把内存吃光 */
const MAX_SPANS = 3_000_000
/** 单封报文的读取上限（正常邮件不可能到这个量级） */
const MAX_MESSAGE_BYTES = 512 * 1024 * 1024

export interface MessageSpan {
  start: number
  end: number
}

export interface ScanOutcome {
  strategy: 'fox-separator' | 'rfc822-headers' | 'none'
  spans: MessageSpan[]
  /** 是否因为超过 MAX_SPANS 而提前停止 */
  truncated: boolean
}

/** 报文尾部要裁掉的填充字节（下一个分隔符的残片、NUL、换行等） */
function isTrailingJunk(b: number): boolean {
  return (
    b === 0x00 || b === 0x0a || b === 0x0d || b === 0x20 || b === 0x09 || b === 0x1a || b === 0x10 || b === 0x11
  )
}

function trimTail(buf: Buffer): Buffer {
  let end = buf.length
  while (end > 0 && isTrailingJunk(buf[end - 1])) end--
  return end === buf.length ? buf : buf.subarray(0, end)
}

export class LargeFileReader {
  private fd: number
  readonly size: number
  readonly path: string

  constructor(path: string) {
    this.path = path
    this.fd = openSync(path, 'r')
    this.size = statSync(path).size
  }

  close(): void {
    try {
      closeSync(this.fd)
    } catch {
      /* 已经关掉了 */
    }
  }

  /** 完整读出一段（readSync 可能短读，这里循环补齐） */
  private readFully(length: number, position: number): { buf: Buffer; read: number } {
    const buf = Buffer.allocUnsafe(length)
    let done = 0
    while (done < length) {
      let n: number
      try {
        n = readSync(this.fd, buf, done, length - done, position + done)
      } catch {
        break
      }
      if (n <= 0) break
      done += n
    }
    return { buf, read: done }
  }

  /** 只读取指定区间的报文 */
  read(span: MessageSpan): Buffer {
    const length = Math.min(span.end - span.start, MAX_MESSAGE_BYTES)
    if (length <= 0) return Buffer.alloc(0)
    const { buf, read } = this.readFully(length, span.start)
    return trimTail(read === length ? buf : buf.subarray(0, read))
  }

  /**
   * 按 Foxmail 分隔符扫描。
   *
   * 分块扫描必须回退 SEP_OVERLAP 个字节，否则跨块的分隔符会被漏掉；
   * 但回退又会让同一处分隔符在相邻两块里各命中一次。
   * 因为分隔符本身有 16 字节、不可能重叠，所以用「偏移必须严格递增」去重即可。
   */
  scanSeparators(onProgress?: (done: number, total: number) => void): ScanOutcome {
    const seps: number[] = []
    let pos = 0
    let truncated = false

    while (pos < this.size) {
      const len = Math.min(CHUNK, this.size - pos)
      // ⚠️ 必须用 readFully 返回的那个 buf —— 内部是按需分配的，
      // 从外面预先 alloc 的 chunk 里读会拿到未初始化内存（曾经因此扫不到任何分隔符）。
      const { buf, read } = this.readFully(len, pos)
      if (read <= 0) break

      const view = buf.subarray(0, read)
      let from = 0
      while (true) {
        const idx = view.indexOf(FOX_SEPARATOR, from)
        if (idx === -1) break
        const abs = pos + idx
        // 严格递增去重：回退窗口里的同一处分隔符只会记一次
        if (seps.length === 0 || abs > seps[seps.length - 1]) {
          if (seps.length >= MAX_SPANS) {
            truncated = true
            break
          }
          seps.push(abs)
        }
        from = idx + FOX_SEPARATOR.length
      }
      if (truncated) break

      onProgress?.(Math.min(pos + read, this.size), this.size)
      if (read < len) break
      pos += Math.max(1, read - SEP_OVERLAP)
    }

    if (!seps.length) return { strategy: 'none', spans: [], truncated }

    const spans: MessageSpan[] = []
    for (let i = 0; i < seps.length; i++) {
      const start = seps[i] + FOX_SEPARATOR.length
      const end = i + 1 < seps.length ? seps[i + 1] : this.size
      if (end > start) spans.push({ start, end })
    }
    return { strategy: 'fox-separator', spans, truncated }
  }

  /**
   * 按报文头扫描（容器未知、又没有分隔符时用）。
   *
   * 校验头部块需要后续若干字节，所以回退窗口给到 256KB，
   * 保证每块内的候选点都能用块内数据完成校验，不必为每个候选点单独 read。
   */
  scanHeaders(onProgress?: (done: number, total: number) => void): ScanOutcome {
    const starts: number[] = []
    let pos = 0
    let truncated = false
    /** 上一封已验证头部块的结束位置（绝对偏移），用来跳过块内的后续候选 */
    let lastEnd = 0

    const LINE_START_RE = /(^|\n)(Return-Path|Received|Delivered-To|Message-ID|From|Date|Subject|MIME-Version):/g

    while (pos < this.size) {
      const len = Math.min(CHUNK, this.size - pos)
      const { buf, read } = this.readFully(len, pos)
      if (read <= 0) break

      const view = buf.subarray(0, read)
      // 用 latin1 做 1:1 的字节映射，正则里每个字符就对应一个字节
      const text = view.toString('latin1')

      LINE_START_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = LINE_START_RE.exec(text)) !== null) {
        const nlOffset = m[1] === '\n' ? 1 : 0
        const idx = m.index + nlOffset
        const abs = pos + idx

        // 已经落在上一封的头部块里，跳过。
        // ⚠️ 没有这道守卫的话，一封邮件的每个头部字段（Return-Path / Received /
        // From / Date …）都会被当成新邮件的开头，12 封会被读成 60 封。
        if (abs < lastEnd) continue
        if (starts.length >= MAX_SPANS) {
          truncated = true
          break
        }
        const block = wasHeaderBlock(view, idx)
        if (!block) continue
        starts.push(abs)
        lastEnd = pos + block.end
      }
      if (truncated) break

      onProgress?.(Math.min(pos + read, this.size), this.size)
      if (read < len) break
      pos += Math.max(1, read - HEADER_OVERLAP)
    }

    if (!starts.length) return { strategy: 'none', spans: [], truncated }

    const spans: MessageSpan[] = []
    for (let i = 0; i < starts.length; i++) {
      const start = starts[i]
      const end = i + 1 < starts.length ? starts[i + 1] : this.size
      if (end > start) spans.push({ start, end })
    }
    return { strategy: 'rfc822-headers', spans, truncated }
  }

  /** 先试分隔符，再试报文头 */
  scan(onProgress?: (done: number, total: number) => void): ScanOutcome {
    const bySep = this.scanSeparators(onProgress)
    if (bySep.spans.length) return bySep
    return this.scanHeaders(onProgress)
  }
}

/**
 * 在块内校验 pos 处是不是一个完整报文的头部块。
 *
 * 必须要求出现信封级字段 —— MIME 多段邮件的每个分段也是以合法头部开头的，
 * 只按「像不像头部」判断会把一封带附件的邮件切成三封（这个坑在 carve.ts 里
 * 详细写过）。
 */
function wasHeaderBlock(buf: Buffer, pos: number): { end: number } | null {
  let cursor = pos
  let lines = 0
  let strong = false
  let hasFrom = false
  let hasDate = false
  const limit = buf.length

  while (cursor < limit) {
    const nl = buf.indexOf(0x0a, cursor)
    if (nl === -1) return null
    let stop = nl
    if (stop > cursor && buf[stop - 1] === 0x0d) stop--

    if (stop === cursor) {
      if (lines < 2) return null
      return strong || (hasFrom && hasDate) ? { end: nl + 1 } : null
    }

    const line = buf.toString('latin1', cursor, Math.min(stop, cursor + 200))
    if (/^[ \t]/.test(line)) {
      // 折行续行
    } else {
      const m = /^([A-Za-z][A-Za-z0-9-]{0,40}):/.exec(line)
      if (!m) return null
      const name = m[1].toLowerCase()
      if (
        name === 'return-path' ||
        name === 'received' ||
        name === 'delivered-to' ||
        name === 'message-id' ||
        name === 'dkim-signature' ||
        name === 'authentication-results'
      ) {
        strong = true
      }
      if (name === 'from') hasFrom = true
      if (name === 'date') hasDate = true
      lines++
    }
    if (lines > 4000) return null
    cursor = nl + 1

    // 头部超过 512KB 说明不是正常邮件
    if (cursor - pos > 512 * 1024) return null
  }
  return null
}
