// 一次性图标生成脚本：手工光栅化品牌图标（橙底圆角方块 + 白色播放三角）
// 用法：bun run packages/transcript-viewer/scripts/generate-icons.ts
//
// 注意：PNG 的 IDAT 必须是 zlib 包裹的 deflate（RFC1950，含 2 字节头 + Adler32 尾）。
// 用 node:zlib 的 deflateSync 而非 Bun.deflateSync —— 后者产出的流头部不规范，
// 浏览器宽容能显示，但 Rust image crate（Tauri 图标生成）会拒绝解码。

import { deflateSync } from 'node:zlib'

const ORANGE = [0xd9, 0x77, 0x06] as const
const WHITE = [0xff, 0xff, 0xff] as const

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  const crcBuf = out.subarray(4, 8 + data.length)
  dv.setUint32(8 + data.length, crc32(crcBuf))
  return out
}

// 多采样抗锯齿的覆盖率计算
function coverage(
  px: number,
  py: number,
  size: number,
  inside: (x: number, y: number) => boolean,
): number {
  const SAMPLES = 4
  let hit = 0
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      const x = px + (sx + 0.5) / SAMPLES
      const y = py + (sy + 0.5) / SAMPLES
      if (inside(x / size, y / size)) hit++
    }
  }
  return hit / (SAMPLES * SAMPLES)
}

// 圆角方块（归一化坐标，半径 0.22）
function inRoundedRect(x: number, y: number): boolean {
  const r = 0.22
  const cx = Math.max(r, Math.min(1 - r, x))
  const cy = Math.max(r, Math.min(1 - r, y))
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

// 播放三角：顶点 (0.40,0.3125) (0.40,0.6875) (0.672,0.5)
function inTriangle(x: number, y: number): boolean {
  const x0 = 0.4
  const y0 = 0.3125
  const y1 = 0.6875
  const x1 = 0.672
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const t = (x - x0) / (x1 - x0)
  const half = (y1 - y0) / 2
  const mid = (y0 + y1) / 2
  return Math.abs(y - mid) <= half * (1 - t)
}

function makePng(size: number): Uint8Array {
  // raw scanlines: filter byte + RGBA
  const raw = new Uint8Array(size * (1 + size * 4))
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4)
    raw[row] = 0
    for (let x = 0; x < size; x++) {
      const rectCov = coverage(x, y, size, inRoundedRect)
      const triCov = coverage(x, y, size, inTriangle)
      const r = ORANGE[0] * (1 - triCov) + WHITE[0] * triCov
      const g = ORANGE[1] * (1 - triCov) + WHITE[1] * triCov
      const b = ORANGE[2] * (1 - triCov) + WHITE[2] * triCov
      const o = row + 1 + x * 4
      raw[o] = Math.round(r)
      raw[o + 1] = Math.round(g)
      raw[o + 2] = Math.round(b)
      raw[o + 3] = Math.round(255 * rectCov)
    }
  }

  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, size)
  dv.setUint32(4, size)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const idat = deflateSync(raw)

  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const parts = [
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(idat)),
    chunk('IEND', new Uint8Array(0)),
  ]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

const dir = new URL('../public/', import.meta.url).pathname
await Bun.write(`${dir}icon-512.png`, makePng(512))
await Bun.write(`${dir}apple-touch-icon.png`, makePng(180))
console.log('icons written to', dir)
