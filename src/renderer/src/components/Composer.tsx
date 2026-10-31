import { useEffect, useMemo, useRef, useState } from 'react'
import AddressField from './AddressField'
import RichEditor, { type RichEditorHandle } from './RichEditor'
import type { Account, ComposeAttachment, ComposePayload, MailDetail } from '../api'
import { api } from '../api'
import { escapeHtml, htmlToPlainText, plainToHtml } from '../richtext'
import { excludeAddress } from '@shared/address'
import { forwardSubject, formatFullDate, replySubject, shortAddress } from '../utils'
import Icon from './Icon'

export interface ComposeInit {
  accountId: number
  draftId?: number
  to: string
  cc: string
  bcc: string
  subject: string
  body: string
  html?: string | null
  inReplyTo?: string | null
  references?: string | null
  attachments: ComposeAttachment[]
}

interface Props {
  accounts: Account[]
  init: ComposeInit
  onClose: () => void
  onSent: (message: string) => void
  onError: (message: string) => void
}

/* 「从地址串里去掉自己」见 shared/address.ts 的 excludeAddress：
   放在 shared 里才能被自检直接覆盖到。 */

/** 签名块：富文本模式下的样子（颜色淡一点，和正文区分开） */
export function signatureHtml(signature: string): string {
  if (!signature) return ''
  return (
    `<div data-smsig="1" style="color:#8d949e;margin-top:10px">` +
    `--<br>${plainToHtml(signature)}</div>`
  )
}

/** 引用块写成内联样式：收件端读不到我们的 CSS 文件。 */
const QUOTE_STYLE =
  'margin:8px 0 0 0;padding-left:12px;border-left:3px solid #d8dde3;color:#5b636d'

/** 去掉正文里已有的签名块（切换发件账户时用） */
export function stripSignatureHtml(html: string): string {
  return html.replace(/<div[^>]*data-smsig="1"[^>]*>[\s\S]*?<\/div>/gi, '')
}

export function buildReplyInit(
  accountId: number,
  mail: MailDetail,
  mode: 'reply' | 'replyAll' | 'forward',
  signature: string,
  /** 当前账户自己的地址：全部回复时要把它排除掉 */
  selfAddress = ''
): ComposeInit {
  const sig = signature ? `\n\n--\n${signature}` : ''
  const headLines = [
    '------------------ 原始邮件 ------------------',
    `发件人: ${mail.fromName ? `${mail.fromName} <${mail.fromAddr}>` : mail.fromAddr}`,
    `时间: ${formatFullDate(mail.date)}`,
    `收件人: ${mail.toText}`,
    ...(mail.ccText ? [`抄送: ${mail.ccText}`] : []),
    `主题: ${mail.subject}`
  ]
  const quotedHeader = `\n\n${headLines.join('\n')}\n\n`
  const quotedBody = (mail.bodyText || '').split('\n').map((l) => `> ${l}`).join('\n')

  /**
   * 富文本版本的引用。
   *
   * 这里**故意**不用原邮件的 body_html：那里面可能塞着几十 MB 的 base64 图片
   * （实测最夸张的一封光图片就占了正文的 95%），整段搬进编辑器会让写窗口卡死，
   * 而 cid: 图片在编辑器里也显示不出来。所以统一把纯文本正文转成 HTML 引用，
   * 保留「谁、什么时候、说了什么」，丢掉原始排版 —— 这是所有客户端的通行做法。
   */
  const headerHtml = headLines.map((l) => escapeHtml(l)).join('<br>')
  const quoteHtml = (text: string): string =>
    `<blockquote style="${QUOTE_STYLE}">${plainToHtml(text)}</blockquote>`
  const sigHtml = signatureHtml(signature)
  const htmlFor = (header: string, body: string): string =>
    `${sigHtml}${header ? `<div style="color:#5b636d">${header}</div>` : ''}${quoteHtml(body)}`

  if (mode === 'forward') {
    return {
      accountId,
      to: '',
      cc: '',
      bcc: '',
      subject: forwardSubject(mail.subject),
      body: `${sig}\n\n${quotedHeader}${mail.bodyText || ''}`,
      html: htmlFor(headerHtml, mail.bodyText || ''),
      attachments: []
    }
  }

  // 全部回复 = 原发件人 + 原收件人（去掉自己）；抄送也去掉自己。
  // 单封回复只发给发件人 —— 但如果这封是「我发出去的」，则回给原收件人。
  const mine = selfAddress.trim().toLowerCase()
  const fromIsMe = mine !== '' && mail.fromAddr.trim().toLowerCase() === mine
  const baseTo =
    mode === 'replyAll'
      ? [mail.fromAddr, mail.toText].join(', ')
      : fromIsMe
        ? mail.toText
        : mail.fromAddr
  const to = excludeAddress(baseTo, selfAddress)
  const cc = mode === 'replyAll' ? excludeAddress(mail.ccText, selfAddress) : ''

  return {
    accountId,
    to: shortAddress(to),
    cc: shortAddress(cc),
    bcc: '',
    subject: replySubject(mail.subject),
    body: `${sig}\n\n${quotedHeader}${quotedBody}`,
    html: htmlFor(headerHtml, mail.bodyText || ''),
    inReplyTo: mail.messageId,
    references: mail.references ?? mail.messageId,
    attachments: []
  }
}

