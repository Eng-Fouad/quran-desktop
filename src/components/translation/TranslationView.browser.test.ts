/**
 * Translation mode (§9.7, §7.4, §9.8) in a real browser, on the IPC mock: the feed and its surah cards, translation
 * blocks in their own language and direction, footnotes (popover and inline), the position kept by ayah (restored
 * within ±2 px when the view opens again or the text size changes), following the reader and the recitation, pointer
 * gestures, the "Add a translation" state and the Arabic UI.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import App from '../../App.svelte'
import { api, events } from '$lib/ipc'
import type { AudioSnapshot, SearchHit } from '$lib/ipc/bindings'
import { app, packs, player, quran, reader, settings, translations, ui } from '$lib/stores'
import { hitOpener } from '../search/open'
import TranslationHarness from './testing/TranslationHarness.svelte'
import { boot, EN, resetAll, scrollFeedTo, scroller, settle, topOf, UR, until, verse } from './testing/setup'

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)
const $$ = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)]
/** Text without the bidi isolates that wrap references (§11.3). */
const plain = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/[⁦-⁩]/gu, '')

async function mount(): Promise<{ unmount: () => void }> {
  const r = render(TranslationHarness)
  await until(() => verse(1)?.querySelector('.arabic'), 'the first verse with its text')
  await until(
    () => verse(1)?.querySelectorAll('section.tr').length === translations.activePacks.length,
    'blocks',
  )
  // virtua settles a jump for 150 ms after the last size change: wait it out before scrolling by script.
  await settle(400)
  return r
}

/** The verse rows mounted and on screen, top to bottom. */
function versesOnScreen(): HTMLElement[] {
  const box = scroller().getBoundingClientRect()
  return $$<HTMLElement>('article[data-qd-ayah]')
    .filter((el) => {
      const r = el.getBoundingClientRect()
      return r.bottom > box.top && r.top < box.bottom
    })
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
}

function snapshot(currentAyahId: number, status: AudioSnapshot['status'] = 'playing'): AudioSnapshot {
  const ref = quran.ayahRef(currentAyahId)
  return {
    status,
    reciterId: 7,
    current: ref,
    currentAyahId,
    range: null,
    ayahRepeat: 1,
    ayahRepeatLeft: 0,
    rangeRepeat: 1,
    rangeRepeatLeft: 0,
    gap: { type: 'none' },
    abLoop: null,
    speedPct: 100,
    volumePct: 100,
    fileMs: 0,
    fileDurationMs: 100_000,
    ayahFromMs: 0,
    ayahToMs: 5000,
    bufferedPct: 100,
    device: null,
    basmalaSkipped: false,
    error: null,
  }
}

/** A Quran-scope search hit of an ayah, its first word matched. */
function searchHit(ayahId: number): SearchHit {
  const { surah, ayah } = quran.ayahRef(ayahId)
  const first = quran.firstWordOf(ayahId)
  return {
    ayahId,
    surah,
    ayah,
    page: quran.pageOfAyah(reader.layout, ayahId),
    firstWordId: first,
    words: [],
    matchedWordIds: [first],
    snippet: null,
    noteId: null,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  resetAll()
})

