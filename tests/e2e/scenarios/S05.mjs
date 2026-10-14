// @ts-check
// S05: pages 3–4 as a spread in QCF V2, sepia. The page fonts load through the fonts store (dev packs in the browser
// mock, packs in the app), so each page shows exactly one QCF rendition in its own page font at the measured glyph
// scale, with every line fitted and no font-status dot. Without the page fonts (a fresh clone) the pages show the Hafs
// fallback and the scenario asserts that instead.
import { equal, mushaf } from '../lib/index.mjs'
import { assertPage, clipAround, expectedRenditions, glyphScaleOf } from './_fonts.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'sepia',
  mode: 'both',
  settings: { mushafStyle: 'qcf_v2', pageMode: 'auto' },
  description: 'Pages 3–4 spread, qcf_v2, sepia: one QCF rendition per page in its page font, line-fit gate',
}

const PAGES = [3, 4]
/** The measured `--glyph-scale` of qcf_v2 (src/lib/mushaf/metrics.ts). */
const GLYPH_SCALE = glyphScaleOf('qcf_v2')

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s05(ctx) {
  const { qd } = ctx
  await qd.goto({ type: 'page', data: { page: 3 } })
  await qd.waitIdle()

  const state = await qd.state()
  equal(state.style, 'qcf_v2', 'the Mushaf style')
  equal(state.resolvedTheme, 'sepia', 'the resolved theme')
  equal(state.spread, true, 'a two-page spread at 1600×1000')
  equal(
    [...state.visiblePages].sort((a, b) => a - b),
    PAGES,
    'the pages on screen',
  )

  const expected = await expectedRenditions(ctx, 'qcf_v2', PAGES)
  for (const page of PAGES) {
    const want = expected.get(page)
    ctx.log(`page ${page}: page font ${want?.availability ?? 'unknown'}`)
    await assertPage(ctx, page, {
      style: 'qcf_v2',
      kind: want?.kind ?? 'fallback',
      availability: want?.availability,
      glyphScale: GLYPH_SCALE,
    })
  }

  await ctx.shot()
  await ctx.shot('spread', { clip: await clipAround(ctx, PAGES.map(mushaf.page), 16) })
}
