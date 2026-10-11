// @ts-check
// S23 (§12.6, §9.7; WP12a): the Downloads manager with a paused and a failed job and an expanded SurahGrid, then the
// rail's Downloads flyout over the reader (owner request 2026-10-11).
//
// Browser mock: a lived-in state (`?mockPacks=demo`: ornaments, translations with an update, Al-Muyassar, Alafasy
// with downloaded and stream-cached surahs, on-demand Mushaf pages), then real clicks drive the jobs:
// - "Download all" of the 1405 AH Mushaf, then Pause → a paused job (muted bar, "Paused · 9.6 of 45.7 MB");
// - "Download all" of the Tajweed Mushaf, made to fail once (`?mockPackFail=mushaf.v4:integrity@20`) → Failed + Retry;
// - in Alafasy's surah grid (open on the first visit: the current reciter), surah 108 downloaded with a click, then
//   Al-Baqarah started and paused, so its cell shows the queued ring.
// - The manager takes the canvas without the sidebar; Escape returns to the reader, and the rail button opens the
//   arrowless flyout beside it: the update line, the paused and failed jobs, "Recently finished" (surah 108).
// Shots: S23.png (paused + failed rows above the expanded grid), S23-top (storage card and banners), S23-grid (the
// reciter row), S23-ar (Arabic UI), S23-night (night theme), S23-flyout and S23-flyout-ar (the rail flyout).
import { check, equal, waitUntil } from '../lib/index.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'web',
  description: 'Downloads manager with paused and failed jobs and an expanded SurahGrid, and the rail flyout',
}

const ROW = (/** @type {string} */ id) => `li.pack[data-pack-id="${id}"]`
const RECITER = 'audio.qdc.7'
const RAIL_BUTTON = '.rail button[data-view="downloads"]'
const FLYOUT = '[data-qd-flyout="downloads"]'
const FLYOUT_ROW = (/** @type {string} */ id) => `${FLYOUT} ul[aria-label] > li[data-pack-id="${id}"]`

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s23(ctx) {
  const { page, qd } = ctx
  // Demo data, a failure for the Tajweed Mushaf, and 10 MB/s so the scenario stays short (the mock reads these lazily).
  await page.evaluate(() =>
    history.replaceState(
      null,
      '',
      `${location.pathname}${location.search ? `${location.search}&` : '?'}mockPacks=demo&mockPackFail=mushaf.v4:integrity@20&mockPackRate=10`,
    ),
  )
  await qd.goto({ type: 'view', data: { view: 'downloads' } })
  await waitUntil(() => page.locator(`${ROW('tr.en.saheeh')}[data-state="installed"]`).count(), {
    timeout: 5000,
    message: 'the demo packs did not appear',
  })
  await qd.waitIdle()

  equal(await page.locator('h1').first().textContent(), 'Downloads', 'view title')
  equal(await page.locator('#qd-pane-sidebar').count(), 0, 'the manager hides the sidebar')
  equal(
    await page.locator(RAIL_BUTTON).getAttribute('aria-current'),
    'page',
    'the rail button marks the manager',
  )
  equal(
    await page.locator(`${ROW('tr.en.hilali_khan')}`).getAttribute('data-state'),
    'update_available',
    'Hilali–Khan has an update',
  )
  check((await page.locator('[data-banner="updates"]').count()) === 1, 'the updates banner shows')
  const usage = (await page.locator('[data-qd-usage] .total').textContent())?.trim() ?? ''
  check(/MB used|GB used/.test(usage), `the storage total ("${usage}")`)

  // A paused job: download the whole 1405 AH Mushaf, then pause it.
  await page.locator(`${ROW('mushaf.v1')} [data-action="download"]`).click()
  await waitForJob(ctx, 'mushaf.v1', 'downloading')
  await ctx.wait(900)
  await page.locator(`${ROW('mushaf.v1')} [data-action="pause"]`).click()
  await waitForJob(ctx, 'mushaf.v1', 'paused')
  const pausedLine = (await page.locator(`${ROW('mushaf.v1')} .stats`).textContent())?.trim() ?? ''
  check(pausedLine.startsWith('Paused'), `the paused line ("${pausedLine}")`)

  // A failed job: the Tajweed Mushaf fails once at 20 % (scripted), and offers Retry.
  await page.locator(`${ROW('mushaf.v4')} [data-action="download"]`).click()
  await waitForJob(ctx, 'mushaf.v4', 'failed', 20_000)
  const error = (await page.locator(`${ROW('mushaf.v4')} .error`).textContent())?.trim() ?? ''
  check(error.includes('damaged'), `the failure reason ("${error}")`)
  check((await page.locator(`${ROW('mushaf.v4')} [data-action="retry"]`).count()) === 1, 'Retry is offered')

  // The current reciter's surah grid is open on the first visit.
  const grid = page.locator(`${ROW(RECITER)} .grid`)
  equal(await grid.count(), 1, "Alafasy's surah grid is open")
  equal(await grid.locator('.cell').count(), 114, 'surah cells')
  equal(await cellState(ctx, 18), 'pinned', 'surah 18 (demo: downloaded)')
  check((await grid.locator('.cell[data-cached]').count()) >= 4, 'stream-cached surahs show half-tone')

  // One click downloads a surah.
  await grid.locator('[data-surah="108"]').click()
  await waitUntil(async () => (await cellState(ctx, 108)) === 'pinned', {
    timeout: 10_000,
    message: 'surah 108 did not download',
  })
  // Al-Baqarah starts, then the reciter's job is paused: its cell keeps the queued ring.
  await grid.locator('[data-surah="2"]').click()
  await waitForJob(ctx, RECITER, 'downloading')
  await ctx.wait(600)
  await page.locator(`${ROW(RECITER)} [data-action="pause"]`).click()
  await waitForJob(ctx, RECITER, 'paused')
  equal(await cellState(ctx, 2), 'queued', 'Al-Baqarah waits in the paused job')
  const fatiha = await grid.locator('[data-surah="1"]').getAttribute('aria-label')
  check(/basmala/.test(fatiha ?? ''), `surah 1 says it holds the basmala ("${fatiha}")`)

  // The status line describes the surah under the pointer.
  await grid.locator('[data-surah="18"]').hover()
  const status = (await page.locator(`${ROW(RECITER)} .status`).textContent())?.trim() ?? ''
  check(status.startsWith('18. Al-Kahf') && status.includes('Downloaded'), `status line ("${status}")`)
  await page.mouse.move(4, 500)

  await qd.waitIdle()
  await scrollTo(ctx, null)
  await ctx.shot('top')
  await scrollTo(ctx, '[data-section="mushaf"]')
  await ctx.shot()
  await ctx.shot('grid', { selector: ROW(RECITER) })

  await qd.setSettings({ uiLanguage: 'ar' })
  await qd.waitIdle()
  await scrollTo(ctx, '[data-section="mushaf"]')
  const titleAr = (await page.locator('h1').first().textContent())?.trim()
  equal(titleAr, 'التنزيلات', 'view title in Arabic')
  await ctx.shot('ar')

  await qd.setSettings({ uiLanguage: 'en', theme: 'night' })
  await qd.waitIdle()
  await scrollTo(ctx, '[data-section="mushaf"]')
  await ctx.shot('night')

  // The rail flyout: back in the reader (Escape), the same jobs at a glance.
  await qd.setSettings({ theme: 'paper' })
  await page.keyboard.press('Escape')
  await qd.waitIdle()
  equal(await page.locator('[data-qd-view="downloads"]').count(), 0, 'Escape returns to the reader')
  await page.locator(RAIL_BUTTON).click()
  await page.locator(FLYOUT).waitFor({ timeout: 5000 })
  equal(await page.locator(RAIL_BUTTON).getAttribute('aria-expanded'), 'true', 'the rail button is expanded')
  equal(await page.locator(`${FLYOUT_ROW('mushaf.v1')}`).getAttribute('data-job'), 'paused', 'flyout: paused')
  equal(await page.locator(`${FLYOUT_ROW('mushaf.v4')}`).getAttribute('data-job'), 'failed', 'flyout: failed')
  const reason = (await page.locator(`${FLYOUT_ROW('mushaf.v4')} .error`).textContent())?.trim() ?? ''
  check(reason.includes('damaged'), `flyout: the failure reason ("${reason}")`)
  check((await page.locator(`${FLYOUT} [data-qd-updates]`).count()) === 1, 'flyout: the update line')
  const finished =
    (await page.locator(`${FLYOUT} .recent li[data-pack-id="${RECITER}"] .line`).textContent()) ?? ''
  check(finished.includes('Al-Kawthar'), `flyout: surah 108 finished ("${finished.trim()}")`)
  check(
    (await page.locator(`${RAIL_BUTTON} [data-badge="failed"]`).count()) === 1,
    'the rail marks the failure',
  )
  await qd.waitIdle()
  await ctx.shot('flyout')

  await qd.setSettings({ uiLanguage: 'ar' })
  await qd.waitIdle()
  equal((await page.locator(`${FLYOUT} h2`).textContent())?.trim(), 'التنزيلات', 'flyout title in Arabic')
  await ctx.shot('flyout-ar')
}

