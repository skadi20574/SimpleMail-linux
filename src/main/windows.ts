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
                  // 富文本正文区是 contenteditable，没有 .value —— 直接写 value
                  // 会抛 Illegal invocation。对它走 execCommand 插字，
                  // 这样才是「真的在编辑器里打字」，事件和状态都会跟着走。
                  if (el.isContentEditable) {
                    el.focus()
                    const range = document.createRange()
                    range.selectNodeContents(el)
                    range.collapse(false)
                    const sel = window.getSelection()
                    sel.removeAllRanges()
                    sel.addRange(range)
                    document.execCommand('insertText', false, ${JSON.stringify(value)})
                    return 'ok'
                  }
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
          /**
           * 可选：模拟按键，多个用 " >> " 分隔。格式 `键名` 或 `修饰键+键名`，
           * 例如 `Delete`、`Shift+Delete`。
           *
           * 专门用来验证键盘驱动的行为（比如按 Delete 删除后是否跳到下一封）——
           * 这类逻辑只有真按键才会走，光点鼠标测不到。
           */
          const keySeq = process.env.SIMPLEMAIL_SHOT_KEY
          if (keySeq) {
            for (const raw of keySeq.split('>>')) {
              const parts = raw.trim().split('+')
              const key = parts.pop() ?? ''
              if (!key) continue
              const shift = parts.some((p) => /^shift$/i.test(p))
              const ctrl = parts.some((p) => /^(ctrl|control)$/i.test(p))
              await win.webContents.executeJavaScript(`
                (() => {
                  const ev = new KeyboardEvent('keydown', {
                    key: ${JSON.stringify(key)},
                    shiftKey: ${shift},
                    ctrlKey: ${ctrl},
                    bubbles: true,
                    cancelable: true
                  })
                  window.dispatchEvent(ev)
                  return 'ok'
                })()
              `)
              await new Promise((resolve) => setTimeout(resolve, 1200))
            }
          }

          /**
           * 可选：模拟拖拽，多个用 " >> " 分隔，每个写成 `选择器::目标X`。
           *
           * 拖动改宽度这类交互只有真的走 mousedown → mousemove → mouseup
           * 才会生效（只有 click 是不行的），所以单独做一个钩子，
           * 否则「三栏可拖拽」这条只能靠肉眼看截图。
           */
          const dragSeq = process.env.SIMPLEMAIL_SHOT_DRAG
          if (dragSeq) {
            for (const raw of dragSeq.split('>>')) {
              const sep = raw.indexOf('::')
              if (sep === -1) continue
              const selector = raw.slice(0, sep).trim()
              const toX = Number(raw.slice(sep + 2))
              if (!Number.isFinite(toX)) continue
              await win.webContents.executeJavaScript(`
                (() => {
                  const el = document.querySelector(${JSON.stringify(selector)})
                  if (!el) return 'missing'
                  const r = el.getBoundingClientRect()
                  const fromX = r.x + r.width / 2
                  const y = r.y + r.height / 2
                  const mk = (type, x) => new MouseEvent(type, {
                    clientX: x, clientY: y, bubbles: true, cancelable: true, buttons: 1
                  })
                  el.dispatchEvent(mk('mousedown', fromX))
                  const steps = 8
                  for (let i = 1; i <= steps; i++) {
                    window.dispatchEvent(mk('mousemove', fromX + ((${toX} - fromX) * i) / steps))
                  }
                  window.dispatchEvent(mk('mouseup', ${toX}))
                  return 'ok'
                })()
              `)
              await new Promise((resolve) => setTimeout(resolve, 900))
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
                  // 布局几何：用坐标证明「三栏并排」，而不是靠肉眼看截图
                  layout: (() => {
                    const box = (sel) => {
                      const el = document.querySelector(sel)
                      if (!el) return null
                      const r = el.getBoundingClientRect()
                      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
                    }
                    const s = box('.sidebarwrap'), l = box('.listwrap'), p = box('.preview')
                    if (!l || !p) return null
                    const sameRow = s && p ? Math.abs(s.y - p.y) < 4 : null
                    const order = s ? s.x < l.x && l.x < p.x : l.x < p.x
                    return {
                      sidebar: s, list: l, preview: p,
                      total: s ? s.w + l.w + p.w : l.w + p.w,
                      sameRow, ordered: order,
                      listX: l.x, listW: l.w, previewX: p.x, previewW: p.w,
                      sameRowListPreview: Math.abs(l.y - p.y) < 4,
                      listLeftOfPreview: l.right ?? (l.x + l.w) <= p.x + 8
                    }
                  })(),
                  // 行首三格：[已读状态] [星标] [附件]；确认复选框已经没有了
                  rowLead: [...document.querySelectorAll('.mailrow')].slice(0, 8).map(r => ({
                    state: r.querySelector('.slot-state .unread-dot') ? '未读'
                         : r.querySelector('.slot-state .read-check') ? '已读' : '无',
                    star: Boolean(r.querySelector('.slot-star svg')),
                    attach: Boolean(r.querySelector('.slot-attach svg')),
                    hasCheckbox: Boolean(r.querySelector('input.rowcheck')),
                    subject: (r.querySelector('.subject')?.textContent || '').trim().slice(0, 14)
                  })),
                  // 当前预览的邮件主题 + 列表前几行的主题：
                  // 用来验证「删除后自动跳到下一封」到底跳对了没有
                  // 地址簿联想（验证写信时的联系人联想）
                  // 提示条文字：用来验证「Ctrl+Enter 触发发送」这类只有副作用的行为
                  toast: (document.querySelector('.toast')?.textContent || '').trim(),
                  addrSuggestOpen: Boolean(document.querySelector('.addrsug')),
                  addrSuggest: [...document.querySelectorAll('.addrsug-item')]
                    .map(el => (el.textContent || '').trim()),
                  addrToValue: (document.querySelector('.addr-to')?.value ?? ''),
                  previewSubject: (document.querySelector('.preview-subject')?.textContent || '').trim(),
                  previewId: (() => {
                    const a = document.querySelector('.mailrow.active')
                    return a ? (a.getAttribute('data-mail-id') || '') : ''
                  })(),
                  rowSubjects: [...document.querySelectorAll('.mailrow .subject')]
                    .slice(0, 6).map(el => (el.textContent || '').trim()),
                  listTitle: (document.querySelector('.listhead .title')?.textContent || '').trim(),
                  listCount: (document.querySelector('.listhead .count')?.textContent || '').trim(),
                  // 当前列表里到底是哪几封（排查「界面条数和库里条数不一样」）
                  listIds: [...document.querySelectorAll('.mailrow')]
                    .map(r => r.getAttribute('data-mail-id')),
                  // ── 线程折叠（1.2.6）──
                  // 折叠标记的数量与文字；展开后子行应该出现在列表里
                  threadBadges: [...document.querySelectorAll('.mailrow .threadtoggle')]
                    .map(el => (el.textContent || '').trim()),
                  threadOpen: [...document.querySelectorAll('.mailrow .threadtoggle.open')].length,
                  childRows: document.querySelectorAll('.mailrow.child').length,
                  // 已回复 / 已转发的标记
                  rowMarks: [...document.querySelectorAll('.mailrow .rowmark')]
                    .map(el => el.getAttribute('title') || ''),
                  // ── 富文本写信（1.2.6）──
                  richEditor: document.querySelector('.rtbody')
                    ? {
                        toolbarButtons: document.querySelectorAll('.rttoolbar .rtbtn').length,
                        selects: document.querySelectorAll('.rttoolbar .rtsel').length,
                        editable: document.querySelector('.rtbody').isContentEditable,
                        height: Math.round(document.querySelector('.rtbody').getBoundingClientRect().height),
                        html: (document.querySelector('.rtbody').innerHTML || '').slice(0, 160)
                      }
                    : null,
                  composerMode: [...document.querySelectorAll('.compose-row .iconbtn')]
                    .map(el => (el.textContent || '').trim())
                    .filter(t => t === '富文本' || t === '纯文本'),
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

          /**
           * 开发辅助：SIMPLEMAIL_SHOT_RICHTEST=1 时跑一遍富文本编辑器的格式命令。
           *
           * 为什么需要它：工具栏的「加粗/字号/颜色」在截图里看起来一模一样，
           * 命令没生效也只是「点了没反应」，肉眼和截图都发现不了。
           * 靠它抓到过一个真 bug —— 工具栏曾经无条件恢复缓存的选区，而缓存只在
           * selectionchange 里更新（那个事件是异步派发的），于是「选好字立刻点 B」
           * 会把格式加到上一次的选区上。
           *
           * 注意：下面的 select 是用**直接赋值 value** 驱动的，不能走
           * Object.getOwnPropertyDescriptor(...).set —— 那样会绕过 React 的值追踪，
           * onChange 不会触发，测出来会是假失败。
           */
          if (process.env.SIMPLEMAIL_SHOT_RICHTEST) {
            const rich = await win.webContents.executeJavaScript(`
              (async () => {
               try {
                const body = document.querySelector('.rtbody')
                if (!body) return { error: '没有富文本编辑器（写信窗口没打开？）' }
                const tick = () => new Promise(r => setTimeout(r, 120))
                const pass = {}

                // 选中 body 里第一处出现的某个词
                const pick = (word) => {
                  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
                  let node
                  while ((node = walker.nextNode())) {
                    const i = node.nodeValue.indexOf(word)
                    if (i === -1) continue
                    const r = document.createRange()
                    r.setStart(node, i)
                    r.setEnd(node, i + word.length)
                    const sel = window.getSelection()
                    sel.removeAllRanges()
                    sel.addRange(r)
                    return true
                  }
                  return false
                }
                const click = (el) => {
                  if (!el) return false
                  // 先 mousedown 再 click：与真实点击的顺序一致，
                  // 工具栏按钮正是在 mousedown 里 preventDefault 保住选区的
                  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
                  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                  return true
                }
                const btn = (cls) => document.querySelector('.rttoolbar .rtbtn' + cls)
                const btnText = (t) => [...document.querySelectorAll('.rttoolbar .rtbtn')]
                  .find(b => b.textContent === t)

                // 粘贴清洗：外部 HTML 里的脚本、iframe、远程图片都不能进正文。
                // 这是「写信」里唯一一处会把外来内容搬进邮件的地方，必须验。
                body.innerHTML = '<div>粘贴起点</div>'
                pick('粘贴起点')
                let pasted = ''
                try {
                  const dt = new DataTransfer()
                  dt.setData(
                    'text/html',
                    '<b>粗体</b><script>window.__pwned=1</script>' +
                      '<iframe src="https://evil.test"></iframe>' +
                      '<img src="https://evil.test/track.png">' +
                      '<a href="javascript:alert(1)">坏链接</a>' +
                      '<a href="https://ok.test/x">好链接</a>'
                  )
                  dt.setData('text/plain', '粗体')
                  // 派发一个真的 paste 事件（带 clipboardData）：
                  // 这样走的就是用户按 Ctrl+V 时那条代码
                  const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
                  Object.defineProperty(ev, 'clipboardData', { value: dt })
                  body.dispatchEvent(ev)
                  await tick()
                  pasted = body.innerHTML
                  pass.粘贴事件生效 = pasted.length > 0
                } catch (err) {
                  pass.粘贴测试出错 = false
                  pasted = 'ERROR: ' + String(err)
                }
                const lower = pasted.toLowerCase()
                pass.粘贴保留粗体 = pasted.includes('<b>')
                pass.粘贴去掉脚本 = !lower.includes('script') && !window.__pwned
                pass.粘贴去掉iframe = !lower.includes('iframe')
                pass.粘贴去掉远程图片 = !lower.includes('<img')
                pass.粘贴去掉javascript链接 = !lower.includes('javascript:')
                pass.粘贴保留正常链接 = pasted.includes('href="https://ok.test/x"')
                body.innerHTML = '<div>甲乙丙丁戊</div>'
                pick('乙'); pass.粗体 = click(btn('.b'))
                pick('丙'); pass.斜体 = click(btn('.i'))
                pick('甲'); pass.下划线 = click(btn('.u'))
                pick('丁')
                const sizeSel = document.querySelectorAll('.rttoolbar .rtsel')[0]
                sizeSel.value = '6'
                sizeSel.dispatchEvent(new Event('change', { bubbles: true }))
                await tick()
                pick('戊')
                const colorSel = document.querySelectorAll('.rttoolbar .rtsel')[1]
                colorSel.value = '#1e8e3e'
                colorSel.dispatchEvent(new Event('change', { bubbles: true }))
                await tick()
                const formatted = body.innerHTML
                pass.粗体生效 = formatted.includes('font-weight: bold')
                pass.斜体生效 = formatted.includes('font-style: italic')
                pass.下划线生效 = formatted.includes('text-decoration-line: underline')
                pass.字号生效 = formatted.includes('font-size:')
                pass.颜色生效 = formatted.includes('color: rgb(30, 142, 62)')
                pass.保留正文 = body.innerText.split(/\\s/).join('').includes('甲乙丙丁戊')

                body.innerHTML = '<div>第一项</div>'
                pick('第一项'); pass.列表 = click(btnText('• 列表'))
                await tick()
                pass.列表生效 = body.innerHTML.includes('<li>')

                body.innerHTML = '<div><span style="font-weight:bold">要清掉的粗体</span></div>'
                pick('要清掉的粗体'); pass.清除格式 = click(btnText('清除格式'))
                await tick()
                pass.清除格式生效 = !body.innerHTML.includes('font-weight')

                body.innerHTML = '<div>点这里打开官网</div>'
                pick('这里')
                click(btnText('链接'))
                await tick()
                const urlInput = document.querySelector('.rtlink input')
                pass.链接面板 = Boolean(urlInput)
                if (urlInput) {
                  const setter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype, 'value'
                  ).set
                  setter.call(urlInput, 'example.com/page')
                  urlInput.dispatchEvent(new Event('input', { bubbles: true }))
                  await tick()
                  click(document.querySelector('.rtlink .btn.primary'))
                  await tick()
                }
                pass.链接生效 = body.innerHTML.includes('href="https://example.com/page"')
                pass.链接面板已关 = !document.querySelector('.rtlink')

                // 模式往返：纯文本里改过的字不能在切回富文本时被旧 HTML 顶掉
                const modeBtn = () => [...document.querySelectorAll('.compose-row .iconbtn')]
                  .find(b => b.textContent === '富文本' || b.textContent === '纯文本')
                click(modeBtn())
                await tick()
                const ta = document.querySelector('.composer textarea')
                pass.切到纯文本 = Boolean(ta)
                if (ta) {
                  const setter = Object.getOwnPropertyDescriptor(
                    window.HTMLTextAreaElement.prototype, 'value'
                  ).set
                  setter.call(ta, '纯文本里改过的一句话')
                  ta.dispatchEvent(new Event('input', { bubbles: true }))
                  await tick()
                }
                click(modeBtn())
                await tick()
                const back = document.querySelector('.rtbody')
                pass.切回富文本 = Boolean(back)
                pass.纯文本编辑没丢 = Boolean(back && back.textContent.includes('纯文本里改过的一句话'))

                return pass
               } catch (err) {
                 return { 脚本出错: String((err && err.stack) || err) }
               }
              })()
            `)
            const failed = Object.entries(rich).filter(([, v]) => v !== true)
            console.log(
              '[SimpleMail] 富文本自检：',
              failed.length === 0 ? '全部通过' : `失败 ${failed.map(([k]) => k).join('、')}`,
              JSON.stringify(rich)
            )
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