describe('the feed', () => {
  it('opens with the surah card and the verses, each translation in its own language and direction', async () => {
    await boot()
    await mount()
    const feed = scroller()
    expect(feed.getAttribute('role')).toBe('feed')
    expect(feed.getAttribute('aria-label')).toBe('Verses with translation')

    const card = $('article.card[data-surah="1"]')
    expect(plain(card)).toContain('Al-Fatihah')
    expect(plain(card)).toContain('The Opening')
    expect(plain(card)).toContain('Meccan · 7 ayahs · p 1')
    expect(card?.querySelector('.basmala')).toBeNull()
    expect(card?.querySelector('h2')?.textContent).toBe('Surah 1, Al-Fatihah, The Opening')

    const first = verse(1)
    expect(first?.getAttribute('aria-labelledby')).toBe('tv-k1')
    expect(plain($('#tv-k1'))).toBe('1:1')
    const arabic = first?.querySelector<HTMLElement>('.arabic')
    expect(arabic?.getAttribute('dir')).toBe('rtl')
    expect(arabic?.getAttribute('lang')).toBe('ar')
    expect(arabic?.classList.contains('quran-text')).toBe(true)
    expect(getComputedStyle(arabic as HTMLElement).fontFamily).toContain('qd-hafs')
    expect(getComputedStyle(arabic as HTMLElement).textAlign).toMatch(/start|right/)

    const blocks = [...(first?.querySelectorAll<HTMLElement>('section.tr') ?? [])]
    expect(blocks.map((b) => [b.dataset.pack, b.lang, b.dir])).toEqual([
      [EN, 'en', 'ltr'],
      [UR, 'ur', 'rtl'],
    ])
    expect(blocks.map((b) => b.querySelector('.label')?.textContent?.trim())).toEqual([
      'Rowwad Translation Center',
      'Muhammad Junagarhi',
    ])
    // Verses follow in order, each the feed's next article.
    const ids = versesOnScreen().map((v) => Number(v.dataset.qdAyah))
    expect(ids.slice(0, 3)).toEqual([1, 2, 3])
    expect(verse(2)?.getAttribute('aria-posinset')).toBe('3')
  })

  it('shows the basmala line on every card except Al-Fatihah and At-Tawbah', async () => {
    await boot()
    await mount()
    await scrollFeedTo(1500)
    await until(() => $('article.card[data-surah="2"]'), 'the Al-Baqarah card')
    expect($('article.card[data-surah="2"] .basmala')?.textContent).toBe(
      'بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ',
    )
  })

  it('keeps each end-of-ayah mark on the line of the ayah’s last word, at any width', async () => {
    await boot()
    await mount()
    for (const width of [1280, 720]) {
      await page.viewport(width, 800)
      await settle(300)
      for (let id = 1; id <= 7; id++) {
        const p = verse(id)?.querySelector<HTMLElement>('.arabic')
        const node = p?.firstChild
        if (!p || !(node instanceof Text)) continue
        const text = node.data
        const mark = text.lastIndexOf('۝')
        expect(mark, `1:${id}`).toBeGreaterThan(1)
        expect(text[mark - 1], `1:${id}: a no-break space before ۝`).toBe(String.fromCharCode(0xa0))
        const at = (i: number) => {
          const r = document.createRange()
          r.setStart(node, i)
          r.setEnd(node, i + 1)
          return r.getClientRects()[0] ?? new DOMRect()
        }
        // The mark sits on the line of the word before it.
        expect(Math.abs(at(mark).top - at(mark - 2).top), `1:${id} at ${width} px`).toBeLessThan(4)
      }
    }
    await page.viewport(1280, 800)
  })

  it('hides the Arabic line when translationArabic is off', async () => {
    await boot({ settings: { translationArabic: false } })
    render(TranslationHarness)
    await until(() => verse(1)?.querySelector('section.tr'), 'the first verse')
    expect(verse(1)?.querySelector('.arabic')).toBeNull()
  })
})

