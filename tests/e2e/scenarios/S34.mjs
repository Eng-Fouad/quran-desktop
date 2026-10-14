// @ts-check
// S34: the ayah action bar after a pointer click-selection on page 262. Clicks a word of 15:9, waits for the bar
// (120 ms after the click), and asserts in the browser: the ayah is selected (selection ring drawn by the highlight
// layer), the bar is a labelled toolbar of 36 px with the eight actions, it sits above the selection's first line (or
// below its last line near the top) and never covers a selected word, and it stays inside the canvas. Then shows a
// button tooltip and the highlight swatches. Writes the viewport and close-ups.
import { check, equal, mushaf, waitUntil } from '../lib/index.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'both',
  settings: { mushafStyle: 'hafs', pageMode: 'spread', ayahActionBar: true, hoverHighlight: true },
  description: 'Ayah action bar after a click-selection on page 262',
}

const PAGE = 262
/** 15:9 ("Indeed, it is We who sent down the Reminder…"), on line 10 of page 262 in the V2 layout. */
const AYAH_ID = 1811

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s34(ctx) {
  const { qd, page } = ctx
  await qd.goto({ type: 'page', data: { page: PAGE } })
  await qd.waitIdle()
  equal(await page.locator(`#a11y-${PAGE}-${AYAH_ID}`).count(), 1, `15:9 is on page ${PAGE}`)

  const ayahId = AYAH_ID
  const word = page.locator(`${mushaf.page(PAGE)} .mp-glyphs .w[data-a="${ayahId}"]:not(.e)`).nth(2)
  equal(await word.count(), 1, `a word of 15:9 on page ${PAGE}`)
  await word.click()

  const bar = page.locator('.ab[role="toolbar"]')
  await waitUntil(async () => (await bar.count()) === 1 && (await bar.isVisible()), {
    message: 'the action bar appears',
    timeout: 2000,
  })
  await qd.waitIdle()

  const state = await qd.state()
  equal(state.selection?.fromAyahId, ayahId, 'selection starts at the clicked ayah')
  equal(state.selection?.toAyahId, ayahId, 'selection ends at the clicked ayah')

  const report = await page.evaluate(measureBar, ayahId)
  ctx.log(JSON.stringify(report))
  check(report.ok, report.problems.join('\n'))

  await ctx.shot()
  const clip = report.clip
  await ctx.shot('bar', { clip })

  // A button tooltip with its keycap (Bookmark · B).
  await page.locator('.ab [aria-label="Bookmark"]').hover()
  await waitUntil(async () => (await page.locator('.tooltip').count()) > 0, {
    message: 'the Bookmark tooltip',
    timeout: 2000,
  })
  await ctx.wait(250)
  await ctx.shot('tooltip', { clip })

  // The highlight swatches (a floating layer).
  await page.locator('.ab [aria-label="Highlight"]').click()
  await waitUntil(async () => (await page.locator('.ab-colors [role="radio"]').count()) === 5, {
    message: 'five swatches',
    timeout: 2000,
  })
  await ctx.wait(250)
  await ctx.shot('swatches', { clip: { ...clip, y: Math.max(0, clip.y - 60), height: clip.height + 60 } })
  await page.keyboard.press('Escape')
}

/**
 * Runs in the page: the bar's geometry.
 * @param {number} ayahId
 */
function measureBar(ayahId) {
  /** @type {string[]} */
  const problems = []
  const bar = document.querySelector('.ab[role="toolbar"]')
  if (!bar) return { ok: false, problems: ['no .ab toolbar'], clip: { x: 0, y: 0, width: 10, height: 10 } }
  const b = bar.getBoundingClientRect()
  if (Math.abs(b.height - 36) > 0.5) problems.push(`bar height ${b.height}, expected 36`)
  if (!bar.getAttribute('aria-label')?.includes('15:9'))
    problems.push(`label "${bar.getAttribute('aria-label')}"`)
  const buttons = [...bar.querySelectorAll(':scope > button, :scope > * > button, :scope > button')]
  const labels = [...new Set([...bar.querySelectorAll('button')].map((x) => x.getAttribute('aria-label')))]
  if (labels.length !== 8) problems.push(`${labels.length} buttons: ${labels.join(', ')}`)
  for (const btn of bar.querySelectorAll('button')) {
    const r = btn.getBoundingClientRect()
    if (Math.abs(r.height - 32) > 0.5)
      problems.push(`button ${btn.getAttribute('aria-label')} is ${r.height} px tall`)
  }
  const words = [...document.querySelectorAll(`.mp-glyphs .w[data-a="${ayahId}"]`)].map((w) =>
    w.getBoundingClientRect(),
  )
  for (const w of words) {
    const overlap =
      Math.min(w.right, b.right) - Math.max(w.left, b.left) > 0 &&
      Math.min(w.bottom, b.bottom) - Math.max(w.top, b.top) > 0
    if (overlap) problems.push('the bar covers a selected word')
  }
  const rings = [...document.querySelectorAll('.mp-hl .hl-selection-ring')].map((r) =>
    r.getBoundingClientRect(),
  )
  if (rings.length === 0) problems.push('no selection ring')
  const firstTop = Math.min(...rings.map((r) => r.top))
  const side = bar.getAttribute('data-side')
  if (side === 'above' && Math.abs(b.bottom + 8 - firstTop) > 1.5)
    problems.push(`bar bottom ${b.bottom} is not 8 px above the first line (${firstTop})`)
  const main = document.querySelector('main')?.getBoundingClientRect()
  if (main && (b.left < main.left || b.right > main.right || b.top < main.top || b.bottom > main.bottom))
    problems.push('the bar leaves the canvas')
  const all = [b, ...rings]
  const x = Math.max(0, Math.min(...all.map((r) => r.left)) - 40)
  const y = Math.max(0, Math.min(...all.map((r) => r.top)) - 40)
  const right = Math.min(window.innerWidth, Math.max(...all.map((r) => r.right)) + 40)
  const bottom = Math.min(window.innerHeight, Math.max(...all.map((r) => r.bottom)) + 60)
  return {
    ok: problems.length === 0,
    problems,
    side,
    buttons: buttons.length,
    labels,
    clip: { x, y, width: right - x, height: bottom - y },
  }
}
