/**
 * The page-navigation affordances besides the rail (§8.11, §8.12; WP8f), in the real `App` on the browser mock:
 * - PageTurnZones: placement in the free canvas beside the paper (never over the text block), book order in both UI
 *   languages, the 0 / 60 % / 100 % chevron, the chevron a drag on the page would turn to, no focus on click, zen;
 * - FlipHUD: shown while flipping with the spread's label, gone 600 ms after the last flip;
 * - DivisionChip: a forward turn or the recitation entering a juz or hizb, once per session, never on a jump;
 * - HintChip: once after the welcome flow, gone for good after "Got it" or a page turn.
 */
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page as browserPage, userEvent } from 'vitest/browser'
import '../../app.css'
import { bootApp, resetApp, settle } from '../shell/testing/boot'
import { idleSnapshot } from '$lib/ipc/mock/state'
import { player, quran, reader, settings, ui } from '$lib/stores'
import { LRI, PDI } from '$lib/stores/i18n.svelte'

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const rect = (selector: string) => $(selector)?.getBoundingClientRect() ?? new DOMRect()
const NEXT = '[data-qd-turn-zone="next"]'
const PREV = '[data-qd-turn-zone="prev"]'
const HUD = '[data-qd-flip-hud]'
const DIVISION = '[data-qd-pagenav="division"]'
const HINT = '[data-qd-pagenav="hint"]'

async function until(done: () => boolean, timeout = 5_000, message = 'condition'): Promise<void> {
  const end = performance.now() + timeout
  while (performance.now() < end) {
    flushSync()
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`${message} not met within ${timeout} ms`)
}

async function boot(options: Parameters<typeof bootApp>[0] = {}): Promise<void> {
  await bootApp({
    size: [1600, 1000],
    ...options,
    settings: { mushafStyle: 'hafs', pageTurnAnimation: false, ...options.settings },
  })
  await until(() => $('section.mp .mp-block') !== null, 5_000, 'the pages')
}

async function goTo(page: number): Promise<void> {
  reader.goToPage(page, { push: false, transition: false })
  await until(() => reader.visiblePages.includes(page) && !reader.turning, 5_000, `turn to ${page}`)
  await settle(60)
}

const opacity = (selector: string) => Number(getComputedStyle($(`${selector} .chev`) as HTMLElement).opacity)

/** The outer paper edges and the text block edges of the book on screen. */
function book(): { paperL: number; paperR: number; textL: number; textR: number } {
  const papers = [...document.querySelectorAll('section.mp')].map((s) => s.getBoundingClientRect())
  const blocks = [...document.querySelectorAll('section.mp .mp-block')].map((s) => s.getBoundingClientRect())
  return {
    paperL: Math.min(...papers.map((r) => r.left)),
    paperR: Math.max(...papers.map((r) => r.right)),
    textL: Math.min(...blocks.map((r) => r.left)),
    textR: Math.max(...blocks.map((r) => r.right)),
  }
}

afterEach(async () => {
  player.snapshot = null
  player.heard = null
  resetApp()
  vi.restoreAllMocks()
  await browserPage.viewport(1280, 800)
})

