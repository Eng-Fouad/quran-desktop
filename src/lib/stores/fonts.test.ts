import { flushSync } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Bootstrap,
  DecorStatus,
  FetchPriority,
  MushafStyle,
  PageData,
  PageFontStatus,
} from '$lib/ipc/bindings'

/** The IPC surface the store uses, faked (§5.13 `mushaf_ensure_page_fonts`, `decor_ensure`; `font_bytes`). */
const ipc = vi.hoisted(() => {
  type Reply = { status: 'ok'; data: unknown } | { status: 'error'; error: { kind: string; message: string } }
  return {
    calls: [] as { style: string; pages: number[]; priority: string }[],
    /** Per page: the availability the fake answers with (default ready). */
    availability: new Map<number, 'ready' | 'failed' | 'unavailable'>(),
    /** When set, the next ensure call rejects with this error kind. */
    errorKind: null as string | null,
    /** Pending replies (resolved by the test) when `hold` is true. */
    hold: false,
    held: [] as (() => void)[],
    decor: { installed: false, surahHeaderUrl: null, quranCommonUrl: null, suraNamesUrl: null } as Record<
      string,
      unknown
    >,
    packsChanged: null as ((e: { payload: { packIds: string[] } }) => void) | null,
    reply(data: unknown): Reply {
      return { status: 'ok', data }
    },
  }
})

vi.mock('$lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/ipc')>()
  const api = {
    mushafEnsurePageFonts: vi.fn(async (style: MushafStyle, pages: number[], priority: FetchPriority) => {
      ipc.calls.push({ style, pages: [...pages], priority })
      if (ipc.hold) await new Promise<void>((resolve) => ipc.held.push(resolve))
      if (ipc.errorKind) {
        const kind = ipc.errorKind
        ipc.errorKind = null
        return { status: 'error', error: { kind, message: 'fake failure' } }
      }
      return ipc.reply(
        pages.map((page): PageFontStatus => {
          const availability = style === 'hafs' ? 'ready' : (ipc.availability.get(page) ?? 'ready')
          const v = style.slice(4)
          const ready = availability === 'ready' && style !== 'hafs'
          return {
            style,
            page,
            availability,
            family: style === 'hafs' ? 'qd-hafs' : `qcf-${v}-p${page}`,
            url: ready ? `http://quran.localhost/mushaf/${v}/p${page}.woff2?v=0123abcd` : null,
            rel: ready ? `mushaf/${v}/p${page}.woff2` : null,
            bytes: ready ? 40_000 : 0,
          }
        }),
      )
    }),
    decorEnsure: vi.fn(async () => ipc.reply(structuredClone(ipc.decor))),
  }
  const events = {
    ...actual.events,
    packsChanged: {
      listen: vi.fn(async (handler: (e: { payload: { packIds: string[] } }) => void) => {
        ipc.packsChanged = handler
        return () => {
          ipc.packsChanged = null
        }
      }),
    },
  }
  return {
    ...actual,
    api,
    events,
    fontBytes: vi.fn(async (rel: string) => new TextEncoder().encode(rel).buffer),
  }
})

const probe = vi.hoisted(() => ({ result: true as boolean | Error, calls: [] as [string, string][] }))
vi.mock('$lib/mushaf/colrProbe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/mushaf/colrProbe')>()
  return {
    ...actual,
    probeColr: vi.fn(async (family: string, glyph: string) => {
      probe.calls.push([family, glyph])
      if (probe.result instanceof Error) throw probe.result
      return probe.result
    }),
  }
})

const { fontBytes } = await import('$lib/ipc')
const { app } = await import('./app.svelte')
const { settings } = await import('./settings.svelte')
const { ui } = await import('./ui.svelte')
const { aroundPages, DECOR_FACES, ENSURE_BATCH, fonts, pageFamily, parseFamily } =
  await import('./fonts.svelte')
const { hasFace } = await import('$lib/mushaf/fontRegistry')
const { PALETTE_STYLE_ID } = await import('$lib/mushaf/palettes')
const { V4_SUPPORT_KEY } = await import('$lib/mushaf/colrProbe')

/** FontFace stand-in (jsdom has none). */
class FakeFontFace {
  static created: FakeFontFace[] = []
  constructor(
    readonly family: string,
    readonly source: string | ArrayBuffer,
  ) {
    FakeFontFace.created.push(this)
  }
  load() {
    return Promise.resolve(this)
  }
}

const faces = new Set<unknown>()

