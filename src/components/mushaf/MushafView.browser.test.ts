/**
 * MushafView in a real browser (§8.10–§8.14, §12.5; WP8e acceptance), mounted in the real `App` on the browser mock:
 * the single-page paper shift (the text block keeps its x on 261/262), the spread (page order, one shadow, spine, fold
 * and corners), the page-turn view transition, CLS 0 across turns, the copy handler, wheel turns and pointer-anchored
 * zoom, the dock reserves, the "Return to recitation" chip and the canvas overlay slot.
 */
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page as browserPage, userEvent } from 'vitest/browser'
import '../../app.css'
import { bootApp, resetApp, settle } from '../shell/testing/boot'
import { idleSnapshot } from '$lib/ipc/mock/state'
import { buildCopyText } from '$lib/mushaf/copy'
import type { PageData } from '$lib/ipc/bindings'
import { a11yItemId } from '$lib/mushaf/a11y'
import { ACTION_BAR_EVENT } from '$lib/mushaf/interactions'
import { UNICODE_FIT, unicodeScale } from '$lib/mushaf/unicodeFit'
import { glyphKey, renditionFontFamily, shapeWarmer, warmPageOf } from '$lib/mushaf/warmup'
import { fonts, memo, pages, player, quran, reader, settings, ui } from '$lib/stores'
import { A11Y_TAB_STOP } from '$lib/stores/reader.svelte'

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const rect = (selector: string) => $(selector)?.getBoundingClientRect() ?? new DOMRect()
const plainText = (s: string | null | undefined) => (s ?? '').replace(/[⁦-⁩]/gu, '')

/** A hafs page's data from the cache (it is on screen or was). */
function pageData(page: number): PageData {
  const data = pages.get('hafs', page)
  if (!data) throw new Error(`page ${page} is not cached`)
  return data
}

/** The Unicode glyph scale a hafs page draws at with the reader's current page mode: its spread's (unicodeFit.ts). */
const hafsScale = (page: number) => unicodeScale(reader.pagesFor(page).map((p) => pageData(p)))

/** The `--glyph-scale` of a page's shown rendition. */
function drawnScale(page: number): number {
  const layers = document.querySelectorAll<HTMLElement>(`section.mp[data-page="${page}"] .mp-glyphs`)
  return Number.parseFloat(layers[layers.length - 1]?.style.getPropertyValue('--glyph-scale') ?? '')
}

/** Waits (real time) until `done()` holds. */
async function until(done: () => boolean, timeout = 5_000, message = 'condition'): Promise<void> {
  const end = performance.now() + timeout
  while (performance.now() < end) {
    flushSync()
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`${message} not met within ${timeout} ms`)
}

/** Waits until the page shows with its words fitted (hafs: no font wait). */
async function shown(page: number): Promise<HTMLElement> {
  await until(
    () => $(`section.mp[data-page="${page}"] .mp-glyphs .ln[style*="--fx"]`) !== null,
    5_000,
    `page ${page} on screen`,
  )
  await settle(40)
  const section = $(`section.mp[data-page="${page}"]`)
  if (!section) throw new Error(`no section for page ${page}`)
  return section
}

async function goTo(page: number): Promise<HTMLElement> {
  reader.goToPage(page, { push: false, transition: false })
  await until(() => reader.visiblePages.includes(page) && !reader.turning, 5_000, `turn to ${page}`)
  return shown(page)
}

afterEach(async () => {
  resetApp()
  vi.restoreAllMocks()
  await browserPage.viewport(1280, 800)
})

