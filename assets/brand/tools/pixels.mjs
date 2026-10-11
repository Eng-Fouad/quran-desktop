// @ts-check
/**
 * Deterministic raster operations in plain JavaScript, used by build.mjs after the browser has decoded the source.
 *
 * Everything runs on Float64 planes in [0, 1] and is rounded to 8 bits once, at the end, so the output depends only on
 * the input pixels and the parameters in design.mjs: IEEE-754 doubles, and V8's own Math.sin/exp/pow, give the same
 * result on every machine (a last-ulp change between Node versions would not survive the rounding to 8 bits).
 *
 * - `Plane`: one channel (a mask, coverage or alpha).
 * - `Layer`: four premultiplied planes (r·a, g·a, b·a, a), sRGB-encoded, so resampling and "over" never fringe.
 */
import { Buffer } from 'node:buffer'

/** @typedef {{ width: number, height: number, data: Float64Array }} Plane */
/** @typedef {{ width: number, height: number, r: Float64Array, g: Float64Array, b: Float64Array, a: Float64Array }} Layer */
/** @typedef {{ width: number, height: number, data: Uint8Array | Buffer }} Rgba8 straight-alpha RGBA, 8 bits */
/** @typedef {[number, number, number]} Rgb colour, 0–255 sRGB */
/** @typedef {'box' | 'lanczos3'} Kernel */
/** @typedef {{ x: number, y: number, w: number, h: number }} Rect a source rectangle, in source pixels (may be fractional) */

