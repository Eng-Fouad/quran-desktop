// @ts-check
// S13: margin markers and their labels. Single pages in the hafs style on paper:
//   - 1600×1000 (qfs ≥ 28): page 176 with the sajda of 7:206 (۩ سجدة beside the line where the ayah ends), then
//     page 177 with the half of hizb 18 that 8:1 opens under its surah header and basmala: the print's label
//     «نِصۡف / الحِزۡبُ / ١٨» in the lamp (U+FC22), its box on line 3, while decor is loaded, else under the ۞.
//   - 1366×768 (qfs < 28): the same pages. The rub's marker is the same at every size (owner request 2026-10-13), so
//     the running head carries no quarter; the sajda's Hafs word needs qfs 28, so its ۩ stands alone.
import { check, equal, mushaf } from '../lib/index.mjs'
import { arabic, expectRubMarker, furniture } from './_furniture.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'both',
  settings: { mushafStyle: 'hafs', pageMode: 'single' },
  description:
    'Pages 176/177: the sajda and the half-hizb lamp with its label at 1600×1000, the same rub marker at 1366×768',
}

const SAJDA = ['sajda', 15, 'سجدة']
const RUB = ['rub', 3, `نصف\nالحزب ${arabic(18)}`]

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s13(ctx) {
  const { qd } = ctx

  // Large: the sajda's word under its ۩.
  await qd.goto({ type: 'page', data: { page: 176 } })
  await qd.waitIdle()
  let state = await qd.state()
  check(state.qfs >= 28, `qfs ${state.qfs} at 1600×1000: the sajda's word drawn`)
  const p176 = await furniture(ctx, 176)
  equal(
    p176.markers.map((m) => [m.kind, m.line, m.label]),
    [SAJDA],
    'page 176: the sajda marker of 7:206 on line 15, labelled',
  )
  equal(p176.markers[0]?.glyph, '۩', 'page 176: the ۩ glyph')
  equal(p176.head?.juz, `الجزء ${arabic(9)}`, 'page 176: the juz head, no rub starts here')
  await ctx.shot()
  await ctx.shot('176', { selector: mushaf.page(176) })

  await qd.goto({ type: 'page', data: { page: 177 } })
  await qd.waitIdle()
  const p177 = await furniture(ctx, 177)
  equal(
    p177.markers.map((m) => [m.kind, m.line, m.label]),
    [RUB],
    'page 177: the half-hizb 18 marker of 8:1 on line 3, labelled',
  )
  expectRubMarker(p177.markers[0], 'quarter', 'page 177')
  ctx.log(`page 177: ${p177.markers[0]?.ornament ? 'the lamp (decor loaded)' : 'the ۞ (no decor)'}`)
  await ctx.shot('177', { selector: mushaf.page(177) })

  // Small: the same rub marker and label; the sajda's ۩ alone.
  await ctx.page.setViewportSize({ width: 1366, height: 768 })
  await ctx.wait(300)
  await qd.waitIdle()
  state = await qd.state()
  check(state.qfs < 28, `qfs ${state.qfs} at 1366×768: below the Hafs words' size`)
  const small177 = await furniture(ctx, 177)
  equal(
    small177.markers.map((m) => [m.kind, m.line, m.label]),
    [RUB],
    'page 177 at 1366×768: the marker keeps its label',
  )
  expectRubMarker(small177.markers[0], 'quarter', 'page 177 at 1366×768')
  equal(
    small177.markers[0]?.ornament,
    p177.markers[0]?.ornament,
    'page 177 at 1366×768: the same glyph as at 1600×1000',
  )
  equal(
    small177.head?.juz,
    `الجزء ${arabic(9)}`,
    'page 177 at 1366×768: no quarter in the running head, the margin names it',
  )
  await ctx.shot('1366')
  await ctx.shot('1366-177', { selector: mushaf.page(177) })

  await qd.goto({ type: 'page', data: { page: 176 } })
  await qd.waitIdle()
  const small176 = await furniture(ctx, 176)
  equal(
    small176.markers.map((m) => [m.kind, m.line, m.label]),
    [[SAJDA[0], SAJDA[1], '']],
    'page 176 at 1366×768: the sajda glyph alone',
  )
  await ctx.shot('1366-176', { selector: mushaf.page(176) })
}
