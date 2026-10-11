// @ts-check
// S13 (§12.6; WP8c): margin markers and their labels. Single pages in the hafs style on paper:
//   - 1600×1000 (qfs ≥ 28): page 176 with the sajda of 7:206 (۩ سجدة beside the line where the ayah ends), then
//     page 177 with the rub that 8:1 opens (۞ over نصف / الحزب ١٨) under its surah header and basmala; labels drawn.
//   - 1366×768 (qfs < 28): the same pages with glyph-only markers; the running head carries the quarter instead.
import { check, equal, mushaf } from '../lib/index.mjs'
import { arabic, furniture } from './_furniture.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'both',
  settings: { mushafStyle: 'hafs', pageMode: 'single' },
  description: 'Pages 176/177: sajda and rub markers with labels at 1600×1000, glyph-only at 1366×768',
}

const SAJDA = ['sajda', 15, 'سجدة']
const RUB = ['rub', 3, `نصف\nالحزب ${arabic(18)}`]

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s13(ctx) {
  const { qd } = ctx

  // Large: labels under the glyphs.
  await qd.goto({ type: 'page', data: { page: 176 } })
  await qd.waitIdle()
  let state = await qd.state()
  check(state.qfs >= 28, `qfs ${state.qfs} at 1600×1000: labels drawn`)
  const p176 = await furniture(ctx, 176)
  equal(
    p176.markers.map((m) => [m.kind, m.line, m.label]),
    [SAJDA],
    'page 176: the sajda marker of 7:206 on line 15, labelled',
  )
  equal(p176.markers[0]?.glyph, '۩', 'page 176: the ۩ glyph')
  equal(p176.head?.juz, `الجزء ${arabic(9)}`, 'page 176: the juz head, no quarter while labels are drawn')
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
  equal(p177.markers[0]?.glyph, '۞', 'page 177: the ۞ glyph')
  await ctx.shot('177', { selector: mushaf.page(177) })

  // Small: glyph-only markers, the quarter in the running head.
  await ctx.page.setViewportSize({ width: 1366, height: 768 })
  await ctx.wait(300)
  await qd.waitIdle()
  state = await qd.state()
  check(state.qfs < 28, `qfs ${state.qfs} at 1366×768: glyph-only`)
  const small177 = await furniture(ctx, 177)
  equal(
    small177.markers.map((m) => [m.kind, m.line, m.label]),
    [[RUB[0], RUB[1], '']],
    'page 177 at 1366×768: the marker without its label',
  )
  equal(
    small177.head?.juz,
    `الجزء ${arabic(9)} نصف الحزب ${arabic(18)}`,
    'page 177 at 1366×768: the running head carries the quarter',
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
