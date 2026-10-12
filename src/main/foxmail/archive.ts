/**
 * 存档识别与读取抽象层。
 *
 * 目标（用户需求）：**自动兼容新老版本的 Foxmail 打包文件**，不需要用户选版本。
 *
 * 支持的形态（按识别顺序）：
 *   1. 目录 + `FMStorage.list`      → Foxmail 7.2 数据目录
 *   2. 目录 + `mail/<账户>/*.box`   → Foxmail 5/6/7.0 数据目录
 *   3. 单个 `.fox`                  → Foxmail 7.2「邮件存档」（格式未公开 → 走雕刻）
 *   4. `*.box` / `*.ind` 文件对     → 任意版本
 *   5. `*.eml` 文件集合 / `*.mbox`  → 通用
 *   6. `*.zip`                      → 解包后递归识别上面任意一种
 *   7. 以上都不匹配                 → 当作不透明二进制做深度雕刻
 *
 * 每个「单元（unit）」对应一个邮件文件夹（收件箱/已发送/…），
 * 单元的 messages 是懒加载的：一次只把一封文件夹的内容读进内存。
 */

import { promises as fsp } from 'node:fs'
import { existsSync, openSync, readSync, closeSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type { ArchiveDetection, ArchiveInspection, ArchiveKind, ArchiveUnit, FolderRole } from '@shared/types'
import {
  carveGeneric,
  carveBySeparator,
  findFoxSeparators,
  looksLikeRfc822,
  headDump
} from './carve'
import { detectIndLayout, type IndLayout } from './boxind'
import { isZipFile, listZipEntries, readZipEntry, type ZipEntry } from './zip'
import { isSmfxContainer, readFoxContainer, SMFX_MAGIC } from './fox'
import { LargeFileReader, type MessageSpan } from './stream'

/**
 * 单个文件全量载入内存的上限。
 *
 * 超过这个大小就不再「读进内存再雕刻」，改用 LargeFileReader 流式处理 ——
 * 用户的 Foxmail 存档里有 2.94GB 的 .box，原来直接报「文件过大」拒绝导入。
 * 阈值取 256MB：这个尺寸以下，全量载入 + 五条线索深度雕刻对畸形容器更宽容；
 * 超过之后流式路径的收益（峰值内存只与单封邮件有关）远大于损失。
 */
const DEFAULT_IN_MEMORY_LIMIT = 256 * 1024 * 1024

/**
 * 当前生效的内存阈值。
 *
 * 做成函数而不是常量，是为了让自检能把阈值调到极小（比如 1KB），
 * 从而用几十条报文的小文件**真实走一遍流式路径** —— 否则要测流式就得
 * 先造一个 300MB 的样本，自检会慢到没法用。
 */
export function inMemoryLimit(): number {
  const raw = process.env.SIMPLEMAIL_IN_MEMORY_LIMIT
  if (raw === undefined) return DEFAULT_IN_MEMORY_LIMIT
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_IN_MEMORY_LIMIT
}

/** 硬上限：连流式都处理不了的极端文件（防止误选磁盘镜像之类的文件） */
const MAX_FILE_BYTES = 64 * 1024 * 1024 * 1024

export interface UnitHandle {
  info: ArchiveUnit
  strategy: string
  layout: IndLayout | null
  /**
   * 逐封产出报文。大数据源（GB 级 .box）实现它来做流式导入；
   * 小数据源可以不实现，调用方会退回 load()。
   */
  stream?: () => AsyncIterable<Buffer>
  load(): Promise<Buffer[]>
}

/** 统一的迭代入口：有流式实现就走流式，否则收集后逐条产出 */
export async function* iterateUnit(unit: UnitHandle): AsyncIterable<Buffer> {
  if (unit.stream) {
    yield* unit.stream()
    return
  }
  for (const message of await unit.load()) yield message
}

/** 把单元的全部报文收进数组（自检与体检用；大文件慎用） */
export async function collectUnit(unit: UnitHandle): Promise<Buffer[]> {
  const out: Buffer[] = []
  for await (const m of iterateUnit(unit)) out.push(m)
  return out
}

export interface OpenedArchive {
  detection: ArchiveDetection
  units: UnitHandle[]
}

const NAME_ROLE_MAP: { re: RegExp; role: FolderRole }[] = [
  { re: /^(inbox|收件箱|收信)$/i, role: 'inbox' },
  { re: /^(sent|sent items|sent messages|已发送|已发送邮件|发件箱|已发邮件)$/i, role: 'sent' },
  { re: /^(draft|drafts|草稿|草稿箱)$/i, role: 'drafts' },
  { re: /^(trash|deleted|deleted items|已删除|垃圾箱|回收站|废件箱)$/i, role: 'trash' },
  { re: /^(junk|spam|junk e-mail|垃圾邮件|广告邮件)$/i, role: 'junk' },
  { re: /^(archive|存档|归档|所有邮件)$/i, role: 'archive' },
  { re: /^(outbox|发件箱|待发箱)$/i, role: 'custom' }
]

export function roleFromName(name: string): FolderRole {
  const clean = name.replace(/\.(box|ind|eml|mbox|fox)$/i, '').trim()
  for (const { re, role } of NAME_ROLE_MAP) {
    if (re.test(clean)) return role
  }
  const lower = clean.toLowerCase()
  if (lower.includes('sent') || clean.includes('已发送') || clean.includes('发件')) return 'sent'
  if (lower.includes('draft') || clean.includes('草稿')) return 'drafts'
  if (lower.includes('trash') || lower.includes('deleted') || clean.includes('删除') || clean.includes('垃圾箱'))
    return 'trash'
  if (lower.includes('spam') || lower.includes('junk') || clean.includes('垃圾邮件')) return 'junk'
  if (lower.includes('inbox') || clean.includes('收件箱')) return 'inbox'
  if (lower.includes('archive') || clean.includes('存档') || clean.includes('归档')) return 'archive'
  return 'custom'
}

function prettyName(name: string): string {
  const clean = name.replace(/\.(box|ind|eml|mbox|fox)$/i, '').trim()
  if (!clean) return '邮件'
  const role = roleFromName(clean)
  const zh: Partial<Record<FolderRole, string>> = {
    inbox: '收件箱',
    sent: '已发送',
    drafts: '草稿箱',
    trash: '垃圾箱',
    junk: '垃圾邮件',
    archive: '存档'
  }
  // 规范名（Inbox/Sent/…）直接换成中文，自定义名字原样保留
  if (zh[role] && /^[a-z _-]+$/i.test(clean)) return zh[role]!
  return clean
}

function readFileGuarded(path: string): Buffer {
  const st = statSync(path)
  if (st.size > MAX_FILE_BYTES) {
    throw new Error(
      `文件过大（${(st.size / 1024 / 1024 / 1024).toFixed(2)} GB），超过单文件 ${(
        MAX_FILE_BYTES / 1024 / 1024 / 1024
      ).toFixed(1)} GB 上限：${path}`
    )
  }
  return readFileSync(path)
}

/* ───────────────────────── 单元构造 ───────────────────────── */

function makeBoxUnit(boxPath: string, indPath: string | null): UnitHandle {
  const base = basename(boxPath, extname(boxPath))
  const handle: UnitHandle = {
    info: {
      name: prettyName(base),
      role: roleFromName(base),
      origin: boxPath,
      estimatedCount: -1
    },
    strategy: 'fox-separator',
    layout: null as IndLayout | null,

    async load(): Promise<Buffer[]> {
      return await collectUnit(handle)
    },

    async *stream(): AsyncIterable<Buffer> {
      const size = statSync(boxPath).size
      if (size > MAX_FILE_BYTES) {
        throw new Error(
          `文件过大（${(size / 1024 / 1024 / 1024).toFixed(2)} GB），超过 ${
            MAX_FILE_BYTES / 1024 / 1024 / 1024
          } GB 的安全上限：${boxPath}`
        )
      }

      if (size > inMemoryLimit()) {
        // ── 大文件：流式扫描定位 + 按需读取，峰值内存只与单封邮件有关 ──
        yield* streamLargeFile(boxPath, indPath, handle, (strategy, count) => {
          handle.strategy = strategy
          handle.info.estimatedCount = count
        })
        return
      }

      // ── 小文件：全量载入 + 深度雕刻（对畸形容器更宽容）──
      const box = readFileGuarded(boxPath)
      const sepOffsets = findFoxSeparators(box)
      let layout: IndLayout | null = null
      if (indPath && existsSync(indPath)) {
        try {
          layout = detectIndLayout(readFileSync(indPath), sepOffsets)
        } catch {
          layout = null
        }
      }
      // 记录下自标定结果，导出时沿用同一布局
      handle.layout = layout
      handle.strategy = layout
        ? `fox-separator + ind(records=${layout.recordCount})`
        : 'fox-separator'

      const carved = carveBySeparator(box)
      if (carved.length) {
        handle.info.estimatedCount = carved.length
        for (const m of carved) yield m.data
        return
      }

      const generic = carveGeneric(box)
      handle.strategy = generic.strategy
      handle.info.estimatedCount = generic.messages.length
      for (const m of generic.messages) yield m.data
    }
  }
  return handle
}

/**
 * 大文件的流式导入：先扫出每封报文的区间，再逐封读取。
 * 顺带用区间起点反推分隔符偏移，喂给 .ind 布局自标定。
 */
async function* streamLargeFile(
  path: string,
  indPath: string | null,
  handle: UnitHandle,
  onScanned: (strategy: string, count: number) => void
): AsyncIterable<Buffer> {
  const reader = new LargeFileReader(path)
  try {
    const outcome = reader.scan()
    if (!outcome.spans.length) {
      handle.strategy = 'none'
      onScanned('none', 0)
      return
    }

    // .ind 自标定：区间起点 = 分隔符偏移 + 16
    if (indPath && existsSync(indPath) && outcome.strategy === 'fox-separator') {
      try {
        const sepOffsets = outcome.spans.map((sp) => sp.start - 16)
        const layout = detectIndLayout(readFileSync(indPath), sepOffsets)
        if (layout) {
          handle.layout = layout
          onScanned(`fox-separator + ind(records=${layout.recordCount})`, outcome.spans.length)
        } else {
          onScanned('fox-separator', outcome.spans.length)
        }
      } catch {
        onScanned('fox-separator', outcome.spans.length)
      }
    } else {
      onScanned(outcome.strategy, outcome.spans.length)
    }

    handle.info.estimatedCount = outcome.spans.length
    for (const span of outcome.spans) {
      yield reader.read(span)
    }
  } finally {
    reader.close()
  }
}

function makeOpaqueUnit(path: string): UnitHandle {
  const base = basename(path)
  const unit: UnitHandle = {
    info: { name: prettyName(base), role: roleFromName(base), origin: path, estimatedCount: -1 },
    strategy: 'pending',
    layout: null,

    async load(): Promise<Buffer[]> {
      return await collectUnit(unit)
    },

    async *stream(): AsyncIterable<Buffer> {
      const size = statSync(path).size
      if (size > MAX_FILE_BYTES) {
        throw new Error(`文件过大（${(size / 1024 / 1024 / 1024).toFixed(2)} GB）：${path}`)
      }

      if (size > inMemoryLimit()) {
        // 大文件容器：先按分隔符，找不到再按报文头分块扫描
        const reader = new LargeFileReader(path)
        try {
          const outcome = reader.scan()
          unit.strategy = outcome.strategy
          unit.info.estimatedCount = outcome.spans.length
          for (const span of outcome.spans) yield reader.read(span)
        } finally {
          reader.close()
        }
        return
      }

      const buf = readFileGuarded(path)
      const result = carveGeneric(buf)
      unit.strategy = result.strategy
      unit.info.estimatedCount = result.messages.length
      for (const m of result.messages) yield m.data
    }
  }
  return unit
}

function makeMboxUnit(path: string): UnitHandle {
  const base = basename(path, extname(path))
  return {
    info: { name: prettyName(base), role: roleFromName(base), origin: path, estimatedCount: -1 },
    strategy: 'mbox-from',
    layout: null,
    async load(): Promise<Buffer[]> {
      const buf = readFileGuarded(path)
      const generic = carveGeneric(buf)
      this.strategy = generic.strategy
      return generic.messages.map((m) => m.data)
    }
  }
}

/** 一个目录下的散装报文（每封一个文件，或 Foxmail 7.2 Storage 里的分片文件） */
function makeLooseFilesUnit(dir: string, files: string[]): UnitHandle {
  const name = basename(dir) || dir
  return {
    info: {
      name: prettyName(name),
      role: roleFromName(name),
      origin: dir,
      estimatedCount: files.length
    },
    strategy: 'loose-files',
    layout: null,
    async load(): Promise<Buffer[]> {
      const out: Buffer[] = []
      for (const f of files) {
        try {
          const buf = readFileGuarded(f)
          if (looksLikeRfc822(buf)) out.push(buf)
          else out.push(...carveGeneric(buf, { deep: false }).messages.map((m) => m.data))
        } catch {
          /* 跳过坏文件 */
        }
      }
      return out
    }
  }
}

/** 一个目录下的 .eml 集合 */
function makeEmlDirUnit(dir: string, files: string[]): UnitHandle {
  const name = basename(dir) || dir
  return {
    info: { name: prettyName(name), role: roleFromName(name), origin: dir, estimatedCount: files.length },
    strategy: 'eml-files',
    layout: null,
    async load(): Promise<Buffer[]> {
      const out: Buffer[] = []
      for (const f of files) {
        try {
          out.push(readFileGuarded(f))
        } catch {
          /* skip */
        }
      }
      return out
    }
  }
}

/* ───────────────────────── 目录扫描 ───────────────────────── */

interface ScanResult {
  units: UnitHandle[]
  warnings: string[]
  hasFmStorageList: boolean
  hasMailDir: boolean
  hasStorageDir: boolean
}

async function scanDirectory(root: string): Promise<ScanResult> {
  const units: UnitHandle[] = []
  const warnings: string[] = []
  let hasFmStorageList = false
  let hasMailDir = false
  let hasStorageDir = false

  const looseByDir = new Map<string, string[]>()
  const emlByDir = new Map<string, string[]>()

  // 先处理 FMStorage.list（Foxmail 7.2 的存储位置清单）
  const roots: string[] = [root]
  const listPath = join(root, 'FMStorage.list')
  if (existsSync(listPath)) {
    hasFmStorageList = true
    try {
      const text = readFileSync(listPath, 'utf8')
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim()
        if (!line) continue
        // 可能是相对路径，也可能是绝对路径（Windows 上常见 D:\...）
        const candidates = [resolve(root, line), line, join(root, line)]
        for (const c of candidates) {
          if (existsSync(c)) {
            roots.push(c)
            break
          }
        }
      }
    } catch (err) {
      warnings.push(`FMStorage.list 读取失败：${String(err)}`)
    }
  }
  if (existsSync(join(root, 'mail'))) hasMailDir = true
  if (existsSync(join(root, 'Storage'))) hasStorageDir = true

  const seen = new Set<string>()

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 12) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        if (seen.has(full)) continue
        seen.add(full)
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (seen.has(full)) continue
      seen.add(full)

      const ext = extname(entry.name).toLowerCase()
      if (ext === '.box') {
        const indPath = `${full.slice(0, full.length - 4)}.ind`
        units.push(makeBoxUnit(full, existsSync(indPath) ? indPath : null))
        continue
      }
      if (ext === '.ind') continue // 随 .box 一起处理
      if (ext === '.eml') {
        const list = emlByDir.get(dir) ?? []
        list.push(full)
        emlByDir.set(dir, list)
        continue
      }
      if (ext === '.mbox' || ext === '.mbx') {
        units.push(makeMboxUnit(full))
        continue
      }
      if (ext === '.fox') {
        units.push(makeOpaqueUnit(full))
        continue
      }
      if (ext === '.zip') {
        // 交给上层的 zip 分支处理
        units.push(makeOpaqueUnit(full))
        continue
      }
      if (/^\.(db|dat|log|ini|list|bak|tmp|lock|idx|rec|stg|cfg)$/i.test(ext)) continue

      // 没有已知扩展名：先看内容像不像报文（只读头部 8KB，不整文件读入）
      if (statSync(full).size < 1024 * 1024 * 64) {
        try {
          const fd = openSync(full, 'r')
          const head = Buffer.alloc(8192)
          let read = 0
          try {
            read = readSync(fd, head, 0, head.length, 0)
          } finally {
            closeSync(fd)
          }
          const slice = head.subarray(0, read)
          if (looksLikeRfc822(slice) || findFoxSeparators(slice, 1).length > 0) {
            const list = looseByDir.get(dir) ?? []
            list.push(full)
            looseByDir.set(dir, list)
          }
        } catch {
          /* skip */
        }
      }
    }
  }

  for (const r of roots) await walk(r, 0)

  for (const [dir, files] of looseByDir) units.push(makeLooseFilesUnit(dir, files))
  for (const [dir, files] of emlByDir) units.push(makeEmlDirUnit(dir, files))

  return { units, warnings, hasFmStorageList, hasMailDir, hasStorageDir }
}

