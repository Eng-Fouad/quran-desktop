// @ts-check
// S22: the study pane's Tafsir tab in the Arabic UI, with At-Tafsir Al-Muyassar. In the browser mock the pack is marked
// installed (the `packs` slice) and the app relaunched; a click on the end-of-ayah marker of 2:255 selects it and opens
// the pane on its Tafsir tab. Asserts the mirrored shell (the pane docked on the left, beside the page), the Arabic
// heading with Arabic-Indic digits, the tafsir right to left in Naskh 18 px at leading 2.0, and the source footer.
// Writes the viewport and a close-up of the pane.
import { check, equal } from '../lib/index.mjs'
import { AYAH_ID, openPaneOn, PAGE } from './S14.mjs'
import { installPacks } from './S21.mjs'

export const TAFSIR = 'tafsir.ar.muyassar'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'ar',
  theme: 'paper',
  mode: 'web',
  settings: { mushafStyle: 'hafs', pageMode: 'auto', tafsirPackId: TAFSIR },
  description: 'Tafsir tab, Arabic (muyassar), RTL',
}

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s22(ctx) {
  const { qd, page } = ctx
  if (ctx.mode !== 'web') ctx.pending('S22 seeds an installed tafsir in the browser mock')
  await installPacks(ctx, [TAFSIR])
  await openPaneOn(ctx, AYAH_ID, 'marker')

  const state = await qd.state()
  equal(state.dir, 'rtl', 'UI direction')
  equal(state.settings.sidePane.tab, 'tafsir', 'the end marker opens the Tafsir tab')
  equal(state.settings.tafsirPackId, TAFSIR, 'the tafsir')

  await page.locator('[data-qd-pane] .entry .text').first().waitFor({ state: 'visible', timeout: 10_000 })
  await qd.waitIdle()
  const report = await page.evaluate(inspectTafsir, PAGE)
  ctx.log(JSON.stringify(report))
  check(report.problems.length === 0, report.problems.join('\n'))

  await ctx.shot()
  await ctx.shot('pane', { selector: 'aside[data-qd-region="side-pane"]' })
}

/**
 * Runs in the page: the mirrored pane and the tafsir typography.
 * @param {number} pageNumber
 */
function inspectTafsir(pageNumber) {
  /** @type {string[]} */
  const problems = []
  const plain = (/** @type {Element | null | undefined} */ el) =>
    (el?.textContent ?? '').replace(/[⁦-⁩]/gu, '').replace(/\s+/g, ' ').trim()
  const aside = document.querySelector('aside[data-qd-region="side-pane"]')
  const pane = aside?.getBoundingClientRect()
  if (!pane) problems.push('no docked side pane')
  else if (pane.left > 1) problems.push(`the pane is not on the left in the Arabic UI (x = ${pane.left})`)
  const book = document.querySelector(`section.mp[data-page="${pageNumber}"]`)?.getBoundingClientRect()
  if (pane && book && book.left < pane.right - 0.5) problems.push('the page overlaps the pane')

  const header = document.querySelector('[data-qd-pane] .ayah-header')
  const title = plain(header?.querySelector('.title'))
  if (title !== 'البقرة ٢:٢٥٥') problems.push(`heading "${title}"`)
  if (header && getComputedStyle(header).direction !== 'rtl') problems.push('header direction')
  const selected = plain(document.querySelector('[data-qd-pane] [role="tab"][aria-selected="true"]'))
  if (selected !== 'التفسير') problems.push(`selected tab "${selected}"`)

  const entry = document.querySelector('[data-qd-pane] .entry')
  const text = entry?.querySelector('.text')
  if (!entry || !text) problems.push('no tafsir entry')
  else {
    if (entry.getAttribute('dir') !== 'rtl' || entry.getAttribute('lang') !== 'ar')
      problems.push('entry lang/dir')
    const cs = getComputedStyle(text)
    if (!cs.fontFamily.includes('Noto Naskh Arabic')) problems.push(`tafsir font ${cs.fontFamily}`)
    if (cs.fontSize !== '18px') problems.push(`tafsir size ${cs.fontSize}`)
    if (cs.lineHeight !== '36px') problems.push(`tafsir leading ${cs.lineHeight}`)
    if (cs.direction !== 'rtl' || cs.textAlign !== 'start')
      problems.push(`alignment ${cs.direction} ${cs.textAlign}`)
  }
  const footer = plain(document.querySelector('[data-qd-pane] .source'))
  if (!footer.includes('التفسير الميسر')) problems.push(`footer "${footer}"`)
  return { title, selected, footer, problems }
}
