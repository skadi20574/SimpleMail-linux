/**
 * 邮件解析。
 *
 * 除了用 mailparser 做标准 MIME 解析外，这里额外做了两件国内邮箱/老邮件必需的事：
 *  1. **GBK/GB18030 兜底**：Foxmail 时代的大量中文邮件在头部用了未声明的 8bit 编码，
 *     或者声明了 `charset=gb2312` 但实际是 GBK/GB18030。解析出来是乱码时，
 *     这里会按 GB18030 重新解码。
 *  2. **裸 8bit 头部修复**：头部若含 0x80 以上字节且不是合法 UTF-8，会先按 GB18030
 *     转成 UTF-8 再交给 mailparser，否则邮件主题会变成问号。
 */

import { simpleParser } from 'mailparser'
import iconv from 'iconv-lite'

export interface ParsedAttachment {
  filename: string
  contentType: string
  size: number
  contentId: string | null
  isInline: boolean
  content: Buffer
}

export interface ParsedMail {
  subject: string
  fromName: string
  fromAddr: string
  toText: string
  ccText: string
  bccText: string
  replyTo: string
  date: number
  messageId: string | null
  inReplyTo: string | null
  references: string | null
  bodyText: string
  bodyHtml: string | null
  rawHeaders: string
  size: number
  attachments: ParsedAttachment[]
}

const FALLBACK_DATE = (): number => Date.now()

/** 判断一段字节是否是合法 UTF-8 */
export function isValidUtf8(buf: Buffer): boolean {
  let i = 0
  while (i < buf.length) {
    const b = buf[i]
    if (b < 0x80) {
      i++
      continue
    }
    let extra = 0
    if ((b & 0xe0) === 0xc0) extra = 1
    else if ((b & 0xf0) === 0xe0) extra = 2
    else if ((b & 0xf8) === 0xf0) extra = 3
    else return false
    if (i + extra >= buf.length) return false
    for (let k = 1; k <= extra; k++) {
      if ((buf[i + k] & 0xc0) !== 0x80) return false
    }
    i += extra + 1
  }
  return true
}

export function countHighBytes(buf: Buffer): number {
  let n = 0
  for (let i = 0; i < buf.length; i++) if (buf[i] >= 0x80) n++
  return n
}

export function decodeSmart(buf: Buffer, declaredCharset?: string | null): string {
  const cs = (declaredCharset || '').toLowerCase()
  if (cs && cs !== 'utf-8' && cs !== 'us-ascii' && iconv.encodingExists(cs)) {
    return iconv.decode(buf, cs)
  }
  if (isValidUtf8(buf)) return buf.toString('utf8')
  if (iconv.encodingExists('gb18030')) return iconv.decode(buf, 'gb18030')
  return buf.toString('latin1')
}

/**
 * 修复头部里的裸 8bit 内容。
 * 做法：把头部按 latin1 逐字节读出来 → 如果存在 >= 0x80 的字节且整段不是合法 UTF-8，
 * 就按 GB18030 解码，再以 UTF-8 重新编码，保证 mailparser 能正确读中文。
 */
export function repairRawHeaders(source: Buffer): Buffer {
  const crlfIdx = source.indexOf('\r\n\r\n')
  const idx = crlfIdx !== -1 ? crlfIdx : source.indexOf('\n\n')
  if (idx === -1) return source

  const headEnd = idx
  const head = source.subarray(0, headEnd)
  const high = countHighBytes(head)
  if (high === 0) return source
  if (isValidUtf8(head)) return source

  const decoded = iconv.decode(head, 'gb18030')
  const rebuilt = Buffer.from(decoded, 'utf8')
  return Buffer.concat([rebuilt, source.subarray(headEnd)])
}

function addrListToString(
  value: { value?: { name?: string; address?: string }[] } | undefined
): string {
  if (!value?.value?.length) return ''
  return value.value
    .map((v) => (v.name ? `${v.name} <${v.address ?? ''}>` : (v.address ?? '')))
    .filter(Boolean)
    .join(', ')
}

