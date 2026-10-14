/**
 * The Index panel in a real browser: the four lists and what they open, the surah filter (names in both scripts,
 * numbers, references), keyboard movement, the surah menu, the recitation dots, the Continue card and the Arabic UI.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import { syntheticIndex } from '$lib/ipc/mock/synthetic'
import { library } from '$lib/stores/library.svelte'
import { memo } from '$lib/stores/memo.svelte'
import { packs } from '$lib/stores/packs.svelte'
import { player } from '$lib/stores/player.svelte'
import { quran } from '$lib/stores/quran.svelte'
import { reader } from '$lib/stores/reader.svelte'
import { settings } from '$lib/stores/settings.svelte'
import { ui } from '$lib/stores/ui.svelte'
import { indexView } from './state.svelte'
import IndexHarness from './testing/IndexHarness.svelte'
import { bootIndex, resetIndex, setRecitation, settle } from './testing/setup'

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)
const $$ = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)]
const surahRows = () => $$('[data-surah]')
const filter = () => $<HTMLInputElement>('.surahs input[type="search"]')
const tab = (name: string) => $$('[role="tab"]').find((t) => t.textContent?.trim() === name)
/** Text without the bidi isolates that wrap references. */
const plain = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/[\u2066-\u2069]/gu, '')

const index = syntheticIndex()

async function mount(options: Omit<Parameters<typeof bootIndex>[0], 'index'> = {}): Promise<void> {
  bootIndex({ index, ...options })
  await render(IndexHarness)
  await settle(100)
}

async function type(text: string): Promise<void> {
  const input = filter()
  if (!input) throw new Error('no filter input')
  await userEvent.clear(input)
  if (text !== '') await userEvent.type(input, text)
  await settle(30)
}

afterEach(() => resetIndex())

