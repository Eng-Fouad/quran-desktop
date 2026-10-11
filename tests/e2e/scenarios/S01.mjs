// @ts-check
// S01 (§12.6, §9.7; WP12c): onboarding step 1 over the real page 1–2 spread, paper, English.
//
// First run: the reader shows the page 1–2 spread and the onboarding opens over it (faint backdrop). Step 1 has the
// headline, the three feature tiles, the language switch and the five theme cards, each a thumbnail of page 1 in its
// theme; Match system (the default) is selected and shows paper and night split on a diagonal. Checks: the dialog is
// 720 × 540 and centred, the backdrop is rgb(0 0 0 / .18), both pages are on screen behind it, the thumbnails render
// page 1 from the hafs style, each card's paper colour is its theme's `--surface-page`, and the step fits the dialog:
// its body does not scroll and the theme cards end above the footer. A first run must be finished: no Skip (owner
// 2026-10-11).
// Shots: S01.png (the window), S01-dialog (the dialog), S01-night (the night theme, chosen on a card; the dialog
// follows the theme at once).
import { check, equal, waitUntil } from '../lib/index.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'system',
  colorScheme: 'light',
  mode: 'web',
  settings: { onboardingDone: false, pageMode: 'auto' },
  description: 'Onboarding step 1 over the real page 1–2 spread (paper, English)',
}

const DIALOG = '[role="dialog"].qd-onboarding'
const CARD = (/** @type {string} */ theme) => `${DIALOG} [data-theme-choice="${theme}"]`

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s01(ctx) {
  const { page, qd } = ctx
  await qd.goto({ type: 'page', data: { page: 1 } })
  await qd.openOverlay('onboarding')
  await page.locator(DIALOG).waitFor({ state: 'visible' })
  await waitUntil(
    async () => (await page.locator(`${DIALOG} [data-theme-choice] section.mp[data-page="1"]`).count()) >= 6,
    { timeout: 10_000, message: 'the theme thumbnails did not render page 1' },
  )
  await qd.waitIdle()
  await ctx.wait(400)

  const report = await page.evaluate(inspect, DIALOG)
  ctx.log(JSON.stringify(report))
  check(Math.abs(report.box.width - 720) <= 1, `dialog width ${report.box.width}`)
  check(Math.abs(report.box.height - 540) <= 1, `dialog height ${report.box.height}`)
  check(Math.abs(report.box.cx - report.viewport.w / 2) <= 2, `dialog centred (x ${report.box.cx})`)
  check(Math.abs(report.box.cy - report.viewport.h / 2) <= 2, `dialog centred (y ${report.box.cy})`)
  equal(report.backdrop, 'rgba(0, 0, 0, 0.18)', 'faint backdrop')
  equal(report.pagesBehind.join(','), '1,2', 'the page 1–2 spread behind the dialog')
  equal(report.title, 'Welcome to Quran for Desktop', 'headline')
  equal(report.checked, 'system', 'Match system is selected by default')
  equal(report.cards.join(','), 'system,paper,sepia,night,black', 'theme cards')
  equal(report.language, 'English', 'language switch')
  equal(report.step, 'Step 1 of 5', 'progress')
  equal(report.skip, false, 'a first run offers no Skip')
  // Each thumbnail's paper is its theme's page colour (§9.2); Match system shows paper and night.
  equal(report.paper.paper, 'rgb(253, 248, 236)', 'paper card')
  equal(report.paper.sepia, 'rgb(246, 234, 210)', 'sepia card')
  equal(report.paper.night, 'rgb(26, 28, 31)', 'night card')
  equal(report.paper.black, 'rgb(0, 0, 0)', 'black card')
  equal(report.paper.system, 'rgb(253, 248, 236)|rgb(26, 28, 31)', 'Match system card (light | dark)')
  check(
    report.body.scrollHeight <= report.body.clientHeight,
    `the step fits without scrolling (${report.body.scrollHeight} ≤ ${report.body.clientHeight})`,
  )
  check(
    report.cardsBottom <= report.body.bottom + 0.5,
    `the theme cards end inside the body (${report.cardsBottom})`,
  )
  await ctx.shot()
  await ctx.shot('dialog', { selector: DIALOG })

  // Choosing a card applies the theme at once (and the dialog follows it).
  await page.locator(CARD('night')).click()
  await waitUntil(
    async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === 'night',
    {
      timeout: 5000,
      message: 'the night card did not apply the theme',
    },
  )
  equal(await page.locator(CARD('night')).getAttribute('aria-checked'), 'true', 'night is checked')
  await qd.waitIdle()
  await ctx.wait(300)
  await ctx.shot('night')
}

/**
 * Geometry and state of the dialog (runs in the page).
 * @param {string} selector
 */
function inspect(selector) {
  const dialog = /** @type {HTMLElement} */ (document.querySelector(selector))
  const r = dialog.getBoundingClientRect()
  const body = /** @type {HTMLElement | null} */ (dialog.querySelector(':scope > .body'))
  const backdrop = document.querySelector('.backdrop')
  const paperOf = (/** @type {Element | null} */ card) =>
    [...(card?.querySelectorAll('.mp-paper') ?? [])].map((p) => getComputedStyle(p).backgroundColor).join('|')
  /** @type {Record<string, string>} */
  const paper = {}
  for (const card of dialog.querySelectorAll('[data-theme-choice]')) {
    paper[card.getAttribute('data-theme-choice') ?? ''] = paperOf(card)
  }
  return {
    viewport: { w: innerWidth, h: innerHeight },
    box: { width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 },
    backdrop: backdrop ? getComputedStyle(backdrop).backgroundColor : '',
    pagesBehind: [...document.querySelectorAll('main#qd-main section.mp')]
      .filter((s) => !dialog.contains(s))
      .map((s) => s.getAttribute('data-page'))
      .sort(),
    title: dialog.querySelector('[data-step-heading]')?.textContent?.trim() ?? '',
    checked: dialog
      .querySelector('[data-theme-choice][aria-checked="true"]')
      ?.getAttribute('data-theme-choice'),
    cards: [...dialog.querySelectorAll('[data-theme-choice]')].map((c) =>
      c.getAttribute('data-theme-choice'),
    ),
    language: dialog
      .querySelector('[role="group"] [data-state="on"], [data-state="on"][role="radio"]')
      ?.textContent?.trim()
      .replace(/\s+/g, ' ')
      .split(' ')[0],
    step: dialog.querySelector('.step-label')?.textContent?.trim() ?? '',
    skip: dialog.querySelector('[data-action="skip"]') !== null,
    paper,
    // A step fits the 720 × 540 dialog: its body does not scroll.
    body: {
      scrollHeight: body?.scrollHeight ?? Infinity,
      clientHeight: body?.clientHeight ?? 0,
      bottom: body?.getBoundingClientRect().bottom ?? 0,
    },
    cardsBottom: Math.max(
      ...[...dialog.querySelectorAll('[data-theme-choice]')].map((c) => c.getBoundingClientRect().bottom),
    ),
  }
}
