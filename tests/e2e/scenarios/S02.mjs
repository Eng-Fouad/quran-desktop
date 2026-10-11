// @ts-check
// S02 (§12.6, §9.7; WP12c): onboarding step 2 (reading setup) in the Arabic UI.
//
// The onboarding opens over the page 1–2 spread in the Arabic UI and moves to step 2 with "التالي". The step mirrors
// (`dir="rtl"`): the Mushaf style cards run right to left, Hafs is selected with "Ornate surah headers" ticked, a
// QCF card offers "Download all pages" unticked, the translation is preselected from the UI language (Arabic →
// At-Tafsir Al-Muyassar, WP5a) and the reciter is Mishary Alafasy, with the listen button and the streaming note.
// Both Arabic steps fit the 720 × 540 dialog: the body never scrolls (Arabic runs taller than English).
// Shots: S02.png (the window), S02-dialog (the dialog), S02-offline (Work offline on: the QCF cards locked).
import { check, equal, waitUntil } from '../lib/index.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'ar',
  theme: 'system',
  colorScheme: 'light',
  mode: 'web',
  settings: { onboardingDone: false, networkAllowed: true },
  description: 'Onboarding step 2 (Mushaf style, translation, reciter) in the Arabic UI',
}

const DIALOG = '[role="dialog"].qd-onboarding'

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s02(ctx) {
  const { page, qd } = ctx
  await qd.goto({ type: 'page', data: { page: 1 } })
  await qd.openOverlay('onboarding')
  await page.locator(DIALOG).waitFor({ state: 'visible' })
  await qd.waitIdle()
  await ctx.wait(400)
  const welcome = await page.evaluate(bodyFit, DIALOG)
  ctx.log(`step 1 body: ${JSON.stringify(welcome)}`)
  check(
    welcome.scrollHeight <= welcome.clientHeight,
    `step 1 fits without scrolling in Arabic (${welcome.scrollHeight} ≤ ${welcome.clientHeight})`,
  )
  check(
    welcome.cardsBottom <= welcome.bottom + 0.5,
    `step 1's theme cards end inside the body (${welcome.cardsBottom})`,
  )
  await page.locator(`${DIALOG} [data-action="next"]`).click()
  await page.locator(`${DIALOG} .steps[data-step="reading"]`).waitFor({ state: 'visible' })
  await waitUntil(async () => (await page.locator(`${DIALOG} [data-style-choice]`).count()) === 3, {
    timeout: 5000,
    message: 'the style cards did not render',
  })
  await qd.waitIdle()
  await ctx.wait(400)

  const report = await page.evaluate(inspect, DIALOG)
  ctx.log(JSON.stringify(report))
  equal(report.dir, 'rtl', 'the dialog mirrors')
  equal(report.title, 'اختر طريقة قراءتك', 'step title')
  equal(report.step, 'الخطوة ٢ من ٤', 'progress in Arabic digits')
  equal(report.checked, 'hafs', 'Hafs is selected')
  check(report.firstCardRight > report.lastCardRight, 'the cards run right to left')
  equal(report.ornaments, true, 'ornate surah headers ticked')
  equal(report.translation, 'التفسير الميسر', 'the Arabic default translation (Al-Muyassar)')
  equal(report.reciter, 'مشاري راشد العفاسي', 'default reciter')
  check(report.focusOnTitle, 'focus moved to the step title')
  const reading = await page.evaluate(bodyFit, DIALOG)
  check(
    reading.scrollHeight <= reading.clientHeight,
    `step 2 fits without scrolling in Arabic (${reading.scrollHeight} ≤ ${reading.clientHeight})`,
  )
  await ctx.shot()
  await ctx.shot('dialog', { selector: DIALOG })

  // A QCF card offers every page in the background, off by default; Hafs comes back with its ornaments ticked.
  await page.locator(`${DIALOG} [data-style-choice="qcf_v2"]`).click()
  equal(
    await page.locator(`${DIALOG} [data-style-choice="qcf_v2"]`).getAttribute('aria-checked'),
    'true',
    'QCF V2',
  )
  equal(
    await page.locator(`${DIALOG} [data-option="all-pages"]`).isChecked(),
    false,
    '"Download all pages" is off',
  )
  await page.locator(`${DIALOG} [data-style-choice="hafs"]`).click()
  equal(await page.locator(`${DIALOG} [data-option="ornaments"]`).isChecked(), true, 'ornaments ticked again')

  // Work offline (step 3's switch) locks the QCF cards and keeps the style on Hafs.
  await qd.setSettings({ networkAllowed: false })
  await qd.waitIdle()
  await ctx.wait(200)
  equal(
    await page.locator(`${DIALOG} [data-style-choice="qcf_v2"]`).getAttribute('aria-disabled'),
    'true',
    'QCF V2 locked offline',
  )
  check((await page.locator(`${DIALOG} .style.locked`).count()) === 2, 'both QCF cards are locked')
  equal(
    await page.locator(`${DIALOG} [data-style-choice="hafs"]`).getAttribute('aria-checked'),
    'true',
    'Hafs stays',
  )
  await ctx.shot('offline', { selector: DIALOG })
}

/**
 * State of the reading step (runs in the page).
 * @param {string} selector
 */
function inspect(selector) {
  const dialog = /** @type {HTMLElement} */ (document.querySelector(selector))
  const cards = [...dialog.querySelectorAll('[data-style-choice]')]
  const ornaments = /** @type {HTMLInputElement | null} */ (dialog.querySelector('[data-option="ornaments"]'))
  const text = (/** @type {string} */ s) => dialog.querySelector(s)?.textContent?.trim() ?? ''
  return {
    dir: getComputedStyle(dialog).direction,
    title: text('[data-step-heading]'),
    step: text('.step-label'),
    checked: dialog
      .querySelector('[data-style-choice][aria-checked="true"]')
      ?.getAttribute('data-style-choice'),
    firstCardRight: cards[0]?.getBoundingClientRect().right ?? 0,
    lastCardRight: cards[cards.length - 1]?.getBoundingClientRect().right ?? 0,
    ornaments: ornaments?.checked ?? null,
    translation: text('.ob-translation .value'),
    reciter: text('.ob-reciter .value'),
    focusOnTitle: document.activeElement?.hasAttribute('data-step-heading') ?? false,
  }
}

/**
 * The dialog body's scroll and box, and where step 1's theme cards end (runs in the page).
 * @param {string} selector
 */
function bodyFit(selector) {
  const dialog = /** @type {HTMLElement} */ (document.querySelector(selector))
  const body = /** @type {HTMLElement | null} */ (dialog.querySelector(':scope > .body'))
  const cards = [...dialog.querySelectorAll('[data-theme-choice]')].map(
    (c) => c.getBoundingClientRect().bottom,
  )
  return {
    scrollHeight: body?.scrollHeight ?? Infinity,
    clientHeight: body?.clientHeight ?? 0,
    bottom: body?.getBoundingClientRect().bottom ?? 0,
    cardsBottom: cards.length > 0 ? Math.max(...cards) : 0,
  }
}
