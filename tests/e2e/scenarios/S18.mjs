// @ts-check
// S18 (§12.6, §8.7; WP8d): the five user-highlight colours, the selection ring and the bookmark margin marks on page 3.
// Seeds the browser mock's library (five highlights, two ayah bookmarks), opens page 3 and clicks 2:10 (the blue one):
// the selection draws its ring and 6 % fill, and the blue highlight under it turns into a bar (one fill per word).
// Asserts every shape the highlight layer draws against the measured words, then shoots the page in paper and in night.
import { check, equal, mushaf, waitUntil } from '../lib/index.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'web',
  settings: { mushafStyle: 'hafs', pageMode: 'spread', highlightBookmarks: true, ayahActionBar: false },
  description: 'Five highlight colours + selection ring + bookmark margin marks (page 3)',
}

const PAGE = 3
/** Ayah ids on page 3 (2:6 … 2:16) and the colour each one gets. */
const HIGHLIGHTS = /** @type {const} */ ([
  [13, 'yellow'], // 2:6
  [15, 'green'], // 2:8
  [17, 'blue'], // 2:10, selected below
  [19, 'red'], // 2:12
  [21, 'purple'], // 2:14
])
const BOOKMARKS = [14, 22] // 2:7, 2:15
const SELECT = 17

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s18(ctx) {
  const { qd, page } = ctx
  await page.evaluate(seed, { highlights: HIGHLIGHTS, bookmarks: BOOKMARKS })
  await qd.goto({ type: 'page', data: { page: PAGE } })
  await qd.waitIdle()

  const fills = page.locator(`${mushaf.page(PAGE)} .mp-hl .hl-user`)
  await waitUntil(async () => (await fills.count()) >= 5, {
    message: 'the five user highlights',
    timeout: 3000,
  })

  await page
    .locator(`${mushaf.page(PAGE)} .mp-glyphs .w[data-a="${SELECT}"]:not(.e)`)
    .first()
    .click()
  await waitUntil(
    async () => (await page.locator(`${mushaf.page(PAGE)} .mp-hl .hl-selection-ring`).count()) > 0,
    { message: 'the selection ring', timeout: 2000 },
  )
  await page.mouse.move(5, 500)
  await qd.waitIdle()
  const state = await qd.state()
  equal(state.selection?.fromAyahId, SELECT, 'the clicked ayah is selected')

  const report = await page.evaluate(measure, { page: PAGE, highlights: HIGHLIGHTS, selected: SELECT })
  ctx.log(JSON.stringify(report.summary))
  check(report.ok, report.problems.join('\n'))

  await ctx.shot()
  await ctx.shot('page', { selector: mushaf.page(PAGE) })
  await qd.setSettings({ theme: 'night' })
  await qd.waitIdle()
  await ctx.shot('night', { selector: mushaf.page(PAGE) })
}

/**
 * Runs in the page: writes the highlights and bookmarks into the mock's user slice (WP0C's `__QD_MOCK__` handle).
 * @param {{ highlights: ReadonlyArray<readonly [number, string]>, bookmarks: number[] }} input
 */
function seed({ highlights, bookmarks }) {
  const mock = /** @type {{ __QD_MOCK__?: { state: { user: { update(fn: (u: any) => void): void } } } }} */ (
    /** @type {unknown} */ (window)
  ).__QD_MOCK__
  if (!mock) throw new Error('the browser mock is not installed')
  const now = Math.floor(Date.now() / 1000)
  mock.state.user.update((u) => {
    u.highlights = highlights.map(([ayahId, color], i) => ({
      id: `s18-h${i}`,
      fromAyahId: ayahId,
      toAyahId: ayahId,
      color,
      tagIds: [],
      createdAt: now,
      updatedAt: now,
    }))
    u.bookmarks = bookmarks.map((ayahId, i) => ({
      id: `s18-b${i}`,
      kind: 'ayah',
      ayahId,
      surah: 2,
      ayah: ayahId - 7,
      layout: null,
      page: null,
      label: null,
      collectionIds: [],
      tagIds: [],
      createdAt: now,
      updatedAt: now,
    }))
  })
}

/**
 * Runs in the page: every highlight shape against the measured words (§8.7).
 * @param {{ page: number, highlights: ReadonlyArray<readonly [number, string]>, selected: number }} input
 */
function measure({ page, highlights, selected }) {
  /** @type {string[]} */
  const problems = []
  const section = document.querySelector(`section.mp[data-page="${page}"]`)
  if (!section) return { ok: false, problems: ['no page'], summary: {} }
  const layer = section.querySelector('.mp-hl')
  const glyphs = [...section.querySelectorAll('.mp-glyphs')].at(-1)
  if (!layer || !glyphs) return { ok: false, problems: ['no highlight layer or rendition'], summary: {} }
  const rect = (/** @type {Element} */ el) => el.getBoundingClientRect()
  const covers = (/** @type {DOMRect} */ a, /** @type {DOMRect} */ w) =>
    a.left <= w.left + w.width / 2 &&
    a.right >= w.left + w.width / 2 &&
    a.top <= w.top + w.height / 2 &&
    a.bottom >= w.top + w.height / 2
  const fills = [
    ...layer.querySelectorAll('.hl-user, .hl-selection, .hl-hover, .hl-search, .hl-audio, .hl-flash'),
  ]
  for (const [ayahId, color] of highlights) {
    const words = [...glyphs.querySelectorAll(`.w[data-a="${ayahId}"]`)].map(rect)
    if (words.length === 0) {
      problems.push(`ayah ${ayahId} is not on the page`)
      continue
    }
    for (const w of words) {
      const under = fills.filter((f) => covers(rect(f), w))
      if (under.length !== 1) problems.push(`ayah ${ayahId}: ${under.length} fills under a word`)
      const want = ayahId === selected ? 'hl-selection' : `hl-${color}`
      if (under[0] && !under[0].classList.contains(want))
        problems.push(`ayah ${ayahId}: fill ${under[0].className}`)
    }
    if (ayahId === selected) {
      const bars = [...layer.querySelectorAll(`.hl-user-bar.hl-${color}`)]
      if (bars.length === 0) problems.push(`the selected ${color} highlight has no bar`)
    }
    // The fill is translucent (glyphs stay legible) and in its own colour.
    const fill = layer.querySelector(`.hl-user.hl-${color}`)
    if (ayahId !== selected && fill) {
      const bg = getComputedStyle(fill).backgroundColor
      if (!/rgba?\(|color\(/.test(bg) || bg === 'rgba(0, 0, 0, 0)') problems.push(`${color} fill is ${bg}`)
    }
  }
  const rings = [...layer.querySelectorAll('.hl-selection-ring')]
  if (rings.length === 0) problems.push('no selection ring')
  for (const r of rings) {
    const shadow = getComputedStyle(r).boxShadow
    if (!shadow.includes('inset')) problems.push(`ring shadow ${shadow}`)
  }
  return {
    ok: problems.length === 0,
    problems,
    summary: {
      fills: fills.length,
      rings: rings.length,
      bars: layer.querySelectorAll('.hl-user-bar').length,
      marks: section.querySelectorAll('.mp-margin [class*="mark"]').length,
    },
  }
}
