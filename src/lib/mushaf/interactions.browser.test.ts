/**
 * Word interactions (WP8d; §8.14, §8.17) in a real browser: a real interactive MushafPage (page 262, hafs) inside a
 * `<main>` canvas, driven with real pointer input (Playwright through `userEvent`) and, for the dwell rule, with
 * pointer events at exact coordinates.
 */
import { flushSync } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import MushafPage from '$components/mushaf/MushafPage.svelte'
import { initIpc } from '$lib/ipc'
import type { PageData } from '$lib/ipc/bindings'
import { fixtures } from '$lib/ipc/mock'
import { pages, player, quran, reader, settings, ui } from '$lib/stores'
import {
  ACTION_BAR_DELAY_MS,
  ACTION_BAR_EVENT,
  nextSelection,
  TOOLTIP_DWELL_MS,
  WORD_DWELL_EVENT,
  type WordDwell,
} from './interactions'

const QFS = 24
const PAGE = 262
const previous = settings.value
let data: PageData

beforeAll(async () => {
  await initIpc()
  document.documentElement.dataset.theme = 'paper'
  quran.index = await fixtures.index()
  // The page comes from the pages cache, as in the reader (the dwell reads the word's text from it).
  await pages.ensure('hafs', [PAGE])
  const cached = pages.get('hafs', PAGE)
  if (!cached) throw new Error('page 262 not cached')
  data = cached
  await document.fonts.load(`${QFS}px "qd-hafs"`)
})

/** Events the module dispatched since the test began. */
let dwells: (WordDwell | null)[] = []
let bars: boolean[] = []
const onDwell = (e: CustomEvent<WordDwell | null>) => dwells.push(e.detail)
const onBar = (e: CustomEvent<{ open: boolean }>) => bars.push(e.detail.open)

beforeEach(() => {
  settings.value = {
    ...previous,
    wbwTooltip: true,
    wbwPackId: 'wbw.en',
    ayahActionBar: true,
    hoverHighlight: true,
  }
  reader.selection = null
  reader.hover = null
  reader.cursorAyahId = null
  reader.page = PAGE
  ui.contextMenu = null
  dwells = []
  bars = []
  window.addEventListener(WORD_DWELL_EVENT, onDwell)
  window.addEventListener(ACTION_BAR_EVENT, onBar)
})

afterEach(() => {
  window.removeEventListener(WORD_DWELL_EVENT, onDwell)
  window.removeEventListener(ACTION_BAR_EVENT, onBar)
  settings.value = previous
  vi.restoreAllMocks()
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function show() {
  const main = document.createElement('main')
  document.body.append(main)
  await render(MushafPage, { target: main, props: { data, qfs: QFS, side: 'left' } })
  const section = main.querySelector<HTMLElement>('section.mp')
  if (!section) throw new Error('no page')
  await expect
    .poll(() => section.querySelector('.mp-glyphs[data-interactive] .ln[style*="--fx"]') !== null)
    .toBe(true)
  const glyphs = [...section.querySelectorAll<HTMLElement>('.mp-glyphs')].at(-1)
  if (!glyphs) throw new Error('no rendition')
  const word = (ayahId: number, nth = 1) => {
    const w = glyphs.querySelectorAll<HTMLElement>(`.w[data-a="${ayahId}"]:not(.e)`)[nth]
    if (!w) throw new Error(`no word ${nth} of ayah ${ayahId}`)
    return w
  }
  const end = (ayahId: number) => {
    const w = glyphs.querySelector<HTMLElement>(`.w.e[data-a="${ayahId}"]`)
    if (!w) throw new Error(`no end marker of ${ayahId}`)
    return w
  }
  return { main, section, glyphs, word, end }
}

/** A pointer move to an element's centre plus an offset, as the browser reports it. */
function move(el: HTMLElement, dx = 0, dy = 0, type: 'pointermove' | 'pointerover' = 'pointermove') {
  const r = el.getBoundingClientRect()
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      clientX: r.left + r.width / 2 + dx,
      clientY: r.top + r.height / 2 + dy,
      pointerType: 'mouse',
      isPrimary: true,
    }),
  )
}