describe('PageTurnZones (§8.11)', () => {
  it('sits in the free canvas beside the paper, full height, and turns in book order: left = next', async () => {
    await boot()
    await goTo(262)
    await until(() => $(NEXT) !== null && $(PREV) !== null, 2_000, 'both zones')
    const view = rect('.mushaf-view')
    const next = rect(NEXT)
    const prev = rect(PREV)
    const b = book()
    expect(next.width).toBeLessThanOrEqual(56)
    expect(next.width).toBeGreaterThanOrEqual(36)
    expect(next.height).toBeCloseTo(view.height, 0)
    expect(next.left).toBeGreaterThanOrEqual(view.left)
    expect(next.right).toBeLessThanOrEqual(b.paperL - 4)
    expect(prev.left).toBeGreaterThanOrEqual(b.paperR + 4)
    expect(prev.right).toBeLessThanOrEqual(view.right + 0.5)
    // The chevron: 40 px at the height of the book's middle.
    const chev = rect(`${NEXT} .chev`)
    expect(chev.width).toBe(40)
    const paper = rect('section.mp')
    expect(Math.abs(chev.top + chev.height / 2 - (paper.top + paper.bottom) / 2)).toBeLessThan(2)
    expect($(NEXT)?.getAttribute('aria-label')).toBe('Next page')
    expect($(PREV)?.getAttribute('aria-label')).toBe('Previous page')

    await userEvent.click($(NEXT) as HTMLElement)
    await until(() => reader.visiblePages.includes(263) && !reader.turning, 2_000, 'the next spread')
    // A click never takes focus, so the arrow keys keep turning pages.
    expect(document.activeElement?.closest('[data-qd-turn-zone]')).toBeNull()
    await userEvent.click($(PREV) as HTMLElement)
    await until(() => reader.visiblePages.includes(261) && !reader.turning, 2_000, 'back to 261')
  })

  it('stays out of the text block: a single page in a narrow canvas, and a zoomed book', async () => {
    await boot({ size: [1024, 900], settings: { pageMode: 'single' } })
    await goTo(262)
    await settle(120)
    const b = book()
    for (const zone of [NEXT, PREV]) {
      const z = $(zone)
      if (!z) continue
      const r = z.getBoundingClientRect()
      expect(r.right <= b.textL || r.left >= b.textR).toBe(true)
    }
    await settings.update({ zoomPct: 250 })
    await settle(300)
    const zoomed = book()
    for (const zone of [NEXT, PREV]) {
      const z = $(zone)
      if (!z) continue
      const r = z.getBoundingClientRect()
      expect(r.right <= zoomed.textL || r.left >= zoomed.textR).toBe(true)
    }
  })

  it('is invisible, 60 % with the pointer over the canvas and 100 % over the zone', async () => {
    await boot()
    await goTo(262)
    await until(() => $(NEXT) !== null, 2_000, 'the zone')
    expect(opacity(NEXT)).toBe(0)
    const view = $('.mushaf-view') as HTMLElement
    await userEvent.hover(view, { position: { x: view.clientWidth / 2, y: 300 } })
    await settle(300)
    expect(opacity(NEXT)).toBeCloseTo(0.6, 2)
    expect(opacity(PREV)).toBeCloseTo(0.6, 2)
    await userEvent.hover($(NEXT) as HTMLElement)
    await settle(300)
    expect(opacity(NEXT)).toBe(1)
    expect(opacity(PREV)).toBeCloseTo(0.6, 2)
    await userEvent.hover($('nav') as HTMLElement)
    await settle(300)
    expect(opacity(NEXT)).toBe(0)
  })

  it.each([
    ['full-height zones', [1600, 1000], false],
    ['compact chevrons', [1280, 800], true],
  ] as const)(
    'lights the chevron a drag on the page would turn to, until the release or a cancel (%s)',
    async (_label, size, compact) => {
      await boot({ size: [...size] })
      await goTo(262)
      await until(() => $(NEXT) !== null && $(PREV) !== null, 2_000, 'both zones')
      expect($(`${NEXT}.compact`) !== null).toBe(compact)
      const view = $('.mushaf-view') as HTMLElement
      await userEvent.hover(view, { position: { x: view.clientWidth / 2, y: 300 } })
      const layers = document.querySelectorAll<HTMLElement>('section.mp[data-page="262"] .mp-glyphs')
      const word = layers[layers.length - 1]?.querySelector<HTMLElement>('.w:not(.e)') as HTMLElement
      const r = word.getBoundingClientRect()
      const send = (type: string, dx: number) =>
        word.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: r.left + r.width / 2 + dx,
            clientY: r.top + r.height / 2,
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1,
            isPrimary: true,
            pointerId: 7,
            pointerType: 'mouse',
          }),
        )
      send('pointerdown', 0)
      send('pointermove', 40)
      await settle(300)
      expect(opacity(NEXT)).toBeCloseTo(0.6, 2)
      // Far enough to turn on release: right is the next page (book order), the left zone.
      send('pointermove', 120)
      await settle(300)
      expect(opacity(NEXT)).toBe(1)
      expect(opacity(PREV)).toBeCloseTo(0.6, 2)
      send('pointermove', -120)
      await settle(300)
      expect(opacity(PREV)).toBe(1)
      expect(opacity(NEXT)).toBeCloseTo(0.6, 2)
      // Escape cancels the drag: nothing stays lit, nothing turns.
      await userEvent.keyboard('{Escape}')
      await settle(300)
      expect(opacity(PREV)).toBeCloseTo(0.6, 2)
      send('pointerup', -120)
      await settle(150)
      expect(reader.visiblePages).toEqual([261, 262])
      // A release that turns lets the chevron go as well.
      send('pointerdown', 0)
      send('pointermove', 120)
      await settle(300)
      expect(opacity(NEXT)).toBe(1)
      send('pointerup', 120)
      await until(() => reader.visiblePages.includes(263) && !reader.turning, 2_000, 'the next spread')
      await settle(300)
      expect(opacity(NEXT)).toBeCloseTo(0.6, 2)
    },
  )

  it('offers no previous page at the first spread and no next page at the last', async () => {
    await boot()
    await goTo(1)
    await until(() => $(NEXT) !== null, 2_000, 'the next zone')
    expect($(PREV)).toBeNull()
    await goTo(604)
    await until(() => $(PREV) !== null, 2_000, 'the previous zone')
    expect($(NEXT)).toBeNull()
  })

  it('keeps book order in the Arabic UI', async () => {
    await boot({ settings: { uiLanguage: 'ar' } })
    await goTo(262)
    await until(() => $(NEXT) !== null, 2_000, 'the zone')
    const b = book()
    expect(rect(NEXT).right).toBeLessThanOrEqual(b.paperL)
    expect(rect(PREV).left).toBeGreaterThanOrEqual(b.paperR)
    expect($(NEXT)?.getAttribute('aria-label')).toBe('الصفحة التالية')
    await userEvent.click($(NEXT) as HTMLElement)
    await until(() => reader.visiblePages.includes(263), 2_000, 'the next spread')
  })

  it('comes after the pages in tab order, and stays hidden in zen until the pointer moves', async () => {
    await boot()
    await goTo(262)
    await until(() => $(NEXT) !== null, 2_000, 'the zone')
    const stage = $('[data-qd-stage]') as HTMLElement
    expect(
      stage.compareDocumentPosition($(NEXT) as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    ui.setZen(true)
    await settle(300)
    expect($('.zones[data-zen-hidden]')).not.toBeNull()
    const view = $('.mushaf-view') as HTMLElement
    await userEvent.hover(view, { position: { x: view.clientWidth / 2, y: 320 } })
    await settle(300)
    expect($('.zones[data-zen-hidden]')).toBeNull()
    expect(opacity(NEXT)).toBeCloseTo(0.6, 2)
    ui.setZen(false)
  })
})

