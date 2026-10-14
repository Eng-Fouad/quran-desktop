// @ts-check
// S02: onboarding steps 2 and 3 (the Mushaf, then translation and recitation) in the Arabic UI.
//
// The onboarding opens over the page 1–2 spread in the Arabic UI and moves to step 2 with "التالي". The step mirrors
// (`dir="rtl"`): the Mushaf style cards stack at the inline start (right) with the live preview of page 1 beside them
// (left). A first run preselects the Madani print of 1421 AH with "Ornate surah headers" ticked and
// "Download all pages" unticked (owner 2026-10-11), and the preview draws that print. Step 3 has the translation,
// preselected from the UI language (Arabic → At-Tafsir Al-Muyassar), and the reciter Mishary Alafasy, with the listen
// button and the streaming note. Every Arabic step fits the 720 × 540 dialog: the body never scrolls (Arabic runs
// taller than English). Shots: S02.png (the window, step 2), S02-dialog (step 2), S02-reading (step 3), S02-offline
// (Work offline on, back on step 2: the QCF cards locked and the preview in Hafs).
import { check, equal, waitUntil } from '../lib/index.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'ar',
  theme: 'system',
  colorScheme: 'light',
  mode: 'web',
  settings: { onboardingDone: false, networkAllowed: true },
  description:
    'Onboarding steps 2 and 3 (the Mushaf with its preview, translation and reciter) in the Arabic UI',
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

  // Step 2: the Mushaf, with its live preview.
  await page.locator(`${DIALOG} [data-action="next"]`).click()
  await page.locator(`${DIALOG} .steps[data-step="mushaf"]`).waitFor({ state: 'visible' })
  await waitUntil(async () => (await page.locator(`${DIALOG} [data-style-choice]`).count()) === 3, {
    timeout: 5000,
    message: 'the style cards did not render',
  })
  await waitUntil(
    async () =>
      (await page
        .locator(`${DIALOG} [data-ob-preview] section.mp[data-page="1"][data-style="qcf_v2"]`)
        .count()) === 1,
    { timeout: 10_000, message: 'the preview did not draw page 1 of the 1421 AH print' },
  )
  await qd.waitIdle()
  await ctx.wait(400)

  const mushaf = await page.evaluate(inspectMushaf, DIALOG)
  ctx.log(JSON.stringify(mushaf))
  equal(mushaf.dir, 'rtl', 'the dialog mirrors')
  equal(mushaf.title, 'اختر مصحفك', 'step 2 title')
  equal(mushaf.step, 'الخطوة ٢ من ٥', 'progress in Arabic digits')
  equal(mushaf.skip, false, 'a first run offers no Skip')
  equal(mushaf.checked, 'qcf_v2', 'the 1421 AH print is preselected')
  equal(mushaf.ornaments, true, 'ornate surah headers ticked')
  equal(mushaf.allPages, false, '"Download all pages" is off')
  check(mushaf.cardsStacked, 'the style cards stack')
  check(mushaf.previewLeft, 'the preview sits at the inline end (left in Arabic)')
  check(mushaf.focusOnTitle, 'focus moved to the step title')
  const mushafFit = await page.evaluate(bodyFit, DIALOG)
  check(
    mushafFit.scrollHeight <= mushafFit.clientHeight,
    `step 2 fits without scrolling in Arabic (${mushafFit.scrollHeight} ≤ ${mushafFit.clientHeight})`,
  )
  await ctx.shot()
  await ctx.shot('dialog', { selector: DIALOG })

  // Hafs keeps the ornaments ticked and drops "Download all pages"; the preview follows at once.
  await page.locator(`${DIALOG} [data-style-choice="hafs"]`).click()
  await page.locator(`${DIALOG} [data-ob-preview][data-style="hafs"]`).waitFor({ state: 'visible' })
  equal(
    await page.locator(`${DIALOG} [data-option="ornaments"]`).isChecked(),
    true,
    'ornaments ticked with Hafs',
  )
  equal(
    await page.locator(`${DIALOG} [data-option="all-pages"]`).count(),
    0,
    'no "Download all pages" for Hafs',
  )
  await page.locator(`${DIALOG} [data-style-choice="qcf_v2"]`).click()
  await page.locator(`${DIALOG} [data-ob-preview][data-style="qcf_v2"]`).waitFor({ state: 'visible' })

  // Step 3: translation and recitation.
  await page.locator(`${DIALOG} [data-action="next"]`).click()
  await page.locator(`${DIALOG} .steps[data-step="reading"]`).waitFor({ state: 'visible' })
  await qd.waitIdle()
  await ctx.wait(400)
  const reading = await page.evaluate(inspectReading, DIALOG)
  ctx.log(JSON.stringify(reading))
  equal(reading.title, 'الترجمة والتلاوة', 'step 3 title')
  equal(reading.step, 'الخطوة ٣ من ٥', 'progress')
  equal(reading.translation, 'التفسير الميسر', 'the Arabic default translation (Al-Muyassar)')
  equal(reading.reciter, 'مشاري راشد العفاسي', 'default reciter')
  const readingFit = await page.evaluate(bodyFit, DIALOG)
  check(
    readingFit.scrollHeight <= readingFit.clientHeight,
    `step 3 fits without scrolling in Arabic (${readingFit.scrollHeight} ≤ ${readingFit.clientHeight})`,
  )
  await ctx.shot('reading', { selector: DIALOG })

  // Work offline (step 4's switch) locks the QCF cards; the style and the preview stay on Hafs.
  await page.locator(`${DIALOG} [data-action="back"]`).click()
  await page.locator(`${DIALOG} .steps[data-step="mushaf"]`).waitFor({ state: 'visible' })
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
  await page.locator(`${DIALOG} [data-ob-preview][data-style="hafs"]`).waitFor({ state: 'visible' })
  await ctx.shot('offline', { selector: DIALOG })
}

