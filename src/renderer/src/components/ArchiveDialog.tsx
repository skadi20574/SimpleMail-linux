import { useEffect, useState } from 'react'
import type {
  Account,
  ArchiveDetection,
  ArchiveInspection,
  ExportFormat,
  ExportProgress,
  Folder,
  ImportProgress
} from '../api'
import { api } from '../api'
import { formatSize } from '../utils'
import Icon from './Icon'

type Tab = 'import' | 'export' | 'inspect'

interface Props {
  accounts: Account[]
  folders: Folder[]
  initialMode: Tab
  initialAccountId?: number
  defaultArchiveTag: string
  onClose: () => void
  onDone: (message: string) => void
  onError: (message: string) => void
}

const KIND_LABEL: Record<string, string> = {
  'foxmail-fox': 'Foxmail 7.2 单文件存档（.fox）',
  'foxmail-boxind': '老版 Foxmail 存档（.box + .ind）',
  'foxmail-storage': 'Foxmail 7.2 数据目录（Storage + FMStorage.list）',
  zip: 'ZIP 压缩包',
  mbox: '标准 mbox',
  'eml-tree': '.eml 邮件集合',
  opaque: '未识别的容器（按通用雕刻处理）',
  unknown: '未知格式'
}

const FORMAT_LABEL: { key: ExportFormat; label: string; hint: string }[] = [
  { key: 'fox', label: '.fox 存档', hint: 'SimpleMail 自有容器，本程序可 100% 无损读回' },
  { key: 'boxind', label: '.box + .ind', hint: '老版 Foxmail 目录结构，可放回 Windows Foxmail' },
  { key: 'eml', label: '.eml 文件集', hint: '每封一个文件，最通用的交换格式' },
  { key: 'mbox', label: '.mbox', hint: 'Thunderbird / foxmail / mutt 都能导入' }
]