const clamp01 = (/** @type {number} */ v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** @returns {Plane} */
export function plane(/** @type {number} */ width, /** @type {number} */ height, fill = 0) {
  const data = new Float64Array(width * height)
  if (fill) data.fill(fill)
  return { width, height, data }
}

/** @returns {Layer} */
export function layer(/** @type {number} */ width, /** @type {number} */ height) {
  const n = width * height
  return {
    width,
    height,
    r: new Float64Array(n),
    g: new Float64Array(n),
    b: new Float64Array(n),
    a: new Float64Array(n),
  }
}

/** Straight 8-bit RGBA → premultiplied layer. */
export function fromRgba8(/** @type {Rgba8} */ img) {
  const out = layer(img.width, img.height)
  for (let p = 0; p < img.width * img.height; p++) {
    const a = (img.data[p * 4 + 3] ?? 0) / 255
    out.r[p] = ((img.data[p * 4] ?? 0) / 255) * a
    out.g[p] = ((img.data[p * 4 + 1] ?? 0) / 255) * a
    out.b[p] = ((img.data[p * 4 + 2] ?? 0) / 255) * a
    out.a[p] = a
  }
  return out
}

/** Premultiplied layer → straight 8-bit RGBA (fully transparent pixels are written as 0,0,0,0). */
export function toRgba8(/** @type {Layer} */ l) {
  const data = Buffer.alloc(l.width * l.height * 4)
  for (let p = 0; p < l.width * l.height; p++) {
    const a8 = Math.round(clamp01(l.a[p] ?? 0) * 255)
    if (a8 === 0) continue
    const a = l.a[p] ?? 0
    data[p * 4] = Math.round(clamp01((l.r[p] ?? 0) / a) * 255)
    data[p * 4 + 1] = Math.round(clamp01((l.g[p] ?? 0) / a) * 255)
    data[p * 4 + 2] = Math.round(clamp01((l.b[p] ?? 0) / a) * 255)
    data[p * 4 + 3] = a8
  }
  return { width: l.width, height: l.height, data }
}

/** A single colour (black by default) with `alpha` as its coverage: template images and masks. */
export function maskToRgba8(/** @type {Plane} */ alpha, /** @type {Rgb} */ rgb = [0, 0, 0]) {
  const data = Buffer.alloc(alpha.width * alpha.height * 4)
  for (let p = 0; p < alpha.width * alpha.height; p++) {
    const a8 = Math.round(clamp01(alpha.data[p] ?? 0) * 255)
    if (a8 === 0) continue
    data[p * 4] = rgb[0]
    data[p * 4 + 1] = rgb[1]
    data[p * 4 + 2] = rgb[2]
    data[p * 4 + 3] = a8
  }
  return { width: alpha.width, height: alpha.height, data }
}

// ---------------------------------------------------------------------------------------------------------------------
// Resampling

/**
 * 1-D resampling weights: for each of `dn` output samples, the source taps and their normalised weights.
 * The output covers source [s0, s0 + sn); taps outside [0, srcN) read as 0 (transparent).
 * @param {number} srcN source length
 * @param {number} s0 source start (fractional)
 * @param {number} sn source span (fractional)
 * @param {number} dn output length
 * @param {Kernel} kernel
 * @returns {{ start: number, w: Float64Array }[]}
 */
function weights1d(srcN, s0, sn, dn, kernel) {
  const scale = sn / dn // source pixels per output pixel
  /** @type {{ start: number, w: Float64Array }[]} */
  const out = []
  for (let i = 0; i < dn; i++) {
    if (kernel === 'box') {
      // Exact area coverage of [x0, x1) over source pixels [k, k + 1).
      const x0 = s0 + i * scale
      const x1 = x0 + scale
      const start = Math.floor(x0)
      const end = Math.ceil(x1)
      const w = new Float64Array(end - start)
      for (let k = start; k < end; k++) {
        const overlap = Math.min(x1, k + 1) - Math.max(x0, k)
        w[k - start] = k >= 0 && k < srcN && overlap > 0 ? overlap / scale : 0
      }
      out.push({ start, w })
      continue
    }
    // Lanczos-3, widened by the scale when minifying.
    const support = 3 * Math.max(scale, 1)
    const f = 1 / Math.max(scale, 1)
    const centre = s0 + (i + 0.5) * scale - 0.5
    const start = Math.floor(centre - support) + 1
    const end = Math.floor(centre + support)
    const w = new Float64Array(end - start + 1)
    let sum = 0
    for (let k = start; k <= end; k++) {
      const x = (k - centre) * f
      let v = 1
      if (x !== 0) {
        if (Math.abs(x) >= 3) v = 0
        else {
          const px = Math.PI * x
          v = (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px)
        }
      }
      w[k - start] = v
      sum += v
    }
    for (let k = start; k <= end; k++) {
      const v = w[k - start] ?? 0
      w[k - start] = k >= 0 && k < srcN ? v / sum : 0
    }
    out.push({ start, w })
  }
  return out
}

/**
 * Resample planes from a source rectangle to `dw`×`dh` (separable; rows first). All planes share the geometry.
 * @param {Float64Array[]} planes
 * @param {number} sw source width
 * @param {number} sh source height
 * @param {Rect} rect
 * @param {number} dw
 * @param {number} dh
 * @param {Kernel} kernel
 * @returns {Float64Array[]}
 */
function resamplePlanes(planes, sw, sh, rect, dw, dh, kernel) {
  const wx = weights1d(sw, rect.x, rect.w, dw, kernel)
  const wy = weights1d(sh, rect.y, rect.h, dh, kernel)
  return planes.map((src) => {
    const tmp = new Float64Array(dw * sh)
    for (let y = 0; y < sh; y++) {
      const row = y * sw
      for (let i = 0; i < dw; i++) {
        const { start, w } = /** @type {{ start: number, w: Float64Array }} */ (wx[i])
        let acc = 0
        for (let k = 0; k < w.length; k++) {
          const wk = w[k] ?? 0
          if (wk !== 0) acc += wk * (src[row + start + k] ?? 0)
        }
        tmp[y * dw + i] = acc
      }
    }
    const dst = new Float64Array(dw * dh)
    for (let j = 0; j < dh; j++) {
      const { start, w } = /** @type {{ start: number, w: Float64Array }} */ (wy[j])
      for (let x = 0; x < dw; x++) {
        let acc = 0
        for (let k = 0; k < w.length; k++) {
          const wk = w[k] ?? 0
          if (wk !== 0) acc += wk * (tmp[(start + k) * dw + x] ?? 0)
        }
        dst[j * dw + x] = acc
      }
    }
    return dst
  })
}

/** Resample a plane (masks, coverage); values are clamped to [0, 1] afterwards. */
export function resamplePlane(
  /** @type {Plane} */ src,
  /** @type {Rect} */ rect,
  /** @type {number} */ dw,
  /** @type {number} */ dh,
  /** @type {Kernel} */ kernel = 'box',
) {
  const [data] = resamplePlanes([src.data], src.width, src.height, rect, dw, dh, kernel)
  const out = /** @type {Float64Array} */ (data)
  for (let p = 0; p < out.length; p++) out[p] = clamp01(out[p] ?? 0)
  return { width: dw, height: dh, data: out }
}

/** Resample a premultiplied layer; colour is clamped to its alpha (Lanczos overshoot). */
export function resampleLayer(
  /** @type {Layer} */ src,
  /** @type {Rect} */ rect,
  /** @type {number} */ dw,
  /** @type {number} */ dh,
  /** @type {Kernel} */ kernel = 'lanczos3',
) {
  const [r, g, b, a] = /** @type {Float64Array[]} */ (
    resamplePlanes([src.r, src.g, src.b, src.a], src.width, src.height, rect, dw, dh, kernel)
  )
  const out = { width: dw, height: dh, r, g, b, a }
  for (let p = 0; p < dw * dh; p++) {
    const al = clamp01(a?.[p] ?? 0)
    out.a[p] = al
    out.r[p] = Math.min(al, Math.max(0, out.r[p] ?? 0))
    out.g[p] = Math.min(al, Math.max(0, out.g[p] ?? 0))
    out.b[p] = Math.min(al, Math.max(0, out.b[p] ?? 0))
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// Filters

/** Separable Gaussian blur; outside the plane reads as 0. */
export function blur(/** @type {Plane} */ src, /** @type {number} */ sigma) {
  if (sigma <= 0) return { width: src.width, height: src.height, data: Float64Array.from(src.data) }
  const radius = Math.ceil(sigma * 3)
  const k = new Float64Array(radius * 2 + 1)
  let sum = 0
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma))
    k[i + radius] = v
    sum += v
  }
  for (let i = 0; i < k.length; i++) k[i] = (k[i] ?? 0) / sum
  const { width: w, height: h } = src
  const tmp = new Float64Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let i = -radius; i <= radius; i++) {
        const xx = x + i
        if (xx >= 0 && xx < w) acc += (k[i + radius] ?? 0) * (src.data[y * w + xx] ?? 0)
      }
      tmp[y * w + x] = acc
    }
  const out = new Float64Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let i = -radius; i <= radius; i++) {
        const yy = y + i
        if (yy >= 0 && yy < h) acc += (k[i + radius] ?? 0) * (tmp[yy * w + x] ?? 0)
      }
      out[y * w + x] = acc
    }
  return { width: w, height: h, data: out }
}

