/**
 * 自动定时收取新邮件。
 *
 * 放在**主进程**而不是界面里：定时收信是"应用级"行为，不该依赖某个窗口
 * 还开着、或界面没被重新加载。放主进程还有一个好处 —— 关掉窗口最小化到后台
 * 时照样按点收信（本程序关掉所有窗口就退出，所以实际差别不大，
 * 但语义上这里才是对的）。
 *
 * 用「跑完再排下一次」而不是 setInterval：
 * 网络慢的时候一次同步可能超过间隔，setInterval 会叠加出多个并发同步。
 * 链式 setTimeout 天然串行。
 */

import { loadSettings } from './settings'
import { isAnySyncRunning, syncAllAccounts } from './sync-runner'
import { diag } from './diagnostics'

let timer: NodeJS.Timeout | null = null
/** 下一次预计执行时间（毫秒时间戳），界面上显示"下次自动收取"用 */
let nextRunAt: number | null = null

export interface AutoSyncStatus {
  enabled: boolean
  intervalMinutes: number
  nextRunAt: number | null
  /** 当前是否正在自动同步中（用于界面提示） */
  running: boolean
}

function clearTimer(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  nextRunAt = null
}

function schedule(delayMs: number): void {
  clearTimer()
  const wait = Math.max(5_000, delayMs)
  nextRunAt = Date.now() + wait
  timer = setTimeout(() => {
    tick()
  }, wait)
  // 定时器不该拖住进程退出
  timer.unref?.()
}

function tick(): void {
  timer = null
  const settings = loadSettings()

  if (!settings.autoSyncEnabled) {
    nextRunAt = null
    return
  }

  // 上一次还没跑完就跳过这一轮，等它结束后的那次排程再收 —— 不叠加
  if (isAnySyncRunning()) {
    diag('[自动同步] 上一轮还在进行，跳过本次')
  } else {
    const r = syncAllAccounts('定时自动收取')
    if (r.started === 0) {
      // 没有可同步的账户（没配密码 / 全部停用）不必反复记日志
    }
  }

  // 收完再排下一次
  schedule(loadSettings().syncIntervalMinutes * 60_000)
}

/**
 * 按当前设置重新排程。
 *
 * 要在这几个时机调用：启动、设置改变、手动同步之后（把计时重新归零，
 * 免得用户刚点完手动同步，两秒后又自动收一次）。
 */
export function rescheduleAutoSync(): AutoSyncStatus {
  clearTimer()
  const settings = loadSettings()

  if (!settings.autoSyncEnabled) {
    diag('[自动同步] 已关闭')
    return autoSyncStatus()
  }

  const minutes = Math.max(1, Math.round(settings.syncIntervalMinutes))
  schedule(minutes * 60_000)
  diag(`[自动同步] 已启用，每 ${minutes} 分钟一次`)
  return autoSyncStatus()
}

/** 手动同步之后调用：把定时器重新计时，不要紧接着又自动收一次 */
export function noteManualSync(): void {
  const settings = loadSettings()
  if (!settings.autoSyncEnabled) return
  rescheduleAutoSync()
}

export function stopAutoSync(): void {
  clearTimer()
}

export function autoSyncStatus(): AutoSyncStatus {
  const settings = loadSettings()
  return {
    enabled: settings.autoSyncEnabled,
    intervalMinutes: settings.syncIntervalMinutes,
    nextRunAt,
    running: isAnySyncRunning()
  }
}
