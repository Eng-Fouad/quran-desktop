// @ts-check
// S31: page 262 with `forced-colors: active` emulated (Windows High Contrast). Glyph ink is CanvasText on Canvas, the
// frame follows, and the highlight fills are transparent with 2 px system-colour outlines: a selected ayah (its ring as
// a solid Highlight outline) and a hovered ayah (dotted Highlight). Asserts the computed colours in the browser and
// shoots the spread and the page.
import { check, equal, mushaf, waitUntil } from '../lib/index.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'both',
  settings: { mushafStyle: 'hafs', pageMode: 'spread', hoverHighlight: true, ayahActionBar: false },
  description: '`forced-colors: active` emulated, page 262',
}

const PAGE = 262
/** 15:9 (line 10) gets the selection, 15:12 (lines 12–13) the hover. */
const SELECT = 1811
const HOVER = 1814

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s31(ctx) {
  const { qd, page } = ctx
  await page.emulateMedia({ forcedColors: 'active' })
  await qd.goto({ type: 'page', data: { page: PAGE } })
  await qd.waitIdle()

  await page
    .locator(`${mushaf.page(PAGE)} .mp-glyphs .w[data-a="${SELECT}"]:not(.e)`)
    .nth(1)
    .click()
  await waitUntil(
    async () => (await page.locator(`${mushaf.page(PAGE)} .mp-hl .hl-selection-ring`).count()) > 0,
    { message: 'the selection ring', timeout: 2000 },
  )
  const hover = page.locator(`${mushaf.page(PAGE)} .mp-glyphs .w[data-a="${HOVER}"]:not(.e)`).nth(1)
  const box = await hover.boundingBox()
  if (!box) throw new Error('no word to hover')
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2, { steps: 2 })
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 })
  await waitUntil(async () => (await page.locator(`${mushaf.page(PAGE)} .mp-hl .hl-hover`).count()) > 0, {
    message: 'the hover outline',
    timeout: 2000,
  })
  await qd.waitIdle()

  const report = await page.evaluate(inspect, PAGE)
  ctx.log(JSON.stringify(report.summary))
  check(report.ok, report.problems.join('\n'))
  equal(report.summary.forced, true, 'forced-colors media query matches')

  await ctx.shot()
  await ctx.shot('page', { selector: mushaf.page(PAGE) })
  await page.emulateMedia({ forcedColors: 'none' })
}

/**
 * Runs in the page: forced-colours rendering of the glyphs and the highlight shapes.
 * @param {number} pageNo
 */
function inspect(pageNo) {
  /** @type {string[]} */
  const problems = []
  const forced = matchMedia('(forced-colors: active)').matches
  const section = document.querySelector(`section.mp[data-page="${pageNo}"]`)
  const layer = section?.querySelector('.mp-hl')
  const glyphs = section ? [...section.querySelectorAll('.mp-glyphs')].at(-1) : null
  if (!section || !layer || !glyphs)
    return { ok: false, problems: ['page parts missing'], summary: { forced } }
  const probe = document.createElement('span')
  probe.style.color = 'CanvasText'
  probe.style.backgroundColor = 'Highlight'
  document.body.append(probe)
  const canvasText = getComputedStyle(probe).color
  const highlight = getComputedStyle(probe).backgroundColor
  probe.remove()
  const ink = getComputedStyle(glyphs).color
  if (ink !== canvasText) problems.push(`glyph ink ${ink}, CanvasText is ${canvasText}`)
  const fill = layer.querySelector('.hl-selection')
  if (fill && !/^rgba\(.*,\s*0\)$/.test(getComputedStyle(fill).backgroundColor))
    problems.push(`.hl-selection background ${getComputedStyle(fill).backgroundColor}`)
  for (const [selector, style] of /** @type {const} */ ([['.hl-hover', 'dotted']])) {
    const el = layer.querySelector(selector)
    if (!el) {
      problems.push(`no ${selector}`)
      continue
    }
    const cs = getComputedStyle(el)
    // Forced colours keep the author alpha of a background (Canvas at alpha 0): the fill must stay transparent.
    if (!/^rgba\(.*,\s*0\)$/.test(cs.backgroundColor) && cs.backgroundColor !== 'transparent')
      problems.push(`${selector} background ${cs.backgroundColor}`)
    if (cs.outlineStyle !== style || cs.outlineWidth !== '2px')
      problems.push(`${selector} outline ${cs.outlineWidth} ${cs.outlineStyle}`)
    if (cs.outlineColor !== highlight)
      problems.push(`${selector} outline colour ${cs.outlineColor} (Highlight ${highlight})`)
  }
  const ring = layer.querySelector('.hl-selection-ring')
  if (ring) {
    const cs = getComputedStyle(ring)
    if (cs.outlineStyle !== 'solid' || cs.outlineWidth !== '2px' || cs.outlineColor !== highlight)
      problems.push(`ring outline ${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}`)
    if (cs.boxShadow !== 'none') problems.push(`ring shadow ${cs.boxShadow}`)
  } else problems.push('no selection ring')
  return {
    ok: problems.length === 0,
    problems,
    summary: { forced, ink, canvasText, highlight, shapes: layer.children.length },
  }
}