describe('surah list', () => {
  it('lists the 114 surahs with name, meaning, Arabic name and meta, and marks the current one', async () => {
    await mount({ page: 262 })
    const rows = surahRows()
    expect(rows).toHaveLength(114)
    const kahf = $('[data-surah="18"]')
    expect(kahf?.textContent).toContain('Al-Kahf')
    expect(kahf?.textContent).toContain('The Cave')
    expect(kahf?.textContent).toContain('الكهف')
    expect(kahf?.textContent).toContain(
      'Meccan · 110 · p ' + quran.pageOfAyah('v2', quran.surahRange(18).from),
    )
    expect(kahf?.getAttribute('aria-label')).toMatch(/^18\. Al-Kahf, The Cave, Meccan, 110 ayahs, page \d+$/)
    // Page 262 opens Al-Hijr (15): it is the current surah and the list's Tab stop.
    const current = $$('[data-surah][aria-current="true"]')
    expect(current.map((r) => r.dataset.surah)).toEqual(['15'])
    expect(current[0]?.tabIndex).toBe(0)
    expect(rows.filter((r) => r.tabIndex === 0)).toHaveLength(1)
  })

  it('opens the current surah centred in the list', async () => {
    await mount({ page: 262 })
    const scroller = $('.surahs .scroll')
    const row = $('[data-surah="15"]')
    if (!scroller || !row) throw new Error('missing list')
    const s = scroller.getBoundingClientRect()
    const r = row.getBoundingClientRect()
    expect(Math.abs(r.top + r.height / 2 - (s.top + s.height / 2))).toBeLessThan(r.height)
  })

  it('opens a surah on click', async () => {
    const goToSurah = vi.spyOn(reader, 'goToSurah')
    await mount()
    await userEvent.click($('[data-surah="36"]') as HTMLElement)
    expect(goToSurah).toHaveBeenCalledWith(36)
  })

  it('filters by Latin and Arabic names, numbers and references', async () => {
    await mount()
    await type('kahf')
    expect(surahRows().map((r) => r.dataset.surah)).toEqual(['18'])
    await type('yaseen')
    expect(surahRows()[0]?.dataset.surah).toBe('36')
    await type('الرحمان')
    expect(surahRows()[0]?.dataset.surah).toBe('55')
    await type('18')
    expect(surahRows().map((r) => r.dataset.surah)).toEqual(['18'])
    // A number also offers its page.
    expect($('.jump')?.textContent).toContain('Go to Page 18')
    // A reference offers the jump above its surah.
    await type('2:255')
    expect(plain($('.jump'))).toContain('Go to Al-Baqara 2:255')
    expect(surahRows().map((r) => r.dataset.surah)).toEqual(['2'])
    await type('kahf 10')
    expect($('.jump')?.textContent).toContain('18:10')
    expect(surahRows().map((r) => r.dataset.surah)).toEqual(['18'])
    await type('')
    expect(surahRows()).toHaveLength(114)
  })

  it('explains a filter that matches nothing, and an out-of-range reference', async () => {
    await mount()
    await type('qqqzzz')
    expect(surahRows()).toHaveLength(0)
    expect(document.body.textContent).toContain('No surah matches “qqqzzz”')
    await type('2:300')
    const jump = $('.jump')
    expect(jump?.getAttribute('aria-disabled')).toBe('true')
    expect(jump?.textContent).toContain('Al-Baqara has 286 ayahs')
  })

  it('opens the jump target, or the first match, on Enter', async () => {
    const goToAyah = vi.spyOn(reader, 'goToAyah')
    const goToSurah = vi.spyOn(reader, 'goToSurah')
    await mount()
    await type('2:255')
    await userEvent.keyboard('{Enter}')
    expect(goToAyah).toHaveBeenCalledWith(262, { select: false, flash: true, focus: false })
    await type('maryam')
    await userEvent.keyboard('{Enter}')
    expect(goToSurah).toHaveBeenCalledWith(19)
  })

  it('moves with the keyboard: one Tab stop, arrows, Home/End, back to the filter', async () => {
    await mount()
    filter()?.focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement?.getAttribute('data-surah')).toBe('1')
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(document.activeElement?.getAttribute('data-surah')).toBe('3')
    await userEvent.keyboard('{End}')
    expect(document.activeElement?.getAttribute('data-surah')).toBe('114')
    await userEvent.keyboard('{Home}')
    expect(document.activeElement?.getAttribute('data-surah')).toBe('1')
    await userEvent.keyboard('{PageDown}')
    expect(document.activeElement?.getAttribute('data-surah')).toBe('9')
    await userEvent.keyboard('{Home}{ArrowUp}')
    expect(document.activeElement).toBe(filter())
    // The focused row became the Tab stop.
    expect($('[data-surah="1"]')?.tabIndex).toBe(0)
  })

  it('types into the filter from a focused row', async () => {
    await mount()
    ;($('[data-surah="2"]') as HTMLElement).focus()
    await userEvent.keyboard('kah')
    await settle(30)
    expect(document.activeElement).toBe(filter())
    expect(filter()?.value).toBe('kah')
    expect(surahRows()[0]?.dataset.surah).toBe('18')
  })

  it('opens the surah menu on right-click and plays the surah', async () => {
    const playRange = vi.spyOn(player, 'playRange')
    await mount()
    await userEvent.click($('[data-surah="67"]') as HTMLElement, { button: 'right' })
    await settle(200)
    const items = $$('[role="menuitem"]').map((m) => m.textContent?.trim())
    expect(items).toEqual([
      'Open',
      'Play surah',
      'Surah info',
      'Download recitation for this surah',
      'Memorize',
    ])
    expect(ui.layerOpen).toBe(true)
    await userEvent.click($$('[role="menuitem"]')[1] as HTMLElement)
    const range = quran.surahRange(67)
    expect(playRange).toHaveBeenCalledWith(range.from, range.to)
  })

  it('downloads the surah recitation and starts memorisation from the menu', async () => {
    const install = vi.spyOn(packs, 'install').mockResolvedValue()
    const startHide = vi.spyOn(memo, 'startHide')
    setRecitation([])
    await mount()
    await userEvent.click($('[data-surah="112"]') as HTMLElement, { button: 'right' })
    await settle(200)
    await userEvent.click($$('[role="menuitem"]')[3] as HTMLElement)
    expect(install).toHaveBeenCalledWith('audio.qdc.7', { type: 'items', data: { items: [112] } })
    await userEvent.click($('[data-surah="112"]') as HTMLElement, { button: 'right' })
    await settle(200)
    await userEvent.hover($$('[role="menuitem"]')[4] as HTMLElement)
    await settle(250)
    await userEvent.click(
      $$('[role="menuitem"]').find((m) => m.textContent?.trim() === 'Hide this surah') as HTMLElement,
    )
    const range = quran.surahRange(112)
    expect(startHide).toHaveBeenCalledWith(range.from, range.to)
  })

  it('shows surah info from the menu', async () => {
    await mount()
    await userEvent.click($('[data-surah="18"]') as HTMLElement, { button: 'right' })
    await settle(200)
    await userEvent.click($$('[role="menuitem"]')[2] as HTMLElement)
    await settle(250)
    const info = $('.info')
    expect(info?.textContent).toContain('Al-Kahf')
    expect(info?.textContent).toContain('Meccan, revelation order 69')
    expect(info?.textContent).toContain('110')
  })

  it('marks surahs downloaded or cached for the current reciter', async () => {
    setRecitation([
      { item: 1, pinned: true },
      { item: 2, pinned: false },
      { item: 3, pinned: false, queued: true },
    ])
    const loadItems = vi.spyOn(packs, 'loadItems')
    await mount()
    expect($('[data-surah="1"] .dot.pinned')).not.toBeNull()
    expect($('[data-surah="2"] .dot.cached')).not.toBeNull()
    // No state: the dot keeps its place, unseen (a dot appearing later never moves the row: CLS 0).
    expect($('[data-surah="3"] .dot:not(.none)')).toBeNull()
    expect(getComputedStyle($('[data-surah="3"] .dot.none') as Element).visibility).toBe('hidden')
    const meta = () => $('[data-surah="3"] .meta')?.getBoundingClientRect()
    const before = meta()
    setRecitation([
      { item: 1, pinned: true },
      { item: 2, pinned: false },
      { item: 3, pinned: false },
    ])
    await settle()
    expect($('[data-surah="3"] .dot.cached')).not.toBeNull()
    expect(meta()?.left).toBe(before?.left)
    expect(meta()?.width).toBe(before?.width)
    expect($('[data-surah="1"]')?.getAttribute('aria-label')).toContain('Recitation downloaded')
    expect($('[data-surah="2"]')?.getAttribute('aria-label')).toContain('Recitation cached')
    // The items are already known: nothing is fetched again.
    expect(loadItems).not.toHaveBeenCalled()
  })

  it('asks for the reciter’s items when they are not loaded yet', async () => {
    setRecitation([])
    packs.items.clear()
    const loadItems = vi.spyOn(packs, 'loadItems').mockResolvedValue()
    await mount()
    expect(loadItems).toHaveBeenCalledWith('audio.qdc.7')
  })
})

