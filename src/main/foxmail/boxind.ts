/**
 * 老版 Foxmail 的 `.box` + `.ind` 读写。
 *
 * `.box` 的结构是明确的：多封原始 RFC822 报文，用 16 字节分隔符连接。
 * `.ind` 是索引，格式在不同版本间有差异，公开资料也不完整。
 *
 * 这里不硬编码某一版的 `.ind` 结构，而是**自标定**：
 * 拿 `.ind` 里每个候选取值去和 `.box` 中真实的分隔符位置比对，
 * 哪个「记录长度 + 字段位置」组合能对上，就用哪个。
 *   · 对得上 → 说明我们认出了这一版的索引，导入时可以用它拿到更准的顺序/删除标记，
 *              导出时也能沿用**同一版布局**写回去；
 *   · 对不上 → 完全忽略 `.ind`，只按分隔符扫描（信息量足够，正文一个字不少）。
 */

import { readFileSync } from 'node:fs'
import { FOX_SEPARATOR, carveBySeparator, findFoxSeparators, type CarvedMessage } from './carve'

export interface IndLayout {
  headerSize: number
  recordSize: number
  /** 记录内 4 字节小端偏移字段的位置 */
  offsetPos: number
  /** 记录内 ID 字段位置与宽度 */
  idPos: number
  idSize: number
  /** 记录内删除标记位置（0x01 表示已删除） */
  deleteFlagPos: number | null
  /** 记录数与文件长度是否自洽 */
  recordCount: number
  confidence: number
}

export interface IndEntry {
  id: number
  offset: number
  deleted: boolean
}

const HEADER_SIZES = [0, 0x40, 0x48, 0x50, 0x100, 0x10]
const RECORD_SIZES = [16, 20, 24, 28, 32, 40, 48, 56, 64, 0x40, 0x48, 0x50, 0x60, 0x80, 0xb0, 0x100]
const FIELD_POSITIONS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32]
const ID_SIZES = [2, 4]

/**
 * 自标定：找出 `.ind` 的记录布局。
 * @param ind .ind 文件内容
 * @param sepOffsets .box 中每个分隔符的偏移（升序）
 */
export function detectIndLayout(ind: Buffer, sepOffsets: number[]): IndLayout | null {
  if (!ind.length || sepOffsets.length < 2) return null

  // 邮件正文起点 = 分隔符偏移 + 16
  const messageStarts = new Set<number>()
  for (const off of sepOffsets) {
    messageStarts.add(off)
    messageStarts.add(off + FOX_SEPARATOR.length)
  }
  messageStarts.add(0)

  let best: IndLayout | null = null

  for (const headerSize of HEADER_SIZES) {
    if (headerSize >= ind.length) continue
    for (const recordSize of RECORD_SIZES) {
      const body = ind.length - headerSize
      if (body < recordSize) continue
      const records = Math.floor(body / recordSize)
      // 记录数与报文数应当接近（允许索引里有已删除的额外记录）
      if (records < sepOffsets.length || records > sepOffsets.length * 4 + 8) continue

      for (const offsetPos of FIELD_POSITIONS) {
        if (offsetPos + 4 > recordSize) continue
        let hit = 0
        let checked = 0
        const step = Math.max(1, Math.floor(records / 64))
        for (let r = 0; r < records; r += step) {
          const base = headerSize + r * recordSize
          if (base + offsetPos + 4 > ind.length) break
          const value = ind.readUInt32LE(base + offsetPos)
          checked++
          if (messageStarts.has(value)) hit++
        }
        if (checked < 2) continue
        const confidence = hit / checked
        if (confidence < 0.6) continue

        // 找 ID 字段：从 0 开始递增的小整数
        let idPos = 0
        let idSize = 4
        for (const size of ID_SIZES) {
          for (const pos of [0, 2, 4, 6, 8]) {
            if (pos + size > recordSize) continue
            const v0 =
              size === 2
                ? ind.readUInt16LE(headerSize + pos)
                : ind.readUInt32LE(headerSize + pos)
            const v1 =
              size === 2
                ? ind.readUInt16LE(headerSize + Math.min(records - 1, 1) * recordSize + pos)
                : ind.readUInt32LE(headerSize + Math.min(records - 1, 1) * recordSize + pos)
            if (v0 >= 0 && v0 < 65535 && (v1 === v0 + 1 || v1 === v0)) {
              idPos = pos
              idSize = size
              break
            }
          }
        }

        // 找删除标记：值为 0/1 的字节
        let deleteFlagPos: number | null = null
        for (const pos of FIELD_POSITIONS) {
          if (pos >= recordSize) continue
          let ones = 0
          let bad = 0
          for (let r = 0; r < Math.min(records, 32); r++) {
            const b = ind[headerSize + r * recordSize + pos]
            if (b === 1) ones++
            else if (b !== 0) bad++
          }
          if (bad === 0 && ones > 0 && ones < Math.min(records, 32)) {
            deleteFlagPos = pos
            break
          }
        }

        const candidate: IndLayout = {
          headerSize,
          recordSize,
          offsetPos,
          idPos,
          idSize,
          deleteFlagPos,
          recordCount: records,
          confidence
        }
        if (!best || candidate.confidence > best.confidence) best = candidate
      }
    }
  }

  return best
}