export default function ArchiveDialog(props: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>(props.initialMode)

  /* ── 导入状态 ── */
  const [sourcePath, setSourcePath] = useState('')
  const [detection, setDetection] = useState<ArchiveDetection | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [tag, setTag] = useState(props.defaultArchiveTag)
  const [targetAccountId, setTargetAccountId] = useState<number | undefined>(props.initialAccountId)
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)
  const [importSummary, setImportSummary] = useState<string | null>(null)

  /* ── 导出状态 ── */
  const [exportAccountId, setExportAccountId] = useState<number | undefined>(
    props.initialAccountId ?? props.accounts[0]?.id
  )
  const [selectedFolders, setSelectedFolders] = useState<Set<number>>(new Set())
  const [formats, setFormats] = useState<Set<ExportFormat>>(new Set(['fox', 'boxind', 'eml']))
  const [baseName, setBaseName] = useState(() => `SimpleMail存档_${new Date().toISOString().slice(0, 10)}`)
  const [outDir, setOutDir] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null)
  const [exportFiles, setExportFiles] = useState<string[]>([])
  const [exportErrors, setExportErrors] = useState<string[]>([])

  /* ── 体检状态 ── */
  const [inspectPath, setInspectPath] = useState('')
  const [inspection, setInspection] = useState<ArchiveInspection | null>(null)
  const [inspecting, setInspecting] = useState(false)

  useEffect(() => {
    const offImport = api.foxmail.onImportProgress(setImportProgress)
    const offExport = api.foxmail.onExportProgress(setExportProgress)
    void (async () => {
      const paths = await api.app.paths()
      setOutDir(paths.exports)
    })()
    return () => {
      offImport()
      offExport()
    }
  }, [])

  // 切换导出账户时，默认全选其文件夹
  useEffect(() => {
    const ids = props.folders.filter((f) => f.accountId === exportAccountId).map((f) => f.id)
    setSelectedFolders(new Set(ids))
  }, [exportAccountId, props.folders])

  const pickArchive = async (): Promise<void> => {
    const picked = await api.app.pickArchive()
    if (!picked) return
    setSourcePath(picked)
    setDetection(null)
    setImportSummary(null)
    setDetecting(true)
    try {
      const det = await api.foxmail.detect(picked)
      setDetection(det)
    } catch (err) {
      props.onError(err instanceof Error ? err.message : String(err))
    } finally {
      setDetecting(false)
    }
  }

  const startImport = async (): Promise<void> => {
    if (!sourcePath) return
    setImporting(true)
    setImportSummary(null)
    setImportProgress(null)
    try {
      const result = await api.foxmail.import({
        sourcePath,
        targetAccountId,
        archiveTag: tag
      })
      const lines = [
        `导入完成：新增 ${result.imported} 封，跳过重复 ${result.skipped} 封，失败 ${result.failed} 封。`,
        `识别为：${KIND_LABEL[result.detection.kind] ?? result.detection.kind}`
      ]
      if (result.errors.length) {
        lines.push('')
        lines.push('部分错误：')
        lines.push(...result.errors.slice(0, 8))
      }
      setImportSummary(lines.join('\n'))
      props.onDone(`存档导入完成，新增 ${result.imported} 封邮件`)
    } catch (err) {
      props.onError(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
    }
  }

  const startExport = async (): Promise<void> => {
    if (!exportAccountId) return
    if (!selectedFolders.size) {
      props.onError('请至少选择一个要导出的文件夹')
      return
    }
    if (!formats.size) {
      props.onError('请至少选择一种导出格式')
      return
    }
    setExporting(true)
    setExportFiles([])
    setExportErrors([])
    setExportProgress(null)
    try {
      const result = await api.foxmail.export({
        accountId: exportAccountId,
        folderIds: [...selectedFolders],
        outDir,
        baseName,
        formats: [...formats]
      })
      setExportFiles(result.files)
      setExportErrors(result.errors)
      props.onDone(`导出完成，共 ${result.exported} 封邮件、${result.files.length} 个文件`)
    } catch (err) {
      props.onError(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }

  const startInspect = async (): Promise<void> => {
    const picked = await api.app.pickArchive()
    if (!picked) return
    setInspectPath(picked)
    setInspecting(true)
    setInspection(null)
    try {
      const report = await api.foxmail.inspect(picked, true)
      setInspection(report)
    } catch (err) {
      props.onError(err instanceof Error ? err.message : String(err))
    } finally {
      setInspecting(false)
    }
  }

  const foldersOfExportAccount = props.folders.filter((f) => f.accountId === exportAccountId)

  return (
    <div className="overlay">
      <div className="dialog" style={{ width: 860, height: '86vh' }}>
        <div className="dialog-head">
          <span>Foxmail 存档导入 / 导出</span>
          <span className="spacer" />
          <button className="iconbtn" onClick={props.onClose}>
            <Icon name="close" size={12} />
          </button>
        </div>

        <div className="dialog-body">
          <div className="tabs">
            <button className={`tab${tab === 'import' ? ' active' : ''}`} onClick={() => setTab('import')}>
              导入存档
            </button>
            <button className={`tab${tab === 'export' ? ' active' : ''}`} onClick={() => setTab('export')}>
              导出存档
            </button>
            <button className={`tab${tab === 'inspect' ? ' active' : ''}`} onClick={() => setTab('inspect')}>
              存档体检
            </button>
          </div>

          {/* ───────────── 导入 ───────────── */}
          {tab === 'import' && (
            <>
              <div className="hint" style={{ marginBottom: 10 }}>
                支持：Foxmail 7.2 的 <b>.fox</b> 单文件存档、老版本的{' '}
                <b>mail/账户/*.box + .ind</b>、整个 Foxmail 数据目录（含{' '}
                <b>Storage/ + FMStorage.list</b>）、以及打包成 <b>.zip</b> 的以上任意一种。
                <br />
                格式由程序自动识别，<b>不需要你选择版本</b>；同一年份重复导入会自动跳过。
              </div>

              <div className="field">
                <label>存档位置</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={sourcePath}
                    placeholder="选择 .fox 文件，或 Foxmail 数据目录"
                    onChange={(e) => {
                      setSourcePath(e.target.value)
                      setDetection(null)
                    }}
                  />
                  <button className="btn" onClick={() => void pickArchive()}>
                    浏览…
                  </button>
                </div>
              </div>

              {detecting && (
                <div className="statusline info">
                  <span className="busy dark" /> 正在识别存档结构…
                </div>
              )}

              {detection && (
                <>
                  <div className="statusline ok">
                    <b>识别结果：{KIND_LABEL[detection.kind] ?? detection.kind}</b>
                    <div style={{ marginTop: 4 }}>{detection.detail}</div>
                    {detection.warnings.map((w, i) => (
                      <div key={i} style={{ marginTop: 4, color: 'var(--warn)' }}>
                        {w}
                      </div>
                    ))}
                  </div>

                  {detection.units.length > 0 && (
                    <div style={{ maxHeight: 200, overflow: 'auto', marginTop: 10 }}>
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th>文件夹</th>
                            <th>类型</th>
                            <th style={{ width: '40%' }}>来源</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detection.units.map((u, i) => (
                            <tr key={i}>
                              <td>{u.name}</td>
                              <td>{u.role}</td>
                              <td className="mono">{u.origin}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}

              <div className="row3" style={{ marginTop: 12 }}>
                <div className="field">
                  <label>导入到账户</label>
                  <select
                    value={targetAccountId ?? ''}
                    onChange={(e) =>
                      setTargetAccountId(e.target.value ? Number(e.target.value) : undefined)
                    }
                  >
                    <option value="">本地存档（推荐）</option>
                    {props.accounts
                      .filter((a) => !a.isLocal)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          合并到 {a.email}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="field">
                  <label>存档批次标签（便于按年份检索）</label>
                  <input type="text" value={tag} onChange={(e) => setTag(e.target.value)} />
                </div>
              </div>

              {importProgress && importing && (
                <>
                  <div className="progress">
                    <div
                      style={{
                        width: `${
                          importProgress.total
                            ? Math.round((importProgress.current / importProgress.total) * 100)
                            : 15
                        }%`
                      }}
                    />
                  </div>
                  <div className="hint">{importProgress.message}</div>
                </>
              )}

              {importSummary && (
                <div className="statusline ok">
                  <div style={{ whiteSpace: 'pre-wrap' }}>{importSummary}</div>
                </div>
              )}

              <div style={{ marginTop: 12 }}>
                <button
                  className="btn primary"
                  disabled={!sourcePath || importing}
                  onClick={() => void startImport()}
                >
                  {importing ? '正在导入…' : '开始导入'}
                </button>
              </div>
            </>
          )}

          {/* ───────────── 导出 ───────────── */}
          {tab === 'export' && (
            <>
              <div className="hint" style={{ marginBottom: 10 }}>
                为兼容不同场景，可以<b>同时导出多种格式</b>。推荐至少勾选{' '}
                <b>.fox</b>（本程序无损读回）与 <b>.eml</b>（Foxmail 可直接导入）。
              </div>

              <div className="row3">
                <div className="field">
                  <label>账户</label>
                  <select
                    value={exportAccountId ?? ''}
                    onChange={(e) => setExportAccountId(Number(e.target.value))}
                  >
                    {props.accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.displayName || a.email}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>存档名称</label>
                  <input type="text" value={baseName} onChange={(e) => setBaseName(e.target.value)} />
                </div>
              </div>

              <div className="field">
                <label>输出目录</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type="text" value={outDir} onChange={(e) => setOutDir(e.target.value)} />
                  <button
                    className="btn"
                    onClick={async () => {
                      const dir = await api.app.pickDirectory('选择导出目录')
                      if (dir) setOutDir(dir)
                    }}
                  >
                    浏览…
                  </button>
                </div>
              </div>

              <div className="field">
                <label>要导出的文件夹</label>
                <div className="chips">
                  {foldersOfExportAccount.map((f) => {
                    const on = selectedFolders.has(f.id)
                    return (
                      <label key={f.id} className={`chip${on ? ' on' : ''}`}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => {
                            const next = new Set(selectedFolders)
                            if (e.target.checked) next.add(f.id)
                            else next.delete(f.id)
                            setSelectedFolders(next)
                          }}
                        />
                        {f.name}（{f.total}）
                      </label>
                    )
                  })}
                  {!foldersOfExportAccount.length && (
                    <span className="hint">该账户下还没有文件夹</span>
                  )}
                </div>
              </div>

              <div className="field">
                <label>导出格式</label>
                <div className="chips">
                  {FORMAT_LABEL.map((f) => {
                    const on = formats.has(f.key)
                    return (
                      <label key={f.key} className={`chip${on ? ' on' : ''}`} title={f.hint}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => {
                            const next = new Set(formats)
                            if (e.target.checked) next.add(f.key)
                            else next.delete(f.key)
                            setFormats(next)
                          }}
                        />
                        {f.label}
                      </label>
                    )
                  })}
                </div>
                <div className="hint">
                  {[...formats]
                    .map((k) => FORMAT_LABEL.find((f) => f.key === k)?.hint)
                    .filter(Boolean)
                    .join('；')}
                </div>
              </div>

              {exporting && exportProgress && (
                <>
                  <div className="progress">
                    <div
                      style={{
                        width: `${
                          exportProgress.total
                            ? Math.round((exportProgress.current / exportProgress.total) * 100)
                            : 30
                        }%`
                      }}
                    />
                  </div>
                  <div className="hint">{exportProgress.message}</div>
                </>
              )}

              {exportFiles.length > 0 && (
                <div className="statusline ok">
                  <div>导出完成，共 {exportFiles.length} 个文件：</div>
                  <div className="mono" style={{ maxHeight: 120, overflow: 'auto', marginTop: 4 }}>
                    {exportFiles.slice(0, 20).map((f, i) => (
                      <div key={i}>{f}</div>
                    ))}
                    {exportFiles.length > 20 && <div>…以及另外 {exportFiles.length - 20} 个文件</div>}
                  </div>
                  <button
                    className="btn"
                    style={{ marginTop: 8 }}
                    onClick={() => {
                      const first = exportFiles[0]
                      const dir = first.slice(0, first.lastIndexOf('/'))
                      void api.app.openPath(dir)
                    }}
                  >
                    打开导出目录
                  </button>
                </div>
              )}

              {exportErrors.length > 0 && (
                <div className="statusline err">
                  <div>有 {exportErrors.length} 项导出失败：</div>
                  <div className="mono">{exportErrors.slice(0, 5).join('\n')}</div>
                </div>
              )}

              <div style={{ marginTop: 12 }}>
                <button className="btn primary" disabled={exporting} onClick={() => void startExport()}>
                  {exporting ? '正在导出…' : '开始导出'}
                </button>
              </div>
            </>
          )}

          {/* ───────────── 体检 ───────────── */}
          {tab === 'inspect' && (
            <>
              <div className="hint" style={{ marginBottom: 10 }}>
                如果某个存档导入的结果不对劲，可以先跑一次「体检」：它只读不写，
                会把文件头、识别结果、每个文件夹实际扫描到的邮件数和使用的解析策略列出来。
                把这份报告发回来，就能针对性定位私有格式的细节。
              </div>

              <button className="btn" disabled={inspecting} onClick={() => void startInspect()}>
                {inspecting ? '正在扫描…' : '选择存档并体检'}
              </button>

              {inspection && (
                <>
                  <div className="statusline info" style={{ marginTop: 12 }}>
                    <div>
                      <b>路径：</b>
                      <span className="mono">{inspection.path}</span>
                    </div>
                    <div>
                      <b>大小：</b>
                      {formatSize(inspection.size)}　<b>识别为：</b>
                      {KIND_LABEL[inspection.kind] ?? inspection.kind}
                    </div>
                    <div>
                      <b>说明：</b>
                      {inspection.detail}
                    </div>
                  </div>

                  <div className="field" style={{ marginTop: 10 }}>
                    <label>文件头 64 字节</label>
                    <div className="mono">{inspection.headHex}</div>
                    <div className="mono" style={{ color: 'var(--muted)' }}>
                      {inspection.headAscii}
                    </div>
                  </div>

                  <div className="field">
                    <label>各文件夹扫描结果</label>
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>文件夹</th>
                          <th style={{ width: 90 }} className="num">
                            邮件数
                          </th>
                          <th>解析策略</th>
                          <th>来源</th>
                        </tr>
                      </thead>
                      <tbody>
                        {inspection.scanned.map((s, i) => (
                          <tr key={i}>
                            <td>{s.name}</td>
                            <td className="num">{s.messages < 0 ? '—' : s.messages}</td>
                            <td className="mono">{s.strategy}</td>
                            <td className="mono">{s.origin}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {inspection.warnings.length > 0 && (
                    <div className="statusline err">
                      {inspection.warnings.map((w, i) => (
                        <div key={i}>{w}</div>
                      ))}
                    </div>
                  )}

                  <button
                    className="btn"
                    onClick={() => {
                      void navigator.clipboard.writeText(JSON.stringify(inspection, null, 2))
                      props.onDone('体检报告已复制到剪贴板')
                    }}
                  >
                    复制完整报告
                  </button>
                </>
              )}
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
