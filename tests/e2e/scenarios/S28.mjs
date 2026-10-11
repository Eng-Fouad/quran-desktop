// @ts-check
// S28 (§12.6; WP8e): Mushaf zoom 200 % on pages 261–262, the canvas scrolled to the middle of page 262. Asserts §8.13
// and §8.1: zoom doubles `qfs` (quarter-px steps) without changing the spread decision, the canvas scrolls on both
// axes with overlay scrollbars (no layout width taken), the page is drawn in px from `--qfs` (no CSS zoom or scale on
// the page, so the glyphs stay crisp), and the wheel scrolls instead of turning the page.
import { check, equal, mushaf } from '../lib/index.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'both',
  settings: { mushafStyle: 'hafs', pageMode: 'auto', zoomPct: 100 },
  description: 'Zoom 200 % on page 262 (spread 261–262), canvas scrolled into page 262',
}

const PAGE = 262

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s28(ctx) {
  const { qd } = ctx
  await qd.goto({ type: 'page', data: { page: PAGE } })
  await qd.waitIdle()
  const fit = await qd.state()
  equal(fit.visiblePages, [261, 262], 'the spread at the fit')

  await qd.setSettings({ zoomPct: 200 })
  await qd.waitIdle()
  const zoomed = await qd.state()
  equal(zoomed.settings.zoomPct, 200, 'zoomPct')
  equal(zoomed.spread, fit.spread, 'zoom keeps the spread decision (geometry only, §8.2)')
  equal(zoomed.visiblePages, [261, 262], 'the pages on screen')
  // The fit is floored to quarter px before and after the zoom, so 2 × the fitted qfs is within one quarter step.
  check(
    zoomed.qfs >= 2 * fit.qfs && zoomed.qfs < 2 * (fit.qfs + 0.25) && (zoomed.qfs * 4) % 1 === 0,
    `qfs ${zoomed.qfs} at 200 %, fit ${fit.qfs}: expected twice the fit in quarter-px steps`,
  )

  // Scroll the canvas to the middle of page 262's text block (the left page).
  const scrolled = await ctx.page.evaluate((pageNo) => {
    const viewport = /** @type {HTMLElement | null} */ (
      document.querySelector('.mushaf-view [data-scroll-area-viewport]')
    )
    const block = document.querySelector(`section.mp[data-page="${pageNo}"] .mp-block`)
    if (!viewport || !block) return null
    const v = viewport.getBoundingClientRect()
    const b = block.getBoundingClientRect()
    viewport.scrollLeft += b.left + b.width / 2 - (v.left + v.width / 2)
    viewport.scrollTop += b.top + b.height * 0.42 - (v.top + v.height / 2)
    return null
  }, PAGE)
  check(scrolled === null, 'the canvas viewport exists')
  await qd.waitIdle()

  const report = await ctx.page.evaluate(inspectCanvas, PAGE)
  ctx.log(JSON.stringify(report.summary))
  check(report.ok, report.problems.join('\n'))

  // The wheel scrolls past the fit; it never turns the page.
  const wheel = await ctx.page.evaluate(() => {
    const view = document.querySelector('.mushaf-view')
    const e = new WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true })
    view?.dispatchEvent(e)
    return e.defaultPrevented
  })
  equal(wheel, false, 'a plain wheel event is left to native scrolling while zoomed')
  equal((await qd.state()).visiblePages, [261, 262], 'the pages after a wheel event')

  // The zoom indicator shows for 0.9 s after a zoom change (§8.13): let it go before the review shots.
  await ctx.wait(1200)
  await ctx.shot()
  await ctx.shot('block', { selector: `${mushaf.page(PAGE)} .mp-block` })
}

/**
 * Runs in the page: checks the zoomed canvas and the page box.
 * @param {number} pageNo
 */
function inspectCanvas(pageNo) {
  /** @type {string[]} */
  const problems = []
  const view = document.querySelector('.mushaf-view')
  const viewport = /** @type {HTMLElement | null} */ (
    document.querySelector('.mushaf-view [data-scroll-area-viewport]')
  )
  const section = /** @type {HTMLElement | null} */ (
    document.querySelector(`section.mp[data-page="${pageNo}"]`)
  )
  if (!view || !viewport || !section)
    return { ok: false, problems: ['no canvas, viewport or page'], summary: {} }
  const qfs = Number.parseFloat(section.style.getPropertyValue('--qfs'))
  const v = viewport.getBoundingClientRect()
  const outer = view.getBoundingClientRect()
  if (viewport.scrollWidth <= viewport.clientWidth) problems.push('the canvas does not scroll horizontally')
  if (viewport.scrollHeight <= viewport.clientHeight) problems.push('the canvas does not scroll vertically')
  if (viewport.scrollTop <= 0) problems.push('the canvas is not scrolled down')
  // Overlay scrollbars: the viewport keeps the whole canvas width and height.
  if (Math.abs(viewport.clientWidth - outer.width) > 1 || Math.abs(viewport.clientHeight - outer.height) > 1)
    problems.push(
      `scrollbars take layout space: ${viewport.clientWidth}×${viewport.clientHeight} in ${outer.width}×${outer.height}`,
    )
  // Crisp at any zoom (§8.1 invariant 4): the page is sized from --qfs, never scaled.
  const box = section.getBoundingClientRect()
  if (Math.abs(box.width - 21 * qfs) > 0.75) problems.push(`page width ${box.width}, expected ${21 * qfs}`)
  const style = getComputedStyle(section)
  if (style.zoom !== '1') problems.push(`page zoom ${style.zoom}`)
  if (style.transform !== 'none') problems.push(`page transform ${style.transform}`)
  const block = section.querySelector('.mp-block')?.getBoundingClientRect()
  if (!block) problems.push('no .mp-block')
  else {
    const visible = Math.min(block.right, v.right) - Math.max(block.left, v.left)
    if (visible < block.width * 0.5) problems.push(`page ${pageNo}'s text block is mostly out of view`)
  }
  const line = /** @type {HTMLElement | null} */ (section.querySelector('.mp-glyphs .ln[data-k="ayah"]'))
  const scale = Number.parseFloat(
    getComputedStyle(section.querySelector('.mp-glyphs') ?? section).getPropertyValue('--glyph-scale'),
  )
  if (line && Number.isFinite(scale)) {
    const size = Number.parseFloat(getComputedStyle(line).fontSize)
    if (Math.abs(size - qfs * scale) > 0.5) problems.push(`glyph size ${size}, expected ${qfs * scale}`)
  }
  return {
    ok: problems.length === 0,
    problems,
    summary: {
      qfs,
      scroll: [Math.round(viewport.scrollLeft), Math.round(viewport.scrollTop)],
      content: [viewport.scrollWidth, viewport.scrollHeight],
      viewport: [viewport.clientWidth, viewport.clientHeight],
    },
  }
}
