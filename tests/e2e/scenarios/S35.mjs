// @ts-check
// S35 (§12.6, §7.8; WP8f): a relaunch restores the reading place and offers the recitation where it stopped.
// The reader opens page 297 (Al-Kahf, spread 297–298) and writes its reading position 1 s after it settles (§7.3); the
// recitation's last ayah, 18:45, is stored as the `audio` position (`position_set`, what the player sends at a stop,
// §7.8 step 4). The app is then relaunched: the browser mock reloads with its storage, the real app restarts on the
// same data dir. It asserts §7.8:
// - step 2: the spread 297–298 opens with no turn, at the position written before (same layout);
// - step 3: the reading cursor is on the restored ayah, with no visible selection;
// - step 4: the idle dock offers "Resume Al-Kahf · 18:45" and nothing plays by itself;
// - nothing from before the relaunch survives in the page-navigation affordances (no HUD, rail or chip).
// Writes the viewport and a close-up of the dock. Then a turn to page 301 and, inside the position's 1 s debounce, the
// user closes the window: the app quits by itself and reopens on page 301 (the page saves it first, `quit-requested`).
import { check, equal, waitUntil } from '../lib/index.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'both',
  settings: { mushafStyle: 'hafs', pageMode: 'auto', readingMode: 'mushaf', zoomPct: 100 },
  description:
    'Relaunch restores page 297 and shows the resume pill; a turn right before closing the window survives',
}

const PAGE = 297
/** Al-Kahf 18:28, the first ayah on page 297 (V2 layout): the reading position the reader writes. */
const FIRST_AYAH = 2168
/** Al-Kahf 18:45 (ayah id 2185, on page 298 of the same spread): where the recitation stopped. */
const RESUME = { surah: 18, ayah: 45, ayahId: 2185, page: 298 }
/** The page turned to right before the window is closed (the first page of the spread 301–302). */
const CLOSE_PAGE = 301

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s35(ctx) {
  const { qd } = ctx

  // Before: read page 297 until the reader has written its position (debounced 1 s, §7.3).
  await qd.goto({ type: 'page', data: { page: PAGE } })
  await qd.waitIdle()
  const before = await qd.state()
  check(before.visiblePages.includes(PAGE), `page ${PAGE} on screen before the relaunch`)
  const written = await waitUntil(
    async () => {
      const b = await qd.ipc('appBootstrap')
      const mushaf = b.positions.find((p) => p.context === 'mushaf')
      return mushaf && mushaf.page === PAGE ? mushaf : null
    },
    { timeout: 5000, message: `the reader's position on page ${PAGE}` },
  )
  ctx.log(`position written: ${JSON.stringify(written)}`)
  equal(written.layout, 'v2', 'the written layout')
  equal(written.ayahId, FIRST_AYAH, 'the written ayah (the first visible ayah, no cursor on screen)')

  // The recitation stopped at 18:45 (what `player.stop()` writes; the mock stamps it now, within the 7 days).
  await qd.ipc('positionSet', {
    context: 'audio',
    layout: 'v2',
    page: RESUME.page,
    ayahId: RESUME.ayahId,
    scrollPx: null,
    updatedAt: 0,
  })

  await ctx.relaunch()
  await qd.waitIdle()

  // §7.8 steps 2–3: page 297 (the spread 297–298) with the cursor on the restored ayah and no selection.
  const after = await qd.state()
  equal(after.view, 'reader', 'the view')
  equal(after.readingMode, 'mushaf', 'the reading mode')
  equal(after.page, PAGE, 'the restored page')
  equal(after.visiblePages, [PAGE, PAGE + 1], 'the restored spread')
  equal(after.cursorAyahId, FIRST_AYAH, 'the reading cursor on the restored ayah')
  equal(after.selection, null, 'no visible selection after a relaunch')

  // §7.8 step 4: the idle dock offers the recitation's place; nothing plays.
  const pill = ctx.page.locator('[data-qd-dock][data-mode="idle"]')
  await waitUntil(async () => (await pill.count()) === 1, { timeout: 5000, message: 'the idle dock' })
  const text = (await pill.innerText()).replace(/\s+/g, ' ')
  ctx.log(`dock: ${text}`)
  check(text.includes('Resume Al-Kahf'), `the dock offers to resume Al-Kahf ("${text}")`)
  check(
    text.includes(`${RESUME.surah}:${RESUME.ayah}`),
    `the dock names ${RESUME.surah}:${RESUME.ayah} ("${text}")`,
  )
  equal(after.player.isPlaying, false, 'nothing plays by itself')
  check(
    after.player.status === null || after.player.status === 'idle',
    `the player is idle (${after.player.status})`,
  )

  // A fresh start: no flip HUD, page rail or arrival chip carried over.
  const leftovers = await ctx.page.evaluate(() =>
    ['[data-qd-flip-hud]', '[data-qd-page-rail]', '[data-qd-pagenav="division"]'].filter(
      (s) => document.querySelector(s) !== null,
    ),
  )
  equal(leftovers, [], 'page-navigation affordances on screen after the relaunch')

  const box = await pill.boundingBox()
  await ctx.shot()
  if (box) {
    const pad = 24
    await ctx.shot('dock', {
      clip: { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad },
    })
  }

  // A turn made just before the user closes the window survives too: the position still waits for its 1 s debounce,
  // and the page saves it before the app quits (`quit-requested`; WebView2 tears a page down without `pagehide`).
  await qd.goto({ type: 'page', data: { page: CLOSE_PAGE } })
  const pending = (await qd.ipc('appBootstrap')).positions.find((p) => p.context === 'mushaf')
  check(
    pending?.page !== CLOSE_PAGE,
    `page ${CLOSE_PAGE} is not written yet when the window closes (debounced 1 s)`,
  )
  await ctx.relaunch({ close: true })
  await qd.waitIdle()
  const closed = await qd.state()
  equal(closed.page, CLOSE_PAGE, 'the page turned to just before the window was closed')
  equal(closed.visiblePages, [CLOSE_PAGE, CLOSE_PAGE + 1], 'its spread')
  ctx.log(`closed on page ${CLOSE_PAGE} right after the turn: it reopens there`)
}
