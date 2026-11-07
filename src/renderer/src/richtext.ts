/**
 * 富文本（HTML）写信用到的一小组工具。
 *
 * 为什么自己写而不是引一个编辑器库：
 *   · 本项目刻意不引第三方 UI 依赖（安装包小、离线可靠、少一层供应链）；
 *   · 需求只是「加粗/颜色/列表/链接/引用」这类基础排版，
 *     Chromium 自带的 execCommand 完全够用（Electron 里浏览器版本是固定的，
 *     不存在「不同浏览器行为不一致」的问题）。
 *
 * ⚠️ 所有从外面进来的 HTML（粘贴、回复原文）都必须过 sanitizeRichHtml。
 * 否则「粘贴」就成了往邮件里塞脚本/追踪像素的后门。
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 纯文本 → HTML（换行变 <br>，空格保留） */
export function plainToHtml(text: string): string {
  if (!text) return ''
  return escapeHtml(text).replace(/\r\n/g, '\n').replace(/\n/g, '<br>')
}

/** HTML → 纯文本。用于给不发 HTML 的收件人准备 text/plain 部分。 */
export function htmlToPlainText(html: string): string {
  if (!html) return ''
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const out: string[] = []

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push((node.nodeValue ?? '').replace(/\u00a0/g, ' '))
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    const tag = el.tagName.toLowerCase()
    if (tag === 'br') {
      out.push('\n')
      return
    }
    if (tag === 'img') {
      // 图片没有文字可留，但要让读纯文本的人知道这里原来有张图
      out.push(`[图片${el.getAttribute('alt') ? `: ${el.getAttribute('alt')}` : ''}]`)
      return
    }
    const block = BLOCK_TAGS.has(tag)
    if (tag === 'li') out.push('• ')
    for (const child of Array.from(el.childNodes)) walk(child)
    if (block) out.push('\n')
  }

  for (const child of Array.from(doc.body.childNodes)) walk(child)

  return out
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'blockquote',
  'ul',
  'ol',
  'pre',
  'table',
  'tr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr'
])

/** 允许保留的标签。不在这个表里的标签会被「脱壳」——去掉标签本身、留下里面的文字。 */
const ALLOWED_TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'center',
  'code',
  'dd',
  'del',
  'div',
  'dl',
  'dt',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'ins',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul'
])

/** 直接整体丢弃的标签（连同内容） */
const DROP_TAGS = new Set([
  'applet',
  'audio',
  'base',
  'button',
  'embed',
  'form',
  'frame',
  'frameset',
  'iframe',
  'input',
  'link',
  'math',
  'meta',
  'noscript',
  'object',
  'script',
  'select',
  'source',
  'style',
  'svg',
  'textarea',
  'title',
  'track',
  'video'
])

/** 保留的属性 */
const KEEP_ATTRS = new Set([
  'align',
  'alt',
  'colspan',
  'height',
  'href',
  'rowspan',
  'span',
  'style',
  'title',
  'valign',
  'width',
  // 内嵌图片用 data-cid 记住它对应的 Content-ID（发信时把 data: 换成 cid:）
  'data-cid',
  // 用户调过的显示比例（百分比）
  'data-smw',
  // 内嵌图片的地址（只允许 data: / cid: / smattach:，见下面的 src 检查）
  'src'
])

export interface SanitizeResult {
  html: string
  /** 被丢掉的图片数量：调用方据此提示用户「图片没带进去」 */
  droppedImages: number
  /** 是否丢掉过整块内容（脚本、iframe 之类） */
  droppedBlocks: boolean
}

/**
 * 清洗一段外部 HTML。
 *
 * 规则：
 *   · DROP_TAGS 连内容一起扔；
 *   · 不在 ALLOWED_TAGS 里的标签只脱壳（保留文字，不保留标签）；
 *   · 属性走白名单，`on*` 一律丢；
 *   · `href` 只允许 http/https/mailto，`javascript:` 直接丢；
 *   · `style` 里去掉 url() 和 expression()（前者会引外部资源，后者是上古 IE 漏洞）；
 *   · 图片全部丢掉：粘贴进来的图片要么是远程地址（等于替别人塞追踪像素），
 *     要么是 data: 的 base64（动辄几 MB，撑爆邮件大小限制）。
 *     要发图请走「添加附件」。
 */
