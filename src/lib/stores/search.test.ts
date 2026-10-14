/**
 * The search store against the browser mock: the debounced query and the
 * request it sends, dropped stale answers, references, scopes and the translation pack, filters, the hit opener and
 * F3 stepping, history recording, suggestions, re-runs (layout, notes, packs) and errors. `search_query` answers are
 * scripted per test (`answer`), so nothing depends on exported fixtures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, call, events, initIpc } from '$lib/ipc'
import type { PackInfo, SearchHit, SearchRequest, SearchResults } from '$lib/ipc/bindings'
import { mockCommands } from '$lib/ipc/mock'
import { err, ok } from '$lib/ipc/mock/result'
import { state } from '$lib/ipc/mock/state'
import { app } from './app.svelte'
import { i18n } from './i18n.svelte'
import { packs } from './packs.svelte'
import { quran } from './quran.svelte'
import {
  type HitOpener,
  hitKey,
  MODE_STORAGE_KEY,
  requestKey,
  search,
  SEARCH_DEBOUNCE_MS,
  SEARCH_LIMIT,
} from './search.svelte'
import { settings } from './settings.svelte'
import { ui } from './ui.svelte'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** Lets pending promise chains (and the mock's microtask answers) settle. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await wait(0)
}

function stubMatchMedia(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

/** A hit of `ayahId` with three words, the second one matched. */
function hit(ayahId: number, noteId: string | null = null): SearchHit {
  const { surah, ayah } = quran.ayahRef(ayahId)
  const first = quran.firstWordOf(ayahId)
  return {
    ayahId,
    surah,
    ayah,
    page: quran.pageOfAyah('v2', ayahId),
    firstWordId: first,
    words: ['a', 'b', 'c'],
    matchedWordIds: [first + 1],
    snippet: null,
    noteId,
  }
}

/** Results for these ayah ids, grouped by surah in Mushaf order. */
function results(query: string, ids: number[], extra: Partial<SearchResults> = {}): SearchResults {
  const groups: SearchResults['groups'] = []
  for (const id of ids) {
    const h = hit(id)
    const g = groups.at(-1)
    if (g && g.surah === h.surah) {
      g.hits.push(h)
      g.count++
    } else groups.push({ surah: h.surah, count: 1, hits: [h] })
  }
  return {
    query,
    normalized: query,
    total: ids.length,
    truncated: false,
    tookMs: 3,
    groups,
    suggestions: [],
    ...extra,
  }
}

/** Scripts `search_query`: each request is answered by `respond` (after `delayMs`). Returns the spy. */
function answer(respond: (r: SearchRequest) => SearchResults, delayMs = 0) {
  return vi.spyOn(mockCommands, 'searchQuery').mockImplementation(async (r: SearchRequest) => {
    await wait(delayMs)
    return ok(respond(r))
  })
}

/** A recording opener (the components install the reader-backed one). */
function opener() {
  return {
    open: vi.fn<HitOpener['open']>(),
    openInPane: vi.fn<HitOpener['openInPane']>(),
  } satisfies HitOpener
}

function pack(id: string, extra: Partial<PackInfo> = {}): PackInfo {
  return {
    id,
    kind: 'translation',
    title: { en: id, ar: id },
    description: { en: '', ar: '' },
    language: 'en',
    direction: 'ltr',
    version: '1',
    installMode: 'whole',
    requires: [],
    sizeKib: 500,
    itemCount: 1,
    recommended: false,
    revalidateDays: null,
    attribution: { text: { en: '', ar: '' }, url: '', licence: '' },
    state: { type: 'installed', data: { version: '1' } },
    installedKib: 500,
    job: null,
    ...extra,
  }
}

async function boot(): Promise<void> {
  localStorage.clear()
  await initIpc()
  state.resetAll()
  state.loadAll()
  const b = await call(api.appBootstrap())
  app.init(b)
  settings.init(b)
  i18n.init(b)
  quran.init(b)
  ui.init(b)
  search.init(b)
  await flush()
}

beforeEach(async () => {
  stubMatchMedia()
  await boot()
})

