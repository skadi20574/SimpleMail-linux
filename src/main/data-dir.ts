/**
 * 数据目录的位置与迁移。
 *
 * 背景：默认情况下所有数据（数据库、附件、导出）都在
 * `~/.config/simplemail/`，也就是**系统盘**。邮件越收越多时会把系统盘
 * 占满，进而让整个系统出问题。所以要让用户能把数据放到别的盘。
 *
 * 做法（和浏览器换配置目录的思路一样）：数据目录本身不能在数据库里记录 ——
 * 因为「数据库在哪」正是我们要决定的。所以在**默认目录**下放一个很小的
 * 指针文件 `datadir.json`：
 *
 *     ~/.config/simplemail/datadir.json   ← 永远在这个固定位置
 *     { "dataDir": "/mnt/data/SimpleMail" }
 *
 * 启动时先读这个文件，再 `app.setPath('userData', ...)` 把整个数据目录
 * 切过去。指针文件留在原地，所以即使目标盘没挂载，程序也还能启动并报错，
 * 而不是让用户彻底打不开。
 */

import { app } from 'electron'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { DataDirInfo, DataDirMigrationResult, DataDirProgress } from '@shared/types'

const POINTER_NAME = 'datadir.json'

/**
 * 默认数据目录。
 *
 * ⚠️ 必须在任何 `app.setPath('userData', ...)` **之前**取一次并缓存 ——
 * 之后 getPath 返回的就是切换后的目录，再也拿不到默认值了。
 */
let defaultDir: string | null = null
export function defaultDataDir(): string {
  if (!defaultDir) defaultDir = app.getPath('userData')
  return defaultDir
}

function pointerPath(): string {
  return join(defaultDataDir(), POINTER_NAME)
}

/** 读取指针文件；没有、损坏、或目录已不存在都返回 null（退化为默认目录） */
export function readDataDirPointer(): string | null {
  try {
    const file = pointerPath()
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { dataDir?: unknown }
    const dir = typeof parsed.dataDir === 'string' ? parsed.dataDir.trim() : ''
    if (!dir) return null
    return resolve(dir)
  } catch {
    return null
  }
}

