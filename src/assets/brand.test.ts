/**
 * Brand assets (ARCHITECTURE §9.9, amended by LEAD.md item 16: the github.com/quran identity). Owner: WP-Brand.
 *
 * Checks the committed outputs of assets/brand/tools/build.mjs independently of that script (own PNG/ICO/ICNS
 * readers): the recorded source and its provenance, exact pixel sizes of every output, the OS icon containers and their
 * entries, the Apple grid vs full-bleed framing, black-only template images, the SVG wrappers and the PNGs they embed,
 * and that the Tauri default icon is gone. The first identity's "geometry only / no <image>" rule is superseded.
 * Regenerating everything and comparing pixel by pixel is `node assets/brand/tools/build.mjs --check`.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const read = (path: string) => readFileSync(resolve(ROOT, path))
const text = (path: string) => read(path).toString('utf8')
const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')

/** sha256 of the scaffold's (Tauri default) src-tauri/icons/icon.png, which must never ship (§9.9). */
const TAURI_DEFAULT_ICON_SHA256 = '6413bfe9d546e5225fc9256a0ecec48df3a1272ea4bdc91c15b8e000222a95d3'
/** quran_android `app/src/main/res/drawable-nodpi/ic_upcoming_app_icon.webp` at commit 19f5bde9 (LEAD.md item 16). */
const SOURCE = 'assets/brand/source/ic_upcoming_app_icon.webp'
const SOURCE_SHA256 = 'fbdeeb52553482f118c29d1e7f84a161b90e507ea9dbc1dcc840f51f1c951c6d'
const SOURCE_COMMIT = '19f5bde93e77b6b94042660cb7bb611d0537fff5'

// ---------------------------------------------------------------------------------------------------------------------
// Minimal readers (8-bit, non-interlaced PNG; ICO; ICNS)

interface Rgba {
  width: number
  height: number
  data: Uint8Array
}

function pngSize(buf: Buffer): [number, number] {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)]
}

function decodePng(buf: Buffer): Rgba {
  const [width, height] = pngSize(buf)
  const bitDepth = buf.readUInt8(24)
  const colorType = buf.readUInt8(25)
  const interlace = buf.readUInt8(28)
  if (bitDepth !== 8 || interlace !== 0 || ![2, 6].includes(colorType))
    throw new Error(`unsupported PNG: depth ${bitDepth}, colour type ${colorType}, interlace ${interlace}`)
  const idat: Buffer[] = []
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o)
    const type = buf.toString('latin1', o + 4, o + 8)
    if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len))
    o += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  const px = new Uint8Array(stride * height)
  const at = (a: Uint8Array, i: number) => (i >= 0 ? (a[i] ?? 0) : 0)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x
      const v = raw[y * (stride + 1) + 1 + x] ?? 0
      const left = x >= bpp ? at(px, i - bpp) : 0
      const up = y > 0 ? at(px, i - stride) : 0
      const ul = x >= bpp && y > 0 ? at(px, i - stride - bpp) : 0
      let pred = 0
      if (filter === 1) pred = left
      else if (filter === 2) pred = up
      else if (filter === 3) pred = (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - ul
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - ul)
        pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : ul
      }
      px[i] = (v + pred) & 0xff
    }
  }
  if (bpp === 4) return { width, height, data: px }
  const data = new Uint8Array(width * height * 4)
  for (let p = 0; p < width * height; p++) {
    data.set(px.subarray(p * 3, p * 3 + 3), p * 4)
    data[p * 4 + 3] = 255
  }
  return { width, height, data }
}

const pixel = (img: Rgba, x: number, y: number) => {
  const i = (y * img.width + x) * 4
  return { r: img.data[i] ?? 0, g: img.data[i + 1] ?? 0, b: img.data[i + 2] ?? 0, a: img.data[i + 3] ?? 0 }
}

/** Share of pixels that are gold (red well above blue) among the opaque ones. */
function goldShare(img: Rgba) {
  let gold = 0
  let opaque = 0
  for (let p = 0; p < img.width * img.height; p++) {
    const { r, b, a } = pixel(img, p % img.width, Math.floor(p / img.width))
    if (a < 200) continue
    opaque++
    if (r > b + 60) gold++
  }
  return gold / opaque
}

interface IcoEntry {
  size: number
  format: 'png' | 'bmp'
  image: Rgba
  /** AND-mask bit per pixel (BMP entries only). */
  transparent?: boolean[]
}

