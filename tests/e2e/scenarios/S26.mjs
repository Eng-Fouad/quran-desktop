// @ts-check
// S26: the Arabic UI with the mirrored chrome, on the pages 261–262 spread, plus a close-up of the dock. Asserts the
// mirror in the browser: `html[lang=ar][dir=rtl]`, the rail on the right edge with the sidebar beside it and the canvas
// to its left, the Windows caption buttons on the left edge with close outermost, the breadcrumb in Arabic with
// Arabic-Indic digits, and the Mushaf itself unchanged (always RTL Arabic, odd page right).
import { check, equal, mushaf } from '../lib/index.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'ar',
  theme: 'paper',
  mode: 'both',
  settings: { pageMode: 'spread', digits: 'auto' },
  description: 'Arabic UI (mirrored chrome), pages 261–262 spread, plus a dock close-up',
}

const PAGES = [261, 262]

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s26(ctx) {
  const { qd } = ctx
  await qd.goto({ type: 'page', data: { page: PAGES[0] ?? 261 } })
  await qd.waitIdle()

  const state = await qd.state()
  equal(state.locale, 'ar', 'UI language')
  equal(state.visiblePages, PAGES, 'the spread on screen')

  const layout = await ctx.page.evaluate(measureChrome)
  ctx.log(JSON.stringify(layout))
  equal(layout.lang, 'ar', 'html[lang]')
  equal(layout.dir, 'rtl', 'html[dir]')
  check(
    Math.abs(layout.rail.right - layout.viewport) <= 1,
    `rail on the right edge (right ${layout.rail.right})`,
  )
  check(layout.sidebar !== null, 'the sidebar is open')
  if (layout.sidebar) {
    check(layout.sidebar.right <= layout.rail.left + 1, 'the sidebar sits left of the rail')
    check(layout.canvas.right <= layout.sidebar.left + 1, 'the canvas sits left of the sidebar')
  }
  if (layout.platform === 'windows') {
    check(layout.close !== null && layout.close.left <= 1, 'close is the left-most caption button')
    check(
      layout.minimize !== null && layout.close !== null && layout.minimize.left > layout.close.left,
      'minimise sits inside close (mirrored caption order)',
    )
  }
  check(/[٠-٩]/.test(layout.crumbs), `breadcrumb uses Arabic-Indic digits ("${layout.crumbs}")`)
  check(layout.crumbs.includes('ص'), `breadcrumb names the spread with ص ("${layout.crumbs}")`)

  // The Mushaf is never mirrored: odd page on the right, both pages RTL Arabic.
  for (const page of PAGES) {
    const section = ctx.page.locator(mushaf.page(page))
    equal(await section.count(), 1, `page ${page} rendered`)
  }
  const sides = await ctx.page.evaluate(pageLefts, PAGES)
  check((sides[0] ?? 0) > (sides[1] ?? 0), `page 261 (odd) is right of page 262 (${sides.join(' / ')})`)

  await ctx.shot()
  await ctx.shot('dock', { selector: '[data-qd-region="dock"] [data-qd-dock-pill]' })
}

/**
 * Runs in the page: the left edge of each page's section.
 * @param {number[]} pages
 */
function pageLefts(pages) {
  return pages.map(
    (n) => document.querySelector(`section.mp[data-page="${n}"]`)?.getBoundingClientRect().left ?? 0,
  )
}

/** Runs in the page: the chrome's boxes and direction. */
function measureChrome() {
  /** @param {string} selector */
  const box = (selector) => {
    const el = document.querySelector(selector)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }
  }
  const rail = box('nav.rail') ?? { left: 0, right: 0, width: 0 }
  const canvas = box('main#qd-main') ?? { left: 0, right: 0, width: 0 }
  return {
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    platform: document.documentElement.dataset.platform ?? '',
    viewport: window.innerWidth,
    rail,
    sidebar: box('aside[data-qd-region="sidebar"]'),
    canvas,
    close: box('.controls .close'),
    minimize: box('.controls .control:first-child'),
    crumbs: document.querySelector('nav.crumbs')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  }
}
