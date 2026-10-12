import type { AttachmentMeta, FolderRole } from '@shared/types'
import type { IconName } from './components/Icon'

/* ───────────────────────── 时间 ───────────────────────── */

const pad = (n: number): string => String(n).padStart(2, '0')

export function formatListDate(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const yesterday = new Date(now.getTime() - 86400000)
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  if (isYesterday) return '昨天'
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

export function formatFullDate(ts: number): string {
  if (!ts) return '(无日期)'
  const d = new Date(ts)
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${week} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`
}

export function formatSize(bytes: number): string {
  if (!bytes || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/* ───────────────────────── 文件夹 ───────────────────────── */

/**
 * 文件夹角色 → 线条图标名（见 components/Icon.tsx）。
 * 用图标名而不是字符，方便调用方渲染 <Icon name={...} />。
 */
export const ROLE_ICON: Record<FolderRole, IconName> = {
  inbox: 'inbox',
  drafts: 'drafts',
  sent: 'sent',
  trash: 'trash',
  junk: 'junk',
  archive: 'archive',
  custom: 'folder'
}

export const ROLE_ORDER: FolderRole[] = ['inbox', 'drafts', 'sent', 'junk', 'archive', 'custom', 'trash']

export function folderIcon(role: FolderRole): IconName {
  return ROLE_ICON[role] ?? 'folder'
}

/* ───────────────────────── 正文渲染 ───────────────────────── */

/**
 * 处理 HTML 正文：
 *  1. 把 cid: 内联图片指向本程序的自定义协议，这样在沙箱 iframe 里也能显示；
 *  2. 如果用户没打开「允许外部图片」，把远程图片换成占位提示，避免被遥测像素跟踪。
 */
export function prepareHtmlBody(
  html: string,
  attachments: AttachmentMeta[],
  allowRemote: boolean
): string {
  let out = html

  const byCid = new Map<string, AttachmentMeta>()
  for (const a of attachments) {
    if (!a.contentId) continue
    byCid.set(a.contentId.replace(/^<|>$/g, '').toLowerCase(), a)
  }

  out = out.replace(/src\s*=\s*(["'])cid:([^"']+)\1/gi, (match, quote: string, cid: string) => {
    const key = decodeURIComponent(cid).replace(/^<|>$/g, '').toLowerCase()
    const att = byCid.get(key)
    if (!att) return match
    return `src=${quote}smattach://${att.id}/${quote}`
  })

  if (!allowRemote) {
    out = out.replace(
      /<img\b[^>]*\bsrc\s*=\s*(["'])https?:\/\/[^"']*\1[^>]*>/gi,
      '<span style="display:inline-block;padding:2px 8px;border:1px dashed #c3cad3;border-radius:4px;color:#8d949e;font-size:12px">远程图片已阻止</span>'
    )
  }

  return out
}

/** 给 iframe 注入基础样式，让纯文本邮件也好看 */
export function wrapHtmlDocument(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;}
  body{padding:14px 16px;font-family:'Noto Sans CJK SC','Microsoft YaHei',system-ui,sans-serif;
       font-size:13.5px;line-height:1.65;color:#23272e;word-break:break-word;}
  img{max-width:100%;height:auto;}
  table{max-width:100%;}
  a{color:#2f7fd8;}
  blockquote{border-left:2px solid #e2e6ea;margin-left:0;padding-left:12px;color:#5b636d;}
  pre{white-space:pre-wrap;word-break:break-word;}
</style></head><body>${body}</body></html>`
}

/* ───────────────────────── 搜索高亮 ───────────────────────── */

/** 把命中的关键字切成 React 片段（中英文都支持，大小写不敏感） */
export function highlightParts(text: string, terms: string[]): { text: string; hit: boolean }[] {
  if (!terms.length || !text) return [{ text, hit: false }]
  const escaped = terms
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length)
  if (!escaped.length) return [{ text, hit: false }]

  const re = new RegExp(`(${escaped.join('|')})`, 'gi')
  const parts: { text: string; hit: boolean }[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0
    if (idx > last) parts.push({ text: text.slice(last, idx), hit: false })
    parts.push({ text: m[0], hit: true })
    last = idx + m[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false })
  return parts.length ? parts : [{ text, hit: false }]
}

/* ───────────────────────── 地址 ───────────────────────── */

export function shortAddress(input: string): string {
  if (!input) return ''
  return input
    .split(',')
    .map((s) => {
      const m = /<([^>]+)>/.exec(s)
      return (m ? m[1] : s).trim()
    })
    .filter(Boolean)
    .join(', ')
}

export function replySubject(subject: string): string {
  if (!subject) return '回复：'
  return /^re[:：]/i.test(subject) ? subject : `回复：${subject}`
}

export function forwardSubject(subject: string): string {
  if (!subject) return '转发：'
  return /^(fwd?|转发)[:：]/i.test(subject) ? subject : `转发：${subject}`
}

/** 时间戳 → 用于文件名 */
export function fileStamp(ts: number): string {
  const d = new Date(ts || Date.now())
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(
    d.getMinutes()
  )}`
}
