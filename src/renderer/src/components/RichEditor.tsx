/**
 * 富文本正文编辑器（HTML 写信）。
 *
 * 用 contenteditable + document.execCommand：
 * execCommand 虽然被标成过时，但在 Chromium 里一直可用，而且
 * Electron 的浏览器版本是随安装包固定的，不存在「不同版本行为不一样」的风险。
 * 换成自己实现 Range 操作的话，光是「跨段落加粗」这一件事就要写几百行。
 *
 * 几个必须处理好的地方：
 *   1. 点工具栏按钮不能把正文里的选区弄丢 —— 所以按钮统一 onMouseDown 时
 *      preventDefault，并且随时把选区存下来；
 *   2. 粘贴是最主要的「脏 HTML」入口 —— 必须过 sanitizeRichHtml，
 *      图片直接丢（远程图等于替别人塞追踪像素，data: 图动辄几 MB）；
 *   3. 内容不受 React 控制（不设 dangerouslySetInnerHTML 的重渲染），
 *      否则每敲一个字光标都会跳到开头。外部要换内容只能走 setHtml()。
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { escapeHtml, plainToHtml, sanitizeRichHtml } from '../richtext'

export interface RichEditorHandle {
  /** 当前正文的 HTML */
  getHtml(): string
  /** 整段替换内容；caret 决定光标落到开头还是结尾 */
  setHtml(html: string, caret?: 'start' | 'end'): void
  focus(): void
}

interface Props {
  /** 初始内容，只在挂载时用一次 */
  initialHtml: string
  /** 内容有任何变化（用户输入、工具栏命令、粘贴）都回调 */
  onChange: () => void
  /** 需要提示用户时调用（例如粘贴的图片被丢掉） */
  onNotify: (message: string) => void
  placeholder?: string
}

const COLORS: { label: string; value: string }[] = [
  { label: '默认', value: '' },
  { label: '红', value: '#d93025' },
  { label: '橙', value: '#e8710a' },
  { label: '绿', value: '#1e8e3e' },
  { label: '蓝', value: '#1a73e8' },
  { label: '紫', value: '#8430ce' },
  { label: '灰', value: '#5f6368' }
]

const SIZES: { label: string; value: string }[] = [
  { label: '小', value: '2' },
  { label: '正常', value: '3' },
  { label: '大', value: '4' },
  { label: '特大', value: '6' }
]

