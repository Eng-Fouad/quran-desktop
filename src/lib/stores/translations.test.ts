import { flushSync } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '$lib/contracts/settings'
import { api, call, events, initIpc, IpcError } from '$lib/ipc'
import type { Bootstrap, Settings } from '$lib/ipc/bindings'
import { mockCommands, state } from '$lib/ipc/mock'
import { contentMock } from '$lib/ipc/mock/handlers/content'
import { err } from '$lib/ipc/mock/result'
import { app } from './app.svelte'
import { packs } from './packs.svelte'
import { quran } from './quran.svelte'
import { settings } from './settings.svelte'
import {
  BLOCK,
  blockOf,
  blockRange,
  dirOfLanguage,
  languageOfPackId,
  MAX_PACKS,
  RETRY_AFTER_MS,
  translations,
  WBW_CHUNK,
} from './translations.svelte'

const EN = 'tr.en.rwwad'
const UR = 'tr.ur.junagarhi'
const FR = 'tr.fr.rashid'

/** Marks packs installed in the mock catalogue (the `packs` slice). */
function install(...ids: string[]): void {
  state.packs.update((v) => {
    for (const p of v.list) {
      if (!ids.includes(p.id)) continue
      p.state = { type: 'installed', data: { version: p.version } }
      p.installedKib = p.sizeKib
    }
  })
}

/** Boots the stores this store reads (settings, quran, app) and the store itself on the mock's bootstrap. */
async function boot(patch: Partial<Settings> = {}, installed: string[] = [EN, UR]): Promise<Bootstrap> {
  install(...installed)
  state.settings.set({ ...defaultSettings(), ...patch })
  const b = await call(api.appBootstrap())
  settings.value = b.settings
  app.init(b)
  quran.init(b)
  translations.init(b)
  flushSync()
  return b
}

function setSettings(patch: Partial<Settings>): void {
  settings.value = { ...settings.value, ...patch }
  flushSync()
}

/** Lets queued microtasks, effects and the mock's 2–8 ms delays run. */
async function settle(ms = 30): Promise<void> {
  flushSync()
  await new Promise((r) => setTimeout(r, ms))
  flushSync()
}

beforeAll(async () => {
  await initIpc()
})

beforeEach(() => {
  state.resetAll()
  state.loadAll()
  contentMock.reset()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  translations.reset()
  packs.reset()
  quran.reset()
  app.reset()
  settings.reset()
})

describe('helpers', () => {
  it('aligns blocks of 50 ayahs', () => {
    expect(BLOCK).toBe(50)
    expect(blockOf(1)).toBe(0)
    expect(blockOf(50)).toBe(0)
    expect(blockOf(51)).toBe(1)
    expect(blockRange(0)).toEqual([1, 50])
    expect(blockRange(124)).toEqual([6201, 6236])
  })

  it('derives a language and direction from a pack id', () => {
    expect(languageOfPackId('tr.en.saheeh')).toBe('en')
    expect(languageOfPackId('tafsir.ar.muyassar')).toBe('ar')
    expect(languageOfPackId('wbw.ur')).toBe('ur')
    expect(languageOfPackId('decor')).toBeNull()
    expect(dirOfLanguage('ur')).toBe('rtl')
    expect(dirOfLanguage('fa-IR')).toBe('rtl')
    expect(dirOfLanguage('en')).toBe('ltr')
    expect(dirOfLanguage(null)).toBe('ltr')
  })
})

