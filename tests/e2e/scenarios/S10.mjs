// @ts-check
// S10: page 50 in QCF V4, night theme, tajweed off (plain dark palette 4), at ink brightness 65 % and 100 %. The
// palette rule names the base palette only (no `override-colors`: a multi-entry override crashes Chromium's renderer);
// the lines' `feColorMatrix` colour map takes every ink entry to the theme's opaque ink, so the glyphs dim with the
// setting exactly like the other styles. Asserts the rule and the map, the drawn ink colour against the resolved ink,
// and the ink contrast on the night page at both settings.
import { check, equal, mushaf } from '../lib/index.mjs'
import {
  assertPage,
  clipAround,
  contrast,
  expectedRenditions,
  inkStats,
  paletteState,
  rgbOf,
} from './_fonts.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'night',
  mode: 'both',
  settings: { mushafStyle: 'qcf_v4', tajweedColors: false, inkBrightnessPct: 65, pageMode: 'single' },
  description: 'Page 50, qcf_v4, night, tajweed off (palette 4): the theme ink at 65 % and 100 %',
}

const PAGE = 50

/**
 * @param {import('../lib/types').ScenarioContext} ctx
 * @param {number} pct
 */
async function checkInk(ctx, pct) {
  const palette = await paletteState(ctx)
  ctx.log(`ink ${pct} %: ${palette.ink}; rule: ${palette.rule}`)
  equal(palette.basePalette, 4, 'base palette (plain, dark)')
  const ink = rgbOf(palette.ink)
  const page = rgbOf(palette.page)
  check(ink && page, `resolved ink ${palette.ink} and page ${palette.page}`)
  // The rule carries the base palette alone; the theme ink is the lines' colour map, rewritten with the brightness.
  check(!palette.rule.includes('override-colors'), `no override-colors at ${pct} %`)
  check(palette.rule.includes('filter: url(#qd-v4-ink)'), `the V4 lines take the colour map at ${pct} %`)
  check(palette.matrix, `the colour map's feColorMatrix at ${pct} %: ${palette.matrix}`)
  const ratio = contrast(ink, page)
  ctx.log(`ink contrast on the night page at ${pct} %: ${ratio.toFixed(2)}:1`)
  check(ratio >= 4.5, `ink contrast ${ratio.toFixed(2)}:1 at ${pct} % (≥ 4.5:1)`)
  // What is drawn: the solid neutral pixels of the text block are the resolved ink (± antialiasing).
  const stats = await inkStats(ctx, PAGE)
  ctx.log(`pixels at ${pct} %: ${JSON.stringify(stats)}`)
  check(stats.ink, 'ink pixels in the text block')
  const drawn = stats.ink
  const delta = Math.max(...drawn.map((v, i) => Math.abs(v - (ink[i] ?? 0))))
  check(delta <= 8, `drawn ink ${drawn.join(' ')} vs resolved ${ink.join(' ')} (Δ ${delta} ≤ 8)`)
  return ink
}

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s10(ctx) {
  const { qd } = ctx
  await qd.goto({ type: 'page', data: { page: PAGE } })
  await qd.waitIdle()

  const state = await qd.state()
  equal(state.style, 'qcf_v4', 'the Mushaf style')
  equal(state.resolvedTheme, 'night', 'the resolved theme')
  equal(state.visiblePages, [PAGE], 'the page on screen')

  const want = (await expectedRenditions(ctx, 'qcf_v4', [PAGE])).get(PAGE)
  ctx.log(`page ${PAGE}: page font ${want?.availability ?? 'unknown'}`)
  await assertPage(ctx, PAGE, {
    style: 'qcf_v4',
    kind: want?.kind ?? 'fallback',
    availability: want?.availability,
  })
  const clip = await clipAround(ctx, [mushaf.page(PAGE)], 16)

  /** @type {number[] | null} */
  let dim = null
  if (want?.kind === 'qcf') dim = await checkInk(ctx, 65)
  await ctx.shot('ink65', { clip })

  await qd.setSettings({ inkBrightnessPct: 100 })
  await qd.waitIdle()
  if (want?.kind === 'qcf') {
    const full = await checkInk(ctx, 100)
    check(
      dim !== null && (full[0] ?? 0) > (dim[0] ?? 0),
      `the ink is brighter at 100 % (${full.join(' ')}) than at 65 % (${dim?.join(' ')})`,
    )
  }
  await ctx.shot('ink100', { clip })
  await ctx.shot()
}