export function parseInd(ind: Buffer, layout: IndLayout): IndEntry[] {
  const out: IndEntry[] = []
  for (let r = 0; r < layout.recordCount; r++) {
    const base = layout.headerSize + r * layout.recordSize
    if (base + layout.recordSize > ind.length) break
    const offset = ind.readUInt32LE(base + layout.offsetPos)
    const id =
      layout.idSize === 2
        ? ind.readUInt16LE(base + layout.idPos)
        : ind.readUInt32LE(base + layout.idPos)
    const deleted =
      layout.deleteFlagPos !== null ? ind[base + layout.deleteFlagPos] === 1 : false
    out.push({ id, offset, deleted })
  }
  return out
}

/** 没有参考布局时，导出使用的默认索引布局（我们自己的读取器与 Foxmail 老版都能读懂大体结构） */
export const DEFAULT_IND_LAYOUT: IndLayout = {
  headerSize: 0x40,
  recordSize: 0x40,
  offsetPos: 4,
  idPos: 0,
  idSize: 4,
  deleteFlagPos: 8,
  recordCount: 0,
  confidence: 0
}

export interface BuildIndEntry {
  id: number
  offset: number
  deleted: boolean
}

/**
 * 生成 `.ind`。
 * 若提供了 layout（来自被导入的存档），则沿用同一布局，保证「导出成同样格式」。
 */
export function buildInd(layout: IndLayout, entries: BuildIndEntry[]): Buffer {
  const header = Buffer.alloc(layout.headerSize)
  const body = Buffer.alloc(layout.recordSize * entries.length)
  for (let r = 0; r < entries.length; r++) {
    const base = r * layout.recordSize
    const e = entries[r]
    if (layout.idSize === 2) body.writeUInt16LE(Math.min(e.id, 0xffff), base + layout.idPos)
    else body.writeUInt32LE(e.id, base + layout.idPos)
    body.writeUInt32LE(e.offset, base + layout.offsetPos)
    if (layout.deleteFlagPos !== null) body[base + layout.deleteFlagPos] = e.deleted ? 1 : 0
  }

  // 头部：尽量模仿 Foxmail 的写法（记录数写在 0x05，邮件数写在 0x08）
  const h = Buffer.from(header)
  if (h.length > 8) {
    h.writeUInt8(Math.min(entries.length, 0xff), 0x05)
    h.writeUInt32LE(entries.length, 0x08)
  }
  return Buffer.concat([h, body])
}

export interface BoxReadResult {
  messages: CarvedMessage[]
  layout: IndLayout | null
  sepOffsets: number[]
}

/** 读取一对 `.box` / `.ind` */
export function readBoxPair(boxPath: string, indPath?: string): BoxReadResult {
  const box = readFileSync(boxPath)
  const messages = carveBySeparator(box)
  const sepOffsets = findFoxSeparators(box)

  let layout: IndLayout | null = null
  if (indPath) {
    try {
      const ind = readFileSync(indPath)
      layout = detectIndLayout(ind, sepOffsets)
    } catch {
      layout = null
    }
  }
  return { messages, layout, sepOffsets }
}
