/**
 * 地址串的小工具。
 *
 * 独立成模块（而不是塞在 Composer.tsx 里）是为了能被自检直接测到：
 * 「全部回复把我自己也加进收件人」这类 bug 恰恰是单看界面发现不了的。
 */

/**
 * 按逗号/分号切地址串。
 *
 * 不能简单地 `split(',')`：显示名里带逗号很常见
 * （`"Zhang, Wei" <zw@example.com>`），裸切会把这个收件人劈成两个假地址，
 * 于是「全部回复」里就多出一个不存在的收件人。
 * 这里按「引号内」和「尖括号内」都不算分隔符来处理。
 */
export function splitAddressList(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  let inAngle = false
  for (const ch of input ?? '') {
    if (ch === '"') inQuote = !inQuote
    else if (ch === '<' && !inQuote) inAngle = true
    else if (ch === '>' && !inQuote) inAngle = false
    if ((ch === ',' || ch === ';') && !inQuote && !inAngle) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** 从一个地址串里取出纯净的邮箱地址（小写、去掉显示名） */
export function addressOf(part: string): string {
  const m = /<([^>]+)>/.exec(part)
  return ((m ? m[1] : part) ?? '').trim().toLowerCase()
}

/**
 * 从地址串里去掉指定的地址（通常是「我自己」）。
 *
 * 起因：点「全部回复」时原邮件的收件人里本来就有我自己，
 * 之前直接把 `mail.toText` 拼进收件人，结果发出去的邮件收件人包含自己的地址。
 * 按地址精确比对，忽略大小写；其它人一个不动。
 */
export function excludeAddress(list: string, address: string): string {
  const me = (address ?? '').trim().toLowerCase()
  if (!me) return list
  return splitAddressList(list)
    .filter((p) => addressOf(p) !== me)
    .join(', ')
}
