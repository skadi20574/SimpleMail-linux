/**
 * 同步任务的中断控制。
 *
 * IMAP 与 POP3 都要用，所以集中在这里，避免两套 registry 各自为政
 * （之前界面上的「取消」按钮就是因为两处状态不互通而失效过）。
 */

interface SyncFlag {
  aborted: boolean
}

const flags = new Map<number, SyncFlag>()

/** 注册一个账户的同步任务，返回它的中断标志 */
export function registerSync(accountId: number): SyncFlag {
  const flag: SyncFlag = { aborted: false }
  flags.set(accountId, flag)
  return flag
}

export function clearSync(accountId: number): void {
  flags.delete(accountId)
}

export function abortSync(accountId: number): void {
  const flag = flags.get(accountId)
  if (flag) flag.aborted = true
}

export function isAborted(accountId: number): boolean {
  return flags.get(accountId)?.aborted === true
}

export function isRunning(accountId: number): boolean {
  return flags.has(accountId)
}

export function runningAccountIds(): number[] {
  return [...flags.keys()]
}
