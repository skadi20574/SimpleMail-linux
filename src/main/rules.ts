/**
 * 自动归类 / 自动删除规则引擎。
 *
 * 规则 = 一组条件 + 一个动作。邮件「落地」时逐条评估，命中的第一条
 * （若该规则设了「命中后停止」）就执行动作。
 *
 * 两个关键设计：
 *
 * 1. **依赖正文的条件会推迟评估**。同步是先抓信封、再补正文的两段式，
 *    信封阶段正文还是空的。所以如果某条规则要匹配正文，这一阶段就跳过它、
 *    把 `rules_done` 留成 0，等正文补下来再评一次。否则正文规则永远不会命中。
 *
 * 2. **删除类动作对 IMAP 会同步到服务器**。只删本地的话，下次同步邮件又回来了，
 *    那是 bug 不是特性。这里复用 mail/actions.ts 的批量逻辑（本地立即生效，
 *    服务器后台异步跟上）。
 */

import type { Rule, RuleCondition, RuleDraft, RulePreview, RulePreviewItem } from '@shared/types'
import * as repo from './db/repo'
import { deleteMailsPermanently, moveMailsToTrash } from './mail/actions'
import { moveManyOnServer } from './mail/imap'

/* ───────────────────────── 条件求值 ───────────────────────── */

interface MailLike {
  subject: string | null
  from_name: string | null
  from_addr: string | null
  to_text: string | null
  cc_text: string | null
  body_text: string | null
  raw_headers: string | null
}