describe('footnotes', () => {
  it('opens a popover from its marker, naming the translation, and Escape returns to the marker', async () => {
    await boot()
    await mount()
    const marker = await until(
      () => $<HTMLElement>(`section.tr[data-pack="${EN}"] sup.fn[role="button"]`),
      'a marker',
    )
    marker.scrollIntoView({ block: 'center' })
    await settle()
    expect(marker.getAttribute('aria-haspopup')).toBe('dialog')
    expect(marker.getAttribute('aria-label')).toMatch(/^Footnote \d+$/)
    await userEvent.click(marker)
    const popover = await until(() => $('[data-qd-footnote]'), 'the footnote popover')
    expect(popover.textContent).toMatch(/Footnote \d+/)
    expect(popover.textContent).toContain('Rowwad Translation Center')
    expect(popover.textContent).toContain('Synthetic footnote on')
    expect(marker.getAttribute('aria-expanded')).toBe('true')

    await userEvent.keyboard('{Escape}')
    await until(() => !$('[data-qd-footnote]'), 'the popover to close')
    await settle(300)
    expect(document.activeElement).toBe(marker)
    expect(marker.getAttribute('aria-expanded')).toBe('false')
  })

  it('lists the notes under the text when footnotesInline is on, and a marker moves to its note', async () => {
    await boot({ settings: { footnotesInline: true } })
    await mount()
    const marker = await until(
      () => $<HTMLElement>(`section.tr[data-pack="${EN}"] sup.fn[role="button"]`),
      'a marker',
    )
    const block = marker.closest('section.tr')
    const notes = block?.querySelectorAll('ol.notes li') ?? []
    expect(notes.length).toBeGreaterThan(0)
    expect(marker.hasAttribute('aria-haspopup')).toBe(false)
    marker.scrollIntoView({ block: 'center' })
    await settle()
    await userEvent.click(marker)
    await settle()
    expect(document.activeElement?.closest('ol.notes')).toBe(block?.querySelector('ol.notes'))
    expect($('[data-qd-footnote]')).toBeNull()
  })
})

describe('the position, kept by ayah', () => {
  it('reopens on the same verse within ±2 px', async () => {
    await boot()
    const first = await mount()
    await scrollFeedTo(23_457)
    const anchor = translations.anchor
    expect(anchor).not.toBeNull()
    if (!anchor) return
    const before = versesOnScreen()[0]
    expect(before).toBeDefined()
    if (!before) return
    const id = Number(before.dataset.qdAyah)
    const top = topOf(before)
    // The reader followed the scroll to the page being read.
    expect(reader.page).toBe(anchor.page)

    first.unmount()
    await settle()
    expect(translations.topAyahId).toBeNull()
    render(TranslationHarness)
    const again = await until(() => verse(id), `verse ${id} after reopening`)
    await settle(300)
    expect(Math.abs(topOf(again) - top)).toBeLessThanOrEqual(2)
  })

  it('keeps the verse at the top in place within ±2 px when the text size changes', async () => {
    await boot()
    await mount()
    await scrollFeedTo(12_345)
    const anchor = translations.anchor
    if (!anchor) throw new Error('no anchor')
    expect(quran.ayahRef(anchor.ayahId).ayah).toBeGreaterThan(1) // a verse row, not a surah card
    const row = verse(anchor.ayahId)
    if (!row) throw new Error('no anchor row')
    const top = topOf(row)
    settings.value = { ...settings.value, translationFontPct: 140 }
    await settle(300)
    const after = verse(anchor.ayahId)
    if (!after) throw new Error('the anchor verse is gone')
    expect(Math.abs(topOf(after) - top)).toBeLessThanOrEqual(2)
    const arabic = after.querySelector<HTMLElement>('.arabic')
    expect(parseFloat(getComputedStyle(arabic ?? after).fontSize)).toBeCloseTo(39.2, 0)
  })

  it('opens at the reading cursor when the reader moved since', async () => {
    await boot()
    reader.page = quran.pageOfAyah(reader.layout, 262)
    reader.cursorAyahId = 262 // 2:255
    render(TranslationHarness)
    const target = await until(() => verse(262)?.querySelector('.arabic') && verse(262), 'the cursor verse')
    await settle(300)
    expect(Math.abs(topOf(target) - 12)).toBeLessThanOrEqual(2)
  })

  it('follows a page change from elsewhere unless that page is already on screen', async () => {
    await boot()
    await mount()
    // Page 50 opens Ali 'Imran: its card comes first. Page 51 starts mid-surah: its first verse comes first.
    for (const page of [50, 51]) {
      const first = quran.pageRange(reader.layout, page).from
      const { surah, ayah } = quran.ayahRef(first)
      reader.goToPage(page)
      const target = await until(
        () => (ayah === 1 ? $(`article.card[data-surah="${surah}"]`) : verse(first)),
        `the start of page ${page}`,
      )
      await settle(300)
      expect(Math.abs(topOf(target) - 12)).toBeLessThanOrEqual(2)
    }
    // A page whose verses are already on screen does not move the feed.
    const before = scroller().scrollTop
    const onScreen = versesOnScreen().at(-1)
    const p = quran.pageOfAyah(reader.layout, Number(onScreen?.dataset.qdAyah))
    if (p !== reader.page) {
      reader.goToPage(p)
      await settle(300)
      expect(Math.abs(scroller().scrollTop - before)).toBeLessThanOrEqual(2)
    }
  })

  it('brings the target of a jump without a flash to the top: a search hit with its words', async () => {
    await boot()
    await mount()
    const id = quran.ayahId(2, 163) // the scenario's hit: far below the first verse of its page
    const page = quran.pageOfAyah(reader.layout, id)
    expect(quran.pageRange(reader.layout, page).from).toBeLessThan(id)
    reader.goToAyah(id, { select: true, highlightWords: [quran.firstWordOf(id)] })
    const target = await until(() => verse(id), 'the hit verse')
    await settle(300)
    expect(Math.abs(topOf(target) - 12)).toBeLessThanOrEqual(2)
    await until(() => document.activeElement === verse(id), 'focus on the hit')
    // A hit opened from the keyboard in the search field takes focus to its verse (as the Mushaf does to its ayah).
    const field = document.createElement('input')
    document.body.append(field)
    field.focus()
    const other = quran.ayahId(3, 10)
    hitOpener.open(searchHit(other), { highlightWords: [quran.firstWordOf(other)], focus: true })
    await until(
      () => verse(other) !== null && document.activeElement === verse(other),
      'focus on the hit 3:10',
    )
    await settle(300)
    expect(Math.abs(topOf(verse(other) as HTMLElement) - 12)).toBeLessThanOrEqual(2)
    field.remove()
  })

  it('applies a jump made while the feed is still opening', async () => {
    await boot()
    reader.page = quran.pageOfAyah(reader.layout, 262)
    reader.cursorAyahId = 262 // 2:255
    render(TranslationHarness)
    // At once, before the feed is ready (the prefetch race and three frames).
    reader.goToSurah(2)
    const card = await until(() => $('article.card[data-surah="2"]'), 'the Al-Baqarah card')
    await settle(400)
    expect(Math.abs(topOf(card) - 12)).toBeLessThanOrEqual(2)
    expect(reader.cursorAyahId).toBe(quran.ayahId(2, 1))
    expect(verse(262) === null || topOf(verse(262) as HTMLElement) > scroller().clientHeight).toBe(true)
  })

  it('brings a flashed verse (a jump) to the top and focuses it', async () => {
    await boot()
    await mount()
    reader.flash = { ayahId: 2141, until: performance.now() + 1500 } // 18:1, shown with its surah card
    const card = await until(() => $('article.card[data-surah="18"]'), 'the Al-Kahf card')
    await settle(300)
    expect(Math.abs(topOf(card) - 12)).toBeLessThanOrEqual(2)
    await until(() => document.activeElement === verse(2141), 'focus on 18:1')
    expect(verse(2141)?.classList.contains('flashing')).toBe(true)
  })
})

