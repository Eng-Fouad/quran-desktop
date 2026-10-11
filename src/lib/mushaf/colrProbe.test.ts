import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PageData, PageLine, PageWord } from '$lib/ipc/bindings'
import {
  firstEndGlyph,
  hasPaletteColour,
  PROBE_CANVAS_PX,
  probeColr,
  readCachedSupport,
  V4_SUPPORT_KEY,
  writeCachedSupport,
} from './colrProbe'

/** One RGBA pixel repeated `n` times. */
const pixels = (rgba: [number, number, number, number], n = 4) =>
  Uint8ClampedArray.from({ length: n * 4 }, (_, i) => rgba[i % 4] ?? 0)

describe('hasPaletteColour', () => {
  it('finds an opaque, strongly chromatic pixel (the ayah-marker teal and pink of palette 0)', () => {
    expect(hasPaletteColour(pixels([0x2c, 0xa4, 0xab, 255]))).toBe(true)
    expect(hasPaletteColour(pixels([0xff, 0x00, 0x80, 200]))).toBe(true)
  })

  it('ignores flat ink, transparent pixels and faint antialiased fringes', () => {
    expect(hasPaletteColour(pixels([0, 0, 0, 255]))).toBe(false)
    expect(hasPaletteColour(pixels([30, 30, 30, 255]))).toBe(false)
    expect(hasPaletteColour(pixels([255, 0, 128, 0]))).toBe(false)
    expect(hasPaletteColour(pixels([255, 0, 128, 128]))).toBe(false)
  })

  it('needs a chroma above 48 (max − min)', () => {
    expect(hasPaletteColour(pixels([100, 100, 52, 255]))).toBe(false)
    expect(hasPaletteColour(pixels([100, 100, 51, 255]))).toBe(true)
  })

  it('finds one coloured pixel among many black ones', () => {
    const data = pixels([0, 0, 0, 255], 64 * 64)
    data.set([10, 160, 170, 255], 1234 * 4)
    expect(hasPaletteColour(data)).toBe(true)
  })
})

function word(id: number, isEnd: boolean, glyph: string): PageWord {
  return { id, ayahId: 1, surah: 3, ayah: 1, position: id, isEnd, glyph, text: glyph }
}

function page(lines: PageWord[][]): PageData {
  const pageLines: PageLine[] = lines.map((words, i) => ({
    line: i + 1,
    kind: words.length ? 'ayah' : 'surah_name',
    centered: false,
    surah: words.length ? null : 3,
    words,
  }))
  return {
    layout: 'v4',
    style: 'qcf_v4',
    page: 50,
    lines: pageLines,
    ayahs: [],
    info: { firstAyahId: 1, lastAyahId: 1, juz: 3, hizb: 5, headSurah: 3, surahIds: [3] },
  }
}

describe('firstEndGlyph', () => {
  it("returns the style glyph of the page's first ayah-end word", () => {
    const data = page([
      [],
      [word(1, false, '\u{FC41}'), word(2, true, '\u{FC42}')],
      [word(3, true, '\u{FC50}')],
    ])
    expect(firstEndGlyph(data)).toBe('\u{FC42}')
  })

  it('is null for a page without an end marker', () => {
    expect(firstEndGlyph(page([[word(1, false, 'x')]]))).toBeNull()
  })
})

describe('the cached result (per webview version)', () => {
  afterEach(() => localStorage.clear())

  it('round-trips for the same webview version only', () => {
    expect(readCachedSupport('Edg 141.0')).toBeNull()
    writeCachedSupport('Edg 141.0', true)
    expect(readCachedSupport('Edg 141.0')).toBe(true)
    expect(readCachedSupport('Edg 142.0')).toBeNull()
    writeCachedSupport('Edg 142.0', false)
    expect(readCachedSupport('Edg 142.0')).toBe(false)
  })

  it('treats corrupt or foreign values as not probed', () => {
    localStorage.setItem(V4_SUPPORT_KEY, '{not json')
    expect(readCachedSupport('x')).toBeNull()
    localStorage.setItem(V4_SUPPORT_KEY, JSON.stringify({ webview: 'x', supported: 'yes' }))
    expect(readCachedSupport('x')).toBeNull()
  })

  it('survives a storage that throws', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readCachedSupport('x')).toBeNull()
    expect(() => writeCachedSupport('x', true)).not.toThrow()
    get.mockRestore()
    set.mockRestore()
  })
})

/** A recording 2D context whose `getImageData` returns what the test says the glyph rendered as. */
class FakeContext {
  font = ''
  textAlign = ''
  textBaseline = ''
  direction = ''
  fillStyle = ''
  drawn: { text: string; x: number; y: number }[] = []
  scales: number[] = []
  constructor(private readonly image: Uint8ClampedArray) {}
  clearRect() {}
  save() {}
  restore() {}
  translate() {}
  scale(x: number) {
    this.scales.push(x)
  }
  measureText(text: string) {
    return {
      width: 40,
      actualBoundingBoxLeft: 2,
      actualBoundingBoxRight: 38 + (text.length - 1),
      actualBoundingBoxAscent: 30,
      actualBoundingBoxDescent: 10,
    }
  }
  fillText(text: string, x: number, y: number) {
    this.drawn.push({ text, x, y })
  }
  getImageData() {
    return { data: this.image }
  }
}

describe('probeColr', () => {
  let ctx: FakeContext | null = null
  const loads: string[] = []

  beforeEach(() => {
    loads.length = 0
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load: async (font: string) => (loads.push(font), []) },
    })
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(
          readonly width: number,
          readonly height: number,
        ) {}
        getContext() {
          return ctx
        }
      },
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(document, 'fonts')
    ctx = null
  })

  it('draws the glyph at 48 px in the page family, centred on its ink box, and reports palette colour', async () => {
    ctx = new FakeContext(pixels([0x2c, 0xa4, 0xab, 255], PROBE_CANVAS_PX * PROBE_CANVAS_PX))
    await expect(probeColr('qcf-v4-p50', '\u{FC42}')).resolves.toBe(true)
    expect(loads).toEqual(['48px "qcf-v4-p50"'])
    expect(ctx.font).toBe('48px "qcf-v4-p50"')
    expect(ctx.fillStyle).toBe('#000000')
    // Ink box 2 + 38 wide, 30 + 10 tall: its centre lands on the canvas centre (the context is translated there).
    expect(ctx.drawn).toEqual([{ text: '\u{FC42}', x: 2 - 20, y: 30 - 20 }])
    expect(ctx.scales).toEqual([1])
  })

  it('reports false when the glyph rendered as flat ink (no COLR support)', async () => {
    ctx = new FakeContext(pixels([0, 0, 0, 255], PROBE_CANVAS_PX * PROBE_CANVAS_PX))
    await expect(probeColr('qcf-v4-p50', '\u{FC42}')).resolves.toBe(false)
  })

  it('rejects when no canvas context exists (support then stays unknown)', async () => {
    ctx = null
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    await expect(probeColr('qcf-v4-p50', '\u{FC42}')).rejects.toThrow(/no 2D canvas/)
  })
})
