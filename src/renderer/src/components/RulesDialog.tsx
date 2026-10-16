import { useEffect, useMemo, useState } from 'react'
import type {
  Account,
  Folder,
  Rule,
  RuleAction,
  RuleCondition,
  RuleDraft,
  RuleField,
  RuleOperator,
  RulePreview
} from '../api'
import { api } from '../api'
import Icon from './Icon'

const FIELD_OPTIONS: { value: RuleField; label: string }[] = [
  { value: 'from', label: '发件人地址' },
  { value: 'fromName', label: '发件人姓名' },
  { value: 'to', label: '收件人' },
  { value: 'cc', label: '抄送' },
  { value: 'subject', label: '主题' },
  { value: 'body', label: '正文' },
  { value: 'header', label: '指定邮件头' },
  { value: 'any', label: '任意字段' }
]

const OP_OPTIONS: { value: RuleOperator; label: string }[] = [
  { value: 'contains', label: '包含' },
  { value: 'notContains', label: '不包含' },
  { value: 'equals', label: '等于' },
  { value: 'startsWith', label: '开头是' },
  { value: 'endsWith', label: '结尾是' },
  { value: 'regex', label: '匹配正则' }
]

const ACTION_OPTIONS: { value: RuleAction; label: string; hint: string }[] = [
  { value: 'move', label: '移动到指定文件夹', hint: '最常见的归类方式，可随时手动移回来' },
  { value: 'trash', label: '移到垃圾箱', hint: '相当于自动按 Delete，仍然可以在垃圾箱里找回' },
  { value: 'mark_read', label: '标记为已读', hint: '适合过滤掉不需要关注的订阅 / 通知' },
  { value: 'flag', label: '加星标', hint: '把重要来源的邮件自动标出来' },
  { value: 'mark_read_move', label: '标记已读并移动', hint: '既归档又不再占用未读计数' },
  {
    value: 'delete',
    label: '永久删除（危险）',
    hint: '直接从本机删除且不弹确认框，附件文件也一并清掉。请先用「试运行」确认条件写对了'
  }
]

function emptyRule(): RuleDraft {
  return {
    name: '',
    enabled: true,
    priority: 100,
    accountId: null,
    matchMode: 'all',
    conditions: [{ field: 'from', op: 'contains', value: '' }],
    action: 'move',
    actionFolderId: null,
    stop: true
  }
}

function describeAction(rule: Rule | RuleDraft, folders: Folder[]): string {
  const folder = folders.find((f) => f.id === rule.actionFolderId)
  switch (rule.action) {
    case 'move':
      return `移动到「${folder?.name ?? '未选择文件夹'}」`
    case 'trash':
      return '移到垃圾箱'
    case 'delete':
      return '永久删除'
    case 'mark_read':
      return '标记已读'
    case 'flag':
      return '加星标'
    case 'mark_read_move':
      return `标记已读并移动到「${folder?.name ?? '未选择文件夹'}」`
    default:
      return rule.action
  }
}

function describeCondition(c: RuleCondition): string {
  const f = FIELD_OPTIONS.find((o) => o.value === c.field)?.label ?? c.field
  const o = OP_OPTIONS.find((x) => x.value === c.op)?.label ?? c.op
  return `${f} ${o}「${c.value}」`
}

interface Props {
  accounts: Account[]
  folders: Folder[]
  onClose: () => void
  onDone: (message: string) => void
  onError: (message: string) => void
  /** 规则可能移动/删除了邮件，需要刷新主界面 */
  onChanged: () => void
}