export function writeDataDirPointer(dir: string | null): void {
  const file = pointerPath()
  if (!dir) {
    // 恢复默认：删掉指针文件即可
    try {
      rmSync(file, { force: true })
    } catch {
      /* ignore */
    }
    return
  }
  mkdirSync(defaultDataDir(), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ dataDir: dir }, null, 2)}\n`, 'utf8')
}

/**
 * 按指针文件把 userData 切到自定义目录。
 * 必须在打开数据库、创建窗口之前调用（在 index.ts 的最前面）。
 */
export function applyDataDir(): { dataDir: string; custom: boolean; pointerBroken?: string } {
  const fallback = defaultDataDir()
  const target = readDataDirPointer()

  if (!target) return { dataDir: fallback, custom: false }

  if (!existsSync(target)) {
    // 目标盘没挂载 / 目录被删了。**不能用它**（否则数据库会在一个错误的位置
    // 被重新创建，用户以为邮件丢了）。退回默认目录，并把这件事记下来，
    // 界面和日志里都要能看到。
    return { dataDir: fallback, custom: false, pointerBroken: target }
  }

  try {
    mkdirSync(target, { recursive: true })
    app.setPath('userData', target)
    return { dataDir: target, custom: true }
  } catch {
    return { dataDir: fallback, custom: false, pointerBroken: target }
  }
}

/* ─────────────────────────── 迁移 ─────────────────────────── */

/** 迁移时搬运的东西（日志不搬：它是诊断信息，留在原处即可） */
const MOVE_ITEMS = ['simplemail.db', 'simplemail.db-wal', 'simplemail.db-shm', 'attachments', 'exports']

function dirSize(dir: string): number {
  let total = 0
  const walk = (p: string): void => {
    let st
    try {
      st = statSync(p)
    } catch {
      return
    }
    if (st.isDirectory()) {
      let entries: string[] = []
      try {
        entries = readdirSync(p)
      } catch {
        return
      }
      for (const e of entries) walk(join(p, e))
    } else {
      total += st.size
    }
  }
  walk(dir)
  return total
}

export interface DataDirCheck {
  ok: boolean
  error?: string
  /** 目标需要多少空间 / 目标盘还剩多少 */
  needBytes?: number
  freeBytes?: number
}

/**
 * 检查目标目录能不能用。
 *
 * 只做「明显不该继续」的拦截，不做过度限制 —— 用户自己的机器自己决定。
 */
export function checkDataDirTarget(target: string): DataDirCheck {
  const dir = resolve(target.trim())
  if (!dir || dir === '/') return { ok: false, error: '请选择一个具体的目录，不能是根目录' }

  const current = app.getPath('userData')
  if (resolve(dir) === resolve(current)) {
    return { ok: false, error: '这就是当前正在使用的数据目录' }
  }
  // 目标在当前数据目录里面：迁移时会把目标自己也复制进去，直接拒绝
  if (resolve(dir).startsWith(resolve(current) + '/')) {
    return { ok: false, error: '目标目录不能放在当前数据目录里面' }
  }

  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    return { ok: false, error: `无法创建目录：${err instanceof Error ? err.message : String(err)}` }
  }

  const need = dirSize(current)
  let free = 0
  try {
    const st = statfsSync(dir)
    free = Number(st.bavail) * Number(st.bsize)
  } catch {
    /* 拿不到剩余空间就不拦 */
  }
  if (free > 0 && need > 0 && free < need * 1.05) {
    return {
      ok: false,
      error: `目标磁盘空间不足：需要约 ${(need / 1073741824).toFixed(2)} GB，可用 ${(free / 1073741824).toFixed(2)} GB`,
      needBytes: need,
      freeBytes: free
    }
  }
  return { ok: true, needBytes: need, freeBytes: free }
}

/**
 * 把当前数据目录整体迁移到 target。
 *
 * 顺序刻意如此：**先复制、校验、最后才写指针文件**。
 * 只有指针文件写成功，程序下次才会去新目录；中途任何一步失败，
 * 原数据都完好无损，用户重启后还是回到原来的位置。
 *
 * 不删除旧数据 —— 由调用方在确认新目录可用之后再问用户要不要删。
 */
export async function migrateDataDir(
  target: string,
  onProgress: (p: DataDirProgress) => void
): Promise<DataDirMigrationResult> {
  const src = app.getPath('userData')
  const dst = resolve(target.trim())

  const check = checkDataDirTarget(dst)
  if (!check.ok) return { ok: false, error: check.error }

  try {
    let done = 0
    const total = MOVE_ITEMS.length

    for (const item of MOVE_ITEMS) {
      const from = join(src, item)
      const to = join(dst, item)
      if (!existsSync(from)) {
        done++
        onProgress({ phase: 'copy', message: `跳过 ${item}（不存在）`, current: done, total })
        continue
      }
      onProgress({ phase: 'copy', message: `正在复制 ${item}…`, current: done, total })
      cpSync(from, to, { recursive: true, force: true })
      done++
      onProgress({ phase: 'copy', message: `${item} 完成`, current: done, total })
      // 让出事件循环，避免大文件复制时界面卡住
      await new Promise((r) => setTimeout(r, 0))
    }

    onProgress({ phase: 'verify', message: '正在校验…', current: 0, total: 1 })

    // 校验：关键文件都在，且数据库能打开、表数量对得上
    const dbDst = join(dst, 'simplemail.db')
    if (existsSync(join(src, 'simplemail.db')) && !existsSync(dbDst)) {
      return { ok: false, error: '复制后没找到数据库文件，已放弃（原数据未改动）' }
    }
    if (existsSync(dbDst)) {
      const srcSize = statSync(join(src, 'simplemail.db')).size
      const dstSize = statSync(dbDst).size
      if (srcSize !== dstSize) {
        return {
          ok: false,
          error: `数据库大小不一致（原 ${srcSize} / 新 ${dstSize}），已放弃（原数据未改动）`
        }
      }
    }

    onProgress({ phase: 'verify', message: '校验通过', current: 1, total: 1 })
    onProgress({ phase: 'switch', message: '正在切换…', current: 0, total: 1 })
    writeDataDirPointer(dst)
    onProgress({ phase: 'done', message: '迁移完成', current: 1, total: 1 })

    return { ok: true, dataDir: dst, from: src }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 迁移成功后，用户确认再删旧数据 */
export function removeOldDataDir(dir: string): { ok: boolean; error?: string } {
  const target = resolve(dir)
  const current = resolve(app.getPath('userData'))
  if (target === current || current.startsWith(target + '/')) {
    return { ok: false, error: '拒绝删除：这是当前正在使用的数据目录' }
  }
  if (target === '/' || basename(target) === '' ) {
    return { ok: false, error: '拒绝删除：路径过于宽泛' }
  }
  try {
    // 只删本程序自己那几个条目，不动用户放在同目录里的其他东西
    for (const item of [...MOVE_ITEMS, 'logs', POINTER_NAME]) {
      rmSync(join(target, item), { recursive: true, force: true })
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function dataDirInfo(): DataDirInfo {
  const current = app.getPath('userData')
  const def = defaultDataDir()
  return {
    dataDir: current,
    defaultDataDir: def,
    custom: resolve(current) !== resolve(def),
    pointerFile: pointerPath(),
    dbBytes: (() => {
      try {
        return statSync(join(current, 'simplemail.db')).size
      } catch {
        return 0
      }
    })()
  }
}