describe('the recitation', () => {
  it('highlights the recitation verse and keeps it 30 % down; a manual scroll pauses that and offers a way back', async () => {
    await boot()
    await mount()
    // Through the store's `audio-state-changed` listener, as the engine reports it.
    await events.audioStateChanged.emit(snapshot(300))
    const playing = await until(() => verse(300), 'the recitation verse')
    await settle(500)
    expect(playing.classList.contains('playing')).toBe(true)
    expect(playing.getAttribute('aria-describedby')).toBe('tv-p300')
    const height = scroller().clientHeight
    expect(Math.abs(topOf(playing) / height - 0.3)).toBeLessThan(0.02)

    // The user scrolls away: following pauses, and the chip brings the verse back.
    scroller().dispatchEvent(new WheelEvent('wheel', { deltaY: 400, bubbles: true }))
    scroller().scrollTop += 6000
    await settle(200)
    await events.audioStateChanged.emit(snapshot(301))
    await settle(200)
    const chip = await until(() => $<HTMLButtonElement>('.follow .chip'), 'Return to recitation')
    expect(chip.textContent?.trim()).toBe('Return to recitation')
    await userEvent.click(chip)
    const next = await until(() => verse(301), 'verse 301')
    await settle(500)
    expect(Math.abs(topOf(next) / height - 0.3)).toBeLessThan(0.03)
    expect($('.follow')).toBeNull()
  })
})

