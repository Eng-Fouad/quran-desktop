// @ts-check
/**
 * Icon container formats, written deterministically (fixed entry order, no timestamps):
 *  - ICO: PNG entries ≥ 256 px, 32-bit BMP (straight alpha + AND mask) below, the layout the `ico` crate and Windows'
 *    own icons use, which every consumer (Explorer, the RC compiler, NSIS) reads;
 *  - ICNS: PNG entries plus the legacy RLE `is32`/`il32` + `s8mk`/`l8mk` for 16 and 32 px, the set `tauri icon` writes.
 * Readers decode both back to RGBA for `build.mjs --check`.
 */
import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'

/** @typedef {{ width: number, height: number, data: Buffer }} Rgba */

/**
 * The part of the pngjs API used here. pngjs (CommonJS) ships no type declarations and dependencies are frozen, so it
 * is loaded through `createRequire` and typed by hand.
 * @typedef {{ deflateLevel: number, deflateStrategy: number, filterType: number, colorType: 2 | 6 }} PngWriteOptions
 * @typedef {{
 *   PNG: {
 *     new (options: { width: number, height: number }): Rgba,
 *     sync: { read(png: Buffer): Rgba, write(png: Rgba, options: PngWriteOptions): Buffer },
 *   },
 * }} PngJs
 */
const pngjs = /** @type {PngJs} */ (createRequire(import.meta.url)('pngjs'))

/** @param {Buffer} png @returns {Rgba} */
export function decodePng(png) {
  const img = pngjs.PNG.sync.read(png)
  return { width: img.width, height: img.height, data: img.data }
}

/**
 * Encode RGBA as a compact PNG (zlib level 9, best whole-image filter; RGB when fully opaque). Deterministic.
 * @param {Rgba} img
 * @returns {Buffer}
 */
export function encodePng(img) {
  const png = new pngjs.PNG({ width: img.width, height: img.height })
  img.data.copy(png.data)
  let opaque = true
  for (let i = 3; i < img.data.length; i += 4) {
    if (img.data.readUInt8(i) !== 255) {
      opaque = false
      break
    }
  }
  // Smallest of the whole-image filter choices; zlib's default strategy (pngjs defaults to Z_RLE, which bloats gradients).
  /** @type {Buffer | undefined} */
  let best
  for (const filterType of [1, 4, 2, 3, 0, -1]) {
    const out = pngjs.PNG.sync.write(png, {
      deflateLevel: 9,
      deflateStrategy: 0,
      filterType,
      colorType: opaque ? 2 : 6,
    })
    if (!best || out.length < best.length) best = out
  }
  if (!best) throw new Error('PNG encoding produced nothing')
  return best
}

/** Re-encode a PNG with {@link encodePng}; the pixels are unchanged. */
export function optimisePng(/** @type {Buffer} */ png) {
  return encodePng(decodePng(png))
}

/** @param {Buffer} buf */
export function isPng(buf) {
  return buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a
}

// ---------------------------------------------------------------------------------------------------------------------
// ICO

/** 32-bit BMP (DIB) for an ICO entry: BITMAPINFOHEADER, bottom-up BGRA rows, then the 1-bpp AND mask. */
function bmpEntry(/** @type {Rgba} */ img) {
  const { width: w, height: h, data } = img
  const maskStride = Math.ceil(w / 32) * 4
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(w, 4)
  header.writeInt32LE(h * 2, 8) // XOR + AND bitmaps
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16) // BI_RGB
  header.writeUInt32LE(w * h * 4 + maskStride * h, 20)
  const pixels = Buffer.alloc(w * h * 4)
  const mask = Buffer.alloc(maskStride * h)
  for (let y = 0; y < h; y++) {
    const row = h - 1 - y // bottom-up
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4
      const d = (row * w + x) * 4
      const r = data.readUInt8(s)
      const g = data.readUInt8(s + 1)
      const b = data.readUInt8(s + 2)
      const a = data.readUInt8(s + 3)
      pixels.writeUInt8(b, d)
      pixels.writeUInt8(g, d + 1)
      pixels.writeUInt8(r, d + 2)
      pixels.writeUInt8(a, d + 3)
      if (a === 0) {
        const m = row * maskStride + (x >> 3)
        mask.writeUInt8(mask.readUInt8(m) | (0x80 >> (x & 7)), m)
      }
    }
  }
  return Buffer.concat([header, pixels, mask])
}

/**
 * @param {{ size: number, png: Buffer }[]} images ascending sizes, square
 * @returns {Buffer}
 */
