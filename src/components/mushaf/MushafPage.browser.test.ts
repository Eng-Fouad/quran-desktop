/**
 * MushafPage in a real browser (WP8a; §8.2–§8.4, §8.15, §12.5): the §8.3 DOM, the page and line geometry in qfs units,
 * the bounded line-fit, the single-page paper shift, the inert preview mode and the mock's synthetic badge. Uses the
 * hafs style, whose page font is always ready, so `RenditionStack` (WP8b) draws its glyphs at once.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import type { PageData } from '$lib/ipc/bindings'
import { fixtures } from '$lib/ipc/mock/fixtures'
import { mushafHandlers } from '$lib/ipc/mock/handlers/mushaf'
import {
  BLOCK_OUTER,
  LH,
  OPENING_INSET,
  OPENING_TOP_LINES,
  PH,
  PW,
  SHIFT,
  TB_H,
  TB_W,
} from '$lib/mushaf/geometry'
import { memo, quran, settings } from '$lib/stores'
import MushafPage from './MushafPage.svelte'

const html = document.documentElement
const QFS = 24

beforeAll(async () => {
  html.dataset.theme = 'paper'
  html.lang = 'en'
  html.dir = 'ltr'
  quran.index = await fixtures.index()
  await document.fonts.load(`${QFS}px "qd-hafs"`)
})

afterAll(() => {
  delete html.dataset.theme
})

afterEach(() => {
  vi.restoreAllMocks()
})

const page = (n: number): Promise<PageData> => fixtures.page('hafs', n)

/** Renders a page and waits until its visible rendition has words and fitted lines. */
async function show(
  data: PageData,
  props: { side?: 'right' | 'left'; interactive?: boolean; furniture?: boolean } = {},
) {
  const side = props.side ?? (data.page % 2 === 1 ? 'right' : 'left')
  const screen = await render(MushafPage, { data, qfs: QFS, side, ...props })
  const section = screen.container.querySelector<HTMLElement>('section.mp')
  if (!section) throw new Error('no section.mp')
  await expect.poll(() => section.querySelector('.mp-glyphs .ln[style*="--fx"]') !== null).toBe(true)
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const layers = [...section.querySelectorAll<HTMLElement>('.mp-glyphs')]
  const layer = layers.at(-1)
  if (!layer) throw new Error('no .mp-glyphs')
  return { screen, section, layer, layers }
}

const near = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol

describe('MushafPage DOM (§8.3)', () => {
  it('renders the page section, the RTL text block and one rendition with every word', async () => {
    const data = await page(262)
    const { section, layer, layers } = await show(data)
    expect(section.dataset.page).toBe('262')
    expect(section.dataset.side).toBe('left')
    expect(section.dataset.style).toBe('hafs')
    expect(section.dataset.layout).toBe('v2')
    expect(section.hasAttribute('data-opening')).toBe(false)
    expect(section.getAttribute('aria-roledescription')).toBe('page')
    expect(section.getAttribute('aria-label')).toBe(
      `Page 262 · ${quran.surahName(data.info.headSurah)} · Juz 14`,
    )
    expect(section.style.getPropertyValue('--qfs')).toBe(`${QFS}px`)

    const block = section.querySelector<HTMLElement>('.mp-block')
    expect(block?.getAttribute('dir')).toBe('rtl')
    expect(block?.getAttribute('lang')).toBe('ar')
    expect(layers).toHaveLength(1)
    expect(layer.classList.contains('quran-text')).toBe(true)
    expect(layer.getAttribute('aria-hidden')).toBe('true')
    expect(layer.dataset.r).toMatch(/^\d+$/)

    const lines = [...layer.querySelectorAll<HTMLElement>(':scope > .ln')]
    expect(lines.map((l) => Number(l.dataset.l))).toEqual(data.lines.map((l) => l.line))
    expect(lines.map((l) => l.dataset.k)).toEqual(data.lines.map((l) => l.kind))
    expect(lines.map((l) => l.hasAttribute('data-c'))).toEqual(data.lines.map((l) => l.centered))

    const words = data.lines.flatMap((l) => l.words)
    const spans = [...layer.querySelectorAll<HTMLElement>('.w')]
    expect(spans.map((s) => Number(s.dataset.w))).toEqual(words.map((w) => w.id))
    expect(spans.map((s) => Number(s.dataset.a))).toEqual(words.map((w) => w.ayahId))
    expect(spans.map((s) => s.textContent)).toEqual(words.map((w) => w.glyph))
    expect(spans.filter((s) => s.classList.contains('e')).length).toBe(words.filter((w) => w.isEnd).length)
  })

  it('renders every layer for real: no wave-0 placeholder is left on the page', async () => {
    const { section } = await show(await page(262))
    expect(section.querySelectorAll('[data-placeholder]')).toHaveLength(0)
    expect(section.querySelector('.mp-block > .mp-glyphs')).not.toBeNull()
  })

  it('labels the page in the Arabic UI with Arabic-Indic digits', async () => {
    const previous = settings.value
    try {
      // No IPC here: set the store's value directly instead of a settings_set round trip.
      settings.value = { ...previous, uiLanguage: 'ar' }
      const data = await page(262)
      const { section } = await show(data)
      expect(section.getAttribute('aria-roledescription')).toBe('صفحة')
      expect(section.getAttribute('aria-label')).toBe(
        `الصفحة ٢٦٢ · سورة ${quran.surah(data.info.headSurah)?.nameAr ?? ''} · الجزء ١٤`,
      )
    } finally {
      settings.value = previous
    }
  })
})

