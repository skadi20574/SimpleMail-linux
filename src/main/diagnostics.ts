/**
 * 启动与崩溃诊断。
 *
 * 图形程序出问题时往往没有终端输出：进程直接消失、或者窗口不出来，
 * 而用户侧看不到任何原因。把「启动时发生了什么」和「为什么退出」落到
 * 文件里，排查时才有依据。记录项刻意保持精简：版本、参数、单实例锁结果、
 * 未捕获异常、子进程消失 —— 多了反而没人看。
 *
 * 日志位置：<userData>/logs/startup.log
 * 大小上限 256KB，超过就截断重来 —— 诊断日志不该把用户的磁盘写满。
 */

import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 256 * 1024

let logPath: string | null = null
let installed = false

function resolveLogPath(): string | null {
  if (logPath) return logPath
  try {
    const dir = join(app.getPath('userData'), 'logs')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    logPath = join(dir, 'startup.log')
    return logPath
  } catch {
    return null
  }
}

/**
 * 写一行诊断日志。
 * 任何失败都吞掉：诊断本身绝不能成为新的崩溃源。
 */
export function diag(message: string): void {
  try {
    const file = resolveLogPath()
    if (!file) return
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      writeFileSync(file, '', 'utf8')
    }
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    /* 忽略 */
  }
}

/** 把对象里的敏感字段去掉再打印（这里其实没有密钥，但保持习惯） */
function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}\n${err.stack ?? ''}`
  return String(err)
}

/**
 * 记录一次启动。pid / 版本 / 参数 / 单实例锁结果 / 可执行文件路径
 * 是排查启动异常最需要的几项。
 */
export function logStartup(extra: Record<string, unknown> = {}): void {
  diag(
    `[启动] pid=${process.pid} version=${app.getVersion()} ` +
      `execPath=${process.execPath} argv=${JSON.stringify(process.argv.slice(1))} ` +
      `APPIMAGE=${process.env.APPIMAGE ?? '无'} userData=${app.getPath('userData')} ` +
      Object.entries(extra)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ')
  )
}

/**
 * 装上崩溃与退出相关的处理器。
 *
 * 重点是把**未捕获异常**记下来 —— 一个在模块加载期抛出的异常会让进程
 * 立刻消失，而终端里往往什么都没有。
 */
export function installDiagnostics(): void {
  if (installed) return
  installed = true

  process.on('uncaughtException', (err) => {
    diag(`[未捕获异常] ${describeError(err)}`)
    // 不退出：多数情况下（尤其是渲染/IO 层）应用还能继续用，
    // 直接崩掉对用户更糟。真正的致命错误会由 Electron 自己收尾。
  })

  process.on('unhandledRejection', (reason) => {
    diag(`[未处理的 Promise 拒绝] ${describeError(reason)}`)
  })

  app.on('render-process-gone', (_e, _wc, details) => {
    diag(`[渲染进程消失] reason=${details.reason} exitCode=${details.exitCode}`)
  })

  app.on('child-process-gone', (_e, details) => {
    diag(`[子进程消失] type=${details.type} reason=${details.reason}`)
  })

  app.on('before-quit', () => {
    diag('[退出] before-quit')
  })

  app.on('will-quit', () => {
    diag('[退出] will-quit')
  })
}