describe('packs', () => {
  it('reads the selected translations once each, at most five, and shows the installed ones', async () => {
    await boot({ translations: [EN, EN, UR, ' ', FR, 'tr.id.affairs', 'tr.tr.rwwad', 'tr.es.garcia'] })
    expect(translations.selectedPacks).toEqual([EN, UR, FR, 'tr.id.affairs', 'tr.tr.rwwad'])
    expect(translations.selectedPacks).toHaveLength(MAX_PACKS)
    expect(translations.activePacks).toEqual([EN, UR])
    expect(translations.missingPacks.map((m) => [m.id, m.availability])).toEqual([
      [FR, 'not_installed'],
      ['tr.id.affairs', 'not_installed'],
      ['tr.tr.rwwad', 'not_installed'],
    ])
  })

  it('describes a pack from the catalogue: title, language, direction, availability', async () => {
    await boot({ translations: [UR] })
    const meta = translations.packMeta(UR)
    expect(meta).toMatchObject({
      id: UR,
      kind: 'translation',
      language: 'ur',
      dir: 'rtl',
      availability: 'installed',
    })
    expect(meta.title.en).toBe('Muhammad Junagarhi')
    expect(translations.packTitle(UR)).toBe('Muhammad Junagarhi')
    // A pack no catalogue lists is shown as is (the backend decides).
    expect(translations.packMeta('tr.xx.unknown')).toMatchObject({
      availability: 'unknown',
      dir: 'ltr',
      kind: null,
    })
  })

  it('loads the full catalogue on demand (sizes, recommendations), installed packs first', async () => {
    await boot({ translations: [] }, [UR])
    expect(translations.packMeta(EN).sizeKib).toBeNull()
    await translations.loadCatalog()
    expect(translations.packMeta(EN).sizeKib).toBeGreaterThan(0)
    const catalog = translations.translationCatalog
    expect(catalog[0]?.id).toBe(UR)
    expect(catalog.every((m) => m.kind === 'translation')).toBe(true)
    expect(catalog.some((m) => m.recommended)).toBe(true)
  })

  it('treats a pack the packs store reports downloading as downloading', async () => {
    await boot({ translations: [FR] }, [])
    packs.jobs.set(FR, {
      jobId: 1,
      packId: FR,
      phase: 'downloading',
      receivedKib: 10,
      totalKib: 100,
      itemsDone: 0,
      itemsTotal: 1,
      rateKibS: 1,
      etaS: null,
      error: null,
    })
    expect(translations.packMeta(FR).availability).toBe('downloading')
    expect(translations.activePacks).toEqual([])
  })
})

