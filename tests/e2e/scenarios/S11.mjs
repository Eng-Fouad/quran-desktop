// @ts-check
// S11: page 600 in QCF V1 (the 1405H layout, whose line breaks differ from V2), sepia, single page, plus the line-fit
// gate: no rendered line is squeezed horizontally below 0.96 (below that the scale is uniform), every justified line
// spans its line box and every centred line sits in the middle. The gate runs on page 600 in V1 and then on a sweep
// of 50 pages in the hafs style (Unicode text, the densest lines). The hafs style is fitted per spread
// (src/lib/mushaf/unicodeFit.ts): every page of the sweep draws between the measured floor and the cap, and in spread
// mode both pages of a spread share one scale (the opening pages keep the floor).
import { readFileSync } from 'node:fs'
import { check, equal, mushaf } from '../lib/index.mjs'
import { assertPage, clipAround, expectedRenditions, glyphScaleOf, inspectPage } from './_fonts.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'sepia',
  mode: 'both',
  settings: { mushafStyle: 'qcf_v1', pageMode: 'single' },
  timeout: 240_000,
  description: 'Page 600, qcf_v1, sepia (V1 layout) + the line-fit gate, and a hafs sweep of 50 pages',
}

const PAGE = 600
/** The measured `--glyph-scale` of qcf_v1 (src/lib/mushaf/metrics.ts). */
const GLYPH_SCALE = glyphScaleOf('qcf_v1')
/** The per-spread fit's bounds: the floor is the measured hafs scale, the cap `UNICODE_FIT.max` (unicodeFit.ts). */
const HAFS_FLOOR = glyphScaleOf('hafs')
const HAFS_CAP = Number(
  /\bmax:\s*([\d.]+)/.exec(
    readFileSync(new URL('../../../src/lib/mushaf/unicodeFit.ts', import.meta.url), 'utf8'),
  )?.[1],
)
/** @type {[number, number][]} Spreads whose two pages carry real text in the mock’s fixtures too (right page first). */
const SPREADS = [
  [1, 2],
  [255, 256],
  [261, 262],
  [601, 602],
  [603, 604],
]
/** 50 pages spread over the whole Mushaf (every 12th page from 3, plus the last page). */
const SPREAD_OUT = [...Array.from({ length: 49 }, (_, i) => 3 + i * 12), 604]

/**
 * The sweep: in the real app any 50 pages carry real text; in the browser mock only the exported fixture pages do
 * (the others are synthetic placeholder words), so the sweep takes those first and fills up to 50.
 * @param {import('../lib/types').ScenarioContext} ctx
 */