describe('juz, hizb and page tabs', () => {
  it('lists the 30 juz with their start and page span, and opens one', async () => {
    const goToJuz = vi.spyOn(reader, 'goToJuz')
    await mount({ page: 262 })
    await userEvent.click(tab('Juz') as HTMLElement)
    await settle(80)
    const rows = $$('[data-juz]')
    expect(rows).toHaveLength(30)
    expect(rows[1]?.textContent).toContain('Juz 2')
    expect(plain(rows[1])).toContain('Al-Baqara 2:142')
    expect($$('[data-juz][aria-current="true"]').map((r) => r.dataset.juz)).toEqual(['14'])
    await userEvent.click(rows[14] as HTMLElement)
    expect(goToJuz).toHaveBeenCalledWith(15)
    expect(indexView.tab).toBe('juz')
  })

  it('lists the 60 hizb under their juz, with quarter chips that open the rub start', async () => {
    const goToHizb = vi.spyOn(reader, 'goToHizb')
    const goToAyah = vi.spyOn(reader, 'goToAyah')
    await mount({ page: 262 })
    await userEvent.click(tab('Hizb') as HTMLElement)
    await settle(80)
    expect($$('[data-hizb]')).toHaveLength(60)
    expect($$('.head')).toHaveLength(30)
    expect($$('.q')).toHaveLength(180)
    await userEvent.click($('[data-hizb="3"]') as HTMLElement)
    expect(goToHizb).toHaveBeenCalledWith(3)
    // Hizb 1, second quarter = rub 3.
    const chips = $$('[data-hizb="1"] ~ .quarters .q')
    expect(chips.map((c) => c.textContent?.trim())).toEqual(['¼', '½', '¾'])
    await userEvent.click(chips[1] as HTMLElement)
    expect(goToAyah).toHaveBeenCalledWith(quran.rubRange(3).from, {
      select: false,
      flash: true,
      focus: false,
    })
  })

  it('moves from a hizb row into its quarter chips with the inline-end arrow', async () => {
    await mount({ page: 262 })
    await userEvent.click(tab('Hizb') as HTMLElement)
    await settle(80)
    ;($('[data-hizb="5"]') as HTMLElement).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(document.activeElement?.textContent?.trim()).toBe('¼')
    await userEvent.keyboard('{ArrowRight}{ArrowRight}')
    expect(document.activeElement?.textContent?.trim()).toBe('¾')
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}')
    expect(document.activeElement?.getAttribute('data-hizb')).toBe('5')
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement?.getAttribute('data-hizb')).toBe('6')
  })

  it('shows the 604 pages by juz, finds a page, and opens it', async () => {
    const goToPage = vi.spyOn(reader, 'goToPage')
    await mount({ page: 262 })
    await userEvent.click(tab('Pages') as HTMLElement)
    await settle(80)
    expect($$('[data-page]')).toHaveLength(604)
    expect($$('[data-page][aria-current="page"]').map((c) => c.dataset.page)).toEqual(
      reader.visiblePages.map(String),
    )
    // Surah starts carry a marker and say so.
    expect($('[data-page="262"]')?.classList.contains('start')).toBe(true)
    expect($('[data-page="262"]')?.getAttribute('aria-label')).toContain('Al-Hijr begins')
    const finder = $<HTMLInputElement>('.pages input[type="search"]') as HTMLInputElement
    await userEvent.type(finder, '٣٠٠')
    await settle(30)
    expect($('[data-page="300"]')?.classList.contains('found')).toBe(true)
    await userEvent.keyboard('{Enter}')
    expect(goToPage).toHaveBeenCalledWith(300, { push: true, transition: true })
    await userEvent.clear(finder)
    await userEvent.type(finder, '700')
    await settle(30)
    expect($('.pages .reason')?.textContent).toBe('The Mushaf has 604 pages')
  })

  it('moves through the page grid in the reading direction', async () => {
    await mount({ page: 1 })
    await userEvent.click(tab('Pages') as HTMLElement)
    await settle(80)
    ;($('[data-page="1"]') as HTMLElement).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(document.activeElement?.getAttribute('data-page')).toBe('2')
    await userEvent.keyboard('{ArrowDown}')
    const below = Number(document.activeElement?.getAttribute('data-page'))
    expect(below).toBeGreaterThan(2)
    await userEvent.keyboard('{ArrowUp}')
    expect(document.activeElement?.getAttribute('data-page')).toBe('2')
  })

  it('remembers the open tab, and a click on it shows the current position again', async () => {
    await mount({ page: 262 })
    await userEvent.click(tab('Juz') as HTMLElement)
    expect(localStorage.getItem('qd.index.tab')).toBe('juz')
    const scroller = $('.rows') as HTMLElement
    scroller.scrollTop = 0
    await userEvent.click(tab('Juz') as HTMLElement)
    await settle(50)
    expect(document.activeElement?.getAttribute('data-juz')).toBe('14')
    localStorage.removeItem('qd.index.tab')
  })
})

