// @ts-check
// S09: page 50 in QCF V4 (colour tajweed, COLRv0 + CPAL), paper theme, tajweed on. The first V4 page runs the COLR
// probe and caches a positive result for this webview; the shared `@font-palette-values --qd-v4` rule names the page
// font with base palette 0 and no `override-colors` (a multi-entry override crashes Chromium's renderer); the paper ink
// is the lines' `feColorMatrix` colour map. The glyphs really draw in colour, and the drawn ink is the theme's (pixel
// checks).
import { check, equal, includes, mushaf } from '../lib/index.mjs'
import {
  assertPage,
  clipAround,
  contrast,
  expectedRenditions,
  glyphScaleOf,
  inkStats,
  paletteState,
  rgbOf,
} from './_fonts.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'both',
  settings: { mushafStyle: 'qcf_v4', tajweedColors: true, pageMode: 'single' },
  description:
    'Page 50, qcf_v4, paper, tajweed on: COLR probe, palette rule (base 0, ink colour map), colour pixels',
}

const PAGE = 50
/** The measured `--glyph-scale` of qcf_v4 (src/lib/mushaf/metrics.ts). */
const GLYPH_SCALE = glyphScaleOf('qcf_v4')

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s09(ctx) {
  const { qd } = ctx
  await qd.goto({ type: 'page', data: { page: PAGE } })
  await qd.waitIdle()

  const state = await qd.state()
  equal(state.style, 'qcf_v4', 'the Mushaf style (a failed COLR probe would have switched it to qcf_v2)')
  equal(state.resolvedTheme, 'paper', 'the resolved theme')
  equal(state.visiblePages, [PAGE], 'the page on screen')

  const want = (await expectedRenditions(ctx, 'qcf_v4', [PAGE])).get(PAGE)
  ctx.log(`page ${PAGE}: page font ${want?.availability ?? 'unknown'}`)
  await assertPage(ctx, PAGE, {
    style: 'qcf_v4',
    kind: want?.kind ?? 'fallback',
    availability: want?.availability,
    glyphScale: GLYPH_SCALE,
  })

  if (want?.kind === 'qcf') {
    const palette = await paletteState(ctx)
    ctx.log(`palette rule: ${palette.rule}`)
    equal(palette.supported, true, 'the cached COLR probe result')
    check(palette.rule.startsWith('@font-palette-values --qd-v4'), 'the #qd-v4-palettes rule exists')
    includes(palette.rule.match(/"qcf-v4-p\d+"/g) ?? [], `"qcf-v4-p${PAGE}"`, 'families named by the rule')
    equal(palette.basePalette, 0, 'base palette (tajweed, light)')
    const ink = rgbOf(palette.ink)
    check(ink, `the resolved ink ${palette.ink}`)
    check(!palette.rule.includes('override-colors'), 'the rule carries no override-colors')
    check(palette.rule.includes('filter: url(#qd-v4-ink)'), 'the rule maps the V4 lines through #qd-v4-ink')
    check(palette.matrix, `the colour map's feColorMatrix: ${palette.matrix}`)
    const line = await ctx.page
      .locator(`${mushaf.page(PAGE)} .mp-glyphs[data-rendition="qcf"] .lw`)
      .first()
      .evaluate((el) => {
        const cs = getComputedStyle(el)
        return { fontPalette: cs.fontPalette, filter: cs.filter }
      })
    equal(line.fontPalette, '--qd-v4', 'font-palette of the V4 lines')
    check(line.filter.includes('#qd-v4-ink'), `filter of the V4 lines: ${line.filter}`)

    // The glyphs are drawn in colour: tajweed rules (and the ayah markers) cover a visible share of the block.
    const stats = await inkStats(ctx, PAGE)
    ctx.log(`pixels: ${JSON.stringify(stats)}`)
    check(
      stats.chromaticPct >= 0.5,
      `colour tajweed pixels: ${stats.chromaticPct} % of the text block (≥ 0.5 %)`,
    )
    check(stats.ink && contrast(stats.ink, stats.paper) >= 7, 'the base ink is dark on the paper (≥ 7:1)')
    // The colour map takes the palette's black to the theme ink: the solid neutral pixels are the resolved ink.
    const drawn = stats.ink ?? []
    const delta = Math.max(...drawn.map((v, i) => Math.abs(v - (ink[i] ?? 0))))
    check(delta <= 8, `drawn ink ${drawn.join(' ')} vs resolved ${ink.join(' ')} (Δ ${delta} ≤ 8)`)
  }

  await ctx.shot()
  await ctx.shot('page', { clip: await clipAround(ctx, [mushaf.page(PAGE)], 16) })
}