/**
 * Waits until a pack row shows a job phase.
 * @param {import('../lib/types').ScenarioContext} ctx
 * @param {string} id
 * @param {string} phase
 * @param {number} [timeout]
 */
async function waitForJob(ctx, id, phase, timeout = 10_000) {
  await waitUntil(async () => (await ctx.page.locator(ROW(id)).getAttribute('data-job')) === phase, {
    timeout,
    message: `${id} did not reach ${phase}`,
  })
}

/**
 * @param {import('../lib/types').ScenarioContext} ctx
 * @param {number} surah
 */
function cellState(ctx, surah) {
  return ctx.page.locator(`${ROW(RECITER)} [data-surah="${surah}"]`).getAttribute('data-state')
}

/**
 * Scrolls the Downloads view so `selector` sits just under the sticky filters (`null`: back to the top).
 * @param {import('../lib/types').ScenarioContext} ctx
 * @param {string | null} selector
 */
async function scrollTo(ctx, selector) {
  await ctx.page.evaluate((sel) => {
    const viewport = document.querySelector('[data-qd-view="downloads"] [data-scroll-area-viewport]')
    if (!(viewport instanceof HTMLElement)) return
    if (sel === null) {
      viewport.scrollTop = 0
      return
    }
    const target = document.querySelector(sel)
    if (!(target instanceof HTMLElement)) return
    const filters = document.querySelector('[data-qd-view="downloads"] .filters')
    const offset = filters instanceof HTMLElement ? filters.offsetHeight + 16 : 16
    viewport.scrollTop += target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - offset
  }, selector)
  await ctx.wait(150)
}
