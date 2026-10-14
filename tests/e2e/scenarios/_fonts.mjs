// @ts-check
// Shared checks of the font scenarios (S05, S09, S10, S11, S30): renditions, font availability, line-fit, the V4
// palette rule and pixel statistics. Not a scenario (the registry skips files starting with `_`).
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { check, equal } from '../lib/index.mjs'

/**
 * The measured `--glyph-scale` of a style, read from `src/lib/mushaf/metrics.ts` (the single source of truth, written by
 * `scripts/measure-glyph-scale.mjs --write`), so the scenarios assert the rendered value against it.
 * @param {'hafs' | 'qcf_v2' | 'qcf_v1' | 'qcf_v4'} style
 */
export function glyphScaleOf(style) {
  const source = readFileSync(new URL('../../../src/lib/mushaf/metrics.ts', import.meta.url), 'utf8')
  const marker = `  ${style}: { glyphScale: `
  const at = source.indexOf(marker)
  const value = at < 0 ? Number.NaN : Number.parseFloat(source.slice(at + marker.length))
  check(Number.isFinite(value), `no glyphScale for ${style} in src/lib/mushaf/metrics.ts`)
  return value
}

/** @typedef {import('../lib/types').ScenarioContext} ScenarioContext */

/**
 * What a page shows, read in the page: its renditions, the visible one's lines and line-fit, and the font-status dot.
 * @param {number} pageNo
 */
export function inspectPage(pageNo) {
  /** @type {string[]} */
  const problems = []
  const section = /** @type {HTMLElement | null} */ (
    document.querySelector(`section.mp[data-page="${pageNo}"]`)
  )
  if (!section)
    return {
      ok: false,
      problems: [`no section.mp for page ${pageNo}`],
      qfs: Number.NaN,
      style: null,
      layout: null,
      renditions: [],
      lines: [],
      words: 0,
      minFit: 1,
      dot: null,
    }
  const qfs = Number.parseFloat(section.style.getPropertyValue('--qfs'))
  const block = section.querySelector('.mp-block')
  const layers = /** @type {HTMLElement[]} */ ([...section.querySelectorAll('.mp-block > .mp-glyphs')])
  const renditions = layers.map((el) => ({
    kind: el.dataset.rendition ?? null,
    family: el.style.getPropertyValue('--glyph-family').trim(),
    glyphScale: Number.parseFloat(el.style.getPropertyValue('--glyph-scale')),
    centerGap: Number.parseFloat(el.style.getPropertyValue('--center-gap')),
    unicode: el.hasAttribute('data-unicode'),
    opacity: getComputedStyle(el).opacity,
  }))
  const layer = layers.at(-1)
  /** @type {{ l: number, fx: number, fy: number, centred: boolean, words: number }[]} */
  const lines = []
  let words = 0
  let emptyWords = 0
  if (layer) {
    const blockBox = block?.getBoundingClientRect()
    for (const ln of /** @type {HTMLElement[]} */ ([...layer.querySelectorAll(':scope > .ln')])) {
      const lw = /** @type {HTMLElement | null} */ (ln.querySelector(':scope > .lw'))
      if (!lw) continue
      const fx = Number.parseFloat(ln.style.getPropertyValue('--fx') || '1')
      const fy = Number.parseFloat(ln.style.getPropertyValue('--fy') || '1')
      const spans = /** @type {HTMLElement[]} */ ([...lw.querySelectorAll('.w')])
      words += spans.length
      for (const span of spans) if (span.getBoundingClientRect().width < 1) emptyWords++
      const centred = ln.hasAttribute('data-c')
      lines.push({ l: Number(ln.dataset.l), fx, fy, centred, words: spans.length })
      // Line-fit gate: never a horizontal-only squeeze below 0.96; below it the scale is uniform.
      if (fx < 0.96 && fy === 1) problems.push(`line ${ln.dataset.l}: horizontal-only squeeze ${fx}`)
      if (fy !== 1 && Math.abs(fy - fx) > 1e-4) problems.push(`line ${ln.dataset.l}: non-uniform ${fx}×${fy}`)
      // Justified lines span their line box after the fit; centred lines sit in the middle.
      const box = ln.getBoundingClientRect()
      const wordsBox = lw.getBoundingClientRect()
      if (!centred && (Math.abs(wordsBox.left - box.left) > 1 || Math.abs(wordsBox.right - box.right) > 1))
        problems.push(
          `justified line ${ln.dataset.l} spans ${wordsBox.left}–${wordsBox.right} of ${box.left}–${box.right}`,
        )
      if (centred && Math.abs(wordsBox.left - box.left - (box.right - wordsBox.right)) > 1.5)
        problems.push(`centred line ${ln.dataset.l} is off-centre`)
      if (blockBox && (box.left < blockBox.left - 0.5 || box.right > blockBox.right + 0.5))
        problems.push(`line ${ln.dataset.l} leaves the text block`)
    }
  } else problems.push('no .mp-glyphs rendition')
  if (emptyWords > 0) problems.push(`${emptyWords} word spans have no width (glyphs missing from the font?)`)
  const dotEl = /** @type {HTMLElement | null} */ (section.querySelector('.rs-dot'))
  const dot = dotEl
    ? {
        state: dotEl.dataset.state ?? null,
        label: dotEl.getAttribute('aria-label'),
        box: dotEl.getBoundingClientRect().toJSON(),
      }
    : null
  const fits = lines.map((l) => l.fx)
  return {
    ok: problems.length === 0,
    problems,
    qfs,
    style: section.dataset.style ?? null,
    layout: section.dataset.layout ?? null,
    renditions,
    lines,
    words,
    minFit: fits.length ? Math.min(...fits) : 1,
    dot,
  }
}