describe('single page (§8.10)', () => {
  it('keeps the text block at the same x on pages 261 and 262 (±0.5 px)', async () => {
    await bootApp({ settings: { pageMode: 'single', mushafStyle: 'hafs' } })
    const odd = await goTo(261)
    expect(odd.dataset.side).toBe('right')
    const blockOdd = odd.querySelector('.mp-block')?.getBoundingClientRect()
    const paperOdd = odd.getBoundingClientRect()
    const even = await goTo(262)
    expect(even.dataset.side).toBe('left')
    const blockEven = even.querySelector('.mp-block')?.getBoundingClientRect()
    const paperEven = even.getBoundingClientRect()
    if (!blockOdd || !blockEven) throw new Error('no .mp-block')
    expect(Math.abs(blockOdd.x - blockEven.x)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(blockOdd.width - blockEven.width)).toBeLessThanOrEqual(0.5)
    // The paper moved by M_OUT − M_IN = 1.0 qfs instead.
    expect(paperOdd.x - paperEven.x).toBeCloseTo(reader.qfs, 0)
  })

  it('lays the page out in a SINGLE_W = 22 qfs box, all four corners rounded, with its own shadow', async () => {
    await bootApp({ settings: { pageMode: 'single', mushafStyle: 'hafs' } })
    await shown(1)
    const single = $('[data-qd-stage]') as HTMLElement
    expect(single.classList.contains('single')).toBe(true)
    expect(single.getBoundingClientRect().width).toBeCloseTo(22 * reader.qfs, 0)
    const paper = getComputedStyle($('section.mp .mp-paper') as HTMLElement)
    expect(paper.borderTopLeftRadius).toBe(paper.borderTopRightRadius)
    expect(paper.boxShadow).not.toBe('none')
    expect(getComputedStyle(single).viewTransitionName).toBe('qd-spread')
  })
})

describe('spread (§8.10)', () => {
  it('puts the odd page on the right, draws one book shadow, square spine corners and the fold', async () => {
    await bootApp({ settings: { pageMode: 'spread', mushafStyle: 'hafs' } })
    await shown(1)
    await shown(2)
    const spread = $('[data-qd-stage]') as HTMLElement
    expect(spread.classList.contains('spread')).toBe(true)
    const [first, second] = [...spread.querySelectorAll<HTMLElement>(':scope > .mp')]
    expect(first?.dataset.page).toBe('1')
    expect(second?.dataset.page).toBe('2')
    const right = first?.getBoundingClientRect() ?? new DOMRect()
    const left = second?.getBoundingClientRect() ?? new DOMRect()
    expect(right.left).toBeCloseTo(left.right, 0)
    expect(right.width).toBeCloseTo(21 * reader.qfs, 0)

    expect(getComputedStyle(spread).boxShadow).not.toBe('none')
    const rightPaper = getComputedStyle(first?.querySelector('.mp-paper') as HTMLElement)
    const leftPaper = getComputedStyle(second?.querySelector('.mp-paper') as HTMLElement)
    expect(rightPaper.boxShadow).toBe('none')
    expect(rightPaper.borderTopLeftRadius).toBe('0px')
    expect(rightPaper.borderTopRightRadius).not.toBe('0px')
    expect(leftPaper.borderTopRightRadius).toBe('0px')
    expect(leftPaper.borderTopLeftRadius).not.toBe('0px')

    // Spine shading on the spine side of each page, the fold hairline in the middle.
    const shade = getComputedStyle(first?.querySelector('.mp-paper') as HTMLElement, '::after')
    expect(shade.backgroundImage).toContain('linear-gradient')
    expect(Number.parseFloat(shade.width)).toBeCloseTo(1.2 * reader.qfs, 0)
    const fold = getComputedStyle(spread, '::after')
    expect(fold.width).toBe('1px')
  })

  it('keeps book order in the Arabic UI', async () => {
    await bootApp({ settings: { pageMode: 'spread', mushafStyle: 'hafs', uiLanguage: 'ar' } })
    await shown(1)
    const one = rect('section.mp[data-page="1"]')
    const two = rect('section.mp[data-page="2"]')
    expect(one.left).toBeGreaterThan(two.left)
  })

  it('reserves the bar dock under the book (§8.2, D28)', async () => {
    await bootApp({ size: [1600, 1000], settings: { mushafStyle: 'hafs' } })
    await shown(1)
    expect(reader.dock).toBe('bar')
    const canvas = rect('main.canvas')
    const book = rect('[data-qd-stage]')
    expect(canvas.bottom - book.bottom).toBeGreaterThanOrEqual(84 + 16 - 1)
  })

  it('reserves the side card beside the book (§8.2, D28)', async () => {
    await bootApp({
      size: [1920, 1080],
      settings: { mushafStyle: 'hafs', sidebar: { open: false, widthPx: 300, tab: 'index' } },
    })
    await shown(1)
    expect(reader.dock).toBe('side')
    const c = rect('main.canvas')
    const b = rect('[data-qd-stage]')
    // Centred in the canvas minus the 288 px side card at the inline end (the right in the English UI).
    expect((b.left + b.right) / 2).toBeCloseTo((c.left + c.right - 288) / 2, 0)
  })
})