export default function RulesDialog(props: Props): JSX.Element {
  const [rules, setRules] = useState<Rule[]>([])
  const [draft, setDraft] = useState<RuleDraft | null>(null)
  const [preview, setPreview] = useState<RulePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)

  const reload = async (): Promise<void> => {
    setRules(await api.rules.list())
  }

  useEffect(() => {
    void reload()
  }, [])

  const patch = (p: Partial<RuleDraft>): void => {
    setDraft((d) => (d ? { ...d, ...p } : d))
    setPreview(null)
  }

  const patchCondition = (index: number, p: Partial<RuleCondition>): void => {
    setDraft((d) => {
      if (!d) return d
      const conditions = d.conditions.map((c, i) => (i === index ? { ...c, ...p } : c))
      return { ...d, conditions }
    })
    setPreview(null)
  }

  const needsFolder = draft?.action === 'move' || draft?.action === 'mark_read_move'
  const foldersForAccount = useMemo(
    () => (draft?.accountId ? props.folders.filter((f) => f.accountId === draft.accountId) : props.folders),
    [props.folders, draft?.accountId]
  )

  const save = async (): Promise<void> => {
    if (!draft) return
    if (!draft.name.trim()) {
      props.onError('请给规则起个名字')
      return
    }
    if (!draft.conditions.length || draft.conditions.every((c) => !c.value)) {
      props.onError('请至少配置一个有效条件')
      return
    }
    if (needsFolder && !draft.actionFolderId) {
      props.onError('请选择要移动到的文件夹')
      return
    }
    setBusy(true)
    try {
      await api.rules.save(draft)
      await reload()
      props.onDone(draft.id ? '规则已更新' : '规则已创建')
      setDraft(null)
      setPreview(null)
    } catch (err) {
      props.onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const runPreview = async (): Promise<void> => {
    if (!draft) return
    setBusy(true)
    try {
      const r = await api.rules.preview(draft, 500)
      setPreview(r)
    } catch (err) {
      props.onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (rule: Rule): Promise<void> => {
    if (!confirm(`确定删除规则「${rule.name}」吗？`)) return
    await api.rules.remove(rule.id)
    await reload()
    props.onDone('规则已删除')
  }

  const toggle = async (rule: Rule): Promise<void> => {
    await api.rules.setEnabled(rule.id, !rule.enabled)
    await reload()
  }

  const runAll = async (): Promise<void> => {
    if (
      !confirm(
        '对现有邮件套用一遍规则？\n\n' +
          '会检查全部现有邮件。已经执行过动作的规则不会对同一封邮件重复执行\n' +
          '（所以可以放心多次点，不会把邮件移两次）。\n' +
          '如果规则里有「永久删除」，符合条件的邮件会直接被删掉。'
      )
    )
      return
    setRunning(true)
    try {
      const r = await api.rules.runAll()
      props.onDone(`已扫描 ${r.scanned} 封，执行了 ${r.acted} 个动作`)
      props.onChanged()
    } catch (err) {
      props.onError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="overlay">
      <div className="dialog" style={{ width: 880, height: '88vh' }}>
        <div className="dialog-head">
          <span>自动归类规则</span>
          <span className="spacer" />
          <button className="iconbtn" onClick={props.onClose}>
            <Icon name="close" size={12} />
          </button>
        </div>

        <div className="dialog-body">
          {!draft ? (
            <>
              <div className="hint" style={{ marginBottom: 10 }}>
                规则在邮件<b>落地时自动执行</b>：同步收下来的新邮件、导入的 Foxmail
                存档都会过一遍。只用邮件头就能判断的规则（比如按发件人）在邮件列表出现的瞬间就生效；
                需要看正文的规则会等正文下载完再补评一次。
                <br />
                已经处理过的邮件不会被同一条规则重复处理，所以「移到垃圾箱」不会对垃圾箱里的邮件再执行一次。
              </div>

              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <button className="btn primary" onClick={() => setDraft(emptyRule())}>
                  ＋ 新建规则
                </button>
                <button className="btn" disabled={running} onClick={() => void runAll()}>
                  {running ? '正在处理…' : '对现有邮件套用一遍'}
                </button>
              </div>

              {rules.length === 0 ? (
                <div className="statusline info">还没有任何规则。规则不会自动做任何事，请放心。</div>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 46 }}>启用</th>
                      <th>规则</th>
                      <th style={{ width: 220 }}>动作</th>
                      <th style={{ width: 96 }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((r) => (
                      <tr key={r.id} style={{ opacity: r.enabled ? 1 : 0.5 }}>
                        <td>
                          <input
                            type="checkbox"
                            className="rowcheck"
                            checked={r.enabled}
                            onChange={() => void toggle(r)}
                            title={r.enabled ? '点击停用' : '点击启用'}
                          />
                        </td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{r.name}</div>
                          <div className="hint" style={{ marginTop: 2 }}>
                            {r.accountId
                              ? `仅 ${
                                  props.accounts.find((a) => a.id === r.accountId)?.email ?? '指定账户'
                                }`
                              : '所有账户'}
                            　·　{r.matchMode === 'all' ? '满足全部条件' : '满足任一条件'}
                            　·　{r.conditions.map(describeCondition).join(' 且 ')}
                          </div>
                        </td>
                        <td>{describeAction(r, props.folders)}</td>
                        <td>
                          <button
                            className="iconbtn"
                            onClick={() => {
                              setDraft({ ...r })
                              setPreview(null)
                            }}
                          >
                            编辑
                          </button>
                          <button className="iconbtn" onClick={() => void remove(r)}>
                            删除
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          ) : (
            <>
              <div className="row3">
                <div className="field">
                  <label>规则名称</label>
                  <input
                    type="text"
                    value={draft.name}
                    placeholder="例如：把某人的邮件归到「客户」"
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>适用账户</label>
                  <select
                    value={draft.accountId ?? ''}
                    onChange={(e) =>
                      patch({
                        accountId: e.target.value ? Number(e.target.value) : null,
                        actionFolderId: null
                      })
                    }
                  >
                    <option value="">所有账户</option>
                    {props.accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.displayName || a.email}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* ── 条件 ── */}
              <div className="field">
                <label>
                  匹配条件
                  <span style={{ marginLeft: 10, color: 'var(--text-2)', fontWeight: 400 }}>
                    <select
                      value={draft.matchMode}
                      onChange={(e) =>
                        patch({ matchMode: e.target.value as 'all' | 'any' })
                      }
                      style={{ height: 24, display: 'inline-block', width: 130 }}
                    >
                      <option value="all">满足全部条件</option>
                      <option value="any">满足任一条件</option>
                    </select>
                  </span>
                </label>

                {draft.conditions.map((c, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                    <select
                      value={c.field}
                      onChange={(e) => patchCondition(i, { field: e.target.value as RuleField })}
                      style={{ width: 130, flex: '0 0 auto' }}
                    >
                      {FIELD_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <select
                      value={c.op}
                      onChange={(e) => patchCondition(i, { op: e.target.value as RuleOperator })}
                      style={{ width: 110, flex: '0 0 auto' }}
                    >
                      {OP_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={c.value}
                      style={{ flex: 1, minWidth: 0 }}
                      placeholder={
                        c.field === 'header'
                          ? '写成 X-Mailer: PHPMailer 这样的「头部名: 内容」'
                          : '要匹配的内容'
                      }
                      onChange={(e) => patchCondition(i, { value: e.target.value })}
                    />
                    <button
                      className="btn"
                      style={{ flex: '0 0 auto' }}
                      disabled={draft.conditions.length <= 1}
                      onClick={() =>
                        patch({ conditions: draft.conditions.filter((_, idx) => idx !== i) })
                      }
                      title="删除这个条件"
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </div>
                ))}

                <button
                  className="btn"
                  onClick={() =>
                    patch({ conditions: [...draft.conditions, { field: 'subject', op: 'contains', value: '' }] })
                  }
                >
                  ＋ 添加条件
                </button>

                <div className="hint" style={{ marginTop: 6 }}>
                  「指定邮件头」可以匹配任意自定义字段，比如 <code>List-Id: dev</code>、
                  <code>X-Spam-Flag: YES</code>。正则写错时该条规则会被忽略，不会影响收信。
                </div>
              </div>

              {/* ── 动作 ── */}
              <div className="row3">
                <div className="field">
                  <label>执行动作</label>
                  <select
                    value={draft.action}
                    onChange={(e) => patch({ action: e.target.value as RuleAction })}
                  >
                    {ACTION_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <div className="hint" style={{ marginTop: 4 }}>
                    {ACTION_OPTIONS.find((o) => o.value === draft.action)?.hint}
                  </div>
                </div>
                <div className="field">
                  <label>目标文件夹{needsFolder ? '（必选）' : ''}</label>
                  <select
                    value={draft.actionFolderId ?? ''}
                    disabled={!needsFolder}
                    onChange={(e) =>
                      patch({ actionFolderId: e.target.value ? Number(e.target.value) : null })
                    }
                  >
                    <option value="">请选择…</option>
                    {foldersForAccount.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {draft.action === 'delete' && (
                <div className="statusline err">
                  <Icon name="warning" size={13} /> 「永久删除」不会弹确认框，本机数据库记录与附件文件都会被删除。
                  建议先点下面的「试运行」确认匹配结果正确。
                </div>
              )}

              <div className="row3" style={{ marginTop: 8 }}>
                <div className="field">
                  <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={draft.stop}
                      onChange={(e) => patch({ stop: e.target.checked })}
                    />
                    命中后停止匹配后面的规则
                  </label>
                </div>
                <div className="field">
                  <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(e) => patch({ enabled: e.target.checked })}
                    />
                    启用这条规则
                  </label>
                </div>
              </div>

              {preview && (
                <div className={`statusline ${preview.error ? 'err' : 'ok'}`}>
                  {preview.error ? (
                    preview.error
                  ) : (
                    <>
                      <div>
                        <b>试运行结果：最近 {500} 封里有 {preview.matched} 封命中</b>
                        （未修改任何数据）
                      </div>
                      {preview.samples.length > 0 && (
                        <div className="mono" style={{ marginTop: 6, maxHeight: 130, overflow: 'auto' }}>
                          {preview.samples.map((s) => (
                            <div key={s.mailId}>
                              · {s.subject || '(无主题)'} — {s.fromAddr}
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="dialog-foot">
          {draft ? (
            <>
              <button className="btn" disabled={busy} onClick={() => void runPreview()}>
                {busy ? '计算中…' : '试运行（不改数据）'}
              </button>
              <span className="spacer" style={{ flex: 1 }} />
              <button
                className="btn"
                onClick={() => {
                  setDraft(null)
                  setPreview(null)
                }}
              >
                返回列表
              </button>
              <button className="btn primary" disabled={busy} onClick={() => void save()}>
                保存规则
              </button>
            </>
          ) : (
            <>
              <span className="hint" style={{ flex: 1 }}>
                共 {rules.length} 条规则，其中 {rules.filter((r) => r.enabled).length} 条已启用
              </span>
              <button className="btn" onClick={props.onClose}>
                关闭
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