/**
 * What each page should show once settled: `qcf` when its page font is available, else `fallback`. Asks the same
 * command the renderer uses, so it holds in the browser mock (dev packs) and in the real app (packs).
 * @param {ScenarioContext} ctx
 * @param {'qcf_v1' | 'qcf_v2' | 'qcf_v4'} style
 * @param {number[]} pages
 * @returns {Promise<Map<number, { kind: 'qcf' | 'fallback', availability: string }>>}
 */
export async function expectedRenditions(ctx, style, pages) {
  const statuses = await ctx.qd.ipc('mushafEnsurePageFonts', style, pages, 'interactive')
  return new Map(
    statuses.map((s) => [
      s.page,
      { kind: s.availability === 'ready' ? 'qcf' : 'fallback', availability: s.availability },
    ]),
  )
}

/**
 * Browser mock only: whether the dev packs (`data/dev-packs/`, listed by `vite/dev-packs.ts` at `/__packs/index.json`)
 * hold the page font of `page` in `variant`. CI never has dev packs (they are not fetched, cached or uploaded there), so
 * a step that needs a real page font checks this first; no side effects, unlike asking `mushafEnsurePageFonts`.
 * @param {ScenarioContext} ctx
 * @param {'v1' | 'v2' | 'v4'} variant
 * @param {number} page
 * @returns {Promise<boolean>}
 */
export function devPackHasPage(ctx, variant, page) {
  return ctx.page.evaluate(
    async ({ variant, page }) => {
      try {
        const res = await fetch('/__packs/index.json', { cache: 'no-store' })
        if (!res.ok) return false
        const index = await res.json()
        return typeof index?.mushaf?.[variant]?.[String(page)]?.bytes === 'number'
      } catch {
        return false
      }
    },
    { variant, page },
  )
}

/**
 * Asserts one settled page: exactly one rendition, of the expected kind, family and metrics; the line-fit gate; and the
 * font-status dot when the page font is unavailable or failed.
 * @param {ScenarioContext} ctx
 * @param {number} pageNo
 * @param {{ style: string, kind: 'qcf' | 'fallback', availability?: string, glyphScale?: number }} expect
 */
export async function assertPage(ctx, pageNo, expect) {
  const report = await ctx.page.evaluate(inspectPage, pageNo)
  ctx.log(
    `page ${pageNo}: ${JSON.stringify({ qfs: report.qfs, renditions: report.renditions, minFit: report.minFit, dot: report.dot?.state ?? null })}`,
  )
  check(report.ok, `page ${pageNo}:\n${report.problems.join('\n')}`)
  equal(report.style, expect.style, `page ${pageNo} data-style`)
  equal(report.renditions.length, 1, `page ${pageNo}: renditions once settled`)
  const shown = report.renditions[0]
  check(shown, `page ${pageNo}: no rendition`)
  equal(shown.kind, expect.kind, `page ${pageNo}: rendition`)
  if (expect.kind === 'qcf') {
    const variant = expect.style.slice(4)
    equal(shown.family, `"qcf-${variant}-p${pageNo}"`, `page ${pageNo}: --glyph-family`)
    if (expect.glyphScale !== undefined)
      equal(shown.glyphScale, expect.glyphScale, `page ${pageNo}: --glyph-scale`)
    equal(report.dot, null, `page ${pageNo}: no font-status dot while the QCF font shows`)
  } else {
    check(shown.unicode, `page ${pageNo}: the fallback rendition is Unicode (data-unicode)`)
    check(/qd-hafs/.test(shown.family), `page ${pageNo}: the fallback draws in qd-hafs (${shown.family})`)
    if (expect.availability === 'unavailable' || expect.availability === 'failed')
      equal(report.dot?.state, expect.availability, `page ${pageNo}: font-status dot`)
  }
  return report
}

/**
 * The union of the boxes of `selectors`, padded and clipped to the viewport: a screenshot `clip`.
 * @param {ScenarioContext} ctx
 * @param {string[]} selectors
 * @param {number} [pad]
 */