describe('FlipHUD (§8.11)', () => {
  it('names the spread while flipping and fades 600 ms after the last flip', async () => {
    await boot()
    await goTo(261)
    const flip = () =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowLeft',
          code: 'ArrowLeft',
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      )
    for (let i = 0; i < 4; i++) {
      flip()
      await new Promise((resolve) => setTimeout(resolve, 75))
    }
    flushSync()
    expect(reader.flipping).toBe(true)
    await until(() => $(HUD) !== null, 1_000, 'the HUD')
    const pages = reader.visiblePages
    expect($(HUD)?.textContent).toContain(`Pages ${LRI}${pages[0]}–${pages[1]}${PDI}`)
    expect($(`${HUD} .naskh`)?.getAttribute('lang')).toBe('ar')
    // Centred in the page area (above the bar dock's reserve).
    const hud = rect(HUD)
    const view = rect('.mushaf-view')
    expect(Math.abs(hud.left + hud.width / 2 - (view.left + view.width / 2))).toBeLessThan(2)
    expect(hud.bottom).toBeLessThan(view.bottom - 84)
    const lastFlip = performance.now()
    await until(() => !reader.flipping, 1_000, 'flipping over')
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, lastFlip + 450 - performance.now())))
    flushSync()
    expect($(HUD)).not.toBeNull()
    await until(() => $(HUD) === null, 1_500, 'the HUD gone')
    expect(performance.now() - lastFlip).toBeGreaterThanOrEqual(600)
  })

  it('reads الحجر · ص ٢٦٢ · ج ١٤ in Naskh in the Arabic UI', async () => {
    await boot({ settings: { uiLanguage: 'ar', pageMode: 'single' } })
    await goTo(261)
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        repeat: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    await until(() => $(HUD) !== null, 1_000, 'the HUD')
    expect($(HUD)?.textContent?.trim()).toBe('الحجر · ص ٢٦٢ · ج ١٤')
    expect(getComputedStyle($(`${HUD} .naskh`) as HTMLElement).fontSize).toBe('18px')
  })
})

