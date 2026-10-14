// @ts-check
// S12: page 255, qcf_v2, in the default paper theme and page mode (a 255–256 spread at 1600×1000). Ar-Ra'd ends on
// line 2, which the layout centres; Ibrahim's header and basmala follow on lines 3–4. Asserts the geometry of both
// pages: page and block boxes, the outer margins of an odd (right) and an even (left) page, the line grid, justified
// lines filling their line box, the centred line, and the bounded line-fit.
import { check, equal, mushaf } from '../lib/index.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'both',
  settings: { mushafStyle: 'qcf_v2', pageMode: 'auto' },
  description:
    'Page 255, qcf_v2: the centred line 2 before the surah 14 header, spread geometry and line-fit',
}

const PAGE = 255

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s12(ctx) {
  const { qd } = ctx
  await qd.goto({ type: 'page', data: { page: PAGE } })
  await qd.waitIdle()

  const state = await qd.state()
  equal(state.style, 'qcf_v2', 'the Mushaf style')
  equal(state.resolvedTheme, 'paper', 'the resolved theme')
  equal(state.visiblePages.includes(PAGE), true, `page ${PAGE} on screen (${state.visiblePages.join(', ')})`)

  const section = ctx.page.locator(mushaf.page(PAGE))
  equal(await section.count(), 1, 'rendered page-255 sections')
  equal(await section.getAttribute('data-side'), 'right', 'data-side (odd pages sit on the right)')

  for (const pageNo of state.visiblePages) {
    const report = await ctx.page.evaluate(measurePage, pageNo)
    ctx.log(`page ${pageNo}, qfs ${state.qfs}: ${JSON.stringify(report.summary)}`)
    check(report.ok, `page ${pageNo}:\n${report.problems.join('\n')}`)
    if (pageNo === PAGE) {
      equal(report.centred, [2], 'centred ayah lines of page 255')
      equal(report.headers, [3], 'surah_name lines of page 255')
      equal(report.basmalas, [4], 'basmallah lines of page 255')
      equal(report.lines, 15, 'lines in the grid of page 255')
    }
  }

  await ctx.shot()
  await ctx.shot('page', { selector: mushaf.page(PAGE) })
}

/**
 * Runs in the page: measures one page's geometry. Returns a summary and a list of problems.
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
      if (!near(words.left - box.left, box.right - words.right, 1.5))
        problems.push(
          `centred line ${n} is off-centre (${words.left - box.left} / ${box.right - words.right})`,
        )
    } else if (!near(words.left, box.left, 1) || !near(words.right, box.right, 1)) {
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
