/**
 * `mailto:` URI 的解析（RFC 6068）。
 *
 * 用途：把 SimpleMail 注册成系统的「邮件程序」之后，用户在网页或文档里点
 * `mailto:someone@example.com?subject=...` 这样的链接，系统就会带着这串 URI
 * 启动本程序（或交给已在运行的实例），我们需要把它变成写信窗口里的收件人、
 * 抄送、主题和正文。
 *
 * 格式：`mailto:` + 逗号分隔的收件人 + 可选的 `?字段=值&字段=值`
 * 支持的 hfield：to / cc / bcc / subject / body（大小写不敏感）。
 *
 * 关于 `+`：RFC 6068 明确 `+` 是普通字符，**不像** form-urlencoded 那样代表空格。
 * 所以这里只做百分号解码，不把 `+` 换成空格 —— Thunderbird 等也是这个行为。
 * 网页端一般会把空格编码成 %20，所以实际使用不会出问题。
 */

export interface MailtoRequest {
  to: string
  cc: string
  bcc: string
  subject: string
  body: string
  /**
   * 附件路径（绝对路径）。
   *
   * 来源是 `attach=` 参数 —— 这是 xdg-email 的约定：文件管理器里
   * 「邮件发送…」会执行 `xdg-email --attach <文件>`，而 xdg-email 对
   * **非 Thunderbird** 的客户端只会把它塞进 mailto URL：
   *
   *     mailto:addr?subject=...&attach=%2Ftmp%2F%E6%88%91%E7%9A%84%20%E6%96%87%E4%BB%B6.txt
   *
   * Thunderbird 走它自己的特殊分支，其它客户端一律按这个格式拿到附件，
   * 所以这是唯一能支持「右键文件 → 邮件发送」的通用办法。
   */
  attachments: string[]
}

/** 判断一个字符串是不是 mailto: 链接（大小写不敏感，允许前后空白） */
export function isMailtoUrl(value: string): boolean {
  return /^\s*mailto:/i.test(value)
}

/**
 * 百分号解码。遇到畸形的转义（比如孤立的 `%`）时原样返回，
 * 不能因为一个坏字符就把整条链接丢掉 —— 用户点了链接却毫无反应更难排查。
 */
function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value.replace(/%([0-9a-fA-F]{2})/g, (m, hex: string) =>
      String.fromCharCode(parseInt(hex, 16))
    )
  }
}

/** 收件人列表：先解码再按逗号切，顺带去掉空白项 */
function splitAddresses(raw: string): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of decode(raw).split(',')) {
    const addr = part.trim()
    if (!addr) continue
    // 同一个地址写两遍没意义，顺手去重（保持首次出现的顺序）
    const key = addr.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(addr)
  }
  return out.join(', ')
}

/**
 * 解析 mailto URI。返回 null 表示这不是一条可用的 mailto 链接。
 *
 * 注意 `mailto:` 后面**什么都没有**也是合法的（RFC 6068 允许），
 * 这时返回一个各字段都为空的请求 —— 打开一个空白的写信窗口，
 * 正是「点邮件图标直接写新邮件」该有的行为。
 */
