/**
 * 「这到底算不算用户附件」的判定。
 *
 * 主进程（算 has_attachments）与渲染进程（正文页的附件区）**必须用同一套规则**，
 * 否则又会出现「列表有回形针、点开什么都没有」这种两边不一致的毛病。
 *
 * 踩过的坑（用真实邮箱 9097 封统计出来的）：
 *   · Foxmail 会往邮件里塞一个 `Content-Type: foxmailicon` 的内部部件，
 *     156KB、没有文件名 —— 那是它自己的图标，跟用户无关；
 *   · 还有一堆 `text/calendar`、`text/richtext`、无文件名的 `image/*`、
 *     以及 `unnamed` 这类部件，多半是正文的一部分或客户端标记。
 * 这些都被记成了「非内嵌附件」，于是回复邮件也被打上了回形针。
 * 实测 2403 封带标记的邮件里，有 22 封纯粹是这些垃圾部件造成的。
 */

/** 明确不是用户附件的 Content-Type（Foxmail 内部部件） */
const INTERNAL_TYPES = new Set(['foxmailicon'])

/**
 * 没有可显示的文件名 —— 这种部件即使用户点开也只会看到一个空名字的条目，
 * 不算「有附件」。
 */
function hasUsableName(filename: string | null | undefined): boolean {
  const name = (filename ?? '').trim()
  if (!name) return false
  // Foxmail 解析不出来的部件常被记成这些占位名
  if (/^(unnamed|noname|unknown)$/i.test(name)) return false
  return true
}

export interface AttachmentLike {
  filename?: string | null
  contentType?: string | null
  isInline?: boolean
}

/** 这个附件是不是「用户能看见、能下载」的真附件 */
export function isRealAttachment(a: AttachmentLike): boolean {
  if (a.isInline) return false
  const ct = (a.contentType ?? '').split(';')[0].trim().toLowerCase()
  if (INTERNAL_TYPES.has(ct)) return false
  return hasUsableName(a.filename)
}

/** 一组附件里有没有真附件（算 has_attachments 用） */
export function hasRealAttachments(atts: readonly AttachmentLike[]): boolean {
  return atts.some(isRealAttachment)
}