describe('MushafPage geometry (§8.2, §8.4)', () => {
  it.each([
    [261, 'right'],
    [262, 'left'],
  ] as const)('page %i (%s): page box, text block and outer margin in qfs units', async (n, side) => {
    const { section } = await show(await page(n))
    expect(section.dataset.side).toBe(side)
    const p = section.getBoundingClientRect()
    const b = section.querySelector('.mp-block')?.getBoundingClientRect()
    if (!b) throw new Error('no block')
    expect(near(p.width, PW * QFS)).toBe(true)
    expect(near(p.height, PH * QFS)).toBe(true)
    expect(near(b.width, TB_W * QFS)).toBe(true)
    expect(near(b.height, TB_H * QFS)).toBe(true)
    expect(near(b.top - p.top, 2.85 * QFS)).toBe(true)
    const outer = side === 'right' ? p.right - b.right : b.left - p.left
    expect(near(outer, BLOCK_OUTER * QFS), `outer margin ${outer}`).toBe(true)
  })

  it('lays the 15 lines on the 1.75 qfs pitch', async () => {
    const { section, layer } = await show(await page(604))
    const block = section.querySelector('.mp-block')?.getBoundingClientRect()
    if (!block) throw new Error('no block')
    for (const ln of layer.querySelectorAll<HTMLElement>(':scope > .ln')) {
      const r = ln.getBoundingClientRect()
      const n = Number(ln.dataset.l)
      expect(near(r.top - block.top, (n - 1) * LH * QFS), `line ${n} top`).toBe(true)
      expect(near(r.height, LH * QFS), `line ${n} height`).toBe(true)
      expect(near(r.width, TB_W * QFS), `line ${n} width`).toBe(true)
    }
  })

  it('centres the 8 opening lines in the block, inset inside the medallion (pages 1–2)', async () => {
    const { section, layer } = await show(await page(1))
    expect(section.hasAttribute('data-opening')).toBe(true)
    const block = section.querySelector('.mp-block')?.getBoundingClientRect()
    if (!block) throw new Error('no block')
    const lines = [...layer.querySelectorAll<HTMLElement>(':scope > .ln')]
    expect(lines).toHaveLength(8)
    const first = lines[0]?.getBoundingClientRect()
    const last = lines.at(-1)?.getBoundingClientRect()
    if (!first || !last) throw new Error('no lines')
    expect(near(first.top - block.top, OPENING_TOP_LINES * LH * QFS)).toBe(true)
    expect(near(block.bottom - last.bottom, first.top - block.top)).toBe(true)
    expect(near(first.left - block.left, OPENING_INSET * QFS)).toBe(true)
    expect(near(block.right - first.right, OPENING_INSET * QFS)).toBe(true)
  })

  it('keeps the text block still across single-page turns: ±SHIFT on the paper (§8.10)', async () => {
    const xs: number[] = []
    for (const n of [261, 262]) {
      const { screen, section } = await show(await page(n))
      const shift = (section.dataset.side === 'right' ? 1 : -1) * SHIFT * QFS
      section.style.translate = `${shift}px 0` // what spread.css (WP8e) applies in single mode
      const b = section.querySelector('.mp-block')?.getBoundingClientRect()
      if (!b) throw new Error('no block')
      xs.push(b.left)
      await screen.unmount()
    }
    expect(Math.abs((xs[0] ?? 0) - (xs[1] ?? 1))).toBeLessThanOrEqual(0.5)
  })
})

