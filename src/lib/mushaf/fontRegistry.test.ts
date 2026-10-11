import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearFaces,
  cssUrl,
  deleteFace,
  evictFaces,
  FACES_PER_STYLE,
  faceGroup,
  fontFormat,
  hasFace,
  loadedFamilies,
  loadFace,
  onFaceSetChange,
  touchFace,
} from './fontRegistry'

/** A FontFace stand-in (jsdom has none): `load()` resolves, or rejects when its source says "broken". */
class FakeFontFace {
  static created: FakeFontFace[] = []
  status = 'unloaded'
  constructor(
    readonly family: string,
    readonly source: string | ArrayBuffer,
    readonly descriptors: FontFaceDescriptors,
  ) {
    FakeFontFace.created.push(this)
  }
  load(): Promise<FakeFontFace> {
    if (typeof this.source === 'string' && this.source.includes('broken')) {
      this.status = 'error'
      return Promise.reject(new DOMException('decode failed', 'SyntaxError'))
    }
    this.status = 'loaded'
    return Promise.resolve(this)
  }
}

const set = new Set<FakeFontFace>()

beforeEach(() => {
  FakeFontFace.created = []
  set.clear()
  vi.stubGlobal('FontFace', FakeFontFace)
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
      add: (f: FakeFontFace) => set.add(f),
      delete: (f: FakeFontFace) => set.delete(f),
    },
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  clearFaces()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(document, 'fonts')
})

describe('helpers', () => {
  it('groups page families by style; decor has no group', () => {
    expect(faceGroup('qcf-v2-p262')).toBe('qcf-v2')
    expect(faceGroup('qcf-v4-p1')).toBe('qcf-v4')
    expect(faceGroup('qd-surah-header')).toBeNull()
    expect(faceGroup('qcf-v3-p1')).toBeNull()
  })

  it('escapes CSS url() strings', () => {
    expect(cssUrl('http://quran.localhost/mushaf/v2/p1.woff2?v=1a2b3c4d')).toBe(
      'url("http://quran.localhost/mushaf/v2/p1.woff2?v=1a2b3c4d")',
    )
    expect(cssUrl('a"b\\c')).toBe('url("a\\22 b\\5c c")')
  })

  it('derives the format() hint from the extension', () => {
    expect(fontFormat('http://quran.localhost/decor/quran-common.ttf?v=1')).toBe('truetype')
    expect(fontFormat('/__packs/mushaf/v4/p50.woff2?v=deadbeef')).toBe('woff2')
    expect(fontFormat('x.woff#frag')).toBe('woff')
    expect(fontFormat('x.otf')).toBe('opentype')
  })
})

describe('loadFace', () => {
  it('loads by URL with display: block and a format hint, and adds the face to document.fonts', async () => {
    const face = await loadFace('qcf-v2-p3', { url: 'http://quran.localhost/mushaf/v2/p3.woff2?v=1' })
    expect(face).not.toBeNull()
    const [created] = FakeFontFace.created
    expect(created?.source).toBe('url("http://quran.localhost/mushaf/v2/p3.woff2?v=1") format("woff2")')
    expect(created?.descriptors).toEqual({ display: 'block' })
    expect(set.has(created as FakeFontFace)).toBe(true)
    expect(hasFace('qcf-v2-p3')).toBe(true)
  })

  it('loads from raw bytes (fontTransport = bytes)', async () => {
    const bytes = new ArrayBuffer(8)
    await loadFace('qcf-v2-p4', { bytes })
    expect(FakeFontFace.created[0]?.source).toBe(bytes)
  })

  it('shares one load between concurrent callers and returns the loaded face afterwards', async () => {
    const [a, b] = await Promise.all([
      loadFace('qcf-v2-p5', { url: '/p5.woff2' }),
      loadFace('qcf-v2-p5', { url: '/p5.woff2' }),
    ])
    expect(a).toBe(b)
    expect(await loadFace('qcf-v2-p5', { url: '/other.woff2' })).toBe(a)
    expect(FakeFontFace.created).toHaveLength(1)
  })

  it('resolves null on a failed load, removes the face again and starts afresh next time', async () => {
    expect(await loadFace('qcf-v2-p6', { url: '/broken.woff2' })).toBeNull()
    expect(set.size).toBe(0)
    expect(hasFace('qcf-v2-p6')).toBe(false)
    expect(await loadFace('qcf-v2-p6', { url: '/fixed.woff2' })).not.toBeNull()
    expect(FakeFontFace.created).toHaveLength(2)
  })

  it('drops a face whose family was deleted while it loaded, out of document.fonts at once', async () => {
    const pending = loadFace('qcf-v2-p7', { url: '/p7.woff2' })
    expect(set.size).toBe(1)
    deleteFace('qcf-v2-p7')
    expect(set.size).toBe(0)
    expect(await pending).toBeNull()
    expect(hasFace('qcf-v2-p7')).toBe(false)
    expect(set.size).toBe(0)
  })
})