async function sweepPages(ctx) {
  if (ctx.mode !== 'web') return SPREAD_OUT
  const fixturePages = await ctx.page.evaluate(async () => {
    const mock =
      /** @type {{ __QD_MOCK__?: { fixtures: { manifest(): Promise<{ pages?: number[] } | null> } } }} */ (
        /** @type {unknown} */ (window)
      ).__QD_MOCK__
    return (await mock?.fixtures.manifest())?.pages ?? []
  })
  const pages = [...new Set(fixturePages)].slice(0, 50)
  for (const p of SPREAD_OUT) if (pages.length < 50 && !pages.includes(p)) pages.push(p)
  return pages.sort((a, b) => a - b)
}

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s11(ctx) {
  const { qd } = ctx
  await qd.goto({ type: 'page', data: { page: PAGE } })
  await qd.waitIdle()

  const state = await qd.state()
  equal(state.style, 'qcf_v1', 'the Mushaf style')
  equal(state.layout, 'v1', 'the layout of qcf_v1')
  equal(state.resolvedTheme, 'sepia', 'the resolved theme')
  equal(state.visiblePages, [PAGE], 'single-page mode')

  const want = (await expectedRenditions(ctx, 'qcf_v1', [PAGE])).get(PAGE)
  ctx.log(`page ${PAGE}: page font ${want?.availability ?? 'unknown'}`)
  const report = await assertPage(ctx, PAGE, {
    style: 'qcf_v1',
    kind: want?.kind ?? 'fallback',
    availability: want?.availability,
    glyphScale: want?.kind === 'qcf' ? GLYPH_SCALE : undefined,
  })
  equal(report.layout, 'v1', 'data-layout of page 600')
  const squeezed = report.lines.filter((l) => l.fx < 1)
  ctx.log(
    `page ${PAGE} (V1): ${report.lines.length} ayah lines, ${squeezed.length} squeezed, min fit ${report.minFit}`,
  )
  if (want?.kind === 'qcf')
    check(report.minFit >= 0.96, `V1 page ${PAGE}: min fit ${report.minFit} (≥ 0.96 expected)`)

  await ctx.shot()
  await ctx.shot('page', { clip: await clipAround(ctx, [mushaf.page(PAGE)], 16) })

  // The hafs sweep: the same gate on 50 pages of Unicode text (allowed to scale uniformly, never to squash).
  await qd.setSettings({ mushafStyle: 'hafs' })
  await qd.waitIdle()
  const sweep = await sweepPages(ctx)
  equal(sweep.length, 50, 'pages in the hafs sweep')
  check(HAFS_CAP > HAFS_FLOOR, `the per-spread fit's bounds (${HAFS_FLOOR}–${HAFS_CAP})`)
  let lines = 0
  let uniform = 0
  let minFit = 1
  /** @type {Map<number, number>} */
  const scales = new Map()
  for (const page of sweep) {
    await qd.goto({ type: 'page', data: { page } })
    const r = await ctx.page.evaluate(inspectPage, page)
    check(r.ok, `hafs page ${page}:\n${r.problems.join('\n')}`)
    equal(r.renditions.length, 1, `hafs page ${page}: renditions`)
    const scale = r.renditions[0]?.glyphScale ?? Number.NaN
    check(
      scale >= HAFS_FLOOR && scale <= HAFS_CAP,
      `hafs page ${page}: --glyph-scale ${scale} within ${HAFS_FLOOR}–${HAFS_CAP}`,
    )
    scales.set(scale, (scales.get(scale) ?? 0) + 1)
    lines += r.lines.length
    uniform += r.lines.filter((l) => l.fy !== 1).length
    minFit = Math.min(minFit, r.minFit)
  }
  const histogram = [...scales]
    .sort((a, b) => a[0] - b[0])
    .map(([scale, n]) => `${scale}×${n}`)
    .join(' ')
  ctx.log(
    `hafs sweep: ${sweep.length} pages, ${lines} ayah lines, ${uniform} scaled uniformly, min fit ${minFit}; ` +
      `scales ${histogram}`,
  )
  check(lines > sweep.length * 8, `the sweep measured ayah lines (${lines})`)

  // Spread mode: the facing pages share one scale, the one of their widest line (the opening pages keep the floor).
  await qd.setSettings({ pageMode: 'spread' })
  await qd.waitIdle()
  for (const [right, left] of SPREADS) {
    await qd.goto({ type: 'page', data: { page: right } })
    await qd.waitIdle()
    const [a = Number.NaN, b = Number.NaN] = await ctx.page.evaluate(
      (pages) =>
        pages.map((p) => {
          const layers = document.querySelectorAll(`section.mp[data-page="${p}"] .mp-block > .mp-glyphs`)
          const el = /** @type {HTMLElement | undefined} */ (layers[layers.length - 1])
          return el ? Number.parseFloat(el.style.getPropertyValue('--glyph-scale')) : Number.NaN
        }),
      [right, left],
    )
    ctx.log(`hafs spread ${right}–${left}: --glyph-scale ${a} / ${b}`)
    equal(a, b, `hafs spread ${right}–${left}: one --glyph-scale for both pages`)
    check(
      a >= HAFS_FLOOR && a <= HAFS_CAP,
      `hafs spread ${right}–${left}: ${a} within ${HAFS_FLOOR}–${HAFS_CAP}`,
    )
    if (right === 1) equal(a, HAFS_FLOOR, 'the opening pages keep the floor')
  }
}
