/**
 * 搜索关键字的切词逻辑 —— 主进程与渲染进程共用，保证「怎么建索引」和
 * 「怎么高亮」用的是同一套规则。
 *
 * 中文问题：FTS5 的 unicode61 分词器把连续汉字当成**一个** token，
 * 于是「季度报告」搜「报告」搜不到。这里的做法是把汉字逐字拆开
 * （索引侧写进 cjk 列，查询侧变成 `cjk:"报 告"` 这样的短语），
 * 等价于子串匹配，1~2 个字的短词也能命中。
 */

/** 需要逐字索引的文字：CJK 表意文字、扩展区、假名、谚文、全角符号 */
const CJK_CHAR_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f\uac00-\ud7af]/

const CJK_ANY_RE = new RegExp(CJK_CHAR_RE.source)

export function hasCjk(text: string): boolean {
  return CJK_ANY_RE.test(text)
}

/**
 * 生成写入 `cjk` 列的内容：只保留需要逐字检索的字符，用空格分开。
 * 西文不进这一列（避免与常规列重复命中，也避免索引体积无谓翻倍）。
 */
export function buildCjkIndexText(...parts: (string | null | undefined)[]): string {
  const out: string[] = []
  for (const part of parts) {
    if (!part) continue
    for (const ch of part) {
      if (CJK_CHAR_RE.test(ch)) out.push(ch)
    }
  }
  return out.join(' ')
}

function quote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`
}

interface Token {
  kind: 'cjk' | 'word'
  value: string
}

/** 按空白切词，但尊重中英文引号短语 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '"' || ch === '“' || ch === '”') {
      const closer = ch === '“' ? '”' : ch
      const end = input.indexOf(closer, i + 1)
      const raw = end === -1 ? input.slice(i + 1) : input.slice(i + 1, end)
      i = end === -1 ? input.length : end + 1
      if (raw.trim()) tokens.push(classify(raw.trim()))
      continue
    }
    let j = i
    while (j < input.length && !/\s/.test(input[j]) && input[j] !== '"' && input[j] !== '“') j++
    const raw = input.slice(i, j)
    i = j
    if (raw) tokens.push(classify(raw))
  }
  return tokens
}

function classify(raw: string): Token {
  return { kind: CJK_ANY_RE.test(raw) ? 'cjk' : 'word', value: raw }
}

/** 把一个混合 token（如「发票PDF」）拆成 CJK 段与非 CJK 段 */
function expand(token: Token): string[] {
  const parts: string[] = []
  let cjkRun = ''
  let wordRun = ''

  const flushCjk = (): void => {
    if (!cjkRun) return
    const chars = [...cjkRun].filter((c) => CJK_CHAR_RE.test(c))
    // 不加列名前缀：FTS5 会在所有列里找这个短语，而「字 字 字」这种相邻单字
    // 只可能出现在 cjk_* 那几个逐字索引列里，所以等价于「全字段中文匹配」。
    // （分字段列改名后如果还写 `cjk:` 会直接报 no such column）
    if (chars.length) parts.push(quote(chars.join(' ')))
    cjkRun = ''
  }
  const flushWord = (): void => {
    if (!wordRun) return
    const cleaned = wordRun.replace(/[^\p{L}\p{N}_.@+-]/gu, '')
    if (cleaned) parts.push(quote(cleaned))
    wordRun = ''
  }

  for (const ch of token.value) {
    if (CJK_CHAR_RE.test(ch)) {
      flushWord()
      cjkRun += ch
    } else if (/\s/.test(ch)) {
      flushCjk()
      flushWord()
    } else {
      flushCjk()
      wordRun += ch
    }
  }
  flushCjk()
  flushWord()
  return parts
}

/**
 * 搜索范围。用户可以限定只搜某个字段（发件人 / 收件人 / 主题 / 正文）。
 *
 * 这要求索引里**每个字段各有一列 CJK 数据**（cjk_subject / cjk_sender / …），
 * 否则中文没法限定字段 —— 详见 src/main/db/fts.ts 的说明。
 */
export type SearchField = 'all' | 'subject' | 'from' | 'to' | 'body'

/** 字段 → FTS 列名映射：常规列处理西文，cjk_ 列处理中日韩逐字检索 */
const FIELD_COLUMNS: Record<Exclude<SearchField, 'all'>, { text: string; cjk: string }> = {
  subject: { text: 'subject', cjk: 'cjk_subject' },
  from: { text: 'sender', cjk: 'cjk_sender' },
  to: { text: 'recipients', cjk: 'cjk_recipients' },
  body: { text: 'body', cjk: 'cjk_body' }
}

/** 把一段关键字转成限定到某个字段的表达式 */
function expandForField(token: Token, field: Exclude<SearchField, 'all'>): string[] {
  const cols = FIELD_COLUMNS[field]
  const parts: string[] = []

  let cjkRun = ''
  let wordRun = ''
  const flushCjk = (): void => {
    if (!cjkRun) return
    const chars = [...cjkRun].filter((c) => CJK_CHAR_RE.test(c))
    if (chars.length) parts.push(`${cols.cjk}:${quote(chars.join(' '))}`)
    cjkRun = ''
  }
  const flushWord = (): void => {
    if (!wordRun) return
    const cleaned = wordRun.replace(/[^\p{L}\p{N}_.@+-]/gu, '')
    if (cleaned) parts.push(`${cols.text}:${quote(cleaned)}`)
    wordRun = ''
  }

  for (const ch of token.value) {
    if (CJK_CHAR_RE.test(ch)) {
      flushWord()
      cjkRun += ch
    } else if (/\s/.test(ch)) {
      flushCjk()
      flushWord()
    } else {
      flushCjk()
      wordRun += ch
    }
  }
  flushCjk()
  flushWord()
  return parts
}

/**
 * 构造 FTS5 的 MATCH 表达式。
 * 返回 null 表示关键字里没有可用内容（调用方应退化为普通列表查询）。
 *
 * @param field 搜索范围，默认 'all'（不限定列，全字段匹配）
 */
export function buildMatchQuery(input: string, field: SearchField = 'all'): string | null {
  const tokens = tokenize(input.trim())
  if (!tokens.length) return null

  const narrow = field !== 'all' ? (field as Exclude<SearchField, 'all'>) : null

  const groups: string[] = []
  for (const token of tokens) {
    const parts = narrow ? expandForField(token, narrow) : expand(token)
    if (!parts.length) continue
    groups.push(parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`)
  }
  if (!groups.length) return null
  return groups.join(' AND ')
}

export const SEARCH_FIELD_LABELS: { value: SearchField; label: string }[] = [
  { value: 'all', label: '全部字段' },
  { value: 'from', label: '发件人' },
  { value: 'to', label: '收件人' },
  { value: 'subject', label: '主题' },
  { value: 'body', label: '正文' }
]

/** 高亮用的词表：中文词按原样（连续字符），英文按整词 */
export function splitHighlightTerms(input: string): string[] {
  const terms: string[] = []
  for (const token of tokenize(input.trim())) {
    if (token.kind === 'cjk') {
      const chars = [...token.value].filter((c) => CJK_CHAR_RE.test(c))
      if (chars.length) terms.push(chars.join(''))
    } else {
      const cleaned = token.value.replace(/[^\p{L}\p{N}_.@+-]/gu, '')
      if (cleaned) terms.push(cleaned)
    }
  }
  return terms
}
