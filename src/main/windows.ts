/**
 * 窗口管理。
 *
 * 单独成模块是为了避免循环依赖：ipc.ts 需要「打开邮件新窗口」，
 * 而窗口创建又依赖主入口，两者互相 import 会成环。
 */

import { BrowserWindow, shell } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

let mainWindow: BrowserWindow | null = null
/** 每封邮件一个独立窗口，重复双击同一封不会开出两个 */
const mailWindows = new Map<number, BrowserWindow>()

function rendererEntry(): { url?: string; file?: string } {
  if (process.env.ELECTRON_RENDERER_URL) return { url: process.env.ELECTRON_RENDERER_URL }
  return { file: join(__dirname, '../renderer/index.html') }
}

function attachExternalLinkGuard(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
}

/** 截图辅助（开发用）：SIMPLEMAIL_SHOT=/path/x.png */
function attachScreenshotHook(win: BrowserWindow): void {
  const shotPath = process.env.SIMPLEMAIL_SHOT
  if (!shotPath) return

  win.webContents.once('did-finish-load', () => {
    const delay = Number(process.env.SIMPLEMAIL_SHOT_DELAY ?? 3000)
    setTimeout(() => {
      const guard = setTimeout(() => {
        console.error('[SimpleMail] 截图超时（Wayland 会话请加 --ozone-platform=x11）')
        process.exit(5)
      }, 15_000)
      void (async () => {
        try {
          // 可选：按顺序模拟点击若干元素，多个选择器用 " >> " 分隔
          const clickSelectors = process.env.SIMPLEMAIL_SHOT_CLICK
          if (clickSelectors) {
            for (const raw of clickSelectors.split('>>')) {
              const selector = raw.trim()
              if (!selector) continue
              await win.webContents.executeJavaScript(
                `document.querySelector(${JSON.stringify(selector)})` +
                  `?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`
              )
              await new Promise((resolve) => setTimeout(resolve, 1200))
            }
          }

          /**
           * 可选：往若干输入框里填值，多个用 " >> " 分隔，每个写成 `选择器::文本`。
           *
           * 必须走原生 value setter 再派发 input 事件 —— 直接 `el.value = x`
           * 不会触发 React 的 onChange，界面看着填进去了但状态没变，
           * 这种「假成功」比不测还危险。
           */
          const typePairs = process.env.SIMPLEMAIL_SHOT_TYPE
          if (typePairs) {
            for (const raw of typePairs.split('>>')) {
              const sep = raw.indexOf('::')
              if (sep === -1) continue
              const selector = raw.slice(0, sep).trim()
              const value = raw.slice(sep + 2)
              await win.webContents.executeJavaScript(`
                (() => {
                  const el = document.querySelector(${JSON.stringify(selector)})
                  if (!el) return 'missing'
                  const setter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype, 'value'
                  ).set
                  setter.call(el, ${JSON.stringify(value)})
                  el.dispatchEvent(new Event('input', { bubbles: true }))
                  return 'ok'
                })()
              `)
              // 比防抖的 320ms 长，确保查询已经发出
              await new Promise((resolve) => setTimeout(resolve, 1000))
            }
          }
          // 开发辅助：SIMPLEMAIL_SHOT_DIAG=1 时打印一份界面状态，便于排查
          // 「设置存了但没生效」这类问题（主题、快捷键、列表条数都在这）。
          if (process.env.SIMPLEMAIL_SHOT_DIAG) {
            try {
              const diag = await win.webContents.executeJavaScript(`
                (async () => JSON.stringify({
                  dataTheme: document.documentElement.getAttribute('data-theme'),
                  settingsTheme: (await window.api.settings.get()).theme,
                  rowCount: document.querySelectorAll('.mailrow').length,
                  unreadDots: document.querySelectorAll('.unread-dot').length,
                  overlay: document.querySelector('.overlay') ? '开' : '关',
                  // 未读蓝点：既要存在，也要有实际尺寸（曾经的 bug 是存在但宽高为 0）
                  unreadDotsVisible: [...document.querySelectorAll('.unread-dot')]
                    .filter(el => el.offsetWidth > 0 && el.offsetHeight > 0).length,
                  stars: [...document.querySelectorAll('.slot-star svg')].length,
                  // 按钮是否被压成两行
                  buttonsWrapped: [...document.querySelectorAll('.btn')]
                    .filter(b => b.offsetHeight > 36).length,
                  browseBtn: (() => {
                    const b = [...document.querySelectorAll('.btn')].find(x => x.textContent.includes('浏览'))
                    return b ? b.offsetHeight : -1
                  })(),
                  wipeInputShown: Boolean(document.querySelector('input[placeholder="DELETE"]')),
                  folderDialogShown: (() => {
                    const dlg = document.querySelector('.overlay .dialog-head span')
                    return dlg ? dlg.textContent : null
                  })(),
                  draggableRows: document.querySelectorAll('.mailrow[draggable="true"]').length,
                  dotRect: (() => {
                    const d = document.querySelector('.unread-dot')
                    if (!d) return null
                    const r = d.getBoundingClientRect()
                    return [Math.round(r.x + r.width/2), Math.round(r.y + r.height/2), Math.round(r.width), Math.round(r.height)]
                  })(),
                  // 设置与主题两个图标路径是否不同
                  iconPaths: [...document.querySelectorAll('.toolbar .tbtn svg path')]
                    .slice(-2).map(p => (p.getAttribute('d') || '').slice(0, 24)),
                  // ── 按字段搜索面板（1.1.6）──
                  // 面板是否展开、里面有几个并列输入框、每个框的实际宽度
                  // （宽度为 0 说明样式没生效，等于用户看不见也点不到）
                  searchPanel: document.querySelector('.searchpanel') ? '开' : '关',
                  searchFields: [...document.querySelectorAll('.searchfield')].map(f => ({
                    label: (f.querySelector('.flabel')?.textContent || '').trim(),
                    width: Math.round(f.querySelector('input')?.getBoundingClientRect().width || 0)
                  })),
                  searchBadge: (document.querySelector('.searchtoggle .badge')?.textContent || '').trim(),
                  searchPlaceholder: document.querySelector('.searchbox input')?.getAttribute('placeholder') || '',
                  // 列表头：标题（含完整搜索条件）与总数 —— 总数才是筛选结果，
                  // rowCount 只反映当前这一页渲染了多少行
                  // 布局几何：用坐标证明「列表在左、正文在右」，而不是靠肉眼看截图
                  layout: (() => {
                    const l = document.querySelector('.listwrap')
                    const p = document.querySelector('.preview')
                    if (!l || !p) return null
                    const lr = l.getBoundingClientRect()
                    const pr = p.getBoundingClientRect()
                    return {
                      listX: Math.round(lr.x), listW: Math.round(lr.width),
                      previewX: Math.round(pr.x), previewW: Math.round(pr.width),
                      sameRow: Math.abs(lr.y - pr.y) < 4,
                      listLeftOfPreview: lr.right <= pr.left + 8
                    }
                  })(),
                  listTitle: (document.querySelector('.listhead .title')?.textContent || '').trim(),
                  listCount: (document.querySelector('.listhead .count')?.textContent || '').trim(),
                  // ── 写信窗口（验证 mailto: 链接有没有正确填进来）──
                  // 按「标签 → 输入框」取名，比按序号稳妥（抄送/密送是条件渲染的）
                  composer: document.querySelector('.composer') ? '开' : '关',
                  composerAttachments: [...document.querySelectorAll('.attachchip .fname')]
                    .map(el => (el.textContent || '').trim()),
                  composerFields: (() => {
                    const out = {}
                    for (const row of document.querySelectorAll('.compose-row')) {
                      const label = (row.querySelector('label')?.textContent || '').trim()
                      const el = row.querySelector('input, textarea')
                      if (label && el) out[label] = el.value
                    }
                    const body = document.querySelector('.composer textarea')
                    if (body) out['正文'] = body.value
                    return out
                  })()
                }))()
              `)
              console.log('[SimpleMail] 界面诊断：', diag)
            } catch (err) {
              console.error('[SimpleMail] 诊断失败：', err)
            }
          }

          const image = await win.webContents.capturePage()
          if (image && !image.isEmpty()) {
            writeFileSync(shotPath, image.toPNG())
            console.log(`[SimpleMail] 截图已保存：${shotPath}`)
          } else {
            console.error('[SimpleMail] 截图内容为空')
          }
        } catch (err) {
          console.error('[SimpleMail] 截图失败：', err)
        } finally {
          clearTimeout(guard)
          const { app } = await import('electron')
          app.quit()
        }
      })()
    }, delay)
  })
}

