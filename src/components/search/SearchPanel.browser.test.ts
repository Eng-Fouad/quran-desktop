/**
 * The Search panel in a real browser (§9.7, §9.8, §1.5, §10.1; WP10b acceptance), inside the real `App` on the IPC
 * mock: 2,000 hits scrolled through a virtualised list under a sticky surah header, word windows fitted to three lines,
 * the keyboard model (field, list, F3), opening hits in the reader and the side pane, the hit menu, the filter and
 * mode controls, references, every §9.8 state and the Arabic UI. `search_query` answers are scripted where the exact
 * hits matter, so nothing depends on exported fixtures.
 */
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import '../../app.css'
import type { SearchHit, SearchRequest, SearchResults, Settings } from '$lib/ipc/bindings'
import { mockCommands } from '$lib/ipc/mock'
import { err, ok } from '$lib/ipc/mock/result'
import { app, quran, reader, search, settings, ui } from '$lib/stores'
import { bootApp, resetApp, settle } from '../shell/testing/boot'

/** `Mod` (§7.7): ⌘ when the browser runs on macOS (the mock reports the browser's platform), Ctrl elsewhere. */
const mod = () => (app.isMac ? 'Meta' : 'Control')

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
/** Text without the bidi isolates around references and terms (§11.3). */
const plain = (el: Element | null | undefined) =>
  (el?.textContent ?? '')
    .replace(/[\u2066-\u2069]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()

const panel = () => $('.search-panel') as HTMLElement
const field = () => $<HTMLInputElement>('.search-panel input[data-qd-focus="search"]') as HTMLInputElement
const scroller = () => $('.search-panel .qd-virtual-list') as HTMLElement
const hitRow = (i: number) => $(`.search-panel [data-hit="${i}"]`)
const mounted = () => $$('.search-panel .qd-virtual-list [data-hit]')

/** Uthmani words of 2:255 (sizes like real hits). */
const KURSI = [
  'ٱللَّهُ',
  'لَآ',
  'إِلَٰهَ',
  'إِلَّا',
  'هُوَ',
  'ٱلۡحَيُّ',
  'ٱلۡقَيُّومُۚ',
  'لَا',
  'تَأۡخُذُهُۥ',
  'سِنَةٞ',
  'وَلَا',
  'نَوۡمٞۚ',
  'لَّهُۥ',
  'مَا',
  'فِي',
  'ٱلسَّمَٰوَٰتِ',
  'وَمَا',
  'فِي',
  'ٱلۡأَرۡضِۗ',
  'مَن',
  'ذَا',
  'ٱلَّذِي',
  'يَشۡفَعُ',
  'عِندَهُۥٓ',
  'إِلَّا',
  'بِإِذۡنِهِۦۚ',
]

const arabicDigits = (n: number) => String(n).replace(/\d/gu, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)] ?? d)

/** A hit of `ayahId` with `n` words (end marker last) and the given word indices matched. */
function hitOf(ayahId: number, n = 8, matched: number[] = [1]): SearchHit {
  const { surah, ayah } = quran.ayahRef(ayahId)
  const first = quran.firstWordOf(ayahId)
  const words = Array.from({ length: n - 1 }, (_, i) => KURSI[i % KURSI.length] ?? '')
  words.push(`۝${arabicDigits(ayah)}`)
  return {
    ayahId,
    surah,
    ayah,
    page: quran.pageOfAyah('v2', ayahId),
    firstWordId: first,
    words,
    matchedWordIds: matched.map((i) => first + i),
    snippet: null,
    noteId: null,
  }
}

function resultsOf(query: string, hits: SearchHit[], extra: Partial<SearchResults> = {}): SearchResults {
  const groups: SearchResults['groups'] = []
  for (const h of hits) {
    const g = groups.at(-1)
    if (g && g.surah === h.surah) {
      g.hits.push(h)
      g.count++
    } else groups.push({ surah: h.surah, count: 1, hits: [h] })
  }
  return {
    query,
    normalized: query,
    total: hits.length,
    truncated: false,
    tookMs: 4,
    groups,
    suggestions: [],
    ...extra,
  }
}

