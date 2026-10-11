// @ts-check
// S07 (§12.6; WP8a): page 604 alone (single-page mode), qcf_v2, black theme. Three surah headers (112, 113, 114), each
// with its basmala, and the centred ayah lines 4, 9, 14 and 15 of the layout. Asserts the §8.2/§8.3/§8.4 geometry of
// the page in the browser: page and block boxes in qfs units, the 15-line grid, justified lines that fill their line
// box exactly, centred lines in the middle, and the bounded line-fit (never a horizontal-only squeeze below 0.96).
import { check, equal, mushaf } from '../lib/index.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'black',
  mode: 'both',
  settings: { mushafStyle: 'qcf_v2', pageMode: 'single' },
  description:
    'Page 604 single, qcf_v2, black: 3 headers, centred lines 4/9/14/15, page geometry and line-fit',
}

const PAGE = 604

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s07(ctx) {
  const { qd } = ctx
  await qd.goto({ type: 'page', data: { page: PAGE } })
  await qd.waitIdle()

  const state = await qd.state()
  equal(state.page, PAGE, 'reader.page')
  equal(state.spread, false, 'single-page mode')
  equal(state.visiblePages, [PAGE], 'the pages on screen')
  equal(state.style, 'qcf_v2', 'the Mushaf style')
  equal(state.resolvedTheme, 'black', 'the resolved theme')

  const section = ctx.page.locator(mushaf.page(PAGE))
  equal(await section.count(), 1, 'rendered page-604 sections')
  equal(await section.getAttribute('data-style'), 'qcf_v2', 'data-style')
  equal(await section.getAttribute('data-layout'), 'v2', 'data-layout')
  equal(await section.getAttribute('data-side'), 'left', 'data-side (even pages sit on the left)')

  const report = await ctx.page.evaluate(measurePage, PAGE)
  ctx.log(`qfs ${state.qfs}: ${JSON.stringify(report.summary)}`)
  check(report.ok, report.problems.join('\n'))

  // The page's line grid (§8.3): three header pairs and the centred lines of the layout.
  equal(report.headers, [1, 5, 10], 'surah_name lines')
  equal(report.basmalas, [2, 6, 11], 'basmallah lines')
  equal(report.centred, [4, 9, 14, 15], 'centred ayah lines')
  equal(report.lines, 15, 'lines in the grid')
  const words = await ctx.page.locator(mushaf.words(PAGE)).count()
  equal(words, report.words, 'word spans in the visible rendition')

  await ctx.shot()
  await ctx.shot('page', { selector: mushaf.page(PAGE) })
}

/**
 * Runs in the page: measures the page's geometry against §8.2–§8.4. Returns a summary and a list of problems.
 * @param {number} pageNo
 */
function measurePage(pageNo) {
  /** @type {string[]} */
  const problems = []
  const section = /** @type {HTMLElement | null} */ (
    document.querySelector(`section.mp[data-page="${pageNo}"]`)
  )
  if (!section) return { ok: false, problems: [`no section.mp for page ${pageNo}`] }
  const qfs = Number.parseFloat(section.style.getPropertyValue('--qfs'))
  const near = (/** @type {number} */ a, /** @type {number} */ b, tol = 0.75) => Math.abs(a - b) <= tol
  const page = section.getBoundingClientRect()
  if (!near(page.width, 21 * qfs) || !near(page.height, 31.95 * qfs))
    problems.push(`page box ${page.width}×${page.height}, expected ${21 * qfs}×${31.95 * qfs}`)
  const blockEl = section.querySelector('.mp-block')
  if (!blockEl) return { ok: false, problems: ['no .mp-block'] }
  const block = blockEl.getBoundingClientRect()
  if (!near(block.width, 16.5 * qfs) || !near(block.height, 26.25 * qfs))
    problems.push(`block ${block.width}×${block.height}, expected ${16.5 * qfs}×${26.25 * qfs}`)
  if (!near(block.top - page.top, 2.85 * qfs)) problems.push(`block top ${block.top - page.top}`)
  const side = section.dataset.side
  const outer = side === 'right' ? page.right - block.right : block.left - page.left
  if (!near(outer, 2.75 * qfs)) problems.push(`outer margin ${outer}, expected ${2.75 * qfs}`)

  // The visible rendition: the last one in the stack (a cross-fade mounts the new one after the old one).
  const layers = [...section.querySelectorAll('.mp-glyphs')]
  const layer = layers.at(-1)
  if (!layer) return { ok: false, problems: [...problems, 'no .mp-glyphs rendition'] }
  const lines = /** @type {HTMLElement[]} */ ([...layer.querySelectorAll(':scope > .ln')])
  /** @type {number[]} */ const headers = []
  /** @type {number[]} */ const basmalas = []
  /** @type {number[]} */ const centred = []
  let minFit = 1
  for (const ln of lines) {
    const n = Number(ln.dataset.l)
    const box = ln.getBoundingClientRect()
    const opening = section.hasAttribute('data-opening')
    const expectedTop = (n - 1 + (opening ? 3.5 : 0)) * 1.75 * qfs
    if (!near(box.top - block.top, expectedTop) || !near(box.height, 1.75 * qfs))
      problems.push(
        `line ${n} at ${box.top - block.top}+${box.height}, expected ${expectedTop}+${1.75 * qfs}`,
      )
    if (ln.dataset.k === 'surah_name') headers.push(n)
    if (ln.dataset.k === 'basmallah') basmalas.push(n)
    const lw = /** @type {HTMLElement | null} */ (ln.querySelector(':scope > .lw'))
    if (!lw) continue
    if (ln.hasAttribute('data-c')) centred.push(n)
    const fx = Number.parseFloat(ln.style.getPropertyValue('--fx') || '1')
    const fy = Number.parseFloat(ln.style.getPropertyValue('--fy') || '1')
    minFit = Math.min(minFit, fx)
    if (fx < 0.96 && fy === 1) problems.push(`line ${n}: horizontal-only squeeze ${fx} below 0.96`)
    if (fy !== 1 && fy !== fx) problems.push(`line ${n}: non-uniform scale ${fx}×${fy} below 0.96`)
    const words = lw.getBoundingClientRect()
    if (ln.hasAttribute('data-c')) {
      // Centred: equal free space on both sides, never wider than the line.
      if (!near(words.left - box.left, box.right - words.right, 1.5))
        problems.push(
          `centred line ${n} is off-centre (${words.left - box.left} / ${box.right - words.right})`,
        )
    } else if (!near(words.left, box.left, 1) || !near(words.right, box.right, 1)) {
      // Justified: the words span the whole line box after the fit.
      problems.push(
        `justified line ${n} spans ${words.left}–${words.right}, line box ${box.left}–${box.right}`,
      )
    }
  }
  return {
    ok: problems.length === 0,
    problems,
    headers,
    basmalas,
    centred,
    lines: lines.length,
    words: layer.querySelectorAll('.w').length,
    summary: { qfs, renditions: layers.length, rendition: layer.getAttribute('data-rendition'), minFit },
  }
}
