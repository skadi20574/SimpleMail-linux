import { useEffect, useMemo, useState } from 'react'
import type { Account, AppSettings, DataDirInfo, DataDirProgress, MailtoStatus } from '../api'
import { api } from '../api'
import { formatSize } from '../utils'
import Icon from './Icon'
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  bindingFromEvent,
  findShortcutConflicts,
  prettyBinding,
  resolveShortcuts
} from '@shared/shortcuts'
import type { ThemeMode } from '@shared/types'

type Tab = 'general' | 'shortcuts' | 'data' | 'about'

interface Props {
  accounts: Account[]
  settings: AppSettings
  onSettingsChange: (s: AppSettings) => void
  onClose: () => void
  onDone: (message: string) => void
  onError: (message: string) => void
}

interface Stats {
  mails: number
  accounts: number
  attachmentBytes: number
  attachmentCount: number
  dbBytes: number
  version: string
}

interface ArchiveRow {
  id: number
  tag: string
  sourcePath: string
  kind: string
  imported: number
  skipped: number
  failed: number
  createdAt: number
}

export default function SettingsDialog(props: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('general')
  const [s, setS] = useState<AppSettings>(props.settings)
  const [stats, setStats] = useState<Stats | null>(null)
  const [paths, setPaths] = useState<{ userData: string; database: string; attachments: string; exports: string } | null>(null)
  const [archives, setArchives] = useState<ArchiveRow[]>([])
  /** 正在录制新按键的动作 id（null = 没在录制） */
  const [recording, setRecording] = useState<string | null>(null)
  const [install, setInstall] = useState<{
    kind: 'deb' | 'appimage' | 'portable' | 'unknown'
    appPath: string
    dataDir: string
    manualCommand: string
    hasPkexec: boolean
  } | null>(null)
  const [uninstalling, setUninstalling] = useState(false)
  const [wiping, setWiping] = useState(false)
  /** 默认邮件程序（mailto:）的状态 */
  const [mailto, setMailto] = useState<MailtoStatus | null>(null)
  /** 数据目录位置与迁移状态 */
  const [dataDir, setDataDir] = useState<DataDirInfo | null>(null)
  const [migrating, setMigrating] = useState(false)
  const [migrateProgress, setMigrateProgress] = useState<DataDirProgress | null>(null)
  const [migratedFrom, setMigratedFrom] = useState<string | null>(null)
  const [mailtoLoading, setMailtoLoading] = useState(false)
  const [mailtoSetting, setMailtoSetting] = useState(false)
  /** 清除数据的界内确认（不用 window.prompt —— Electron 根本没实现它） */
  const [wipeConfirm, setWipeConfirm] = useState(false)
  const [wipeWord, setWipeWord] = useState('')

  const shortcuts = useMemo(() => resolveShortcuts(s), [s])
  const conflicts = useMemo(() => findShortcutConflicts(shortcuts), [shortcuts])

  /* 迁移进度（复制 GB 级数据时界面要有反馈） */
  useEffect(() => api.app.onDataDirProgress(setMigrateProgress), [])

  /* 录制新快捷键：只监听一次 keydown，按下什么就存什么 */
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(null)
        return
      }
      const binding = bindingFromEvent(e)
      if (!binding) return // 只按了修饰键，继续等
      void patch({ shortcuts: { ...shortcuts, [recording]: binding } })
      setRecording(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, shortcuts])

  useEffect(() => {
    void (async () => {
      const [st, p, ar, info, mt, dd] = await Promise.all([
        api.app.stats(),
        api.app.paths(),
        api.archives.list(),
        api.app.installInfo(),
        api.app.mailtoStatus(),
        api.app.dataDir()
      ])
      setStats(st)
      setPaths(p)
      setArchives(ar)
      setInstall(info)
      setMailto(mt)
      setDataDir(dd)
    })()
  }, [])

  /**
   * 清除本地数据。
   *
   * ⚠️ 这里曾经用 window.prompt() 让用户输入确认词 —— Electron **没有实现 prompt()**，
   * 它直接返回 null，于是判断短路、函数提前 return，按钮看起来「点了没反应」。
   * 现在改成界内的确认面板 + 输入框。
   */
  const doWipe = async (): Promise<void> => {
    if (wipeWord !== 'DELETE') return
    setWiping(true)
    try {
      const r = await api.app.wipeData()
      if (!r.ok) {
        props.onError(r.error ?? '清除失败')
        return
      }
      props.onDone('本地数据已清除，程序即将重启')
      await api.app.restart()
    } finally {
      setWiping(false)
      setWipeConfirm(false)
      setWipeWord('')
    }
  }

  const patch = async (p: Partial<AppSettings>): Promise<void> => {
    const next = { ...s, ...p }
    setS(next)
    const saved = await api.settings.set(p)
    props.onSettingsChange(saved)
  }

  return (
    <div className="overlay">
      <div className="dialog" style={{ width: 720, height: '78vh' }}>
        <div className="dialog-head">
          <span>设置</span>
          <span className="spacer" />
          <button className="iconbtn" onClick={props.onClose}>
            <Icon name="close" size={12} />
          </button>
        </div>

        <div className="dialog-body">
          <div className="tabs">
            <button className={`tab${tab === 'general' ? ' active' : ''}`} onClick={() => setTab('general')}>
              常规
            </button>
            <button
              className={`tab${tab === 'shortcuts' ? ' active' : ''}`}
              onClick={() => setTab('shortcuts')}
            >
              快捷键
            </button>
            <button className={`tab${tab === 'data' ? ' active' : ''}`} onClick={() => setTab('data')}>
              数据与存档
            </button>
            <button className={`tab${tab === 'about' ? ' active' : ''}`} onClick={() => setTab('about')}>
              关于
            </button>
          </div>

          {tab === 'general' && (
            <>
              <div className="field">
                <label>界面主题</label>
                <div className="chips" style={{ marginBottom: 4 }}>
                  {(
                    [
                      { value: 'light', icon: 'sun', label: '浅色' },
                      { value: 'dark', icon: 'moon', label: '深色' },
                      { value: 'system', icon: 'autoTheme', label: '跟随系统' }
                    ] as { value: ThemeMode; icon: 'sun' | 'moon' | 'autoTheme'; label: string }[]
                  ).map((opt) => (
                    <label key={opt.value} className={`chip${s.theme === opt.value ? ' on' : ''}`}>
                      <input
                        type="radio"
                        name="theme"
                        checked={s.theme === opt.value}
                        onChange={() => void patch({ theme: opt.value })}
                      />
                      <Icon name={opt.icon} size={14} />
                      {opt.label}
                    </label>
                  ))}
                </div>
                <div className="hint">
                  「跟随系统」会跟着桌面环境的深浅色自动切换。工具栏上也有一个同样的切换按钮，
                  图标就是小太阳（浅色）、月亮（深色）、半明半暗的圆（跟随系统）。
                </div>
              </div>

              <div className="field">
                <label style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={s.autoSyncOnStart}
                    onChange={(e) => void patch({ autoSyncOnStart: e.target.checked })}
                  />
                  启动后自动同步所有账户
                </label>
              </div>

              <div className="field">
                <label style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={s.allowRemoteImages}
                    onChange={(e) => void patch({ allowRemoteImages: e.target.checked })}
                  />
                  默认显示邮件中的远程图片
                </label>
                <div className="hint" style={{ marginLeft: 22 }}>
                  关闭更安全：远程图片常被用作「是否已读」的跟踪像素。阅读时随时可以临时打开。
                </div>
              </div>

              <div className="field">
                <label style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={s.autoDownloadBodies}
                    onChange={(e) => void patch({ autoDownloadBodies: e.target.checked })}
                  />
                  同步时后台补齐邮件正文与附件
                </label>
                <div className="hint" style={{ marginLeft: 22 }}>
                  打开后，本地会保存完整正文与附件；关闭则只同步邮件列表，正文在打开时按需下载。
                </div>
              </div>

              <div className="field">
                <label style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={s.autoMarkRead}
                    onChange={(e) => void patch({ autoMarkRead: e.target.checked })}
                  />
                  打开邮件后自动标记为已读
                </label>
                <div className="hint" style={{ marginLeft: 22 }}>
                  关掉之后，点开邮件不会改变已读状态；需要自己用右键菜单的
                  「标记为已读 / 标记为未读」或者按 <b>M</b> 键来改。
                  列表里<b>绿色圆点</b>表示未读，<b>灰色对勾</b>表示已读。
                </div>
              </div>

              <div className="row3">
                <div className="field">
                  <label>每个文件夹单次同步的邮件数</label>
                  <input
                    type="number"
                    min={50}
                    max={5000}
                    value={s.syncBatch}
                    onChange={(e) => void patch({ syncBatch: Number(e.target.value) || 500 })}
                  />
                  <div className="hint">首次同步大量邮件时，数字越大一次性抓得越多。</div>
                </div>
                <div className="field">
                  <label>列表每页加载数量</label>
                  <input
                    type="number"
                    min={50}
                    max={2000}
                    value={s.pageSize}
                    onChange={(e) => void patch({ pageSize: Number(e.target.value) || 200 })}
                  />
                </div>
              </div>

              <div className="field">
                <label>导入存档时的默认批次标签</label>
                <input
                  type="text"
                  value={s.defaultArchiveTag}
                  onChange={(e) => void patch({ defaultArchiveTag: e.target.value })}
                />
                <div className="hint">建议写成「Foxmail存档2024」这样，方便之后按年份筛查。</div>
              </div>
            </>
          )}


          {tab === 'shortcuts' && (
            <>
              <div className="statusline info" style={{ marginBottom: 12 }}>
                快捷键可以自己改：点右侧「修改」，然后直接按下你想要的键。
                单键操作（比如 <b>M</b>、<b>Delete</b>）在输入框里不会误触发；
                标了「输入框内也可用」的组合键（写邮件、回复、搜索）随时可用。
                同一组按键被分给多个动作时会标红提示。
              </div>

              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <button
                  className="btn"
                  onClick={() => void patch({ shortcuts: {} })}
                  title="恢复到出厂设置的全部按键"
                >
                  全部重置为默认
                </button>
                {conflicts.size > 0 && (
                  <span className="statusline err" style={{ margin: 0, flex: 1 }}>
                    <Icon name="warning" size={13} /> 有 {conflicts.size} 个动作的按键重复了，
                    重复时只有靠前的动作会生效
                  </span>
                )}
              </div>

              <table className="tbl">
                <thead>
                  <tr>
                    <th>动作</th>
                    <th style={{ width: 190 }}>当前按键</th>
                    <th style={{ width: 120 }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {SHORTCUT_ACTIONS.map((a) => (
                    <tr key={a.id} style={conflicts.has(a.id) ? { background: 'var(--danger-soft)' } : undefined}>
                      <td>
                        {a.label}
                        {a.allowInInput && (
                          <span className="tag" style={{ marginLeft: 6 }}>
                            输入框内也可用
                          </span>
                        )}
                        {a.hint && <div className="hint">{a.hint}</div>}
                      </td>
                      <td>
                        {recording === a.id ? (
                          <span style={{ color: 'var(--accent)' }}>请按下新的按键…（Esc 取消）</span>
                        ) : (
                          <kbd className="kbd">{prettyBinding(shortcuts[a.id] ?? '')}</kbd>
                        )}
                      </td>
                      <td>
                        <button
                          className="iconbtn"
                          onClick={() => setRecording(recording === a.id ? null : a.id)}
                        >
                          {recording === a.id ? '取消' : '修改'}
                        </button>
                        {shortcuts[a.id] !== DEFAULT_SHORTCUTS[a.id] && (
                          <button
                            className="iconbtn"
                            onClick={() =>
                              void patch({
                                shortcuts: { ...shortcuts, [a.id]: DEFAULT_SHORTCUTS[a.id] }
                              })
                            }
                          >
                            重置
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="field" style={{ marginTop: 14 }}>
                <label>多选与删除的语义</label>
                <div className="hint" style={{ lineHeight: 1.8 }}>
                  · <b>移到垃圾箱</b>是本地与 IMAP 服务器一起移动，可恢复；
                  选中的邮件超过 5 封时会先确认一次。
                  <br />
                  · <b>永久删除</b>会弹确认框，确认后本机数据库记录 + 磁盘上的附件文件一起删除；
                  IMAP 账户还会在服务器上把这几封移到垃圾箱，这样下次同步不会又冒出来。
                  <br />
                  · 在<b>垃圾箱</b>里按「移到垃圾箱」等同于永久删除（和多数客户端的习惯一致）。
                </div>
              </div>
            </>
          )}

          {tab === 'data' && (
            <>
              {stats && (
                <div className="statusline info">
                  <div>
                    本地共保存 <b>{stats.mails}</b> 封邮件，数据库 <b>{formatSize(stats.dbBytes)}</b>，
                    附件 <b>{stats.attachmentCount}</b> 个、合计 <b>{formatSize(stats.attachmentBytes)}</b>。
                  </div>
                  <div className="hint" style={{ marginTop: 4 }}>
                    这些数据永久保存在本机，程序不会自动清理或上传。
                  </div>
                </div>
              )}

              <div className="field" style={{ marginTop: 12 }}>
                <label>数据目录</label>
                {paths && (
                  <table className="tbl">
                    <tbody>
                      <tr>
                        <td style={{ width: 110 }}>程序数据</td>
                        <td className="mono">{paths.userData}</td>
                        <td style={{ width: 70 }}>
                          <button className="iconbtn" onClick={() => void api.app.openPath(paths.userData)}>
                            打开
                          </button>
                        </td>
                      </tr>
                      <tr>
                        <td>邮件数据库</td>
                        <td className="mono">{paths.database}</td>
                        <td>
                          <button className="iconbtn" onClick={() => void api.app.openPath(paths.userData)}>
                            打开
                          </button>
                        </td>
                      </tr>
                      <tr>
                        <td>附件目录</td>
                        <td className="mono">{paths.attachments}</td>
                        <td>
                          <button className="iconbtn" onClick={() => void api.app.openPath(paths.attachments)}>
                            打开
                          </button>
                        </td>
                      </tr>
                      <tr>
                        <td>导出目录</td>
                        <td className="mono">{paths.exports}</td>
                        <td>
                          <button className="iconbtn" onClick={() => void api.app.openPath(paths.exports)}>
                            打开
                          </button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </div>

              <div className="field">
                <label>数据存放位置</label>
                <div className="hint">
                  邮件全部保存在下面这个目录里。默认在系统盘（<code>~/.config/simplemail</code>），
                  邮件越收越多会把系统盘占满 —— 可以整体搬到别的磁盘。
                </div>

                {dataDir && (
                  <div className="statusline info" style={{ display: 'block', marginTop: 8 }}>
                    <div>
                      当前使用：<span className="mono">{dataDir.dataDir}</span>
                      {dataDir.custom ? (
                        <span style={{ color: 'var(--ok)' }}>　（自定义位置）</span>
                      ) : (
                        <span style={{ color: 'var(--muted)' }}>　（默认位置）</span>
                      )}
                    </div>
                    <div className="hint" style={{ marginTop: 4 }}>
                      数据库 {formatSize(dataDir.dbBytes)}。位置记录在
                      <code>{dataDir.pointerFile}</code>，它**不会**被一起搬走 ——
                      所以目标盘没挂载时程序仍能启动并提示你，而不是打不开。
                    </div>
                  </div>
                )}

                {migrating && (
                  <div className="statusline info" style={{ display: 'block', marginTop: 8 }}>
                    <div>{migrateProgress?.message ?? '正在迁移…'}</div>
                    <div className="hint" style={{ marginTop: 4 }}>
                      {migrateProgress ? `${migrateProgress.current} / ${migrateProgress.total}` : ''}
                    </div>
                  </div>
                )}

                {migratedFrom && (
                  <div className="statusline" style={{ display: 'block', marginTop: 8 }}>
                    <div>迁移完成。原目录里的数据**没有**被删除。</div>
                    <div className="hint" style={{ marginTop: 4 }}>
                      重启程序后就会使用新位置。要现在删掉原目录里的数据吗？
                      （只删本程序自己的文件，不动该目录里的其它内容）
                    </div>
                    <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                      <button
                        className="btn"
                        onClick={async () => {
                          const r = await api.app.dataDirRemoveOld(migratedFrom)
                          if (r.ok) {
                            props.onDone('已删除原数据目录里的数据')
                            setMigratedFrom(null)
                          } else {
                            props.onError(r.error ?? '删除失败')
                          }
                        }}
                      >
                        删除原数据
                      </button>
                      <button className="btn" onClick={() => setMigratedFrom(null)}>
                        保留（我自己处理）
                      </button>
                    </div>
                  </div>
                )}

                <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    className="btn"
                    disabled={migrating}
                    onClick={async () => {
                      const picked = await api.app.pickDirectory('选择数据存放目录')
                      if (!picked) return
                      const check = await api.app.dataDirCheck(picked)
                      if (!check.ok) {
                        props.onError(check.error ?? '这个目录不能用')
                        return
                      }
                      const needGb = ((check.needBytes ?? 0) / 1073741824).toFixed(2)
                      if (
                        !confirm(
                          `要把数据迁移到：\n${picked}\n\n` +
                            `需要复制约 ${needGb} GB，期间请不要关闭程序。\n` +
                            `原数据会保留，确认新目录可用之后再决定是否删除。\n\n继续吗？`
                        )
                      )
                        return

                      setMigrating(true)
                      setMigrateProgress(null)
                      try {
                        const r = await api.app.dataDirMigrate(picked)
                        if (r.ok && r.dataDir) {
                          setMigratedFrom(r.from ?? null)
                          setDataDir(await api.app.dataDir())
                          props.onDone('迁移完成，重启后生效')
                        } else {
                          props.onError(r.error ?? '迁移失败（原数据未改动）')
                        }
                      } finally {
                        setMigrating(false)
                        setMigrateProgress(null)
                      }
                    }}
                  >
                    <Icon name="folderOpen" size={14} />
                    {dataDir?.custom ? ' 更改数据位置…' : ' 迁移到其它位置…'}
                  </button>
                  {dataDir && (
                    <button
                      className="btn"
                      onClick={() => void api.app.openPath(dataDir.dataDir)}
                    >
                      打开当前目录
                    </button>
                  )}
                </div>
              </div>

              <div className="field">
                <label>存档导入记录</label>
                {archives.length === 0 ? (
                  <div className="hint">还没有导入过存档。</div>
                ) : (
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>批次</th>
                        <th>导入时间</th>
                        <th className="num">新增</th>
                        <th className="num">跳过</th>
                        <th className="num">失败</th>
                        <th style={{ width: '32%' }}>来源</th>
                      </tr>
                    </thead>
                    <tbody>
                      {archives.map((a) => (
                        <tr key={a.id}>
                          <td>{a.tag}</td>
                          <td>{new Date(a.createdAt).toLocaleString('zh-CN')}</td>
                          <td className="num">{a.imported}</td>
                          <td className="num">{a.skipped}</td>
                          <td className="num">{a.failed}</td>
                          <td className="mono">{a.sourcePath}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="field">
                <label>账户一览</label>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>邮箱</th>
                      <th>类型</th>
                      <th>IMAP</th>
                      <th>SMTP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {props.accounts.map((a) => (
                      <tr key={a.id}>
                        <td>{a.email}</td>
                        <td>{a.isLocal ? '本地存档' : 'IMAP/SMTP'}</td>
                        <td className="mono">{a.isLocal ? '—' : `${a.imapHost}:${a.imapPort}`}</td>
                        <td className="mono">{a.isLocal ? '—' : `${a.smtpHost}:${a.smtpPort}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {tab === 'about' && (
            <>
              {/* ── 默认邮件程序（mailto:） ── */}
              <div className="field">
                <label>系统邮件链接</label>
                <div className="hint">
                  让网页和文档里的「发送邮件」链接（<code>mailto:</code>）直接打开 SimpleMail
                  的写信窗口，而不是跳到浏览器或别的客户端。
                </div>
                {mailto ? (
                  <div className="statusline info" style={{ display: 'block', marginTop: 8 }}>
                    <div>
                      当前系统的邮件程序：
                      <b>{mailto.currentDefault || '（未设置）'}</b>
                      {mailto.isDefault && <span style={{ color: 'var(--ok)' }}> ← 就是 SimpleMail</span>}
                    </div>
                    {!mailto.declaresMailto && (
                      <div className="hint" style={{ marginTop: 4, color: 'var(--warn)' }}>
                        还没找到声明了 <code>x-scheme-handler/mailto</code> 的桌面项。
                        .deb 安装版由安装包提供；免安装版点下面的按钮会写一份到
                        <code>{mailto.userDesktopFile}</code>。
                      </div>
                    )}
                    {!mailto.xdgAvailable && (
                      <div className="hint" style={{ marginTop: 4, color: 'var(--danger)' }}>
                        系统里没有 <code>xdg-mime</code>（属于 xdg-utils 包），
                        无法在界面内切换。请手动执行：<code>{mailto.manualCommand}</code>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="hint">正在检测…</div>
                )}
                <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    className="btn"
                    disabled={mailtoSetting || !mailto?.canSetAutomatically || mailto?.isDefault}
                    onClick={async () => {
                      setMailtoSetting(true)
                      try {
                        const r = await api.app.mailtoSetDefault()
                        if (r.ok) {
                          props.onDone(r.message)
                          setMailto(await api.app.mailtoStatus())
                        } else {
                          props.onError(r.message)
                          setMailto(r.status)
                        }
                      } catch (err) {
                        props.onError(`设置失败：${(err as Error).message}`)
                      } finally {
                        setMailtoSetting(false)
                      }
                    }}
                  >
                    <Icon name="filter" size={14} />
                    {mailtoSetting
                      ? ' 正在设置…'
                      : mailto?.isDefault
                        ? ' 已经是默认邮件程序'
                        : ' 设为默认邮件程序'}
                  </button>
                  <button
                    className="btn"
                    disabled={mailtoLoading}
                    onClick={async () => {
                      setMailtoLoading(true)
                      setMailto(await api.app.mailtoStatus())
                      setMailtoLoading(false)
                    }}
                  >
                    <Icon name="sync" size={14} /> 重新检测
                  </button>
                </div>
                <div className="hint" style={{ marginTop: 6 }}>
                  只影响<b>当前用户</b>，随时可以在系统「默认应用」里改回去。
                  等价命令：<code>{mailto?.manualCommand ?? ''}</code>
                </div>
              </div>

              {/* ── 卸载与清理 ── */}
              <div className="field">
                <label>卸载</label>
                {install ? (
                  <>
                    <div className="statusline info" style={{ display: 'block' }}>
                      <div>
                        当前安装方式：
                        <b>
                          {install.kind === 'deb'
                            ? '.deb 安装包（系统包管理器管理）'
                            : install.kind === 'appimage'
                              ? 'AppImage 单文件'
                              : install.kind === 'portable'
                                ? '便携版（解压目录）'
                                : '未知'}
                        </b>
                      </div>
                      <div className="mono" style={{ marginTop: 4 }}>
                        {install.appPath}
                      </div>
                      {install.kind !== 'deb' && (
                        <div className="hint" style={{ marginTop: 4 }}>
                          这种情况没有安装记录，退出程序后删掉上面的文件/目录即可，
                          用不着卸载脚本。命令行：<code>{install.manualCommand}</code>
                        </div>
                      )}
                    </div>

                    {install.kind === 'deb' && (
                      <>
                        <div className="hint" style={{ marginTop: 6 }}>
                          会弹出系统的授权对话框，确认后执行 <code>apt-get remove simplemail</code>。
                          卸载只移除程序本身，<b>不会删掉你的邮件数据</b>（数据在下面的目录里）。
                        </div>
                        <button
                          className="btn danger"
                          style={{ marginTop: 8 }}
                          disabled={uninstalling || !install.hasPkexec}
                          onClick={async () => {
                            if (
                              !confirm(
                                '确定要卸载 SimpleMail 吗？\n\n' +
                                  '· 会弹出系统授权对话框，需要输入密码\n' +
                                  '· 卸载后程序文件会被删除，程序随即退出\n' +
                                  '· 你的邮件数据会保留，如需一并删除请先用下面的「清除本地数据」'
                              )
                            )
                              return
                            setUninstalling(true)
                            const r = await api.app.uninstall()
                            setUninstalling(false)
                            if (!r.ok) props.onError(r.error ?? '卸载失败')
                          }}
                        >
                          <Icon name="uninstall" size={14} />
                          {uninstalling ? ' 正在卸载…' : ' 卸载 SimpleMail'}
                        </button>
                        {!install.hasPkexec && (
                          <div className="hint" style={{ marginTop: 6, color: 'var(--danger)' }}>
                            系统里没有 pkexec，无法在界面内提权。请在终端执行：
                            <code>{install.manualCommand}</code>
                          </div>
                        )}
                      </>
                    )}
                  </>
                ) : (
                  <div className="hint">正在检测安装方式…</div>
                )}
              </div>

              <div className="field">
                <label>清除本地数据</label>
                <div className="hint">
                  删除邮件数据库、全部附件文件与导出目录（<code>{install?.dataDir ?? ''}</code>）。
                  这个操作<b>不可撤销</b>，清完程序会自动重启到一个空数据库。
                  想留个底的话，先用工具栏的「导出存档」导出一份 .fox。
                </div>
                {!wipeConfirm ? (
                  <button
                    className="btn danger"
                    style={{ marginTop: 8 }}
                    disabled={wiping}
                    onClick={() => {
                      setWipeConfirm(true)
                      setWipeWord('')
                    }}
                  >
                    <Icon name="database" size={14} />
                    清除全部本地数据
                  </button>
                ) : (
                  <div className="statusline err" style={{ display: 'block', marginTop: 8 }}>
                    <div>
                      <Icon name="warning" size={13} /> 这会删除本机保存的全部邮件与附件，
                      <b>无法恢复</b>。想留底请先用工具栏的「导出存档」导出一份。
                    </div>
                    <div style={{ marginTop: 8 }}>
                      请输入 <b>DELETE</b> 确认：
                    </div>
                    <input
                      type="text"
                      value={wipeWord}
                      autoFocus
                      placeholder="DELETE"
                      style={{ marginTop: 6 }}
                      onChange={(e) => setWipeWord(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && wipeWord === 'DELETE') void doWipe()
                        if (e.key === 'Escape') {
                          setWipeConfirm(false)
                          setWipeWord('')
                        }
                      }}
                    />
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button
                        className="btn"
                        onClick={() => {
                          setWipeConfirm(false)
                          setWipeWord('')
                        }}
                      >
                        取消
                      </button>
                      <button
                        className="btn danger"
                        disabled={wipeWord !== 'DELETE' || wiping}
                        onClick={() => void doWipe()}
                      >
                        {wiping ? '正在清除…' : '确认清除全部数据'}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="statusline info" style={{ marginTop: 4 }}>
                <b>SimpleMail {stats?.version ?? ''}</b>
                <div className="hint" style={{ marginTop: 4 }}>
                  本地优先的开源邮件客户端，以 MIT 许可发布。所有邮件都存在你自己电脑上的
                  SQLite 数据库里，附件存在应用数据目录；除了你自己配置的 IMAP/POP3/SMTP
                  服务器，程序不会向任何地方上传数据。
                </div>
              </div>

              <div className="field" style={{ marginTop: 12 }}>
                <label>知识产权说明</label>
                <div className="hint" style={{ lineHeight: 1.75 }}>
                  · 本项目为独立实现，<b>未使用</b> Foxmail、Outlook
                  或其他商业邮件客户端的商标、图标、界面素材或任何专有代码。
                  <br />
                  · 名称、图标、配色均为原创（图标是代码绘制的线条 SVG），以 MIT 许可开源。
                  <br />
                  · 对 Foxmail 存档格式的支持，是通过公开资料与对用户自有数据文件的兼容性分析实现的，
                  目的是让用户能够读取<b>自己</b>的历史邮件；不包含 Foxmail 的任何程序代码。
                  <br />· 内置的邮件解析、搜索、界面均基于开源组件（Electron、React、imapflow、nodemailer、
                  mailparser 等），各自遵循其原始许可证。
                </div>
              </div>

              <div className="field">
                <label>开源组件</label>
                <div className="hint">
                  Electron（MIT）· React（MIT）· imapflow（MIT）· nodemailer（MIT）·
                  mailparser（MIT）· iconv-lite（MIT）· SQLite（Public Domain，
                  由 Electron 内置的 Node.js 提供，含 FTS5 全文检索）
                </div>
              </div>
            </>
          )}
        </div>

        <div className="dialog-foot">
          <button className="btn" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