/** `n` hits spread over the whole Quran, in Mushaf order. */
function many(n: number): SearchHit[] {
  return Array.from({ length: n }, (_, i) =>
    hitOf(1 + Math.floor((i * 6236) / n), 6 + (i % 14), [1 + (i % 3)]),
  )
}

/** Scripts `search_query` (and quiets `search_suggest`). */
function answer(respond: (r: SearchRequest) => SearchResults) {
  vi.spyOn(mockCommands, 'searchSuggest').mockResolvedValue(ok([]))
  return vi.spyOn(mockCommands, 'searchQuery').mockImplementation(async (r) => ok(respond(r)))
}

async function boot(extra: Partial<Settings> = {}, size: [number, number] = [1440, 900]): Promise<void> {
  await bootApp({
    size,
    settings: { sidebar: { open: true, widthPx: 300, tab: 'search' }, pageMode: 'spread', ...extra },
  })
  await settle(80)
}

/** Waits until `fn` holds. */
async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await settle(20)
  }
}

/** The sticky header names the surah of the first hit below it. */
function expectStickyHeaderOfTopHit(): void {
  const sticky = $('.search-panel [data-sticky-group]')
  expect(sticky).not.toBeNull()
  const below = (sticky as HTMLElement).getBoundingClientRect().bottom
  const under = mounted().find((r) => r.getBoundingClientRect().bottom > below + 4)
  expect(Number(sticky?.dataset.stickyGroup)).toBe(quran.ayahRef(Number(under?.dataset.ayah)).surah)
}

/** Types into the field and waits for the results of that query to be on screen. */
async function searchFor(query: string): Promise<void> {
  await userEvent.fill(field(), query)
  await until(() => search.status !== 'loading' && !search.stale && search.trimmed === query.trim())
  flushSync()
  await settle(60)
}

afterEach(async () => {
  resetApp()
  vi.restoreAllMocks()
  await page.viewport(1280, 800)
})

describe('2,000 hits', () => {
  it('scrolls them virtualised: few rows mounted, the sticky header follows, the last hit renders', async () => {
    await boot()
    answer((r) => resultsOf(r.query, many(2000)))
    await searchFor('الله')
    const groups = search.results?.groups.length ?? 0
    expect(plain($('.search-panel .summary'))).toBe(`2,000 results in ${groups} surahs · 4 ms`)
    expect(mounted().length).toBeGreaterThan(3)
    expect(mounted().length).toBeLessThan(60)
    expect($('.search-panel [data-sticky-group]')).toBeNull()

    // Halfway: the sticky header names the surah of the first hit under it.
    const list = scroller()
    list.scrollTop = list.scrollHeight / 2
    await until(() => $('.search-panel [data-sticky-group]') !== null)
    await settle(80)
    expectStickyHeaderOfTopHit()
    expect(mounted().length).toBeLessThan(60)

    // To the end, in steps (virtua measures as it goes).
    for (let i = 0; i < 40 && !hitRow(1999); i++) {
      list.scrollTop = list.scrollHeight
      await settle(30)
    }
    expect(hitRow(1999)).not.toBeNull()
    await settle(80)
    expectStickyHeaderOfTopHit()
    expect(mounted().length).toBeLessThan(60)
  })

  it('moves through them from the keyboard: ↓ from the field, End, Home, ↑ back to the field, type to search', async () => {
    await boot()
    answer((r) => resultsOf(r.query, many(2000)))
    await searchFor('الله')
    field().focus()
    await userEvent.keyboard('{ArrowDown}')
    await until(() => document.activeElement === hitRow(0))
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    await until(() => document.activeElement === hitRow(2))
    // One Tab stop: the focused hit.
    expect(mounted().filter((r) => r.tabIndex === 0)).toEqual([hitRow(2)])
    await userEvent.keyboard('{End}')
    await until(() => document.activeElement === hitRow(1999))
    await userEvent.keyboard('{PageUp}')
    await until(() => document.activeElement === hitRow(1993))
    await userEvent.keyboard('{Home}')
    await until(() => document.activeElement === hitRow(0))
    await userEvent.keyboard('{ArrowUp}')
    await until(() => document.activeElement === field())
    await userEvent.keyboard('{ArrowDown}')
    await until(() => document.activeElement === hitRow(0))
    // Type to search on an Arabic layout: ر is its V key. Playwright types a character outside the US layout with
    // `insertText`, which sends no keydown at all (and Chromium's CDP puts the text into the last focused field by
    // itself), so the keydown goes to the focused hit as that layout reports it.
    hitRow(0)?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ر', code: 'KeyV', bubbles: true, cancelable: true }),
    )
    await until(() => document.activeElement === field())
    expect(field().value).toBe('اللهر')
  })
})

