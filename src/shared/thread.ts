/**
 * 邮件线程（回复线索）分组。
 *
 * 用途：列表上把「同一主题的一串回复」折叠成一行，点开才展开。
 * 判断同一线程的依据就是**主题**：把 Re: / 回复: / Fwd: / 转发: 这类前缀
 * 反复剥掉之后如果一样，就算同一条线索。
 *
 * 为什么按主题而不是按 Message-ID / References：
 *   · 手上这批邮件来自各种客户端，`References` 经常缺失或断裂；
 *   · 用户说的就是"同样主题的这种邮件"，按主题最符合直觉，也不会漏。
 * 代价是「不同的人碰巧用同一个主题」会被并到一起 —— 这种情况极少，
 * 而且展开之后一眼能看出来。
 */

/** 需要反复剥掉的主题前缀（含中英文与全角冒号） */
const PREFIX_RE =
  /^\s*(?:re|fw|fwd|sv|答复|回复|回覆|转发|转寄|转)\s*(?:\[\d+\])?\s*[:：]\s*/i

/**
 * 主题 → 线程键。剥掉前缀、压缩空白、转小写。
 * 剥多轮是因为真实邮件里常见 `Re: 回复: Re: xxx` 这种层层叠加。
 */
export function threadKey(subject: string): string {
  let s = (subject ?? '').trim()
  // 最多剥 10 轮，防御畸形主题造成死循环
  for (let i = 0; i < 10; i++) {
    const next = s.replace(PREFIX_RE, '')
    if (next === s) break
    s = next
  }
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

export interface Threadable {
  id: number
  subject: string
}

export interface ThreadGroup<T extends Threadable> {
  /** 线程键 */
  key: string
  /** 代表这组的邮件（列表里显示这一行） */
  head: T
  /** 组内其它邮件（按传入顺序，已排除 head） */
  rest: T[]
}

/**
 * 按线程分组。
 *
 * 保持传入顺序：`items` 是已经排好序的列表，所以 head 就是该线程里
 * 排序最靠前的那封（按时间倒序时就是最新的一封）。组的顺序也按 head 的
 * 位置，不会打乱用户当前的排序。
 *
 * @param enabled false 时原样一对一返回（等于不折叠）
 */
export function groupByThread<T extends Threadable>(
  items: readonly T[],
  enabled: boolean
): ThreadGroup<T>[] {
  if (!enabled) {
    return items.map((m) => ({ key: threadKey(m.subject), head: m, rest: [] }))
  }
  const order: string[] = []
  const map = new Map<string, ThreadGroup<T>>()
  for (const m of items) {
    const key = threadKey(m.subject)
    const exists = map.get(key)
    if (exists) {
      exists.rest.push(m)
      continue
    }
    const group: ThreadGroup<T> = { key, head: m, rest: [] }
    map.set(key, group)
    order.push(key)
  }
  return order.map((k) => map.get(k)!)
}
