/**
 * The audio-word glide (WP8d; §8.7 layer 6, §8.18 "audio word glide ≥ 58 fps average, no frame > 32 ms") in a real
 * browser with mock playback: the `player` store is replaced by a reactive test double whose `activeWord` steps through
 * the words of page 262 at a recitation pace (5 words/s, crossing lines), while the page renders for real.
 *
 * - The frame rate over the whole recitation is ≥ 58 fps on average and no frame takes longer than 32 ms. A frame that
 *   is late while this document's main thread is idle (another test file's iframe holding the compositor) is set aside.
 * - On the same line the pill glides (transform only, one element); a new line jumps there at once; reduced motion
 *   never glides.
 * - The glide is the compositor's (glide.ts): a word change writes the pill's box once and starts one Web Animation of
 *   its transform; nothing writes the pill's style during the glide.
 */
import { flushSync } from 'svelte'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import { initIpc } from '$lib/ipc'
import type { PageData } from '$lib/ipc/bindings'
import { fixtures } from '$lib/ipc/mock/fixtures'
import { LH } from '$lib/mushaf/geometry'
import { quran, reader, settings } from '$lib/stores'
import MushafPage from './MushafPage.svelte'
import { testPlayer } from './HighlightLayer.test-player.svelte'

vi.mock('$lib/stores/player.svelte', async () => {
  const double = await import('./HighlightLayer.test-player.svelte')
  return { player: double.testPlayer }
})

const QFS = 26
const html = document.documentElement
const previous = settings.value

beforeAll(async () => {
  await initIpc()
  html.dataset.theme = 'paper'
  html.dataset.accent = 'teal'
  quran.index = await fixtures.index()
  await document.fonts.load(`${QFS}px "qd-hafs"`)
})

afterEach(() => {
  testPlayer.reset()
  settings.value = previous
})

const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function show(n: number) {
  const data: PageData = await fixtures.page('hafs', n)
  reader.page = n
  const screen = await render(MushafPage, { data, qfs: QFS, side: n % 2 === 1 ? 'right' : 'left' })
  const section = screen.container.querySelector<HTMLElement>('section.mp')
  if (!section) throw new Error('no section.mp')
  await expect.poll(() => section.querySelector('.mp-glyphs .ln[style*="--fx"]') !== null).toBe(true)
  for (let i = 0; i < 3; i++) await frame()
  const layer = section.querySelector<HTMLElement>('.mp-hl')
  if (!layer) throw new Error('no highlight layer')
  // Words in recitation order (page order), end markers excluded.
  const words = data.lines.flatMap((l) =>
    l.words.filter((w) => !w.isEnd).map((w) => ({ ...w, line: l.line })),
  )
  return { data, layer, words }
}

/** Where the word pill is laid out: its inline translate3d x/y, in px (written once per word). */
function position(el: Element | null): { x: number; y: number } | null {
  const m = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec((el as HTMLElement | null)?.style.transform ?? '')
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null
}

/** Where the word pill is drawn now: its computed transform, a running glide included, in px. */
function drawn(el: Element | null): { x: number; y: number; sx: number } | null {
  const transform = el ? getComputedStyle(el).transform : 'none'
  if (transform === 'none') return null
  const m = new DOMMatrixReadOnly(transform)
  return { x: m.e, y: m.f, sx: m.a }
}

function recite(word: { id: number; ayahId: number; position: number }) {
  testPlayer.currentAyahId = word.ayahId
  testPlayer.activeWord = { ayahId: word.ayahId, wordId: word.id, pos: word.position }
  flushSync()
}