describe('ensureWindow', () => {
  it('loads text and translations in aligned blocks, in the requested pack order', async () => {
    await boot({ translations: [UR, EN] })
    const ayahs = vi.spyOn(mockCommands, 'quranGetAyahs')
    const tr = vi.spyOn(mockCommands, 'translationGet')
    const v0 = translations.version
    await translations.ensureWindow(45, 60)
    expect(ayahs.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      ['v2', 1, 50],
      ['v2', 51, 100],
    ])
    expect(tr.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      [[UR, EN], 1, 50],
      [[UR, EN], 51, 100],
    ])
    expect(translations.version).toBeGreaterThan(v0)
    const row = translations.row(52)
    expect(row?.ayah.id).toBe(52)
    expect(row?.ayah.surah).toBe(2)
    expect(row?.tr.map((t) => t.packId)).toEqual([UR, EN])
    expect(translations.state(52)).toMatchObject({ text: 'ready', tr: 'ready', error: null })
    expect(translations.state(160)).toMatchObject({ text: 'idle', tr: 'idle' })

    await translations.ensureWindow(1, 100)
    expect(ayahs).toHaveBeenCalledTimes(2)
    expect(tr).toHaveBeenCalledTimes(2)
  })

  it('clamps the window to the Quran and ignores empty windows', async () => {
    await boot({ translations: [EN] })
    const ayahs = vi.spyOn(mockCommands, 'quranGetAyahs')
    await translations.ensureWindow(6230, 9999)
    expect(ayahs.mock.calls.map((c) => [c[1], c[2]])).toEqual([[6201, 6236]])
    await translations.ensureWindow(Number.NaN, 5)
    await translations.ensureWindow(-20, -1)
    expect(ayahs).toHaveBeenCalledTimes(1)
    expect(translations.row(6236)?.ayah.surah).toBe(114)
  })

  it('shares requests in flight', async () => {
    await boot({ translations: [EN] })
    const ayahs = vi.spyOn(mockCommands, 'quranGetAyahs')
    const pending = translations.ensureWindow(1, 7)
    expect(translations.state(3).text).toBe('loading')
    await Promise.all([pending, translations.ensureWindow(2, 3), translations.ensureWindow(7, 7)])
    expect(ayahs).toHaveBeenCalledTimes(1)
  })

  it('loads only the text when no translation is active', async () => {
    await boot({ translations: [FR] }, [])
    const tr = vi.spyOn(mockCommands, 'translationGet')
    await translations.ensureWindow(1, 7)
    expect(tr).not.toHaveBeenCalled()
    expect(translations.row(1)?.tr).toEqual([])
    expect(translations.state(1)).toMatchObject({ text: 'ready', tr: 'ready' })
  })

  it('refetches only the translations when the selection changes, and reloads the last window by itself', async () => {
    await boot({ translations: [EN] })
    await translations.ensureWindow(1, 7)
    const ayahs = vi.spyOn(mockCommands, 'quranGetAyahs')
    const tr = vi.spyOn(mockCommands, 'translationGet')
    setSettings({ translations: [UR, EN] })
    expect(translations.row(1)?.tr).toEqual([])
    expect(translations.state(1).tr).not.toBe('ready')
    await settle()
    expect(ayahs).not.toHaveBeenCalled()
    expect(tr.mock.calls.map((c) => c[0])).toEqual([[UR, EN]])
    expect(translations.row(1)?.tr.map((t) => t.packId)).toEqual([UR, EN])
  })

  it('reloads the remembered window only: a side load (remember: false) never replaces it', async () => {
    await boot({ translations: [EN] })
    await translations.ensureWindow(1, 7)
    await translations.ensureWindow(BLOCK * 3 + 1, BLOCK * 3 + 2, { remember: false })
    const ayahs = vi.spyOn(mockCommands, 'quranGetAyahs')
    setSettings({ mushafStyle: 'qcf_v1' })
    await settle()
    expect(ayahs.mock.calls.map((c) => [c[0], c[1]])).toEqual([['v1', blockRange(blockOf(1))[0]]])
  })

  it('refetches only the text when the Mushaf layout changes (pages are per layout)', async () => {
    await boot({ translations: [EN] })
    await translations.ensureWindow(1, 7)
    const ayahs = vi.spyOn(mockCommands, 'quranGetAyahs')
    const tr = vi.spyOn(mockCommands, 'translationGet')
    setSettings({ mushafStyle: 'qcf_v1' })
    expect(translations.layout).toBe('v1')
    await settle()
    expect(ayahs.mock.calls.map((c) => c[0])).toEqual(['v1'])
    expect(tr).not.toHaveBeenCalled()
    expect(translations.row(1)?.tr).toHaveLength(1)
  })

  it('keeps one broken pack from hiding the others', async () => {
    await boot({ translations: [EN, UR] })
    const real = mockCommands.translationGet
    vi.spyOn(mockCommands, 'translationGet').mockImplementation((ids, from, to) =>
      ids.includes(UR)
        ? Promise.resolve(err('not_found', `pack ${UR} is not installed`))
        : real(ids, from, to),
    )
    const tr = vi.mocked(mockCommands.translationGet)
    await translations.ensureWindow(1, 7)
    await settle()
    expect(translations.row(1)?.tr.map((t) => t.packId)).toEqual([EN])
    expect(translations.brokenPacks.map((b) => [b.meta.id, b.error.kind])).toEqual([[UR, 'not_found']])
    expect(translations.activePacks).toEqual([EN])
    // Both packs, then each alone; dropping the broken one keeps what was loaded (no refetch).
    expect(tr.mock.calls.map((c) => c[0])).toEqual([[EN, UR], [EN], [UR]])

    vi.mocked(mockCommands.translationGet).mockRestore()
    await translations.retry()
    await settle()
    expect(translations.brokenPacks).toEqual([])
    expect(translations.row(1)?.tr.map((t) => t.packId)).toEqual([EN, UR])
  })

  it('keeps a failure per block, waits before retrying it, and retries at once on request', async () => {
    await boot({ translations: [EN] })
    vi.spyOn(mockCommands, 'quranGetAyahs').mockResolvedValue(err('database', 'disk I/O error'))
    await translations.ensureWindow(1, 7)
    const s = translations.state(3)
    expect(s.text).toBe('error')
    expect(s.error).toBeInstanceOf(IpcError)
    expect(s.error?.kind).toBe('database')
    expect(translations.row(3)).toBeUndefined()

    await translations.ensureWindow(1, 7)
    expect(mockCommands.quranGetAyahs).toHaveBeenCalledTimes(1)

    vi.mocked(mockCommands.quranGetAyahs).mockRestore()
    const again = vi.spyOn(mockCommands, 'quranGetAyahs')
    await translations.retry(3)
    expect(again).toHaveBeenCalled()
    expect(translations.state(3).text).toBe('ready')
    expect(RETRY_AFTER_MS).toBeGreaterThan(0)
  })
})