describe('pointer gestures', () => {
  it('click selects, Shift+click extends, Mod+click plays, right-click opens the ayah menu', async () => {
    await boot()
    await mount()
    const select = vi.spyOn(reader, 'select')
    const play = vi.spyOn(player, 'playFrom')
    const arabic = verse(2)?.querySelector<HTMLElement>('.arabic')
    if (!arabic) throw new Error('no verse 2')
    await userEvent.click(arabic)
    expect(select).toHaveBeenLastCalledWith(2, false)
    await userEvent.click(arabic, { modifiers: ['Shift'] })
    expect(select).toHaveBeenLastCalledWith(2, true)
    await userEvent.click(arabic, { modifiers: ['Control'] })
    expect(play).toHaveBeenLastCalledWith({ ayahId: 2 })
    await userEvent.click(arabic, { button: 'right' })
    expect(ui.contextMenu?.ayahId).toBe(2)
  })

  it('shows the selection and the actions; actions apply to the verse', async () => {
    await boot()
    await mount()
    reader.selection = { fromAyahId: 3, toAyahId: 4, anchorAyahId: 3 }
    await settle()
    expect(verse(3)?.classList.contains('selected')).toBe(true)
    expect(verse(4)?.classList.contains('selected')).toBe(true)
    expect(verse(5)?.classList.contains('selected')).toBe(false)
    // Two selected verses read as one block: joined edges, and the separator between them is part of it.
    expect(verse(3)?.classList.contains('join-next')).toBe(true)
    expect(verse(3)?.classList.contains('join-prev')).toBe(false)
    expect(verse(4)?.classList.contains('join-prev')).toBe(true)
    expect(verse(4)?.classList.contains('join-next')).toBe(false)
    expect(verse(3)?.nextElementSibling?.classList.contains('joined')).toBe(true)
    expect(verse(4)?.nextElementSibling?.classList.contains('joined')).toBe(false)
    const toolbar = verse(3)?.querySelector('[role="toolbar"]')
    expect(toolbar?.getAttribute('aria-label')?.replace(/[⁦-⁩]/gu, '')).toBe('Actions for 1:3')
    const open = vi.spyOn(ui, 'openSidePane')
    const study = verse(3)?.querySelector<HTMLButtonElement>('button[aria-label="Tafsir and word by word"]')
    await userEvent.click(study as HTMLButtonElement)
    expect(open).toHaveBeenCalledWith('tafsir')
  })
})

