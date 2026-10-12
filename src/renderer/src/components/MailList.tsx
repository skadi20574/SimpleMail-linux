import { useMemo } from 'react'
import type { MailSummary } from '../api'
import { formatListDate, highlightParts } from '../utils'
import Icon from './Icon'

interface Props {
  title: string
  mails: MailSummary[]
  total: number
  /** 多选：所有高亮的邮件 id */
  selectedIds: Set<number>
  /** 当前「活动」邮件（下方面板显示的那封，也是键盘上下移动的游标） */
  activeId: number | null
  loading: boolean
  searchTerms: string[]
  showAccount: boolean
  orderBy: 'relevance' | 'date' | 'subject' | 'from'
  orderDir: 'asc' | 'desc'
  /** 是否处于搜索状态：只有搜索时才有「相关度」这一维 */
  isSearching: boolean
  onChangeOrder: (by: 'relevance' | 'date' | 'subject' | 'from', dir: 'asc' | 'desc') => void
  /** 单击行；带上事件以便识别 Ctrl / Shift 组合键 */
  onRowClick: (mail: MailSummary, event: React.MouseEvent) => void
  /** 双击整行：在新窗口打开这封邮件 */
  onRowDoubleClick: (mail: MailSummary) => void
  /** 右键整行：弹出原生菜单 */
  onRowContextMenu: (mail: MailSummary, event: React.MouseEvent) => void
  /** 开始拖拽整行（把它拖到左侧文件夹上即可移动） */
  onRowDragStart: (mail: MailSummary) => void
  /** 点击行首复选框：单独切换一封 */
  onToggle: (mail: MailSummary) => void
  /** 表头复选框：全选 / 取消全选 */
  onSelectAll: (select: boolean) => void
  onLoadMore: () => void
}

function Hl({ text, terms }: { text: string; terms: string[] }): JSX.Element {
  const parts = useMemo(() => highlightParts(text, terms), [text, terms])
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="hl">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </>
  )
}

export default function MailList(props: Props): JSX.Element {
  const { mails, total, activeId, selectedIds } = props

  const allSelected = mails.length > 0 && mails.every((m) => selectedIds.has(m.id))
  const someSelected = !allSelected && mails.some((m) => selectedIds.has(m.id))

  const toggleSort = (by: 'relevance' | 'date' | 'subject' | 'from'): void => {
    // 相关度是 bm25 算出来的，没有「升/降序」的概念，点一下就是用它
    if (by === 'relevance') {
      props.onChangeOrder('relevance', 'desc')
      return
    }
    if (props.orderBy === by) {
      props.onChangeOrder(by, props.orderDir === 'desc' ? 'asc' : 'desc')
    } else {
      props.onChangeOrder(by, 'desc')
    }
  }

  const arrow = (by: 'relevance' | 'date' | 'subject' | 'from'): string => {
    if (props.orderBy !== by) return ''
    if (by === 'relevance') return ' •'
    return props.orderDir === 'desc' ? ' ↓' : ' ↑'
  }

  return (
    <div className="listwrap" style={{ flex: 1 }}>
      <div className="listhead">
        <input
          type="checkbox"
          className="rowcheck"
          checked={allSelected}
          ref={(el) => {
            if (el) el.indeterminate = someSelected
          }}
          onChange={(e) => props.onSelectAll(e.target.checked)}
          title="全选 / 取消全选（Ctrl+A）"
        />
        <span className="title">{props.title}</span>
        <span className="count">
          共 {total} 封{mails.length < total ? `，已显示 ${mails.length}` : ''}
          {selectedIds.size > 1 ? `　已选中 ${selectedIds.size} 封` : ''}
        </span>
        <span className="spacer" />
        {props.loading && <span className="busy dark" />}
        {props.isSearching && (
          <button
            className="iconbtn"
            title="按匹配度排序（bm25，匹配度最高的排最前）"
            onClick={() => toggleSort('relevance')}
          >
            相关度{arrow('relevance')}
          </button>
        )}
        <button className="iconbtn" title="按发件人排序" onClick={() => toggleSort('from')}>
          发件人{arrow('from')}
        </button>
        <button className="iconbtn" title="按主题排序" onClick={() => toggleSort('subject')}>
          主题{arrow('subject')}
        </button>
        <button className="iconbtn" title="按时间排序" onClick={() => toggleSort('date')}>
          时间{arrow('date')}
        </button>
      </div>

      <div
        className="mailrows"
        onScroll={(e) => {
          const el = e.currentTarget
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) props.onLoadMore()
        }}
      >
        {mails.map((m) => {
          const selected = selectedIds.has(m.id)
          const active = activeId === m.id
          return (
            <div
              key={m.id}
              data-mail-id={m.id}
              className={`mailrow${m.unread ? ' unread' : ' read'}${selected ? ' selected' : ''}${
                active ? ' active' : ''
              }`}
              // 可拖到左侧文件夹上完成移动
              draggable
              onDragStart={(e) => {
                // 不设置数据的话 Chromium 不会启动拖拽
                e.dataTransfer.setData('text/plain', m.subject || '(无主题)')
                e.dataTransfer.effectAllowed = 'move'
                props.onRowDragStart(m)
              }}
              onClick={(e) => props.onRowClick(m, e)}
              onDoubleClick={() => props.onRowDoubleClick(m)}
              onContextMenu={(e) => props.onRowContextMenu(m, e)}
            >
              <span className="rowlead">
                {/*
                  三个格子各自独立，互不顶替：
                    [未读蓝点] [星标] [复选框]
                  之前蓝点和星标共用一个格子、并且「有星标就不显示蓝点」，
                  导致未读的星标邮件看起来和已读的一样，分不出状态。
                  三格都固定占位，鼠标划过出现复选框时文字也不会左右跳。
                */}
                {/*
                  未读 = 绿色圆点，已读 = 小对勾。
                  两种状态**都有**可见标记，一眼就能区分开，
                  而不是「未读有点、已读什么都没有」。
                */}
                <span className="slot slot-state" title={m.unread ? '未读' : '已读'}>
                  {m.unread ? (
                    <span className="unread-dot" />
                  ) : (
                    <Icon name="check" size={11} className="read-check" />
                  )}
                </span>
                <span className="slot slot-star" title={m.flagged ? '已加星标' : ''}>
                  {m.flagged ? <Icon name="star" size={11} className="star-on" /> : null}
                </span>
                <input
                  type="checkbox"
                  className="rowcheck"
                  checked={selected}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => props.onToggle(m)}
                  title="选中这封（配合 Ctrl / Shift 可多选）"
                />
              </span>
              <span className="from" title={m.fromAddr}>
                <Hl text={m.fromName || m.fromAddr || '(无发件人)'} terms={props.searchTerms} />
              </span>
              <span className="subject" title={m.subject}>
                {m.hasAttachments && (
                  <span className="clip" title="含附件">
                    <Icon name="paperclip" size={11} />{' '}
                  </span>
                )}
                <Hl text={m.subject || '(无主题)'} terms={props.searchTerms} />
                {props.showAccount && m.folderName && <span className="tag">{m.folderName}</span>}
              </span>
              <span className="date">{formatListDate(m.date)}</span>
            </div>
          )
        })}

        {!mails.length && !props.loading && (
          <div className="empty" style={{ height: 200 }}>
            <div className="big">
              <Icon name="mailbox" size={44} />
            </div>
            <div>这里还没有邮件</div>
          </div>
        )}
      </div>
    </div>
  )
}
