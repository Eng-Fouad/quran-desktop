// @ts-check
// S06 (§12.6; WP8c): pages 261–262 as a spread, QCF V2, night. Page 262 opens Al-Ḥijr: the surah header and the
// basmala (decor glyphs once loaded), the juz 14 / hizb 27 marker beside 15:1, and the running heads of both pages
// (Ibrāhīm · juz 13 on 261; Al-Ḥijr · juz 14 on 262, with the hizb carried into the head because the labels are
// glyph-only at this size). Frame, footers and page-stack hairlines in the night palette.
import { check, equal, mushaf } from '../lib/index.mjs'
import { arabic, expectFramedPage, furniture, waitDecor } from './_furniture.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'night',
  mode: 'both',
  settings: { mushafStyle: 'qcf_v2', pageMode: 'spread' },
  description: 'Pages 261–262 spread (15:1 header + basmala), qcf_v2, night',
}

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s06(ctx) {
  const { qd } = ctx
  await qd.goto({ type: 'page', data: { page: 262 } })
  await qd.waitIdle()
  const decor = (await waitDecor(ctx, 'qd-surah-header')) && (await waitDecor(ctx, 'qd-quran-common'))
  await qd.waitIdle()

  const state = await qd.state()
  equal(state.visiblePages, [261, 262], 'the 261–262 spread')
  equal(state.resolvedTheme, 'night', 'the resolved theme')
  check(state.qfs < 28, `qfs ${state.qfs}: margin labels are glyph-only in this spread`)

  const p261 = await furniture(ctx, 261)
  const p262 = await furniture(ctx, 262)
  expectFramedPage(p261, 261)
  expectFramedPage(p262, 262)
  check(!p261.medallion && !p262.medallion, 'no opening medallion on ordinary pages')
  check(p261.edges.shown && p262.edges.shown, 'page-stack hairlines in a spread')

  // Running heads: surah on the right, juz on the left; the hizb that starts on 262 follows the juz.
  // Names as core.db spells them (`name_ar`; the qdc source writes ابراهيم without hamza).
  check(/^سورة [إا]براهيم$/.test(p261.head?.surah ?? ''), `page 261: the surah head (${p261.head?.surah})`)
  equal(p262.head?.surah, 'سورة الحجر', 'page 262: the surah head')
  if (!decor) {
    equal(p261.head?.juz, `الجزء ${arabic(13)}`, 'page 261: the juz head')
    equal(p262.head?.juz, `الجزء ${arabic(14)} الحزب ${arabic(27)}`, 'page 262: juz head with the hizb')
  } else {
    check(
      p262.head?.juz.endsWith(`الحزب ${arabic(27)}`),
      `page 262: the hizb follows the juz (${p262.head?.juz})`,
    )
  }

  // The surah header and basmala of Al-Hijr on lines 1–2.
  equal(
    p262.headers.map((h) => [h.line, h.surah, h.decor]),
    [[1, 15, decor]],
    'page 262: the Al-Hijr header',
  )
  equal(
    p262.basmalas.map((b) => [b.line, b.decor]),
    [[2, decor]],
    'page 262: the basmala',
  )
  equal(p261.headers.length + p261.basmalas.length, 0, 'page 261: no header lines')

  // 15:1 opens juz 14 (and hizb 27): one marker on line 3, glyph only at this size.
  equal(
    p262.markers.map((m) => [m.kind, m.line, m.label]),
    [['rub', 3, '']],
    'page 262: the juz 14 marker beside line 3',
  )
  equal(p261.markers, [], 'page 261: no markers')

  await ctx.shot()
  await ctx.shot('p262', { selector: mushaf.page(262) })
}
