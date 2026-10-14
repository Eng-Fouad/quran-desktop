// @ts-check
// S14: 2:255 selected on page 42 and the study pane open on its Translation tab. In the browser mock Saheeh
// International is marked installed in the mock catalogue (the `packs` slice) and the app relaunched, the way a reader
// who installed it would open it; then a double-click on a word of 2:255 selects the ayah and opens the pane. Asserts
// the selection, the docked pane beside the page (no overlap), the 56 px header ("Al-Baqarah 2:255", rosette, Naskh
// name, juz and page), the Translation tab with the Arabic in qd-hafs and the translation in English at 16 px with its
// translator label. Writes the viewport and a close-up of the pane.
import { check, equal, mushaf, waitUntil } from '../lib/index.mjs'
import { installPacks } from './S21.mjs'

export const PACK = 'tr.en.saheeh'
/** 2:255 (Ayat al-Kursi). */
export const AYAH_ID = 262
export const PAGE = 42

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'web',
  settings: { mushafStyle: 'hafs', pageMode: 'auto', translations: [PACK], translationArabic: true },
  description: '2:255 selected, side pane translation open',
}

/**
 * Opens the study pane on an ayah of the page by a pointer gesture: a double-click on one of its words (Translation
 * tab), or a click on its end-of-ayah marker (Tafsir tab). Waits until the pane heads that ayah.
 * @param {import('../lib/types').ScenarioContext} ctx
 * @param {number} ayahId
 * @param {'word' | 'marker'} how
 */
export async function openPaneOn(ctx, ayahId, how) {
  const { qd, page } = ctx
  await qd.goto({ type: 'ayah', data: { ayahId } })
  await qd.waitIdle()
  if (how === 'word') {
    const word = page.locator(`${mushaf.words(PAGE)}[data-a="${ayahId}"]:not(.e)`).nth(1)
    equal(await word.count(), 1, `a word of ayah ${ayahId} on page ${PAGE}`)
    await word.dblclick()
  } else {
    const marker = page.locator(`${mushaf.words(PAGE)}.e[data-a="${ayahId}"]`).first()
    equal(await marker.count(), 1, `the end marker of ayah ${ayahId} on page ${PAGE}`)
    await marker.click()
  }
  await waitUntil(
    async () =>
      (await qd.state()).selection?.fromAyahId === ayahId &&
      (await page.locator('[data-qd-pane] .ayah-header').count()) === 1,
    { timeout: 10_000, message: `the study pane open on ayah ${ayahId}` },
  )
  await qd.waitIdle()
}

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s14(ctx) {
  const { qd, page } = ctx
  if (ctx.mode !== 'web') ctx.pending('S14 seeds an installed translation in the browser mock')
  await installPacks(ctx, [PACK])
  await openPaneOn(ctx, AYAH_ID, 'word')

  const state = await qd.state()
  equal(state.selection, { fromAyahId: AYAH_ID, toAyahId: AYAH_ID, anchorAyahId: AYAH_ID }, 'selection')
  equal(state.sidePaneOpen, true, 'side pane open')
  equal(state.settings.sidePane.tab, 'translation', 'the Translation tab')
  check(state.visiblePages.includes(PAGE), `page ${PAGE} on screen (${state.visiblePages.join(',')})`)

  await waitUntil(
    () =>
      page.evaluate(
        (id) => document.querySelector(`[data-qd-pane] .ayah[data-ayah="${id}"] section.tr .text`) !== null,
        AYAH_ID,
      ),
    { timeout: 10_000, message: 'the translation of 2:255 in the pane' },
  )
  const report = await page.evaluate(inspectPane, { ayahId: AYAH_ID, page: PAGE })
  ctx.log(JSON.stringify(report))
  check(report.problems.length === 0, report.problems.join('\n'))

  await ctx.shot()
  await ctx.shot('pane', { selector: 'aside[data-qd-region="side-pane"]' })
}

/**
 * Runs in the page: the docked pane, its header and the Translation tab.
 * @param {{ ayahId: number, page: number }} args
 */
function inspectPane({ ayahId, page }) {
  /** @type {string[]} */
  const problems = []
  const plain = (/** @type {Element | null | undefined} */ el) =>
    (el?.textContent ?? '').replace(/[⁦-⁩]/gu, '').replace(/\s+/g, ' ').trim()
  const aside = document.querySelector('aside[data-qd-region="side-pane"]')
  const sheet = document.querySelector('[role="dialog"] [data-qd-pane]')
  if (!aside) problems.push(sheet ? 'the pane is a sheet, not docked' : 'no docked side pane')
  const pane = aside?.getBoundingClientRect()
  const book = document.querySelector(`section.mp[data-page="${page}"]`)?.getBoundingClientRect()
  if (pane && book && book.right > pane.left + 0.5) problems.push(`page ${page} overlaps the pane`)
  if (pane && Math.abs(pane.right - innerWidth) > 1)
    problems.push('the pane is not at the inline end (LTR: right)')

  const header = document.querySelector('[data-qd-pane] .ayah-header')
  const h = header?.getBoundingClientRect()
  if (!h || Math.round(h.height) !== 56) problems.push(`header height ${h?.height}`)
  const title = plain(header?.querySelector('.title'))
  if (title !== 'Al-Baqarah 2:255') problems.push(`heading "${title}"`)
  if (plain(header?.querySelector('.rosette .num')) !== '255') problems.push('rosette number')
  const meta = plain(header?.querySelector('.meta'))
  if (meta !== 'البقرة · Juz 3 · Page 42') problems.push(`meta line "${meta}"`)

  const selected = document.querySelector('[data-qd-pane] [role="tab"][aria-selected="true"]')
  if (plain(selected) !== 'Translation') problems.push(`selected tab "${plain(selected)}"`)

  const arabic = document.querySelector(`[data-qd-pane] .ayah[data-ayah="${ayahId}"] .arabic`)
  if (!arabic) problems.push('no Arabic text')
  else {
    const cs = getComputedStyle(arabic)
    if (!cs.fontFamily.includes('qd-hafs')) problems.push(`Arabic font ${cs.fontFamily}`)
    if (arabic.getAttribute('dir') !== 'rtl') problems.push('Arabic direction')
  }
  const block = document.querySelector(`[data-qd-pane] .ayah[data-ayah="${ayahId}"] section.tr`)
  if (!block) problems.push('no translation block')
  else {
    if (block.getAttribute('lang') !== 'en' || block.getAttribute('dir') !== 'ltr')
      problems.push('block language')
    if (plain(block.querySelector('.label')) !== 'Saheeh International') problems.push('translator label')
    const text = block.querySelector('.text')
    const size = text ? getComputedStyle(text).fontSize : ''
    if (size !== '16px') problems.push(`reading size ${size}`)
  }
  return { title, meta, pane: pane && { x: pane.left, w: pane.width }, problems }
}
