// @ts-check
// S27: memorisation hide mode (blur) on page 50 with 3 words revealed. Opens page 50 in single-page mode (qcf_v2),
// presses E (hide the visible page: no selection) and W three times, then asserts, on every rendition of the page:
// - the first three recitable words are shown, every other word of the page is hidden (`.w-hid`), and no ayah-end
//   marker is ever hidden (they stay as anchors);
// - a hidden word draws blurred (`filter: blur(0.16·qfs)`, opacity 0.55) and a revealed one does not;
// - `<html>` carries the session (`data-memo="hide"`, `data-memo-style="blur"`);
// - the toolbar in the overlay slot reads "Hiding Ali 'Imran 3:1–9" and "3 of N words";
// - the overlay slot (the toolbar at its foot) never covers the page footer: `.mv-slot` does not intersect the page's
//   `.mp-foot`, and the toolbar starts at least 12 px below the page (the book re-fits above it);
// - holding Q (peek) shows every word, and releasing it hides them again.
// Writes the viewport, a close-up of the page's top half and one of the toolbar.
import { check, equal, mushaf, waitUntil } from '../lib/index.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'both',
  settings: {
    mushafStyle: 'qcf_v2',
    pageMode: 'single',
    memoHideStyle: 'blur',
    memoRevealOnHover: true,
    sidebar: { open: false, widthPx: 300, tab: 'memorize' },
  },
  description: 'Memorisation hide (blur) on page 50 with 3 words revealed',
}

const PAGE = 50
const REVEALED = 3

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s27(ctx) {
  const { qd, page } = ctx
  await qd.goto({ type: 'page', data: { page: PAGE } })
  await qd.waitIdle()
  equal((await qd.state()).visiblePages, [PAGE], 'the page on screen')

  // The pointer rests off the page (hovering a word would reveal it), and nothing holds focus.
  await page.mouse.move(4, 600)
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })

  await page.keyboard.press('e')
  await waitUntil(async () => (await page.locator(`${mushaf.page(PAGE)} .w-hid`).count()) > 0, {
    message: 'E hides the page',
    timeout: 3000,
  })
  for (let i = 0; i < REVEALED; i++) await page.keyboard.press('w')
  await qd.waitIdle()

  const report = await page.evaluate(measure, { page: PAGE, revealed: REVEALED })
  ctx.log(JSON.stringify({ ...report, toolbarClip: undefined, pageClip: undefined }))
  check(report.ok, report.problems.join('\n'))

  // Peek: hold Q, every word shows; release, they hide again.
  await page.keyboard.down('q')
  await waitUntil(async () => (await page.locator(`${mushaf.page(PAGE)} .w-hid`).count()) === 0, {
    message: 'holding Q shows every word',
    timeout: 2000,
  })
  await page.keyboard.up('q')
  await waitUntil(
    async () => (await page.locator(`${mushaf.page(PAGE)} .w-hid`).count()) === report.hiddenSpans,
    { message: 'releasing Q hides them again', timeout: 2000 },
  )
  await qd.waitIdle()

  await ctx.shot()
  await ctx.shot('page', { clip: report.pageClip })
  await ctx.shot('toolbar', { clip: report.toolbarClip })
}

/**
 * Runs in the page: the class map, the computed styles and the toolbar.
 * @param {{ page: number, revealed: number }} args
 */