describe('page turns (§8.11)', () => {
  it('animates only the spread with the staggered view transition, then cleans up', async () => {
    await bootApp({ settings: { pageMode: 'spread', mushafStyle: 'hafs', motion: 'full' } })
    await shown(1)
    if (typeof document.startViewTransition !== 'function') return
    const start = vi.spyOn(document, 'startViewTransition')
    reader.next()
    await until(() => document.documentElement.dataset.turn === 'next', 2_000, 'html[data-turn]')
    expect(getComputedStyle(document.documentElement).viewTransitionName).toBe('none')
    await until(
      () => document.documentElement.dataset.turn === undefined && !reader.turning,
      3_000,
      'turn end',
    )
    expect(start).toHaveBeenCalledTimes(1)
    expect(reader.visiblePages).toEqual([3, 4])
    await shown(3)
  })

  it('does not animate under reduced motion or with the setting off', async () => {
    await bootApp({ settings: { pageMode: 'spread', mushafStyle: 'hafs', pageTurnAnimation: false } })
    await shown(1)
    const start = vi.spyOn(document, 'startViewTransition')
    reader.next()
    await until(() => reader.visiblePages.includes(3) && !reader.turning)
    expect(start).not.toHaveBeenCalled()
  })

  it('shifts nothing on screen across turns (CLS 0, §8.1)', async () => {
    await bootApp({ settings: { pageMode: 'spread', mushafStyle: 'hafs', pageTurnAnimation: false } })
    await shown(1)
    // Shifts of the Mushaf canvas only (the title bar's breadcrumb is the shell's, WP7c).
    const view = $('.mushaf-view') as HTMLElement
    const shifts: number[] = []
    interface Shift extends PerformanceEntry {
      value: number
      sources: { node: Node | null }[]
    }
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Shift[])
        if (entry.sources.some((s) => s.node !== null && view.contains(s.node))) shifts.push(entry.value)
    })
    observer.observe({ type: 'layout-shift', buffered: false })
    for (const target of [3, 5, 7, 262]) {
      reader.goToPage(target, { push: false })
      await until(() => reader.visiblePages.includes(target) && !reader.turning)
      await shown(target)
    }
    await settle(100)
    observer.disconnect()
    expect(shifts.reduce((a, b) => a + b, 0)).toBe(0)
  })
})

