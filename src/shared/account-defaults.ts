/**
 * 账户草稿的默认值工厂。
 *
 * 主进程（本地存档账户、演示数据、自检）与渲染进程（添加账户对话框）
 * 都要构造 AccountDraft，字段一多就容易漏。集中在这里，
 * 新增字段时只改一处，编译器会帮忙把漏掉的地方揪出来。
 */

import type { AccountDraft } from './types'

export const DEFAULT_IMAP_PORT = 993
export const DEFAULT_POP3_PORT = 995
export const DEFAULT_SMTP_PORT = 465

export function createAccountDraft(patch: Partial<AccountDraft> = {}): AccountDraft {
  return {
    email: '',
    displayName: '',
    protocol: 'imap',
    imapHost: '',
    imapPort: DEFAULT_IMAP_PORT,
    imapSecure: true,
    pop3Host: '',
    pop3Port: DEFAULT_POP3_PORT,
    pop3Secure: true,
    pop3DeleteAfterFetch: false,
    smtpHost: '',
    smtpPort: DEFAULT_SMTP_PORT,
    smtpSecure: true,
    username: '',
    password: '',
    signature: '',
    color: '#2f7fd8',
    syncEnabled: true,
    isLocal: false,
    ...patch
  }
}
