/**
 * SimpleMail 自有存档容器（`.fox`）。
 *
 * 为什么不直接用 Foxmail 的 .fox 格式：那是未公开的私有格式，没有规范也没有样本，
 * 硬猜一个写出去，对方版本一升级就会读不出来 —— 那才是真正的数据风险。
 *
 * 所以这里的策略是「双保险」：
 *   · 导出时同时产出**本容器**（.fox，可被本程序 100% 无损读回，
 *     并且因为是自带清单的明文结构，十几年后也一定能解析）；
 *   · 以及 **.box/.ind + .eml + .mbox** 三套通用格式（见 exporter.ts），
 *     用来放回 Windows Foxmail 或任何其他邮件客户端。
 *
 * 容器结构（小端）：
 *   0   : magic  "SMFXARCH"   8 字节
 *   8   : version  uint32
 *   12  : manifestLength uint32
 *   16  : manifest  UTF-8 JSON
 *   ... : 所有报文的原始字节，按 manifest 中的 offset/length 引用
 */

import { readFileSync, writeFileSync } from 'node:fs'
import type { FolderRole } from '@shared/types'

/** 容器魔数。刻意不用 Foxmail 的商标，避免任何形式的混淆或侵权。 */
export const SMFX_MAGIC = Buffer.from('SMFXARCH', 'ascii')
export const SMFX_VERSION = 1

export interface FoxManifestMail {
  offset: number
  length: number
  date: number
  subject: string
  fromAddr: string
  messageId: string | null
  /** 原始来源账户邮箱，便于还原 */
  accountEmail: string
}

export interface FoxManifestFolder {
  name: string
  role: FolderRole
  mails: FoxManifestMail[]
}

export interface FoxManifest {
  format: 'simplemail-archive'
  version: number
  createdAt: string
  app: string
  account: { email: string; displayName: string }
  archiveTag: string
  folders: FoxManifestFolder[]
}

export interface FoxArchive {
  manifest: FoxManifest
  payload: Buffer
}

export function isSmfxContainer(head: Buffer): boolean {
  return head.length >= 8 && head.subarray(0, 8).equals(SMFX_MAGIC)
}

export function buildFoxContainer(manifest: Omit<FoxManifest, 'format' | 'version' | 'app'>, payload: Buffer): Buffer {
  const full: FoxManifest = {
    format: 'simplemail-archive',
    version: SMFX_VERSION,
    app: 'SimpleMail',
    ...manifest
  }
  const manifestBuf = Buffer.from(JSON.stringify(full), 'utf8')
  const head = Buffer.alloc(16)
  SMFX_MAGIC.copy(head, 0)
  head.writeUInt32LE(SMFX_VERSION, 8)
  head.writeUInt32LE(manifestBuf.length, 12)
  return Buffer.concat([head, manifestBuf, payload])
}

export function readFoxContainer(path: string): FoxArchive {
  const buf = readFileSync(path)
  if (!isSmfxContainer(buf)) throw new Error('不是 SimpleMail 存档容器')
  const version = buf.readUInt32LE(8)
  if (version > SMFX_VERSION) {
    throw new Error(`存档版本 ${version} 高于当前程序支持的 ${SMFX_VERSION}，请升级 SimpleMail`)
  }
  const manifestLength = buf.readUInt32LE(12)
  const manifestStart = 16
  const manifestEnd = manifestStart + manifestLength
  if (manifestEnd > buf.length) throw new Error('存档清单已损坏（长度越界）')
  const manifest = JSON.parse(buf.toString('utf8', manifestStart, manifestEnd)) as FoxManifest
  return { manifest, payload: buf.subarray(manifestEnd) }
}

export function sliceMails(archive: FoxArchive): { folder: FoxManifestFolder; data: Buffer }[] {
  const out: { folder: FoxManifestFolder; data: Buffer }[] = []
  for (const folder of archive.manifest.folders) {
    for (const m of folder.mails) {
      if (m.offset + m.length > archive.payload.length) continue
      out.push({ folder, data: archive.payload.subarray(m.offset, m.offset + m.length) })
    }
  }
  return out
}

export function writeFoxContainer(path: string, buffer: Buffer): void {
  writeFileSync(path, buffer)
}