afterEach(() => {
  search.setOpener(null)
  search.reset()
  packs.list = []
  ui.reset()
  quran.reset()
  settings.reset()
  app.reset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('typing and requests', () => {
  it('searches 120 ms after the last keystroke, once, with the full request', async () => {
    const spy = answer((r) => results(r.query, [1, 3]))
    search.setQuery('ا')
    search.setQuery('الر')
    search.setQuery('الرحمن')
    expect(search.query).toBe('الرحمن')
    await wait(SEARCH_DEBOUNCE_MS - 40)
    expect(spy).not.toHaveBeenCalled()
    await wait(80)
    await flush()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[0]).toEqual({
      query: 'الرحمن',
      scope: { type: 'quran' },
      mode: 'smart',
      surah: null,
      juz: null,
      limit: SEARCH_LIMIT,
      layout: 'v2',
    })
    expect(search.status).toBe('done')
    expect(search.count).toBe(2)
    expect(search.flatHits.map((h) => h.ayahId)).toEqual([1, 3])
    expect(search.activeIndex).toBe(-1)
    expect(search.stale).toBe(false)
  })

  it('trims the query and asks for page numbers in the layout of the Mushaf style', async () => {
    const spy = answer((r) => results(r.query, [1]))
    settings.value = { ...settings.value, mushafStyle: 'qcf_v1' }
    search.setQuery('  رحمة  ')
    await search.run()
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ query: 'رحمة', layout: 'v1' })
  })

  it('keeps the previous results on screen while a new search runs, and drops answers that arrive late', async () => {
    let n = 0
    vi.spyOn(mockCommands, 'searchQuery').mockImplementation(async (r: SearchRequest) => {
      n++
      // The first request answers after the second.
      await wait(n === 1 ? 60 : 5)
      return ok(results(r.query, r.query === 'old' ? [1] : [2, 3]))
    })
    search.setQuery('old')
    const first = search.run()
    expect(search.status).toBe('loading')
    search.setQuery('new')
    await search.run()
    await first
    expect(search.results?.query).toBe('new')
    expect(search.flatHits.map((h) => h.ayahId)).toEqual([2, 3])
  })

  it('marks the results stale while the field holds another query', async () => {
    answer((r) => results(r.query, [1]))
    search.setQuery('الرحمن')
    await search.run()
    expect(search.stale).toBe(false)
    search.setQuery('الرحيم')
    expect(search.stale).toBe(true)
    await search.run()
    expect(search.stale).toBe(false)
  })

  it('clears at once when the field is emptied', async () => {
    answer((r) => results(r.query, [1]))
    search.setQuery('الرحمن')
    await search.run()
    search.setQuery('')
    expect(search.results).toBeNull()
    expect(search.status).toBe('idle')
    expect(search.request).toBeNull()
  })

  it('offers references instead of searching the Quran for them', async () => {
    const spy = answer((r) => results(r.query, [1]))
    search.setQuery('الرحمن')
    await search.run()
    search.setQuery('2:255')
    // Cleared at once, without waiting for the debounce.
    expect(search.results).toBeNull()
    expect(search.request).toBeNull()
    expect(search.references.map((r) => r.target)).toEqual([{ type: 'ayah', surah: 2, ayah: 255 }])
    search.setQuery('p 262')
    expect(search.references.map((r) => r.target)).toEqual([{ type: 'page', page: 262 }])
    search.setQuery('255')
    expect(search.references.map((r) => r.target)).toEqual([{ type: 'page', page: 255 }])
    await wait(SEARCH_DEBOUNCE_MS + 30)
    expect(spy).toHaveBeenCalledTimes(1)
    // Words never parse as references.
    search.setQuery('kahf')
    expect(search.references).toEqual([])
  })

  it('still searches a translation for a query with digits', async () => {
    packs.list = [pack('tr.en.saheeh')]
    const spy = answer((r) => results(r.query, [1]))
    search.setScope({ type: 'translation', data: { packId: '' } })
    search.setQuery('2:255')
    await search.run()
    expect(search.references).toHaveLength(1)
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ query: '2:255' }))
  })
})