describe('the Unicode text is fitted per spread (§8.2, §8.4; unicodeFit.ts)', () => {
  /** Justified ayah lines of a page's shown rendition: the line's `--fx` and its words' share of the line box. */
  function lines(page: number): { fx: number; fill: number }[] {
    const layers = document.querySelectorAll<HTMLElement>(`section.mp[data-page="${page}"] .mp-glyphs`)
    const layer = layers[layers.length - 1]
    if (!layer) return []
    return [...layer.querySelectorAll<HTMLElement>('.ln:not([data-c])')].flatMap((ln) => {
      const words = [...ln.querySelectorAll<HTMLElement>(':scope > .lw > .w')]
      if (words.length === 0) return []
      const fx = Number.parseFloat(ln.style.getPropertyValue('--fx') || '1')
      const width = words.reduce((sum, w) => sum + w.getBoundingClientRect().width, 0)
      return [{ fx, fill: width / ln.getBoundingClientRect().width }]
    })
  }

  it('draws both pages of a spread at one scale, fitted to its widest line, none of them squeezed', async () => {
    await bootApp({ settings: { pageMode: 'spread', mushafStyle: 'hafs', pageTurnAnimation: false } })
    await goTo(262)
    await shown(261)
    const scale = drawnScale(261)
    expect(drawnScale(262)).toBe(scale)
    expect(scale).toBe(hafsScale(262))
    // Pages 261–262 have room: the text grows past the global floor, and every line still fits unsqueezed.
    expect(scale).toBeGreaterThan(UNICODE_FIT.min)
    expect(scale).toBeLessThanOrEqual(UNICODE_FIT.max)
    const all = [...lines(261), ...lines(262)]
    expect(all.length).toBeGreaterThan(20)
    expect(all.every((l) => l.fx === 1)).toBe(true)
    // The words fill more of each line than at the floor, where one global scale left the typical page loose (an
    // unsqueezed line's words grow with the scale).
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
    const fill = median(all.map((l) => l.fill))
    const fillAtFloor = (fill * UNICODE_FIT.min) / scale
    expect(fill - fillAtFloor).toBeGreaterThan(0.02)
  })

  it('takes the scale of the visible page alone in single-page mode, and warms neighbours at theirs', async () => {
    await bootApp({ settings: { pageMode: 'single', mushafStyle: 'hafs', pageTurnAnimation: false } })
    await goTo(262)
    expect(drawnScale(262)).toBe(unicodeScale([pageData(262)]))
    // A spread takes the smaller of its pages' scales: the single page is never smaller than in the spread.
    const page261 = await pages.ensure('hafs', [261]).then(() => pageData(261))
    expect(drawnScale(262)).toBeGreaterThanOrEqual(unicodeScale([page261, pageData(262)]))
  })

  it('keeps the opening pages at the floor (their lines are centred, nothing to fill)', async () => {
    await bootApp({ settings: { pageMode: 'spread', mushafStyle: 'hafs' } })
    await shown(1)
    await shown(2)
    expect(drawnScale(1)).toBe(UNICODE_FIT.min)
    expect(drawnScale(2)).toBe(UNICODE_FIT.min)
  })
})

