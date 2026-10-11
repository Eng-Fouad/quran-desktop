// @ts-check
// S03 (§12.6; WP8c): the plain look, signed off as the first-run look (LEAD 13). Pages 1–2 as a spread in the hafs style
// on paper, without the decor fonts, as an offline first run or "Ornate surah headers" off shows them (online, a first
// run now preselects the 1421 AH print with its ornaments, owner 2026-10-11): the original frame (rules, interlace band, khatam corners), the ogee-arched opening medallion with its 12 rosettes,
// the SVG surah cartouches (Al-Fātiḥah, Al-Baqarah), the Unicode basmala of Al-Baqarah, no running heads and no margin
// markers on the opening pages (as in print), and the page numbers ١ and ٢ in their footer medallions.
// Lead sign-off gate (§14.3).
import { check, equal, mushaf } from '../lib/index.mjs'
import { decorLoaded, expectFramedPage, furniture } from './_furniture.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'both',
  settings: { mushafStyle: 'hafs', pageMode: 'spread' },
  description:
    'Pages 1–2 spread, hafs, paper, no decor: frame, opening medallion, cartouches, basmala, footers',
}

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s03(ctx) {
  const { qd } = ctx
  await qd.goto({ type: 'page', data: { page: 1 } })
  await qd.waitIdle()

  const state = await qd.state()
  equal(state.style, 'hafs', 'the Mushaf style')
  equal(state.spread, true, 'a two-page spread')
  equal(state.visiblePages, [1, 2], 'the opening spread')
  equal(await ctx.page.locator(mushaf.page(1)).getAttribute('data-side'), 'right', 'page 1 on the right')

  const p1 = await furniture(ctx, 1)
  const p2 = await furniture(ctx, 2)
  for (const [n, r] of /** @type {const} */ ([
    [1, p1],
    [2, p2],
  ])) {
    expectFramedPage(r, n)
    check(r.opening, `page ${n} is an opening page`)
    check(r.medallion, `page ${n}: the opening medallion`)
    equal(r.head, null, `page ${n}: no running heads on the opening pages`)
    equal(r.markers, [], `page ${n}: no margin markers on the opening pages`)
    check(r.edges.shown && r.edges.count >= 1 && r.edges.count <= 5, `page ${n}: 1–5 page-stack hairlines`)
  }
  // Page 1 (right) has one page beneath it; page 2's outer edge carries the rest of the book.
  equal(p1.edges.count, 1, 'page 1: one hairline')
  equal(p2.edges.count, 5, 'page 2: five hairlines')

  // The fallback cartouche, narrowed to the 12.1 qfs opening line, with the surah names from core.db.
  equal(
    p1.headers.map((h) => [h.line, h.surah, h.decor]),
    [[1, 1, false]],
    'page 1: the Al-Fatihah header on line 1, no decor',
  )
  equal(
    p2.headers.map((h) => [h.line, h.surah, h.decor]),
    [[1, 2, false]],
    'page 2: the Al-Baqarah header on line 1, no decor',
  )
  for (const h of [...p1.headers, ...p2.headers]) {
    check(Math.abs(h.width - 12.1) < 0.05, `cartouche ${h.surah} is ${h.width} qfs wide, expected 12.1`)
    check(h.name.startsWith('سُورَةُ '), `cartouche ${h.surah} reads "${h.name}"`)
  }
  equal(p2.basmalas.length, 1, 'page 2: one basmala line')
  equal(p2.basmalas[0]?.decor, false, 'page 2: the Unicode basmala (no decor)')
  equal(p2.basmalas[0]?.text, 'بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ', 'page 2: the basmala text')
  check(!(await decorLoaded(ctx, 'qd-surah-header')), 'the plain look loads no decor font')

  await ctx.shot()
  await ctx.shot('spread', { selector: '.mushaf-view .stage, .spread' })
  await ctx.shot('p1', { selector: mushaf.page(1) })
  await ctx.shot('p2', { selector: mushaf.page(2) })
}