function readIco(buf: Buffer): IcoEntry[] {
  expect(buf.readUInt16LE(0)).toBe(0)
  expect(buf.readUInt16LE(2)).toBe(1)
  const entries: IcoEntry[] = []
  for (let i = 0; i < buf.readUInt16LE(4); i++) {
    const e = 6 + 16 * i
    const size = buf.readUInt8(e) || 256
    expect(buf.readUInt8(e + 1) || 256).toBe(size)
    expect(buf.readUInt16LE(e + 6)).toBe(32)
    const len = buf.readUInt32LE(e + 8)
    const off = buf.readUInt32LE(e + 12)
    expect(off + len).toBeLessThanOrEqual(buf.length)
    const data = buf.subarray(off, off + len)
    if (data.readUInt32BE(0) === 0x89504e47) {
      entries.push({ size, format: 'png', image: decodePng(data) })
      continue
    }
    expect(data.readUInt32LE(0)).toBe(40)
    expect(data.readInt32LE(4)).toBe(size)
    expect(data.readInt32LE(8)).toBe(size * 2)
    expect(data.readUInt16LE(14)).toBe(32)
    const maskStride = Math.ceil(size / 32) * 4
    expect(data.length).toBe(40 + size * size * 4 + maskStride * size)
    const img = new Uint8Array(size * size * 4)
    const transparent: boolean[] = []
    for (let y = 0; y < size; y++) {
      const row = size - 1 - y
      for (let x = 0; x < size; x++) {
        const s = 40 + (row * size + x) * 4
        img.set([data[s + 2] ?? 0, data[s + 1] ?? 0, data[s] ?? 0, data[s + 3] ?? 0], (y * size + x) * 4)
        const m = data[40 + size * size * 4 + row * maskStride + (x >> 3)] ?? 0
        transparent.push((m & (0x80 >> (x & 7))) !== 0)
      }
    }
    entries.push({ size, format: 'bmp', image: { width: size, height: size, data: img }, transparent })
  }
  return entries
}

function readIcns(buf: Buffer): Map<string, Buffer> {
  expect(buf.toString('latin1', 0, 4)).toBe('icns')
  expect(buf.readUInt32BE(4)).toBe(buf.length)
  const out = new Map<string, Buffer>()
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o + 4)
    expect(len).toBeGreaterThan(8)
    out.set(buf.toString('latin1', o, o + 4), buf.subarray(o + 8, o + len))
    o += len
  }
  return out
}

const parseSvg = (source: string) => new DOMParser().parseFromString(source, 'image/svg+xml')

/** The PNGs an SVG embeds as data: URIs, decoded. */
function embeddedPngs(source: string): Buffer[] {
  return [...source.matchAll(/href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/g)].map((m) =>
    Buffer.from(m[1] ?? '', 'base64'),
  )
}

// ---------------------------------------------------------------------------------------------------------------------