describe('keyboard focus across turns and jumps (§7.4, §8.15)', () => {
  it('a turn from the focused roving item moves focus to the new view’s tab stop, never to <body>', async () => {
    await bootApp({ settings: { pageMode: 'spread', mushafStyle: 'hafs', pageTurnAnimation: false } })
    await goTo(50)
    // "Skip to Quran text" focuses the view's tab stop.
    const stop = $(A11Y_TAB_STOP) as HTMLElement
    stop.focus()
    expect(document.activeElement).toBe(stop)
    const cursor = reader.cursorAyahId
    for (const [key, spread] of [
      ['{ArrowLeft}', [51, 52]],
      ['{PageDown}', [53, 54]],
      ['{ArrowRight}', [51, 52]],
    ] as const) {
      await userEvent.keyboard(key)
      await until(
        () => reader.visiblePages.join() === spread.join() && !reader.turning,
        5_000,
        `pages ${spread}`,
      )
      await until(() => document.activeElement?.matches(A11Y_TAB_STOP) ?? false, 2_000, `focus after ${key}`)
      const focused = document.activeElement as HTMLElement
      // The tab stop is the first ayah of the new view (the cursor was on the old one), and focus put the cursor there.
      expect(focused).toBe($(`section.mp[data-page="${spread[0]}"] .mp-a11y li`))
      expect(reader.cursorAyahId).toBe(Number(focused.dataset.ayah))
      expect(reader.cursorAyahId).not.toBe(cursor)
    }
  })

  it('a flip from the focused roving item gives focus back once it settles', async () => {
    await bootApp({ settings: { pageMode: 'spread', mushafStyle: 'hafs' } })
    await goTo(50)
    ;($(A11Y_TAB_STOP) as HTMLElement).focus()
    reader.flip('next')
    reader.flip('next')
    await until(() => !reader.flipping && reader.visiblePages.includes(53), 3_000, 'the flip settles')
    await until(() => document.activeElement?.matches(A11Y_TAB_STOP) ?? false, 2_000, 'focus after the flip')
    expect(document.activeElement?.closest('section.mp')?.getAttribute('data-page')).toBe('53')
  })

  it('leaves focus alone when it is elsewhere', async () => {
    await bootApp({ settings: { pageMode: 'spread', mushafStyle: 'hafs', pageTurnAnimation: false } })
    await goTo(50)
    const button = $('button.command') as HTMLElement
    button.focus()
    reader.next()
    await until(() => reader.visiblePages.includes(51) && !reader.turning)
    await settle(100)
    expect(document.activeElement).toBe(button)
  })

  it('Go to "2:255-257" selects the range, flashes, focuses and announces its first ayah', async () => {
    await bootApp({ settings: { pageMode: 'spread', mushafStyle: 'hafs', pageTurnAnimation: false } })
    await shown(1)
    const first = quran.ayahId(2, 255)
    const last = quran.ayahId(2, 257)
    const page = quran.pageOfAyah('v2', first)
    ui.open('goto', {})
    await until(() => $('[role="dialog"] input[role="combobox"]') !== null, 2_000, 'the Go to dialog')
    await settle(200)
    await userEvent.type($('[role="dialog"] input[role="combobox"]') as HTMLElement, '2:255-257')
    await settle(60)
    await userEvent.keyboard('{Enter}')
    await until(() => document.activeElement?.id === a11yItemId(page, first), 5_000, 'focus on 2:255')
    expect(reader.visiblePages).toContain(page)
    expect(reader.selection).toEqual({ fromAyahId: first, toAyahId: last, anchorAyahId: first })
    expect(reader.flash?.ayahId).toBe(first)
    expect(plainText(ui.announcement)).toBe(`${quran.surahName(2)} 2:255–257, page ${page}`)
  })
})

describe('the ayah action bar (§8.17)', () => {
  const BAR = '[role="toolbar"].ab'

  it('Escape closes only the bar; the next Escape clears the selection', async () => {
    await bootApp({ settings: { pageMode: 'spread', mushafStyle: 'hafs', pageTurnAnimation: false } })
    await goTo(50)
    const ayah = Number(($('section.mp[data-page="50"] .mp-a11y li') as HTMLElement).dataset.ayah)
    reader.select(ayah)
    window.dispatchEvent(new CustomEvent(ACTION_BAR_EVENT, { detail: { open: true } }))
    await until(() => $(BAR) !== null, 2_000, 'the action bar')

    await userEvent.keyboard('{Escape}')
    await until(() => $(BAR) === null, 2_000, 'the bar closes')
    await settle(60)
    expect(reader.selection?.fromAyahId).toBe(ayah)

    await userEvent.keyboard('{Escape}')
    await until(() => reader.selection === null, 2_000, 'the second Escape clears the selection')
  })
})

