// @ts-check
// S24: Settings › Appearance in the high-contrast theme at 150 % interface size.
//
// Settings is a dialog over the reader, which stays mounted under it (owner request 2026-10-11). The interface size is
// webview zoom in the real app and CSS zoom on <html> in the browser mock, so the 1600 × 1000 window lays out
// like 1067 × 667: the dialog still floats (1019 × 579 under the title bar) with the navigation beside the column.
// At 200 % (800 × 500) it fills the room under the title bar and the sections fold into one scrolling row. The page
// preview shows Al-Fatihah in high contrast beside 1:2 in Saheeh International (the browser mock installs it through
// `?mockPacks=demo`; in the real app the preview asks for a translation instead). Shots: S24.png (Appearance),
// S24-preview (the preview card), S24-search ("dark": rows from several sections), S24-ar (the Arabic UI), S24-strip
// (Arabic at 200 %: the filled dialog and its one-row strip) and S24-paper (paper at 100 %, the everyday look).
import { check, equal, waitUntil } from '../lib/index.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'high_contrast',
  mode: 'both',
  settings: { uiScalePct: 150 },
  description: 'Settings › Appearance, high_contrast, UI scale 150 %',
}

const ROW = (/** @type {string} */ id) => `[data-row="${id}"]`
const DIALOG = '[role="dialog"]:has([data-qd-settings-dialog])'

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s24(ctx) {
  const { page, qd } = ctx
  if (ctx.mode === 'web') {
    // Demo packs (a downloaded Saheeh International) for the preview's translation line.
    await page.evaluate(() =>
      history.replaceState(
        null,
        '',
        `${location.pathname}${location.search ? `${location.search}&` : '?'}mockPacks=demo`,
      ),
    )
    await qd.ipc('packsList')
    await qd.setSettings({ translations: ['tr.en.saheeh'] })
  }
  await qd.goto({ type: 'view', data: { view: 'settings' } })
  await page.locator('nav button[data-section="appearance"]').click()
  await waitUntil(() => page.locator('[data-preview] section.mp').count(), {
    timeout: 8000,
    message: 'the preview page did not render',
  })
  await qd.waitIdle()

  // The dialog over the reader: named by the view's title, the reader still mounted under it.
  equal(await page.locator(DIALOG).count(), 1, 'the Settings dialog')
  check((await page.locator('[data-qd-view="mushaf"] section.mp').count()) > 0, 'the reader stays mounted')

  // The view: title, the open section, every Appearance row.
  equal((await page.locator('h1').first().textContent())?.trim(), 'Settings', 'view title')
  equal(
    await page.locator('nav button[aria-current="page"]').getAttribute('data-section'),
    'appearance',
    'the open section',
  )
  for (const id of [
    'theme',
    'lightVariant',
    'darkVariant',
    'accent',
    'uiScalePct',
    'inkBrightnessPct',
    'motion',
  ]) {
    equal(await page.locator(ROW(id)).count(), 1, `row ${id}`)
  }

  // High contrast is applied and chosen.
  const html = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    zoom: document.documentElement.style.zoom,
  }))
  equal(html.theme, 'high_contrast', 'html[data-theme]')
  equal(
    await page.locator(`${ROW('theme')} [role="radio"][aria-checked="true"]`).getAttribute('data-value'),
    'high_contrast',
    'the High contrast card is chosen',
  )
  check(
    ((await page.locator(`${ROW('accent')} .note`).textContent()) ?? '').includes('own accent'),
    'the accent row explains that high contrast forces its accent',
  )

  // 150 %: the slider and its value; the mock zooms the document (the real app zooms the webview).
  equal(
    await page.locator(`${ROW('uiScalePct')} [role="slider"]`).getAttribute('aria-valuenow'),
    '150',
    'UI scale',
  )
  equal(
    (await page.locator(`${ROW('uiScalePct')} output`).textContent())?.trim(),
    '150%',
    'UI scale readout (Intl percent, as elsewhere in the app)',
  )
  if (ctx.mode === 'web') equal(html.zoom, '150%', 'the mock approximates the UI scale with CSS zoom')

  // At 150 % the dialog floats under the title bar with room for the navigation beside the column.
  const layout = await page.evaluate(inspectLayout, DIALOG)
  ctx.log(JSON.stringify(layout))
  check(layout !== null && !layout.fill, 'the dialog floats with margins at 150 %')
  check(layout !== null && layout.navEnd <= layout.columnStart + 1, 'the navigation sits beside the column')

  if (ctx.mode === 'web') {
    // The fixtures' text may be synthetic ("Synthetic translation of 1:2…"): any text of 1:2 will do.
    await waitUntil(
      async () =>
        ((await page.locator('[data-preview] .translation').textContent()) ?? '').trim().length > 10,
      { timeout: 5000, message: 'the preview did not show 1:2 in Saheeh International' },
    )
    equal(
      (await page.locator('[data-preview] .translator').textContent())?.trim(),
      'Saheeh International',
      'the preview names the translation',
    )
  }

  await qd.waitIdle()
  await ctx.shot()
  await ctx.shot('preview', { selector: '[data-preview]' })

  // Search across sections: "dark" finds the dark theme, ink brightness and others; counts show in the navigation.
  const search = page.locator('[data-settings-search]')
  await search.fill('dark')
  await waitUntil(async () => (await page.locator('[data-row]:not([hidden])').count()) > 1, {
    timeout: 3000,
    message: 'the search found nothing for "dark"',
  })
  const found = await page
    .locator('[data-row]:not([hidden])')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-row')))
  check(found.includes('darkVariant') && found.includes('theme'), `search results (${found.join(', ')})`)
  await ctx.shot('search')
  await search.fill('')

  // The Arabic UI: mirrored, translated, Arabic-Indic digits in the readout.
  await qd.setSettings({ uiLanguage: 'ar' })
  await qd.waitIdle()
  equal((await page.locator('h1').first().textContent())?.trim(), 'الإعدادات', 'view title in Arabic')
  const readout = (await page.locator(`${ROW('uiScalePct')} output`).textContent())?.trim() ?? ''
  check(readout.includes('١٥٠'), `UI scale readout in Arabic-Indic digits ("${readout}")`)
  await ctx.shot('ar')

  // 200 % (800 × 500): the dialog fills the room under the title bar; the sections fold into one row that scrolls.
  await qd.setSettings({ uiScalePct: 200 })
  await qd.waitIdle()
  const small = await page.evaluate(inspectLayout, DIALOG)
  ctx.log(JSON.stringify(small))
  check(small !== null && small.fill, 'the dialog fills the room at 200 %')
  check(small !== null && small.stripRows === 1 && small.stripScrolls, 'the sections are one scrolling row')
  await ctx.shot('strip')

  // The everyday look: English, paper, 100 %.
  await qd.setSettings({ uiLanguage: 'en', theme: 'paper', uiScalePct: 100 })
  await qd.waitIdle()
  await ctx.shot('paper')
}

/**
 * The Settings dialog's layout (runs in the page): whether it fills the room under the title bar, where
 * its navigation ends and its column starts (in reading order), and its section buttons' rows.
 * @param {string} selector
 */
function inspectLayout(selector) {
  const dialog = document.querySelector(selector)
  const nav = dialog?.querySelector('[data-qd-view="settings"] nav')
  const column = dialog?.querySelector('[data-qd-view="settings"] .content')
  const strip = dialog?.querySelector('ul.sections')
  if (!dialog || !nav || !column || !strip) return null
  const rtl = getComputedStyle(dialog).direction === 'rtl'
  const n = nav.getBoundingClientRect()
  const c = column.getBoundingClientRect()
  const rows = new Set(
    [...strip.querySelectorAll('button[data-section]')].map((b) => Math.round(b.getBoundingClientRect().top)),
  )
  return {
    // Filled: edge to edge, so no rounded corners.
    fill: getComputedStyle(dialog).borderStartStartRadius === '0px',
    navEnd: rtl ? -n.left : n.right,
    columnStart: rtl ? -c.right : c.left,
    stripRows: rows.size,
    stripScrolls: strip.scrollWidth > strip.clientWidth,
  }
}
