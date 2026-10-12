import { useEffect, useRef, useState } from 'react'
import type { MailDetail } from './api'
import { api } from './api'
import MailView from './components/MailView'
import Icon from './components/Icon'

/**
 * 双击邮件后打开的独立读信窗口。
 *
 * 与主窗口共用 MailView 组件，所以正文渲染、附件处理、安全策略
 * （沙箱 iframe、默认阻止远程图片）都完全一致，不会出现两套行为。
 * 回复 / 转发仍然回到主窗口去写 —— 这里只负责读。
 */
export default function MailWindow({ mailId }: { mailId: number }): JSX.Element {
  const [mail, setMail] = useState<MailDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [allowRemote, setAllowRemote] = useState(false)
  const [loading, setLoading] = useState(true)
  /** 独立窗口里没有写信界面，回复/转发给一条会自己消失的提示 */
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<number | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const settings = await api.settings.get()
        setAllowRemote(settings.allowRemoteImages)
        const detail = await api.mails.get(mailId)
        if (!detail) {
          setError('这封邮件已经不存在了（可能已被删除）')
          setLoading(false)
          return
        }
        setMail(detail)
        document.title = detail.subject ? `${detail.subject} — SimpleMail` : 'SimpleMail'
        if (detail.unread) {
          await api.mails.markRead(detail.id, false)
          setMail({ ...detail, unread: false })
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    })()
  }, [mailId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey) window.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /**
   * 回复 / 转发在独立窗口里没有写信界面，给一条界内提示。
   * （原来用的是 alert()，它会阻塞整个渲染进程，而且在独立窗口里很突兀。）
   */
  const hintReply = (): void => {
    setNotice('回复 / 转发请在主窗口操作：选中这封邮件后按 Ctrl+R，或点工具栏的按钮。')
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4000)
  }

  if (loading) {
    return (
      <div className="empty" style={{ height: '100vh' }}>
        <span className="busy dark" />
        <div>正在读取邮件…</div>
      </div>
    )
  }

  if (error || !mail) {
    return (
      <div className="empty" style={{ height: '100vh' }}>
        <div className="big">
          <Icon name="mailbox" size={44} />
        </div>
        <div>{error ?? '邮件不存在'}</div>
      </div>
    )
  }

  return (
    <div className="app" style={{ height: '100vh' }}>
      {notice && <div className="toast">{notice}</div>}
      <MailView
        mail={mail}
        allowRemoteImages={allowRemote}
        onToggleRemote={() => setAllowRemote((v) => !v)}
        onReply={() => hintReply()}
        onReplyAll={() => hintReply()}
        onForward={() => hintReply()}
        onOpenAttachment={(id) => void api.attachments.open(id)}
        onSaveAttachment={async (id) => {
          await api.attachments.saveAs(id)
        }}
        onRevealAttachment={(id) => void api.attachments.reveal(id)}
        onToggleFlag={async (m) => {
          await api.mails.markFlagged(m.id, !m.flagged)
          setMail({ ...m, flagged: !m.flagged })
        }}
      />
    </div>
  )
}
