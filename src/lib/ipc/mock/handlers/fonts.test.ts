import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DevPackIndex } from './fonts'

const fixturePages = vi.hoisted(() => new Set<string>())
vi.mock('../fixtures', () => ({
  fixtures: { hasPage: (style: string, page: number) => fixturePages.has(`${style}:${page}`) },
}))
/**
 * Page fonts fetched on demand are recorded in the packs mock (the Downloads row counts them, WP12a), and so is decor
 * installed by `decor_ensure` (Rust's `sync_decor_row`).
 */
const recordCachedItem = vi.hoisted(() => vi.fn<(packId: string, item: number) => void>())
const recordWholeInstalled = vi.hoisted(() => vi.fn<(packId: string) => void>())
vi.mock('./packs', () => ({ recordCachedItem, recordWholeInstalled }))

const { fontsHandlers, parseIndex, resetFontsMock } = await import('./fonts')
const { state } = await import('../state')

const INDEX: DevPackIndex = {
  mushaf: {
    v1: { '600': { bytes: 38_204, sha8: 'aaaaaaaa' } },
    v2: {
      '3': { bytes: 46_000, sha8: '0123abcd' },
      '4': { bytes: 47_000, sha8: '4567ef01' },
      '300': { bytes: 1, sha8: 'bbbbbbbb' },
    },
    v4: { '50': { bytes: 60_000, sha8: 'cccccccc' } },
  },
  decor: {
    'qcf-surah-header.woff2': { bytes: 118_552, sha8: '11111111' },
    'quran-common.ttf': { bytes: 125_444, sha8: '22222222' },
    'sura-names.woff2': { bytes: 88_560, sha8: '33333333' },
  },
}

let served: unknown = INDEX
const fetchMock = vi.fn(async (url: string) => {
  if (url !== '/__packs/index.json' || served === null) return new Response('not found', { status: 404 })
  return new Response(JSON.stringify(served), { headers: { 'content-type': 'application/json' } })
})

function setQuery(query: string): void {
  window.history.replaceState(null, '', `/${query}`)
}

beforeEach(() => {
  served = INDEX
  fetchMock.mockClear()
  recordCachedItem.mockClear()
  recordWholeInstalled.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  resetFontsMock()
  state.resetAll()
  fixturePages.clear()
  for (const key of ['qcf_v2:3', 'qcf_v2:4', 'qcf_v1:600', 'qcf_v4:50']) fixturePages.add(key)
  setQuery('?mockFontLatency=0')
})

afterEach(() => {
  vi.unstubAllGlobals()
  setQuery('')
})