const RichEditor = forwardRef<RichEditorHandle, Props>(function RichEditor(
  props,
  ref
): JSX.Element {
  const editorRef = useRef<HTMLDivElement>(null)
  /** 最近一次在编辑器内产生的选区：点工具栏按钮会先丢掉它，必须自己存 */
  const savedRange = useRef<Range | null>(null)
  const [active, setActive] = useState<Record<string, boolean>>({})
  const [empty, setEmpty] = useState(!props.initialHtml)
  /**
   * 插入链接的小面板。
   *
   * 为什么不用浏览器自带的输入框函数：Electron 的渲染进程根本没有实现它，
   * 调用只会得到 null 并在控制台留一条警告 —— 那个按钮就等于坏了。
   */
  const [linkPanel, setLinkPanel] = useState<{ text: string; url: string } | null>(null)

  const refreshActive = (): void => {
    const q = (cmd: string): boolean => {
      try {
        return document.queryCommandState(cmd)
      } catch {
        return false
      }
    }
    setActive({
      bold: q('bold'),
      italic: q('italic'),
      underline: q('underline'),
      strikeThrough: q('strikeThrough'),
      insertUnorderedList: q('insertUnorderedList'),
      insertOrderedList: q('insertOrderedList'),
      justifyLeft: q('justifyLeft'),
      justifyCenter: q('justifyCenter'),
      justifyRight: q('justifyRight')
    })
  }

  const saveSelection = (): void => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    const el = editorRef.current
    if (!el) return
    if (!el.contains(range.commonAncestorContainer)) return
    savedRange.current = range.cloneRange()
  }

  const restoreSelection = (): void => {
    const el = editorRef.current
    if (!el) return
    const sel = window.getSelection()
    /**
     * 选区**本来就在正文里**时就别碰它 —— 这是最正常的一条路径：
     * 用户选好文字，直接点工具栏按钮（按钮的 mousedown 被 preventDefault 拦住，
     * 所以选区还在）。
     *
     * 之前这里无条件恢复 savedRange，而 savedRange 只在 selectionchange
     * 事件里更新 —— 那个事件是**异步派发**的。刚选完文字立刻点按钮时，
     * savedRange 还是上一次的旧选区，于是「加粗」作用到了别的地方
     * （表现就是点了没反应）。这个 bug 是自检脚本（选中几个字再点 B）
     * 抓出来的，光看截图看不出来。
     */
    if (sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      return
    }
    el.focus()
    const range = savedRange.current
    if (!range || !sel) return
    // 缓存下来的选区可能指向已经被替换掉的旧 DOM（例如整段内容被 setHtml 换掉、
    // 或者编辑器重新挂载过）。往这种「游离节点」上恢复选区不会报错，
    // 但后续 execCommand 会插到空处 —— 表现就是「粘贴/加粗没反应」。
    if (!el.contains(range.commonAncestorContainer)) return
    sel.removeAllRanges()
    sel.addRange(range)
  }

  const syncEmpty = (): void => {
    const el = editorRef.current
    if (!el) return
    setEmpty(el.innerText.trim() === '' && !el.querySelector('img,hr,table'))
  }

  // 只挂一次：把内容写进 DOM，并让 execCommand 产出 style 而不是 <font> 标签
  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    el.innerHTML = props.initialHtml
    syncEmpty()
    try {
      // 用 style 表达格式，产出 <span style="...">，比 <font size=4> 干净得多，
      // 收件端也更容易正确显示
      document.execCommand('styleWithCSS', false, 'true')
      document.execCommand('defaultParagraphSeparator', false, 'div')
    } catch {
      /* 老内核不支持就算了，不影响打字 */
    }
    // 光标放到正文开头（签名/引用下方之后由父组件决定，这里只保证能直接打字）
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(true)
    const sel = window.getSelection()
    if (sel) {
      sel.removeAllRanges()
      sel.addRange(range)
    }
    savedRange.current = range.cloneRange()
    // 只在挂载时执行一次；initialHtml 之后的变化一律走 setHtml()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onSelChange = (): void => {
      saveSelection()
      refreshActive()
    }
    document.addEventListener('selectionchange', onSelChange)
    return () => document.removeEventListener('selectionchange', onSelChange)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useImperativeHandle(ref, () => ({
    getHtml: () => editorRef.current?.innerHTML ?? '',
    setHtml: (html, caret = 'start') => {
      const el = editorRef.current
      if (!el) return
      el.innerHTML = html
      syncEmpty()
      el.focus()
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(caret === 'start')
      const sel = window.getSelection()
      if (sel) {
        sel.removeAllRanges()
        sel.addRange(range)
      }
      savedRange.current = range.cloneRange()
    },
    focus: () => editorRef.current?.focus()
  }))

  /** 执行一条编辑命令 */
  const run = (cmd: string, value?: string): void => {
    restoreSelection()
    try {
      document.execCommand(cmd, false, value)
    } catch {
      /* 命令不支持时静默忽略：不值得为它弹个错误框 */
    }
    saveSelection()
    refreshActive()
    syncEmpty()
    props.onChange()
  }

  /** 把链接面板里填的地址落到正文里 */
  const applyLink = (): void => {
    if (!linkPanel) return
    let url = linkPanel.url.trim()
    if (!url) {
      setLinkPanel(null)
      return
    }
    // 只写 "example.com" 也当外链处理：收件端点开时不至于变成相对路径
    if (!/^(https?:\/\/|mailto:)/i.test(url)) url = `https://${url}`
    restoreSelection()
    if (linkPanel.text) {
      // 有选中文字 ⇒ 把这段文字变成链接
      document.execCommand('createLink', false, url)
    } else {
      // 没选中 ⇒ 直接插入一个「地址即文字」的链接
      const label = escapeHtml(url)
      document.execCommand(
        'insertHTML',
        false,
        `<a href="${label.replace(/"/g, '&quot;')}">${label}</a>`
      )
    }
    setLinkPanel(null)
    saveSelection()
    syncEmpty()
    props.onChange()
  }

  const Btn = (p: {    cmd?: string
    value?: string
    label: string
    title: string
    on?: boolean
    className?: string
  }): JSX.Element => (
    <button
      type="button"
      className={`rtbtn${p.on ? ' on' : ''}${p.className ? ` ${p.className}` : ''}`}
      title={p.title}
      // 关键：不让按钮抢走正文里的选区
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => (p.cmd ? run(p.cmd, p.value) : undefined)}
    >
      {p.label}
    </button>
  )

  return (
    <div className="richedit">
      {linkPanel && (
        <div className="rtlink">
          <span>链接地址</span>
          <input
            autoFocus
            value={linkPanel.url}
            placeholder="https://example.com"
            onChange={(e) => setLinkPanel({ ...linkPanel, url: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyLink()
              if (e.key === 'Escape') setLinkPanel(null)
            }}
          />
          {!linkPanel.text && <span className="rthint">未选中文字，将把地址本身显示为链接文字</span>}
          <span className="spacer" style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={() => setLinkPanel(null)}>
            取消
          </button>
          <button type="button" className="btn primary" onClick={applyLink}>
            插入
          </button>
        </div>
      )}
      <div className="rttoolbar">
        {Btn({ cmd: 'bold', label: 'B', title: '粗体（Ctrl+B）', on: active.bold, className: 'b' })}
        {Btn({ cmd: 'italic', label: 'I', title: '斜体（Ctrl+I）', on: active.italic, className: 'i' })}
        {Btn({
          cmd: 'underline',
          label: 'U',
          title: '下划线（Ctrl+U）',
          on: active.underline,
          className: 'u'
        })}
        {Btn({
          cmd: 'strikeThrough',
          label: 'S',
          title: '删除线',
          on: active.strikeThrough,
          className: 's'
        })}
        <span className="rtsep" />
        <select
          className="rtsel"
          title="字号"
          defaultValue="3"
          onMouseDown={saveSelection}
          onChange={(e) => run('fontSize', e.target.value)}
        >
          {SIZES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          className="rtsel"
          title="文字颜色"
          defaultValue=""
          onMouseDown={saveSelection}
          onChange={(e) => run('foreColor', e.target.value || 'inherit')}
        >
          {COLORS.map((c) => (
            <option key={c.label} value={c.value}>
              颜色：{c.label}
            </option>
          ))}
        </select>
        <span className="rtsep" />
        {Btn({
          cmd: 'insertUnorderedList',
          label: '• 列表',
          title: '无序列表',
          on: active.insertUnorderedList
        })}
        {Btn({
          cmd: 'insertOrderedList',
          label: '1. 编号',
          title: '有序列表',
          on: active.insertOrderedList
        })}
        {Btn({ cmd: 'formatBlock', value: 'blockquote', label: '引用', title: '缩进引用' })}
        <span className="rtsep" />
        {Btn({ cmd: 'justifyLeft', label: '左', title: '左对齐', on: active.justifyLeft })}
        {Btn({ cmd: 'justifyCenter', label: '中', title: '居中', on: active.justifyCenter })}
        {Btn({ cmd: 'justifyRight', label: '右', title: '右对齐', on: active.justifyRight })}
        <span className="rtsep" />
        <button
          type="button"
          className="rtbtn"
          title="插入链接"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            saveSelection()
            const sel = window.getSelection()
            const picked = sel ? sel.toString().trim() : ''
            setLinkPanel({ text: picked, url: /^(https?:\/\/|mailto:)/i.test(picked) ? picked : '' })
          }}
        >
          链接
        </button>
        {Btn({ cmd: 'removeFormat', label: '清除格式', title: '去掉选中文字的格式' })}
        <span className="rtsep" />
        {Btn({ cmd: 'undo', label: '撤销', title: '撤销（Ctrl+Z）' })}
        {Btn({ cmd: 'redo', label: '重做', title: '重做（Ctrl+Y）' })}
      </div>

      <div
        className="rtbody"
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        data-ph={props.placeholder ?? '在这里写正文…'}
        data-empty={empty ? '1' : '0'}
        onInput={() => {
          saveSelection()
          syncEmpty()
          props.onChange()
        }}
        onKeyUp={() => {
          saveSelection()
          refreshActive()
        }}
        onMouseUp={() => {
          saveSelection()
          refreshActive()
        }}
        onBlur={saveSelection}
        onPaste={(e) => {
          // 自己接管粘贴：外面来的 HTML 一律清洗
          e.preventDefault()
          // 先把焦点和插入点找回来：execCommand 只对「当前焦点」生效，
          // 万一编辑器不是焦点（例如先点了别处再右键粘贴），内容会插到空处。
          restoreSelection()
          const html = e.clipboardData.getData('text/html')
          const text = e.clipboardData.getData('text/plain')
          if (html) {
            const res = sanitizeRichHtml(html)
            document.execCommand('insertHTML', false, res.html)
            if (res.droppedImages) {
              props.onNotify('粘贴内容里的图片没有带进来 —— 正文插图请用「添加附件」')
            }
            if (res.droppedBlocks) {
              props.onNotify('粘贴内容里的脚本/内嵌框架已被丢弃')
            }
          } else if (text) {
            document.execCommand('insertHTML', false, plainToHtml(text))
          }
          saveSelection()
          syncEmpty()
          props.onChange()
        }}
        onDrop={(e) => {
          // 往正文里拖文件当成「往邮件里插外部资源」，一律不理，
          // 但要说清楚，否则用户以为拖进来的东西发出去了
          if (e.dataTransfer.files.length) {
            e.preventDefault()
            props.onNotify('拖着文件进正文不会自动加附件 —— 请用「添加附件」按钮')
          }
        }}
      />
    </div>
  )
})

export default RichEditor