/** Unsharp mask: v + amount·(v − blur(v)), clamped to [0, 1]. */
export function unsharp(/** @type {Plane} */ src, /** @type {number} */ sigma, /** @type {number} */ amount) {
  if (amount === 0) return src
  const b = blur(src, sigma)
  const out = new Float64Array(src.data.length)
  for (let p = 0; p < out.length; p++) {
    const v = src.data[p] ?? 0
    out[p] = clamp01(v + amount * (v - (b.data[p] ?? 0)))
  }
  return { width: src.width, height: src.height, data: out }
}

/** Levels: maps [lo, hi] to [0, 1] (a contrast stretch of coverage). */
export function levels(/** @type {Plane} */ src, /** @type {number} */ lo, /** @type {number} */ hi) {
  const out = new Float64Array(src.data.length)
  for (let p = 0; p < out.length; p++) out[p] = clamp01(((src.data[p] ?? 0) - lo) / (hi - lo))
  return { width: src.width, height: src.height, data: out }
}

/** Pixel-wise product of two planes of the same size. */
export function multiply(/** @type {Plane} */ a, /** @type {Plane} */ b) {
  const out = new Float64Array(a.data.length)
  for (let p = 0; p < out.length; p++) out[p] = (a.data[p] ?? 0) * (b.data[p] ?? 0)
  return { width: a.width, height: a.height, data: out }
}

/**
 * Squared Euclidean distance to the nearest `true` pixel (Felzenszwalb–Huttenlocher, exact, O(n)).
 * @param {Uint8Array} feature 1 = feature pixel
 * @param {number} w
 * @param {number} h
 */
