// @ts-check
// S19 (§12.6, §9.7, §1.5; WP10b): search "الرحمن". From the reader, Mod+F opens the sidebar's Search tab with the field
// focused; typing the word searches (Smart mode). The panel shows the count line, the results grouped by surah under
// sticky headers, each hit a word window of the ayah in the Quran font with the match marked. Enter in the field opens
// the first hit: the reader shows its page with the matched word on the search-hit layer and the ayah selected, while
// the hit is marked active in the list and the field keeps focus. Then close-ups: F3 moving on to the next hit, the
// typo fallback ("الرحمان" → الرحمن), the empty panel with the recent search and examples, a reference query ("2:255"),
// and the Arabic UI in the night theme.
import { check, equal, waitUntil } from '../lib/index.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'both',
  settings: { pageMode: 'spread', sidebar: { open: true, widthPx: 320, tab: 'index' } },
  description: 'Search "الرحمن": sidebar results grouped by surah, and the hit highlighted on its page',
}

const PANEL = '.search-panel'
const FIELD = `${PANEL} input[data-qd-focus="search"]`
const HITS = `${PANEL} [data-hit]`

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s19(ctx) {
  const { qd, page } = ctx
  await qd.goto({ type: 'page', data: { page: 1 } })
  await qd.waitIdle()

  // Mod+F from the reader: the Search tab, its field focused.
  await page.locator('main#qd-main').focus()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
  await page.locator(FIELD).waitFor({ state: 'visible' })
  await waitUntil(() => page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, FIELD), {
    timeout: 3000,
  })

  // Typing searches after the debounce.
  await page.keyboard.type('الرحمن')
  await waitUntil(async () => (await page.locator(HITS).count()) > 0, { timeout: 8000 })
  await qd.waitIdle()
  const first = await page.evaluate(inspect, { panel: PANEL })
  ctx.log(JSON.stringify(first))
  check(/^\d+ results in \d+ surahs · \d+ ms$/u.test(first.summary), `summary "${first.summary}"`)
  check(first.groups.length > 0, 'surah groups')
  equal(first.groups[0]?.surah, '1', 'the first group (mushaf order)')
  check(first.hits.length > 0 && first.hits.every((h) => h.marks > 0), 'every hit marks a matched word')
  check(
    first.hits.every((h) => h.font.includes('qd-hafs')),
    'hits use the Quran font',
  )
  check(
    first.hits.every((h) => h.size === '22px'),
    'hits are 22 px',
  )

  // Enter opens the first hit and keeps the field focused; the page shows the search-hit layer.
  await page.keyboard.press('Enter')
  await waitUntil(() => page.evaluate(() => document.querySelectorAll('.mp-hl .hl-search').length > 0), {
    timeout: 8000,
  })
  await qd.waitIdle()
  const opened = await page.evaluate(
    ({ panel, field }) => ({
      active:
        document.querySelector(`${panel} [data-hit][aria-current="true"]`)?.getAttribute('data-ayah') ?? null,
      fieldFocused: document.activeElement?.matches(field) ?? false,
      highlighted: document.querySelectorAll('.mp-hl .hl-search').length,
    }),
    { panel: PANEL, field: FIELD },
  )
  ctx.log(JSON.stringify(opened))
  equal(opened.active, '1', 'the active hit is 1:1')
  equal(opened.fieldFocused, true, 'the field keeps focus')
  check(opened.highlighted > 0, 'the matched word is on the search-hit layer')
  // Let the arrival pulse finish before the shot.
  await ctx.wait(1400)
  await ctx.shot()
  await ctx.shot('panel', { selector: 'aside:has(.search-panel)' })

  // F3 from the reader moves to the next hit; the list follows.
  await page.locator('main#qd-main').focus()
  await page.keyboard.press('F3')
  await waitUntil(
    () =>
      page
        .evaluate(
          (panel) =>
            document.querySelector(`${panel} [data-hit][aria-current="true"]`)?.getAttribute('data-ayah'),
          PANEL,
        )
        .then((a) => a === '3'),
    { timeout: 5000 },
  )
  await qd.waitIdle()
  await ctx.wait(1400)
  await ctx.shot('f3', { selector: 'aside:has(.search-panel)' })

  // Scrolled: the sticky group header follows the list.
  await page.locator(`${PANEL} .qd-virtual-list`).evaluate((el) => el.scrollBy(0, 900))
  await ctx.wait(300)
  const sticky = await page.locator(`${PANEL} [data-sticky-group]`).count()
  check(sticky === 1, 'a sticky group header over the scrolled list')
  await ctx.shot('scrolled', { selector: 'aside:has(.search-panel)' })

  // A typo: Smart mode corrects it and says so.
  await page.locator(FIELD).fill('الرحمان')
  await waitUntil(async () => (await page.locator(`${PANEL} .notice.typo`).count()) > 0, { timeout: 8000 })
  await qd.waitIdle()
  const typo = await page.locator(`${PANEL} .notice.typo`).innerText()
  check(typo.includes('الرحمن') && typo.includes('الرحمان'), `typo banner "${typo}"`)
  await ctx.shot('typo', { selector: 'aside:has(.search-panel)' })

  // A reference: the jump instead of text hits.
  await page.locator(FIELD).fill('2:255')
  await waitUntil(async () => (await page.locator(`${PANEL} .jump`).count()) > 0, { timeout: 5000 })
  const jump = (await page.locator(`${PANEL} .jump`).first().innerText()).replace(/[\u2066-\u2069]/gu, '')
  check(/Go to Al-Baqara?h 2:255/u.test(jump), `jump "${jump}"`)
  await ctx.shot('reference', { selector: 'aside:has(.search-panel)' })

  // The empty panel: the recent search and the examples.
  await page.locator(FIELD).fill('')
  await waitUntil(async () => (await page.locator(`${PANEL} .recent`).count()) > 0, { timeout: 5000 })
  const recent = await page.locator(`${PANEL} .recent-list .query`).allInnerTexts()
  check(recent.includes('الرحمن'), `recent searches ${JSON.stringify(recent)}`)
  await ctx.shot('empty', { selector: 'aside:has(.search-panel)' })

  // The Arabic UI, night theme.
  await qd.setSettings({ uiLanguage: 'ar', theme: 'night' })
  await qd.waitIdle()
  await page.locator(FIELD).fill('الرحمن')
  await waitUntil(async () => (await page.locator(HITS).count()) > 0, { timeout: 8000 })
  await qd.waitIdle()
  const dir = await page.evaluate(
    (panel) => getComputedStyle(document.querySelector(panel) ?? document.body).direction,
    PANEL,
  )
  equal(dir, 'rtl', 'the panel direction in the Arabic UI')
  await ctx.shot('ar', { selector: 'aside:has(.search-panel)' })
}

/**
 * Runs in the page: the summary, the groups and the hits on screen.
 * @param {{ panel: string }} sel
 */
function inspect(sel) {
  const panel = document.querySelector(sel.panel)
  const strip = (/** @type {string | null | undefined} */ s) =>
    (s ?? '')
      .replace(/[\u2066-\u2069]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()
  return {
    summary: strip(panel?.querySelector('.summary')?.textContent),
    groups: [...(panel?.querySelectorAll('.qd-virtual-list [data-group]') ?? [])].map((g) => ({
      surah: g.getAttribute('data-group'),
      text: strip(g.textContent),
    })),
    hits: [...(panel?.querySelectorAll('[data-hit]') ?? [])].slice(0, 6).map((h) => {
      const ayah = h.querySelector('.ayah')
      const style = ayah ? getComputedStyle(ayah) : null
      return {
        ayah: h.getAttribute('data-ayah'),
        marks: h.querySelectorAll('mark').length,
        font: style?.fontFamily ?? '',
        size: style?.fontSize ?? '',
      }
    }),
  }
}