function measure({ page, revealed }) {
  /** @type {string[]} */
  const problems = []
  const section = document.querySelector(`section.mp[data-page="${page}"]`)
  const layers = [...(section?.querySelectorAll('.mp-glyphs') ?? [])]
  if (layers.length === 0) problems.push(`page ${page} has no glyph layer`)
  let hiddenSpans = 0
  for (const layer of layers) {
    const words = [.../** @type {NodeListOf<HTMLElement>} */ (layer.querySelectorAll('.w'))]
    const recitable = words.filter((w) => !w.classList.contains('e'))
    const shown = recitable.slice(0, revealed)
    const rest = recitable.slice(revealed)
    for (const w of shown) {
      if (w.classList.contains('w-hid')) problems.push(`revealed word ${w.dataset.w} is hidden`)
    }
    for (const w of rest) {
      if (!w.classList.contains('w-hid')) problems.push(`word ${w.dataset.w} is not hidden`)
    }
    for (const w of words) {
      if (w.classList.contains('e') && w.classList.contains('w-hid')) {
        problems.push(`end marker ${w.dataset.w} is hidden`)
      }
    }
    hiddenSpans += layer.querySelectorAll('.w-hid').length
    const visibleLayer = getComputedStyle(layer).opacity !== '0'
    if (visibleLayer && rest[0]) {
      const cs = getComputedStyle(rest[0])
      if (!cs.filter.startsWith('blur(')) problems.push(`a hidden word's filter is "${cs.filter}"`)
      if (Math.abs(Number(cs.opacity) - 0.55) > 0.01)
        problems.push(`a hidden word's opacity is ${cs.opacity}`)
    }
    if (visibleLayer && shown[0]) {
      const cs = getComputedStyle(shown[0])
      if (cs.filter !== 'none') problems.push(`a revealed word's filter is "${cs.filter}"`)
    }
  }

  const root = document.documentElement
  if (root.dataset.memo !== 'hide') problems.push(`html[data-memo] is "${root.dataset.memo}"`)
  if (root.dataset.memoStyle !== 'blur') problems.push(`html[data-memo-style] is "${root.dataset.memoStyle}"`)

  const toolbar = document.querySelector('[data-qd-memo-toolbar]')
  const text = (toolbar?.textContent ?? '').replace(/[⁦-⁩]/g, '').replace(/\s+/g, ' ').trim()
  if (!toolbar) problems.push('no hide-mode toolbar')
  if (!text.includes('Hiding Ali ')) problems.push(`toolbar title: "${text}"`)
  if (!/\b3 of \d+ words\b/.test(text)) problems.push(`toolbar count: "${text}"`)

  const block = section?.querySelector('.mp-block')?.getBoundingClientRect()
  const tb = toolbar?.getBoundingClientRect()

  // The persistent bar sits at the slot's foot and the book ends 12 px above it: nothing of the slot covers the footer.
  const slot = document.querySelector('.mv-slot')?.getBoundingClientRect()
  const foot = section?.querySelector(':scope > .mp-foot')?.getBoundingClientRect()
  const paper = section?.getBoundingClientRect()
  if (!slot || slot.height === 0) problems.push('no overlay slot')
  if (!foot || foot.height === 0) problems.push(`page ${page} has no footer`)
  if (slot && foot) {
    const overlaps =
      slot.left < foot.right && foot.left < slot.right && slot.top < foot.bottom && foot.top < slot.bottom
    if (overlaps)
      problems.push(
        `the overlay slot (${Math.round(slot.top)}–${Math.round(slot.bottom)}) covers the footer (${Math.round(foot.top)}–${Math.round(foot.bottom)})`,
      )
  }
  if (tb && paper && tb.top - paper.bottom < 12 - 0.5)
    problems.push(`the toolbar starts ${(tb.top - paper.bottom).toFixed(1)} px below the page (≥ 12)`)

  const pad = 24
  const pageClip = block
    ? {
        x: Math.max(0, block.left - pad),
        y: Math.max(0, block.top - pad),
        width: block.width + 2 * pad,
        height: Math.min(block.height, 460) + pad,
      }
    : { x: 0, y: 0, width: 10, height: 10 }
  const toolbarClip = tb
    ? {
        x: Math.max(0, tb.left - 20),
        y: Math.max(0, tb.top - 20),
        width: tb.width + 40,
        height: tb.height + 40,
      }
    : { x: 0, y: 0, width: 10, height: 10 }
  return {
    ok: problems.length === 0,
    problems,
    hiddenSpans,
    layers: layers.length,
    toolbar: text,
    pageClip,
    toolbarClip,
  }
}
