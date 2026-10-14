/**
 * MushafPage under a simulated font swap: `RenditionStack` is replaced by a double that stacks GlyphLayers. A second
 * rendition in another font is mounted at opacity 0, fitted, cross-faded in, and the first one is removed. Nothing on
 * the page may move: no `layout-shift` entry, and the page, block and line boxes are identical before and after, while
 * the word boxes do change (it really was another font).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import { fixtures } from '$lib/ipc/mock/fixtures'
import { quran } from '$lib/stores'
import MushafPage from './MushafPage.svelte'
import { stack } from './MushafPage.test-stack.svelte'

vi.mock('./RenditionStack.svelte', () => import('./MushafPage.test-stack.svelte'))

const QFS = 26
const frames = (n = 2) =>
  new Promise<void>((resolve) => {
    const step = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1)))
    step(n)
  })

const rect = (el: Element | null | undefined) => {
  const r = el?.getBoundingClientRect()
  return r ? [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100) : null
}

beforeAll(async () => {
  document.documentElement.dataset.theme = 'paper'
  quran.index = await fixtures.index()
  await document.fonts.load(`${QFS}px "qd-hafs"`)
})

afterEach(() => {
  stack.renditions = []
  stack.elements = {}
  stack.measured = []
})

describe('font swap', () => {
  it('cross-fades a new rendition with zero layout shift and unchanged page, block and line boxes', async () => {
    const supportsShift = PerformanceObserver.supportedEntryTypes?.includes('layout-shift') ?? false
    const data = await fixtures.page('hafs', 262)
    stack.renditions = [{ key: 1, kind: 'fallback', family: 'qd-hafs' }]
    const screen = await render(MushafPage, { data, qfs: QFS, side: 'left' })
    const section = screen.container.querySelector<HTMLElement>('section.mp')
    if (!section) throw new Error('no section.mp')
    await expect.poll(() => stack.measured.length).toBeGreaterThan(0)
    await frames()

    // One rendition: the double's own.
    expect(section.querySelectorAll('.mp-glyphs')).toHaveLength(1)
    const before = {
      page: rect(section),
      block: rect(section.querySelector('.mp-block')),
      lines: [...section.querySelectorAll('.mp-glyphs .ln')].map(rect),
      words: [...section.querySelectorAll('.mp-glyphs .w')].map(rect),
    }

    const shifts: number[] = []
    const observer = supportsShift
      ? new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) shifts.push((entry as unknown as { value: number }).value)
        })
      : null
    observer?.observe({ type: 'layout-shift', buffered: false })

    // 1. Mount the new rendition in a different font, invisible, and let the double fit and measure it.
    stack.renditions = [...stack.renditions, { key: 2, kind: 'qcf', family: 'qd-swap-test' }]
    await expect.poll(() => stack.elements[2] != null).toBe(true)
    const next = stack.elements[2]
    const old = stack.elements[1]
    if (!next || !old) throw new Error('renditions missing')
    next.style.opacity = '0'
    await frames()
    // 2. Cross-fade, then unmount the old rendition.
    next.style.opacity = '1'
    old.style.opacity = '0'
    await frames()
    stack.renditions = stack.renditions.filter((r) => r.key === 2)
    await frames(3)
    observer?.disconnect()

    expect(section.querySelectorAll('.mp-glyphs')).toHaveLength(1)
    const after = {
      page: rect(section),
      block: rect(section.querySelector('.mp-block')),
      lines: [...section.querySelectorAll('.mp-glyphs .ln')].map(rect),
      words: [...section.querySelectorAll('.mp-glyphs .w')].map(rect),
    }
    expect(after.page).toEqual(before.page)
    expect(after.block).toEqual(before.block)
    expect(after.lines).toEqual(before.lines)
    // The swap really changed the glyphs' metrics.
    expect(after.words).not.toEqual(before.words)
    if (supportsShift) expect(shifts.reduce((a, b) => a + b, 0)).toBe(0)
    // The page forwarded the new rendition's word boxes to the highlight layer.
    expect(stack.measured.length).toBeGreaterThanOrEqual(2)
  })
})
