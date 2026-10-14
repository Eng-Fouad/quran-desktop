// @ts-check
// S15: hover a word on page 1 and its word-by-word tooltip. The pointer moves onto a word of 1:3 and rests: the ayah
// gets the neutral hover tint and, 450 ms later, the WBW tooltip shows the word in qd-hafs, its translation and its
// transliteration, above the word pill. Asserts the dwell rule: any keydown hides the tooltip and a parked pointer
// never brings it back; moving again does. Writes the viewport and a close-up.
import { check, equal, mushaf, waitUntil } from '../lib/index.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'web',
  settings: {
    mushafStyle: 'hafs',
    pageMode: 'spread',
    hoverHighlight: true,
    wbwPackId: 'wbw.en',
    wbwTooltip: true,
    wbwShowTransliteration: true,
  },
  description: 'Hover word + WBW tooltip (page 1)',
}

const PAGE = 1
/** 1:3 "ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ": its first word. */
const AYAH_ID = 3

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s15(ctx) {
  const { qd, page } = ctx
  await qd.goto({ type: 'page', data: { page: PAGE } })
  await qd.waitIdle()

  const word = page.locator(`${mushaf.page(PAGE)} .mp-glyphs .w[data-a="${AYAH_ID}"]:not(.e)`).first()
  equal(await word.count(), 1, 'a word of 1:3')
  const box = await word.boundingBox()
  if (!box) throw new Error('the word has no box')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2

  // Arrive from the side, then rest on the word.
  await page.mouse.move(cx + 120, cy + 4)
  await page.mouse.move(cx, cy, { steps: 8 })
  const tooltip = page.locator('.word-tooltip')
  await waitUntil(async () => (await tooltip.count()) === 1, {
    message: 'the WBW tooltip after the dwell',
    timeout: 3000,
  })
  await waitUntil(
    async () => ((await tooltip.locator('.wt-translation').textContent()) ?? '').trim() !== '',
    { message: 'the translation line', timeout: 3000 },
  )
  await qd.waitIdle()

  const report = await page.evaluate(measure, AYAH_ID)
  ctx.log(JSON.stringify(report))
  check(report.ok, report.problems.join('\n'))

  await ctx.shot()
  await ctx.shot('tooltip', { clip: report.clip })

  // Any keydown hides it, and a pointer that stays parked never brings it back.
  await page.keyboard.press('Shift')
  await waitUntil(async () => (await tooltip.count()) === 0, {
    message: 'the tooltip hides on a keydown',
    timeout: 2000,
  })
  await ctx.wait(800)
  equal(await tooltip.count(), 0, 'no tooltip for a parked pointer')

  // Moving again (≥ 4 px) and resting shows it again.
  await page.mouse.move(cx + 3, cy + 3, { steps: 3 })
  await waitUntil(async () => (await tooltip.count()) === 1, {
    message: 'the tooltip after moving again',
    timeout: 3000,
  })
}

/**
 * Runs in the page: the hover tint, the tooltip's content and its placement against the word.
 * @param {number} ayahId
 */
function measure(ayahId) {
  /** @type {string[]} */
  const problems = []
  const tip = document.querySelector('.word-tooltip')
  if (!tip) return { ok: false, problems: ['no tooltip'], clip: { x: 0, y: 0, width: 10, height: 10 } }
  const t = tip.getBoundingClientRect()
  const arabic = tip.querySelector('.wt-word')?.textContent?.trim() ?? ''
  const translation = tip.querySelector('.wt-translation')?.textContent?.trim() ?? ''
  const translit = tip.querySelector('.wt-translit')?.textContent?.trim() ?? ''
  if (!/\p{Script=Arabic}/u.test(arabic)) problems.push(`no Arabic word ("${arabic}")`)
  if (translation === '') problems.push('no translation')
  if (translit === '') problems.push('no transliteration')
  const font = getComputedStyle(tip.querySelector('.wt-word') ?? tip).fontFamily
  if (!font.includes('qd-hafs')) problems.push(`Arabic font ${font}`)
  const hover = [...document.querySelectorAll('.mp-hl .hl-hover')]
  if (hover.length === 0) problems.push('no hover tint')
  const words = [...document.querySelectorAll(`.mp-glyphs .w[data-a="${ayahId}"]`)].map((w) =>
    w.getBoundingClientRect(),
  )
  const first = words[0]
  if (first) {
    if (t.bottom > first.top) problems.push(`tooltip bottom ${t.bottom} below the word top ${first.top}`)
    const centre = (first.left + first.right) / 2
    if (Math.abs((t.left + t.right) / 2 - centre) > 12) problems.push('tooltip is not centred on the word')
  }
  const all = [t, ...words, ...hover.map((h) => h.getBoundingClientRect())]
  const x = Math.max(0, Math.min(...all.map((r) => r.left)) - 48)
  const y = Math.max(0, Math.min(...all.map((r) => r.top)) - 32)
  const right = Math.min(window.innerWidth, Math.max(...all.map((r) => r.right)) + 48)
  const bottom = Math.min(window.innerHeight, Math.max(...all.map((r) => r.bottom)) + 48)
  return {
    ok: problems.length === 0,
    problems,
    arabic,
    translation,
    translit,
    clip: { x, y, width: right - x, height: bottom - y },
  }
}
