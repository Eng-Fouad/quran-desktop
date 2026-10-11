// @ts-check
// S39 (§12.6, §9.7, §8.13; WP8e, owner request 2026-10-11): the "Aa" reading-display popover.
//
// Beside the Mushaf in the night theme (pages 261–262): the "Aa" button 8 px under the zoom control, its arrowless
// popover opening toward the canvas with its top on the button's, the theme cards three across, the ink brightness
// (Night dims its ink), the Mushaf style cards, the pages, and "All settings" with its key. A theme card changes the
// real page at once (Sepia), with no scrim, and the ink row leaves with the dark theme. Then translation mode in the
// Arabic UI: the button in the top-left gutter beside the column, the popover to its right with the theme and the
// translation text size only. In the browser mock the translations are marked installed and the app relaunched (S21).
// Shots: S39.png (the window, night), S39-popover (the popover), S39-sepia (the window after the Sepia card) and
// S39-ar (translation mode in Arabic, the popover open).
import { check, equal, waitUntil } from '../lib/index.mjs'
import { installPacks, PACKS, waitForVerse } from './S21.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'night',
  mode: 'web',
  settings: { mushafStyle: 'hafs', pageMode: 'auto', inkBrightnessPct: 85, zoomPct: 100 },
  description:
    'The "Aa" display popover: Mushaf in night (theme, ink, style, pages); translation mode in Arabic',
}

const BUTTON = '[data-qd-display-control] button[data-action="display"]'
const POPOVER = '[data-qd-popover="display"]'

/**
 * Runs in the page: the boxes of the canvas, the zoom capsule, the "Aa" capsule and the popover, the popover's rows
 * and theme-card rows, and whether anything dims the page.
 */
function measure() {
  /** @param {Element | null} el */
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
  }
  const popover = document.querySelector('[data-qd-popover="display"]')
  const cards = [...(popover?.querySelectorAll('[data-row="theme"] [role="radio"]') ?? [])]
  return {
    canvas: box(document.querySelector('main.canvas')),
    zoom: box(document.querySelector('[data-qd-zoom-control]')),
    control: box(document.querySelector('[data-qd-display-control]')),
    sheet: box(document.querySelector('[data-qd-view="translation"] > .sheet')),
    popover: box(popover?.closest('[role="dialog"]') ?? null),
    rows: [...(popover?.querySelectorAll('[data-row]') ?? [])].map((r) => r.getAttribute('data-row')),
    cards: cards.length,
    cardRows: new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top))).size,
    arrow: (popover?.closest('[role="dialog"]')?.querySelector('.arrow') ?? null) !== null,
    footer:
      popover?.querySelector('[data-action="all-settings"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    scrim: document.querySelector('.backdrop') !== null,
    theme: document.documentElement.dataset.theme ?? '',
  }
}

/** @param {import('../lib/types').ScenarioContext} ctx */
async function openPopover(ctx) {
  await ctx.page.locator(BUTTON).click()
  await waitUntil(() => ctx.page.locator(POPOVER).count(), { timeout: 4000, message: 'the display popover' })
  await ctx.wait(250)
}

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s39(ctx) {
  const { page, qd } = ctx
  if (ctx.mode !== 'web') ctx.pending('S39 seeds installed packs in the browser mock')
  await qd.goto({ type: 'page', data: { page: 262 } })
  await qd.waitIdle()

  // The button: 40 × 40, 8 px under the zoom capsule, on the same inline-end edge.
  const rest = await page.evaluate(measure)
  const { zoom, control } = rest
  check(zoom !== null && control !== null, 'the zoom control and the display button')
  if (zoom && control) {
    check(Math.abs(control.width - 40) < 0.5 && Math.abs(control.height - 40) < 0.5, 'a 40 × 40 capsule')
    check(Math.abs(control.right - zoom.right) < 0.5, 'on the zoom control’s inline-end edge')
    check(
      Math.abs(control.top - zoom.bottom - 8) < 1,
      `8 px under the zoom control (${control.top - zoom.bottom})`,
    )
  }

  await openPopover(ctx)
  const night = await page.evaluate(measure)
  ctx.log(JSON.stringify(night))
  equal(
    night.rows,
    ['theme', 'inkBrightnessPct', 'mushafStyle', 'pageMode'],
    'the rows beside the Mushaf in night',
  )
  equal(night.cards, 6, 'six theme cards')
  equal(night.cardRows, 2, 'three across, in two rows')
  equal(night.arrow, false, 'no arrow (a chrome-button popover)')
  equal(night.scrim, false, 'no scrim over the page')
  check(night.footer.startsWith('All settings'), `the footer ("${night.footer}")`)
  if (night.popover && night.control) {
    check(
      night.popover.right <= night.control.left,
      'the popover opens toward the canvas (left of the button)',
    )
    check(Math.abs(night.popover.top - night.control.top) < 1, 'its top on the button’s')
    check(Math.abs(night.popover.width - 340) < 1, `340 px wide (${night.popover.width})`)
  }
  await ctx.shot()
  await ctx.shot('popover', { selector: `[role="dialog"]:has(${POPOVER})` })

  // A theme card applies at once, under the open popover; the ink row leaves with the dark theme.
  await page.locator(`${POPOVER} [data-row="theme"] [role="radio"][data-value="sepia"]`).click()
  await waitUntil(async () => (await page.evaluate(measure)).theme === 'sepia', {
    timeout: 4000,
    message: 'the sepia theme applied',
  })
  await ctx.wait(300)
  const sepia = await page.evaluate(measure)
  equal(sepia.rows, ['theme', 'mushafStyle', 'pageMode'], 'the rows in sepia')
  equal((await qd.state()).settings.theme, 'sepia', 'the theme setting')
  await ctx.shot('sepia')
  await page.keyboard.press('Escape')
  await waitUntil(async () => (await page.locator(POPOVER).count()) === 0, {
    timeout: 4000,
    message: 'Escape closes the popover',
  })

  // Translation mode in the Arabic UI: the button in the gutter at the top left, the popover to its right.
  await qd.setSettings({ readingMode: 'translation', translations: PACKS, uiLanguage: 'ar', theme: 'paper' })
  await installPacks(ctx, PACKS)
  await qd.waitIdle()
  await waitForVerse(ctx, 1, PACKS.length)
  await openPopover(ctx)
  const ar = await page.evaluate(measure)
  ctx.log(JSON.stringify(ar))
  equal(ar.rows, ['theme', 'translationFontPct'], 'the rows in translation mode')
  if (ar.canvas && ar.control && ar.sheet && ar.popover) {
    check(
      Math.abs(ar.control.left - ar.canvas.left - 12) < 1,
      'the top-left corner of the canvas (Arabic UI)',
    )
    check(Math.abs(ar.control.top - ar.canvas.top - 16) < 1, '16 px down, where the zoom control would be')
    check(ar.control.right < ar.sheet.left, 'in the gutter, clear of the reading column’s paper')
    check(ar.popover.left >= ar.control.right, 'the popover opens to the right, toward the canvas')
  }
  await ctx.shot('ar')
}