/* ───────────────────────── 单文件识别 ───────────────────────── */

async function openZipFile(zipPath: string): Promise<{ units: UnitHandle[]; warnings: string[] }> {
  const units: UnitHandle[] = []
  const warnings: string[] = []
  const entries = listZipEntries(zipPath)

  const emlByDir = new Map<string, ZipEntry[]>()
  const looseByDir = new Map<string, ZipEntry[]>()

  const readEntry = (e: ZipEntry): Buffer | null => {
    try {
      return readZipEntry(zipPath, e)
    } catch (err) {
      warnings.push(`条目 ${e.name} 读取失败：${String(err)}`)
      return null
    }
  }

  for (const entry of entries) {
    const ext = extname(entry.name).toLowerCase()
    if (ext === '.box') {
      const base = basename(entry.name, '.box')
      const dirPart = entry.name.slice(0, entry.name.length - basename(entry.name).length)
      const indEntry = entries.find((x) => x.name === `${dirPart}${base}.ind`)
      units.push({
        info: { name: prettyName(base), role: roleFromName(base), origin: `zip:${entry.name}`, estimatedCount: -1 },
        strategy: 'zip-box',
        layout: null,
        async load(): Promise<Buffer[]> {
          const box = readEntry(entry)
          if (!box) return []
          const seps = findFoxSeparators(box)
          if (indEntry) {
            const ind = readEntry(indEntry)
            if (ind) this.layout = detectIndLayout(ind, seps)
          }
          if (this.layout) this.strategy = `zip-box + ind(records=${this.layout.recordCount})`
          const carved = carveBySeparator(box)
          if (carved.length) return carved.map((m) => m.data)
          const generic = carveGeneric(box)
          this.strategy = generic.strategy
          return generic.messages.map((m) => m.data)
        }
      })
      continue
    }
    if (ext === '.eml') {
      const dir = dirname(entry.name)
      const list = emlByDir.get(dir) ?? []
      list.push(entry)
      emlByDir.set(dir, list)
      continue
    }
    if (ext === '.mbox') {
      units.push({
        info: {
          name: prettyName(basename(entry.name, '.mbox')),
          role: roleFromName(entry.name),
          origin: `zip:${entry.name}`,
          estimatedCount: -1
        },
        strategy: 'mbox-from',
        layout: null,
        async load(): Promise<Buffer[]> {
          const buf = readEntry(entry)
          if (!buf) return []
          const g = carveGeneric(buf)
          this.strategy = g.strategy
          return g.messages.map((m) => m.data)
        }
      })
      continue
    }
    if (ext === '.fox') {
      units.push({
        info: {
          name: prettyName(basename(entry.name, '.fox')),
          role: roleFromName(entry.name),
          origin: `zip:${entry.name}`,
          estimatedCount: -1
        },
        strategy: 'pending',
        layout: null,
        async load(): Promise<Buffer[]> {
          const buf = readEntry(entry)
          if (!buf) return []
          const g = carveGeneric(buf)
          this.strategy = g.strategy
          return g.messages.map((m) => m.data)
        }
      })
      continue
    }
    if (/^\.(db|dat|log|ini|list|bak|tmp|lock|idx|rec|stg|cfg)$/i.test(ext)) continue

    const dir = dirname(entry.name)
    const list = looseByDir.get(dir) ?? []
    list.push(entry)
    looseByDir.set(dir, list)
  }

  for (const [dir, list] of looseByDir) {
    units.push({
      info: {
        name: prettyName(basename(dir) || basename(zipPath, '.zip')),
        role: roleFromName(dir || zipPath),
        origin: `zip:${dir}`,
        estimatedCount: list.length
      },
      strategy: 'loose-zip-entries',
      layout: null,
      async load(): Promise<Buffer[]> {
        const out: Buffer[] = []
        for (const e of list) {
          const buf = readEntry(e)
          if (!buf) continue
          if (looksLikeRfc822(buf)) out.push(buf)
          else out.push(...carveGeneric(buf, { deep: false }).messages.map((m) => m.data))
        }
        return out
      }
    })
  }

  for (const [dir, list] of emlByDir) {
    units.push({
      info: {
        name: prettyName(basename(dir) || basename(zipPath, '.zip')),
        role: roleFromName(dir || zipPath),
        origin: `zip:${dir}`,
        estimatedCount: list.length
      },
      strategy: 'eml-files',
      layout: null,
      async load(): Promise<Buffer[]> {
        const out: Buffer[] = []
        for (const e of list) {
          const buf = readEntry(e)
          if (buf) out.push(buf)
        }
        return out
      }
    })
  }

  return { units, warnings }
}