function firstAddress(
  value: { value?: { name?: string; address?: string }[] } | undefined
): { name: string; addr: string } {
  const first = value?.value?.[0]
  return { name: first?.name ?? '', addr: first?.address ?? '' }
}

function toIsoString(value: unknown): string | null {
  if (!value) return null
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.length ? String(value[0]) : null
  return String(value)
}

/** 把 HTML 里明显的脚本/事件去掉，降低阅读窗格的风险面（同时保留排版） */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '')
}

/** 极简 HTML → 纯文本，仅作为 mailparser 没给 text 时的兜底 */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 手写兜底解析：当 mailparser 抛错（老邮件结构不规范时很常见）使用。
 * 只做最基本的事：切头/体，解码头部字段。
 */
function manualParse(source: Buffer): ParsedMail {
  const text = decodeSmart(source)
  const splitIdx = text.search(/\r?\n\r?\n/)
  const headerBlock = splitIdx === -1 ? text : text.slice(0, splitIdx)
  const rawBody = splitIdx === -1 ? '' : text.slice(splitIdx).replace(/^\r?\n\r?\n/, '')

  // 头部折行展开
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ')
  const headers = new Map<string, string>()
  for (const line of unfolded.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line)
    if (m) headers.set(m[1].toLowerCase(), m[2].trim())
  }

  const subject = headers.get('subject') ?? ''
  const fromRaw = headers.get('from') ?? ''
  const fromMatch = /^(.*?)\s*<([^>]+)>$/.exec(fromRaw)
  const dateRaw = headers.get('date')
  const parsedDate = dateRaw ? Date.parse(dateRaw) : NaN

  return {
    subject,
    fromName: fromMatch ? fromMatch[1].replace(/^"|"$/g, '').trim() : '',
    fromAddr: fromMatch ? fromMatch[2] : fromRaw,
    toText: headers.get('to') ?? '',
    ccText: headers.get('cc') ?? '',
    bccText: headers.get('bcc') ?? '',
    replyTo: headers.get('reply-to') ?? '',
    date: Number.isFinite(parsedDate) ? parsedDate : FALLBACK_DATE(),
    messageId: headers.get('message-id') ?? null,
    inReplyTo: headers.get('in-reply-to') ?? null,
    references: headers.get('references') ?? null,
    bodyText: rawBody,
    bodyHtml: null,
    rawHeaders: headerBlock,
    size: source.length,
    attachments: []
  }
}

export async function parseMessage(input: Buffer | string): Promise<ParsedMail> {
  const source = typeof input === 'string' ? Buffer.from(input, 'binary') : input
  const repaired = repairRawHeaders(source)
  const size = source.length

  try {
    const parsed = await simpleParser(repaired, {
      skipHtmlToText: false,
      skipTextToHtml: true,
      skipImageLinks: false
    })

    const from = firstAddress(parsed.from as never)
    const html = typeof parsed.html === 'string' && parsed.html ? parsed.html : null
    let text = parsed.text ?? ''
    if (!text && html) text = htmlToText(html)

    // GBK 兜底：mailparser 猜错编码时会留下大量替换字符
    if (text && (text.match(/\uFFFD/g)?.length ?? 0) > 3) {
      const guess = decodeSmart(repaired, 'gb18030')
      if ((guess.match(/\uFFFD/g)?.length ?? 0) < (text.match(/\uFFFD/g)?.length ?? 0)) {
        text = guess
      }
    }

    const attachments: ParsedAttachment[] = []
    for (const att of parsed.attachments ?? []) {
      attachments.push({
        filename: att.filename || 'unnamed',
        contentType: att.contentType || 'application/octet-stream',
        size: att.size ?? att.content?.length ?? 0,
        contentId: att.cid ?? null,
        isInline: att.contentDisposition === 'inline' || Boolean(att.cid),
        content: att.content ?? Buffer.alloc(0)
      })
    }

    return {
      subject: parsed.subject ?? '',
      fromName: from.name,
      fromAddr: from.addr,
      toText: addrListToString(parsed.to as never),
      ccText: addrListToString(parsed.cc as never),
      bccText: addrListToString(parsed.bcc as never),
      replyTo: addrListToString(parsed.replyTo as never),
      date: parsed.date ? parsed.date.getTime() : FALLBACK_DATE(),
      messageId: parsed.messageId ?? null,
      inReplyTo: toIsoString(parsed.inReplyTo),
      references: toIsoString(parsed.references),
      bodyText: text,
      bodyHtml: html ? sanitizeHtml(html) : null,
      rawHeaders: String(parsed.headerLines?.map((l) => l.line).join('') ?? ''),
      size,
      attachments
    }
  } catch {
    return manualParse(source)
  }
}