describe('wheel and zoom (§8.13)', () => {
  it('turns one page per wheel notch while the page fits', async () => {
    await bootApp({ settings: { pageMode: 'spread', mushafStyle: 'hafs', pageTurnAnimation: false } })
    await shown(1)
    const view = $('.mushaf-view') as HTMLElement
    const e = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })
    view.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    await until(() => reader.visiblePages.includes(3) && !reader.turning)
    expect(reader.visiblePages).toEqual([3, 4])
  })

  it('zooms with Ctrl+wheel keeping the point under the pointer; past the fit the wheel scrolls', async () => {
    await bootApp({ settings: { pageMode: 'spread', mushafStyle: 'hafs', zoomPct: 200 } })
    const section = await shown(1)
    expect(reader.scrolls).toBe(true)
    const view = $('.mushaf-view') as HTMLElement
    const canvas = view.getBoundingClientRect()
    const x = canvas.left + canvas.width * 0.4
    const y = canvas.top + canvas.height * 0.55
    const block = section.querySelector('.mp-block') as HTMLElement
    const before = block.getBoundingClientRect()
    const fx = (x - before.left) / before.width
    const fy = (y - before.top) / before.height
    for (let i = 0; i < 2; i++) {
      const e = new WheelEvent('wheel', {
        deltaY: -100,
        ctrlKey: true,
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
      })
      view.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(true)
      await settle(30)
    }
    expect(settings.value.zoomPct).toBe(220)
    const after = block.getBoundingClientRect()
    expect(after.width).toBeGreaterThan(before.width * 1.05)
    // The book point under the pointer stays under it (±1 px).
    expect(Math.abs(after.left + fx * after.width - x)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.top + fy * after.height - y)).toBeLessThanOrEqual(1)
    // Past the fit the wheel scrolls natively.
    const plain = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })
    view.dispatchEvent(plain)
    expect(plain.defaultPrevented).toBe(false)
  })

  it('zooms around the canvas centre from the keyboard; a new page starts at its reading corner', async () => {
    await bootApp({ settings: { pageMode: 'spread', mushafStyle: 'hafs', zoomPct: 200 } })
    const section = await shown(1)
    const view = $('.mushaf-view') as HTMLElement
    const c = view.getBoundingClientRect()
    const cx = c.left + c.width / 2
    const cy = c.top + c.height / 2
    const block = section.querySelector('.mp-block') as HTMLElement
    const b0 = block.getBoundingClientRect()
    const fx = (cx - b0.left) / b0.width
    const fy = (cy - b0.top) / b0.height
    reader.zoomIn()
    await settle(30)
    const b1 = block.getBoundingClientRect()
    expect(Math.abs(b1.left + fx * b1.width - cx)).toBeLessThanOrEqual(1)
    expect(Math.abs(b1.top + fy * b1.height - cy)).toBeLessThanOrEqual(1)
    // A new spread on a scrolled canvas starts at its top right, where the right page's text begins.
    const next = await goTo(3)
    const viewport = view.querySelector<HTMLElement>('[data-scroll-area-viewport]') as HTMLElement
    expect(viewport.scrollTop).toBe(0)
    const right = next.getBoundingClientRect().right
    expect(right).toBeLessThanOrEqual(c.right + 0.5)
    expect(right).toBeGreaterThan(c.right - 2 * reader.qfs)
  })
})

describe('copy (§8.14)', () => {
  it('puts the selected words’ Unicode text and the reference on the clipboard, never PUA codes', async () => {
    await bootApp({ settings: { pageMode: 'spread', mushafStyle: 'hafs' } })
    const section = await shown(1)
    const spans = [...section.querySelectorAll<HTMLElement>('.mp-glyphs .w')]
    const from = spans[4]
    const to = spans[9]
    if (!from || !to) throw new Error('page 1 words')
    const range = document.createRange()
    range.setStartBefore(from)
    range.setEndAfter(to)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    const data = new DataTransfer()
    const e = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true })
    from.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    // Words 5–10 of page 1: the end of 1:1 and the whole of 1:2, in the user's copy format (§5.5).
    const words = (pages.get('hafs', 1)?.lines ?? []).flatMap((l) => l.words).slice(4, 10)
    expect(words.map((w) => String(w.id))).toEqual(spans.slice(4, 10).map((s) => s.dataset.w))
    const text = data.getData('text/plain')
    expect(text).toBe(buildCopyText(words, settings.value.copy, quran))
    expect(text.startsWith('﴿١﴾ ')).toBe(true)
    expect(text.endsWith('﴿٢﴾\n— Al-Fatihah 1:1–2')).toBe(true)
    expect(/[-]/u.test(text)).toBe(false)
    selection?.removeAllRanges()
  })

  it('leaves copies outside the glyphs alone', async () => {
    await bootApp({ settings: { mushafStyle: 'hafs' } })
    await shown(1)
    const data = new DataTransfer()
    const e = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true })
    ;($('.mushaf-view') as HTMLElement).dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
  })
})