describe('tafsirFor', () => {
  it('caches a range entry under every ayah it covers and shares requests', async () => {
    await boot({ translations: [] }, ['tafsir.ar.muyassar'])
    const spy = vi.spyOn(mockCommands, 'tafsirGet')
    const [a, b] = await Promise.all([
      translations.tafsirFor('tafsir.en.ibn_kathir', 300),
      translations.tafsirFor('tafsir.en.ibn_kathir', 300),
    ])
    expect(a).toBe(b)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(a.fromAyahId).toBeLessThanOrEqual(300)
    expect(a.toAyahId).toBeGreaterThanOrEqual(300)
    for (let id = a.fromAyahId; id <= a.toAyahId; id++) {
      expect(translations.tafsirOf('tafsir.en.ibn_kathir', id)).toBe(a)
      await translations.tafsirFor('tafsir.en.ibn_kathir', id)
    }
    expect(spy).toHaveBeenCalledTimes(1)
    const whole = await translations.tafsirFor('tafsir.ar.muyassar', 1)
    expect(whole).toMatchObject({ lang: 'ar', dir: 'rtl', fetchedAt: null, stale: false })
  })

  it('rejects with the IpcError: offline for a chapter that is not cached, not_found for a missing pack', async () => {
    await boot({ translations: [], networkAllowed: false })
    await expect(translations.tafsirFor('tafsir.en.ibn_kathir', 300)).rejects.toMatchObject({
      kind: 'offline',
    })
    await expect(translations.tafsirFor('tafsir.ar.muyassar', 1)).rejects.toMatchObject({ kind: 'not_found' })
    await expect(translations.tafsirFor('tafsir.xx.none', 1)).rejects.toBeInstanceOf(IpcError)
  })

  it('fetches a stale entry again once the network is back', async () => {
    await boot({ translations: [] })
    const stale = {
      packId: 'tafsir.en.ibn_kathir',
      fromAyahId: 300,
      toAyahId: 300,
      html: '<p>old</p>',
      lang: 'en',
      dir: 'ltr' as const,
      fetchedAt: 1,
      stale: true,
    }
    translations.tafsir.set('tafsir.en.ibn_kathir:300', stale)
    app.online = false
    expect(await translations.tafsirFor('tafsir.en.ibn_kathir', 300)).toBe(stale)
    app.online = true
    const fresh = await translations.tafsirFor('tafsir.en.ibn_kathir', 300)
    expect(fresh).not.toBe(stale)
    expect(fresh.stale).toBe(false)
  })
})