export function sanitizeRichHtml(html: string): SanitizeResult {
  let droppedImages = 0
  let droppedBlocks = false

  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const holder = document.createElement('div')

  const copy = (node: Node, parent: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.appendChild(document.createTextNode(node.nodeValue ?? ''))
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    const tag = el.tagName.toLowerCase()

    if (DROP_TAGS.has(tag)) {
      droppedBlocks = true
      return
    }
    if (tag === 'img') {
      /**
       * 图片分两种：
       *   · 内嵌图（data: / cid: / smattach:）—— 已经在我们自己的邮件里，
       *     留着它，正文里该有图就得有图；
       *   · 远程图（http/https）—— 粘进来的外部图片。直接留着等于让收件人
       *     替别人加载追踪像素，所以默认丢掉；调用方会先尝试把它下载下来
       *     变成内嵌图，成了再放进来。
       */
      const src = (el.getAttribute('src') ?? '').trim()
      if (!/^(data:|cid:|smattach:)/i.test(src)) {
        droppedImages++
        return
      }
    }
    if (!ALLOWED_TAGS.has(tag)) {
      // 脱壳：保留里面的内容
      for (const child of Array.from(el.childNodes)) copy(child, parent)
      return
    }

    const clean = document.createElement(tag)
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (!KEEP_ATTRS.has(name)) continue
      let value = attr.value
      if (name === 'href') {
        if (!/^(https?:\/\/|mailto:)/i.test(value.trim())) continue
      }
      if (name === 'src') {
        // 图片地址只允许这三种：内嵌 base64、Content-ID、本程序自己的附件协议。
        // 远程 http(s) 图片在上面 img 分支里就已经被丢掉了。
        if (!/^(data:image\/|cid:|smattach:)/i.test(value.trim())) continue
      }
      if (name === 'style') {
        value = value
          .replace(/url\s*\([^)]*\)/gi, '')
          .replace(/expression\s*\([^)]*\)/gi, '')
      }
      clean.setAttribute(name, value)
    }
    for (const child of Array.from(el.childNodes)) copy(child, clean)
    parent.appendChild(clean)
  }

  for (const child of Array.from(tpl.content.childNodes)) copy(child, holder)
  return { html: holder.innerHTML, droppedImages, droppedBlocks }
}

/** 编辑器是不是空的（只剩 `<br>`、空 `<div>` 之类也算空） */
export function isBlankHtml(html: string): boolean {
  if (!html) return true
  if (/<(img|hr|table)\b/i.test(html)) return false
  return htmlToPlainText(html).trim() === ''
}

/**
 * 发信前把正文里的内嵌图片从 data URL 换成 `cid:` 引用。
 *
 * 编辑器里必须用 data URL 才能在窗口里显示出来；但真正发出去的邮件不能带
 * 几百 KB 的 base64（收件端大多会直接屏蔽 data: 图片）。所以：
 *   · 有 data-cid 的图（我们自己插/粘进来的）→ 换成 cid:contentId；
 *   · 没有登记的 data: 图（从别处整段粘过来、没来得及落盘的）→ 换成文字提示，
 *     否则用户以为发出去了，收件人那边其实是一片空白。
 *
 * @param keepDataUrl 存草稿时传 true：草稿要能重新打开就看到图，保留 data URL
 */
export function inlineImagesToCid(html: string, keepDataUrl: boolean): string {
  if (keepDataUrl || !html) return html
  if (!/<img/i.test(html)) return html
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  for (const img of Array.from(tpl.content.querySelectorAll('img'))) {
    const cid = img.getAttribute('data-cid')
    const src = (img.getAttribute('src') ?? '').trim()
    if (cid && /^data:/i.test(src)) {
      img.setAttribute('src', `cid:${cid}`)
      continue
    }
    if (/^data:/i.test(src)) {
      img.replaceWith(document.createTextNode('[图片]'))
    }
  }
  return tpl.innerHTML
}

/** data URL → File（不依赖 fetch，避开 CSP 对 data: 的 connect-src 限制） */
export function dataUrlToFile(dataUrl: string, filename: string, fallbackType = 'image/png'): File | null {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/i.exec(dataUrl)
  if (!m) return null
  const type = m[1] || fallbackType
  const isBase64 = Boolean(m[2])
  const payload = m[3] ?? ''
  let bytes: Uint8Array
  if (isBase64) {
    const bin = atob(payload)
    bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload))
  }
  // 复制到独立的 ArrayBuffer：Uint8Array 的底层缓冲区类型在 TS 里可能是
  // ArrayBufferLike（含 SharedArrayBuffer），不能直接当 BlobPart 用
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return new File([copy.buffer], filename, { type })
}