function bootstrap(decor?: Partial<DecorStatus>): Bootstrap {
  return {
    app: { ...app.info, webviewVersion: 'Test 1.0' },
    online: true,
    settings: settings.value,
    decor: { installed: false, surahHeaderUrl: null, quranCommonUrl: null, suraNamesUrl: null, ...decor },
  } as unknown as Bootstrap
}

/** Lets pending promise chains (IPC replies, face loads) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  flushSync()
}

beforeEach(() => {
  ipc.calls = []
  ipc.availability.clear()
  ipc.errorKind = null
  ipc.hold = false
  ipc.held = []
  ipc.decor = { installed: false, surahHeaderUrl: null, quranCommonUrl: null, suraNamesUrl: null }
  probe.result = true
  probe.calls = []
  FakeFontFace.created = []
  faces.clear()
  vi.stubGlobal('FontFace', FakeFontFace)
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { add: (f: unknown) => faces.add(f), delete: (f: unknown) => faces.delete(f) },
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  localStorage.clear()
})

afterEach(() => {
  fonts.reset()
  app.info = { ...app.info, fontTransport: 'url' }
  settings.value = { ...settings.value, mushafStyle: 'hafs', networkAllowed: true }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(document, 'fonts')
})

describe('families and states', () => {
  it('names page families per style and parses them back', () => {
    expect(fonts.family('qcf_v2', 262)).toBe('qcf-v2-p262')
    expect(pageFamily('qcf_v1', 1)).toBe('qcf-v1-p1')
    expect(pageFamily('qcf_v4', 604)).toBe('qcf-v4-p604')
    expect(fonts.family('hafs', 9)).toBe('qd-hafs')
    expect(parseFamily('qcf-v4-p50')).toEqual({ style: 'qcf_v4', page: 50 })
    expect(parseFamily('qd-surah-header')).toBeNull()
    expect(parseFamily('qcf-v2-p605')).toBeNull()
  })

  it('treats hafs as always ready, without IPC', async () => {
    expect(fonts.isReady('hafs', 1)).toBe(true)
    expect(fonts.state('hafs', 1)).toBe('ready')
    await fonts.ensure('hafs', [1, 2], 'interactive')
    expect(ipc.calls).toEqual([])
  })
})

describe('ensure (§8.5)', () => {
  it('asks in batches of at most 12 pages and loads every ready face by URL', async () => {
    const pages = Array.from({ length: 20 }, (_, i) => i + 1)
    const done = fonts.ensure('qcf_v2', pages, 'interactive')
    expect(fonts.state('qcf_v2', 1)).toBe('loading')
    await done
    expect(ipc.calls.map((c) => c.pages.length)).toEqual([ENSURE_BATCH, 8])
    for (const p of pages) expect(fonts.isReady('qcf_v2', p)).toBe(true)
    expect(FakeFontFace.created[0]?.source).toBe(
      'url("http://quran.localhost/mushaf/v2/p1.woff2?v=0123abcd") format("woff2")',
    )
    expect(faces.size).toBe(20)
    await fonts.ensure(
      'qcf_v1',
      Array.from({ length: 25 }, (_, i) => i + 1),
      'prefetch',
    )
    expect(ipc.calls.slice(2).map((c) => c.pages.length)).toEqual([ENSURE_BATCH, ENSURE_BATCH, 1])
  })

  it('ignores invalid and duplicate pages, and pages already loaded', async () => {
    await fonts.ensure('qcf_v2', [0, 3, 3, 605, 2.5], 'interactive')
    expect(ipc.calls).toEqual([{ style: 'qcf_v2', pages: [3], priority: 'interactive' }])
    await fonts.ensure('qcf_v2', [3], 'interactive')
    expect(ipc.calls).toHaveLength(1)
  })

  it('maps failed and unavailable answers, and IPC errors (offline → unavailable)', async () => {
    ipc.availability.set(5, 'failed')
    ipc.availability.set(6, 'unavailable')
    await fonts.ensure('qcf_v2', [5, 6], 'interactive')
    expect(fonts.state('qcf_v2', 5)).toBe('failed')
    expect(fonts.state('qcf_v2', 6)).toBe('unavailable')
    ipc.errorKind = 'offline'
    await fonts.ensure('qcf_v2', [7], 'interactive')
    expect(fonts.state('qcf_v2', 7)).toBe('unavailable')
    ipc.errorKind = 'io'
    await fonts.ensure('qcf_v2', [8], 'interactive')
    expect(fonts.state('qcf_v2', 8)).toBe('failed')
  })

  it('shares a request in flight', async () => {
    ipc.hold = true
    const a = fonts.ensure('qcf_v2', [10, 11], 'interactive')
    const b = fonts.ensure('qcf_v2', [11], 'interactive')
    const c = fonts.ensure('qcf_v2', [10], 'prefetch')
    await Promise.resolve()
    expect(ipc.calls).toHaveLength(1)
    for (const release of ipc.held.splice(0)) release()
    await Promise.all([a, b, c])
    expect(fonts.isReady('qcf_v2', 11)).toBe(true)
  })

  it('lets an interactive request overtake a prefetch in flight', async () => {
    ipc.hold = true
    const prefetch = fonts.ensure('qcf_v2', [20], 'prefetch')
    const interactive = fonts.ensure('qcf_v2', [20], 'interactive')
    await Promise.resolve()
    expect(ipc.calls.map((c) => c.priority)).toEqual(['prefetch', 'interactive'])
    for (const release of ipc.held.splice(0)) release()
    await Promise.all([prefetch, interactive])
    expect(fonts.isReady('qcf_v2', 20)).toBe(true)
    expect(FakeFontFace.created).toHaveLength(1)
  })

  it('never lets an older failure override a newer success', async () => {
    ipc.hold = true
    const first = fonts.ensure('qcf_v2', [30], 'prefetch')
    const second = fonts.ensure('qcf_v2', [30], 'interactive')
    await Promise.resolve()
    const [releasePrefetch, releaseInteractive] = ipc.held.splice(0)
    releaseInteractive?.()
    await second
    expect(fonts.isReady('qcf_v2', 30)).toBe(true)
    ipc.availability.set(30, 'failed')
    releasePrefetch?.()
    await first
    expect(fonts.state('qcf_v2', 30)).toBe('ready')
  })

  it('skips failed and unavailable pages when prefetching, but asks again interactively and on retry', async () => {
    ipc.availability.set(40, 'failed')
    await fonts.ensure('qcf_v2', [40], 'interactive')
    await fonts.ensure('qcf_v2', [40], 'prefetch')
    expect(ipc.calls).toHaveLength(1)
    ipc.availability.delete(40)
    await fonts.retry('qcf_v2', 40)
    expect(ipc.calls).toHaveLength(2)
    expect(ipc.calls[1]?.priority).toBe('interactive')
    expect(fonts.isReady('qcf_v2', 40)).toBe(true)
  })

  it('loads faces from bytes when the transport is bytes (D30)', async () => {
    app.info = { ...app.info, fontTransport: 'bytes' }
    await fonts.ensure('qcf_v1', [2], 'interactive')
    expect(fontBytes).toHaveBeenCalledWith('mushaf/v1/p2.woff2')
    const source = FakeFontFace.created[0]?.source
    expect(typeof source).not.toBe('string')
    expect((source as ArrayBuffer).byteLength).toBe('mushaf/v1/p2.woff2'.length)
    expect(fonts.isReady('qcf_v1', 2)).toBe(true)
  })

  it('retries a face that fails by URL through font_bytes, then stays on bytes for the session (WP6a)', async () => {
    app.info = { ...app.info, fontTransport: 'url' }
    const load = vi.spyOn(FakeFontFace.prototype, 'load')
    load.mockImplementationOnce(() => Promise.reject(new Error('blocked url font')))
    await fonts.ensure('qcf_v2', [7], 'interactive')
    await settle()
    expect(FakeFontFace.created.map((f) => typeof f.source)).toEqual(['string', 'object'])
    expect(fontBytes).toHaveBeenCalledWith('mushaf/v2/p7.woff2')
    expect(fonts.isReady('qcf_v2', 7)).toBe(true)
    // The next face goes straight to bytes.
    await fonts.ensure('qcf_v2', [8], 'interactive')
    await settle()
    expect(typeof FakeFontFace.created[2]?.source).toBe('object')
    expect(fonts.isReady('qcf_v2', 8)).toBe(true)
  })

  it('drops answers that arrive after a reset', async () => {
    ipc.hold = true
    const pending = fonts.ensure('qcf_v2', [50], 'interactive')
    await Promise.resolve()
    fonts.reset()
    for (const release of ipc.held.splice(0)) release()
    await pending
    expect(fonts.state('qcf_v2', 50)).toBeNull()
    expect(faces.size).toBe(0)
  })
})

describe('prefetch and the LRU (§8.5)', () => {
  it('computes the prefetch window nearest first, clamped to 1..604', () => {
    expect(aroundPages(262, false)).toEqual([262, 261, 263, 260, 264])
    expect(aroundPages(261, true)).toEqual([261, 260, 262, 259, 263, 258, 264, 257, 265, 266])
    expect(aroundPages(1, false)).toEqual([1, 2, 3])
    expect(aroundPages(604, true)).toEqual([604, 603, 602, 601, 600])
    expect(aroundPages(100, false, 1)).toHaveLength(13)
    expect(Math.max(...aroundPages(100, false, 1))).toBe(110)
    expect(Math.min(...aroundPages(100, false, -1))).toBe(90)
  })

  it('prefetches the window in the background lane', async () => {
    fonts.prefetchAround('qcf_v2', 262, false)
    await settle()
    expect(ipc.calls).toEqual([{ style: 'qcf_v2', pages: [262, 261, 263, 260, 264], priority: 'prefetch' }])
    fonts.prefetchAround('hafs', 262, true)
    expect(ipc.calls).toHaveLength(1)
  })

  it('keeps 24 faces per style, never one within ±2 of a displayed page', async () => {
    const release = fonts.track('qcf_v2', 1)
    for (let p = 1; p <= 40; p++) await fonts.ensure('qcf_v2', [p], 'interactive')
    const loaded = Array.from({ length: 40 }, (_, i) => i + 1).filter((p) => hasFace(`qcf-v2-p${p}`))
    expect(loaded).toHaveLength(24)
    expect(loaded.slice(0, 3)).toEqual([1, 2, 3])
    expect(fonts.state('qcf_v2', 4)).toBeNull() // evicted: forgotten, asked again when needed
    release()
  })
})

describe('V4 palettes and the COLR probe (§8.6)', () => {
  function v4Page(page: number): PageData {
    return {
      layout: 'v4',
      style: 'qcf_v4',
      page,
      lines: [
        {
          line: 1,
          kind: 'ayah',
          centered: false,
          surah: null,
          words: [
            { id: 1, ayahId: 1, surah: 1, ayah: 1, position: 1, isEnd: true, glyph: '\u{FC42}', text: '' },
          ],
        },
      ],
      ayahs: [],
      info: { firstAyahId: 1, lastAyahId: 1, juz: 1, hizb: 1, headSurah: 1, surahIds: [1] },
    }
  }

  it('names every loaded V4 family in the palette rule, and forgets evicted ones', async () => {
    fonts.init(bootstrap())
    await fonts.ensure('qcf_v4', [1, 50], 'interactive')
    flushSync()
    const css = document.getElementById(PALETTE_STYLE_ID)?.textContent ?? ''
    expect(css).toContain(
      '@font-palette-values --qd-v4 { font-family: "qcf-v4-p1", "qcf-v4-p50"; base-palette:',
    )
    expect([...fonts.v4Families].sort()).toEqual(['qcf-v4-p1', 'qcf-v4-p50'])
  })

  it('runs the probe once on the first V4 page, caches it per webview version', async () => {
    fonts.init(bootstrap())
    await fonts.ensure('qcf_v4', [50], 'interactive')
    await expect(fonts.probeV4(v4Page(50))).resolves.toBe(true)
    expect(probe.calls).toEqual([['qcf-v4-p50', '\u{FC42}']])
    expect(fonts.v4Supported).toBe(true)
    expect(JSON.parse(localStorage.getItem(V4_SUPPORT_KEY) ?? 'null')).toEqual({
      webview: app.info.webviewVersion,
      supported: true,
    })
    await fonts.probeV4(v4Page(50))
    expect(probe.calls).toHaveLength(1)
  })

  it('cannot probe a page whose face is not loaded, or a non-V4 page', async () => {
    await expect(fonts.probeV4(v4Page(51))).resolves.toBeNull()
    await expect(fonts.probeV4({ ...v4Page(51), style: 'qcf_v2' })).resolves.toBeNull()
    expect(probe.calls).toEqual([])
  })

  it('leaves an unknown result when the probe cannot run', async () => {
    probe.result = new Error('no canvas')
    await fonts.ensure('qcf_v4', [50], 'interactive')
    await expect(fonts.probeV4(v4Page(50))).resolves.toBeNull()
    expect(fonts.v4Supported).toBeNull()
  })

  it('switches to QCF V2 with a toast when V4 cannot be drawn', async () => {
    const update = vi.spyOn(settings, 'update').mockResolvedValue(true)
    const toast = vi.spyOn(ui, 'toast').mockReturnValue(1)
    settings.value = { ...settings.value, mushafStyle: 'qcf_v4' }
    fonts.init(bootstrap())
    probe.result = false
    await fonts.ensure('qcf_v4', [50], 'interactive')
    await fonts.probeV4(v4Page(50))
    flushSync()
    expect(update).toHaveBeenCalledWith({ mushafStyle: 'qcf_v2' })
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'warning' }))
  })

  it('applies a cached negative result at start-up', () => {
    const update = vi.spyOn(settings, 'update').mockResolvedValue(true)
    vi.spyOn(ui, 'toast').mockReturnValue(1)
    localStorage.setItem(V4_SUPPORT_KEY, JSON.stringify({ webview: 'Test 1.0', supported: false }))
    settings.value = { ...settings.value, mushafStyle: 'qcf_v4' }
    fonts.init(bootstrap())
    flushSync()
    expect(fonts.v4Supported).toBe(false)
    expect(update).toHaveBeenCalledWith({ mushafStyle: 'qcf_v2' })
  })
})

describe('decor (§8.5)', () => {
  const installed: DecorStatus = {
    installed: true,
    surahHeaderUrl: 'http://quran.localhost/decor/qcf-surah-header.woff2?v=1',
    quranCommonUrl: 'http://quran.localhost/decor/quran-common.ttf?v=2',
    suraNamesUrl: 'http://quran.localhost/decor/sura-names.woff2?v=3',
  }

  it('loads the three decor faces when the bootstrap says installed', async () => {
    fonts.init(bootstrap(installed))
    await settle()
    expect(fonts.decorReady).toBe(true)
    for (const { family } of DECOR_FACES) expect(fonts.status.get(family)).toBe('ready')
    expect(FakeFontFace.created.map((f) => f.source)).toContain(
      'url("http://quran.localhost/decor/quran-common.ttf?v=2") format("truetype")',
    )
  })

  it('asks for decor once when a QCF style is used online, never for hafs', async () => {
    fonts.init(bootstrap())
    await settle()
    expect(ipc.decor.installed).toBe(false)
    const { api } = await import('$lib/ipc')
    expect(api.decorEnsure).not.toHaveBeenCalled()
    ipc.decor = { ...installed }
    settings.value = { ...settings.value, mushafStyle: 'qcf_v2' }
    flushSync()
    await settle()
    expect(api.decorEnsure).toHaveBeenCalledTimes(1)
    expect(fonts.decor.installed).toBe(true)
    expect(fonts.decorReady).toBe(true)
  })

  it('unloads decor when PacksChanged reports it removed', async () => {
    fonts.init(bootstrap(installed))
    await settle()
    ipc.decor = { installed: false, surahHeaderUrl: null, quranCommonUrl: null, suraNamesUrl: null }
    ipc.packsChanged?.({ payload: { packIds: ['decor'] } })
    await settle()
    expect(fonts.decor.installed).toBe(false)
    expect(fonts.decorReady).toBe(false)
    expect(hasFace('qd-surah-header')).toBe(false)
  })
})

describe('connectivity and packs', () => {
  it('re-ensures displayed pages of a mushaf pack that changed', async () => {
    fonts.init(bootstrap())
    const release = fonts.track('qcf_v2', 77)
    ipc.availability.set(77, 'unavailable')
    await fonts.ensure('qcf_v2', [77], 'interactive')
    expect(fonts.state('qcf_v2', 77)).toBe('unavailable')
    ipc.availability.delete(77)
    ipc.packsChanged?.({ payload: { packIds: ['mushaf.v2'] } })
    await settle()
    expect(fonts.isReady('qcf_v2', 77)).toBe(true)
    release()
  })

  it('retries unavailable pages when the app comes online', async () => {
    fonts.init({ ...bootstrap(), online: false })
    flushSync()
    const release = fonts.track('qcf_v2', 88)
    ipc.availability.set(88, 'unavailable')
    await fonts.ensure('qcf_v2', [88], 'interactive')
    ipc.availability.delete(88)
    app.online = false
    flushSync()
    app.online = true
    flushSync()
    await settle()
    expect(fonts.isReady('qcf_v2', 88)).toBe(true)
    release()
  })
})

describe('reset', () => {
  it('unloads every face, forgets every state and removes the palette rule', async () => {
    fonts.init(bootstrap())
    await fonts.ensure('qcf_v4', [3], 'interactive')
    flushSync()
    expect(document.getElementById(PALETTE_STYLE_ID)).not.toBeNull()
    fonts.reset()
    expect(fonts.status.size).toBe(0)
    expect(faces.size).toBe(0)
    expect(fonts.v4Families.size).toBe(0)
    expect(document.getElementById(PALETTE_STYLE_ID)).toBeNull()
  })
})