const ensure = fontsHandlers.mushafEnsurePageFonts
const ok = <T>(r: { status: 'ok'; data: T } | { status: 'error'; error: unknown }): T => {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(r.error)}`)
  return r.data
}

describe('mushaf_ensure_page_fonts (mock)', () => {
  it('answers hafs as ready without IO (§5.4)', async () => {
    expect(ok(await ensure('hafs', [1, 2], 'interactive'))).toEqual([
      { style: 'hafs', page: 1, availability: 'ready', family: 'qd-hafs', url: null, rel: null, bytes: 0 },
      { style: 'hafs', page: 2, availability: 'ready', family: 'qd-hafs', url: null, rel: null, bytes: 0 },
    ])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('serves dev-pack fonts of fixture pages as ready, with the URL and rel shapes Rust returns', async () => {
    const [p3, p4] = ok(await ensure('qcf_v2', [3, 4], 'interactive'))
    expect(p3).toEqual({
      style: 'qcf_v2',
      page: 3,
      availability: 'ready',
      family: 'qcf-v2-p3',
      url: '/__packs/mushaf/v2/p3.woff2?v=0123abcd',
      rel: 'mushaf/v2/p3.woff2',
      bytes: 46_000,
    })
    expect(p4?.family).toBe('qcf-v2-p4')
    const [v4] = ok(await ensure('qcf_v4', [50], 'prefetch'))
    expect(v4?.url).toBe('/__packs/mushaf/v4/p50.woff2?v=cccccccc')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('answers unavailable for pages without a font, synthetic pages, or no dev packs at all', async () => {
    // p300 has a font file but its page data would be synthetic: its glyph codes would draw garbage.
    const [p300, p301] = ok(await ensure('qcf_v2', [300, 301], 'interactive'))
    expect(p300?.availability).toBe('unavailable')
    expect(p301?.availability).toBe('unavailable')
    resetFontsMock()
    served = null
    const [p3] = ok(await ensure('qcf_v2', [3], 'interactive'))
    expect(p3).toMatchObject({ availability: 'unavailable', url: null, rel: null })
  })

  it('answers unavailable offline unless the page was downloaded this session', async () => {
    ok(await ensure('qcf_v2', [3], 'interactive'))
    state.settings.update((s) => {
      s.networkAllowed = false
    })
    const [p3, p4] = ok(await ensure('qcf_v2', [3, 4], 'interactive'))
    expect(p3?.availability).toBe('ready')
    expect(p4?.availability).toBe('unavailable')
  })

  it('fails the ?mockFontFail pages once, then serves them', async () => {
    setQuery('?mockFontLatency=0&mockFontFail=3')
    const [first] = ok(await ensure('qcf_v2', [3], 'interactive'))
    expect(first?.availability).toBe('failed')
    const [retry] = ok(await ensure('qcf_v2', [3], 'interactive'))
    expect(retry?.availability).toBe('ready')
  })

  it('simulates the download time on a first visit only', async () => {
    setQuery('?mockFontLatency=60')
    const t0 = performance.now()
    ok(await ensure('qcf_v2', [3], 'interactive'))
    const first = performance.now() - t0
    const t1 = performance.now()
    ok(await ensure('qcf_v2', [3], 'interactive'))
    const second = performance.now() - t1
    expect(first).toBeGreaterThanOrEqual(55)
    expect(second).toBeLessThan(first)
    // Recorded once, as an unpinned item of its pack, when it was downloaded.
    expect(
      recordCachedItem.mock.calls.filter(([pack, page]) => pack === 'mushaf.v2' && page === 3),
    ).toHaveLength(1)
  })

  it('validates its arguments like the command (§5.13)', async () => {
    expect(await ensure('qcf_v2', [], 'interactive')).toMatchObject({
      status: 'error',
      error: { kind: 'invalid_argument' },
    })
    const thirteen = Array.from({ length: 13 }, (_, i) => i + 1)
    expect(await ensure('qcf_v2', thirteen, 'interactive')).toMatchObject({
      status: 'error',
      error: { kind: 'invalid_argument' },
    })
    expect(await ensure('qcf_v2', [605], 'interactive')).toMatchObject({
      status: 'error',
      error: { kind: 'invalid_argument' },
    })
    expect(await ensure('qcf_v3' as never, [1], 'interactive')).toMatchObject({
      status: 'error',
      error: { kind: 'invalid_argument' },
    })
    expect(await ensure('qcf_v2', [1], 'soon' as never)).toMatchObject({
      status: 'error',
      error: { kind: 'invalid_argument' },
    })
  })
})

describe('decor_ensure (mock)', () => {
  it('installs the decor fonts when online and persists the status for the next bootstrap', async () => {
    const decor = ok(await fontsHandlers.decorEnsure())
    expect(decor).toEqual({
      installed: true,
      surahHeaderUrl: '/__packs/decor/qcf-surah-header.woff2?v=11111111',
      quranCommonUrl: '/__packs/decor/quran-common.ttf?v=22222222',
      suraNamesUrl: '/__packs/decor/sura-names.woff2?v=33333333',
    })
    expect(state.fonts.value.decor).toEqual(decor)
    // The packs mock lists the decor pack installed (Downloads, the onboarding's starter set).
    expect(recordWholeInstalled.mock.calls).toEqual([['decor']])
  })

  it('does not install offline, but keeps an installed decor', async () => {
    state.settings.update((s) => {
      s.networkAllowed = false
    })
    expect(ok(await fontsHandlers.decorEnsure()).installed).toBe(false)
    expect(recordWholeInstalled).not.toHaveBeenCalled()
    state.settings.update((s) => {
      s.networkAllowed = true
    })
    ok(await fontsHandlers.decorEnsure())
    state.settings.update((s) => {
      s.networkAllowed = false
    })
    expect(ok(await fontsHandlers.decorEnsure()).installed).toBe(true)
  })

  it('reports nothing installed when the decor files are missing', async () => {
    state.fonts.set({
      decor: { installed: true, surahHeaderUrl: 'x', quranCommonUrl: 'y', suraNamesUrl: 'z' },
    })
    served = { ...INDEX, decor: {} }
    expect(ok(await fontsHandlers.decorEnsure()).installed).toBe(false)
    expect(state.fonts.value.decor.installed).toBe(false)
  })
})

describe('parseIndex', () => {
  it('keeps well-formed entries and drops everything else', () => {
    expect(
      parseIndex({
        mushaf: {
          v2: {
            '3': { bytes: 1, sha8: 'abcdef01' },
            '4': { bytes: '1', sha8: 'abcdef01' },
            '5': { bytes: 1, sha8: 'nothex!!' },
          },
        },
        decor: null,
      }),
    ).toEqual({ mushaf: { v1: {}, v2: { '3': { bytes: 1, sha8: 'abcdef01' } }, v4: {} }, decor: {} })
    expect(parseIndex('nope')).toEqual({ mushaf: { v1: {}, v2: {}, v4: {} }, decor: {} })
  })
})
