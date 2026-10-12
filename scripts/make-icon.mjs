#!/usr/bin/env node
/**
 * 生成应用图标（512×512 PNG）。
 *
 * 刻意**完全自绘**：一个浅蓝色圆角方块上放一个信封。
 * 不使用任何商业邮件客户端的图标素材，避免商标与著作权问题。
 * 纯 Node 实现（手写 PNG 编码），不依赖任何图像库。
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 512
const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..')

/* ── CRC32 ── */
const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

/* ── 画布 ── */
const px = Buffer.alloc(SIZE * SIZE * 4) // RGBA

function setPixel(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
  const i = (y * SIZE + x) * 4
  const src = a / 255
  const dstA = px[i + 3] / 255
  const outA = src + dstA * (1 - src)
  if (outA === 0) return
  px[i] = Math.round((r * src + px[i] * dstA * (1 - src)) / outA)
  px[i + 1] = Math.round((g * src + px[i + 1] * dstA * (1 - src)) / outA)
  px[i + 2] = Math.round((b * src + px[i + 2] * dstA * (1 - src)) / outA)
  px[i + 3] = Math.round(outA * 255)
}

/** 圆角矩形（带 1px 抗锯齿） */
function roundRect(x0, y0, x1, y1, radius, color) {
  const [r, g, b, a] = color
  for (let y = Math.floor(y0) - 1; y <= Math.ceil(y1) + 1; y++) {
    for (let x = Math.floor(x0) - 1; x <= Math.ceil(x1) + 1; x++) {
      const cx = Math.min(Math.max(x + 0.5, x0 + radius), x1 - radius)
      const cy = Math.min(Math.max(y + 0.5, y0 + radius), y1 - radius)
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      const dist = Math.sqrt(dx * dx + dy * dy)
      const cover = Math.min(1, Math.max(0, radius + 0.5 - dist))
      if (cover <= 0) continue
      setPixel(x, y, r, g, b, Math.round(a * cover))
    }
  }
}

/** 三角形填充（用于信封翻盖），三点重心坐标法 + 超采样抗锯齿 */
function triangle(p0, p1, p2, color, samples = 3) {
  const [r, g, b, a] = color
  const minX = Math.floor(Math.min(p0[0], p1[0], p2[0]))
  const maxX = Math.ceil(Math.max(p0[0], p1[0], p2[0]))
  const minY = Math.floor(Math.min(p0[1], p1[1], p2[1]))
  const maxY = Math.ceil(Math.max(p0[1], p1[1], p2[1]))

  const sign = (ax, ay, bx, by, cx, cy) => (ax - cx) * (by - cy) - (bx - cx) * (ay - cy)
  const d1 = sign(p0[0], p0[1], p1[0], p1[1], p2[0], p2[1])
  if (d1 === 0) return

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let inside = 0
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px0 = x + (sx + 0.5) / samples
          const py0 = y + (sy + 0.5) / samples
          const a1 = sign(px0, py0, p1[0], p1[1], p2[0], p2[1])
          const a2 = sign(p0[0], p0[1], px0, py0, p2[0], p2[1])
          const a3 = sign(p0[0], p0[1], p1[0], p1[1], px0, py0)
          const hasNeg = a1 < 0 || a2 < 0 || a3 < 0
          const hasPos = a1 > 0 || a2 > 0 || a3 > 0
          if (!(hasNeg && hasPos)) inside++
        }
      }
      if (!inside) continue
      const cover = inside / (samples * samples)
      setPixel(x, y, r, g, b, Math.round(a * cover))
    }
  }
}

/* ── 开始绘制 ── */

// 1) 圆角底：竖直渐变（#3f8fe0 → #2a6fc4）
const bgTop = [63, 143, 224]
const bgBottom = [38, 105, 190]
const R = 104
for (let y = 0; y < SIZE; y++) {
  const t = y / (SIZE - 1)
  const r = Math.round(bgTop[0] + (bgBottom[0] - bgTop[0]) * t)
  const g = Math.round(bgTop[1] + (bgBottom[1] - bgTop[1]) * t)
  const b = Math.round(bgTop[2] + (bgBottom[2] - bgTop[2]) * t)
  for (let x = 0; x < SIZE; x++) {
    const cx = Math.min(Math.max(x + 0.5, R), SIZE - R)
    const cy = Math.min(Math.max(y + 0.5, R), SIZE - R)
    const dx = x + 0.5 - cx
    const dy = y + 0.5 - cy
    const dist = Math.sqrt(dx * dx + dy * dy)
    const cover = Math.min(1, Math.max(0, R + 0.5 - dist))
    if (cover <= 0) continue
    setPixel(x, y, r, g, b, Math.round(255 * cover))
  }
}

// 2) 信封：白色纸面
const env = { x0: 108, y0: 156, x1: 404, y1: 356 }
roundRect(env.x0, env.y0, env.x1, env.y1, 22, [255, 255, 255, 255])

// 3) 信封的翻盖（一个从顶部两角收到中心的三角形），用淡蓝色做层次
const flapColor = [206, 226, 246, 255]
triangle(
  [env.x0 + 4, env.y0 + 4],
  [env.x1 - 4, env.y0 + 4],
  [(env.x0 + env.x1) / 2, env.y0 + 122],
  flapColor
)

// 4) 纸面下方的两条"折线"，让它更像信封
triangle(
  [env.x0 + 4, env.y1 - 4],
  [env.x0 + 132, env.y0 + 96],
  [env.x0 + 4, env.y0 + 96],
  [232, 241, 251, 255]
)
triangle(
  [env.x1 - 4, env.y1 - 4],
  [env.x1 - 132, env.y0 + 96],
  [env.x1 - 4, env.y0 + 96],
  [232, 241, 251, 255]
)

/* ── 编码 PNG ── */
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0 // filter: none
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const outDir = join(projectRoot, 'build')
mkdirSync(outDir, { recursive: true })
const iconPath = join(outDir, 'icon.png')
writeFileSync(iconPath, png)

// electron-builder 的 Linux 图标目录（多尺寸可选，这里放一张 512 就够）
const iconsDir = join(outDir, 'icons')
mkdirSync(iconsDir, { recursive: true })
writeFileSync(join(iconsDir, '512x512.png'), png)

console.log(`已生成图标：${iconPath}（${SIZE}×${SIZE}，${(png.length / 1024).toFixed(1)} KB）`)
