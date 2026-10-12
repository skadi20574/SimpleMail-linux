import { useState } from 'react'
import type { Account, AccountDraft, MailProtocol } from '../api'
import { api } from '../api'
import Icon from './Icon'
import {
  createAccountDraft,
  DEFAULT_IMAP_PORT,
  DEFAULT_POP3_PORT,
  DEFAULT_SMTP_PORT
} from '@shared/account-defaults'

interface Preset {
  key: string
  label: string
  hint: string
  imapHost: string
  imapPort: number
  imapSecure: boolean
  pop3Host: string
  pop3Port: number
  pop3Secure: boolean
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
}

/**
 * 常见国内邮箱的服务器参数。密码一律填「授权码」，不是登录密码。
 *
 * IMAP 与 POP3 两套地址都预先填好，切换收件协议时不用重新查资料。
 */
export const PRESETS: Preset[] = [
  {
    key: 'qq',
    label: 'QQ 邮箱',
    hint: '需要在 QQ 邮箱网页版「设置 → 账户 → POP3/IMAP/SMTP服务」开启对应服务并生成 16 位授权码，密码处填授权码。',
    imapHost: 'imap.qq.com',
    imapPort: 993,
    imapSecure: true,
    pop3Host: 'pop.qq.com',
    pop3Port: 995,
    pop3Secure: true,
    smtpHost: 'smtp.qq.com',
    smtpPort: 465,
    smtpSecure: true
  },
  {
    key: '163',
    label: '163 邮箱',
    hint: '在 163 邮箱网页版「设置 → POP3/SMTP/IMAP」开启服务并设置客户端授权码。',
    imapHost: 'imap.163.com',
    imapPort: 993,
    imapSecure: true,
    pop3Host: 'pop.163.com',
    pop3Port: 995,
    pop3Secure: true,
    smtpHost: 'smtp.163.com',
    smtpPort: 465,
    smtpSecure: true
  },
  {
    key: '126',
    label: '126 邮箱',
    hint: '与 163 相同，需要开启服务并设置授权码。',
    imapHost: 'imap.126.com',
    imapPort: 993,
    imapSecure: true,
    pop3Host: 'pop.126.com',
    pop3Port: 995,
    pop3Secure: true,
    smtpHost: 'smtp.126.com',
    smtpPort: 465,
    smtpSecure: true
  },
  {
    key: 'exmail',
    label: '腾讯企业邮箱',
    hint: '使用企业邮箱地址与客户端专用密码（如已开启安全登录）。',
    imapHost: 'imap.exmail.qq.com',
    imapPort: 993,
    imapSecure: true,
    pop3Host: 'pop.exmail.qq.com',
    pop3Port: 995,
    pop3Secure: true,
    smtpHost: 'smtp.exmail.qq.com',
    smtpPort: 465,
    smtpSecure: true
  },
  {
    key: 'sina',
    label: '新浪邮箱',
    hint: '需要在网页版邮箱设置中开启 IMAP/SMTP 或 POP3/SMTP 服务。',
    imapHost: 'imap.sina.com',
    imapPort: 993,
    imapSecure: true,
    pop3Host: 'pop.sina.com',
    pop3Port: 995,
    pop3Secure: true,
    smtpHost: 'smtp.sina.com',
    smtpPort: 465,
    smtpSecure: true
  },
  {
    key: 'gmail',
    label: 'Gmail',
    hint: '需要开启两步验证并生成「应用专用密码」。',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    imapSecure: true,
    pop3Host: 'pop.gmail.com',
    pop3Port: 995,
    pop3Secure: true,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    smtpSecure: true
  },
  {
    key: 'outlook',
    label: 'Outlook / Office365',
    hint: '现代验证（OAuth）暂不支持，若账户强制 OAuth 则无法用密码登录。',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    imapSecure: true,
    pop3Host: 'outlook.office365.com',
    pop3Port: 995,
    pop3Secure: true,
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    smtpSecure: false
  },
  {
    key: 'custom',
    label: '自定义 / 其他',
    hint: '手动填写收件与发信服务器地址、端口。',
    imapHost: '',
    imapPort: DEFAULT_IMAP_PORT,
    imapSecure: true,
    pop3Host: '',
    pop3Port: DEFAULT_POP3_PORT,
    pop3Secure: true,
    smtpHost: '',
    smtpPort: DEFAULT_SMTP_PORT,
    smtpSecure: true
  }
]