/** 导出时用：把数据库里的字段重建为 RFC822 报文 */
export function buildRfc822(input: {
  rawHeaders: string
  subject: string
  fromName: string
  fromAddr: string
  toText: string
  ccText: string
  date: number
  messageId: string | null
  bodyText: string
  bodyHtml: string | null
  attachments: { filename: string; contentType: string; contentId: string | null; data: Buffer }[]
}): Buffer {
  const hasAttachments = input.attachments.length > 0
  const boundary = `----SimpleMail_${Math.random().toString(36).slice(2)}_${Date.now()}`

  const headerLines: string[] = []
  const pushHeader = (name: string, value: string): void => {
    if (!value) return
    headerLines.push(`${name}: ${value}`)
  }

  pushHeader('From', input.fromName ? `"${input.fromName}" <${input.fromAddr}>` : input.fromAddr)
  pushHeader('To', input.toText)
  pushHeader('Cc', input.ccText)
  pushHeader('Subject', input.subject)
  pushHeader('Date', new Date(input.date || Date.now()).toUTCString())
  pushHeader('Message-ID', input.messageId ?? `<${Date.now()}@simplemail.local>`)
  pushHeader('MIME-Version', '1.0')

  const encodedSubjectHeader = headerLines.join('\r\n')

  let body: string
  let contentTypeHeader: string

  if (!hasAttachments) {
    if (input.bodyHtml) {
      contentTypeHeader = 'Content-Type: text/html; charset=UTF-8'
      body = input.bodyHtml
    } else {
      contentTypeHeader = 'Content-Type: text/plain; charset=UTF-8'
      body = input.bodyText
    }
  } else {
    contentTypeHeader = `Content-Type: multipart/mixed; boundary="${boundary}"`
    const parts: string[] = []
    if (input.bodyHtml) {
      parts.push(
        `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
          Buffer.from(input.bodyHtml, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')
      )
    } else {
      parts.push(
        `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
          Buffer.from(input.bodyText, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')
      )
    }
    for (const att of input.attachments) {
      const nameEncoded = `=?UTF-8?B?${Buffer.from(att.filename, 'utf8').toString('base64')}?=`
      parts.push(
        `--${boundary}\r\nContent-Type: ${att.contentType}; name="${nameEncoded}"\r\n` +
          `Content-Transfer-Encoding: base64\r\n` +
          `Content-Disposition: attachment; filename="${nameEncoded}"\r\n\r\n` +
          att.data.toString('base64').replace(/(.{76})/g, '$1\r\n')
      )
    }
    parts.push(`--${boundary}--`)
    body = parts.join('\r\n')
  }

  const full = `${encodedSubjectHeader}\r\n${contentTypeHeader}\r\n\r\n${body}`
  return Buffer.from(full, 'utf8')
}

/**
 * 到底有没有「用户可见的附件」。
 *
 * 内嵌图片（Content-Disposition: inline，或带 Content-ID 的）**不算**：
 * 它们是正文的一部分，已经在正文里渲染过了，详情页的附件区本来就会把
 * 它们过滤掉（见 MailView.tsx 的 `filter(a => !a.isInline)`）。
 *
 * 以前列表图标按 `attachments.length > 0` 算，口径与详情页不一致，
 * 于是「只有签名 logo 这类内嵌图」的邮件在列表里显示了回形针图标，
 * 点开却一个附件都没有。列表与详情页必须用同一个判定。
 */
export function hasVisibleAttachments(atts: readonly { isInline?: boolean }[]): boolean {
  return atts.some((a) => !a.isInline)
}
