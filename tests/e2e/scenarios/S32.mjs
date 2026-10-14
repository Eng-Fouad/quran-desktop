// @ts-check
// S32: 1536×864 (1920×1080 at 125 %) with the sidebar open and the side pane open. The pane docks, the canvas is
// 784×824 and the reader shows a single page at qfs 22.75 with the compact bar. Asserts the geometry and that nothing
// overlaps: the page lies inside the canvas, clear of the sidebar and the docked side pane, the dock sits under the
// page's text block, and the single-page paper shift keeps the text block centred.
import { check, equal } from '../lib/index.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1536, 864],
  ui: 'en',
  theme: 'paper',
  mode: 'both',
  settings: {
    mushafStyle: 'hafs',
    pageMode: 'auto',
    zoomPct: 100,
    sidebar: { open: true, widthPx: 300, tab: 'index' },
    sidePane: {
      open: true,
      widthPx: 400,
      tab: 'translation',
      follow: 'selection_or_audio',
      autoCollapseSidebar: true,
    },
  },
  description: '1536×864, sidebar and side pane open: single page at qfs 22.75, docked pane, no overlap',
}

const PAGE = 262

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s32(ctx) {
  const { qd } = ctx
  await qd.goto({ type: 'page', data: { page: PAGE } })
  await qd.waitIdle()
  const state = await qd.state()
  equal(state.sidebarOpen, true, 'the sidebar is open')
  equal(state.sidePaneOpen, true, 'the side pane is open')
  equal(state.spread, false, 'single page (784×824 canvas)')
  equal(state.dock, 'compact', 'the compact bar (canvas under 860 px tall)')
  equal(state.qfs, 22.75, 'qfs')
  equal(state.visiblePages, [PAGE], 'the page on screen')

  const report = await ctx.page.evaluate(inspectLayout, PAGE)
  ctx.log(JSON.stringify(report.summary))
  check(report.ok, report.problems.join('\n'))

  await ctx.shot()
  await ctx.shot('canvas', { selector: 'main.canvas' })
}

/**
 * Runs in the page: the shell regions and the page, in viewport px; returns the overlaps found.
 * @param {number} pageNo
 */
function inspectLayout(pageNo) {
  /** @type {string[]} */
  const problems = []
  /** @param {string} selector */
  const box = (selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null
  /** @param {DOMRect} a @param {DOMRect} b */
  const overlap = (a, b) =>
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5
  const canvas = box('main.canvas')
  const page = box(`section.mp[data-page="${pageNo}"]`)
  const block = box(`section.mp[data-page="${pageNo}"] .mp-block`)
  const sidebar = box('aside[data-qd-region="sidebar"]')
  const pane = box('aside[data-qd-region="side-pane"]')
  const dock = box('[data-qd-dock-pill]')
  if (!canvas || !page || !block)
    return { ok: false, problems: ['no canvas, page or text block'], summary: {} }

  // The canvas measures 784 × 824.
  if (Math.abs(canvas.width - 784) > 1 || Math.abs(canvas.height - 824) > 1)
    problems.push(`canvas ${canvas.width}×${canvas.height}, expected 784×824`)
  // The page lies inside the canvas.
  if (page.left < canvas.left - 0.5 || page.right > canvas.right + 0.5 || page.top < canvas.top - 0.5)
    problems.push(`page ${JSON.stringify(page)} leaves the canvas ${JSON.stringify(canvas)}`)
  // Nothing of the shell covers it: the sidebar and the docked side pane sit beside the canvas.
  if (!sidebar || sidebar.width < 200) problems.push('the sidebar is not shown')
  else if (overlap(sidebar, page)) problems.push('the sidebar overlaps the page')
  if (!pane || pane.width < 300) problems.push('the side pane is not docked')
  else {
    if (overlap(pane, page)) problems.push('the side pane overlaps the page')
    if (overlap(pane, canvas)) problems.push('the side pane overlays the canvas (not docked)')
  }
  // The dock floats under the text block, never over it.
  if (dock && overlap(dock, block)) problems.push(`the dock ${JSON.stringify(dock)} covers the text block`)
  // The single-page footprint (SINGLE_W = 22 qfs) is centred in the canvas width: the paper shift keeps the block put.
  const qfs = page.width / 21
  const footprint = 22 * qfs
  const stageCentre = (canvas.left + canvas.right) / 2
  const side = document.querySelector(`section.mp[data-page="${pageNo}"]`)?.getAttribute('data-side')
  const footprintLeft = side === 'right' ? page.left - qfs : page.left
  if (Math.abs(footprintLeft + footprint / 2 - stageCentre) > 1)
    problems.push(`the single page is off-centre by ${footprintLeft + footprint / 2 - stageCentre} px`)
  return {
    ok: problems.length === 0,
    problems,
    summary: {
      canvas: [Math.round(canvas.width), Math.round(canvas.height)],
      page: [Math.round(page.left), Math.round(page.top), Math.round(page.width), Math.round(page.height)],
      dockTop: dock ? Math.round(dock.top) : null,
      blockBottom: Math.round(block.bottom),
      sidebar: sidebar ? [Math.round(sidebar.left), Math.round(sidebar.width)] : null,
      pane: pane ? [Math.round(pane.left), Math.round(pane.width)] : null,
    },
  }
}
