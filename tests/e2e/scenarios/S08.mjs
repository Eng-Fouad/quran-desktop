// @ts-check
// S08 (§12.6; WP8c): page 187 alone, QCF V2, paper. At-Tawbah opens on line 1 with its surah header and, alone among the
// surahs, no basmala: line 2 is already 9:1. 9:1 also opens the half of hizb 19, marked in the outer margin with its
// label (single page at 1600×1000: qfs ≥ 28). When the surah info popover is mounted (MushafView, WP8e), a click on the
// header opens it and it is shot too.
import { check, equal, mushaf } from '../lib/index.mjs'
import { arabic, expectFramedPage, furniture, waitDecor } from './_furniture.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'both',
  settings: { mushafStyle: 'qcf_v2', pageMode: 'single' },
  description: 'Page 187, qcf_v2: surah 9 header with no basmala, the ½ hizb 19 marker with its label',
}

const PAGE = 187

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s08(ctx) {
  const { qd } = ctx
  await qd.goto({ type: 'page', data: { page: PAGE } })
  await qd.waitIdle()
  const decor = (await waitDecor(ctx, 'qd-surah-header')) && (await waitDecor(ctx, 'qd-quran-common'))
  await qd.waitIdle()

  const state = await qd.state()
  equal(state.visiblePages, [PAGE], 'page 187 alone')
  check(state.qfs >= 28, `qfs ${state.qfs}: margin labels are drawn`)

  const r = await furniture(ctx, PAGE)
  expectFramedPage(r, PAGE)
  equal(r.head?.surah, 'سورة التوبة', 'the surah head')
  equal(
    r.headers.map((h) => [h.line, h.surah, h.decor]),
    [[1, 9, decor]],
    'the At-Tawbah header on line 1',
  )
  equal(r.basmalas, [], 'At-Tawbah has no basmala')
  equal(
    r.markers.map((m) => [m.kind, m.line, m.label]),
    [['rub', 2, `½ الحزب ${arabic(19)}`]],
    'the half-hizb 19 marker beside 9:1, labelled',
  )
  if (!decor) check(r.markers[0]?.glyph === '۞', 'the ۞ glyph without decor')

  await ctx.shot()
  await ctx.shot('page', { selector: mushaf.page(PAGE) })

  // The surah info popover, where MushafView mounts it (WP8e renders SurahInfoPopover in its overlay layer).
  await ctx.page.locator(`${mushaf.page(PAGE)} .mp-glyphs:last-of-type .sh-line`).click()
  await ctx.wait(400)
  if ((await ctx.page.locator('.si[data-surah="9"]').count()) > 0) {
    await ctx.shot('info')
    await ctx.page.keyboard.press('Escape')
  } else ctx.log('SurahInfoPopover is not mounted in this build (MushafView, WP8e): no popover shot')
}