describe('Continue card', () => {
  const NOW = Math.floor(Date.now() / 1000)

  it('offers the reading bookmark when it is more than two pages away, and jumps there', async () => {
    const goToAyah = vi.spyOn(reader, 'goToAyah')
    const id = quran.ayahId(18, 45) || 2185
    library.readingBookmark = { ayahId: id, layout: 'v2', page: 297, updatedAt: NOW - 3 * 86_400 }
    await mount({ page: 1 })
    const card = $('.continue .main')
    expect(card?.textContent).toContain('Continue reading')
    expect(plain(card)).toContain('Al-Kahf 18:45 · p 297 · 3 days ago')
    expect(card?.getAttribute('aria-label')).toContain('Continue from reading bookmark')
    await userEvent.click(card as HTMLElement)
    expect(goToAyah).toHaveBeenCalledWith(quran.ayahId(18, 45), { select: false, flash: true, focus: true })
  })

  it('is hidden near the bookmark, and until the bookmark moves once dismissed', async () => {
    library.readingBookmark = { ayahId: 8, layout: 'v2', page: 2, updatedAt: NOW }
    await mount({ page: 3 })
    expect($('.continue')).toBeNull()
    library.readingBookmark = { ayahId: 2185, layout: 'v2', page: 297, updatedAt: NOW }
    await settle(30)
    expect($('.continue')).not.toBeNull()
    await userEvent.click($('.continue .dismiss') as HTMLElement)
    await settle(30)
    expect($('.continue')).toBeNull()
    library.readingBookmark = { ayahId: 2185, layout: 'v2', page: 297, updatedAt: NOW + 60 }
    await settle(30)
    expect($('.continue')).not.toBeNull()
  })
})