describe('follow-along chip and the overlay slot (§7.5, §8.12)', () => {
  it('offers "Return to recitation" above the dock after a manual navigation, and returns', async () => {
    await bootApp({ settings: { pageMode: 'spread', mushafStyle: 'hafs', pageTurnAnimation: false } })
    await shown(1)
    player.snapshot = { ...idleSnapshot(settings.value), status: 'playing' }
    player.heard = { surah: 1, ayah: 2, ayahId: 2 }
    reader.goToPage(50)
    await until(() => reader.followChip, 3_000, 'the chip')
    await settle(250)
    const chip = $('[data-qd-follow-chip]') as HTMLElement
    expect(chip.textContent).toContain('Return to recitation')
    expect(chip.closest('.mv-slot')).not.toBeNull()
    const dock = rect('[data-qd-dock-pill]')
    expect(chip.getBoundingClientRect().bottom).toBeLessThanOrEqual(dock.top)
    ;(chip.querySelector('.chip') as HTMLElement).click()
    await until(() => reader.visiblePages.includes(1) && !reader.turning)
    await until(() => $('[data-qd-follow-chip]') === null, 2_000, 'the chip gone')
    player.snapshot = null
    player.heard = null
  })

  it.each([
    ['a single page beside the side card', 'single', 'side'],
    ['a spread above the bar dock', 'auto', 'bar'],
  ] as const)(
    'keeps the memorisation toolbar off the page footer: %s re-fits above it, the dock stays',
    async (_label, pageMode, dock) => {
      await bootApp({
        size: [1600, 1000],
        settings: { pageMode, mushafStyle: 'hafs', sidebar: { open: false, widthPx: 300, tab: 'index' } },
      })
      await goTo(50)
      expect(reader.dock).toBe(dock)
      const before = { qfs: reader.qfs, spread: reader.spread }
      const { from, to } = reader.visibleRange
      memo.startHide(from, to)
      await until(() => $('[data-qd-memo-toolbar]') !== null, 2_000, 'the toolbar')
      await until(() => reader.qfs < before.qfs, 2_000, 'the book re-fits above the toolbar')
      await settle(250)
      const bar = rect('[data-qd-memo-toolbar]')
      expect(bar.height).toBeGreaterThan(40)
      // The dock and the spread decision stay; the book only shrinks.
      expect(reader.dock).toBe(dock)
      expect(reader.spread).toBe(before.spread)
      for (const page of reader.visiblePages) {
        const section = $(`section.mp[data-page="${page}"]`) as HTMLElement
        const foot = section.querySelector(':scope > .mp-foot')?.getBoundingClientRect() ?? new DOMRect()
        const paper = section.getBoundingClientRect()
        expect(foot.height).toBeGreaterThan(0)
        // Nothing of the toolbar's slot over the footer (its number) or the paper's bottom edge: a 12 px gap.
        expect(bar.top).toBeGreaterThanOrEqual(paper.bottom + 12 - 0.5)
        const slot = rect('.mv-slot')
        const overlaps =
          slot.top < foot.bottom && slot.bottom > foot.top && slot.left < foot.right && slot.right > foot.left
        expect(overlaps).toBe(false)
      }
      // Stopping gives the room back.
      memo.stop()
      await until(() => $('[data-qd-memo-toolbar]') === null, 2_000, 'the toolbar leaves')
      await until(() => reader.qfs === before.qfs, 2_000, 'the book re-fits')
      expect(reader.dock).toBe(dock)
    },
  )

  it('mounts the view’s singletons once and draws no placeholder over the pages', async () => {
    await bootApp({ settings: { mushafStyle: 'hafs' } })
    await shown(1)
    const view = $('.mushaf-view') as HTMLElement
    expect(view.querySelectorAll('section.mp')).toHaveLength(2)
    expect(document.querySelectorAll('[data-placeholder]')).toHaveLength(0)
    expect(ui.view).toBe('reader')
    expect(quran.ayahCount).toBeGreaterThan(0)
  })
})