function squaredDistance(feature, w, h) {
  const INF = 1e20
  const d = new Float64Array(w * h)
  for (let p = 0; p < w * h; p++) d[p] = feature[p] ? 0 : INF
  const n = Math.max(w, h)
  const f = new Float64Array(n)
  const z = new Float64Array(n + 1)
  const v = new Int32Array(n)
  const out = new Float64Array(n)
  const pass = (/** @type {number} */ len) => {
    const meet = (/** @type {number} */ q, /** @type {number} */ vk) =>
      ((f[q] ?? 0) + q * q - ((f[vk] ?? 0) + vk * vk)) / (2 * q - 2 * vk)
    let k = 0
    v[0] = 0
    z[0] = -INF
    z[1] = INF
    for (let q = 1; q < len; q++) {
      let s = meet(q, v[k] ?? 0)
      while (s <= (z[k] ?? 0)) {
        k--
        s = meet(q, v[k] ?? 0)
      }
      k++
      v[k] = q
      z[k] = s
      z[k + 1] = INF
    }
    k = 0
    for (let q = 0; q < len; q++) {
      while ((z[k + 1] ?? 0) < q) k++
      const vk = v[k] ?? 0
      out[q] = (q - vk) * (q - vk) + (f[vk] ?? 0)
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = d[y * w + x] ?? INF
    pass(h)
    for (let y = 0; y < h; y++) d[y * w + x] = out[y] ?? INF
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = d[y * w + x] ?? INF
    pass(w)
    for (let x = 0; x < w; x++) d[y * w + x] = out[x] ?? INF
  }
  return d
}

/**
 * Signed distance (pixels) to the 0.5 contour of a coverage plane: negative inside, positive outside.
 * @param {Plane} coverage
 * @returns {Plane}
 */
export function signedDistance(coverage) {
  const { width: w, height: h } = coverage
  const inside = new Uint8Array(w * h)
  const outside = new Uint8Array(w * h)
  for (let p = 0; p < w * h; p++) {
    const v = (coverage.data[p] ?? 0) >= 0.5
    inside[p] = v ? 1 : 0
    outside[p] = v ? 0 : 1
  }
  const toInside = squaredDistance(inside, w, h)
  const toOutside = squaredDistance(outside, w, h)
  const data = new Float64Array(w * h)
  for (let p = 0; p < w * h; p++)
    data[p] = inside[p] ? -(Math.sqrt(toOutside[p] ?? 0) - 0.5) : Math.sqrt(toInside[p] ?? 0) - 0.5
  return { width: w, height: h, data }
}

/** Grow (positive `px`) or shrink a shape given by its signed distance; returns anti-aliased coverage. */
export function offsetShape(/** @type {Plane} */ sdf, /** @type {number} */ px) {
  const out = new Float64Array(sdf.data.length)
  for (let p = 0; p < out.length; p++) out[p] = clamp01(0.5 + px - (sdf.data[p] ?? 0))
  return { width: sdf.width, height: sdf.height, data: out }
}

// ---------------------------------------------------------------------------------------------------------------------
// Colour and compositing

/** sRGB-encoded 0–255 → 0–1. */
export const unit = (/** @type {Rgb} */ c) => /** @type {Rgb} */ (c.map((v) => v / 255))

/** sRGB transfer: encoded → linear and back. */
export const toLinear = (/** @type {number} */ v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
export const fromLinear = (/** @type {number} */ v) =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055

/**
 * A flat layer: colour from a vertical gradient (`top` at y = 0 → `bottom` at y = height), alpha from `alpha`.
 * @param {Plane} alpha
 * @param {Rgb} top
 * @param {Rgb} bottom
 */
export function fill(alpha, top, bottom = top) {
  const { width: w, height: h } = alpha
  const out = layer(w, h)
  const t = unit(top)
  const b = unit(bottom)
  for (let y = 0; y < h; y++) {
    const f = h > 1 ? (y + 0.5) / h : 0.5
    const c = [0, 1, 2].map((i) => (t[i] ?? 0) + ((b[i] ?? 0) - (t[i] ?? 0)) * f)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const a = clamp01(alpha.data[p] ?? 0)
      out.r[p] = (c[0] ?? 0) * a
      out.g[p] = (c[1] ?? 0) * a
      out.b[p] = (c[2] ?? 0) * a
      out.a[p] = a
    }
  }
  return out
}

/**
 * Porter–Duff "over": `top` over `base` (same size).
 * With `linear`, the colour of partly covered pixels is mixed in linear light, so a thin light stroke on a dark field
 * keeps its brightness (gamma-correct anti-aliasing).
 * @param {Layer} base
 * @param {Layer} top
 * @param {{ linear?: boolean }} [opts]
 */
export function over(base, top, opts = {}) {
  const out = layer(base.width, base.height)
  for (let p = 0; p < base.width * base.height; p++) {
    const ta = top.a[p] ?? 0
    const ba = base.a[p] ?? 0
    const a = ta + ba * (1 - ta)
    out.a[p] = a
    for (const ch of /** @type {const} */ (['r', 'g', 'b'])) {
      const tc = top[ch][p] ?? 0
      const bc = base[ch][p] ?? 0
      if (!opts.linear || a === 0) {
        out[ch][p] = tc + bc * (1 - ta)
        continue
      }
      // Straight colours, mixed in linear light by the top's coverage, re-encoded and premultiplied.
      const ts = ta > 0 ? toLinear(tc / ta) : 0
      const bs = ba > 0 ? toLinear(bc / ba) : 0
      const wTop = ta / a
      out[ch][p] = fromLinear(ts * wTop + bs * (1 - wTop)) * a
    }
  }
  return out
}

/** Paste `src` into a new `size`×`size` transparent layer at integer offset (dx, dy). */
export function place(
  /** @type {Layer} */ src,
  /** @type {number} */ size,
  /** @type {number} */ dx,
  /** @type {number} */ dy,
) {
  const out = layer(size, size)
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const tx = x + dx
      const ty = y + dy
      if (tx < 0 || ty < 0 || tx >= size || ty >= size) continue
      const s = y * src.width + x
      const d = ty * size + tx
      out.r[d] = src.r[s] ?? 0
      out.g[d] = src.g[s] ?? 0
      out.b[d] = src.b[s] ?? 0
      out.a[d] = src.a[s] ?? 0
    }
  return out
}

