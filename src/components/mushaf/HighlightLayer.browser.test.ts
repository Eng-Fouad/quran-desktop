/**
 * HighlightLayer and A11yLayer (WP8d; §8.7, §8.15, §12.5) in a real browser, inside a real MushafPage on the browser
 * mock (fixture pages, the mock's user library):
 * - user highlights draw as ayah pills in their colours, with exactly one fill under every word;
 * - pills sit on the line band (line top + 0.12·LH, 0.76·LH tall) and span the words they cover;
 * - the selection draws its ring and fill, and a user highlight under it becomes a bar (one fill per word);
 * - hover (only with `hoverHighlight`), the search hit (word pills, underline, arrival pulse), the audio ayah, the
 *   arrival flash and the reading cursor's ring (keyboard focus on a roving item only);
 * - the spoken ayah list: one item per ayah segment, its speech text, the UI-language context, the roving tab stop.
 */
import { flushSync } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import { initIpc } from '$lib/ipc'
import type { AudioSnapshot, Highlight, PageData } from '$lib/ipc/bindings'
import { fixtures, state } from '$lib/ipc/mock'
import { idleSnapshot } from '$lib/ipc/mock/state'
import { toSpeech } from '$lib/mushaf/a11y'
import { LH } from '$lib/mushaf/geometry'
import { PILL } from '$lib/mushaf/layout'
import { player, quran, reader, settings } from '$lib/stores'
import MushafPage from './MushafPage.svelte'

const html = document.documentElement
const QFS = 24
const lh = QFS * LH

beforeAll(async () => {
  await initIpc()
  html.dataset.theme = 'paper'
  html.dataset.accent = 'teal'
  html.lang = 'en'
  html.dir = 'ltr'
  quran.index = await fixtures.index()
  await document.fonts.load(`${QFS}px "qd-hafs"`)
})

const previousSettings = settings.value

beforeEach(() => {
  state.user.update((u) => {
    u.highlights = []
    u.bookmarks = []
    u.notes = []
    u.readingBookmark = null
  })
  // Hover tinting stays off unless a test is about it: the real pointer is shared by the browser test files that run
  // in parallel, and one resting over a word of this page would tint its ayah under another test's assertions.
  settings.value = { ...previousSettings, hoverHighlight: false, wordHighlight: true }
  reader.selection = null
  reader.hover = null
  reader.searchHit = null
  reader.flash = null
  reader.cursorAyahId = null
  player.snapshot = null
  player.heard = null
})

afterEach(() => {
  settings.value = previousSettings
  player.snapshot = null
  player.heard = null
})

const frames = (n = 2) =>
  new Promise<void>((resolve) => {
    const step = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1)))
    step(n)
  })

function highlight(id: string, ayahId: number, color: Highlight['color']): Highlight {
  return { id, fromAyahId: ayahId, toAyahId: ayahId, color, tagIds: [], createdAt: 0, updatedAt: 0 }
}

/** Renders an interactive page and waits until its highlight layer has word boxes. */
async function show(n: number) {
  const data: PageData = await fixtures.page('hafs', n)
  reader.page = n
  const screen = await render(MushafPage, { data, qfs: QFS, side: n % 2 === 1 ? 'right' : 'left' })
  const section = screen.container.querySelector<HTMLElement>('section.mp')
  if (!section) throw new Error('no section.mp')
  await expect.poll(() => section.querySelector('.mp-glyphs .ln[style*="--fx"]') !== null).toBe(true)
  await frames(3)
  const block = section.querySelector<HTMLElement>('.mp-block')
  const layer = section.querySelector<HTMLElement>('.mp-hl')
  const glyphs = [...section.querySelectorAll<HTMLElement>('.mp-glyphs')].at(-1)
  if (!block || !layer || !glyphs) throw new Error('page parts missing')
  return { data, section, block, layer, glyphs }
}

/** Rect of an element relative to the block, in px. */
function rel(el: Element, block: HTMLElement) {
  const b = block.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  return { x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height, right: r.right - b.left }
}

const centre = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
const inside = (p: { x: number; y: number }, r: DOMRect) =>
  p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom

/** The fills (not rings, not bars) under a word's centre. */
function fillsUnder(layer: HTMLElement, word: Element): string[] {
  const c = centre(word.getBoundingClientRect())
  return [...layer.querySelectorAll('.hl-user, .hl-selection, .hl-hover, .hl-search, .hl-audio, .hl-flash')]
    .filter((f) => inside(c, f.getBoundingClientRect()))
    .map((f) => [...f.classList].filter((k) => k !== 'hl').join('.'))
}

const words = (glyphs: HTMLElement, ayahId: number) => [...glyphs.querySelectorAll(`.w[data-a="${ayahId}"]`)]