describe('bounded line-fit (§8.4)', () => {
  it.each([1, 2, 3, 50, 77, 187, 255, 262, 377, 545, 600, 604])(
    'page %i: justified lines fill their box, centred lines are centred, never a squeeze below 0.96',
    async (n) => {
      const { layer } = await show(await page(n))
      for (const ln of layer.querySelectorAll<HTMLElement>(':scope > .ln')) {
        const lw = ln.querySelector<HTMLElement>(':scope > .lw')
        if (!lw) continue
        const fx = Number(ln.style.getPropertyValue('--fx') || '1')
        const fy = Number(ln.style.getPropertyValue('--fy') || '1')
        expect(fx).toBeLessThanOrEqual(1)
        if (fx < 0.96) expect(fy, `line ${ln.dataset.l}: uniform scale`).toBe(fx)
        else expect(fy, `line ${ln.dataset.l}: horizontal-only squeeze`).toBe(1)
        const box = ln.getBoundingClientRect()
        const words = lw.getBoundingClientRect()
        if (ln.hasAttribute('data-c')) {
          expect(
            near(words.left - box.left, box.right - words.right, 1.5),
            `line ${ln.dataset.l} centred`,
          ).toBe(true)
          expect(words.width).toBeLessThanOrEqual(box.width + 1)
        } else {
          expect(near(words.left, box.left, 1), `line ${ln.dataset.l} starts at the edge`).toBe(true)
          expect(near(words.right, box.right, 1), `line ${ln.dataset.l} ends at the edge`).toBe(true)
        }
      }
    },
  )

  it('keeps a word gap on dense Unicode lines instead of running words together', async () => {
    const { layer } = await show(await page(50))
    expect(layer.hasAttribute('data-unicode')).toBe(true)
    for (const lw of layer.querySelectorAll<HTMLElement>('.ln:not([data-c]) > .lw')) {
      const spans = [...lw.querySelectorAll<HTMLElement>('.w')].map((s) => s.getBoundingClientRect())
      for (let i = 1; i < spans.length; i++) {
        const prev = spans[i - 1]
        const cur = spans[i]
        if (!prev || !cur) continue
        // RTL: each word sits to the left of the previous one, separated by a visible gap.
        expect(prev.left - cur.right).toBeGreaterThan(QFS * 0.1)
      }
    }
  })
})

describe('MushafPage modes', () => {
  it('interactive={false} renders an inert, decorative page without highlight or a11y layers', async () => {
    const { section, layer } = await show(await page(1), { interactive: false })
    expect(section.inert).toBe(true)
    expect(section.getAttribute('aria-hidden')).toBe('true')
    expect(section.hasAttribute('aria-label')).toBe(false)
    expect(section.querySelector('.mp-hl, .mp-a11y')).toBeNull()
    expect(layer.hasAttribute('data-interactive')).toBe(false)
  })

  it('interactive pages carry the highlight and a11y layers and mark their glyph layer', async () => {
    const { section, layer } = await show(await page(1))
    expect(section.inert).toBe(false)
    expect(section.querySelector('.mp-hl')).not.toBeNull()
    expect(section.querySelector('.mp-a11y')).not.toBeNull()
    expect(layer.hasAttribute('data-interactive')).toBe(true)
  })

  it('furniture={false} leaves out the frame, heads, margins and footer', async () => {
    const furniture = '.mp-frame, .mp-head, .mp-margin, .mp-foot'
    const bare = await show(await page(3), { furniture: false })
    expect(bare.section.querySelectorAll(furniture)).toHaveLength(0)
    await bare.screen.unmount()
    const full = await show(await page(3))
    expect(full.section.querySelectorAll(furniture).length).toBeGreaterThan(0)
  })

  it('shows the synthetic badge only on pages the mock invented (§4.6)', async () => {
    const real = await show(await page(3))
    expect(real.section.querySelector('.synthetic')).toBeNull()
    await real.screen.unmount()
    const result = await mushafHandlers.mushafGetPages('hafs', [300])
    if (result.status !== 'ok' || !result.data[0]) throw new Error('no synthetic page')
    const { section } = await show(result.data[0])
    const badge = section.querySelector<HTMLElement>('.synthetic')
    expect(badge?.textContent?.trim()).toBe('Synthetic page')
    expect(badge?.title).toContain('placeholder words')
  })

  it('applies the memo class map to word spans and clears it when the session ends (§8.16)', async () => {
    const data = await page(604)
    const { layer } = await show(data)
    const hidden = new Set(
      data.lines
        .flatMap((l) => l.words)
        .filter((w) => w.ayahId === 6222)
        .map((w) => w.id),
    )
    vi.spyOn(memo, 'isHidden').mockImplementation((id: number) => hidden.has(id))
    memo.active = { from: 6222, to: 6222, mode: 'hide' }
    await expect.poll(() => layer.querySelectorAll('.w-hid').length).toBe(hidden.size)
    memo.active = null
    await expect.poll(() => layer.querySelectorAll('.w-hid').length).toBe(0)
  })

  it('records a qd:page performance measure for every render (§8.18)', async () => {
    performance.clearMeasures('qd:page')
    await show(await page(262))
    const entries = performance.getEntriesByName('qd:page', 'measure') as PerformanceMeasure[]
    expect(entries.length).toBeGreaterThanOrEqual(1)
    expect(entries.at(-1)?.detail).toMatchObject({ page: 262, style: 'hafs' })
    expect(entries.at(-1)?.duration).toBeLessThan(500)
  })
})
