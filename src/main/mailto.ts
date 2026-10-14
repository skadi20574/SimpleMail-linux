/**
 * 把 SimpleMail 注册成系统的默认「邮件程序」（x-scheme-handler/mailto）。
 *
 * 背景：网页/文档里的 `mailto:` 链接由 desktop 文件里的
 * `MimeType=x-scheme-handler/mailto;` 声明 + 用户选择的默认程序决定。
 * 系统当前默认是谁，可以 `xdg-mime query default x-scheme-handler/mailto` 查。
 *
 * 为什么不安装时就自动抢过来：默认程序是**用户的选择**。安装包擅自改掉
 * 用户已有的邮件客户端（比如 Foxmail、Thunderbird）是不礼貌的，而且用户
 * 往往在装完很久之后才发现「怎么点邮件链接跳到别的地方去了」。
 * 所以这里只提供「查询当前状态」和「用户主动点按钮才切换」两条路径。
 */

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  statSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type {
  InstallKind,
  MailtoStatus,
  MailtoSetResult,
  ResolvedAttachment
} from '@shared/types'

export type { InstallKind, MailtoStatus, MailtoSetResult }

/** 某个 argv 条目是不是真实存在的普通文件（给「右键 → 邮件发送」识别裸文件参数用） */
export function isExistingFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * 校验 mailto 里的附件路径。
 *
 * 分开返回「能用的」和「找不到的」：找不到的必须让用户看见，
 * 否则会出现「我以为附上了、其实没附」这种最糟糕的失败方式。
 */
export function resolveMailtoAttachments(paths: readonly string[]): {
  files: ResolvedAttachment[]
  missing: string[]
} {
  const files: ResolvedAttachment[] = []
  const missing: string[] = []
  const seen = new Set<string>()

  for (const raw of paths) {
    const path = raw.trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    try {
      const st = statSync(path)
      if (!st.isFile()) {
        missing.push(path)
        continue
      }
      files.push({ path, filename: basename(path) || 'attachment', size: st.size })
    } catch {
      missing.push(path)
    }
  }
  return { files, missing }
}

/** 应用在系统里的 desktop 文件 id —— 必须与 electron-builder 生成的文件名一致 */
export const DESKTOP_ID = 'simplemail.desktop'

/**
 * deb 安装时 desktop 文件的落点（只读，由包管理器维护）。
 *
 * `SIMPLEMAIL_DESKTOP_DIR` 是给测试用的：本机装了 SimpleMail 之后
 * /usr/share/applications 下总是有那个文件，就永远走不到「自己写一份」的
 * 分支。留一个可覆盖的入口，才能在不卸载系统包的前提下把两条路都验一遍。
 */
function systemDesktopPath(): string {
  const dir = process.env.SIMPLEMAIL_DESKTOP_DIR || '/usr/share/applications'
  return join(dir, DESKTOP_ID)
}

/**
 * 免安装形态（AppImage / tar.gz）时写到这里。
 *
 * 必须尊重 XDG_DATA_HOME：用户把它指到别处时（比如放到另一个盘），
 * 桌面环境只会去 `$XDG_DATA_HOME/applications` 里找 —— 写死在
 * `~/.local/share/applications` 的话文件根本不会被发现。
 */
export function userDesktopPath(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(dataHome, 'applications', DESKTOP_ID)
}

/** 用哪条命令去问「当前默认是谁」 */
function xdgMime(): string | null {
  for (const bin of ['/usr/bin/xdg-mime', '/bin/xdg-mime']) {
    if (existsSync(bin)) return bin
  }
  try {
    execFileSync('sh', ['-c', 'command -v xdg-mime'], { stdio: 'ignore' })
    return 'xdg-mime'
  } catch {
    return null
  }
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000
    })
    return { ok: true, out: (out ?? '').trim() }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const detail = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message || '执行失败'
    return { ok: false, out: detail }
  }
}

/** 当前系统的默认 mailto 处理程序（例如 `firefox.desktop`），没有则为空串 */
export function currentMailtoHandler(): string {
  const bin = xdgMime()
  if (!bin) return ''
  const res = run(bin, ['query', 'default', 'x-scheme-handler/mailto'])
  return res.ok ? res.out : ''
}

export function installKind(): InstallKind {
  if (process.env.APPIMAGE) return 'appimage'
  if (process.execPath.startsWith('/opt/SimpleMail')) return 'deb'
  if (process.execPath.includes('.bin')) return 'portable'
  return 'unknown'
}

/**
 * 启动 SimpleMail 的命令。
 *
 * ⚠️ 一定要指向**启动器**（simplemail）而不是 simplemail.bin：
 * 启动器负责在必要时补 --no-sandbox，直接用 .bin 在没有 setuid 的形态下
 * 会立刻 abort（详见 src/main/index.ts 顶部）。AppImage 则用它的绝对路径。
 */