describe('states', () => {
  it('offers to add a translation when none is installed, and Install selects the pack and starts it', async () => {
    await boot({ settings: { translations: [] }, installed: [] })
    render(TranslationHarness)
    const card = await until(() => $('[aria-labelledby="tv-add-title"]'), 'the Add a translation card')
    expect(card.querySelector('h2')?.textContent).toBe('Add a translation')
    const rows = await until(
      () => (card.querySelectorAll('li.pack').length === 3 ? $$('li.pack') : null),
      '3 packs',
    )
    expect(rows.map((r) => r.dataset.pack).every((id) => id?.startsWith('tr.en.'))).toBe(true)
    expect(plain(rows[0])).toMatch(/English · \d+ kB/)
    const install = vi.spyOn(packs, 'install').mockResolvedValue()
    const button = rows[0]?.querySelector<HTMLButtonElement>('button')
    await userEvent.click(button as HTMLButtonElement)
    await settle()
    expect(settings.value.translations).toEqual([rows[0]?.dataset.pack])
    expect(install).toHaveBeenCalledWith(rows[0]?.dataset.pack)
  })

  it('says translations download when online, and disables Install, while offline', async () => {
    await boot({ settings: { translations: [], networkAllowed: false }, installed: [] })
    render(TranslationHarness)
    const card = await until(() => $('[aria-labelledby="tv-add-title"]'), 'the card')
    expect(card.textContent).toContain('Translations download when you’re online')
    await until(() => card.querySelector('li.pack button'), 'a pack row')
    expect($$<HTMLButtonElement>('li.pack button').every((b) => b.disabled)).toBe(true)
  })

  it('says a failed load once, politely: the rows show their Retry without an alert each', async () => {
    await boot()
    const failure = { status: 'error', error: { kind: 'offline', message: 'no connection' } } as const
    vi.spyOn(api, 'quranGetAyahs').mockResolvedValue(failure)
    vi.spyOn(api, 'translationGet').mockResolvedValue(failure)
    render(TranslationHarness)
    await until(() => $$('article[data-qd-ayah] .error').length >= 3, 'errors on the verses')
    expect($$('[role="alert"]')).toHaveLength(0)
    await until(() => $$('[role="status"]').some((st) => plain(st).trim() !== ''), 'the polite status')
    const said = $$('[role="status"]')
      .map((st) => plain(st).trim())
      .filter((t) => t !== '')
    expect(said).toEqual(["The translation couldn't be loaded"])
  })

  it('names a selected translation that is not installed above the verses', async () => {
    await boot({ settings: { translations: [EN, 'tr.en.hilali_khan'] }, installed: [EN] })
    await mount()
    const notice = await until(() => $('.notice[data-pack="tr.en.hilali_khan"]'), 'the notice')
    expect(notice.textContent).toContain('Hilali and Khan isn’t downloaded')
    await userEvent.click(notice.querySelector('button:last-of-type') as HTMLButtonElement)
    await settle()
    expect(settings.value.translations).toEqual([EN])
  })
})

describe('the Arabic UI', () => {
  it('mirrors the rows and uses Arabic-Indic digits', async () => {
    await boot({ lang: 'ar' })
    document.documentElement.dir = 'rtl'
    document.documentElement.lang = 'ar'
    await mount()
    expect(plain($('#tv-k2'))).toBe('١:٢')
    const v = verse(2)
    const badge = v?.querySelector('.key')?.getBoundingClientRect()
    const box = v?.getBoundingClientRect()
    // The key badge sits at the inline start: the right edge in RTL.
    expect(badge && box ? box.right - badge.right : 99).toBeLessThan(24)
    const meta = plain($('article.card[data-surah="1"] .meta'))
    expect(meta.startsWith('مكية، ')).toBe(true)
    expect(meta.endsWith('ص ١')).toBe(true)
    expect(meta).toContain('٧')
    expect($('article.card[data-surah="1"] .name')).toBeNull()
  })
})

describe('the side card (§8.2)', () => {
  for (const lang of ['en', 'ar'] as const) {
    it(`keeps the verse column and its paper clear of the side card (${lang})`, async () => {
      await boot({ lang, settings: { sidebar: { open: true, widthPx: 300, tab: 'index' } } })
      document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'
      document.documentElement.lang = lang
      await page.viewport(1426, 1006)
      render(App)
      app.markReady()
      await until(() => verse(1)?.querySelector('.arabic'), 'the first verse with its text')
      await settle(300)
      expect(reader.dock).toBe('side')
      const card = ($('[data-qd-dock]') as HTMLElement).getBoundingClientRect()
      expect(Math.round(card.width)).toBe(272)
      const boxes = [$('.tv .sheet'), ...$$('.tv .column')]
        .map((el) => (el as HTMLElement).getBoundingClientRect())
        .filter((box) => box.width > 0)
      expect(boxes.length).toBeGreaterThan(3)
      for (const box of boxes) {
        if (lang === 'en') expect(box.right).toBeLessThanOrEqual(card.left)
        else expect(box.left).toBeGreaterThanOrEqual(card.right)
      }
      // The column keeps its full 760 px when the canvas has the room.
      const canvas = ($('main#qd-main') as HTMLElement).getBoundingClientRect()
      if (canvas.width >= 760 + 312) expect(Math.round(boxes[0]?.width ?? 0)).toBe(760)
    })
  }
})