describe('nextSelection (§8.15)', () => {
  it('selects one ayah, or extends from the anchor (else the cursor) in either direction', () => {
    expect(nextSelection(null, null, 5, false)).toEqual({ fromAyahId: 5, toAyahId: 5, anchorAyahId: 5 })
    const sel = { fromAyahId: 5, toAyahId: 5, anchorAyahId: 5 }
    expect(nextSelection(sel, 5, 9, true)).toEqual({ fromAyahId: 5, toAyahId: 9, anchorAyahId: 5 })
    expect(nextSelection(sel, 5, 2, true)).toEqual({ fromAyahId: 2, toAyahId: 5, anchorAyahId: 5 })
    expect(nextSelection(null, 7, 3, true)).toEqual({ fromAyahId: 3, toAyahId: 7, anchorAyahId: 7 })
    expect(nextSelection(sel, 5, 9, false)).toEqual({ fromAyahId: 9, toAyahId: 9, anchorAyahId: 9 })
  })
})

describe('hover and the WBW dwell rule (§8.17)', () => {
  it('sets the hover and shows the tooltip 450 ms after a move of 4 px or more onto a word', async () => {
    const { word, glyphs } = await show()
    const w = word(1811, 2)
    move(w, 30, 0)
    move(w, 0, 0)
    flushSync()
    expect(reader.hover).toEqual({ ayahId: 1811, wordId: Number(w.dataset.w) })
    await sleep(TOOLTIP_DWELL_MS - 150)
    expect(dwells).toEqual([])
    await expect.poll(() => dwells.length, { timeout: 1000 }).toBe(1)
    const shown = dwells[0]
    expect(shown?.wordId).toBe(Number(w.dataset.w))
    expect(shown?.ayahId).toBe(1811)
    expect(shown?.text).toBe(data.lines.flatMap((l) => l.words).find((x) => x.id === shown?.wordId)?.text)
    const r = w.getBoundingClientRect()
    expect(shown?.anchor.left).toBeCloseTo(r.left - 0.1 * QFS, 0)
    expect(shown?.anchor.right).toBeCloseTo(r.right + 0.1 * QFS, 0)
    // Leaving the rendition hides the tooltip and clears the hover.
    glyphs.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }))
    flushSync()
    expect(dwells.at(-1)).toBeNull()
    expect(reader.hover).toBeNull()
  })

  it('never shows it for a parked pointer, a still-travelling pointer, an end marker, or with WBW off', async () => {
    const { word, end } = await show()
    // Parked: the word changes under a pointer that does not move (a synthetic move at the same position).
    const w = word(1812, 1)
    move(w, 0, 0)
    move(w, 0, 0)
    await sleep(TOOLTIP_DWELL_MS + 150)
    expect(dwells).toEqual([])
    // Travelling across a word: each 4 px move restarts the rest.
    const v = word(1813, 1)
    move(v, -12, 0)
    for (let i = 0; i < 6; i++) {
      move(v, -12 + 5 * (i + 1), 0)
      await sleep(TOOLTIP_DWELL_MS / 3)
    }
    expect(dwells).toEqual([])
    // An end marker has no word-by-word entry.
    const e = end(1813)
    move(e, 20, 0)
    move(e, 0, 0)
    await sleep(TOOLTIP_DWELL_MS + 150)
    expect(dwells).toEqual([])
    // WBW off.
    settings.value = { ...settings.value, wbwTooltip: false }
    const u = word(1814, 1)
    move(u, 20, 0)
    move(u, 0, 0)
    await sleep(TOOLTIP_DWELL_MS + 150)
    expect(dwells).toEqual([])
  })

  it('hides on any keydown and stays hidden while the pointer stays parked', async () => {
    const { word } = await show()
    const w = word(1811, 3)
    move(w, 25, 0)
    move(w, 0, 0)
    await expect.poll(() => dwells.length, { timeout: 1500 }).toBe(1)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }))
    expect(dwells.at(-1)).toBeNull()
    move(w, 0, 0)
    await sleep(TOOLTIP_DWELL_MS + 150)
    expect(dwells.filter((d) => d !== null)).toHaveLength(1)
    // Moving again brings it back.
    move(w, 6, 0)
    await expect.poll(() => dwells.filter((d) => d !== null).length, { timeout: 1500 }).toBe(2)
  })
})

