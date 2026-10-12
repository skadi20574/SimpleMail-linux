import { useMemo, useState } from 'react'
import type { Account, Folder, FolderRole } from '../api'
import { folderIcon, ROLE_ORDER } from '../utils'
import Icon from './Icon'

interface Props {
  accounts: Account[]
  folders: Folder[]
  selectedFolderId: number | null
  collapsed: Set<number>
  onToggleCollapse: (accountId: number) => void
  onSelectFolder: (folder: Folder) => void
  onAddAccount: () => void
  onEditAccount: (account: Account) => void
  onSync: (accountId: number) => void
  onImportArchive: (accountId?: number) => void
  onExportArchive: (accountId: number) => void
  /** 右键文件夹：交给主进程弹原生菜单 */
  onFolderContextMenu: (folder: Folder, event: React.MouseEvent) => void
  /** 把正在拖拽的邮件放进这个文件夹 */
  onDropMails: (folderId: number) => void
  /** 新建文件夹；parentId 为 null 表示建在账户根下 */
  onCreateFolder: (accountId: number, parentId: number | null) => void
  stats: string
  /** 应用版本号，来自主进程，避免在界面上硬编码 */
  version: string
}

export default function Sidebar(props: Props): JSX.Element {
  /** 当前被拖拽悬停的文件夹（高亮用） */
  const [dropTarget, setDropTarget] = useState<number | null>(null)

  const grouped = useMemo(() => {
    const map = new Map<number, Folder[]>()
    for (const f of props.folders) {
      const list = map.get(f.accountId) ?? []
      list.push(f)
      map.set(f.accountId, list)
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        const ra = ROLE_ORDER.indexOf(a.role as FolderRole)
        const rb = ROLE_ORDER.indexOf(b.role as FolderRole)
        if (ra !== rb) return ra - rb
        return a.name.localeCompare(b.name, 'zh-CN')
      })
    }
    return map
  }, [props.folders])

  return (
    <div className="sidebar">
      <div className="sidebar-scroll">
        {props.accounts.map((account) => {
          const list = grouped.get(account.id) ?? []
          const collapsed = props.collapsed.has(account.id)
          const unread = list.reduce((sum, f) => sum + f.unread, 0)
          return (
            <div className="acct" key={account.id}>
              <div
                className="acct-head"
                onClick={() => props.onToggleCollapse(account.id)}
                title={account.email}
              >
                <span className="dot" style={{ background: account.color || '#2f7fd8' }} />
                <span className="name">
                  {collapsed ? '▸ ' : '▾ '}
                  {account.displayName || account.email}
                  {account.isLocal ? '（本地）' : ''}
                </span>
                {unread > 0 && <span className="badge">{unread > 999 ? '999+' : unread}</span>}
                <span className="acts" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="iconbtn"
                    title="在这个账户下新建文件夹"
                    onClick={() => props.onCreateFolder(account.id, null)}
                  >
                    ＋
                  </button>
                  {!account.isLocal && (
                    <button
                      className="iconbtn"
                      title="立即同步"
                      onClick={() => props.onSync(account.id)}
                    >
                      <Icon name="sync" size={13} />
                    </button>
                  )}
                  <button
                    className="iconbtn"
                    title="编辑账户"
                    onClick={() => props.onEditAccount(account)}
                  >
                    <Icon name="settings" size={13} />
                  </button>
                  <button
                    className="iconbtn"
                    title="导入存档到本账户"
                    onClick={() => props.onImportArchive(account.id)}
                  >
                    <Icon name="import" size={13} />
                  </button>
                  <button
                    className="iconbtn"
                    title="导出本账户存档"
                    onClick={() => props.onExportArchive(account.id)}
                  >
                    <Icon name="export" size={13} />
                  </button>
                </span>
              </div>

              {!collapsed &&
                list.map((folder) => (
                  <div
                    key={folder.id}
                    className={`folder${props.selectedFolderId === folder.id ? ' active' : ''}${
                      dropTarget === folder.id ? ' drop-target' : ''
                    }`}
                    onClick={() => props.onSelectFolder(folder)}
                    onContextMenu={(e) => props.onFolderContextMenu(folder, e)}
                    title={`${folder.path || folder.name}（共 ${folder.total} 封）\n右键可新建 / 重命名 / 删除；也可以把邮件拖进来`}
                    onDragOver={(e) => {
                      // 必须 preventDefault，否则浏览器不认这是个可放置目标
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      if (dropTarget !== folder.id) setDropTarget(folder.id)
                    }}
                    onDragLeave={() => setDropTarget((cur) => (cur === folder.id ? null : cur))}
                    onDrop={(e) => {
                      e.preventDefault()
                      setDropTarget(null)
                      props.onDropMails(folder.id)
                    }}
                  >
                    <span className="fico">
                      <Icon name={folderIcon(folder.role as FolderRole)} size={14} />
                    </span>
                    <span className="fname">{folder.name}</span>
                    <span className={`badge${folder.unread ? '' : ' zero'}`}>
                      {folder.unread > 999 ? '999+' : folder.unread}
                    </span>
                  </div>
                ))}

              {!collapsed && list.length === 0 && (
                <div className="folder" style={{ color: 'var(--muted)', paddingLeft: 22 }}>
                  <span className="fico" />
                  <span className="fname">还没有文件夹</span>
                </div>
              )}
            </div>
          )
        })}

        <div style={{ padding: '8px 10px' }}>
          <button className="btn" style={{ width: '100%' }} onClick={props.onAddAccount}>
            <Icon name="account" size={14} /> 添加邮箱账户
          </button>
        </div>
      </div>

      <div className="sidebar-foot">
        <span>{props.stats}</span>
        <span>v{props.version && props.version !== '0.0.0' ? props.version : __APP_VERSION__}</span>
      </div>
    </div>
  )
}