describe('user highlights (§8.7 layer 1)', () => {
  it('draws each one in its colour, with exactly one fill under every highlighted word', async () => {
    const colors: Highlight['color'][] = ['yellow', 'green', 'blue', 'red', 'purple']
    const ayahs = [13, 15, 17, 19, 21]
    state.user.update(
      (u) => (u.highlights = ayahs.map((a, i) => highlight(`h${i}`, a, colors[i] ?? 'yellow'))),
    )
    const { layer, glyphs } = await show(3)
    await expect.poll(() => layer.querySelectorAll('.hl-user').length).toBeGreaterThanOrEqual(5)
    ayahs.forEach((a, i) => {
      for (const w of words(glyphs, a)) expect(fillsUnder(layer, w)).toEqual([`hl-user.hl-${colors[i]}`])
    })
    // Unhighlighted ayahs carry nothing.
    for (const w of words(glyphs, 14)) expect(fillsUnder(layer, w)).toEqual([])
    const bg = getComputedStyle(layer.querySelector('.hl-user.hl-yellow') ?? layer).backgroundColor
    expect(bg).toMatch(/^rgba?\(|^color\(/)
    expect(bg).not.toBe('rgba(0, 0, 0, 0)')
  })
})

describe('selection (§8.7 layer 3)', () => {
  it('rings the ayah on the line band and fills it, turning a user highlight under it into a bar', async () => {
    state.user.update((u) => (u.highlights = [highlight('h', 17, 'blue')]))
    const { layer, glyphs, block } = await show(3)
    await expect.poll(() => layer.querySelectorAll('.hl-user').length).toBeGreaterThan(0)
    reader.selection = { fromAyahId: 17, toAyahId: 17, anchorAyahId: 17 }
    flushSync()
    await frames()
    const rings = [...layer.querySelectorAll('.hl-selection-ring')]
    expect(rings.length).toBeGreaterThan(0)
    for (const ring of rings) {
      const r = rel(ring, block)
      const line = Math.floor((r.y + r.h / 2) / lh)
      expect(r.y).toBeCloseTo(line * lh + 0.12 * lh, 0)
      expect(r.h).toBeCloseTo(0.76 * lh, 0)
      expect(getComputedStyle(ring).boxShadow).toContain('inset')
    }
    for (const w of words(glyphs, 17)) {
      expect(fillsUnder(layer, w)).toEqual(['hl-selection'])
      // The word lies inside one of the rings.
      expect(rings.some((r) => inside(centre(w.getBoundingClientRect()), r.getBoundingClientRect()))).toBe(
        true,
      )
    }
    const bars = [...layer.querySelectorAll('.hl-user-bar.hl-blue')]
    expect(bars.length).toBe(rings.length)
    for (const bar of bars) {
      const r = rel(bar, block)
      expect(r.h).toBeCloseTo(PILL.userBar * QFS, 0)
      const line = Math.floor(r.y / lh)
      expect(r.y + r.h).toBeCloseTo(line * lh + 0.88 * lh, 0)
    }
    reader.selection = null
    flushSync()
    await expect.poll(() => layer.querySelectorAll('.hl-selection-ring, .hl-user-bar').length).toBe(0)
    for (const w of words(glyphs, 17)) expect(fillsUnder(layer, w)).toEqual(['hl-user.hl-blue'])
  })
})

describe('hover, search, audio, flash and the reading cursor', () => {
  it('tints the hovered ayah only while hoverHighlight is on', async () => {
    settings.value = { ...settings.value, hoverHighlight: true }
    const { layer, glyphs } = await show(262)
    reader.setHover(1811, 0)
    flushSync()
    await expect.poll(() => layer.querySelectorAll('.hl-hover').length).toBeGreaterThan(0)
    for (const w of words(glyphs, 1811)) expect(fillsUnder(layer, w)).toEqual(['hl-hover'])
    settings.value = { ...settings.value, hoverHighlight: false }
    flushSync()
    await expect.poll(() => layer.querySelectorAll('.hl-hover').length).toBe(0)
  })

  it('draws a search hit as word pills with an underline that pulse on arrival', async () => {
    const { layer, glyphs, block } = await show(262)
    const target = words(glyphs, 1811)[2]
    if (!target) throw new Error('no word')
    const wordId = Number((target as HTMLElement).dataset.w)
    reader.searchHit = { ayahId: 1811, wordIds: [wordId] }
    flushSync()
    await frames()
    const pill = layer.querySelector('.hl-search')
    const bar = layer.querySelector('.hl-search-bar')
    if (!pill || !bar) throw new Error('search shapes missing')
    const w = rel(target, block)
    const p = rel(pill, block)
    expect(p.x).toBeCloseTo(w.x - PILL.wordPad * QFS, 0)
    expect(p.w).toBeCloseTo(w.w + 2 * PILL.wordPad * QFS, 0)
    expect(getComputedStyle(pill).animationName).toBe('hl-pulse')
    expect(getComputedStyle(pill).animationIterationCount).toBe('2')
    expect(rel(bar, block).h).toBeCloseTo(PILL.searchBar * QFS, 0)
    expect(fillsUnder(layer, target)).toEqual(['hl-search'])
  })

  it('tints the recited ayah while the player is active', async () => {
    const { layer, glyphs } = await show(2)
    const base: AudioSnapshot = idleSnapshot(settings.value)
    // What the store does with an `audio-state` event (the player is not initialised here): the snapshot, and the heard
    // ayah that `currentAyahId` derives from.
    player.snapshot = { ...base, status: 'paused', currentAyahId: 9, current: { surah: 2, ayah: 2 } }
    player.heard = { surah: 2, ayah: 2, ayahId: 9 }
    flushSync()
    await expect.poll(() => layer.querySelectorAll('.hl-audio').length).toBeGreaterThan(0)
    for (const w of words(glyphs, 9)) expect(fillsUnder(layer, w)).toEqual(['hl-audio'])
    // An idle player draws nothing (stopping clears the tint after its fade).
    player.snapshot = base
    player.heard = null
    flushSync()
    await expect.poll(() => layer.querySelectorAll('.hl-audio').length).toBe(0)
  })

  it('flashes a jump target and lets it fade', async () => {
    const { layer } = await show(262)
    reader.flash = { ayahId: 1805, until: Date.now() + 300 }
    flushSync()
    await expect.poll(() => layer.querySelectorAll('.hl-flash').length).toBeGreaterThan(0)
    expect(getComputedStyle(layer.querySelector('.hl-flash') ?? layer).animationName).toBe('hl-flash')
    await expect.poll(() => layer.querySelectorAll('.hl-flash').length, { timeout: 2000 }).toBe(0)
  })

  it('rings the reading cursor only while a roving item has keyboard focus', async () => {
    const { layer, section } = await show(262)
    expect(layer.querySelectorAll('.hl-cursor-ring').length).toBe(0)
    const stop = section.querySelector<HTMLElement>('.mp-a11y li[tabindex="0"]')
    expect(stop?.dataset.ayah).toBe('1803')
    await userEvent.keyboard('{Tab}')
    await expect.poll(() => document.activeElement === stop).toBe(true)
    await expect.poll(() => layer.querySelectorAll('.hl-cursor-ring').length).toBeGreaterThan(0)
    // Focusing an item puts the reading cursor on its ayah.
    expect(reader.cursorAyahId).toBe(1803)
    stop?.blur()
    await expect.poll(() => layer.querySelectorAll('.hl-cursor-ring').length).toBe(0)
  })
})

describe('A11yLayer (§8.15)', () => {
  it('speaks every ayah segment of the page, with its reference and margin markers in the UI language', async () => {
    const { data, section } = await show(262)
    const items = [...section.querySelectorAll<HTMLElement>('ol.mp-a11y > li')]
    expect(items.map((li) => Number(li.dataset.ayah))).toEqual(data.ayahs.map((a) => a.id))
    expect(section.querySelector('ol.mp-a11y')?.getAttribute('aria-label')).toBe('Text of page 262')
    const first = items[0]
    if (!first) throw new Error('no items')
    expect(first.id).toBe('a11y-262-1803')
    expect(first.lang).toBe('ar')
    expect(first.dir).toBe('rtl')
    const words = data.lines.flatMap((l) => l.words).filter((w) => w.ayahId === 1803 && !w.isEnd)
    const span = first.querySelector('span')
    expect(first.firstChild?.textContent).toBe(`${toSpeech(words.map((w) => w.text).join(' '))} (١)`)
    expect(span?.lang).toBe('en')
    expect(span?.textContent).toBe(', Al-Hijr, ayah 1, start of Juz 14')
    // The glyph layers stay hidden from screen readers.
    for (const g of section.querySelectorAll('.mp-glyphs')) expect(g.getAttribute('aria-hidden')).toBe('true')
    // Exactly one tab stop in the page: the first ayah, while the cursor is elsewhere.
    expect(items.filter((li) => li.tabIndex === 0).map((li) => li.dataset.ayah)).toEqual(['1803'])
  })

  it('moves the tab stop to the cursor and names a sajda', async () => {
    reader.cursorAyahId = 1155
    const { section } = await show(176)
    const stops = [...section.querySelectorAll<HTMLElement>('.mp-a11y li[tabindex="0"]')]
    expect(stops.map((li) => li.dataset.ayah)).toEqual(['1155'])
    const sajda = section.querySelector('#a11y-176-1160 span')?.textContent ?? ''
    expect(sajda).toContain('place of prostration')
  })
})
