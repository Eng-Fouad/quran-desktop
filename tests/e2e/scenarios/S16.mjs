// @ts-check
// S16 (§12.6, §7.3, §8.7; WP9a): the recitation paused at a fixed millisecond inside 1:2. Plays Al-Fatihah paused
// (`audio_play` with `startPaused`), seeks the file to 3,900 ms (the second word of 1:2 in the exported timings) and
// asserts: the player is paused on 1:2 at that position; the highlight layer draws the audio ayah (layer 5) over 1:2's
// words and the opaque word pill (layer 6) on its second word; the dock shows the bar with "1:2" and the time. Writes
// the viewport, a close-up of the page and one of the dock.
import { check, equal, mushaf, waitUntil } from '../lib/index.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'web',
  settings: { mushafStyle: 'hafs', pageMode: 'spread', wordHighlight: true, followAlong: true },
  description: 'Audio paused at a fixed ms inside 1:2: ayah + word highlight',
}

const PAGE = 1
/** 1:2 (ayah id 2). */
const AYAH_ID = 2
/** Inside 1:2's second word (3,400–4,080 ms in the exported Alafasy timings of surah 1). */
const AT_MS = 3_900
const WORD_POS = 2

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s16(ctx) {
  const { qd, page } = ctx
  await qd.goto({ type: 'page', data: { page: PAGE } })
  await qd.waitIdle()

  await qd.play({
    reciterId: 7,
    from: { surah: 1, ayah: 1 },
    to: null,
    stopAt: 'end_of_surah',
    layout: 'v2',
    ayahRepeat: 1,
    rangeRepeat: 1,
    gap: { type: 'none' },
    startPaused: true,
  })
  await waitUntil(async () => (await qd.state()).player.status === 'paused', {
    message: 'the play rests paused',
    timeout: 3000,
  })
  await qd.seek(AT_MS)
  await waitUntil(
    async () => {
      const s = await qd.state()
      return s.player.currentAyahId === AYAH_ID && Math.abs(s.player.positionMs - AT_MS) < 1
    },
    { message: `paused inside 1:2 at ${AT_MS} ms`, timeout: 3000 },
  )
  await waitUntil(async () => (await page.locator(`${mushaf.page(PAGE)} .mp-hl .hl-word`).count()) === 1, {
    message: 'the word pill',
    timeout: 3000,
  })
  await qd.waitIdle()
  await ctx.wait(400) // the word pill's spring settles

  const state = await qd.state()
  equal(state.player.status, 'paused', 'paused')
  equal(state.player.isPlaying, false, 'not playing')
  equal(state.dock, 'bar', 'the bar dock at 1600×1000')

  const report = await page.evaluate(measure, { page: PAGE, ayahId: AYAH_ID, pos: WORD_POS })
  ctx.log(JSON.stringify(report))
  check(report.ok, report.problems.join('\n'))

  await ctx.shot()
  await ctx.shot('page', { clip: report.pageClip })
  await ctx.shot('dock', { clip: report.dockClip })
}

/**
 * Runs in the page: the highlight shapes against 1:2's words, and the dock's readout.
 * @param {{ page: number, ayahId: number, pos: number }} args
 */
function measure({ page, ayahId, pos }) {
  /** @type {string[]} */
  const problems = []
  const section = document.querySelector(`section.mp[data-page="${page}"]`)
  const words = [...(section?.querySelectorAll(`.mp-glyphs .w[data-a="${ayahId}"]:not(.e)`) ?? [])]
  if (words.length < pos) problems.push(`1:2 has ${words.length} words on the page`)
  const word = /** @type {HTMLElement | undefined} */ (words[pos - 1])
  const wordBox = word?.getBoundingClientRect()
  const audio = [...(section?.querySelectorAll('.mp-hl .hl-audio') ?? [])].map((e) =>
    e.getBoundingClientRect(),
  )
  if (audio.length === 0) problems.push('no audio ayah fill (layer 5)')
  for (const w of words) {
    const b = w.getBoundingClientRect()
    const cx = b.left + b.width / 2
    const cy = b.top + b.height / 2
    const covered = audio.some((r) => cx >= r.left && cx <= r.right && cy >= r.top - 2 && cy <= r.bottom + 2)
    const pill = section?.querySelector('.mp-hl .hl-word')?.getBoundingClientRect()
    const underPill = pill && cx >= pill.left && cx <= pill.right && cy >= pill.top && cy <= pill.bottom
    if (!covered && !underPill)
      problems.push(`word ${w.getAttribute('data-w')} of 1:2 is not under the audio fill`)
  }
  const pill = section?.querySelector('.mp-hl .hl-word')?.getBoundingClientRect()
  if (!pill) problems.push('no word pill (layer 6)')
  if (pill && wordBox) {
    const cx = wordBox.left + wordBox.width / 2
    const cy = wordBox.top + wordBox.height / 2
    if (!(cx >= pill.left && cx <= pill.right && cy >= pill.top && cy <= pill.bottom)) {
      problems.push(
        `the word pill (${pill.left},${pill.top},${pill.width}×${pill.height}) is not on word ${pos}`,
      )
    }
  }
  // Other ayahs carry no audio fill.
  for (const w of section?.querySelectorAll(`.mp-glyphs .w:not([data-a="${ayahId}"])`) ?? []) {
    const b = w.getBoundingClientRect()
    const cx = b.left + b.width / 2
    const cy = b.top + b.height / 2
    if (audio.some((r) => cx > r.left + 1 && cx < r.right - 1 && cy > r.top + 1 && cy < r.bottom - 1)) {
      problems.push(`word ${w.getAttribute('data-w')} of another ayah is under the audio fill`)
      break
    }
  }

  const dock = document.querySelector('[data-qd-dock]')
  // The visible pill (the dock's box spans the canvas, so its morph never shifts the layout).
  const db = document.querySelector('[data-qd-dock-pill]')?.getBoundingClientRect()
  if (!dock || dock.getAttribute('data-mode') !== 'bar')
    problems.push(`dock mode ${dock?.getAttribute('data-mode')}`)
  const readout = dock?.querySelector('.readout')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  if (!readout.startsWith('1:2')) problems.push(`readout "${readout}"`)
  if (!readout.includes('00:03')) problems.push(`readout time "${readout}"`)
  const slider = dock?.querySelector('[role="slider"]')
  if (slider?.getAttribute('aria-valuenow') !== '3') {
    problems.push(`scrubber aria-valuenow ${slider?.getAttribute('aria-valuenow')}`)
  }
  const play = dock?.querySelector('.transport .play')
  if (play?.getAttribute('data-state') !== 'paused') problems.push('the play button does not show Play')

  const sb = section?.querySelector('.mp-block')?.getBoundingClientRect()
  const pad = 24
  const pageClip = sb
    ? {
        x: Math.max(0, sb.left - pad),
        y: Math.max(0, sb.top - pad),
        width: sb.width + 2 * pad,
        height: Math.min(sb.height, 420) + pad,
      }
    : { x: 0, y: 0, width: 10, height: 10 }
  const dockClip = db
    ? {
        x: Math.max(0, db.left - 24),
        y: Math.max(0, db.top - 24),
        width: db.width + 48,
        height: db.height + 40,
      }
    : { x: 0, y: 0, width: 10, height: 10 }
  return { ok: problems.length === 0, problems, readout, audio: audio.length, pageClip, dockClip }
}
