// @ts-check
// S24 (§12.6, §9.7; WP12b): Settings › Appearance in the high-contrast theme at 150 % interface size.
//
// The interface size is webview zoom in the real app (D27) and CSS zoom on <html> in the browser mock (§12.6), so the
// 1600 × 1000 window lays out like 1067 × 667: the settings navigation folds into a strip above the column. The page
// preview shows Al-Fatihah in high contrast beside 1:2 in Saheeh International (the browser mock installs it through
// `?mockPacks=demo`; in the real app the preview asks for a translation instead).
// Shots: S24.png (Appearance), S24-preview (the preview card), S24-search ("dark": rows from several sections), S24-ar
// (the Arabic UI) and S24-paper (paper at 100 %, the everyday look).
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

  // 150 %: the slider and its value; the mock zooms the document (the real app zooms the webview, D27).
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

  // At 150 % the canvas is narrow: the section navigation is a strip above the column.
  const layout = await page.evaluate(() => {
    const nav = document.querySelector('[data-qd-view="settings"] nav')?.getBoundingClientRect()
    const column = document.querySelector('[data-qd-view="settings"] .content')?.getBoundingClientRect()
    return nav && column ? { navBottom: nav.bottom, columnTop: column.top } : null
  })
  check(layout !== null && layout.navBottom <= layout.columnTop + 1, 'the navigation sits above the column')

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

  // The everyday look: English, paper, 100 %.
  await qd.setSettings({ uiLanguage: 'en', theme: 'paper', uiScalePct: 100 })
  await qd.waitIdle()
  await ctx.shot('paper')
}