export default function Composer(props: Props): JSX.Element {
  const [form, setForm] = useState<ComposeInit>(props.init)
  const [showCc, setShowCc] = useState(Boolean(props.init.cc || props.init.bcc))
  const [sending, setSending] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const editorRef = useRef<RichEditorHandle>(null)

  /**
   * 富文本 / 纯文本。
   *
   * 默认富文本 —— 用户要的就是「写信能排版」。切到纯文本时正文里已有的
   * 格式会被摊平（文字内容不丢），发出去的邮件也就没有 HTML 部分，
   * 这一点在切换时会明确提示，不让用户以为排版只是被藏起来了。
   */
  const [rich, setRich] = useState(true)
  /**
   * 富文本正文的权威副本。
   *
   * 为什么不用 React 控制 contenteditable：受控组件每次输入都会重写
   * innerHTML，光标会跳回开头、中文输入法的组词也会被打断。
   * 所以正文只在「我们自己要换内容」时才写进 DOM（初始化、切账户、切模式），
   * 其余时间从 DOM 里读。
   */
  const htmlRef = useRef<string>(props.init.html ?? plainToHtml(props.init.body))
  /** 纯文本正文的权威副本（切模式时用它，避免来回切换时内容丢失） */
  const textRef = useRef<string>(props.init.body)
  /**
   * 纯文本模式下有没有真的动过字。
   *
   * 用来决定「切回富文本」时听谁的：
   *   · 没动过 ⇒ 用原来那份 HTML，排版一点都不丢（来回切换是无损的）；
   *   · 动过 ⇒ 只能按用户改过的纯文本来重建，否则刚打的字会被旧 HTML 顶掉。
   */
  const plainDirtyRef = useRef(false)

  // 打开时自动根据签名/账户变化重置（切换账户时重新套用签名）
  const account = useMemo(
    () => props.accounts.find((a) => a.id === form.accountId) ?? props.accounts[0],
    [props.accounts, form.accountId]
  )

  useEffect(() => {
    if (rich) editorRef.current?.focus()
    else bodyRef.current?.focus()
    // 只在挂载时聚焦，之后切模式时由 setMode 自己处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 把一条提示作为「发送失败」那样弹出来（只用于富文本编辑器的小提示） */
  const notifyEditor = (msg: string): void => props.onError(msg)

  /**
   * Ctrl/Cmd + Enter 发送。
   *
   * 挂在 window 上而不是某个输入框：写信时有收件人/主题/正文多个焦点位置，
   * 用户不该每次先点回正文才能用快捷键。用捕获阶段抢在别的处理器之前。
   *
   * 用 isComposing 排除中文输入法正在组词的情况 —— 输入法选词时敲回车很常见，
   * 那一刻不能把邮件发出去。
   *
   * ⚠️ 这里必须走 ref：监听器只在挂载时注册一次（避免每敲一个字就重装监听），
   * 但 doSend 依赖 form 等一堆状态。直接闭包会捕获**旧的** form ——
   * 表现为「刚打的正文没被发出去，发的是打开时空的内容」。
   */
  const sendOnceRef = useRef<() => void>(() => {})
  useEffect(() => {
    sendOnceRef.current = () => {
      if (!sending) void doSend()
    }
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return
      if (e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      sendOnceRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const patch = (p: Partial<ComposeInit>): void => {
    setForm((f) => ({ ...f, ...p }))
    setDirty(true)
  }

  const switchAccount = (accountId: number): void => {
    const next = props.accounts.find((a) => a.id === accountId)
    if (!next) return
    if (rich) {
      // 富文本：从 DOM 里拿当前 HTML，摘掉旧签名块，把新签名放在最前面
      const current = editorRef.current?.getHtml() ?? htmlRef.current
      const body = stripSignatureHtml(current)
      const nextHtml = `${signatureHtml(next.signature ?? '')}${body}`
      htmlRef.current = nextHtml
      textRef.current = htmlToPlainText(nextHtml)
      editorRef.current?.setHtml(nextHtml, 'start')
      patch({ accountId })
      return
    }
    // 纯文本：原来那套「按 `\n\n--\n` 标记换签名」的逻辑照旧
    const oldSig = account?.signature
    let body = form.body
    if (oldSig) {
      const marker = `\n\n--\n${oldSig}`
      if (body.includes(marker)) body = body.replace(marker, '')
    }
    const newSig = next.signature ? `\n\n--\n${next.signature}` : ''
    textRef.current = `${body}${newSig}`
    patch({ accountId, body: `${body}${newSig}` })
  }

  /**
   * 切换富文本 / 纯文本。
   *
   * 两种模式各自保存一份内容，切换时把**当前**那份转成另一种格式再写过去：
   *   · 富文本 → 纯文本：文字全留下，格式没了（格式本来也没法用纯文本表达）；
   *   · 纯文本 → 富文本：换行变 <br>，之后可以随便排版。
   * 这样来回切不会丢字，只是排版必须重做 —— 切换时会把这件事说出来。
   */
  const setMode = (nextRich: boolean): void => {
    if (nextRich === rich) return
    if (nextRich) {
      // 在纯文本里改过字就只能以文字为准，否则用户的编辑会被旧 HTML 顶掉
      const html = plainDirtyRef.current
        ? plainToHtml(textRef.current)
        : htmlRef.current || plainToHtml(textRef.current)
      plainDirtyRef.current = false
      htmlRef.current = html
      setRich(true)
      // 等编辑器挂载之后再写内容
      window.setTimeout(() => editorRef.current?.setHtml(html, 'end'), 0)
      props.onError('已切到富文本：纯文本里的换行已转成对应排版，可以开始加格式了')
    } else {
      const html = editorRef.current?.getHtml() ?? htmlRef.current
      htmlRef.current = html
      const text = htmlToPlainText(html)
      textRef.current = text
      plainDirtyRef.current = false
      setForm((f) => ({ ...f, body: text, html: null }))
      setRich(false)
      props.onError('已切到纯文本：原有排版已摊平（文字没丢），发出的邮件将不带 HTML 部分')
    }
    setDirty(true)
  }

  const addAttachments = async (): Promise<void> => {
    const picked = await api.attachments.pick()
    if (!picked.length) return
    const existing = new Set(form.attachments.map((a) => a.path))
    const merged = [...form.attachments, ...picked.filter((p) => !existing.has(p.path))]
    patch({ attachments: merged })
  }

  const buildPayload = (saveAsDraft: boolean): ComposePayload => {
    // 富文本模式从 DOM 里现取现算：正文没走受控组件，状态里那份可能落后
    const html = rich ? (editorRef.current?.getHtml() ?? htmlRef.current) : null
    const text = rich ? htmlToPlainText(html ?? '') : form.body
    return {
      accountId: form.accountId,
      draftId: form.draftId,
      to: form.to,
      cc: form.cc,
      bcc: form.bcc,
      subject: form.subject,
      text,
      html,
      inReplyTo: form.inReplyTo ?? null,
      references: form.references ?? null,
      attachments: form.attachments,
      saveAsDraft
    }
  }

  const doSend = async (): Promise<void> => {
    if (!form.to.trim()) {
      props.onError('请先填写收件人')
      return
    }
    if (!account || account.isLocal) {
      props.onError('「本地存档」账户不能发信，请先添加一个真实邮箱账户')
      return
    }
    setSending(true)
    try {
      const result = await api.mails.send(buildPayload(false))
      if (result.ok) {
        props.onSent('邮件已发送')
        props.onClose()
      } else {
        props.onError(result.error ?? '发送失败')
      }
    } catch (err) {
      props.onError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  const doSaveDraft = async (silent = false): Promise<void> => {
    setSaving(true)
    try {
      const result = await api.mails.saveDraft(buildPayload(true))
      if (result.ok) {
        if (result.mailId) patch({ draftId: result.mailId })
        setDirty(false)
        if (!silent) props.onSent('草稿已保存到「草稿箱」')
      } else if (!silent) {
        props.onError(result.error ?? '保存草稿失败')
      }
    } catch (err) {
      if (!silent) props.onError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const close = async (): Promise<void> => {
    if (dirty) {
      await doSaveDraft(true)
    }
    props.onClose()
  }

  return (
    <div className="overlay">
      <div className="dialog" style={{ width: '78vw', maxWidth: 980, height: '82vh' }}>
        <div className="dialog-head">
          <span>{form.draftId ? '编辑草稿' : '写邮件'}</span>
          <span className="spacer" />
          {dirty && <span className="draftflag">● 未保存</span>}
          <button className="iconbtn" title="关闭" onClick={() => void close()}>
            <Icon name="close" size={12} />
          </button>
        </div>

        <div className="composer">
          <div className="compose-row">
            <label>发件人</label>
            <select
              style={{ flex: 1, height: 26, border: 'none', background: 'transparent', outline: 'none' }}
              value={form.accountId}
              onChange={(e) => switchAccount(Number(e.target.value))}
            >
              {props.accounts
                .filter((a) => !a.isLocal)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName ? `${a.displayName} <${a.email}>` : a.email}
                  </option>
                ))}
            </select>
            <button className="iconbtn" onClick={() => setShowCc((v) => !v)} title="显示抄送/密送">
              {showCc ? '收起抄送' : '抄送/密送'}
            </button>
            {/*
              富文本 / 纯文本切换。
              放在「发件人」这一行：它决定的是整封邮件的格式，
              和抄送那种「显示哪些字段」的开关在语义上不同，但都只影响这封信。
            */}
            <button
              className={`iconbtn${rich ? ' on' : ''}`}
              title={
                rich
                  ? '当前是富文本（HTML）格式，点击改为纯文本'
                  : '当前是纯文本格式，点击改为富文本（可加粗、变色、列表）'
              }
              onClick={() => setMode(!rich)}
            >
              {rich ? '富文本' : '纯文本'}
            </button>
          </div>

          <div className="compose-row">
            <label>收件人</label>
            <AddressField
              name="to"
              value={form.to}
              onChange={(v) => patch({ to: v })}
              placeholder="多个地址用逗号分隔，输入时会联想地址簿"
            />
          </div>

          {showCc && (
            <>
              <div className="compose-row">
                <label>抄送</label>
                <AddressField
                  name="cc"
                  value={form.cc}
                  onChange={(v) => patch({ cc: v })}
                  placeholder="抄送"
                />
              </div>
              <div className="compose-row">
                <label>密送</label>
                <AddressField
                  name="bcc"
                  value={form.bcc}
                  onChange={(v) => patch({ bcc: v })}
                  placeholder="密送"
                />
              </div>
            </>
          )}

          <div className="compose-row">
            <label>主题</label>
            <input value={form.subject} onChange={(e) => patch({ subject: e.target.value })} />
          </div>

          {form.attachments.length > 0 && (
            <div className="attachbar" style={{ borderBottom: '1px solid var(--border)' }}>
              {form.attachments.map((a, i) => (
                <span className="attachchip" key={`${a.path}-${i}`}>
                  <Icon name="paperclip" size={13} />
                  <span className="fname">{a.filename}</span>
                  <button
                    className="iconbtn"
                    title="移除"
                    onClick={() =>
                      patch({ attachments: form.attachments.filter((_, idx) => idx !== i) })
                    }
                  >
                    <Icon name="close" size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="compose-body">
            {rich ? (
              <RichEditor
                ref={editorRef}
                initialHtml={htmlRef.current}
                onNotify={props.onError}
                onChange={() => {
                  setDirty(true)
                }}
              />
            ) : (
              <textarea
                ref={bodyRef}
                value={form.body}
                onChange={(e) => {
                  textRef.current = e.target.value
                  plainDirtyRef.current = true
                  patch({ body: e.target.value })
                }}
                placeholder="在这里写正文…"
              />
            )}
          </div>
        </div>

        <div className="dialog-foot">
          <button className="btn" onClick={() => void addAttachments()}>
            <Icon name="paperclip" size={13} /> 添加附件
          </button>
          <button className="btn" disabled={saving} onClick={() => void doSaveDraft()}>
            {saving ? '保存中…' : '存草稿'}
          </button>
          <span className="spacer" style={{ flex: 1 }} />
          <button className="btn" onClick={() => void close()}>
            取消
          </button>
          <button className="btn primary" disabled={sending} onClick={() => void doSend()}>
            {sending ? '发送中…' : '发送'}
          </button>
        </div>
      </div>
    </div>
  )
}
