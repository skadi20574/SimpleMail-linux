/**
 * 同步执行器。
 *
 * 从 ipc.ts 里抽出来，是因为除了「用户点同步」之外，**自动定时同步**也要用同一套
 * 逻辑（去重、进度广播、结束广播）。留在 ipc.ts 里的话，定时器要么绕一圈发假
 * IPC，要么复制一遍逻辑，两边迟早不一致。
 */

import { BrowserWindow } from 'electron'
import { loadSettings } from './settings'
import { syncAccount } from './mail/imap'
import { syncPop3Account } from './mail/pop3'
import { isAborted } from './mail/sync-control'
import * as repo from './db/repo'
import type { Account, SyncProgress } from '@shared/types'
import { diag } from './diagnostics'

/** 每个账户同一时刻只允许一个同步任务 */
const syncRunning = new Map<number, Promise<void>>()
let lastProgress: SyncProgress | null = null

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function isSyncRunning(accountId: number): boolean {
  return syncRunning.has(accountId)
}

export function isAnySyncRunning(): boolean {
  return syncRunning.size > 0
}

export function lastSyncProgress(): SyncProgress | null {
  return lastProgress
}

/** 启动一个账户的同步；已经在该账户同步时直接返回 false */
export function startSync(account: Account): boolean {
  if (syncRunning.has(account.id)) return false

  const settings = loadSettings()
  const onProgress = (p: SyncProgress): void => {
    lastProgress = p
    broadcast('sync:progress', p)
  }

  const task = (
    account.protocol === 'pop3'
      ? syncPop3Account(account, {
          // POP3 是「下载即完整」的模式，单次上限沿用同步批量设置，
          // 剩余部分下次同步继续拉，进度条不会长时间不动
          maxMessages: Math.max(settings.syncBatch, 200),
          onProgress
        })
      : syncAccount(account, {
          headerBatch: settings.syncBatch,
          bodyBatch: 200,
          onProgress
        })
  )
    .catch(() => {
      /* 错误已经通过 progress 事件上报 */
    })
    .finally(() => {
      syncRunning.delete(account.id)
      broadcast('sync:finished', { accountId: account.id, aborted: isAborted(account.id) })
    })

  syncRunning.set(account.id, task)
  return true
}

/** 能不能对某个账户发起同步：在线账户 + 开了同步 + 填了密码 */
export function canSync(account: Account): boolean {
  return !account.isLocal && account.syncEnabled && Boolean(account.password)
}

export interface SyncAllResult {
  /** 实际发起同步的账户数 */
  started: number
  /** 在线但没填密码、被跳过的账户数 */
  skipped: number
}

/** 对所有「可以同步」的账户发起同步（手动点同步、启动时、定时都用它） */
export function syncAllAccounts(reason: string): SyncAllResult {
  const accounts = repo.listAccounts()
  const eligible = accounts.filter(canSync)
  const online = accounts.filter((a) => !a.isLocal && a.syncEnabled)

  let started = 0
  for (const a of eligible) {
    if (startSync(a)) started++
  }
  if (started > 0) {
    diag(`[同步] 发起 ${started} 个账户的同步（${reason}）`)
  }
  return { started, skipped: online.length - eligible.length }
}
