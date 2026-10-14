/**
 * The reader store on the browser mock: startup restore, the fit and the visible pages, turns and their navigation
 * history, cursor moves and selection, the action target, the follow-along and its chip, zoom, page and reading modes,
 * the navigation and view keys, and the reading position and history writes. jsdom has no View Transitions, so every
 * turn commits directly after its readiness wait.
 */
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { defaultSettings } from '$lib/contracts/settings'
import { api, call, initIpc } from '$lib/ipc'
import type { Bootstrap, ReadingPosition, Settings } from '$lib/ipc/bindings'
import { mockCommands } from '$lib/ipc/mock'
import { idleSnapshot, state } from '$lib/ipc/mock/state'
import { fitLayout } from '$lib/mushaf/geometry'
import { app } from './app.svelte'
import { history } from './history.svelte'
import { i18n } from './i18n.svelte'
import { resetStores } from './index'
import { player } from './player.svelte'
import { quran } from './quran.svelte'
import {
  FLASH_MS,
  HISTORY_DWELL_MS,
  nextSelection,
  POSITION_DEBOUNCE_MS,
  reader,
  spreadPages,
} from './reader.svelte'
import { settings } from './settings.svelte'
import { shortcuts } from './shortcuts.svelte'
import { translations } from './translations.svelte'
import { RAIL_W, TITLEBAR_H, ui } from './ui.svelte'

/** Text without the bidi isolates `i18n.ref` wraps references in. */
const plainText = (s: string) => s.replace(/[⁦-⁩]/gu, '')

/** The canvas at 1600 × 1000 with the sidebar open: a spread with the bar dock at qfs 26.25. */
const CANVAS: [number, number] = [1248, 960]

function stubMatchMedia(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

/** Boots the stores the reader reads on the mock's bootstrap, then the reader (`edit` changes the bootstrap). */
async function boot(
  patch: Partial<Settings> = {},
  edit: (b: Bootstrap) => Bootstrap = (b) => b,
): Promise<Bootstrap> {
  stubMatchMedia()
  localStorage.clear()
  await initIpc()
  state.resetAll()
  state.loadAll()
  state.settings.set({ ...defaultSettings(), ...patch })
  const b = edit(await call(api.appBootstrap()))
  app.init(b)
  settings.init(b)
  i18n.init(b)
  quran.init(b)
  ui.init(b)
  shortcuts.init(b)
  history.init(b)
  reader.init(b)
  reader.setViewport(...CANVAS)
  flushSync()
  return b
}

/** Lets turns (≤ 120 ms readiness wait), the mock's 2–8 ms replies and effects run. */
async function settle(ms = 200): Promise<void> {
  flushSync()
  await new Promise((resolve) => setTimeout(resolve, ms))
  flushSync()
}

/** A keydown on the window, through the shortcut listeners. */
function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const code =
    init.code ?? (/^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : key.length === 1 ? undefined : key)
  const e = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...init })
  document.body.dispatchEvent(e)
  flushSync()
  return e
}

function position(patch: Partial<ReadingPosition>): ReadingPosition {
  return { context: 'mushaf', layout: 'v2', page: 1, ayahId: 1, scrollPx: null, updatedAt: 0, ...patch }
}