/**
 * State of the Mushaf step (runs in the page).
 * @param {string} selector
 */
function inspectMushaf(selector) {
  const dialog = /** @type {HTMLElement} */ (document.querySelector(selector))
  const cards = [...dialog.querySelectorAll('[data-style-choice]')].map((c) => c.getBoundingClientRect())
  const preview = dialog.querySelector('[data-ob-preview]')?.getBoundingClientRect()
  const input = (/** @type {string} */ option) =>
    /** @type {HTMLInputElement | null} */ (dialog.querySelector(`[data-option="${option}"]`))?.checked ??
    null
  const text = (/** @type {string} */ s) => dialog.querySelector(s)?.textContent?.trim() ?? ''
  return {
    dir: getComputedStyle(dialog).direction,
    title: text('[data-step-heading]'),
    step: text('.step-label'),
    skip: dialog.querySelector('[data-action="skip"]') !== null,
    checked: dialog
      .querySelector('[data-style-choice][aria-checked="true"]')
      ?.getAttribute('data-style-choice'),
    ornaments: input('ornaments'),
    allPages: input('all-pages'),
    cardsStacked: cards.every((c, i) => i === 0 || c.top >= (cards[i - 1]?.bottom ?? Infinity)),
    previewLeft: preview !== undefined && cards.every((c) => preview.right <= c.left),
    focusOnTitle: document.activeElement?.hasAttribute('data-step-heading') ?? false,
  }
}

/**
 * State of the translation and recitation step (runs in the page).
 * @param {string} selector
 */
function inspectReading(selector) {
  const dialog = /** @type {HTMLElement} */ (document.querySelector(selector))
  const text = (/** @type {string} */ s) => dialog.querySelector(s)?.textContent?.trim() ?? ''
  return {
    title: text('[data-step-heading]'),
    step: text('.step-label'),
    translation: text('.ob-translation .value'),
    reciter: text('.ob-reciter .value'),
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