/** The alpha of a layer as a plane. */
export const alphaOf = (/** @type {Layer} */ l) => ({ width: l.width, height: l.height, data: l.a })

/** Shift a plane by an integer offset, filling with 0. */
export function shift(/** @type {Plane} */ src, /** @type {number} */ dx, /** @type {number} */ dy) {
  const out = plane(src.width, src.height)
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const sx = x - dx
      const sy = y - dy
      if (sx >= 0 && sy >= 0 && sx < src.width && sy < src.height)
        out.data[y * src.width + x] = src.data[sy * src.width + sx] ?? 0
    }
  return out
}

/**
 * 4-connected components of the pixels at or above `threshold`, in scan order, with their area and bounding box
 * (inclusive edges).
 * @param {Plane} p
 * @returns {{ area: number, x0: number, y0: number, x1: number, y1: number }[]}
 */
export function components(p, threshold = 0.5) {
  const { width: w, height: h } = p
  const label = new Int32Array(w * h)
  const stack = new Int32Array(w * h)
  /** @type {{ area: number, x0: number, y0: number, x1: number, y1: number }[]} */
  const out = []
  for (let start = 0; start < w * h; start++) {
    if (label[start] || (p.data[start] ?? 0) < threshold) continue
    const id = out.length + 1
    const c = { area: 0, x0: w, y0: h, x1: -1, y1: -1 }
    let top = 0
    stack[top++] = start
    label[start] = id
    while (top > 0) {
      const q = stack[--top] ?? 0
      const x = q % w
      const y = (q - x) / w
      c.area++
      if (x < c.x0) c.x0 = x
      if (x > c.x1) c.x1 = x
      if (y < c.y0) c.y0 = y
      if (y > c.y1) c.y1 = y
      for (const [nx, ny] of /** @type {const} */ ([
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ])) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const n = ny * w + nx
        if (label[n] || (p.data[n] ?? 0) < threshold) continue
        label[n] = id
        stack[top++] = n
      }
    }
    out.push(c)
  }
  return out
}

/** Bounding box of the pixels above `threshold` (inclusive edges), or null when empty. */
export function bounds(/** @type {Plane} */ p, threshold = 0.5) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++)
      if ((p.data[y * p.width + x] ?? 0) > threshold) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
  return x1 < 0 ? null : { x0, y0, x1, y1 }
}