describe('shaping warm-up (§8.18 page turn)', () => {
  /** A hafs page's key at the glyph scale of the spread it shows in (unicodeFit.ts); none while it is not cached. */
  const hafsKey = (page: number) => {
    const spread = reader.pagesFor(page).map((p) => pages.get('hafs', p))
    if (!spread.every((d): d is PageData => d !== undefined)) return `not cached: ${page}`
    return glyphKey('hafs', page, reader.qfs, unicodeScale(spread))
  }

  it('shapes the pages the next and previous turns show once the reader rests, and leaves nothing behind', async () => {
    await bootApp({ settings: { pageMode: 'single', mushafStyle: 'hafs' } })
    await goTo(50)
    const warm = (page: number) => shapeWarmer.isWarm(hafsKey(page), fonts.faceEpoch)
    await until(() => warm(51) && warm(49), 5_000, 'neighbours warm')
    // At their own spread's scale, which is not the floor here: the key would differ.
    expect(hafsKey(51)).not.toBe(glyphKey('hafs', 51, reader.qfs))
    // The page on screen is laid out already: the neighbours' warm-up never does it. No line stays in the host.
    expect(shapeWarmer.hasGlyphsNow(hafsKey(50))).toBe(false)
    const host = $('.mushaf-view > .qd-warm') as HTMLElement
    expect(host.childElementCount).toBe(0)
    expect(getComputedStyle(host).visibility).toBe('hidden')
    expect(host.getBoundingClientRect().width).toBe(0)
    // The host carries the reader's qfs, so its lines are shaped at the size the pages draw them at.
    expect(getComputedStyle(host).getPropertyValue('--qfs')).toBe(`${reader.qfs}px`)
    // A turn moves the window: the next neighbour is warmed after it.
    await goTo(51)
    await until(() => warm(52), 5_000, 'page 52 warm')
    expect(host.childElementCount).toBe(0)
  })

  it('a warmed line has exactly the font, size and features of the page line it stands for', async () => {
    await bootApp({ settings: { pageMode: 'single', mushafStyle: 'hafs' } })
    await goTo(50)
    const line = $('section.mp[data-page="50"] .mp-glyphs .ln') as HTMLElement
    const host = $('.mushaf-view > .qd-warm') as HTMLElement
    const box = document.createElement('div')
    box.className = 'quran-text'
    box.style.setProperty('--glyph-family', renditionFontFamily('qd-hafs', false))
    // What the warm-up uses for page 50: the scale of its spread (here the page alone).
    box.style.setProperty(
      '--glyph-scale',
      String(warmPageOf(pageData(50), reader.qfs, hafsScale(50)).glyphScale),
    )
    const warm = document.createElement('div')
    warm.className = 'qd-warm-ln'
    box.append(warm)
    host.append(box)
    try {
      const a = getComputedStyle(line)
      const b = getComputedStyle(warm)
      expect(b.fontSize).toBe(a.fontSize)
      expect(b.fontFamily).toBe(a.fontFamily)
      expect(b.fontFeatureSettings).toBe(a.fontFeatureSettings)
      expect(b.fontKerning).toBe(a.fontKerning)
    } finally {
      box.remove()
    }
  })
})