describe('DivisionChip (§8.12)', () => {
  it('greets the start of a juz on a forward turn, announces it, and leaves after 2.5 s', async () => {
    await boot()
    await goTo(279)
    reader.next()
    await until(() => $(DIVISION) !== null, 2_000, 'the chip')
    expect(reader.visiblePages).toEqual([281, 282])
    expect($(`${DIVISION} .heading`)?.textContent).toBe('بداية الجزء الخامس عشر')
    expect($(`${DIVISION} .short`)?.textContent).toBe('Juz 15')
    expect($(DIVISION)?.closest('.mv-slot')).not.toBeNull()
    await until(() => ui.announcement === 'Beginning of Juz 15', 2_000, 'the announcement')
    await until(() => $(DIVISION) === null, 3_500, 'the chip gone')
  })

  it('greets a hizb that does not open a juz, but never a jump and never twice', async () => {
    await boot()
    const hizb30 = quran.pageOfAyah('v2', quran.hizbRange(30).from)
    expect(hizb30).toBe(292)
    // A jump straight to the page: no chip.
    await goTo(291)
    await settle(300)
    expect($(DIVISION)).toBeNull()
    // Reading into it: the chip.
    await goTo(289)
    reader.next()
    await until(() => $(DIVISION) !== null, 2_000, 'the chip')
    expect($(`${DIVISION} .heading`)?.textContent).toBe('بداية الحزب الثلاثين')
    expect($(`${DIVISION} .short`)?.textContent).toBe('Hizb 30')
    await until(() => $(DIVISION) === null, 3_500, 'the chip gone')
    // Again in the same session: nothing.
    await goTo(289)
    reader.next()
    await until(() => reader.visiblePages.includes(291), 2_000, 'the turn')
    await settle(300)
    expect($(DIVISION)).toBeNull()
  })

  it('follows the recitation into a new juz, across the page turn it causes', async () => {
    await boot({ settings: { followAlong: true, uiLanguage: 'ar' } })
    const juz16 = quran.juzRange(16).from
    await goTo(quran.pageOfAyah('v2', juz16 - 1))
    player.snapshot = { ...idleSnapshot(settings.value), status: 'playing' }
    const ref = (id: number) => ({ ...quran.ayahRef(id), ayahId: id })
    player.heard = ref(juz16 - 1)
    await settle(100)
    expect($(DIVISION)).toBeNull()
    player.heard = ref(juz16)
    await until(() => $(DIVISION) !== null, 2_000, 'the chip')
    expect($(`${DIVISION} .heading`)?.textContent).toBe('بداية الجزء السادس عشر')
    // The Arabic UI shows the Arabic heading alone.
    expect($(`${DIVISION} .short`)).toBeNull()
    await until(() => ui.announcement === 'بداية الجزء السادس عشر', 2_000, 'the announcement')
  })
})

describe('HintChip (§8.11)', () => {
  it('shows once after the welcome flow, with the arrow keycaps, until "Got it"', async () => {
    await boot({ settings: { onboardingDone: true, hintsSeen: [] } })
    await goTo(262)
    await until(() => $(HINT) !== null, 3_000, 'the hint')
    const hint = $(HINT) as HTMLElement
    expect(hint.getAttribute('role')).toBe('status')
    expect(hint.closest('.mv-slot')).not.toBeNull()
    expect(hint.textContent).toContain('Scroll, swipe or press')
    const caps = [...hint.querySelectorAll('.keys kbd.cap')].map((k) => k.textContent)
    expect(caps).toEqual(['←', '→'])
    await userEvent.click(hint.querySelector('button') as HTMLElement)
    await until(() => $(HINT) === null, 2_000, 'the hint gone')
    await until(() => settings.value.hintsSeen.includes('page_turn'), 2_000, 'marked seen')
  })

  it('leaves for good when a page is turned', async () => {
    await boot({ settings: { onboardingDone: true, hintsSeen: [] } })
    await goTo(262)
    await until(() => $(HINT) !== null, 3_000, 'the hint')
    reader.next()
    await until(() => $(HINT) === null, 2_000, 'the hint gone')
    await until(() => settings.value.hintsSeen.includes('page_turn'), 2_000, 'marked seen')
  })

  it('waits for the welcome flow and never comes back once seen', async () => {
    await boot({ settings: { onboardingDone: false, hintsSeen: [] } })
    await settle(1_600)
    expect($(HINT)).toBeNull()
    resetApp()
    await boot({ settings: { onboardingDone: true, hintsSeen: ['page_turn'] } })
    await settle(1_600)
    expect($(HINT)).toBeNull()
  })
})