const COLORS = ['#2f7fd8', '#2e9c5a', '#c8860d', '#8a6d3b', '#8e5bd0', '#d9534f', '#0f8b8d']

interface Props {
  account: Account | null
  onClose: () => void
  onSaved: (message: string) => void
  onError: (message: string) => void
}

export default function AccountDialog(props: Props): JSX.Element {
  const [draft, setDraft] = useState<AccountDraft>(() =>
    props.account ? { ...props.account } : createAccountDraft(PRESETS[0])
  )
  const [presetKey, setPresetKey] = useState('qq')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const preset = PRESETS.find((p) => p.key === presetKey) ?? PRESETS[0]
  const protocol: MailProtocol = draft.protocol === 'pop3' ? 'pop3' : 'imap'
  const isLocal = Boolean(draft.isLocal)

  const patch = (p: Partial<AccountDraft>): void => setDraft((d) => ({ ...d, ...p }))

  const applyPreset = (key: string): void => {
    setPresetKey(key)
    const p = PRESETS.find((x) => x.key === key)
    if (!p || key === 'custom') return
    patch({
      imapHost: p.imapHost,
      imapPort: p.imapPort,
      imapSecure: p.imapSecure,
      pop3Host: p.pop3Host,
      pop3Port: p.pop3Port,
      pop3Secure: p.pop3Secure,
      smtpHost: p.smtpHost,
      smtpPort: p.smtpPort,
      smtpSecure: p.smtpSecure
    })
  }

  const switchProtocol = (next: MailProtocol): void => {
    setTestResult(null)
    // 切换协议时若新协议那边是空的，用当前预设补上，省得用户重新查服务器地址
    if (next === 'pop3' && !draft.pop3Host && preset.pop3Host) {
      patch({
        protocol: next,
        pop3Host: preset.pop3Host,
        pop3Port: preset.pop3Port,
        pop3Secure: preset.pop3Secure
      })
      return
    }
    if (next === 'imap' && !draft.imapHost && preset.imapHost) {
      patch({
        protocol: next,
        imapHost: preset.imapHost,
        imapPort: preset.imapPort,
        imapSecure: preset.imapSecure
      })
      return
    }
    patch({ protocol: next })
  }

  const save = async (): Promise<void> => {
    if (!draft.email.trim()) {
      props.onError('请填写邮箱地址')
      return
    }
    const receiveHost = protocol === 'pop3' ? draft.pop3Host : draft.imapHost
    if (!isLocal && (!receiveHost?.trim() || !draft.smtpHost.trim())) {
      props.onError(
        protocol === 'pop3' ? '请填写 POP3 与 SMTP 服务器地址' : '请填写 IMAP 与 SMTP 服务器地址'
      )
      return
    }
    setSaving(true)
    try {
      await api.accounts.save({
        ...draft,
        protocol,
        username: draft.username?.trim() || draft.email.trim(),
        displayName: draft.displayName?.trim() || draft.email.split('@')[0]
      })
      props.onSaved(props.account ? '账户已更新' : '账户已添加，正在同步邮件…')
      props.onClose()
    } catch (err) {
      props.onError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await api.accounts.test({
        ...draft,
        protocol,
        username: draft.username?.trim() || draft.email.trim()
      })
      const label = protocol === 'pop3' ? 'POP3' : 'IMAP'
      const lines: string[] = []
      lines.push(
        r.receive.ok
          ? `${label} 连接成功${r.receive.error ? `（${r.receive.error}）` : ''}`
          : `${label} 失败：${r.receive.error ?? '未知错误'}`
      )
      lines.push(r.smtp.ok ? 'SMTP 连接成功' : `SMTP 失败：${r.smtp.error ?? '未知错误'}`)
      if (!(r.receive.ok && r.smtp.ok)) {
        lines.push('')
        lines.push(
          '常见原因：密码处应填「授权码」而不是登录密码；该服务未在邮箱网页版开启；或端口被网络限制。'
        )
      }
      setTestResult({ ok: r.receive.ok && r.smtp.ok, text: lines.join('\n') })
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="overlay">
      <div className="dialog" style={{ width: 660, maxHeight: '92vh' }}>
        <div className="dialog-head">
          <span>{props.account ? '编辑账户' : '添加邮箱账户'}</span>
          <span className="spacer" />
          <button className="iconbtn" onClick={props.onClose}>
            <Icon name="close" size={12} />
          </button>
        </div>

        <div className="dialog-body">
          {!props.account && (
            <div className="field">
              <label>邮箱类型</label>
              <select value={presetKey} onChange={(e) => applyPreset(e.target.value)}>
                {PRESETS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
              <div className="hint" style={{ marginTop: 5 }}>
                {preset.hint}
              </div>
            </div>
          )}

          <div className="row3">
            <div className="field">
              <label>邮箱地址 *</label>
              <input
                type="text"
                value={draft.email}
                placeholder="you@qq.com"
                onChange={(e) => patch({ email: e.target.value })}
              />
            </div>
            <div className="field">
              <label>显示名称</label>
              <input
                type="text"
                value={draft.displayName}
                placeholder="张三"
                onChange={(e) => patch({ displayName: e.target.value })}
              />
            </div>
          </div>

          {!isLocal && (
            <>
              <div className="field">
                <label>密码 / 授权码 *</label>
                <input
                  type="password"
                  value={draft.password}
                  placeholder="QQ、163 等邮箱请填「客户端授权码」"
                  onChange={(e) => patch({ password: e.target.value })}
                />
              </div>

              {/* ───────── 收件协议 ───────── */}
              <div className="field">
                <label>收件协议</label>
                <div className="chips" style={{ marginBottom: 4 }}>
                  <label className={`chip${protocol === 'imap' ? ' on' : ''}`}>
                    <input
                      type="radio"
                      name="protocol"
                      checked={protocol === 'imap'}
                      onChange={() => switchProtocol('imap')}
                    />
                    IMAP（推荐）
                  </label>
                  <label className={`chip${protocol === 'pop3' ? ' on' : ''}`}>
                    <input
                      type="radio"
                      name="protocol"
                      checked={protocol === 'pop3'}
                      onChange={() => switchProtocol('pop3')}
                    />
                    POP3
                  </label>
                </div>
                <div className="hint">
                  {protocol === 'imap' ? (
                    <>
                      IMAP 会把服务器上的<b>文件夹结构、已读状态、星标</b>一并同步过来，
                      手机与电脑上看到的邮件保持一致，推荐用它。
                    </>
                  ) : (
                    <>
                      POP3 <b>只收信、只同步收件箱</b>：服务器上没有文件夹概念，也没有已读状态，
                      拉下来的邮件只存在本机。「已发送 / 草稿箱 / 垃圾箱」会成为纯本地文件夹，
                      发信仍然走 SMTP。适合只在一台电脑上收信的老邮箱。
                    </>
                  )}
                </div>
              </div>

              {/* ───────── 收件服务器 ───────── */}
              {protocol === 'imap' ? (
                <div className="field">
                  <label>IMAP 接收服务器</label>
                  <div className="row2">
                    <input
                      type="text"
                      value={draft.imapHost}
                      placeholder="imap.qq.com"
                      onChange={(e) => patch({ imapHost: e.target.value })}
                    />
                    <input
                      type="number"
                      value={draft.imapPort}
                      onChange={(e) =>
                        patch({ imapPort: Number(e.target.value) || DEFAULT_IMAP_PORT })
                      }
                    />
                  </div>
                  <div className="hint" style={{ marginTop: 4 }}>
                    <label style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={draft.imapSecure}
                        onChange={(e) => patch({ imapSecure: e.target.checked })}
                      />
                      使用 SSL/TLS（993 端口勾选，143 端口不勾选）
                    </label>
                  </div>
                </div>
              ) : (
                <div className="field">
                  <label>POP3 接收服务器</label>
                  <div className="row2">
                    <input
                      type="text"
                      value={draft.pop3Host}
                      placeholder="pop.qq.com"
                      onChange={(e) => patch({ pop3Host: e.target.value })}
                    />
                    <input
                      type="number"
                      value={draft.pop3Port}
                      onChange={(e) =>
                        patch({ pop3Port: Number(e.target.value) || DEFAULT_POP3_PORT })
                      }
                    />
                  </div>
                  <div className="hint" style={{ marginTop: 4 }}>
                    <label style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={draft.pop3Secure}
                        onChange={(e) => patch({ pop3Secure: e.target.checked })}
                      />
                      使用 SSL/TLS（995 端口勾选；110 端口不勾选，会自动尝试 STLS 升级）
                    </label>
                  </div>

                  <div className="statusline info" style={{ marginTop: 8, display: 'block' }}>
                    <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={draft.pop3DeleteAfterFetch}
                        onChange={(e) => patch({ pop3DeleteAfterFetch: e.target.checked })}
                      />
                      下载成功后<b>从服务器删除</b>这些邮件
                    </label>
                    <div className="hint" style={{ marginTop: 4 }}>
                      默认不勾选：邮件下载到本机后服务器上仍然保留，可以再用手机或其他客户端收。
                      勾选后本机就是唯一的副本，<b>换电脑前请先做一次「导出存档」备份</b>。
                      删除只在邮件成功写入本地数据库之后才执行，中途取消不会删。
                    </div>
                  </div>
                </div>
              )}

              <div className="field">
                <label>SMTP 发送服务器（与收件协议无关，两种协议都用它发信）</label>
                <div className="row2">
                  <input
                    type="text"
                    value={draft.smtpHost}
                    placeholder="smtp.qq.com"
                    onChange={(e) => patch({ smtpHost: e.target.value })}
                  />
                  <input
                    type="number"
                    value={draft.smtpPort}
                    onChange={(e) =>
                      patch({ smtpPort: Number(e.target.value) || DEFAULT_SMTP_PORT })
                    }
                  />
                </div>
                <div className="hint" style={{ marginTop: 4 }}>
                  <label style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={draft.smtpSecure}
                      onChange={(e) => patch({ smtpSecure: e.target.checked })}
                    />
                    使用 SSL/TLS（465 端口勾选；587 端口不勾选，走 STARTTLS）
                  </label>
                </div>
              </div>

              <div className="field">
                <label>用户名</label>
                <input
                  type="text"
                  value={draft.username}
                  placeholder="留空则使用邮箱地址"
                  onChange={(e) => patch({ username: e.target.value })}
                />
              </div>
            </>
          )}

          <div className="field">
            <label>邮件签名（写信时自动追加）</label>
            <textarea
              rows={3}
              value={draft.signature}
              placeholder={'此致\n张三'}
              onChange={(e) => patch({ signature: e.target.value })}
            />
          </div>

          <div className="field">
            <label>账户颜色</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => patch({ color: c })}
                  title={c}
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    background: c,
                    border: draft.color === c ? '2px solid var(--text)' : '2px solid transparent'
                  }}
                />
              ))}
            </div>
          </div>

          {!isLocal && (
            <div className="field">
              <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={draft.syncEnabled}
                  onChange={(e) => patch({ syncEnabled: e.target.checked })}
                />
                启动时自动同步这个账户
              </label>
            </div>
          )}

          {testResult && (
            <div className={`statusline ${testResult.ok ? 'ok' : 'err'}`}>
              <div style={{ whiteSpace: 'pre-wrap' }}>{testResult.text}</div>
            </div>
          )}
        </div>

        <div className="dialog-foot">
          {!isLocal && (
            <button className="btn" disabled={testing} onClick={() => void test()}>
              {testing ? '测试中…' : '测试连接'}
            </button>
          )}
          <span className="spacer" style={{ flex: 1 }} />
          {props.account && !props.account.isLocal && (
            <button
              className="btn danger"
              onClick={async () => {
                if (
                  !confirm(
                    `确定删除账户「${props.account?.email}」吗？\n该账户下已保存的邮件也会一并删除。`
                  )
                )
                  return
                await api.accounts.remove(props.account!.id)
                props.onSaved('账户已删除')
                props.onClose()
              }}
            >
              删除账户
            </button>
          )}
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button className="btn primary" disabled={saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
