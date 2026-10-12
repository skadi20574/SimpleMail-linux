/**
 * SMTP 发送。
 *
 * 做法：先用 MailComposer 把邮件编译成一份 RFC822 报文（raw），
 * 再用同一个 raw 既发送、又追加到服务器「已发送」并落库。
 * 这样本地「已发送」和服务器上的副本内容完全一致。
 */

import nodemailer from 'nodemailer'
import type { Account, ComposePayload } from '@shared/types'

export interface SmtpCheck {
  ok: boolean
  error?: string
}

interface MailOptionsLike {
  from: string
  to: string
  cc?: string
  bcc?: string
  subject: string
  text?: string
  html?: string
  inReplyTo?: string
  references?: string
  attachments: { filename: string; path: string; contentType?: string }[]
}

function makeTransport(account: Account): nodemailer.Transporter {
  return nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpSecure,
    auth: { user: account.username || account.email, pass: account.password },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 120_000
  })
}

export async function testSmtp(account: Account): Promise<SmtpCheck> {
  const transport = makeTransport(account)
  try {
    await transport.verify()
    transport.close()
    return { ok: true }
  } catch (err) {
    try {
      transport.close()
    } catch {
      /* ignore */
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 把地址串拆成数组，服务器 envelope 需要纯地址 */
export function parseAddressList(input: string): string[] {
  if (!input) return []
  return input
    .split(/[,;]/)
    .map((s) => s.trim())
    .map((s) => {
      const m = /<([^>]+)>/.exec(s)
      return (m ? m[1] : s).trim()
    })
    .filter((s) => s.includes('@'))
}

async function buildRaw(options: MailOptionsLike): Promise<Buffer> {
  const mod = await import('nodemailer/lib/mail-composer/index.js')
  const Ctor =
    (mod as unknown as { default?: unknown }).default ?? (mod as unknown as { MailComposer?: unknown })
  const MailComposer = Ctor as new (o: unknown) => {
    compile(): { build(cb: (err: Error | null, message: Buffer) => void): void }
  }
  return await new Promise<Buffer>((resolve, reject) => {
    new MailComposer(options).compile().build((err, message) => {
      if (err) reject(err)
      else resolve(message)
    })
  })
}

export interface SendOutcome {
  ok: boolean
  error?: string
  raw?: Buffer
}

/**
 * 发送一封邮件。返回编译好的 raw，供调用方落库 / 追加到「已发送」。
 */
export async function sendMail(
  account: Account,
  payload: ComposePayload,
  attachmentPaths: { filename: string; path: string; contentType?: string }[]
): Promise<SendOutcome> {
  const fromHeader = account.displayName
    ? `"${account.displayName}" <${account.email}>`
    : account.email

  const options: MailOptionsLike = {
    from: fromHeader,
    to: payload.to,
    cc: payload.cc || undefined,
    bcc: payload.bcc || undefined,
    subject: payload.subject,
    text: payload.text || undefined,
    html: payload.html || undefined,
    inReplyTo: payload.inReplyTo || undefined,
    references: payload.references || undefined,
    attachments: attachmentPaths
  }

  let raw: Buffer
  try {
    raw = await buildRaw(options)
  } catch (err) {
    return { ok: false, error: `构造邮件失败：${err instanceof Error ? err.message : String(err)}` }
  }

  const transport = makeTransport(account)
  try {
    await transport.sendMail({
      envelope: {
        from: account.email,
        to: [
          ...parseAddressList(payload.to),
          ...parseAddressList(payload.cc),
          ...parseAddressList(payload.bcc)
        ]
      },
      raw
    })
    return { ok: true, raw }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), raw }
  } finally {
    try {
      transport.close()
    } catch {
      /* ignore */
    }
  }
}