function detectFileKind(path: string, head: Buffer): ArchiveKind {
  if (isSmfxContainer(head)) return 'foxmail-fox'
  if (isZipFile(head)) return 'zip'
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'unknown'
  if (head.length >= 6 && head.subarray(0, 6).toString('latin1') === '7z\xbc\xaf\x27\x1c') return 'opaque'
  if (head.length >= 4 && head.subarray(0, 4).toString('latin1') === 'Rar!') return 'opaque'

  const ext = extname(path).toLowerCase()
  if (findFoxSeparators(head, 1).length > 0) return 'foxmail-boxind'
  if (looksLikeRfc822(head)) return ext === '.mbox' ? 'mbox' : 'eml-tree'
  if (ext === '.fox') return 'foxmail-fox'
  return 'opaque'
}

/* ───────────────────────── 对外入口 ───────────────────────── */

export async function openArchive(path: string): Promise<OpenedArchive> {
  const abs = resolve(path)
  if (!existsSync(abs)) throw new Error(`路径不存在：${abs}`)
  const st = statSync(abs)

  if (st.isDirectory()) {
    const scan = await scanDirectory(abs)
    const kind: ArchiveKind = scan.hasFmStorageList
      ? 'foxmail-storage'
      : scan.hasMailDir
        ? 'foxmail-boxind'
        : scan.units.some((u) => u.strategy === 'eml-files')
          ? 'eml-tree'
          : 'foxmail-boxind'

    const detailParts: string[] = []
    if (scan.hasFmStorageList) detailParts.push('检测到 FMStorage.list（Foxmail 7.2 数据目录）')
    if (scan.hasMailDir) detailParts.push('检测到 mail/ 子目录（老版 Foxmail 数据目录）')
    if (scan.hasStorageDir) detailParts.push('检测到 Storage/ 子目录')
    detailParts.push(`识别到 ${scan.units.length} 个邮件文件夹`)

    const detection: ArchiveDetection = {
      kind,
      detail: detailParts.join('；'),
      units: scan.units.map((u) => u.info),
      warnings: scan.warnings
    }
    return { detection, units: scan.units }
  }

  const fd = readFileSync(abs)
  const head = fd.subarray(0, Math.min(fd.length, 8192))
  const kind = detectFileKind(abs, head)

  // 本程序自己导出的存档：走自带清单，100% 无损还原
  if (isSmfxContainer(head)) {
    const archive = readFoxContainer(abs)
    const units: UnitHandle[] = archive.manifest.folders.map((folder) => ({
      info: {
        name: folder.name,
        role: folder.role,
        origin: `simplemail:${folder.name}`,
        estimatedCount: folder.mails.length
      },
      strategy: 'simplemail-manifest',
      layout: null,
      async load(): Promise<Buffer[]> {
        const out: Buffer[] = []
        for (const m of folder.mails) {
          if (m.offset + m.length > archive.payload.length) continue
          out.push(Buffer.from(archive.payload.subarray(m.offset, m.offset + m.length)))
        }
        return out
      }
    }))
    return {
      detection: {
        kind: 'foxmail-fox',
        detail: `SimpleMail 存档容器 v${archive.manifest.version}（批次：${
          archive.manifest.archiveTag || '未命名'
        }，共 ${units.length} 个文件夹）`,
        units: units.map((u) => u.info),
        warnings: []
      },
      units
    }
  }

  if (kind === 'zip') {
    const { units, warnings } = await openZipFile(abs)
    return {
      detection: {
        kind: 'zip',
        detail: `ZIP 压缩包，内含 ${units.length} 个邮件文件夹`,
        units: units.map((u) => u.info),
        warnings
      },
      units
    }
  }

  const base = basename(abs)
  const ext = extname(abs).toLowerCase()

  if (ext === '.box') {
    const indPath = `${abs.slice(0, abs.length - 4)}.ind`
    const unit = makeBoxUnit(abs, existsSync(indPath) ? indPath : null)
    return {
      detection: {
        kind: 'foxmail-boxind',
        detail: existsSync(indPath) ? 'Foxmail .box + .ind 文件对' : 'Foxmail .box 文件（无 .ind 索引）',
        units: [unit.info],
        warnings: []
      },
      units: [unit]
    }
  }

  if (ext === '.mbox' || ext === '.mbx') {
    const unit = makeMboxUnit(abs)
    return {
      detection: { kind: 'mbox', detail: '标准 mbox 文件', units: [unit.info], warnings: [] },
      units: [unit]
    }
  }

  // .fox 以及所有无法识别的二进制 → 深度雕刻
  const unit = makeOpaqueUnit(abs)
  const isFox = ext === '.fox'
  return {
    detection: {
      kind: isFox ? 'foxmail-fox' : kind,
      detail: isFox
        ? 'Foxmail 7.2 单文件存档（.fox，私有格式）→ 使用报文雕刻导入'
        : '未识别的容器 → 使用报文雕刻导入',
      units: [unit.info],
      warnings: isFox
        ? []
        : ['该文件不是已知的 Foxmail 存档格式，已按通用二进制雕刻处理，请核对导入数量。']
    },
    units: [unit]
  }
}

