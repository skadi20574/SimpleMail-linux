/**
 * 列表导航：删除之后该选中哪一封。
 *
 * 抽到这个文件里是为了能单测 —— 它有不少边界情况（删最后一封、多选删除、
 * 锚点不在列表里、全删光），而这些都只在真按键之后才会走到，
 * 放在界面组件里就只能靠手工点。
 */

/** 只要求有 id 即可，方便主进程/渲染进程共用，也方便测试里造数据 */
export interface HasId {
  id: number
}

/**
 * 删除若干封之后，应当选中哪一封。
 *
 * 规则：以「当前正在看的那封」（anchorId）为基准，**往后**找第一封没被删的；
 * 后面没有了就往前找。往前后都合理，往后更符合直觉 —— 删除后列表往上收，
 * 原来位置显示的就是下一封，视线不用跳。
 *
 * @param items      当前列表（顺序即显示顺序）
 * @param deletedIds 本次删掉的 id
 * @param anchorId   当前正在看的邮件 id，可为 null
 * @returns 应当选中的邮件；列表被删空时返回 null
 */
export function nextAfterDelete<T extends HasId>(
  items: readonly T[],
  deletedIds: readonly number[],
  anchorId: number | null
): T | null {
  if (!items.length) return null
  const removed = new Set(deletedIds)

  // 锚点找不到（比如它已经被删了、或不在当前筛选结果里）时从列表头部找起
  const anchorIdx = anchorId === null ? -1 : items.findIndex((m) => m.id === anchorId)
  const from = Math.max(anchorIdx, 0)

  for (let i = from; i < items.length; i++) {
    if (!removed.has(items[i].id)) return items[i]
  }
  for (let i = Math.min(from, items.length - 1); i >= 0; i--) {
    if (!removed.has(items[i].id)) return items[i]
  }
  return null
}
