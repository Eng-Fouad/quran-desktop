// @ts-check
// S30 (§12.6; WP8b): network not allowed ("Work offline"), QCF V2 selected, page 300, whose page font is not on disk:
// mushaf_ensure_page_fonts answers `unavailable`, so the page shows the Hafs fallback rendition with no error toast,
// and the subtle font-status dot in the footer band says "Offline — showing the Hafs font" (§8.5, §9.8), also in the
// Arabic UI. In the browser mock, when `data/dev-packs` has page 262's font (CI has no dev packs), it then makes one
// download fail (`?mockFontFail`) and recovers it through the dot's Retry (the `failed` state of §9.8; the
// RenditionStack browser test covers that state everywhere).
import { check, equal, mushaf, waitUntil } from '../lib/index.mjs'
import { assertPage, clipAround, devPackHasPage, inspectPage } from './_fonts.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'both',
  settings: { mushafStyle: 'qcf_v2', networkAllowed: false, pageMode: 'auto' },
  description: 'Network disallowed: qcf_v2, page 300 shows the hafs fallback and the offline dot (no toast)',
}

const PAGE = 300
/** A fixture page with a dev-pack font, made to fail once with `?mockFontFail` (browser mock only). */
const FAILING = 262
/** The fixture pages with a dev-pack font that the reader shows or prefetches around page 262. */
const FAILING_NEIGHBOURS = [255, 256, 261, 263]
const OFFLINE = 'Offline — showing the Hafs font'
const OFFLINE_AR = 'دون اتصال — تُعرض الصفحة بخط حفص'
const FAILED = "Couldn't download this page's font"

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s30(ctx) {
  const { qd } = ctx
  await qd.goto({ type: 'page', data: { page: PAGE } })
  await qd.waitIdle()

  const state = await qd.state()
  equal(state.style, 'qcf_v2', 'the Mushaf style')
  equal(state.settings.networkAllowed, false, 'networkAllowed')
  check(state.visiblePages.includes(PAGE), `page ${PAGE} on screen (${state.visiblePages.join(', ')})`)

  const [status] = await qd.ipc('mushafEnsurePageFonts', 'qcf_v2', [PAGE], 'interactive')
  equal(status?.availability, 'unavailable', `the page font of page ${PAGE} offline`)

  for (const page of state.visiblePages) {
    const report = await assertPage(ctx, page, {
      style: 'qcf_v2',
      kind: 'fallback',
      availability: 'unavailable',
    })
    equal(report.dot?.label, OFFLINE, `page ${page}: the dot's accessible name`)
  }
  // No error toast for a missing font (§8.5: the fallback stays quietly).
  const toasts = await ctx.page.locator('[data-sonner-toast]').count()
  equal(toasts, 0, 'toasts on screen')

  await ctx.shot()

  // The dot's tooltip (hover, after the 500 ms tooltip delay), in English and in Arabic.
  const tip = await hoverDot(ctx, PAGE, OFFLINE)
  ctx.log(`tooltip: ${tip}`)
  await ctx.shot('dot', { clip: await clipAround(ctx, [`${mushaf.page(PAGE)} .rs-dot`, '.tooltip'], 140) })
  await ctx.shot('page', { clip: await clipAround(ctx, [mushaf.page(PAGE)], 16) })

  await qd.setSettings({ uiLanguage: 'ar' })
  await qd.waitIdle()
  await ctx.page.mouse.move(0, 0)
  const tipAr = await hoverDot(ctx, PAGE, OFFLINE_AR)
  ctx.log(`tooltip (ar): ${tipAr}`)
  const dotAr = await ctx.page.evaluate(inspectPage, PAGE)
  equal(dotAr.dot?.label, OFFLINE_AR, 'the dot label in the Arabic UI')
  await ctx.shot('dot-ar', { clip: await clipAround(ctx, [`${mushaf.page(PAGE)} .rs-dot`, '.tooltip'], 140) })
  await qd.setSettings({ uiLanguage: 'en' })
  await ctx.page.mouse.move(0, 0)

  // Browser mock only: a download that fails (?mockFontFail) shows the warning dot, whose Retry recovers the page.
  if (ctx.mode !== 'web') return
  // Without the page's dev-pack font the mock answers `unavailable` before it looks at `?mockFontFail`: nothing to fail.
  if (!(await devPackHasPage(ctx, 'v2', FAILING))) {
    ctx.log(`page ${FAILING}'s qcf_v2 font is not in data/dev-packs: no failed download and Retry`)
    return
  }
  await qd.setSettings({ networkAllowed: true })
  // A fresh page-font download anywhere in the style reports `packs-changed`, which makes the reader retry its failed
  // pages at once (as the app does: the network works again). Download the neighbours first, so nothing but the failing
  // page itself is fetched around it and its failed state stays until Retry.
  await qd.ipc('mushafEnsurePageFonts', 'qcf_v2', FAILING_NEIGHBOURS, 'interactive')
  await qd.waitIdle()
  await ctx.page.evaluate(
    (p) => history.replaceState(null, '', `${location.pathname}?mockFontFail=${p}`),
    FAILING,
  )
  await qd.goto({ type: 'page', data: { page: FAILING } })
  await qd.waitIdle()
  const failed = await ctx.page.evaluate(inspectPage, FAILING)
  equal(
    failed.renditions.map((r) => r.kind),
    ['fallback'],
    `page ${FAILING} after a failed download`,
  )
  equal(failed.dot?.state, 'failed', `page ${FAILING}: font-status dot`)
  equal(failed.dot?.label, `${FAILED}. Retry`, `page ${FAILING}: the dot label`)
  const failedTip = await hoverDot(ctx, FAILING, FAILED)
  check(failedTip.includes('Retry'), `the failed tooltip offers Retry (${failedTip})`)
  await ctx.shot('failed', {
    clip: await clipAround(ctx, [`${mushaf.page(FAILING)} .rs-dot`, '.tooltip'], 140),
  })
  await ctx.page.locator(`${mushaf.page(FAILING)} .rs-dot`).click()
  await waitUntil(
    () =>
      ctx.page.evaluate(
        (p) =>
          document
            .querySelector(`section.mp[data-page="${p}"] .mp-glyphs`)
            ?.getAttribute('data-rendition') === 'qcf',
        FAILING,
      ),
    { timeout: 5000, message: `page ${FAILING} did not recover after Retry` },
  )
  await qd.waitIdle()
  await assertPage(ctx, FAILING, { style: 'qcf_v2', kind: 'qcf' })
  await ctx.shot('retried', { clip: await clipAround(ctx, [mushaf.page(FAILING)], 16) })
}

/**
 * Hovers a page's font-status dot and waits for its tooltip to show `text`; returns the tooltip text.
 * @param {import('../lib/types').ScenarioContext} ctx
 * @param {number} page
 * @param {string} text
 */
async function hoverDot(ctx, page, text) {
  await ctx.page.locator(`${mushaf.page(page)} .rs-dot`).hover()
  const tip = await waitUntil(
    async () => {
      const found = await ctx.page
        .locator('.tooltip')
        .first()
        .textContent({ timeout: 100 })
        .catch(() => null)
      return found?.includes(text) ? found : null
    },
    { timeout: 3000, message: `the dot tooltip of page ${page} did not show "${text}"` },
  )
  return tip.replace(/\s+/g, ' ').trim()
}