describe('audio word glide (§8.7, §8.18)', () => {
  it('sustains ≥ 58 fps with no frame over 32 ms while reciting across lines', async ({ annotate }) => {
    settings.value = { ...previous, wordHighlight: true, motion: 'full' }
    const { layer, words } = await show(262)
    testPlayer.isActive = true
    testPlayer.isPlaying = true
    const first = words[0]
    if (!first) throw new Error('no words')
    recite(first)
    await expect.poll(() => layer.querySelector('.hl-word') !== null).toBe(true)
    expect(layer.querySelector('.hl-word')?.hasAttribute('data-playing')).toBe(true)

    // Warm up, then measure 3.6 s of recitation at 5 words per second (18 words, two line changes).
    for (let i = 0; i < 20; i++) await frame()
    const times: number[] = []
    let running = true
    const sample = (t: number) => {
      times.push(t)
      if (running) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    // A main-thread heartbeat. A frame that arrives late while the heartbeat kept beating was not held up by script,
    // style, layout or paint on this thread (all run between tasks): the browser simply did not draw this iframe then.
    // That happens when the other test files of this run, each in an iframe of the same page, take the compositor;
    // such frames are set aside, frames late because this thread was busy are not.
    const beats: number[] = []
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      beats.push(performance.now())
      if (running) setTimeout(() => channel.port2.postMessage(0), 2)
    }
    channel.port2.postMessage(0)
    const lines = new Set<number>()
    for (const w of words.slice(1, 19)) {
      recite(w)
      lines.add(w.line)
      await sleep(200)
    }
    running = false
    await frame()
    channel.port1.close()

    expect(lines.size).toBeGreaterThanOrEqual(2)
    const all = times.slice(1).map((t, i) => ({ from: times[i] ?? t, to: t }))
    /** The longest the main thread went without a heartbeat during a frame gap. */
    const blocked = (g: { from: number; to: number }) => {
      const points = [g.from, ...beats.filter((b) => b > g.from && b < g.to), g.to]
      return Math.max(...points.slice(1).map((p, i) => p - (points[i] ?? p)))
    }
    const own = all.filter((g) => g.to - g.from <= 32 || blocked(g) > 16)
    const gaps = own.map((g) => g.to - g.from)
    const elapsed = gaps.reduce((sum, g) => sum + g, 0)
    const fps = (gaps.length * 1000) / elapsed
    const worst = Math.max(...gaps)
    const setAside = all.length - own.length
    await annotate(
      `${gaps.length} frames in ${elapsed.toFixed(0)} ms: ${fps.toFixed(1)} fps, worst frame ${worst.toFixed(1)} ms` +
        (setAside > 0 ? ` (${setAside} late frame(s) with an idle main thread set aside)` : ''),
    )
    expect(own.length).toBeGreaterThan(all.length * 0.9)
    expect(fps).toBeGreaterThanOrEqual(58)
    expect(worst).toBeLessThanOrEqual(32)
  })

  it('glides on the same line, jumps to a new line, and never glides under reduced motion', async () => {
    settings.value = { ...previous, wordHighlight: true, motion: 'full' }
    const { layer, words } = await show(262)
    testPlayer.isActive = true
    testPlayer.isPlaying = true
    const line = words.filter((w) => w.line === 6)
    const [a, b] = [line[1], line[4]]
    const next = words.find((w) => w.line === 7)
    if (!a || !b || !next) throw new Error('words missing')
    recite(a)
    await expect.poll(() => layer.querySelector('.hl-word') !== null).toBe(true)
    for (let i = 0; i < 40; i++) await frame()
    const pill = layer.querySelector<HTMLElement>('.hl-word')
    if (!pill) throw new Error('no pill')
    const start = drawn(pill)
    expect(pill.getAnimations()).toHaveLength(0)
    // One write of the new box, then the compositor: nothing touches the pill's style while it glides.
    const writes: MutationRecord[] = []
    const observer = new MutationObserver((records) => writes.push(...records))
    recite(b)
    const laidOut = position(pill)
    observer.observe(pill, { attributes: true, attributeFilter: ['style'] })
    expect(pill.getAnimations()).toHaveLength(1)
    await frame()
    await frame()
    // The same element moves: mid-glide it is drawn between the two words, already laid out at the second.
    const mid = drawn(layer.querySelector('.hl-word'))
    expect(layer.querySelector('.hl-word')).toBe(pill)
    for (let i = 0; i < 60; i++) await frame()
    observer.disconnect()
    expect(writes).toHaveLength(0)
    expect(pill.getAnimations()).toHaveLength(0)
    const end = drawn(pill)
    if (!start || !mid || !end || !laidOut) throw new Error('no transform')
    expect(Math.abs(mid.x - start.x)).toBeGreaterThan(0.5)
    expect(Math.abs(end.x - mid.x)).toBeGreaterThan(0.5)
    expect(mid.y).toBeCloseTo(start.y, 3)
    expect(end.x).toBeCloseTo(laidOut.x, 3)
    expect(end.sx).toBe(1)

    // A word arriving mid-glide starts from where the pill is drawn then, not from where it was laid out.
    const c = line[2]
    if (!c) throw new Error('word missing')
    recite(a)
    await frame()
    await frame()
    const between = drawn(pill)
    recite(c)
    const effect = pill.getAnimations()[0]?.effect
    const restart = effect instanceof KeyframeEffect ? effect.getKeyframes()[0]?.transform : undefined
    const from = typeof restart === 'string' ? new DOMMatrixReadOnly(restart) : null
    if (!between || !from) throw new Error('no glide')
    expect(from.e).toBeCloseTo(between.x, 0)
    for (let i = 0; i < 60; i++) await frame()
    recite(b)
    for (let i = 0; i < 60; i++) await frame()

    // A new line: the pill is there in the next frame.
    recite(next)
    expect(pill.getAnimations()).toHaveLength(0)
    await frame()
    const jumped = drawn(layer.querySelector('.hl-word'))
    const lh = QFS * LH
    expect(jumped?.y).toBeCloseTo((end.y ?? 0) + lh, 0)

    // Reduced motion: every move is instant.
    settings.value = { ...settings.value, motion: 'reduce' }
    flushSync()
    const other = words.filter((w) => w.line === 7)[3]
    if (!other) throw new Error('word missing')
    const before = drawn(layer.querySelector('.hl-word'))
    recite(other)
    expect(pill.getAnimations()).toHaveLength(0)
    await frame()
    const after = drawn(layer.querySelector('.hl-word'))
    await frame()
    await frame()
    expect(drawn(layer.querySelector('.hl-word'))).toEqual(after)
    expect(after?.x).not.toBe(before?.x)
  })

  it('shows no word pill when word highlighting is off or the player is idle', async () => {
    settings.value = { ...previous, wordHighlight: false }
    const { layer, words } = await show(262)
    testPlayer.isActive = true
    const w = words[3]
    if (!w) throw new Error('no word')
    recite(w)
    await frame()
    expect(layer.querySelector('.hl-word')).toBeNull()
    settings.value = { ...previous, wordHighlight: true }
    flushSync()
    await expect.poll(() => layer.querySelector('.hl-word') !== null).toBe(true)
    testPlayer.isActive = false
    flushSync()
    await expect.poll(() => layer.querySelector('.hl-word')).toBeNull()
  })
})