export async function clipAround(ctx, selectors, pad = 24) {
  const clip = await ctx.page.evaluate(
    ({ selectors, pad }) => {
      const boxes = selectors.flatMap((s) =>
        [...document.querySelectorAll(s)].map((el) => el.getBoundingClientRect()),
      )
      if (boxes.length === 0) return null
      const left = Math.max(0, Math.min(...boxes.map((b) => b.left)) - pad)
      const top = Math.max(0, Math.min(...boxes.map((b) => b.top)) - pad)
      const right = Math.min(innerWidth, Math.max(...boxes.map((b) => b.right)) + pad)
      const bottom = Math.min(innerHeight, Math.max(...boxes.map((b) => b.bottom)) + pad)
      return {
        x: Math.round(left),
        y: Math.round(top),
        width: Math.round(right - left),
        height: Math.round(bottom - top),
      }
    },
    { selectors, pad },
  )
  check(clip && clip.width > 0 && clip.height > 0, `nothing to clip around ${selectors.join(', ')}`)
  return clip
}

/**
 * Pixel statistics of the text block of a page (a PNG of `.mp-block`): how many pixels are strongly chromatic (V4
 * tajweed and marker colours), and the drawn ink: the mean of the 10 % of neutral pixels farthest from the paper
 * colour (fully covered stroke interiors, free of antialiasing).
 * @param {ScenarioContext} ctx
 * @param {number} pageNo
 */
export async function inkStats(ctx, pageNo) {
  const buffer = await ctx.page.locator(`section.mp[data-page="${pageNo}"] .mp-block`).screenshot()
  const { data, width, height } = PNG.sync.read(buffer)
  // The paper: the most common colour.
  /** @type {Map<number, number>} */
  const counts = new Map()
  for (let i = 0; i < data.length; i += 4) {
    const key = ((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const paperKey = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
  const paper = [(paperKey >> 16) & 255, (paperKey >> 8) & 255, paperKey & 255]
  let chromatic = 0
  /** @type {{ d: number, rgb: number[] }[]} */
  const neutral = []
  for (let i = 0; i < data.length; i += 4) {
    const rgb = [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0]
    const chroma = Math.max(...rgb) - Math.min(...rgb)
    if (chroma > 60) chromatic++
    const d = rgb.reduce((sum, v, c) => sum + Math.abs(v - (paper[c] ?? 0)), 0)
    if (d > 48 && chroma < 24) neutral.push({ d, rgb })
  }
  neutral.sort((a, b) => b.d - a.d)
  const solid = neutral.slice(0, Math.max(1, Math.round(neutral.length * 0.1)))
  const ink =
    neutral.length === 0
      ? null
      : [0, 1, 2].map((c) => Math.round(solid.reduce((sum, p) => sum + (p.rgb[c] ?? 0), 0) / solid.length))
  const pixels = width * height
  return {
    pixels,
    paper,
    chromatic,
    chromaticPct: Math.round((chromatic / pixels) * 10000) / 100,
    inkPixels: neutral.length,
    ink,
  }
}

/** WCAG relative luminance of an sRGB triple. @param {number[]} rgb */
export function luminance(rgb) {
  const lin = (/** @type {number} */ c) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(rgb[0] ?? 0) + 0.7152 * lin(rgb[1] ?? 0) + 0.0722 * lin(rgb[2] ?? 0)
}

/** WCAG contrast ratio. @param {number[]} a @param {number[]} b */
export function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * The generated V4 palette rule and the resolved ink, read in the page.
 * @param {ScenarioContext} ctx
 */
export async function paletteState(ctx) {
  return ctx.page.evaluate(() => {
    const rule = document.getElementById('qd-v4-palettes')?.textContent ?? ''
    // The theme's colour map on the V4 lines (after the crash fix): `<filter id="qd-v4-ink"><feColorMatrix>`.
    const matrix =
      document.querySelector('#qd-v4-ink-svg filter#qd-v4-ink feColorMatrix')?.getAttribute('values') ?? null
    const probe = document.createElement('span')
    probe.style.color = 'var(--ink)'
    document.documentElement.append(probe)
    const ink = getComputedStyle(probe).color
    probe.remove()
    const page = getComputedStyle(document.documentElement).getPropertyValue('--surface-page').trim()
    const palette = /base-palette:\s*(\d+)/.exec(rule)?.[1]
    /** @type {boolean | null} */
    const supported = (() => {
      try {
        return JSON.parse(localStorage.getItem('qd-v4-colr-support') ?? 'null')?.supported ?? null
      } catch {
        return null
      }
    })()
    return { rule, matrix, ink, page, basePalette: palette === undefined ? null : Number(palette), supported }
  })
}

/** `rgb(…)`/`color(srgb …)` → [r, g, b]. @param {string} css */
export function rgbOf(css) {
  const rgb = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(css)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  const srgb = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(css)
  if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255].map(Math.round)
  const hex = /^#([0-9a-f]{6})$/i.exec(css.trim())
  if (hex) {
    const n = Number.parseInt(hex[1] ?? '0', 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  return null
}
