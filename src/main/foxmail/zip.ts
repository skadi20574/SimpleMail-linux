/**
 * 极简 ZIP 读取器（基于中央目录）。
 *
 * 之所以不引第三方库：只需要「列出条目 + 读出内容」两件事，
 * 而且这里只处理用户自己打包的 Foxmail 存档 zip，规模可控。
 * 支持 ZIP64 的扩展字段，足以应付超过 4GB 的存档。
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const EOCD64_LOCATOR_SIG = 0x07064b50
const EOCD64_SIG = 0x06064b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

export interface ZipEntry {
  name: string
  compressedSize: number
  uncompressedSize: number
  method: number
  localHeaderOffset: number
}

function readAt(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length)
  const read = readSync(fd, buf, 0, length, offset)
  return read === length ? buf : buf.subarray(0, read)
}

function findEocd(fd: number, fileSize: number): number {
  const maxBack = Math.min(fileSize, 66_000)
  const start = fileSize - maxBack
  const buf = readAt(fd, start, maxBack)
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return start + i
  }
  return -1
}

/** 解析 ZIP64 扩展字段，取出 8 字节的 uncompressed/compressed/offset */
function parseZip64Extra(extra: Buffer, need: { usize: boolean; csize: boolean; offset: boolean }): {
  usize?: number
  csize?: number
  offset?: number
} {
  let p = 0
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p)
    const size = extra.readUInt16LE(p + 2)
    const body = extra.subarray(p + 4, p + 4 + size)
    if (id === 0x0001) {
      let q = 0
      const out: { usize?: number; csize?: number; offset?: number } = {}
      if (need.usize && q + 8 <= body.length) {
        out.usize = Number(body.readBigUInt64LE(q))
        q += 8
      }
      if (need.csize && q + 8 <= body.length) {
        out.csize = Number(body.readBigUInt64LE(q))
        q += 8
      }
      if (need.offset && q + 8 <= body.length) {
        out.offset = Number(body.readBigUInt64LE(q))
        q += 8
      }
      return out
    }
    p += 4 + size
  }
  return {}
}

export function listZipEntries(zipPath: string): ZipEntry[] {
  const fd = openSync(zipPath, 'r')
  try {
    const fileSize = statSync(zipPath).size
    const eocd = findEocd(fd, fileSize)
    if (eocd === -1) throw new Error('不是有效的 ZIP 文件（找不到中央目录）')

    const eocdBuf = readAt(fd, eocd, 22)
    let entryCount = eocdBuf.readUInt16LE(10)
    let cenOffset = eocdBuf.readUInt32LE(16)

    // ZIP64
    if (entryCount === 0xffff || cenOffset === 0xffffffff) {
      const locatorOffset = eocd - 20
      if (locatorOffset >= 0) {
        const loc = readAt(fd, locatorOffset, 20)
        if (loc.readUInt32LE(0) === EOCD64_LOCATOR_SIG) {
          const eocd64Offset = Number(loc.readBigUInt64LE(8))
          const e64 = readAt(fd, eocd64Offset, 56)
          if (e64.readUInt32LE(0) === EOCD64_SIG) {
            entryCount = Number(e64.readBigUInt64LE(32))
            cenOffset = Number(e64.readBigUInt64LE(48))
          }
        }
      }
    }

    const entries: ZipEntry[] = []
    let p = cenOffset
    for (let i = 0; i < entryCount; i++) {
      const head = readAt(fd, p, 46)
      if (head.length < 46 || head.readUInt32LE(0) !== CEN_SIG) break
      const method = head.readUInt16LE(10)
      let csize = head.readUInt32LE(20)
      let usize = head.readUInt32LE(24)
      const nameLen = head.readUInt16LE(28)
      const extraLen = head.readUInt16LE(30)
      const commentLen = head.readUInt16LE(32)
      let localOffset = head.readUInt32LE(42)
      const name = readAt(fd, p + 46, nameLen).toString('utf8')

      if (usize === 0xffffffff || csize === 0xffffffff || localOffset === 0xffffffff) {
        const extra = readAt(fd, p + 46 + nameLen, extraLen)
        const z = parseZip64Extra(extra, {
          usize: usize === 0xffffffff,
          csize: csize === 0xffffffff,
          offset: localOffset === 0xffffffff
        })
        if (z.usize !== undefined) usize = z.usize
        if (z.csize !== undefined) csize = z.csize
        if (z.offset !== undefined) localOffset = z.offset
      }

      if (!name.endsWith('/')) {
        entries.push({ name, compressedSize: csize, uncompressedSize: usize, method, localHeaderOffset: localOffset })
      }
      p += 46 + nameLen + extraLen + commentLen
    }
    return entries
  } finally {
    closeSync(fd)
  }
}

export function readZipEntry(zipPath: string, entry: ZipEntry): Buffer {
  const fd = openSync(zipPath, 'r')
  try {
    const loc = readAt(fd, entry.localHeaderOffset, 30)
    if (loc.readUInt32LE(0) !== LOC_SIG) throw new Error(`条目 ${entry.name} 的本地头无效`)
    const nameLen = loc.readUInt16LE(26)
    const extraLen = loc.readUInt16LE(28)
    const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen

    if (entry.method === 0) {
      return readAt(fd, dataStart, entry.uncompressedSize || entry.compressedSize)
    }
    if (entry.method === 8) {
      const raw = readAt(fd, dataStart, entry.compressedSize)
      return inflateRawSync(raw, { maxOutputLength: 1024 * 1024 * 1024 })
    }
    throw new Error(`不支持的压缩方式 ${entry.method}（条目 ${entry.name}）`)
  } finally {
    closeSync(fd)
  }
}

export function isZipFile(head: Buffer): boolean {
  return head.length >= 4 && head.readUInt32LE(0) === LOC_SIG
}
