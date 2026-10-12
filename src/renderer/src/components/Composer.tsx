import { useEffect, useMemo, useRef, useState } from 'react'
import type { Account, ComposeAttachment, ComposePayload, MailDetail } from '../api'
import { api } from '../api'
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

/** 由「回复/回复全部/转发」生成初始内容 */
export function buildReplyInit(
  accountId: number,
  mail: MailDetail,
  mode: 'reply' | 'replyAll' | 'forward',
  signature: string
): ComposeInit {
  const sig = signature ? `\n\n--\n${signature}` : ''
  const quotedHeader =
    `\n\n------------------ 原始邮件 ------------------\n` +
    `发件人: ${mail.fromName ? `${mail.fromName} <${mail.fromAddr}>` : mail.fromAddr}\n` +
    `时间: ${formatFullDate(mail.date)}\n` +
    `收件人: ${mail.toText}\n` +
    (mail.ccText ? `抄送: ${mail.ccText}\n` : '') +
    `主题: ${mail.subject}\n\n`
  const quotedBody = (mail.bodyText || '').split('\n').map((l) => `> ${l}`).join('\n')

  if (mode === 'forward') {
    return {
      accountId,
      to: '',
      cc: '',
      bcc: '',
      subject: forwardSubject(mail.subject),
      body: `${sig}\n\n${quotedHeader}${mail.bodyText || ''}`,
      attachments: []
    }
  }

  const to = mode === 'replyAll' ? [mail.fromAddr, ...mail.toText.split(',')].join(', ') : mail.fromAddr
  const cc = mode === 'replyAll' ? mail.ccText : ''

  return {
    accountId,
    to: shortAddress(to),
    cc: shortAddress(cc),
    bcc: '',
    subject: replySubject(mail.subject),
    body: `${sig}\n\n${quotedHeader}${quotedBody}`,
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

  // 打开时自动根据签名/账户变化重置（切换账户时重新套用签名）
  const account = useMemo(
    () => props.accounts.find((a) => a.id === form.accountId) ?? props.accounts[0],
    [props.accounts, form.accountId]
  )

  useEffect(() => {
    bodyRef.current?.focus()
  }, [])

  const patch = (p: Partial<ComposeInit>): void => {
    setForm((f) => ({ ...f, ...p }))
    setDirty(true)
  }

  const switchAccount = (accountId: number): void => {
    const next = props.accounts.find((a) => a.id === accountId)
    if (!next) return
    // 换账户时把旧签名摘掉、套上新签名
    const oldSig = account?.signature
    let body = form.body
    if (oldSig) {
      const marker = `\n\n--\n${oldSig}`
      if (body.includes(marker)) body = body.replace(marker, '')
    }
    const newSig = next.signature ? `\n\n--\n${next.signature}` : ''
    patch({ accountId, body: `${body}${newSig}` })
  }

  const addAttachments = async (): Promise<void> => {
    const picked = await api.attachments.pick()
    if (!picked.length) return
    const existing = new Set(form.attachments.map((a) => a.path))
    const merged = [...form.attachments, ...picked.filter((p) => !existing.has(p.path))]
    patch({ attachments: merged })
  }

  const buildPayload = (saveAsDraft: boolean): ComposePayload => ({
    accountId: form.accountId,
    draftId: form.draftId,
    to: form.to,
    cc: form.cc,
    bcc: form.bcc,
    subject: form.subject,
    text: form.body,
    html: form.html ?? null,
    inReplyTo: form.inReplyTo ?? null,
    references: form.references ?? null,
    attachments: form.attachments,
    saveAsDraft
  })

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
          </div>

          <div className="compose-row">
            <label>收件人</label>
            <input
              value={form.to}
              onChange={(e) => patch({ to: e.target.value })}
              placeholder="多个地址用逗号分隔，例如 a@qq.com, b@163.com"
            />
          </div>

          {showCc && (
            <>
              <div className="compose-row">
                <label>抄送</label>
                <input value={form.cc} onChange={(e) => patch({ cc: e.target.value })} />
              </div>
              <div className="compose-row">
                <label>密送</label>
                <input value={form.bcc} onChange={(e) => patch({ bcc: e.target.value })} />
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
            <textarea
              ref={bodyRef}
              value={form.body}
              onChange={(e) => patch({ body: e.target.value })}
              placeholder="在这里写正文…"
            />
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