export function launchCommand(): string {
  if (process.env.APPIMAGE) return process.env.APPIMAGE
  const dir = join(process.execPath, '..')
  const launcher = join(dir, 'simplemail')
  if (existsSync(launcher)) return launcher
  return process.execPath
}

export function desktopFileBody(): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=SimpleMail',
    'GenericName=Mail Client',
    'GenericName[zh_CN]=邮件客户端',
    'Comment=Local-first desktop email client',
    'Comment[zh_CN]=本地优先的邮件客户端',
    // %U 必须留着：系统就是通过它把 mailto: 链接作为参数传给我们的
    `Exec=${launchCommand()} %U`,
    'Terminal=false',
    'Categories=Network;Email;',
    // 这一行才是「能被选为邮件程序」的关键
    'MimeType=x-scheme-handler/mailto;',
    'StartupWMClass=SimpleMail',
    'NoDisplay=false',
    ''
  ].join('\n')
}

export function mailtoStatus(): MailtoStatus {
  const kind = installKind()
  const systemExists = existsSync(systemDesktopPath())
  const desktopFile = systemExists ? systemDesktopPath() : userDesktopPath()
  const exists = existsSync(desktopFile)
  const defaultHandler = currentMailtoHandler()
  const xdg = xdgMime()

  let declares = false
  if (exists) {
    try {
      declares = /x-scheme-handler\/mailto/i.test(readFileSync(desktopFile, 'utf8'))
    } catch {
      declares = false
    }
  }

  return {
    installKind: kind,
    desktopFile,
    systemWide: systemExists,
    desktopFileExists: exists,
    declaresMailto: declares,
    currentDefault: defaultHandler,
    isDefault: defaultHandler.toLowerCase() === DESKTOP_ID,
    xdgAvailable: Boolean(xdg),
    canSetAutomatically: Boolean(xdg),
    manualCommand: `xdg-mime default ${DESKTOP_ID} x-scheme-handler/mailto`,
    userDesktopFile: userDesktopPath()
  }
}

/**
 * 把自己设为默认邮件程序。
 *
 * 免安装形态（AppImage / tar.gz）系统里本来没有我们的 desktop 文件，
 * 所以先往 `~/.local/share/applications/` 写一个 —— 不需要 root，
 * 也只影响当前用户。
 */
export function setMailtoDefault(): MailtoSetResult {
  const before = mailtoStatus()
  const xdg = xdgMime()
  if (!xdg) {
    return {
      ok: false,
      message: '系统里没有 xdg-mime（通常属于 xdg-utils 包），无法自动设置。请手动执行下方命令。',
      status: before
    }
  }

  // 系统级 desktop 文件不存在（免安装形态）→ 写一份到用户目录
  if (!existsSync(systemDesktopPath())) {
    const target = userDesktopPath()
    try {
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, desktopFileBody(), 'utf8')
      chmodSync(target, 0o644)
    } catch (err) {
      const e = err as { message?: string }
      return {
        ok: false,
        message: `写入 ${target} 失败：${e.message ?? err}`,
        status: mailtoStatus()
      }
    }
  }

  // ⚠️ xdg-mime 不会检查目标 desktop 文件是否存在 —— 它只是往 mimeapps.list
  // 里写一行。所以文件缺失时它照样「成功」，但系统实际打开不了任何东西。
  // 这里必须自己确认那个文件真的存在、且声明了 mailto 能力。
  const target = existsSync(systemDesktopPath()) ? systemDesktopPath() : userDesktopPath()
  if (!existsSync(target)) {
    return {
      ok: false,
      message: `找不到桌面项文件 ${target}，即使设置成功系统也无法打开邮件链接。`,
      status: mailtoStatus()
    }
  }
  if (!/x-scheme-handler\/mailto/i.test(readFileSync(target, 'utf8'))) {
    return {
      ok: false,
      message:
        `桌面项 ${target} 没有声明 x-scheme-handler/mailto，` +
        '多半是旧版本安装留下的文件，重装当前版本即可。',
      status: mailtoStatus()
    }
  }

  const set = run(xdg, ['default', DESKTOP_ID, 'x-scheme-handler/mailto'])
  if (!set.ok) {
    return { ok: false, message: `xdg-mime 执行失败：${set.out}`, status: mailtoStatus() }
  }

  // 让桌面环境重新扫描一遍（不是所有发行版都装了 update-desktop-database）
  const userApps = join(target, '..')
  if (existsSync(userApps)) {
    try {
      execFileSync('update-desktop-database', [userApps], { stdio: 'ignore', timeout: 10_000 })
    } catch {
      /* 没装就算了，xdg-mime 本身已经写好 mimeapps.list */
    }
  }

  const after = mailtoStatus()
  return {
    ok: after.isDefault,
    message: after.isDefault
      ? '已设为默认邮件程序。以后点网页里的邮件链接会直接打开 SimpleMail 写信窗口。'
      : `设置后默认程序仍是「${after.currentDefault || '未知'}」，可能被其它配置覆盖了。`,
    status: after
  }
}