describe('scope, mode and filters', () => {
  it('searches the translation the reader shows, else a recommended one, and needs a pack without any', async () => {
    const spy = answer((r) => results(r.query, [1]))
    search.setQuery('mercy')
    await search.run()
    search.setScope({ type: 'translation', data: { packId: '' } })
    expect(search.needsPack).toBe(true)
    expect(search.request).toBeNull()
    expect(search.results).toBeNull()

    // Installing packs: the effect moves the scope to the best one and searches.
    packs.list = [pack('tr.en.b'), pack('tr.en.a', { recommended: true })]
    await flush()
    expect(search.scope).toEqual({ type: 'translation', data: { packId: 'tr.en.a' } })
    expect(spy.mock.calls.at(-1)?.[0].scope).toEqual({ type: 'translation', data: { packId: 'tr.en.a' } })

    settings.value = { ...settings.value, translations: ['tr.en.b'] }
    expect(search.translationPacks.map((p) => p.id)).toEqual(['tr.en.b', 'tr.en.a'])
    expect(search.defaultPack()).toBe('tr.en.b')

    // The searched pack is removed: the scope moves to the other one.
    packs.list = [pack('tr.en.b')]
    await flush()
    expect(search.scope).toEqual({ type: 'translation', data: { packId: 'tr.en.b' } })
  })

  it('searches again at once on a scope, mode or filter change', async () => {
    const spy = answer((r) => results(r.query, [1]))
    search.setQuery('mercy')
    await search.run()
    spy.mockClear()
    search.setScope({ type: 'notes' })
    search.setMode('exact')
    search.setFilters({ surah: 2 })
    search.setFilters({ juz: 3 })
    await flush()
    expect(spy.mock.calls.map((c) => [c[0].scope.type, c[0].mode, c[0].surah, c[0].juz])).toEqual([
      ['notes', 'smart', null, null],
      ['notes', 'exact', null, null],
      ['notes', 'exact', 2, null],
      ['notes', 'exact', 2, 3],
    ])
    // Unchanged values and invalid filters do nothing.
    spy.mockClear()
    search.setScope({ type: 'notes' })
    search.setMode('exact')
    search.setFilters({ surah: 115 })
    search.setFilters({ juz: 0 })
    search.setFilters({ surah: 2.5 })
    await flush()
    expect(spy).not.toHaveBeenCalled()
    search.clearFilters()
    await flush()
    expect(spy.mock.calls.at(-1)?.[0]).toMatchObject({ surah: null, juz: null })
  })

  it('remembers the mode for the next session', async () => {
    search.setMode('substring')
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe('substring')
    search.reset()
    expect(search.mode).toBe('smart')
    search.init({} as never)
    expect(search.mode).toBe('substring')
    localStorage.setItem(MODE_STORAGE_KEY, 'bogus')
    search.reset()
    search.init({} as never)
    expect(search.mode).toBe('smart')
  })

  it('searches for a query in a scope at once (examples, recent searches, deep links)', async () => {
    const spy = answer((r) => results(r.query, [1]))
    packs.list = [pack('tr.en.saheeh')]
    search.searchFor('mercy', { type: 'translation', data: { packId: 'tr.en.gone' } })
    await flush()
    expect(spy.mock.calls.at(-1)?.[0]).toMatchObject({
      query: 'mercy',
      scope: { type: 'translation', data: { packId: 'tr.en.saheeh' } },
    })
    search.useHistory({ query: 'الرحمن', scope: { type: 'quran' }, lastUsedAt: 1, useCount: 1 })
    await flush()
    expect(spy.mock.calls.at(-1)?.[0]).toMatchObject({ query: 'الرحمن', scope: { type: 'quran' } })
    ui.navigate({ type: 'search', data: { query: 'الرحيم' } })
    await flush()
    expect(search.query).toBe('الرحيم')
    expect(spy.mock.calls.at(-1)?.[0].query).toBe('الرحيم')
  })
})