describe('clicks (§8.17, D26)', () => {
  it('selects the ayah, moves the cursor and asks for the action bar 120 ms later', async () => {
    const { word } = await show()
    await userEvent.click(word(1811, 2))
    expect(reader.selection).toEqual({ fromAyahId: 1811, toAyahId: 1811, anchorAyahId: 1811 })
    expect(reader.cursorAyahId).toBe(1811)
    expect(bars).toEqual([])
    await sleep(ACTION_BAR_DELAY_MS + 60)
    expect(bars).toEqual([true])
  })

  it('never asks for the action bar with the setting off', async () => {
    settings.value = { ...settings.value, ayahActionBar: false }
    const { word } = await show()
    await userEvent.click(word(1811, 2))
    await sleep(ACTION_BAR_DELAY_MS + 60)
    expect(bars).toEqual([])
    expect(reader.selection?.fromAyahId).toBe(1811)
  })

  it('extends the selection with Shift+click', async () => {
    const { word } = await show()
    await userEvent.click(word(1806, 1))
    await userEvent.click(word(1809, 1), { modifiers: ['Shift'] })
    expect(reader.selection).toEqual({ fromAyahId: 1806, toAyahId: 1809, anchorAyahId: 1806 })
    // Shift+click never extends a native text selection over the glyphs.
    expect(window.getSelection()?.isCollapsed ?? true).toBe(true)
  })

  it('opens the side pane on Translation for a double-click, without a native word selection', async () => {
    const pane = vi.spyOn(ui, 'openSidePane').mockImplementation(() => undefined)
    const { word } = await show()
    await userEvent.dblClick(word(1810, 1))
    expect(pane).toHaveBeenCalledWith('translation')
    expect(reader.selection?.fromAyahId).toBe(1810)
    expect(window.getSelection()?.toString() ?? '').toBe('')
    await sleep(ACTION_BAR_DELAY_MS + 60)
    expect(bars.at(-1)).toBe(false)
  })

  it('opens the tafsir for a click on the end-of-ayah marker', async () => {
    const pane = vi.spyOn(ui, 'openSidePane').mockImplementation(() => undefined)
    const { end } = await show()
    await userEvent.click(end(1808))
    expect(pane).toHaveBeenCalledWith('tafsir')
    expect(reader.selection?.fromAyahId).toBe(1808)
  })

  it('plays from the ayah with Mod+click (and Alt+click off Linux), selecting nothing', async () => {
    const play = vi.spyOn(player, 'playFrom').mockResolvedValue(undefined)
    const { word } = await show()
    await userEvent.click(word(1812, 1), { modifiers: ['ControlOrMeta'] })
    expect(play).toHaveBeenCalledWith({ ayahId: 1812 })
    expect(reader.selection).toBeNull()
    await userEvent.click(word(1813, 1), { modifiers: ['Alt'] })
    expect(play).toHaveBeenLastCalledWith({ ayahId: 1813 })
  })

  it('opens the ayah context menu at the pointer for a right-click', async () => {
    const { word } = await show()
    const w = word(1814, 1)
    await userEvent.click(w, { button: 'right' })
    expect(ui.contextMenu?.ayahId).toBe(1814)
    expect(ui.contextMenu?.wordId).toBe(Number(w.dataset.w))
    ui.contextMenu = null
  })

  it('clears the selection for a click on empty paper or canvas, not for a click on a word', async () => {
    const { word, main, section } = await show()
    await userEvent.click(word(1811, 2))
    expect(reader.selection).not.toBeNull()
    const paper = section.querySelector<HTMLElement>('.mp-paper')
    if (!paper) throw new Error('no paper')
    await userEvent.click(paper, { position: { x: 4, y: 4 } })
    expect(reader.selection).toBeNull()
    expect(bars.at(-1)).toBe(false)
    await userEvent.click(word(1811, 2))
    await userEvent.click(main, { position: { x: 2, y: 2 } })
    expect(reader.selection).toBeNull()
  })

  it('cancels the native selection of a double-click inside the glyphs (§8.14)', async () => {
    const { word } = await show()
    const w = word(1811, 1)
    const e = new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 2, button: 0 })
    w.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    const single = new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 1, button: 0 })
    w.dispatchEvent(single)
    expect(single.defaultPrevented).toBe(false)
  })
})
