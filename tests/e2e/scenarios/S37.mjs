// @ts-check
// S37: the study pane's Tafsir tab with a Quran.com range entry and the stale footer. The browser mock serves Ibn
// Kathir (abridged) chapter by chapter: the scenario fetches Al-Baqarah once (online), relaunches (a chapter cached
// before the page loaded counts as fetched on an earlier run, 9 days ago), and switches the network off. A click on the
// end-of-ayah marker of 2:255 opens the Tafsir tab. Asserts the entry's "Covers 2:253–255" chip, the footer
// "Saved 9 days ago · refreshes when online" and the source. Writes the viewport and a close-up of the pane.
import { check, equal, waitUntil } from '../lib/index.mjs'
import { AYAH_ID, openPaneOn } from './S14.mjs'

export const TAFSIR = 'tafsir.en.ibn_kathir'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'web',
  settings: { mushafStyle: 'hafs', pageMode: 'auto', tafsirPackId: TAFSIR, networkAllowed: true },
  description: 'Side pane, Tafsir tab with a range entry and the stale footer',
}

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s37(ctx) {
  const { qd, page } = ctx
  if (ctx.mode !== 'web') ctx.pending('S37 ages a cached tafsir chapter in the browser mock')

  // Fetch Al-Baqarah once, online; after a relaunch the mock dates it 9 days back.
  const fresh = await qd.ipc('tafsirGet', TAFSIR, AYAH_ID)
  equal(
    [fresh.fromAyahId, fresh.toAyahId, fresh.stale],
    [AYAH_ID - 2, AYAH_ID, false],
    'the fresh range entry',
  )
  await ctx.relaunch()
  await qd.setSettings({ networkAllowed: false })
  await waitUntil(async () => !(await qd.state()).online, { message: 'the app is offline', timeout: 5000 })

  await openPaneOn(ctx, AYAH_ID, 'marker')
  equal((await qd.state()).settings.sidePane.tab, 'tafsir', 'the Tafsir tab')
  await page.locator('[data-qd-pane] .source.stale').waitFor({ state: 'visible', timeout: 10_000 })
  await qd.waitIdle()

  const report = await page.evaluate(() => {
    const plain = (/** @type {Element | null | undefined} */ el) =>
      (el?.textContent ?? '').replace(/[⁦-⁩]/gu, '').replace(/\s+/g, ' ').trim()
    const entries = [...document.querySelectorAll('[data-qd-pane] .entry')]
    return {
      heading: plain(document.querySelector('[data-qd-pane] .ayah-header .title')),
      entries: entries.length,
      covers: plain(entries[0]?.querySelector('.covers')),
      dir: entries[0]?.getAttribute('dir') ?? '',
      size: entries[0]?.querySelector('.text')
        ? getComputedStyle(entries[0].querySelector('.text') ?? document.body).fontSize
        : '',
      source: plain(document.querySelector('[data-qd-pane] .source .name')),
      date: plain(document.querySelector('[data-qd-pane] .source .date')),
    }
  })
  ctx.log(JSON.stringify(report))
  equal(report.heading, 'Al-Baqarah 2:255', 'pane heading')
  equal(report.entries, 1, 'one entry')
  equal(report.covers, 'Covers 2:253–255', 'the range entry chip')
  equal(report.dir, 'ltr', 'English tafsir direction')
  equal(report.size, '16px', 'English tafsir reading size')
  equal(report.source, 'Ibn Kathir (abridged)', 'the source')
  equal(report.date, 'Saved 9 days ago · refreshes when online', 'the stale footer')
  check((await qd.state()).online === false, 'still offline')

  await ctx.shot()
  await ctx.shot('pane', { selector: 'aside[data-qd-region="side-pane"]' })
}