/** 取出 `X-Foo: bar` 形式的头部值 */
function headerValue(rawHeaders: string | null, name: string): string {
  if (!rawHeaders) return ''
  const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}:\\s*(.*)$`, 'im')
  const m = re.exec(rawHeaders)
  return m ? m[1].trim() : ''
}

function fieldValue(mail: MailLike, field: RuleCondition['field']): string {
  switch (field) {
    case 'from':
      return mail.from_addr ?? ''
    case 'fromName':
      return mail.from_name ?? ''
    case 'to':
      return mail.to_text ?? ''
    case 'cc':
      return mail.cc_text ?? ''
    case 'subject':
      return mail.subject ?? ''
    case 'body':
      return mail.body_text ?? ''
    case 'header':
      return mail.raw_headers ?? ''
    case 'any':
    default:
      return [
        mail.subject,
        mail.from_name,
        mail.from_addr,
        mail.to_text,
        mail.cc_text,
        mail.body_text
      ]
        .filter(Boolean)
        .join('\\n')
  }
}

/** 把条件里的值拆成「头部名 + 内容」，用于 field='header' */
function splitHeaderSpec(value: string): { name: string; pattern: string } {
  const idx = value.indexOf(':')
  if (idx === -1) return { name: value.trim(), pattern: '' }
  return { name: value.slice(0, idx).trim(), pattern: value.slice(idx + 1).trim() }
}

/** 单个条件是否命中 */
export function testCondition(mail: MailLike, cond: RuleCondition): boolean {
  let haystack: string
  let needle = cond.value ?? ''

  if (cond.field === 'header') {
    const { name, pattern } = splitHeaderSpec(cond.value ?? '')
    if (!name) return false
    haystack = headerValue(mail.raw_headers, name)
    needle = pattern
  } else {
    haystack = fieldValue(mail, cond.field)
  }

  if (!needle) {
    // 空值条件：只有「不包含」这种否定条件才有意义
    return cond.op === 'notContains'
  }

  const h = haystack.toLowerCase()
  const n = needle.toLowerCase()

  switch (cond.op) {
    case 'contains':
      return h.includes(n)
    case 'notContains':
      return !h.includes(n)
    case 'equals':
      return h.trim() === n.trim()
    case 'startsWith':
      return h.trimStart().startsWith(n)
    case 'endsWith':
      return h.trimEnd().endsWith(n)
    case 'regex':
      try {
        return new RegExp(needle, 'i').test(haystack)
      } catch {
        // 正则写错了就当作不匹配，不要让一条坏规则把同步搞崩
        return false
      }
    default:
      return false
  }
}

/** 这条规则是否需要正文才能评估 */
export function ruleNeedsBody(rule: Rule): boolean {
  return rule.conditions.some((c) => c.field === 'body' || c.field === 'any')
}

/** 规则是否命中；返回命中的条件描述，未命中返回 null */
export function matchRule(mail: MailLike, rule: Rule): string[] | null {
  const conds = rule.conditions ?? []
  if (!conds.length) return null

  const hits: string[] = []
  for (const c of conds) {
    const ok = testCondition(mail, c)
    if (ok) hits.push(describeCondition(c))
    else if (rule.matchMode === 'all') return null
  }

  if (rule.matchMode === 'any') return hits.length ? hits : null
  return hits
}

const FIELD_LABEL: Record<RuleCondition['field'], string> = {
  from: '发件人',
  fromName: '发件人姓名',
  to: '收件人',
  cc: '抄送',
  subject: '主题',
  body: '正文',
  header: '邮件头',
  any: '任意字段'
}

const OP_LABEL: Record<RuleCondition['op'], string> = {
  contains: '包含',
  notContains: '不包含',
  equals: '等于',
  startsWith: '开头是',
  endsWith: '结尾是',
  regex: '匹配正则'
}

export function describeCondition(c: RuleCondition): string {
  return `${FIELD_LABEL[c.field] ?? c.field} ${OP_LABEL[c.op] ?? c.op}「${c.value}」`
}

/* ───────────────────────── 动作执行 ───────────────────────── */

function accountCanSyncToServer(accountId: number): boolean {
  const account = repo.getAccount(accountId)
  return Boolean(account && !account.isLocal && account.protocol === 'imap')
}

/** 把邮件移到指定文件夹，IMAP 后台同步到服务器 */
function applyMove(mailId: number, folderId: number): void {
  const locations = repo.getMailLocations([mailId])
  const loc = locations[0]
  if (!loc) return
  if (loc.folderId === folderId) return

  repo.moveMany([mailId], folderId)

  if (loc.uid !== null && accountCanSyncToServer(loc.accountId)) {
    const account = repo.getAccount(loc.accountId)!
    const from = repo.getFolder(loc.folderId)
    const to = repo.getFolder(folderId)
    if (from && to) {
      void moveManyOnServer(account, from.path, [loc.uid], to.path).catch(() => {})
    }
  }
}

/** 对一个已经落库的邮件执行规则；返回动作数 */
function executeRule(mailId: number, rule: Rule): boolean {
  const loc = repo.getMailLocations([mailId])[0]
  if (!loc) return false

  switch (rule.action) {
    case 'trash':
      moveMailsToTrash([mailId])
      return true
    case 'delete':
      deleteMailsPermanently([mailId])
      return true
    case 'move':
      if (rule.actionFolderId) {
        applyMove(mailId, rule.actionFolderId)
        return true
      }
      return false
    case 'mark_read':
      repo.markManyRead([mailId], false)
      return true
    case 'flag':
      repo.markManyFlagged([mailId], true)
      return true
    case 'mark_read_move':
      repo.markManyRead([mailId], false)
      if (rule.actionFolderId) applyMove(mailId, rule.actionFolderId)
      return true
    default:
      return false
  }
}

/* ───────────────────────── 对外入口 ───────────────────────── */

export interface ApplyOutcome {
  /** 执行了几个动作 */
  acted: number
  /** 命中的规则名 */
  matched: string[]
  /** 是否有规则因为正文还没到而被推迟 */
  postponed: boolean
}

/**
 * 对一封邮件评估并执行规则。
 *
 * @param force 忽略 `rules_done` 标记强制重评（正文补下来时用）
 */
export function applyRulesToMail(mailId: number, force = false): ApplyOutcome {
  const outcome: ApplyOutcome = { acted: 0, matched: [], postponed: false }

  const mail = repo.getMailFull(mailId)
  if (!mail) return outcome
  if (!force && repo.isRulesDone(mailId)) return outcome

  const rules = repo.listRules(mail.account_id).filter((r) => r.enabled)
  if (!rules.length) {
    repo.setMailRulesDone(mailId, true)
    return outcome
  }

  // 已经执行过动作的规则不再重复执行。
  //
  // 这一步不是优化，而是**正确性要求**：正文补下来后会再评一次规则，
  // 如果规则是「移到垃圾箱」，第二次执行时邮件已经在垃圾箱里，
  // 而 moveMailsToTrash 对垃圾箱里的邮件等同于永久删除 —— 会误删。
  const fired = new Set(repo.getMailRulesFired(mailId))

  // 正文还没下载下来时（body_text 空 且 body_html 为 null），
  // 依赖正文的规则先跳过，留到正文补齐后再评。
  const bodyAvailable = !(mail.body_text === '' && mail.body_html === null)

  let deleted = false
  for (const rule of rules) {
    if (fired.has(rule.id)) continue

    if (ruleNeedsBody(rule) && !bodyAvailable) {
      outcome.postponed = true
      continue
    }

    const hits = matchRule(mail, rule)
    if (!hits) continue

    outcome.matched.push(rule.name)
    fired.add(rule.id)
    if (executeRule(mailId, rule)) outcome.acted++
    if (rule.action === 'delete') deleted = true

    // 规则可能把邮件删了，后面的规则就没法继续
    if (deleted) break
    if (rule.stop) break
  }

  repo.setMailRulesFired(mailId, [...fired])
  // 邮件已经被删掉就不必再更新状态了
  if (!deleted) repo.setMailRulesDone(mailId, !outcome.postponed)
  return outcome
}

/** 试运行：只统计匹配结果，绝不改任何数据 */
export function previewRule(draft: RuleDraft, limit = 200): RulePreview {
  const rule: Rule = {
    id: 0,
    name: draft.name || '（未命名规则）',
    enabled: true,
    priority: draft.priority ?? 100,
    accountId: draft.accountId ?? null,
    matchMode: draft.matchMode ?? 'all',
    conditions: draft.conditions ?? [],
    action: draft.action,
    actionFolderId: draft.actionFolderId ?? null,
    stop: draft.stop !== false,
    createdAt: 0
  }

  if (!rule.conditions.length) {
    return { matched: 0, samples: [], error: '还没有配置任何条件' }
  }

  // 逻辑写错的正则会让整条规则失效，这里提前报出来
  for (const c of rule.conditions) {
    if (c.op === 'regex' && c.value) {
      try {
        new RegExp(c.value, 'i')
      } catch {
        return { matched: 0, samples: [], error: `正则表达式无效：${c.value}` }
      }
    }
  }

  const rows = repo.listMailsForRuleScan(rule.accountId, limit)
  const samples: RulePreviewItem[] = []
  let matched = 0

  for (const row of rows) {
    const hits = matchRule(row as unknown as MailLike, rule)
    if (!hits) continue
    matched++
    if (samples.length < 20) {
      samples.push({
        mailId: row.id,
        subject: row.subject ?? '',
        fromAddr: row.from_addr ?? '',
        date: row.date,
        matchedConditions: hits
      })
    }
  }

  return { matched, samples }
}

/** 对现有邮件批量重跑规则（用户手动触发） */
export function runAllRules(accountId?: number): { scanned: number; acted: number } {
  const ids = repo.listMailsPendingRules(accountId, 20000)
  let acted = 0
  for (const id of ids) {
    // 邮件可能已经被前面的规则删掉了
    if (!repo.getMailFull(id)) continue
    acted += applyRulesToMail(id, true).acted
  }
  return { scanned: ids.length, acted }
}