afterEach(() => {
  resetStores()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('pure helpers', () => {
  it('pairs pages into spreads: [odd, odd + 1], 604 with 603', () => {
    expect(spreadPages(1, true)).toEqual([1, 2])
    expect(spreadPages(2, true)).toEqual([1, 2])
    expect(spreadPages(262, true)).toEqual([261, 262])
    expect(spreadPages(603, true)).toEqual([603, 604])
    expect(spreadPages(604, true)).toEqual([603, 604])
    expect(spreadPages(262, false)).toEqual([262])
  })

  it('selects like nextSelection in interactions.ts: the ayah, or a range from the anchor', () => {
    expect(nextSelection(null, null, 5, false)).toEqual({ fromAyahId: 5, toAyahId: 5, anchorAyahId: 5 })
    expect(nextSelection(null, 3, 5, true)).toEqual({ fromAyahId: 3, toAyahId: 5, anchorAyahId: 3 })
    const sel = { fromAyahId: 5, toAyahId: 8, anchorAyahId: 5 }
    expect(nextSelection(sel, 8, 2, true)).toEqual({ fromAyahId: 2, toAyahId: 5, anchorAyahId: 5 })
    expect(nextSelection(sel, 8, 2, false)).toEqual({ fromAyahId: 2, toAyahId: 2, anchorAyahId: 2 })
  })
})

describe('startup', () => {
  it('opens pages 1–2 on the first run, with no cursor', async () => {
    await boot()
    expect(reader.page).toBe(1)
    expect(reader.visiblePages).toEqual([1, 2])
    expect(reader.cursorAyahId).toBeNull()
    expect(reader.selection).toBeNull()
  })

  it('restores the position of the reading mode, with the cursor and no selection', async () => {
    await boot({}, (b) => ({ ...b, positions: [position({ page: 262, ayahId: 1805 })] }))
    expect(reader.page).toBe(262)
    expect(reader.visiblePages).toEqual([261, 262])
    expect(reader.cursorAyahId).toBe(1805)
    expect(reader.selection).toBeNull()
    expect(reader.actionTarget).toBe(1805)
  })

  it('maps a position saved in another layout by its ayah', async () => {
    const ayahId = 1805
    await boot({ mushafStyle: 'hafs' }, (b) => ({
      ...b,
      positions: [position({ layout: 'v1', page: 999, ayahId })],
    }))
    expect(reader.page).toBe(quran.pageOfAyah('v2', ayahId))
  })

  it('restores translation mode from the translation position', async () => {
    await boot({ readingMode: 'translation' }, (b) => ({
      ...b,
      positions: [position({ page: 3 }), position({ context: 'translation', page: 50, ayahId: 300 })],
    }))
    expect(reader.page).toBe(50)
    expect(reader.cursorAyahId).toBe(300)
  })
})

describe('fit and visible pages', () => {
  it('follows the fit acceptance table', async () => {
    await boot()
    reader.setViewport(1014, 728)
    expect([reader.spread, reader.dock, reader.qfs]).toEqual([true, 'compact', 19.75])
    reader.setViewport(784, 824)
    expect([reader.spread, reader.dock, reader.qfs]).toEqual([false, 'compact', 22.75])
    reader.setViewport(672, 660)
    expect([reader.spread, reader.qfs, reader.scrolls]).toEqual([false, 18, true])
    reader.setViewport(1868, 1040)
    expect([reader.spread, reader.dock, reader.qfs]).toEqual([true, 'side', 31.5])
  })

  it('estimates the canvas from the shell layout until MushafView measures it', async () => {
    await boot()
    reader.setViewport(0, 0)
    const sidebar = ui.sidebarOpen && !ui.sidebarOverlay ? settings.value.sidebar.widthPx : 0
    const canvas = fitLayout(innerWidth - RAIL_W - sidebar, innerHeight - TITLEBAR_H, 'auto', 100)
    expect([reader.spread, reader.dock, reader.qfs]).toEqual([canvas.spread, canvas.dock, canvas.qfs])
    ui.setZen(true)
    const zen = fitLayout(innerWidth, innerHeight, 'auto', 100)
    expect(reader.qfs).toBe(zen.qfs)
  })

  it('zooms in 10 % steps within 50–300 % and scrolls past the fit', async () => {
    await boot()
    const fit = reader.qfs
    reader.zoomIn()
    expect(settings.value.zoomPct).toBe(110)
    expect(reader.scrolls).toBe(true)
    expect(reader.qfs).toBeGreaterThan(fit)
    reader.zoomReset()
    expect(settings.value.zoomPct).toBe(100)
    expect(reader.qfs).toBe(fit)
    for (let i = 0; i < 30; i++) reader.zoomOut()
    expect(settings.value.zoomPct).toBe(50)
    reader.zoomAt(1000, 10, 20)
    expect(settings.value.zoomPct).toBe(300)
    expect(reader.takeZoomAnchor()).toEqual({ x: 10, y: 20 })
    expect(reader.takeZoomAnchor()).toBeNull()
  })

  it('keeps the cursor’s page when a spread collapses to a single page', async () => {
    await boot()
    reader.select(9)
    reader.select(10, true)
    expect(reader.visiblePages).toEqual([1, 2])
    reader.setViewport(784, 824)
    flushSync()
    expect(reader.spread).toBe(false)
    expect(reader.visiblePages).toEqual([2])
    expect(reader.actionTarget).toBe(9)
  })

  it('cycles the page mode auto → single → spread → auto', async () => {
    await boot()
    reader.cyclePageMode()
    expect(settings.value.pageMode).toBe('single')
    expect(reader.visiblePages).toEqual([1])
    reader.cyclePageMode()
    expect(settings.value.pageMode).toBe('spread')
    reader.cyclePageMode()
    expect(settings.value.pageMode).toBe('auto')
  })
})

describe('turns and navigation history', () => {
  it('turns a spread at a time and stops at the ends', async () => {
    await boot()
    reader.next()
    await settle()
    expect(reader.visiblePages).toEqual([3, 4])
    reader.prev()
    await settle()
    expect(reader.visiblePages).toEqual([1, 2])
    reader.prev()
    await settle()
    expect(reader.visiblePages).toEqual([1, 2])
    reader.goToPage(604, { push: false })
    await settle()
    expect(reader.visiblePages).toEqual([603, 604])
    reader.next()
    await settle()
    expect(reader.visiblePages).toEqual([603, 604])
  })

  it('counts quick presses on from the turn still on its way, one pending turn at most', async () => {
    await boot()
    reader.next()
    reader.next()
    reader.next()
    await settle(400)
    expect(reader.visiblePages).toEqual([7, 8])
    expect(reader.turning).toBe(false)
  })

  it('turns one page at a time in single mode', async () => {
    await boot({ pageMode: 'single' })
    reader.next()
    await settle()
    expect(reader.visiblePages).toEqual([2])
  })

  it('announces the new pages', async () => {
    await boot()
    reader.next()
    await settle()
    expect(ui.announcement).toBe('Pages 3 and 4')
  })

  it('records jumps, not sequential turns, and goes back and forward', async () => {
    await boot()
    reader.next()
    await settle()
    expect(reader.navBack).toEqual([])
    reader.goToPage(262)
    await settle()
    expect(reader.navBack).toEqual([{ page: 3, ayahId: null }])
    reader.back()
    await settle()
    expect(reader.visiblePages).toEqual([3, 4])
    expect(reader.navFwd).toEqual([{ page: 262, ayahId: null }])
    reader.forward()
    await settle()
    expect(reader.visiblePages).toEqual([261, 262])
    expect(reader.navFwd).toEqual([])
  })

  it('a manual turn clears a selection that lies entirely off the new pages', async () => {
    await boot()
    reader.select(3)
    reader.next()
    await settle()
    expect(reader.selection).toBeNull()
    expect(reader.paneFollow).toBe('audio')
  })

  it('flips on key repeat: instantly, at most one page per 70 ms, and settles', async () => {
    await boot()
    reader.flip('next')
    expect(reader.visiblePages).toEqual([3, 4])
    expect(reader.flipping).toBe(true)
    reader.flip('next')
    reader.flip('next')
    expect(reader.visiblePages).toEqual([3, 4])
    await settle(100)
    expect(reader.visiblePages).toEqual([5, 6])
    await settle(300)
    expect(reader.flipping).toBe(false)
    expect(ui.announcement).toBe('Pages 5 and 6')
  })
})

describe('jumps', () => {
  it('goes to an ayah: cursor, selection, flash, history', async () => {
    await boot()
    const before = Date.now()
    reader.goToAyah(1805, { select: true, flash: true })
    await settle()
    expect(reader.visiblePages).toEqual([261, 262])
    expect(reader.cursorAyahId).toBe(1805)
    expect(reader.selection).toEqual({ fromAyahId: 1805, toAyahId: 1805, anchorAyahId: 1805 })
    expect(reader.flash?.ayahId).toBe(1805)
    expect(reader.flash?.until).toBeGreaterThanOrEqual(before + FLASH_MS)
    expect(reader.navBack).toEqual([{ page: 1, ayahId: null }])
  })

  it('remembers the cursor of the place a jump started from', async () => {
    await boot()
    reader.select(3)
    reader.goToSurah(15)
    await settle()
    expect(reader.navBack).toEqual([{ page: 1, ayahId: 3 }])
    expect(reader.cursorAyahId).toBe(quran.surahRange(15).from)
    reader.back()
    await settle()
    expect(reader.cursorAyahId).toBe(3)
  })

  it('marks the words of a search hit', async () => {
    await boot()
    reader.goToAyah(262, { highlightWords: [3000, 3001] })
    await settle()
    expect(reader.searchHit).toEqual({ ayahId: 262, wordIds: [3000, 3001] })
  })

  it('handles deep navigation requests (tray, navigate-requested)', async () => {
    await boot()
    ui.navigate({ type: 'page', data: { page: 50 } })
    await settle()
    expect(reader.visiblePages).toEqual([49, 50])
    ui.navigate({ type: 'surah', data: { surah: 2 } })
    await settle()
    expect(reader.cursorAyahId).toBe(8)
    expect(reader.visiblePages).toEqual([1, 2])
  })

  it('selects a range jump itself and still flashes, focuses and announces its first ayah', async () => {
    await boot()
    const first = quran.ayahId(2, 255)
    const last = quran.ayahId(2, 257)
    const page = quran.pageOfAyah('v2', first)
    reader.goToAyah(first, { select: true, selectTo: last, flash: true, focus: true })
    await settle()
    expect(reader.visiblePages).toContain(page)
    expect(reader.selection).toEqual({ fromAyahId: first, toAyahId: last, anchorAyahId: first })
    expect(reader.flash?.ayahId).toBe(first)
    expect(plainText(ui.announcement)).toBe(`${quran.surahName(2)} 2:255–257, page ${page}`)
  })

  it('treats a range selected right after the call (the older form of selectTo) as part of the jump', async () => {
    await boot()
    const first = quran.ayahId(2, 255)
    const last = quran.ayahId(2, 257)
    reader.goToAyah(first, { select: true, flash: true, focus: true })
    reader.select(last, true)
    await settle()
    expect(reader.selection).toEqual({ fromAyahId: first, toAyahId: last, anchorAyahId: first })
    expect(reader.cursorAyahId).toBe(last)
    expect(reader.flash?.ayahId).toBe(first)
    expect(plainText(ui.announcement)).toContain('2:255–257')
  })

  it('a newer jump, or the cursor moved before a jump lands, cancels its flash and announcement', async () => {
    await boot()
    reader.goToAyah(quran.ayahId(2, 255), { flash: true, focus: true })
    reader.goToAyah(quran.ayahId(3, 1), { flash: true, focus: true })
    await settle()
    expect(reader.flash?.ayahId).toBe(quran.ayahId(3, 1))
    reader.flash = null
    reader.goToAyah(quran.ayahId(2, 255), { flash: true, focus: true })
    await Promise.resolve()
    await Promise.resolve()
    reader.select(quran.ayahId(2, 100))
    await settle()
    expect(reader.flash).toBeNull()
  })

  it('in translation mode follows the view without side effects', async () => {
    await boot({ readingMode: 'translation' })
    reader.select(5)
    reader.goToPage(40, { push: false, transition: false })
    flushSync()
    expect(reader.page).toBe(40)
    expect(reader.selection?.fromAyahId).toBe(5)
    expect(reader.navBack).toEqual([])
    expect(ui.announcement).toBe('')
    reader.goToAyah(300, { flash: true })
    flushSync()
    expect(reader.flash?.ayahId).toBe(300)
    expect(reader.cursorAyahId).toBe(300)
  })
})

describe('cursor and selection', () => {
  it('selects, extends and clears; the selection pins the side pane', async () => {
    await boot()
    reader.select(5)
    expect(reader.cursorAyahId).toBe(5)
    expect(reader.paneFollow).toBe('selection')
    reader.select(7, true)
    expect(reader.selection).toEqual({ fromAyahId: 5, toAyahId: 7, anchorAyahId: 5 })
    reader.followRecitation()
    expect(reader.paneFollow).toBe('audio')
    expect(reader.selection).not.toBeNull()
    reader.clearSelection()
    expect(reader.selection).toBeNull()
  })

  it('moves the cursor from the visible pages and turns the page at the edge', async () => {
    await boot()
    reader.moveCursor(1)
    await settle(20)
    expect(reader.cursorAyahId).toBe(1)
    expect(reader.selection).toEqual({ fromAyahId: 1, toAyahId: 1, anchorAyahId: 1 })
    const last = reader.visibleRange.to
    reader.cursorToEdge('last')
    expect(reader.cursorAyahId).toBe(last)
    reader.moveCursor(1)
    await settle()
    expect(reader.cursorAyahId).toBe(last + 1)
    expect(reader.isVisible(last + 1)).toBe(true)
    expect(reader.visiblePages).toEqual([3, 4])
    reader.moveCursor(1, { extend: true })
    await settle(20)
    expect(reader.selection).toEqual({ fromAyahId: last + 1, toAyahId: last + 2, anchorAyahId: last + 1 })
  })

  it('starts from the first visible ayah when the cursor is off screen', async () => {
    await boot({}, (b) => ({ ...b, positions: [position({ page: 1, ayahId: 1 })] }))
    reader.goToPage(262, { push: false })
    await settle()
    reader.moveCursor(1)
    await settle(20)
    expect(reader.cursorAyahId).toBe(reader.visibleRange.from)
  })

  it('picks the action target: visible selection, else visible cursor, else the first visible ayah', async () => {
    await boot()
    expect(reader.actionTarget).toBe(1)
    reader.cursorAyahId = 4
    expect(reader.actionTarget).toBe(4)
    reader.select(6)
    reader.select(7, true)
    expect(reader.actionTarget).toBe(6)
    reader.select(900)
    expect(reader.actionTarget).toBe(1)
  })

  it('in translation mode, a cursor outside the verses the feed shows is not the action target', async () => {
    await boot({ readingMode: 'translation' })
    // The feed (TranslationView): a scroller from y 100 to 700 and its verse rows, two of them off screen.
    const view = document.createElement('div')
    view.dataset.qdView = 'translation'
    const feed = document.createElement('div')
    feed.className = 'qd-virtual-list'
    feed.getBoundingClientRect = () => new DOMRect(0, 100, 800, 600)
    view.append(feed)
    document.body.append(view)
    onTestFinished(() => view.remove())
    const rows = (tops: Record<number, [number, number]>) => {
      feed.replaceChildren()
      for (const [id, [top, bottom]] of Object.entries(tops)) {
        const row = document.createElement('article')
        row.id = `tv-a${id}`
        row.getBoundingClientRect = () => new DOMRect(0, top, 800, bottom - top)
        feed.append(row)
      }
    }
    rows({
      288: [0, 100],
      289: [60, 140],
      290: [140, 300],
      291: [300, 500],
      292: [500, 720],
      293: [720, 900],
    })
    translations.topAyahId = 289
    await settle(50)
    expect(reader.translationRows).toEqual({ from: 289, to: 292 })

    // The cursor left behind by Mushaf mode (2:255) is far above: the verse being read is the target.
    reader.cursorAyahId = 262
    expect(reader.isVisible(262)).toBe(false)
    expect(reader.actionTarget).toBe(289)
    // A cursor on screen is the target; a selection on screen wins.
    reader.cursorAyahId = 291
    expect(reader.actionTarget).toBe(291)
    reader.select(290)
    reader.select(292, true)
    expect(reader.actionTarget).toBe(290)

    // Scrolling the feed measures it again: the selection is off screen now.
    rows({ 300: [120, 400], 301: [400, 690] })
    feed.dispatchEvent(new Event('scroll'))
    translations.topAyahId = 300
    await settle(50)
    expect(reader.translationRows).toEqual({ from: 300, to: 301 })
    expect(reader.actionTarget).toBe(300)

    // Back to the Mushaf: the pages decide again.
    await settings.update({ readingMode: 'mushaf' })
    flushSync()
    expect(reader.translationRows).toBeNull()
  })

  it('Escape clears the selection and the search hit, then dismisses the follow chip', async () => {
    await boot()
    reader.select(2)
    reader.searchHit = { ayahId: 2, wordIds: [10] }
    expect(reader.escape()).toBe(true)
    expect(reader.selection).toBeNull()
    expect(reader.searchHit).toBeNull()
    expect(reader.escape()).toBe(false)
  })
})

describe('follow-along', () => {
  /** Puts the player in a playing state at an ayah (no word timings: the ayah's first word decides). */
  function recite(surah: number, ayah: number): void {
    player.snapshot = { ...idleSnapshot(settings.value), status: 'playing' }
    player.heard = { surah, ayah, ayahId: quran.ayahId(surah, ayah) }
    flushSync()
  }

  it('turns to the recited ayah’s page', async () => {
    await boot()
    recite(2, 6)
    expect(reader.followTarget).toBe(3)
    await settle()
    expect(reader.visiblePages).toEqual([3, 4])
    expect(reader.followChip).toBe(false)
  })

  it('uses the surah’s first ayah during the basmala', async () => {
    await boot()
    player.snapshot = { ...idleSnapshot(settings.value), status: 'playing' }
    player.heard = { surah: 15, ayah: 0, ayahId: 0 }
    flushSync()
    expect(reader.followTarget).toBe(quran.pageOfAyah('v2', quran.ayahId(15, 1)))
  })

  it('holds after a manual navigation and offers the chip instead', async () => {
    await boot()
    recite(1, 1)
    reader.goToPage(50)
    await settle()
    expect(reader.followChip).toBe(true)
    recite(2, 6)
    await settle()
    expect(reader.visiblePages).toEqual([49, 50])
    expect(reader.followChip).toBe(true)
    reader.returnToRecitation()
    await settle()
    expect(reader.visiblePages).toEqual([3, 4])
    expect(reader.followChip).toBe(false)
  })

  it('dismisses the chip until the recitation reaches another page', async () => {
    await boot()
    recite(1, 1)
    reader.goToPage(50)
    await settle()
    expect(reader.followChip).toBe(true)
    reader.dismissFollowChip()
    expect(reader.followChip).toBe(false)
    reader.next()
    await settle()
    expect(reader.followChip).toBe(false)
  })

  it('does nothing with follow-along off or outside Mushaf mode', async () => {
    await boot({ followAlong: false })
    recite(2, 6)
    expect(reader.followTarget).toBeNull()
    await settle()
    expect(reader.visiblePages).toEqual([1, 2])
  })
})

describe('keys', () => {
  it('turns pages with the book arrows and Page Up/Down', async () => {
    await boot()
    press('ArrowLeft')
    await settle()
    expect(reader.visiblePages).toEqual([3, 4])
    press('PageDown')
    await settle()
    expect(reader.visiblePages).toEqual([5, 6])
    press('ArrowRight')
    await settle()
    expect(reader.visiblePages).toEqual([3, 4])
    press('PageUp')
    await settle()
    expect(reader.visiblePages).toEqual([1, 2])
  })

  it('flips on a repeated arrow', async () => {
    await boot()
    press('ArrowLeft', { repeat: true })
    expect(reader.flipping).toBe(true)
    expect(reader.visiblePages).toEqual([3, 4])
  })

  it('moves the cursor with ↓/↑ and j/k, extends with Shift, clears with Escape', async () => {
    await boot()
    press('ArrowDown')
    press('j')
    await settle(20)
    expect(reader.cursorAyahId).toBe(2)
    press('k')
    press('J', { code: 'KeyJ', shiftKey: true })
    await settle(20)
    expect(reader.selection).toEqual({ fromAyahId: 1, toAyahId: 2, anchorAyahId: 1 })
    const esc = press('Escape')
    expect(esc.defaultPrevented).toBe(true)
    expect(reader.selection).toBeNull()
  })

  it('goes to the next and the previous surah start with Shift+arrows', async () => {
    await boot()
    press('ArrowLeft', { shiftKey: true })
    await settle()
    expect(reader.cursorAyahId).toBe(quran.surahRange(3).from)
    press('ArrowRight', { shiftKey: true })
    await settle()
    expect(reader.cursorAyahId).toBe(quran.surahRange(2).from)
  })

  it('jumps to the first and last page with Mod+Home/End', async () => {
    await boot()
    press('End', { ctrlKey: true })
    await settle()
    expect(reader.visiblePages).toEqual([603, 604])
    press('Home', { ctrlKey: true })
    await settle()
    expect(reader.visiblePages).toEqual([1, 2])
  })

  it('zooms with Mod+= / Mod+- / Mod+0 and cycles the page mode with D', async () => {
    await boot()
    press('=', { code: 'Equal', ctrlKey: true })
    expect(settings.value.zoomPct).toBe(110)
    press('-', { code: 'Minus', ctrlKey: true })
    press('-', { code: 'Minus', ctrlKey: true })
    expect(settings.value.zoomPct).toBe(90)
    press('0', { code: 'Digit0', ctrlKey: true })
    expect(settings.value.zoomPct).toBe(100)
    press('d')
    expect(settings.value.pageMode).toBe('single')
  })

  it('toggles the reading mode with T, keeping the place by ayah', async () => {
    await boot()
    press('t')
    expect(settings.value.readingMode).toBe('translation')
    press('t')
    expect(settings.value.readingMode).toBe('mushaf')
  })

  it('opens Go to with Mod+G and toggles zen with Z', async () => {
    await boot()
    press('g', { ctrlKey: true })
    expect(ui.isOpen('goto')).toBe(true)
    ui.close('goto')
    press('z')
    expect(ui.zen).toBe(true)
  })

  it('asks the page rail to show with P', async () => {
    await boot()
    const before = reader.railRequest
    press('p')
    expect(reader.railRequest).toBe(before + 1)
  })

  it('registers navigation and view definitions with shortcut labels', async () => {
    await boot()
    const ids = shortcuts.defs.map((d) => d.id)
    for (const id of ['nav.nextPage', 'nav.prevAyah', 'nav.goTo', 'nav.escape', 'view.zoomIn', 'view.zen'])
      expect(ids).toContain(id)
    for (const def of shortcuts.defs) expect(def.labelKey.startsWith('shortcuts.')).toBe(true)
  })
})

describe('persistence', () => {
  it('writes the reading position 1 s after it settles, once', async () => {
    await boot({}, (b) => ({ ...b, positions: [position({ page: 1, ayahId: 1 })] }))
    const set = vi.spyOn(history, 'setPosition')
    reader.goToPage(262)
    await settle()
    expect(set).not.toHaveBeenCalled()
    await settle(POSITION_DEBOUNCE_MS)
    expect(set).toHaveBeenCalledTimes(1)
    expect(set.mock.calls[0]?.[0]).toMatchObject({ context: 'mushaf', layout: 'v2', page: 262 })
  })

  it('writes a turn made just before quitting, and the quit waits for the write', async () => {
    await boot({}, (b) => ({ ...b, positions: [position({ page: 1, ayahId: 1 })] }))
    let land!: () => void
    const set = vi
      .spyOn(history, 'setPosition')
      .mockImplementation(() => new Promise((resolve) => (land = resolve)))
    const quit = vi.spyOn(mockCommands, 'appQuit')
    reader.goToPage(262)
    await settle()
    expect(set).not.toHaveBeenCalled() // still inside the 1 s debounce
    const quitting = app.quit()
    await settle(0)
    expect(set).toHaveBeenCalledTimes(1)
    expect(set.mock.calls[0]?.[0]).toMatchObject({ context: 'mushaf', layout: 'v2', page: 262 })
    expect(quit).not.toHaveBeenCalled() // the exit waits for the write
    land()
    await quitting
    expect(quit).toHaveBeenCalledTimes(1)
    // The debounce timer was cleared: nothing is written twice.
    await settle(POSITION_DEBOUNCE_MS + 100)
    expect(set).toHaveBeenCalledTimes(1)
  })

  it('does not rewrite the restored position at startup', async () => {
    await boot({}, (b) => ({ ...b, positions: [position({ page: 262, ayahId: 1805 })] }))
    const set = vi.spyOn(history, 'setPosition')
    await settle(POSITION_DEBOUNCE_MS + 100)
    expect(set).not.toHaveBeenCalled()
  })

  it('records a page read for 3 s in the history', async () => {
    const record = vi.spyOn(history, 'record').mockResolvedValue()
    await boot()
    await settle(HISTORY_DWELL_MS + 150)
    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0]?.[0]).toMatchObject({ mode: 'read', layout: 'v2', page: 1, dwellS: 3 })
    reader.next()
    await settle()
    // Leaving the page tops up the dwell beyond what was recorded (nothing new here: 3 s were recorded).
    expect(record.mock.calls.length).toBeLessThanOrEqual(2)
  })
})
