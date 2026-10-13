/**
 * mailto 请求的投递队列。
 *
 * 为什么需要「队列」而不只是「发一条 IPC 消息」─────────────────────
 * 主进程把 mailto 交给渲染进程时，渲染进程可能**还没准备好**：
 *   · 窗口刚建好，页面还在加载；
 *   · 页面加载完了，但 React 的 effect 还没跑起来（订阅还没建立）。
 * 这两种情况下直接 `webContents.send` 会石沉大海，用户看到的现象就是
 * 「点了邮件链接，程序起来了但没打开写信窗口」。
 *
 * 所以：主进程把最后一条请求**留在队列里**，渲染进程挂载后主动拉一次
 * （mailto:take），处理完再 ack 掉。推送和拉取可能都送到同一条，
 * 用自增 id 去重即可。
 *
 * 放在单独模块里是因为请求由 index.ts 产生、由 ipc.ts 提供拉取接口。
 */

import type { MailtoDelivery, MailtoRequest } from '@shared/types'

export type { MailtoDelivery }

let seq = 0
let pending: MailtoDelivery | null = null

/** 记下一条待投递请求并返回它（含用于去重的 id） */
export function enqueueMailto(request: MailtoRequest): MailtoDelivery {
  seq += 1
  pending = { id: seq, request }
  return pending
}

/** 渲染进程主动拉取；返回 null 表示当前没有待处理的请求 */
export function takePendingMailto(): MailtoDelivery | null {
  return pending
}

/** 渲染进程处理完确认；只清掉不大于该 id 的请求，避免误清更新的那条 */
export function ackMailto(id: number): void {
  if (pending && pending.id <= id) pending = null
}