/** 存档体检：只报告结构，不写库。用于把报告发回来定位私有格式。 */
export async function inspectArchive(path: string, scanMessages = true): Promise<ArchiveInspection> {
  const abs = resolve(path)
  if (!existsSync(abs)) throw new Error(`路径不存在：${abs}`)
  const st = statSync(abs)

  let head = Buffer.alloc(0)
  if (st.isFile()) head = readFileSync(abs).subarray(0, 64)
  const dump = headDump(head, 64)

  const opened = await openArchive(abs)
  const scanned: ArchiveInspection['scanned'] = []

  for (const unit of opened.units) {
    if (!scanMessages) {
      scanned.push({ name: unit.info.name, origin: unit.info.origin, messages: -1, strategy: 'skipped' })
      continue
    }
    try {
      // 只计数，不保留报文 —— 体检一样要能吃下几个 GB 的存档
      let count = 0
      for await (const message of iterateUnit(unit)) {
        void message
        count++
      }
      scanned.push({
        name: unit.info.name,
        origin: unit.info.origin,
        messages: count,
        strategy: unit.strategy
      })
    } catch (err) {
      scanned.push({
        name: unit.info.name,
        origin: unit.info.origin,
        messages: -1,
        strategy: `error: ${err instanceof Error ? err.message : String(err)}`
      })
    }
  }

  return {
    path: abs,
    size: st.size,
    kind: opened.detection.kind,
    detail: opened.detection.detail,
    headHex: dump.hex,
    headAscii: dump.ascii,
    units: opened.detection.units,
    scanned,
    warnings: opened.detection.warnings
  }
}