describe('evictFaces (LRU, §8.5)', () => {
  async function loadPages(style: string, pages: number[]) {
    for (const p of pages) await loadFace(`qcf-${style}-p${p}`, { url: `/${style}/p${p}.woff2` })
  }

  it('keeps at most 24 faces per style, least recently used first, never one in `keep`', async () => {
    const pages = Array.from({ length: FACES_PER_STYLE + 3 }, (_, i) => i + 1)
    await loadPages('v2', pages)
    touchFace('qcf-v2-p1') // displayed again: now the most recent
    const evicted = evictFaces(new Set(['qcf-v2-p2']))
    expect(evicted).toEqual(['qcf-v2-p3', 'qcf-v2-p4', 'qcf-v2-p5'])
    expect(loadedFamilies('qcf-v2')).toHaveLength(FACES_PER_STYLE)
    expect(hasFace('qcf-v2-p1')).toBe(true)
    expect(hasFace('qcf-v2-p2')).toBe(true)
    expect(set.size).toBe(FACES_PER_STYLE)
  })

  it('counts each style separately and never evicts decor', async () => {
    await loadPages('v2', [1, 2, 3])
    await loadPages('v4', [1, 2, 3])
    await loadFace('qd-surah-header', { url: '/decor/qcf-surah-header.woff2' })
    expect(evictFaces(new Set(), 2)).toEqual(['qcf-v2-p1', 'qcf-v4-p1'])
    expect(evictFaces(new Set(), 0)).toHaveLength(4)
    expect(hasFace('qd-surah-header')).toBe(true)
  })

  it('takes a budget per group: 0 unloads every face of that group that is not kept', async () => {
    await loadPages('v2', [1, 2, 3])
    await loadPages('v4', [41, 42, 43])
    const budget = (group: string) => (group === 'qcf-v4' ? 0 : FACES_PER_STYLE)
    expect(evictFaces(new Set(['qcf-v4-p42']), budget)).toEqual(['qcf-v4-p41', 'qcf-v4-p43'])
    expect(loadedFamilies('qcf-v4')).toEqual(['qcf-v4-p42'])
    expect(loadedFamilies('qcf-v2')).toHaveLength(3)
    expect([...set].map((f) => f.family).filter((f) => f.startsWith('qcf-v4-'))).toEqual(['qcf-v4-p42'])
    // Once the last kept face is no longer kept, the group empties.
    expect(evictFaces(new Set(), budget)).toEqual(['qcf-v4-p42'])
    expect(loadedFamilies('qcf-v4')).toEqual([])
  })

  it('lists loaded families by group, least recently used first', async () => {
    await loadPages('v1', [10, 11])
    touchFace('qcf-v1-p10')
    expect(loadedFamilies('qcf-v1')).toEqual(['qcf-v1-p11', 'qcf-v1-p10'])
  })
})

describe('face-set changes (the shaping warm-up warms again after them)', () => {
  it('reports a face joining, finishing its load, failing and leaving document.fonts', async () => {
    const changes: number[] = []
    const stop = onFaceSetChange(() => changes.push(set.size))
    await loadFace('qcf-v2-p1', { url: 'quran://p1.woff2' })
    // Added (before its load), then loaded.
    expect(changes).toEqual([1, 1])
    // Already loaded: no change.
    await loadFace('qcf-v2-p1', { url: 'quran://p1.woff2' })
    expect(changes).toHaveLength(2)
    // A broken face is added, then removed again.
    await loadFace('qcf-v2-p2', { url: 'quran://broken.woff2' })
    expect(changes).toEqual([1, 1, 2, 1])
    deleteFace('qcf-v2-p1')
    expect(changes.at(-1)).toBe(0)
    expect(deleteFace('qcf-v2-p1')).toBe(false)
    expect(changes).toHaveLength(5)
    stop()
    await loadFace('qcf-v2-p3', { url: 'quran://p3.woff2' })
    expect(changes).toHaveLength(5)
  })
})
