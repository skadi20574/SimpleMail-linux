/**
 * 主进程入口。
 *
 * 关于渲染进程沙箱（踩过的坑，写在这里免得以后重踩）─────────────────
 * Electron 的渲染进程沙箱依赖两种机制之一：
 *   (a) SUID sandbox：chrome-sandbox 属于 root 且带 setuid 位；
 *   (b) namespace sandbox：内核允许非特权用户命名空间（userns）。
 *
 * 实测结论（Ubuntu 26.04；24.04 同样）：
 *   · .deb 安装 → 安装后脚本把 chrome-sandbox 设为 setuid root，(a) 可用，沙箱真正开启；
 *   · AppImage  → FUSE 只读挂载，永远不可能 setuid，(a) 不可用；
 *   · tar.gz 解压 → 文件属于普通用户，(a) 同样不可用；
 *   · 而 Ubuntu 23.10 起用 AppArmor 限制了非特权 userns，所以 (b) 也不可用。
 *     （对应报错分别来自 setuid_sandbox_host.cc:166 与 zygote_host_impl_linux.cc:132）
 *
 * 关键点：这个判断**没法在 JS 里做**。Chromium 在主脚本执行之前就完成了沙箱检查，
 * 主脚本里再 app.commandLine.appendSwitch('no-sandbox') 已经太晚，进程会直接 abort。
 * 所以非 deb 形态的 --no-sandbox **必须写在命令行上**，由构建期生成的启动器负责：
 *   · 见 build/linux/after-pack.cjs，它按 chrome-sandbox 的实际权限自适应决定。
 * deb 安装则不需要任何额外参数，沙箱是真正开启的。
 *
 * 安全影响评估：关掉沙箱后，渲染进程仍需突破 contextIsolation（已开启）、
 * 没有 nodeIntegration、远程 HTML 只在 sandbox="allow-same-origin"（禁用脚本）
 * 的 iframe 里渲染，风险面是受控的。
 */

import { app, dialog, protocol, net } from 'electron'
import type { BrowserWindow } from 'electron'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc, relaunchApp } from './ipc'
import { getDb, closeDb, setMeta, getMeta } from './db'
import * as repo from './db/repo'
import { appPaths } from './paths'
import { applyThemeToNative, loadSettings, saveSettings } from './settings'
import { ensureLocalArchiveAccount } from './foxmail/importer'
import { createMainWindow, getAllWindows, getMainWindow } from './windows'
import { parseMailtoFromArgv, type MailtoRequest } from '@shared/mailto'
import { enqueueMailto } from './mailto-queue'
import { isExistingFile, resolveMailtoAttachments } from './mailto'

/**
 * 判断某个 argv 条目能不能当附件。
 *
 * 除了「是个真实文件」之外，还必须排除**程序自己的可执行文件**：
 * argv[0] 已经在 parseMailtoFromArgv 里跳过了，但保险起见再挡一道 ——
 * 打包后它是 simplemail.bin，真的是个存在的文件，一旦混进去，
 * 用户每次发邮件都会莫名其妙带上一个几十 MB 的附件。
 */
function isAttachmentCandidate(path: string): boolean {
  if (path === process.execPath) return false
  return isExistingFile(path)
}
import { diag, installDiagnostics, logStartup } from './diagnostics'
import { applyDataDir } from './data-dir'

// 自定义协议：邮件正文里的 cid: 内联图片通过它读取磁盘上的附件文件。
// 必须在 app ready 之前完成注册。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'smattach',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

// 让 node:sqlite 的实验性提示不要打扰用户
process.env.NODE_NO_WARNINGS = '1'

/** 处理 smattach://<附件 id>/ */
function registerAttachmentProtocol(): void {
  protocol.handle('smattach', async (request) => {
    try {
      const url = new URL(request.url)
      const id = Number(url.hostname || url.pathname.replace(/^\/+/, ''))
      if (!Number.isFinite(id) || id <= 0) {
        return new Response('bad request', { status: 400 })
      }
      const att = repo.getAttachment(id)
      if (!att?.storedPath) return new Response('not found', { status: 404 })
      return await net.fetch(pathToFileURL(att.storedPath).toString())
    } catch {
      return new Response('error', { status: 500 })
    }
  })
}

