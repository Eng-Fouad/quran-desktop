// @ts-check
// S29: a 1024×700 window at UI scale 130 %. The canvas is too short for a legible page, so `qfs` holds at the
// legibility floor `QFS_MIN = 18` and the canvas scrolls vertically instead of shrinking the glyphs. Asserts the fit
// the reader chose against `fitLayout` for the measured canvas, a single page at `qfs` 18 (a spread would not fit the
// width at the floor, so the floor beats the spread preference), the vertical scroll only (overlay scrollbars), and
// that the wheel scrolls instead of turning the page.
//
// UI scale is webview zoom in the app; the browser mock approximates it with CSS `zoom` on <html> and divides the
// window size by it, so in both modes the window is 788×538 CSS px and the sidebar floats.
import { check, equal } from '../lib/index.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1024, 700],
  ui: 'en',
  theme: 'paper',
  mode: 'both',
  settings: { uiScalePct: 130, mushafStyle: 'hafs', pageMode: 'auto', zoomPct: 100 },
  description: '1024×700 at UI scale 130 %: qfs held at 18 (QFS_MIN), the canvas scrolls vertically',
}

const QFS_MIN = 18

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s29(ctx) {
  const { qd } = ctx
  await qd.goto({ type: 'page', data: { page: 1 } })
  await qd.waitIdle()
  const state = await qd.state()
  equal(state.settings.uiScalePct, 130, 'uiScalePct')

  const canvas = await ctx.page.evaluate(() => {
    const view = /** @type {HTMLElement | null} */ (document.querySelector('.mushaf-view'))
    const viewport = /** @type {HTMLElement | null} */ (
      document.querySelector('.mushaf-view [data-scroll-area-viewport]')
    )
    return view && viewport
      ? {
          w: view.clientWidth,
          h: view.clientHeight,
          scrollHeight: viewport.scrollHeight,
          clientHeight: viewport.clientHeight,
          clientWidth: viewport.clientWidth,
        }
      : null
  })
  check(canvas !== null, 'the Mushaf canvas exists')
  ctx.log(
    `canvas ${canvas.w}×${canvas.h}: ${state.spread ? 'spread' : 'single'}, ${state.dock}, qfs ${state.qfs}`,
  )

  const expected = fit(canvas.w, canvas.h)
  equal(state.spread, expected.spread, `spread for a ${canvas.w}×${canvas.h} canvas (fitLayout)`)
  equal(state.dock, expected.dock, 'dock placement')
  check(expected.fit < QFS_MIN, `the canvas fits a page at ${expected.fit.toFixed(2)} px, below QFS_MIN`)
  check(state.qfs >= QFS_MIN, `qfs ${state.qfs} below the legibility floor ${QFS_MIN}`)
  equal(state.qfs, QFS_MIN, 'qfs held at QFS_MIN')
  equal(state.visiblePages, [1], 'a single page')

  check(canvas.scrollHeight > canvas.clientHeight, 'the canvas scrolls vertically')
  const scrollWidth = await ctx.page.evaluate(
    () => document.querySelector('.mushaf-view [data-scroll-area-viewport]')?.scrollWidth ?? 0,
  )
  check(scrollWidth <= canvas.clientWidth + 1, `no horizontal scroll (scrollWidth ${scrollWidth})`)
  equal(canvas.clientWidth, canvas.w, 'overlay scrollbars take no width')

  const wheel = await ctx.page.evaluate(() => {
    const view = document.querySelector('.mushaf-view')
    const e = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })
    view?.dispatchEvent(e)
    return e.defaultPrevented
  })
  equal(wheel, false, 'below the floor the wheel scrolls')

  await ctx.shot()
}

/**
 * `fitLayout` at zoom 100 in page mode `auto`, with the legibility floor ranked above the spread preference (the
 * acceptance values are unit-tested in `geometry.test.ts`).
 * @param {number} canvasW
 * @param {number} canvasH
 */
function fit(canvasW, canvasH) {
  const PAD_X = 24
  const PAD_Y = 16
  const SIDE_DOCK_W = 288
  const PW = 21
  const PH = 31.95
  const SINGLE_W = 22
  const barReserve = canvasH < 860 ? 64 : 84
  const barDock = canvasH < 860 ? 'compact' : 'bar'
  const hSide = (canvasH - 2 * PAD_Y) / PH
  const hBar = (canvasH - 2 * PAD_Y - barReserve) / PH
  const wSide = canvasW - 2 * PAD_X - SIDE_DOCK_W
  const wBar = canvasW - 2 * PAD_X
  if (2 * PW * hSide <= wSide) return { spread: true, dock: 'side', fit: hSide }
  const single =
    SINGLE_W * hSide <= wSide
      ? { q: hSide, dock: 'side' }
      : { q: Math.min(hBar, wBar / SINGLE_W), dock: barDock }
  const barSingle = { q: Math.min(hBar, wBar / SINGLE_W), dock: barDock }
  const barSpreadQ = Math.min(hBar, wBar / (2 * PW))
  if (barSpreadQ >= 0.85 * single.q) {
    const floor = floorSingle(barSpreadQ, single, barSingle, wSide, wBar)
    if (floor) return { spread: false, dock: floor.dock, fit: floor.q }
    return { spread: true, dock: barDock, fit: barSpreadQ }
  }
  return { spread: false, dock: single.dock, fit: single.q }
}

/**
 * @param {number} spreadQ
 * @param {{ q: number, dock: string }} single
 * @param {{ q: number, dock: string }} barSingle
 * @param {number} wSide
 * @param {number} wBar
 */
function floorSingle(spreadQ, single, barSingle, wSide, wBar) {
  const PW = 21
  const SINGLE_W = 22
  if (spreadQ >= QFS_MIN) return null
  if (single.q >= QFS_MIN) return single
  if (2 * PW * QFS_MIN <= wBar) return null
  if (single.dock === 'side' && SINGLE_W * QFS_MIN <= wSide) return single
  if (SINGLE_W * QFS_MIN <= wBar) return barSingle
  return null
}