describe('wbwForRange', () => {
  it('fetches aligned chunks once, skips end markers, and is replaced by another pack', async () => {
    await boot({ translations: [] })
    const spy = vi.spyOn(mockCommands, 'wbwGetRange')
    const first = quran.firstWordOf(1)
    const last = quran.firstWordOf(2) - 1 // 1:1's end marker
    const words = await translations.wbwForRange('wbw.en', first, last)
    expect(words.map((w) => w.wordId)).toEqual([first, first + 1, first + 2, first + 3])
    expect(spy.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([['wbw.en', 1, WBW_CHUNK]])
    await translations.wbwForRange('wbw.en', 5, 40)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(translations.wbwPackId).toBe('wbw.en')

    await translations.wbwForRange('wbw.ur', first, last)
    expect(translations.wbwPackId).toBe('wbw.ur')
    expect(spy).toHaveBeenCalledTimes(2)
    expect([...translations.wbw.values()].every((w) => w.translation !== null)).toBe(true)
  })

  it('falls back to the exact range when an aligned chunk reaches into a chapter that is not cached', async () => {
    await boot({ translations: [] })
    const real = mockCommands.wbwGetRange
    const spy = vi
      .spyOn(mockCommands, 'wbwGetRange')
      .mockImplementationOnce(() => Promise.resolve(err('offline', 'chapter 2 is not cached')))
    const first = quran.firstWordOf(1)
    const words = await translations.wbwForRange('wbw.en', first, first + 2)
    expect(words.map((w) => w.wordId)).toEqual([first, first + 1, first + 2])
    expect(spy.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [1, WBW_CHUNK],
      [first, first + 2],
    ])
    expect(translations.wbw.get(first)).toBeDefined()
    spy.mockImplementation(real)
  })

  it('rejects offline when a chapter is not cached', async () => {
    await boot({ translations: [], networkAllowed: false })
    await expect(translations.wbwForRange('wbw.en', 1, 4)).rejects.toMatchObject({ kind: 'offline' })
    // A reversed or out-of-range window is normalised, an empty one asks for nothing.
    const spy = vi.spyOn(mockCommands, 'wbwGetRange')
    expect(await translations.wbwForRange('wbw.en', -5, 0)).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('copyAyahs', () => {
  it('copies in the copy settings’ format, with the first active translation on request', async () => {
    await boot({ translations: [EN, UR] })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const spy = vi.spyOn(mockCommands, 'quranCopyText').mockResolvedValue({ status: 'ok', data: 'TEXT' })

    expect(await translations.copyAyahs(9, 8)).toBe('TEXT')
    expect(spy).toHaveBeenLastCalledWith(8, 9, {
      includeReference: true,
      referenceStyle: settings.value.copy.referenceStyle,
      ayahNumbers: settings.value.copy.ayahNumbers,
      translationPackId: null,
    })
    expect(writeText).toHaveBeenLastCalledWith('TEXT')

    await translations.copyAyahs(8, 8, true)
    expect(spy.mock.lastCall?.[2].translationPackId).toBe(EN)

    writeText.mockRejectedValueOnce(new Error('denied'))
    await expect(translations.copyAyahs(8, 8)).rejects.toBeInstanceOf(IpcError)
  })
})

describe('events and lifecycle', () => {
  it('reloads an active translation that changed (PacksChanged) and drops a changed whole tafsir pack', async () => {
    await boot({ translations: [EN] }, [EN, 'tafsir.ar.muyassar'])
    await translations.ensureWindow(1, 7)
    await translations.tafsirFor('tafsir.ar.muyassar', 1)
    await translations.tafsirFor('tafsir.en.ibn_kathir', 1)
    const tr = vi.spyOn(mockCommands, 'translationGet')
    await events.packsChanged.emit({ packIds: [EN, 'tafsir.ar.muyassar', 'tafsir.en.ibn_kathir'] })
    await settle(40)
    expect(tr).toHaveBeenCalledTimes(1)
    expect(translations.tafsirOf('tafsir.ar.muyassar', 1)).toBeUndefined()
    // On-demand chapters (Quran.com) keep what was read.
    expect(translations.tafsirOf('tafsir.en.ibn_kathir', 1)).toBeDefined()
  })

  it('opens at the saved translation position (ayah and pixels)', async () => {
    state.user.update((u) => {
      u.positions = [
        { context: 'translation', layout: 'v2', page: 42, ayahId: 262, scrollPx: 37, updatedAt: 0 },
      ]
    })
    await boot({ translations: [EN] })
    expect(translations.anchor).toEqual({ ayahId: 262, delta: 37, page: 42 })
  })

  it('reset() drops every cache and late answers', async () => {
    await boot({ translations: [EN] })
    const pending = translations.ensureWindow(1, 7)
    translations.reset()
    await pending
    expect(translations.rows.size).toBe(0)
    expect(translations.row(1)).toBeUndefined()
    expect(translations.version).toBe(0)
    expect(translations.anchor).toBeNull()
    expect(translations.topAyahId).toBeNull()
  })
})