describe('source artwork (assets/brand/source)', () => {
  it('is the unmodified quran_android icon (1024 px lossless WebP)', () => {
    const webp = read(SOURCE)
    expect(sha256(webp)).toBe(SOURCE_SHA256)
    expect(webp.toString('latin1', 0, 4)).toBe('RIFF')
    expect(webp.toString('latin1', 8, 16)).toBe('WEBPVP8L')
    // VP8L header: 14-bit width − 1 and height − 1 after the 0x2f signature.
    expect(webp.readUInt8(20)).toBe(0x2f)
    const bits = webp.readUInt32LE(21)
    expect([(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1]).toEqual([1024, 1024])
  })

  it('SOURCE.md records the origin, commit, licence and credit', () => {
    expect(existsSync(resolve(ROOT, 'assets/brand/source/SOURCE.md'))).toBe(true)
    const md = text('assets/brand/source/SOURCE.md')
    expect(md).toContain('https://github.com/quran/quran_android')
    expect(md).toContain('app/src/main/res/drawable-nodpi/ic_upcoming_app_icon.webp')
    expect(md).toContain(SOURCE_COMMIT)
    expect(md).toContain(SOURCE_SHA256)
    expect(md).toContain('GPL-3.0')
    expect(md).toContain('Quran.com / quran_android contributors')
  })

  it('the brand guide credits the source and notes the release approval', () => {
    const md = text('assets/brand/README.md')
    expect(md).toContain('Quran.com / quran_android contributors')
    expect(md).toContain('GPL-3.0')
    expect(md).toMatch(/approval\s+of the quran organisation's maintainers/)
  })
})

describe('master and the Tauri icon set (`pnpm tauri icon assets/brand/icon.png`)', () => {
  it('the master PNG is 1024 px: a navy tile with transparent corners and the gold glyph', () => {
    const img = decodePng(read('assets/brand/icon.png'))
    expect([img.width, img.height]).toEqual([1024, 1024])
    expect(pixel(img, 0, 0).a).toBe(0)
    expect(pixel(img, 1023, 1023).a).toBe(0)
    expect(pixel(img, 512, 1).a).toBe(255) // full-bleed mid-edge
    const navy = pixel(img, 80, 512)
    expect(navy.b).toBeGreaterThan(navy.r + 50)
    const gold = pixel(img, 300, 300) // the nun's dot
    expect(gold.r).toBeGreaterThan(gold.b + 60)
  })

  it('the shipped icon is not the Tauri default', () => {
    expect(sha256(read('src-tauri/icons/icon.png'))).not.toBe(TAURI_DEFAULT_ICON_SHA256)
  })

  it.each([
    ['32x32.png', 32],
    ['64x64.png', 64],
    ['128x128.png', 128],
    ['128x128@2x.png', 256],
    ['icon.png', 512],
    ['Square30x30Logo.png', 30],
    ['Square44x44Logo.png', 44],
    ['Square150x150Logo.png', 150],
    ['Square310x310Logo.png', 310],
    ['StoreLogo.png', 50],
  ])('%s is %i px', (file, size) => {
    expect(pngSize(read(`src-tauri/icons/${file}`))).toEqual([size, size])
  })

  it.each([
    'src-tauri/tauri.conf.json',
    'src-tauri/tauri.windows.conf.json',
    'src-tauri/tauri.macos.conf.json',
    'src-tauri/tauri.linux.conf.json',
  ])('the files named in %s bundle.icon exist', (file) => {
    const conf = JSON.parse(text(file)) as { bundle?: { icon?: string[] } }
    for (const icon of conf.bundle?.icon ?? [])
      expect(existsSync(resolve(ROOT, 'src-tauri', icon)), icon).toBe(true)
  })
})

describe('Windows icon (src-tauri/icons/windows/icon.ico)', () => {
  const entries = readIco(read('src-tauri/icons/windows/icon.ico'))

  it('holds 16/20/24/32/40/48/64 px (BMP) and 256 px (PNG), each at its exact size', () => {
    expect(entries.map((e) => e.size)).toEqual([16, 20, 24, 32, 40, 48, 64, 256])
    expect(entries.map((e) => e.format)).toEqual(['bmp', 'bmp', 'bmp', 'bmp', 'bmp', 'bmp', 'bmp', 'png'])
    for (const e of entries) expect([e.image.width, e.image.height]).toEqual([e.size, e.size])
  })

  it('BMP entries carry an AND mask that matches their alpha', () => {
    for (const e of entries.filter((x) => x.format === 'bmp')) {
      e.transparent?.forEach((t, p) =>
        expect(t, `${e.size}px pixel ${p}`).toBe((e.image.data[p * 4 + 3] ?? 0) === 0),
      )
    }
  })

  it('is full-bleed: the tile reaches the edge, the corners are rounded off', () => {
    for (const e of entries) {
      const mid = Math.floor(e.size / 2)
      expect(pixel(e.image, mid, 0).a, `${e.size}px top edge`).toBeGreaterThan(200)
      expect(pixel(e.image, 0, 0).a, `${e.size}px corner`).toBeLessThan(80)
    }
  })

  it('the tuned sizes show more gold than the master would (tighter crop, bolder strokes)', () => {
    const big = entries.find((e) => e.size === 256)?.image
    if (!big) throw new Error('no 256 px entry')
    const master = goldShare(big)
    for (const e of entries.filter((x) => x.size <= 64)) {
      expect(goldShare(e.image), `${e.size}px`).toBeGreaterThan(master * 1.3)
      expect(goldShare(e.image), `${e.size}px`).toBeLessThan(0.6) // still a glyph on a tile, not a gold blob
    }
  })
})

describe('macOS icon (src-tauri/icons/macos/icon.icns)', () => {
  const entries = readIcns(read('src-tauri/icons/macos/icon.icns'))

  it('has the legacy 16/32 px pairs and every PNG size', () => {
    expect([...entries.keys()]).toEqual([
      'is32',
      's8mk',
      'il32',
      'l8mk',
      'ic11',
      'ic12',
      'ic07',
      'ic13',
      'ic08',
      'ic14',
      'ic09',
      'ic10',
    ])
    expect(entries.get('s8mk')?.length).toBe(16 * 16)
    expect(entries.get('l8mk')?.length).toBe(32 * 32)
    const sizes: Record<string, number> = {
      ic11: 32,
      ic12: 64,
      ic07: 128,
      ic13: 256,
      ic08: 256,
      ic14: 512,
      ic09: 512,
      ic10: 1024,
    }
    for (const [type, size] of Object.entries(sizes)) {
      const data = entries.get(type)
      if (!data) throw new Error(`no ${type}`)
      expect(pngSize(data), type).toEqual([size, size])
    }
  })

  it('sits on the Apple grid: an 824 px body with a 100 px margin and a drop shadow below', () => {
    const data = entries.get('ic10')
    if (!data) throw new Error('no ic10')
    const img = decodePng(data)
    expect(pixel(img, 512, 104).a).toBe(255) // body top edge
    expect(pixel(img, 104, 512).a).toBe(255)
    expect(pixel(img, 512, 60).a).toBeLessThan(40) // margin above: clear
    expect(pixel(img, 40, 512).a).toBeLessThan(40)
    expect(pixel(img, 512, 940).a).toBeGreaterThan(pixel(img, 512, 84).a) // shadow falls below the body
  })

  it('the tuned 32 and 64 px keep a margin around the body', () => {
    for (const [type, size, inset] of [
      ['ic11', 32, 3],
      ['ic12', 64, 6],
    ] as const) {
      const data = entries.get(type)
      if (!data) throw new Error(`no ${type}`)
      const img = decodePng(data)
      expect(pixel(img, size / 2, 0).a, type).toBeLessThan(40)
      expect(pixel(img, size / 2, inset).a, type).toBeGreaterThan(200)
    }
  })
})

describe('tray icons (src-tauri/icons/tray)', () => {
  it.each([
    ['tray-template.png', 18],
    ['tray-template@2x.png', 36],
  ])('%s is a %i px template image: black + alpha only', (file, size) => {
    const img = decodePng(read(`src-tauri/icons/tray/${file}`))
    expect([img.width, img.height]).toEqual([size, size])
    let opaque = 0
    for (let p = 0; p < size * size; p++) {
      const { r, g, b, a } = pixel(img, p % size, Math.floor(p / size))
      if (a > 0) expect([r, g, b]).toEqual([0, 0, 0])
      if (a === 255) opaque++
    }
    expect(opaque).toBeGreaterThan(size * 2)
  })

  it('colour tray icons are the tuned Windows icons for each DPI step; tray.png is the 32 px one', () => {
    const ico = readIco(read('src-tauri/icons/windows/icon.ico'))
    for (const size of [16, 20, 24, 32]) {
      const tray = decodePng(read(`src-tauri/icons/tray/tray-${size}.png`))
      expect([tray.width, tray.height]).toEqual([size, size])
      expect(Array.from(tray.data)).toEqual(Array.from(ico.find((e) => e.size === size)?.image.data ?? []))
    }
    expect(read('src-tauri/icons/tray/tray.png').equals(read('src-tauri/icons/tray/tray-32.png'))).toBe(true)
  })
})

describe('media artwork (src-tauri/icons/media/artwork.png)', () => {
  it('is an opaque 512 px navy square with the gold glyph (media flyouts crop or round it themselves)', () => {
    const img = decodePng(read('src-tauri/icons/media/artwork.png'))
    expect([img.width, img.height]).toEqual([512, 512])
    for (let p = 0; p < 512 * 512; p++) expect(img.data[p * 4 + 3]).toBe(255)
    for (const [x, y] of [
      [0, 0],
      [511, 0],
      [0, 511],
      [511, 511],
      [256, 4],
    ] as const) {
      const c = pixel(img, x, y)
      expect(c.b, `${x},${y}`).toBeGreaterThan(c.r + 30) // navy, no rim highlight or corner
    }
    expect(goldShare(img)).toBeGreaterThan(0.08)
  })
})

describe('UI assets (src/assets): SVG wrappers around the brand rasters', () => {
  it.each([
    ['src/assets/app-icon.svg', 256],
    ['src/assets/app-icon-small.svg', 32],
  ])('%s shows one embedded %i px PNG at its exact size', (path, size) => {
    const source = text(path)
    const doc = parseSvg(source)
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)
    const svg = doc.documentElement
    expect(svg.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg')
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${size} ${size}`)
    expect([svg.getAttribute('width'), svg.getAttribute('height')]).toEqual([String(size), String(size)])
    const images = doc.getElementsByTagName('image')
    expect(images).toHaveLength(1)
    expect([images[0]?.getAttribute('width'), images[0]?.getAttribute('height')]).toEqual([
      String(size),
      String(size),
    ])
    const pngs = embeddedPngs(source)
    expect(pngs).toHaveLength(1)
    const img = decodePng(pngs[0] ?? Buffer.alloc(0))
    expect([img.width, img.height]).toEqual([size, size])
    expect(pixel(img, 0, 0).a).toBeLessThan(80) // the tile's rounded corner
    expect(pixel(img, size / 2, size / 2).a).toBe(255)
  })

  it('app-icon.svg embeds the ICO 256 px entry and app-icon-small.svg the tuned 32 px tray icon', () => {
    const ico = readIco(read('src-tauri/icons/windows/icon.ico'))
    const big = decodePng(embeddedPngs(text('src/assets/app-icon.svg'))[0] ?? Buffer.alloc(0))
    expect(Array.from(big.data)).toEqual(Array.from(ico.find((e) => e.size === 256)?.image.data ?? []))
    const small = decodePng(embeddedPngs(text('src/assets/app-icon-small.svg'))[0] ?? Buffer.alloc(0))
    expect(Array.from(small.data)).toEqual(
      Array.from(decodePng(read('src-tauri/icons/tray/tray-32.png')).data),
    )
  })

  it('app-mark.svg is single-colour: currentColor masked by an embedded 128 px silhouette', () => {
    const source = text('src/assets/app-mark.svg')
    const doc = parseSvg(source)
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)
    expect(doc.documentElement.getAttribute('viewBox')).toBe('0 0 128 128')
    const rect = doc.getElementsByTagName('rect')[0]
    expect(rect?.getAttribute('fill')).toBe('currentColor')
    const maskId = /^url\(#([\w-]+)\)$/.exec(rect?.getAttribute('mask') ?? '')?.[1] ?? ''
    const mask = doc.getElementById(maskId)
    expect(mask?.nodeName).toBe('mask')
    expect(mask?.getElementsByTagName('image')).toHaveLength(1)
    expect(source).not.toMatch(/#[0-9a-f]{6}\b/i)
    const pngs = embeddedPngs(source)
    expect(pngs).toHaveLength(1)
    const img = decodePng(pngs[0] ?? Buffer.alloc(0))
    expect([img.width, img.height]).toEqual([128, 128])
    // White + alpha, so the default luminance mask equals the alpha.
    let ink = 0
    for (let p = 0; p < 128 * 128; p++) {
      const { r, g, b, a } = pixel(img, p % 128, Math.floor(p / 128))
      if (a > 0) expect([r, g, b]).toEqual([255, 255, 255])
      if (a === 255) ink++
    }
    expect(ink).toBeGreaterThan(128 * 128 * 0.15)
  })

  it.each(['src/assets/app-icon.svg', 'src/assets/app-icon-small.svg', 'src/assets/app-mark.svg'])(
    '%s has no scripts, foreign objects or external references',
    (path) => {
      const source = text(path)
      const doc = parseSvg(source)
      for (const tag of ['script', 'foreignObject', 'style'])
        expect(doc.getElementsByTagName(tag), tag).toHaveLength(0)
      for (const el of Array.from(doc.getElementsByTagName('*'))) {
        const href = el.getAttribute('href') ?? el.getAttribute('xlink:href')
        if (href !== null) expect(href.startsWith('data:image/png;base64,'), el.nodeName).toBe(true)
      }
      expect(source).not.toMatch(/url\((?!#)|@import/)
    },
  )

  it('star8.svg stays the geometric 48 px EmptyState decoration in the brand gold, usable as a CSS mask', () => {
    expect(text('src/assets/star8.svg')).toBe(text('assets/brand/svg/star8.svg'))
    const doc = parseSvg(text('src/assets/star8.svg'))
    expect(doc.documentElement.getAttribute('viewBox')).toBe('0 0 48 48')
    expect(doc.getElementsByTagName('title')).toHaveLength(0) // decorative: no accessible name
    expect(doc.getElementsByTagName('image')).toHaveLength(0)
    const paints = new Set(
      Array.from(doc.querySelectorAll('[fill],[stroke]')).flatMap((el) =>
        ['fill', 'stroke'].map((a) => el.getAttribute(a)).filter((v) => v && v !== 'none'),
      ),
    )
    expect([...paints]).toEqual(['#b08d57'])
  })
})