function bootstrapData(): void {
  const db = getDb()
  if (!getMeta(db, 'initialized')) {
    setMeta(db, 'initialized', new Date().toISOString())
  }
  // 每次启动都确保「本地存档」账户存在（用户可能把它删了）
  ensureLocalArchiveAccount()

  const settings = loadSettings()
  saveSettings(settings)
}

/* ─────────────────────────── 单实例 ───────────────────────────
 *
 * 注册成系统邮件程序之后，系统处理 `mailto:` 链接的方式是**再启动一个进程**，
 * 把链接当命令行参数传进来。如果不做单实例，用户每点一次链接就会：
 *   · 多出一个窗口，
 *   · 多一份数据库连接 —— 很快就有两个进程同时写同一个 SQLite 文件。
 *
 * 所以：第一个实例持有锁并负责处理参数；后启动的实例把参数转交给它后立刻退出。
 */

let initialMailtoHandled = false

/** 把主窗口叫到前台，没有就建一个 */
function focusMainWindow(): BrowserWindow {
  const win = getMainWindow() ?? createMainWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return win
}

/**
 * 把解析好的 mailto 请求交给渲染进程去打开写信窗口。
 *
 * ⚠️ 这里**不能**只发一条 IPC 就完事：窗口可能还在加载，或者页面加载完了
 * 但 React 的 effect 还没订阅 —— 那样消息会丢，用户看到的是「点了邮件链接
 * 却什么都没发生」。所以请求同时进队列（见 mailto-queue.ts），
 * 渲染进程挂载后会主动拉一次。
 */
function dispatchMailto(request: MailtoRequest): void {
  // 附件在这里校验：渲染进程拿不到 fs，「文件到底在不在」必须由主进程确认，
  // 并把找不到的路径一并带回界面 —— 默默丢掉附件是最糟的失败方式。
  const { files, missing } = resolveMailtoAttachments(request.attachments)
  const delivery = enqueueMailto(request, files, missing)

  // 窗口还没建就先不发，等它建好；队列里那份会被渲染进程挂载时拉走
  if (!getMainWindow()) return

  const win = focusMainWindow()
  const send = (): void => {
    if (!win.isDestroyed()) win.webContents.send('mailto:open', delivery)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
  else send()
}

/**
 * ⚠️ 顺序很重要：先按指针文件把数据目录切过去，**再**装诊断。
 * 否则诊断日志会写到默认目录，而真正出问题时需要看的是当前目录的日志。
 */
const dataDirState = applyDataDir()

installDiagnostics()

/**
 * 取单实例锁。
 *
 * ⚠️ 这里必须 try/catch：这是**模块加载期**的调用，一旦抛异常（例如
 * userData 所在的文件系统不支持它用的 socket/lock 机制），进程会立刻
 * 消失，而终端里什么都没有，极难排查。
 * 拿不到锁时退化成「允许多开」：多开不好，但比程序起不来强得多。
 */
let hasSingleInstanceLock = true
try {
  hasSingleInstanceLock = app.requestSingleInstanceLock()
} catch (err) {
  diag(`[单实例] requestSingleInstanceLock 抛异常，退化为允许多开：${String(err)}`)
  hasSingleInstanceLock = true
}

logStartup({
  singleInstanceLock: hasSingleInstanceLock,
  dataDir: dataDirState.dataDir,
  dataDirCustom: dataDirState.custom,
  ...(dataDirState.pointerBroken ? { dataDirPointerBroken: dataDirState.pointerBroken } : {})
})

if (!hasSingleInstanceLock) {
  // ⚠️ 这条分支里**不要**做任何初始化（数据库、IPC、窗口）——
  // 那正好会造成「两个进程同时操作同一个库」。
  diag('[退出] 未取到单实例锁（已有实例在运行），本次进程退出')
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const request = parseMailtoFromArgv(argv, isAttachmentCandidate)
    if (request) {
      dispatchMailto(request)
      return
    }
    // 不是 mailto 触发的（比如用户又点了一次图标）：只把已有窗口叫到前台
    if (getMainWindow()) focusMainWindow()
  })

  app.whenReady().then(() => {
    /**
     * 数据目录指向了一个不存在的位置（多半是那块盘没挂载）。
     *
     * ⚠️ 这里**不能**静默退回默认目录：那会在默认位置新建一个空数据库，
     * 用户看到的就是「邮件全没了」—— 比打不开严重得多。
     * 所以先明确告诉用户发生了什么，默认动作是退出。
     */
    if (dataDirState.pointerBroken) {
      const broken = dataDirState.pointerBroken
      const choice = dialog.showMessageBoxSync({
        type: 'warning',
        buttons: ['退出（推荐）', '仍然使用默认目录（会是一个空的邮件库）'],
        defaultId: 0,
        cancelId: 0,
        title: 'SimpleMail',
        message: '找不到你的数据目录',
        detail:
          `数据目录设置在这里：\n${broken}\n\n` +
          '但这个位置现在不存在 —— 常见原因是那块磁盘没有挂载。\n\n' +
          '你的邮件应该都还在那块盘上。请先挂载磁盘，再重新打开 SimpleMail。\n\n' +
          `（设置记录在 ${join(app.getPath('userData'), 'datadir.json')}）`
      })
      if (choice === 0) {
        app.quit()
        return
      }
      diag('[数据目录] 用户选择在目标盘缺失的情况下继续，使用默认目录')
    }

    try {
      appPaths()
      bootstrapData()
      // 主题模式交给 Electron：'system' 会跟随系统，深浅由用户选择时强制
      applyThemeToNative()
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[SimpleMail] 初始化失败:', err)
    }

    registerIpc()
    registerAttachmentProtocol()
    createMainWindow()

    // 首次启动就带着 mailto:（用户直接点了链接，当时没有实例在跑）
    if (!initialMailtoHandled) {
      initialMailtoHandled = true
      const initial = parseMailtoFromArgv(process.argv, isAttachmentCandidate)
      if (initial) dispatchMailto(initial)
    }
    app.on('activate', () => {
      if (getAllWindows().length === 0) createMainWindow()
    })
  })
}