describe('Arabic UI', () => {
  it('leads with the Arabic name, uses Arabic digits and the Arabic comma, and runs right to left', async () => {
    await mount({ lang: 'ar', page: 262 })
    const kahf = $('[data-surah="18"]')
    expect(kahf?.querySelector('.name')?.textContent).toBe('الكهف')
    expect(kahf?.querySelector('.sub')?.textContent).toBe('Al-Kahf')
    expect(kahf?.querySelector('.meta')?.textContent?.trim()).toMatch(/^مكية، ١١٠، ص [٠-٩]+$/u)
    expect(getComputedStyle(kahf as HTMLElement).direction).toBe('rtl')
    // The rosette sits at the inline start: the right edge in RTL.
    const rosette = kahf?.querySelector('.rosette')?.getBoundingClientRect()
    const row = kahf?.getBoundingClientRect()
    if (!rosette || !row) throw new Error('missing row')
    expect(row.right - rosette.right).toBeLessThan(20)
    expect(tab('السور')).toBeDefined()
    await type('الكهف')
    expect(surahRows().map((r) => r.dataset.surah)).toEqual(['18'])
  })

  it('writes the quarter chips in the UI digits: ١/٤ ١/٢ ٣/٤, or ¼ ½ ¾ with Western Arabic numbers', async () => {
    await mount({ lang: 'ar', page: 262 })
    await userEvent.click(tab('الأحزاب') as HTMLElement)
    await settle(80)
    const chips = () => $$('[data-hizb="1"] ~ .quarters .q')
    expect(chips().map((c) => c.textContent?.trim())).toEqual(['١/٤', '١/٢', '٣/٤'])
    for (const chip of chips()) {
      // Whole inside the 28 px chip, with no fraction feature reshaping the solidus.
      expect(chip.scrollWidth).toBeLessThanOrEqual(chip.clientWidth)
      expect(getComputedStyle(chip).fontVariantNumeric).toBe('normal')
      const text = [...chip.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())
      if (!text?.textContent) throw new Error('no chip text')
      const box = chip.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(text)
      const ink = range.getBoundingClientRect()
      expect(ink.left).toBeGreaterThanOrEqual(box.left)
      expect(ink.right).toBeLessThanOrEqual(box.right)
      // One left-to-right number in the RTL list: the numerator stays on the left.
      const at = (i: number) => {
        const r = document.createRange()
        r.setStart(text, i)
        r.setEnd(text, i + 1)
        return r.getBoundingClientRect()
      }
      const start = text.textContent.indexOf(text.textContent.trim())
      expect(at(start).right).toBeLessThanOrEqual(at(start + 2).left + 0.5)
    }
    settings.value = { ...settings.value, digits: 'latin' }
    await settle(30)
    expect(chips().map((c) => c.textContent?.trim())).toEqual(['¼', '½', '¾'])
  })
})
