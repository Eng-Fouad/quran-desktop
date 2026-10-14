// @ts-check
// S04: pages 1–2 as a spread in the QCF V2 style on paper. The opening medallion around the 8 lines, and, once the
// decor fonts are in (a QCF style asks for them), the QCF surah headers narrowed to the 12.1 qfs opening line and
// quran-common's basmala calligraphy on page 2. No running heads, no margin markers (as in print).
import { check, equal, mushaf } from '../lib/index.mjs'
import { expectFramedPage, furniture, waitDecor } from './_furniture.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'both',
  settings: { mushafStyle: 'qcf_v2', pageMode: 'spread' },
  description: 'Pages 1–2 spread, qcf_v2, paper: opening medallion, decor headers and basmala',
}

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s04(ctx) {
  const { qd } = ctx
  await qd.goto({ type: 'page', data: { page: 1 } })
  await qd.waitIdle()
  const decor = (await waitDecor(ctx, 'qd-surah-header')) && (await waitDecor(ctx, 'qd-quran-common'))
  await qd.waitIdle()

  const state = await qd.state()
  equal(state.style, 'qcf_v2', 'the Mushaf style')
  equal(state.visiblePages, [1, 2], 'the opening spread')

  const p1 = await furniture(ctx, 1)
  const p2 = await furniture(ctx, 2)
  for (const [n, r] of /** @type {const} */ ([
    [1, p1],
    [2, p2],
  ])) {
    expectFramedPage(r, n)
    check(r.medallion, `page ${n}: the opening medallion`)
    equal(r.head, null, `page ${n}: no running heads on the opening pages`)
    equal(r.markers, [], `page ${n}: no margin markers on the opening pages`)
  }
  equal(
    p1.headers.map((h) => [h.line, h.surah]),
    [[1, 1]],
    'page 1: the Al-Fatihah header',
  )
  equal(
    p2.headers.map((h) => [h.line, h.surah]),
    [[1, 2]],
    'page 2: the Al-Baqarah header',
  )
  equal(p2.basmalas.length, 1, 'page 2: one basmala line')
  if (decor) {
    for (const h of [...p1.headers, ...p2.headers]) {
      check(h.decor, `surah ${h.surah}: the QCF surah-header glyph once decor is loaded`)
      check(
        h.width > 11.4 && h.width <= 12.1,
        `surah ${h.surah}: header ${h.width} qfs wide, within the 12.1 qfs line`,
      )
    }
    check(p2.basmalas[0]?.decor === true, 'page 2: the decor basmala calligraphy')
  } else {
    ctx.log('decor fonts unavailable (no data/dev-packs/decor): the fallback cartouche is shown')
    for (const h of [...p1.headers, ...p2.headers])
      check(!h.decor, `surah ${h.surah}: the fallback cartouche`)
  }

  await ctx.shot()
  await ctx.shot('p1', { selector: mushaf.page(1) })
  await ctx.shot('p2', { selector: mushaf.page(2) })
}