describe('hits', () => {
  it('shows a word window of the 22 px Quran text: at most three lines, the match marked, cut edges faded', async () => {
    await boot()
    answer((r) =>
      resultsOf(r.query, [
        hitOf(262, 51, [20, 45, 48]),
        hitOf(263, 5, [0]),
        { ...hitOf(264, 30, [3]), matchedWordIds: [] },
      ]),
    )
    await searchFor('رحمة')
    const long = hitRow(0) as HTMLElement
    const ayah = long.querySelector('.ayah') as HTMLElement
    const style = getComputedStyle(ayah)
    expect(style.fontFamily).toContain('qd-hafs')
    expect(style.fontSize).toBe('22px')
    expect(Number.parseFloat(style.lineHeight)).toBeCloseTo(46.2, 0)
    expect(ayah.getBoundingClientRect().height).toBeLessThanOrEqual(3 * 46.2 + 2)
    expect(ayah.getAttribute('dir')).toBe('rtl')
    // The first match shows, marked; the two beyond the window are counted.
    const marks = [...long.querySelectorAll('mark')]
    expect(marks).toHaveLength(1)
    expect(marks[0]?.textContent).toBe(KURSI[20])
    expect(plain(long.querySelector('.more'))).toContain('+2 more in this ayah')
    expect(long.querySelector('.cut-start')).not.toBeNull()
    expect(long.querySelector('.cut-end')).not.toBeNull()
    // Words are whole: the text is the words joined by single spaces.
    expect(ayah.textContent?.split(' ').every((w) => KURSI.includes(w) || w.startsWith('۝'))).toBe(true)
    // A short ayah shows whole, end marker included, without fades; a hit without word ids starts at the ayah.
    const short = hitRow(1) as HTMLElement
    expect(short.querySelector('.cut-start, .cut-end, .more')).toBeNull()
    expect(
      short.querySelector('.ayah')?.textContent?.endsWith(`۝${arabicDigits(quran.ayahRef(263).ayah)}`),
    ).toBe(true)
    expect(hitRow(2)?.querySelector('.cut-start')).toBeNull()
    // The key badge and the page.
    expect(plain(long.querySelector('.meta'))).toContain('2:255')
    expect(plain(long.querySelector('.meta'))).toContain(`p ${quran.pageOfAyah('v2', 262)}`)
    expect(plain({ textContent: long.getAttribute('aria-label') } as Element)).toBe(
      `Al-Baqarah 2:255, page ${quran.pageOfAyah('v2', 262)}`,
    )
  })

  it('opens a hit in the reader with its words on the search-hit layer, and marks it active', async () => {
    await boot()
    answer((r) => resultsOf(r.query, [hitOf(1, 5, [2]), hitOf(3, 3, [0]), hitOf(262, 8, [4])]))
    const goToAyah = vi.spyOn(reader, 'goToAyah')
    await searchFor('الرحمن')
    await userEvent.click(hitRow(2) as HTMLElement)
    expect(goToAyah).toHaveBeenLastCalledWith(262, {
      select: true,
      highlightWords: [quran.firstWordOf(262) + 4],
      flash: false,
      focus: true,
    })
    await until(() => hitRow(2)?.getAttribute('aria-current') === 'true')
    expect(search.activeIndex).toBe(2)
    await until(() => reader.searchHit?.ayahId === 262)
    expect(reader.searchHit?.wordIds).toEqual([quran.firstWordOf(262) + 4])
  })

  it('steps through hits with Enter in the field (focus stays) and with F3 from the reader, the list following', async () => {
    await boot()
    answer((r) => resultsOf(r.query, many(300)))
    const goToAyah = vi.spyOn(reader, 'goToAyah')
    await searchFor('الله')
    field().focus()
    await userEvent.keyboard('{Enter}')
    await until(() => search.activeIndex === 0)
    expect(goToAyah.mock.calls.at(-1)?.[1]).toMatchObject({ focus: false, select: true })
    expect(document.activeElement).toBe(field())
    await userEvent.keyboard('{Enter}{Enter}')
    await until(() => search.activeIndex === 2)
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}')
    await until(() => search.activeIndex === 1)

    // F3 from the reader, wrapping backwards to the last hit: the list scrolls it into view.
    ;(document.querySelector('main#qd-main') as HTMLElement).focus()
    await userEvent.keyboard('{Shift>}{F3}{/Shift}{Shift>}{F3}{/Shift}')
    await until(() => search.activeIndex === 299)
    await until(() => hitRow(299) !== null)
    // virtua corrects the scroll frame by frame while the rows it lands on are measured: wait for it to settle (slow
    // frames, as WebKit's under load, only make that take longer), then the hit sits below the sticky header.
    const inView = () => {
      const row = (hitRow(299) as HTMLElement).getBoundingClientRect()
      const box = scroller().getBoundingClientRect()
      return row.top >= box.top + 31 && row.bottom <= box.bottom + 1
    }
    await until(inView).catch(() => undefined)
    const row = (hitRow(299) as HTMLElement).getBoundingClientRect()
    const box = scroller().getBoundingClientRect()
    expect(row.top).toBeGreaterThanOrEqual(box.top + 31)
    expect(row.bottom).toBeLessThanOrEqual(box.bottom + 1)
    expect(hitRow(299)?.getAttribute('aria-current')).toBe('true')
  })

  it('opens a hit in the side pane with Mod+Enter or a middle click, and offers the hit menu', async () => {
    await boot()
    answer((r) => resultsOf(r.query, [hitOf(1, 5, [2]), hitOf(262, 8, [4])]))
    const openSidePane = vi.spyOn(ui, 'openSidePane')
    const goToAyah = vi.spyOn(reader, 'goToAyah')
    await searchFor('الرحمن')
    ;(hitRow(1) as HTMLElement).focus()
    await userEvent.keyboard(`{${mod()}>}{Enter}{/${mod()}}`)
    expect(openSidePane).toHaveBeenCalledTimes(1)
    expect(reader.selection?.fromAyahId).toBe(262)
    expect(goToAyah).not.toHaveBeenCalled()

    ;(hitRow(0) as HTMLElement).dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }))
    expect(openSidePane).toHaveBeenCalledTimes(2)
    expect(reader.selection?.fromAyahId).toBe(1)

    await userEvent.click(hitRow(1) as HTMLElement, { button: 'right' })
    await until(() => $$('[role="menuitem"]').length > 0)
    expect(
      $$('[role="menuitem"]').map((m) =>
        plain(m)
          .replace(/Ctrl\+Enter|⌘↩|Enter$/u, '')
          .trim(),
      ),
    ).toEqual(['Open', 'Open in side pane', 'Copy', 'Bookmark'])
    await userEvent.keyboard('{Escape}')
  })
})