export function createMainWindow(): BrowserWindow {
  // 开发辅助：SIMPLEMAIL_SHOT_SIZE=1000x680 可以指定窗口尺寸，
  // 用来复现窄窗口下的文字折行 / 溢出问题。
  const sizeEnv = process.env.SIMPLEMAIL_SHOT_SIZE
  let winWidth = 1360
  let winHeight = 860
  if (sizeEnv) {
    const m = /^(\d+)x(\d+)$/.exec(sizeEnv.trim())
    if (m) {
      winWidth = Number(m[1])
      winHeight = Number(m[2])
    }
  }

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'SimpleMail',
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      spellcheck: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  attachExternalLinkGuard(mainWindow)
  attachScreenshotHook(mainWindow)

  const entry = rendererEntry()
  if (entry.url) void mainWindow.loadURL(entry.url)
  else void mainWindow.loadFile(entry.file!)

  mainWindow.on('closed', () => {
    mainWindow = null
  })
  return mainWindow
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function getAllWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
}

export function getMailMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
}

/**
 * 双击邮件时打开一个独立窗口来读信。
 * 同一封邮件重复双击会聚焦已有窗口，而不是再开一个。
 */
export function openMailWindow(mailId: number, title?: string): void {
  const existing = mailWindows.get(mailId)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return
  }

  const win = new BrowserWindow({
    width: 940,
    height: 760,
    minWidth: 560,
    minHeight: 420,
    show: false,
    title: title || 'SimpleMail — 邮件',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      spellcheck: false
    }
  })

  win.on('ready-to-show', () => win.show())
  attachExternalLinkGuard(win)

  const entry = rendererEntry()
  if (entry.url) {
    const u = new URL(entry.url)
    u.searchParams.set('mailWindow', String(mailId))
    void win.loadURL(u.toString())
  } else {
    void win.loadFile(entry.file!, { query: { mailWindow: String(mailId) } })
  }

  win.on('closed', () => mailWindows.delete(mailId))
  mailWindows.set(mailId, win)
}

/** 关闭某封邮件的独立窗口（在别处删掉这封邮件时用） */
export function closeMailWindow(mailId: number): void {
  const win = mailWindows.get(mailId)
  if (win && !win.isDestroyed()) win.close()
  mailWindows.delete(mailId)
}
