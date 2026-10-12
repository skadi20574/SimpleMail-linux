import { useMemo, useState } from 'react'
import type { AttachmentMeta, MailDetail } from '../api'
import { formatFullDate, formatSize, prepareHtmlBody, wrapHtmlDocument } from '../utils'
import Icon from './Icon'

interface Props {
  mail: MailDetail | null
  allowRemoteImages: boolean
  onToggleRemote: () => void
  onReply: (mail: MailDetail) => void
  onReplyAll: (mail: MailDetail) => void
  onForward: (mail: MailDetail) => void
  onOpenAttachment: (id: number) => void
  onSaveAttachment: (id: number) => void
  onRevealAttachment: (id: number) => void
  onToggleFlag: (mail: MailDetail) => void
}

export default function MailView(props: Props): JSX.Element {
  const { mail } = props
  const [showHeaders, setShowHeaders] = useState(false)

  const doc = useMemo(() => {
    if (!mail) return ''
    if (mail.bodyHtml) {
      return wrapHtmlDocument(
        prepareHtmlBody(mail.bodyHtml, mail.attachments, props.allowRemoteImages)
      )
    }
    return ''
  }, [mail, props.allowRemoteImages])

  if (!mail) {
    return (
      <div className="empty">
        <div className="big">
          <Icon name="mail" size={44} />
        </div>
        <div>从上方列表选择一封邮件进行阅读</div>
        <div style={{ fontSize: 11.5 }}>所有邮件都保存在本地，断网也能查看</div>
      </div>
    )
  }

  const attachments: AttachmentMeta[] = mail.attachments.filter((a) => !a.isInline)

  return (
    <div className="preview">
      <div className="preview-head">
        <div className="preview-subject">{mail.subject || '(无主题)'}</div>
        <div className="preview-meta">
          <span className="k">发件人</span>
          <span className="v" title={mail.fromAddr}>
            {mail.fromName ? `${mail.fromName} <${mail.fromAddr}>` : mail.fromAddr}
          </span>
          <span className="k">收件人</span>
          <span className="v" title={mail.toText}>
            {mail.toText || '(无)'}
          </span>
          {mail.ccText && (
            <>
              <span className="k">抄送</span>
              <span className="v" title={mail.ccText}>
                {mail.ccText}
              </span>
            </>
          )}
          <span className="k">时间</span>
          <span className="v">
            {formatFullDate(mail.date)}
            {mail.archiveTag && (
              <span className="tag" style={{ marginLeft: 8 }}>
                存档：{mail.archiveTag}
              </span>
            )}
          </span>
        </div>

        <div style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
          <button className="btn" onClick={() => props.onReply(mail)}>
            回复
          </button>
          <button className="btn" onClick={() => props.onReplyAll(mail)}>
            回复全部
          </button>
          <button className="btn" onClick={() => props.onForward(mail)}>
            转发
          </button>
          <button className="btn" onClick={() => props.onToggleFlag(mail)}>
            {mail.flagged ? '取消星标' : '加星标'}
          </button>
          <span className="spacer" style={{ flex: 1 }} />
          {mail.bodyHtml && (
            <button className="btn" onClick={props.onToggleRemote} title="远程图片可能是跟踪像素">
              {props.allowRemoteImages ? '禁止远程图片' : '显示远程图片'}
            </button>
          )}
          <button className="btn" onClick={() => setShowHeaders((v) => !v)}>
            {showHeaders ? '隐藏原始头' : '查看原始头'}
          </button>
        </div>
      </div>

      {showHeaders && (
        <div
          style={{
            flex: '0 0 auto',
            maxHeight: 200,
            overflow: 'auto',
            borderBottom: '1px solid var(--border)',
            background: '#fbfcfd',
            padding: '10px 16px'
          }}
        >
          <div className="mono" style={{ whiteSpace: 'pre-wrap' }}>
            {mail.rawHeaders || '(本地未保存原始头)'}
          </div>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="attachbar">
          <span style={{ color: 'var(--muted)', alignSelf: 'center' }}>
            附件（{attachments.length}）：
          </span>
          {attachments.map((a) => (
            <span
              key={a.id}
              className="attachchip"
              title={`${a.filename}\n点击打开，右键可另存为`}
              onClick={() => props.onOpenAttachment(a.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                props.onSaveAttachment(a.id)
              }}
            >
              <Icon name="paperclip" size={13} />
              <span className="fname">{a.filename}</span>
              <span className="fsize">{formatSize(a.size)}</span>
              <button
                className="iconbtn"
                title="在文件管理器中显示"
                onClick={(e) => {
                  e.stopPropagation()
                  props.onRevealAttachment(a.id)
                }}
              >
                <Icon name="folderOpen" size={13} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="preview-body">
        {mail.bodyHtml ? (
          <iframe
            title="邮件正文"
            sandbox="allow-same-origin"
            srcDoc={doc}
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="preview-text">{mail.bodyText || '(此邮件还没有下载正文，联网后同步即可补齐)'}</div>
        )}
      </div>
    </div>
  )
}