export function parseMailto(url: string): MailtoRequest | null {
  if (typeof url !== 'string') return null
  const trimmed = url.trim()
  if (!isMailtoUrl(trimmed)) return null

  const rest = trimmed.slice('mailto:'.length)

  // 用第一个 '?' 切分路径与查询串。后面的 '?' 属于查询值的一部分。
  const qIndex = rest.indexOf('?')
  const path = qIndex === -1 ? rest : rest.slice(0, qIndex)
  const query = qIndex === -1 ? '' : rest.slice(qIndex + 1)

  const request: MailtoRequest = {
    to: splitAddresses(path),
    cc: '',
    bcc: '',
    subject: '',
    body: '',
    attachments: []
  }

  if (query) {
    for (const pair of query.split('&')) {
      if (!pair) continue
      const eq = pair.indexOf('=')
      if (eq === -1) continue
      const key = decode(pair.slice(0, eq)).trim().toLowerCase()
      const rawValue = pair.slice(eq + 1)
      switch (key) {
        case 'to':
          // ?to= 与路径里的收件人合并
          request.to = [request.to, splitAddresses(rawValue)].filter(Boolean).join(', ')
          break
        case 'cc':
          request.cc = splitAddresses(rawValue)
          break
        case 'bcc':
          request.bcc = splitAddresses(rawValue)
          break
        case 'subject':
          request.subject = decode(rawValue)
          break
        case 'body':
          request.body = decode(rawValue)
          break
        case 'attach':
        case 'attachment': {
          // 有的客户端/脚本会写成 file:// URL，统一还原成普通路径
          let file = decode(rawValue).trim()
          if (/^file:\/\//i.test(file)) {
            try {
              file = decodeURIComponent(new URL(file).pathname)
            } catch {
              file = file.replace(/^file:\/\//i, '')
            }
          }
          if (file && !request.attachments.includes(file)) request.attachments.push(file)
          break
        }
        default:
          // 其它 hfield（in-reply-to、x-* 等）忽略：写信窗口没有对应输入框，
          // 硬塞进正文反而会让用户困惑。
          break
      }
    }
  }

  return request
}

/** 从一条内容为空的请求里判断「什么都没带」 */
export function isMailtoRequestEmpty(req: MailtoRequest): boolean {
  return (
    !req.to &&
    !req.cc &&
    !req.bcc &&
    !req.subject &&
    !req.body &&
    req.attachments.length === 0
  )
}

/**
 * 从命令行参数里找出 mailto 链接并解析。
 *
 * Linux 下桌面环境把链接作为普通参数传进来（`Exec=... %U`），
 * 所以只要扫一遍参数即可。返回 null 表示这次启动不是由 mailto 触发的。
 *
 * 另外，有些文件管理器/脚本会把**文件本身**作为参数传进来
 * （`simplemail 文件1 文件2`），这里一并收作附件 —— 这样
 * 「用 SimpleMail 打开 / 发送」这类入口也能工作。
 *
 * @param extraFileExists 判断某个参数是不是真实存在的文件。
 *   主体进程用 fs.statSync；不传则只处理 mailto 里的 attach。
 */
export function parseMailtoFromArgv(
  argv: readonly string[],
  extraFileExists?: (path: string) => boolean
): MailtoRequest | null {
  let parsed: MailtoRequest | null = null

  for (const arg of argv) {
    if (isMailtoUrl(arg)) {
      const p = parseMailto(arg)
      if (p) parsed = p
    }
  }

  const loose: string[] = []
  if (extraFileExists) {
    // 跳过 argv[0]：按惯例那是程序自身的路径（打包后是 simplemail.bin，
    // 它确实是个存在的文件）。不跳过的话，每次发邮件都会把程序二进制
    // 当成附件带上 —— 实测就是这么发现的。
    for (const arg of argv.slice(1)) {
      // 跳过程序路径本身与开关，只看像文件名的裸参数
      if (!arg || arg.startsWith('-')) continue
      if (isMailtoUrl(arg)) continue
      if (arg.endsWith('.asar')) continue
      if (/\.(js|cjs|mjs|ts)$/i.test(arg)) continue // 开发时 `electron .` 之类
      if (!extraFileExists(arg)) continue
      if (!loose.includes(arg)) loose.push(arg)
    }
  }

  if (!parsed && !loose.length) return null
  if (!parsed) {
    parsed = { to: '', cc: '', bcc: '', subject: '', body: '', attachments: [] }
  }
  for (const f of loose) {
    if (!parsed.attachments.includes(f)) parsed.attachments.push(f)
  }
  return parsed
}

/** 把解析结果拼回一条 mailto 链接（自检里用来验证往返一致） */
export function buildMailto(req: Partial<MailtoRequest>): string {
  const enc = (s: string): string => encodeURIComponent(s)
  const params: string[] = []
  if (req.cc) params.push(`cc=${enc(req.cc)}`)
  if (req.bcc) params.push(`bcc=${enc(req.bcc)}`)
  if (req.subject) params.push(`subject=${enc(req.subject)}`)
  if (req.body) params.push(`body=${enc(req.body)}`)
  for (const f of req.attachments ?? []) params.push(`attach=${enc(f)}`)
  const head = `mailto:${(req.to ?? '').split(',').map((s) => enc(s.trim())).filter(Boolean).join(',')}`
  return params.length ? `${head}?${params.join('&')}` : head
}