describe('opening hits', () => {
  it('opens hits through the installed opener with their matched words, and steps with wrap-around', async () => {
    const o = opener()
    search.setOpener(o)
    answer((r) => results(r.query, [1, 3, 262]))
    search.setQuery('الرحمن')
    await search.run()

    search.move(1)
    expect(search.activeIndex).toBe(0)
    expect(o.open).toHaveBeenLastCalledWith(search.flatHits[0], {
      highlightWords: search.flatHits[0]?.matchedWordIds,
      focus: true,
    })
    search.move(1)
    search.move(1)
    expect(search.activeHit?.ayahId).toBe(262)
    search.move(1)
    expect(search.activeIndex).toBe(0)
    search.move(-1)
    expect(search.activeIndex).toBe(2)

    // From no active hit, Shift+F3 starts at the last one.
    search.activeIndex = -1
    search.move(-1)
    expect(search.activeIndex).toBe(2)
    expect(o.open).toHaveBeenCalledTimes(6)
  })

  it('announces the hit when focus stays in the field', async () => {
    search.setOpener(opener())
    const announce = vi.spyOn(ui, 'announce')
    answer((r) => results(r.query, [1, 3]))
    search.setQuery('الرحمن')
    await search.run()
    search.move(1, { focus: false })
    expect(announce).toHaveBeenLastCalledWith(`Result 1 of 2: ${quran.refLabel(1, 'long')}`)
  })

  it('opens a hit in the side pane, and falls back to deep navigation without an opener', async () => {
    const o = opener()
    search.setOpener(o)
    answer((r) => results(r.query, [262]))
    search.setQuery('الكرسي')
    await search.run()
    const h = search.flatHits[0] as SearchHit
    search.openInPane(h)
    expect(o.openInPane).toHaveBeenCalledWith(h)

    search.setOpener(null)
    const navigate = vi.spyOn(ui, 'navigate')
    search.openHit(h)
    expect(navigate).toHaveBeenCalledWith({ type: 'ayah', data: { ayahId: 262 } })
    expect(search.activeIndex).toBe(0)
  })

  it('records a query once per scope when a hit opens, and reloads the history', async () => {
    search.setOpener(opener())
    const add = vi.spyOn(mockCommands, 'searchHistoryAdd')
    answer((r) => results(r.query, [1, 3]))
    search.setQuery('الرحمن')
    await search.run()
    search.move(1)
    search.move(1)
    search.openHit(search.flatHits[0] as SearchHit)
    await flush()
    expect(add).toHaveBeenCalledTimes(1)
    expect(add).toHaveBeenCalledWith('الرحمن', { type: 'quran' })
    expect(search.history.map((h) => h.query)).toEqual(['الرحمن'])

    search.setScope({ type: 'notes' })
    await flush()
    search.move(1)
    await flush()
    expect(add).toHaveBeenCalledTimes(2)
    expect(search.history.map((h) => h.scope.type)).toEqual(['notes', 'quran'])
  })

  it('records a query again after the history was cleared', async () => {
    search.setOpener(opener())
    const add = vi.spyOn(mockCommands, 'searchHistoryAdd')
    answer((r) => results(r.query, [1, 3]))
    search.setQuery('الرحمن')
    await search.run()
    search.openHit(search.flatHits[0] as SearchHit)
    await flush()
    expect(add).toHaveBeenCalledTimes(1)
    await search.clearHistory()
    expect(search.history).toEqual([])
    search.openHit(search.flatHits[1] as SearchHit)
    await flush()
    expect(add).toHaveBeenCalledTimes(2)
    expect(search.history.map((h) => h.query)).toEqual(['الرحمن'])
  })

  it('reads the recent searches again when the library reports a history change (a restore)', async () => {
    const path = '/backups/search.qdb'
    await call(api.searchHistoryAdd('before', { type: 'quran' }))
    await call(api.userBackupCreate(path))
    await call(api.searchHistoryAdd('after-backup', { type: 'quran' }))
    await search.loadHistory()
    expect(search.history.map((h) => h.query)).toEqual(['after-backup', 'before'])
    await call(api.userBackupRestore(path))
    await wait(400) // the coalescing window
    await flush()
    expect(search.history.map((h) => h.query)).toEqual(['before'])
  })

  it('submits: searches a pending query first and opens its first (or last) hit, then steps', async () => {
    const o = opener()
    search.setOpener(o)
    answer((r) => results(r.query, [1, 3, 262]), 5)
    search.setQuery('الرحمن')
    await search.submit()
    expect(search.activeIndex).toBe(0)
    expect(o.open).toHaveBeenLastCalledWith(
      expect.objectContaining({ ayahId: 1 }),
      expect.objectContaining({ focus: false }),
    )
    await search.submit()
    expect(search.activeIndex).toBe(1)
    await search.submit(-1)
    expect(search.activeIndex).toBe(0)

    search.setQuery('الرحيم')
    await search.submit(-1)
    expect(search.activeHit?.ayahId).toBe(262)
    // Nothing to submit for a reference.
    o.open.mockClear()
    search.setQuery('2:255')
    await search.submit()
    expect(o.open).not.toHaveBeenCalled()
  })

  it('keeps the active hit when the same search runs again (another layout)', async () => {
    search.setOpener(opener())
    const spy = answer((r) => results(r.query, [1, 3, 262]))
    search.setQuery('الرحمن')
    await search.run()
    search.move(1)
    search.move(1)
    expect(search.activeHit?.ayahId).toBe(3)
    settings.value = { ...settings.value, mushafStyle: 'qcf_v4' }
    await flush()
    expect(spy.mock.calls.at(-1)?.[0].layout).toBe('v4')
    expect(search.activeHit?.ayahId).toBe(3)
    // A new query starts without an active hit.
    search.setQuery('الرحيم')
    await search.run()
    expect(search.activeIndex).toBe(-1)
  })

  it('keys hits by ayah, or by note for note hits', () => {
    expect(hitKey(hit(5))).toBe('a5')
    expect(hitKey(hit(5, 'n-1'))).toBe('nn-1')
  })
})