export function encodeIco(images) {
  const sorted = [...images].sort((a, b) => a.size - b.size)
  const payloads = sorted.map(({ size, png }) => {
    const img = decodePng(png)
    if (img.width !== size || img.height !== size)
      throw new Error(`ICO entry ${size}: image is ${img.width}×${img.height}`)
    return size >= 256 ? png : bmpEntry(img)
  })
  const head = Buffer.alloc(6 + 16 * sorted.length)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2) // icon
  head.writeUInt16LE(sorted.length, 4)
  let offset = head.length
  sorted.forEach(({ size }, i) => {
    const payload = payloads[i]
    if (!payload) throw new Error('ICO: missing payload')
    const e = 6 + 16 * i
    head.writeUInt8(size >= 256 ? 0 : size, e)
    head.writeUInt8(size >= 256 ? 0 : size, e + 1)
    head.writeUInt8(0, e + 2) // palette size
    head.writeUInt8(0, e + 3)
    head.writeUInt16LE(1, e + 4) // planes
    head.writeUInt16LE(32, e + 6) // bits per pixel
    head.writeUInt32LE(payload.length, e + 8)
    head.writeUInt32LE(offset, e + 12)
    offset += payload.length
  })
  return Buffer.concat([head, ...payloads])
}

/**
 * @param {Buffer} ico
 * @returns {{ size: number, format: 'png' | 'bmp', image: Rgba }[]}
 */
export function readIco(ico) {
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error('not an ICO file')
  const count = ico.readUInt16LE(4)
  /** @type {{ size: number, format: 'png' | 'bmp', image: Rgba }[]} */
  const out = []
  for (let i = 0; i < count; i++) {
    const e = 6 + 16 * i
    const size = ico.readUInt8(e) || 256
    const length = ico.readUInt32LE(e + 8)
    const offset = ico.readUInt32LE(e + 12)
    const data = ico.subarray(offset, offset + length)
    if (isPng(data)) {
      out.push({ size, format: 'png', image: decodePng(data) })
      continue
    }
    const w = data.readInt32LE(4)
    const h = data.readInt32LE(8) / 2
    if (data.readUInt16LE(14) !== 32)
      throw new Error(`ICO entry ${size}: only 32-bit BMP entries are supported`)
    const px = Buffer.alloc(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = 40 + ((h - 1 - y) * w + x) * 4
        const d = (y * w + x) * 4
        px.writeUInt8(data.readUInt8(s + 2), d)
        px.writeUInt8(data.readUInt8(s + 1), d + 1)
        px.writeUInt8(data.readUInt8(s), d + 2)
        px.writeUInt8(data.readUInt8(s + 3), d + 3)
      }
    }
    out.push({ size, format: 'bmp', image: { width: w, height: h, data: px } })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// ICNS

/** Apple's icns RLE for one channel: `n < 0x80` → n + 1 literal bytes; `n ≥ 0x80` → next byte repeated n − 125 times. */
function rleChannel(/** @type {number[]} */ bytes) {
  /** @type {number[]} */
  const out = []
  let i = 0
  while (i < bytes.length) {
    let run = 1
    while (i + run < bytes.length && run < 130 && bytes[i + run] === bytes[i]) run++
    if (run >= 3) {
      out.push(0x80 + run - 3, bytes[i] ?? 0)
      i += run
      continue
    }
    const start = i
    while (i < bytes.length && i - start < 128) {
      if (i + 2 < bytes.length && bytes[i] === bytes[i + 1] && bytes[i] === bytes[i + 2]) break
      i++
    }
    out.push(i - start - 1, ...bytes.slice(start, i))
  }
  return out
}

/** @param {Buffer} data @param {number} pixels @returns {number[][]} R, G, B channels */
function unrle(data, pixels) {
  /** @type {number[][]} */
  const channels = []
  let o = 0
  for (let ch = 0; ch < 3; ch++) {
    /** @type {number[]} */
    const out = []
    while (out.length < pixels) {
      const n = data.readUInt8(o++)
      if (n < 0x80) {
        for (let k = 0; k <= n; k++) out.push(data.readUInt8(o++))
      } else {
        const v = data.readUInt8(o++)
        for (let k = 0; k < n - 125; k++) out.push(v)
      }
    }
    channels.push(out)
  }
  return channels
}

/** Legacy 16/32 px pair: RLE RGB (`is32`/`il32`) and an 8-bit alpha mask (`s8mk`/`l8mk`). */
function legacyPair(/** @type {Rgba} */ img) {
  const n = img.width * img.height
  /** @type {number[][]} */
  const ch = [[], [], []]
  const alpha = Buffer.alloc(n)
  for (let p = 0; p < n; p++) {
    for (let c = 0; c < 3; c++) ch[c]?.push(img.data.readUInt8(p * 4 + c))
    alpha.writeUInt8(img.data.readUInt8(p * 4 + 3), p)
  }
  const rgb = Buffer.from(ch.flatMap((c) => rleChannel(c)))
  return { rgb, alpha }
}

/** PNG-backed ICNS types by pixel size (`@2x` types share a pixel size with a 1x type). */
export const ICNS_PNG_TYPES = Object.freeze([
  ['ic11', 32],
  ['ic12', 64],
  ['ic07', 128],
  ['ic13', 256],
  ['ic08', 256],
  ['ic14', 512],
  ['ic09', 512],
  ['ic10', 1024],
])

/**
 * @param {Map<number, Buffer>} pngs PNG per pixel size: 16, 32, 64, 128, 256, 512, 1024
 * @returns {Buffer}
 */
export function encodeIcns(pngs) {
  const get = (/** @type {number} */ size) => {
    const png = pngs.get(size)
    if (!png) throw new Error(`ICNS: no ${size} px image`)
    const img = decodePng(png)
    if (img.width !== size || img.height !== size)
      throw new Error(`ICNS ${size}: image is ${img.width}×${img.height}`)
    return { png, img }
  }
  const s16 = legacyPair(get(16).img)
  const s32 = legacyPair(get(32).img)
  /** @type {[string, Buffer][]} */
  const entries = [
    ['is32', s16.rgb],
    ['s8mk', s16.alpha],
    ['il32', s32.rgb],
    ['l8mk', s32.alpha],
    ...ICNS_PNG_TYPES.map(
      ([type, size]) => /** @type {[string, Buffer]} */ ([String(type), get(Number(size)).png]),
    ),
  ]
  const parts = entries.map(([type, data]) => {
    const h = Buffer.alloc(8)
    h.write(type, 0, 'latin1')
    h.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([h, data])
  })
  const total = 8 + parts.reduce((s, p) => s + p.length, 0)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'latin1')
  head.writeUInt32BE(total, 4)
  return Buffer.concat([head, ...parts])
}