describe('controls', () => {
  it('limits the search to a surah or a juz from the filter picker, and clears it', async () => {
    await boot()
    const spy = answer((r) => resultsOf(r.query, [hitOf(2150, 6, [1])]))
    await searchFor('الرحمن')
    await userEvent.click($('.search-panel .filter .chip-button') as HTMLElement)
    await until(() => $$('[role="listbox"] [role="option"]').length > 0)
    // All surahs, 30 juz, 114 surahs.
    expect($$('[role="listbox"] [role="option"]')).toHaveLength(145)
    await userEvent.keyboard('kahf')
    await until(() => $$('[role="listbox"] [role="option"]').length === 1)
    await userEvent.keyboard('{Enter}')
    await until(() => search.surahFilter === 18)
    expect(spy.mock.calls.at(-1)?.[0]).toMatchObject({ surah: 18, juz: null })
    expect(plain($('.search-panel .filter .chip-button'))).toBe('Al-Kahf')

    await userEvent.click($('.search-panel .filter .chip-button') as HTMLElement)
    await until(() => $$('[role="listbox"] [role="option"]').length > 0)
    await userEvent.keyboard('j 30{Enter}')
    await until(() => search.juzFilter === 30)
    expect(search.surahFilter).toBeNull()
    expect(plain($('.search-panel .filter .chip-button'))).toBe('Juz 30')

    await userEvent.click($('.search-panel .filter button[aria-label="Search all surahs"]') as HTMLElement)
    await until(() => search.juzFilter === null)
    expect(plain($('.search-panel .filter .chip-button'))).toBe('All surahs')
  })

  it('switches the mode from its menu and remembers it', async () => {
    await boot()
    const spy = answer((r) => resultsOf(r.query, [hitOf(1, 5, [2])]))
    await searchFor('الرحمن')
    await userEvent.click($('.search-panel .chip-button[data-mode]') as HTMLElement)
    await until(() => $$('[role="menuitemradio"]').length === 3)
    expect($$('[role="menuitemradio"]').map((m) => plain(m))).toEqual(['Smart', 'Exact letters', 'Contains'])
    await userEvent.click($$('[role="menuitemradio"]')[1] as HTMLElement)
    await until(() => search.mode === 'exact')
    expect(spy.mock.calls.at(-1)?.[0].mode).toBe('exact')
    expect(plain($('.search-panel .chip-button[data-mode]'))).toBe('Exact letters')
    expect(localStorage.getItem('qd.search.mode')).toBe('exact')
  })

  it('switches the scope; the Translation scope picks an installed pack or shows the install card', async () => {
    await boot()
    answer((r) => resultsOf(r.query, [hitOf(1, 5, [2])]))
    await searchFor('mercy')
    await userEvent.click(
      $$('.search-panel [role="radio"], .search-panel .segmented button')[1] as HTMLElement,
    )
    await until(() => search.scope.type === 'translation')
    expect(search.needsPack).toBe(true)
    await until(() => plain(panel()).includes('Search a translation'))
    expect($$('.search-panel [data-pack]').length).toBeGreaterThan(0)
    expect(field().placeholder).toBe('Search the translation')
  })

  it('offers word completions and fills one in', async () => {
    await boot()
    answer((r) => resultsOf(r.query, [hitOf(1, 5, [2])]))
    vi.spyOn(mockCommands, 'searchSuggest').mockResolvedValue(
      ok([
        { term: 'الرحمن', count: 57 },
        { term: 'الرحيم', count: 95 },
      ]),
    )
    await searchFor('الرح')
    await until(() => $$('.search-panel .completion').length === 2)
    expect($$('.search-panel .completion')[0]?.getAttribute('aria-label')).toBe('الرحمن, 57 ayahs')
    await userEvent.click($$('.search-panel .completion')[1] as HTMLElement)
    await until(() => search.query === 'الرحيم ')
    expect(document.activeElement).toBe(field())
  })

  it('focuses the field with Mod+F from the reader', async () => {
    await boot({ sidebar: { open: true, widthPx: 300, tab: 'index' } })
    ;(document.querySelector('main#qd-main') as HTMLElement).focus()
    await userEvent.keyboard(`{${mod()}>}f{/${mod()}}`)
    await until(() => document.activeElement === field())
    expect(settings.value.sidebar.tab).toBe('search')
  })
})