/**
 * 开发辅助：SIMPLEMAIL_TEST_MIGRATE=<目标目录> 时，把数据迁移过去、打印结果后退出。
 *
 * 迁移要搬运 GB 级数据、还会写指针文件，是最容易出错的一步；
 * 用环境变量触发才能在自动化的端到端脚本里真的跑一遍，
 * 而不是只靠点界面。见 scripts/ 下的验证脚本。
 */
if (process.env.SIMPLEMAIL_TEST_MIGRATE) {
  app.whenReady().then(async () => {
    const { migrateDataDir, dataDirInfo } = await import('./data-dir')
    const target = String(process.env.SIMPLEMAIL_TEST_MIGRATE)
    console.log(`迁移前数据目录：${dataDirInfo().dataDir}`)
    const r = await migrateDataDir(target, (p) => {
      console.log(`  [${p.phase}] ${p.message} (${p.current}/${p.total})`)
    })
    console.log(`迁移结果：${r.ok ? '成功' : '失败'} ${r.ok ? `-> ${r.dataDir}` : `- ${r.error}`}`)
    console.log(`MIGRATE_RESULT ok=${r.ok} dataDir=${r.dataDir ?? ''} from=${r.from ?? ''}`)
    app.exit(r.ok ? 0 : 1)
  })
}

/**
 * 开发辅助：SIMPLEMAIL_TEST_RESTART=1 时，启动两秒后真的走一遍重启流程。
 * 用文件做一次性标记，避免重启后的新实例又触发一次（无限重启）。
 * 用来验证「清除数据后重启」这条路在打包产物里确实能起来。
 */
if (process.env.SIMPLEMAIL_TEST_RESTART) {
  const marker = join(app.getPath('temp'), 'simplemail-restart-test.marker')
  const trail = join(app.getPath('temp'), 'simplemail-restart-test.log')
  const note = (line: string): void => {
    try {
      appendFileSync(trail, `${new Date().toISOString()} pid=${process.pid} ${line}\n`)
    } catch {
      /* ignore */
    }
  }

  note(`启动 execPath=${process.execPath}`)
  if (!existsSync(marker)) {
    writeFileSync(marker, String(Date.now()))
    setTimeout(() => {
      note('触发重启')
      const r = relaunchApp()
      note(`relaunchApp 返回 ${JSON.stringify(r)}`)
    }, 2000)
  } else {
    note('✅ 重启后的新实例已成功启动')
    setTimeout(() => app.exit(0), 2500)
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  closeDb()
})

// 让「关于」里显示得清楚一点
app.setName('SimpleMail')