/** @param {Buffer} icns @returns {Map<string, Buffer>} raw entry data by type */
export function readIcnsEntries(icns) {
  if (icns.toString('latin1', 0, 4) !== 'icns') throw new Error('not an ICNS file')
  /** @type {Map<string, Buffer>} */
  const out = new Map()
  let o = 8
  while (o + 8 <= icns.length) {
    const type = icns.toString('latin1', o, o + 4)
    const len = icns.readUInt32BE(o + 4)
    if (len < 8) throw new Error(`ICNS: bad length for ${type}`)
    out.set(type, icns.subarray(o + 8, o + len))
    o += len
  }
  return out
}

/**
 * Decode every image of an ICNS file to RGBA, keyed by type (`is32`/`il32` merged with their masks).
 * @param {Buffer} icns
 * @returns {Map<string, Rgba>}
 */
export function readIcns(icns) {
  const entries = readIcnsEntries(icns)
  /** @type {Map<string, Rgba>} */
  const out = new Map()
  for (const [type, data] of entries) {
    if (isPng(data)) out.set(type, decodePng(data))
  }
  for (const [rgbType, maskType, size] of /** @type {const} */ ([
    ['is32', 's8mk', 16],
    ['il32', 'l8mk', 32],
  ])) {
    const rgb = entries.get(rgbType)
    const mask = entries.get(maskType)
    if (!rgb || !mask) continue
    const n = size * size
    const [r, g, b] = unrle(rgb, n)
    const px = Buffer.alloc(n * 4)
    for (let p = 0; p < n; p++) {
      px.writeUInt8(r?.[p] ?? 0, p * 4)
      px.writeUInt8(g?.[p] ?? 0, p * 4 + 1)
      px.writeUInt8(b?.[p] ?? 0, p * 4 + 2)
      px.writeUInt8(mask.readUInt8(p), p * 4 + 3)
    }
    out.set(rgbType, { width: size, height: size, data: px })
  }
  return out
}

/**
 * Compare two RGBA images. `tolerance` is the largest per-channel difference that still counts as equal.
 * @param {Rgba} a
 * @param {Rgba} b
 * @param {number} tolerance
 */
export function compareRgba(a, b, tolerance) {
  if (a.width !== b.width || a.height !== b.height)
    return {
      equal: false,
      reason: `size ${a.width}×${a.height} vs ${b.width}×${b.height}`,
      differing: -1,
      maxDelta: -1,
    }
  let differing = 0
  let maxDelta = 0
  for (let p = 0; p < a.width * a.height; p++) {
    let worst = 0
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a.data.readUInt8(p * 4 + c) - b.data.readUInt8(p * 4 + c))
      if (d > worst) worst = d
    }
    if (worst > tolerance) differing++
    if (worst > maxDelta) maxDelta = worst
  }
  return {
    equal: differing === 0,
    reason: differing ? `${differing} px differ (max Δ ${maxDelta})` : '',
    differing,
    maxDelta,
  }
}