describe('re-runs, errors, suggestions and history', () => {
  it('searches notes again when a note changes', async () => {
    const spy = answer((r) => results(r.query, [1]))
    search.setScope({ type: 'notes' })
    search.setQuery('mercy')
    await search.run()
    spy.mockClear()
    await events.userDataChanged.emit({ kinds: ['notes'] })
    await flush()
    expect(spy).toHaveBeenCalledTimes(1)
    await events.userDataChanged.emit({ kinds: ['bookmarks'] })
    await flush()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('reports a failed search and recovers on retry', async () => {
    const spy = vi
      .spyOn(mockCommands, 'searchQuery')
      .mockResolvedValueOnce(err('not_found', 'pack tr.x is not installed'))
    search.setQuery('mercy')
    await search.run()
    expect(search.status).toBe('error')
    expect(search.error?.kind).toBe('not_found')
    expect(search.results).toBeNull()
    spy.mockImplementation(async (r: SearchRequest) => ok(results(r.query, [1])))
    await search.run()
    expect(search.status).toBe('done')
    expect(search.error).toBeNull()
  })

  it('asks for completions of the word being typed (Quran scope only)', async () => {
    answer((r) => results(r.query, [1]))
    const suggest = vi
      .spyOn(mockCommands, 'searchSuggest')
      .mockResolvedValue(ok([{ term: 'الرحمن', count: 45 }]))
    search.setQuery('الرح')
    await search.run()
    await flush()
    expect(suggest).toHaveBeenCalledWith('الرح', 5)
    expect(search.suggestions).toEqual([{ term: 'الرحمن', count: 45 }])

    search.useSuggestion('الرحمن')
    expect(search.query).toBe('الرحمن ')
    await flush()
    // A finished word (trailing space) asks for nothing.
    expect(search.suggestions).toEqual([])

    suggest.mockClear()
    search.setScope({ type: 'notes' })
    await flush()
    expect(suggest).not.toHaveBeenCalled()
    expect(search.suggestions).toEqual([])
  })

  it('replaces only the word being typed with a completion', async () => {
    answer((r) => results(r.query, [1]))
    vi.spyOn(mockCommands, 'searchSuggest').mockResolvedValue(ok([]))
    search.setQuery('يا ايها الذ')
    search.useSuggestion('الذين')
    expect(search.query).toBe('يا ايها الذين ')
    await flush()
  })

  it('clears the history, restoring it when the command fails', async () => {
    await call(api.searchHistoryAdd('الرحمن', { type: 'quran' }))
    await search.loadHistory()
    expect(search.history).toHaveLength(1)
    vi.spyOn(mockCommands, 'searchHistoryClear').mockResolvedValueOnce(err('internal', 'disk full'))
    const toastError = vi.spyOn(ui, 'toastError')
    await search.clearHistory()
    expect(search.history).toHaveLength(1)
    expect(toastError).toHaveBeenCalled()
    await search.clearHistory()
    expect(search.history).toEqual([])
    await search.loadHistory()
    expect(search.history).toEqual([])
  })

  it('identifies requests by every field', () => {
    const base: SearchRequest = {
      query: 'q',
      scope: { type: 'quran' },
      mode: 'smart',
      surah: null,
      juz: null,
      limit: 500,
      layout: 'v2',
    }
    expect(requestKey(base)).toBe(requestKey({ ...base }))
    expect(requestKey(base)).not.toBe(requestKey({ ...base, layout: 'v1' }))
    expect(requestKey(base)).not.toBe(requestKey({ ...base, juz: 1 }))
  })
})
