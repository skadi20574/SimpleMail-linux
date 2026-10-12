/**
 * 键盘快捷键的定义与解析。
 *
 * 主进程（存设置）与渲染进程（派发按键）共用，保证「界面上写的是什么」
 * 和「实际按下去认的是什么」用的是同一套规则。
 *
 * 绑定字符串格式：修饰键按固定顺序 Ctrl → Alt → Shift，最后是键名。
 *   例：`Ctrl+Shift+R`、`Shift+Delete`、`ArrowDown`、`F5`、`M`
 * 之所以要求固定顺序，是为了能用字符串直接比较、直接存进 JSON。
 */

import type { AppSettings } from './types'

export type ShortcutGroup = '邮件' | '选择' | '操作'

export interface ShortcutActionDef {
  id: string
  label: string
  group: ShortcutGroup
  defaultBinding: string
  /** true = 在输入框里也生效（比如 Ctrl+N 写邮件）；false = 只在列表区生效 */
  allowInInput?: boolean
  hint?: string
}

export const SHORTCUT_ACTIONS: ShortcutActionDef[] = [
  // ── 邮件 ──
  { id: 'newMail', label: '写邮件', group: '邮件', defaultBinding: 'Ctrl+N', allowInInput: true },
  { id: 'reply', label: '回复', group: '邮件', defaultBinding: 'Ctrl+R', allowInInput: true },
  {
    id: 'replyAll',
    label: '回复全部',
    group: '邮件',
    defaultBinding: 'Ctrl+Shift+R',
    allowInInput: true
  },
  { id: 'forward', label: '转发', group: '邮件', defaultBinding: 'Ctrl+L', allowInInput: true },
  { id: 'search', label: '跳到搜索框', group: '邮件', defaultBinding: 'Ctrl+F', allowInInput: true },
  { id: 'sync', label: '同步全部账户', group: '邮件', defaultBinding: 'F5' },
  { id: 'openWindow', label: '在新窗口打开', group: '邮件', defaultBinding: 'Enter' },

  // ── 选择 ──
  { id: 'nextMail', label: '下一封', group: '选择', defaultBinding: 'ArrowDown' },
  { id: 'prevMail', label: '上一封', group: '选择', defaultBinding: 'ArrowUp' },
  {
    id: 'extendNext',
    label: '向下扩展选择',
    group: '选择',
    defaultBinding: 'Shift+ArrowDown',
    hint: '从锚点开始连选，可反复按'
  },
  { id: 'extendPrev', label: '向上扩展选择', group: '选择', defaultBinding: 'Shift+ArrowUp' },
  { id: 'toFirst', label: '跳到列表开头', group: '选择', defaultBinding: 'Home' },
  { id: 'toLast', label: '跳到列表末尾', group: '选择', defaultBinding: 'End' },
  { id: 'pageDown', label: '向下翻页', group: '选择', defaultBinding: 'PageDown' },
  { id: 'pageUp', label: '向上翻页', group: '选择', defaultBinding: 'PageUp' },
  { id: 'selectAll', label: '全选', group: '选择', defaultBinding: 'Ctrl+A' },
  { id: 'clearSelection', label: '收回多选 / 退出输入框', group: '选择', defaultBinding: 'Escape', allowInInput: true },

  // ── 操作 ──
  {
    id: 'delete',
    label: '移到垃圾箱',
    group: '操作',
    defaultBinding: 'Delete',
    hint: '本地与 IMAP 服务器一起移动，可恢复'
  },
  {
    id: 'deletePermanent',
    label: '永久删除',
    group: '操作',
    defaultBinding: 'Shift+Delete',
    hint: '本机正文与附件文件一并清掉；IMAP 账户会同时在服务器移到垃圾箱'
  },
  { id: 'toggleRead', label: '标记已读 / 未读', group: '操作', defaultBinding: 'M' },
  { id: 'toggleFlag', label: '加 / 取消星标', group: '操作', defaultBinding: 'S' }
]

export const DEFAULT_SHORTCUTS: Record<string, string> = Object.fromEntries(
  SHORTCUT_ACTIONS.map((a) => [a.id, a.defaultBinding])
)

/** 取生效的快捷键表（用户设置覆盖默认值） */
export function resolveShortcuts(settings: Pick<AppSettings, 'shortcuts'>): Record<string, string> {
  return { ...DEFAULT_SHORTCUTS, ...(settings.shortcuts ?? {}) }
}

/**
 * 把一次按键事件转成绑定字符串。
 * 单独按下修饰键时返回空串（表示「还没按完」，调用方应忽略）。
 */
export function bindingFromEvent(e: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}): string {
  const key = e.key
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return ''
  if (!key) return ''

  const parts: string[] = []
  // Mac 上的 Cmd 统一归一化成 Ctrl，跨平台只维护一套绑定
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')

  let name = key
  if (name === ' ') name = 'Space'
  // 单字符键统一大写：这样 'm' 与 'M'、Ctrl+a 与 Ctrl+A 都是同一个绑定
  if (name.length === 1) name = name.toUpperCase()
  parts.push(name)

  return parts.join('+')
}

/** 人类可读的键名（界面上显示用） */
export function prettyBinding(binding: string): string {
  if (!binding) return '未设置'
  return binding
    .split('+')
    .map((p) => {
      if (p === 'ArrowDown') return '↓'
      if (p === 'ArrowUp') return '↑'
      if (p === 'ArrowLeft') return '←'
      if (p === 'ArrowRight') return '→'
      if (p === 'Escape') return 'Esc'
      if (p === 'Space') return '空格'
      if (p === 'Delete') return 'Del'
      return p
    })
    .join(' + ')
}

/**
 * 从快捷键表反查出这次按键对应哪个动作。
 * 同一个绑定被分配到多个动作时，靠前的动作优先（界面上会提示冲突）。
 */
export function actionForEvent(
  e: Parameters<typeof bindingFromEvent>[0],
  shortcuts: Record<string, string>
): string | null {
  const binding = bindingFromEvent(e)
  if (!binding) return null
  for (const action of SHORTCUT_ACTIONS) {
    if (shortcuts[action.id] === binding) return action.id
  }
  return null
}

/** 找出重复分配的动作 id 集合（界面提示用） */
export function findShortcutConflicts(shortcuts: Record<string, string>): Set<string> {
  const byBinding = new Map<string, string[]>()
  for (const action of SHORTCUT_ACTIONS) {
    const b = shortcuts[action.id]
    if (!b) continue
    const list = byBinding.get(b) ?? []
    list.push(action.id)
    byBinding.set(b, list)
  }
  const conflicts = new Set<string>()
  for (const ids of byBinding.values()) {
    if (ids.length > 1) for (const id of ids) conflicts.add(id)
  }
  return conflicts
}