describe('states (§9.8)', () => {
  it('empty query: recent searches and examples; a recent search runs again', async () => {
    await boot()
    answer((r) => resultsOf(r.query, [hitOf(1, 5, [2])]))
    expect(plain(panel())).toContain('Search the Quran')
    expect($$('.search-panel .example').map((e) => plain(e))).toEqual([
      'الرحمن Quran',
      'mercy Translation',
      '2:255 Reference',
    ])
    await searchFor('الرحمن')
    field().focus()
    await userEvent.keyboard('{Enter}')
    await until(() => search.history.length === 1)
    await userEvent.fill(field(), '')
    await until(() => $$('.search-panel .recent-list button').length === 1)
    expect(plain($('.search-panel .recent'))).toContain('Recent searches')
    await userEvent.click($('.search-panel .recent-list button') as HTMLElement)
    await until(() => search.query === 'الرحمن' && search.flatHits.length === 1)
    await userEvent.fill(field(), '')
    await until(() => $$('.search-panel .recent-list button').length === 1)
    await userEvent.click($('.search-panel .recent-head button') as HTMLElement)
    await until(() => $('.search-panel .recent') === null)
  })

  it('no matches: says so and offers the ways out', async () => {
    await boot()
    answer((r) => resultsOf(r.query, []))
    await searchFor('qqq')
    expect(plain(panel())).toContain('No matches for “qqq”')
    // Smart mode is already on (the default): neither the advice nor a button suggests it again.
    expect(search.mode).toBe('smart')
    expect(plain($('.search-panel .empty .body'))).toBe('Try another spelling, or search the translations.')
    expect(plain($('.search-panel .empty .body'))).not.toContain('Smart')
    expect($$('.search-panel .ways button').map((b) => plain(b))).not.toContain('Use Smart mode')
    search.setMode('exact')
    search.setFilters({ surah: 2 })
    await until(() => search.surahFilter === 2 && !search.stale && search.status === 'done')
    flushSync()
    const ways = $$('.search-panel .ways button').map((b) => plain(b))
    expect(ways).toEqual(['Use Smart mode', 'Search translations', 'Search all surahs'])
    expect(plain($('.search-panel .empty .body'))).toBe(
      'Try Smart mode, another spelling, or search the translations.',
    )
    await userEvent.click($$('.search-panel .ways button')[0] as HTMLElement)
    await until(() => search.mode === 'smart')
  })

  it('a failed search: the error and Retry', async () => {
    await boot()
    const spy = vi.spyOn(mockCommands, 'searchQuery').mockResolvedValue(err('internal', 'boom'))
    vi.spyOn(mockCommands, 'searchSuggest').mockResolvedValue(ok([]))
    await userEvent.fill(field(), 'الرحمن')
    await until(() => search.status === 'error')
    expect(plain(panel())).toContain('The search failed')
    spy.mockImplementation(async (r) => ok(resultsOf(r.query, [hitOf(1, 5, [2])])))
    await userEvent.click($$('.search-panel button').find((b) => plain(b) === 'Retry') as HTMLElement)
    await until(() => search.status === 'done' && mounted().length === 1)
  })

  it('a corrected typo and a truncated list say so', async () => {
    await boot()
    answer((r) =>
      resultsOf(r.query, many(500), {
        total: 1234,
        truncated: true,
        suggestions: ['الرحمن'],
        query: r.query,
      }),
    )
    await searchFor('الرحمان')
    expect(plain($('.search-panel .notice.typo'))).toBe(
      'Showing results for الرحمن No exact match for الرحمان',
    )
    expect(plain($('.search-panel .notice.truncated'))).toBe('Showing 500 of 1,234 Filter by surah')
    expect(plain($('.search-panel .summary'))).toBe('1,234 results · 4 ms')
    await userEvent.click($$('.search-panel .notice.truncated button')[0] as HTMLElement)
    await until(() => $$('[role="listbox"] [role="option"]').length > 0)
    await userEvent.keyboard('{Escape}')
  })

  it('a reference: the jump instead of results, opened with Enter', async () => {
    await boot()
    const spy = answer((r) => resultsOf(r.query, []))
    const goToAyah = vi.spyOn(reader, 'goToAyah')
    await userEvent.fill(field(), '2:255')
    await until(() => $$('.search-panel .jump').length === 1)
    expect(plain($('.search-panel .jump'))).toContain('Go to Al-Baqarah 2:255')
    field().focus()
    await userEvent.keyboard('{Enter}')
    await until(() => goToAyah.mock.calls.length > 0)
    expect(goToAyah.mock.calls[0]?.[0]).toBe(262)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('Arabic UI', () => {
  it('mirrors the panel, with Arabic digits and copy', async () => {
    await boot({ uiLanguage: 'ar', theme: 'night' })
    answer((r) => resultsOf(r.query, [hitOf(1, 5, [2]), hitOf(3, 3, [0]), hitOf(262, 8, [4])]))
    await searchFor('الرحمن')
    expect(getComputedStyle(panel()).direction).toBe('rtl')
    expect(plain($('.search-panel .summary'))).toMatch(/^٣ نتائج في سورتين، ٤ مل+ي ثانية$/u)
    expect(plain(hitRow(2)?.querySelector('.key'))).toBe('٢:٢٥٥')
    expect(field().placeholder).toBe('ابحث في القرآن')
    expect(hitRow(0)?.querySelector('.ayah')?.getAttribute('dir')).toBe('rtl')
  })
})
