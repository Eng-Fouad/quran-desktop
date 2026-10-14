// @ts-check
// S36: translation mode at 1920 × 1080: the centred reading column on its sheet, the Al-Baqarah surah card (cartouche,
// name and meaning, "Medinan · 286 ayahs · p 2", the basmala line) and the recitation's verse highlighted (`--hl-audio`
// and the 3 px accent bar), kept 30 % down the viewport. The reading position is seeded at 1:1 and the app relaunched;
// the recitation then starts paused at 2:1, below the fold: `audio_play` with `startPaused` rests on the basmala
// (ayah 0) as the real engine does, and `audio_seek` moves it to the ayah (never audible). The feed follows it,
// bringing the verse 30 % down.
import { check, equal, waitUntil } from '../lib/index.mjs'
import { installPacks, waitForVerse } from './S21.mjs'

const PACKS = ['tr.en.saheeh', 'tr.ur.junagarhi']
/** 2:1 (Al-Baqarah): ayah id 8, page 2 in the V2 layout (the 2:1–33 fixture window carries the real text). */
const AYAH_ID = 8
const SURAH = 2
const PAGE = 2
/** Where the reader starts: 1:1, so 2:1 is below the fold until the recitation is followed. */
const START = { ayahId: 1, page: 1 }

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1920, 1080],
  ui: 'en',
  theme: 'paper',
  mode: 'web',
  settings: { readingMode: 'translation', translations: PACKS, followAlong: true },
  description:
    'Translation mode at 1920×1080: the column, the Al-Baqarah surah card and the recitation verse',
}

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s36(ctx) {
  const { qd } = ctx
  if (ctx.mode !== 'web') ctx.pending('S36 seeds installed packs in the browser mock')

  // The reader's saved translation position at 1:1 (the user slice of the mock), then the packs, then a relaunch.
  await ctx.page.evaluate(
    ([ayahId, page]) => {
      const mock = /** @type {any} */ (window).__QD_MOCK__
      mock?.state.user.update((/** @type {any} */ u) => {
        u.positions = u.positions.filter((/** @type {any} */ p) => p.context !== 'translation')
        u.positions.push({ context: 'translation', layout: 'v2', page, ayahId, scrollPx: 0, updatedAt: 0 })
      })
    },
    [START.ayahId, START.page],
  )
  await installPacks(ctx, PACKS)
  await qd.waitIdle()
  await startPausedAt(ctx)
  await qd.waitIdle()

  const state = await qd.state()
  equal(state.readingMode, 'translation', 'reading mode')
  equal(state.player.currentAyahId, AYAH_ID, 'the recitation verse')

  await waitForVerse(ctx, AYAH_ID, PACKS.length)
  // Following the recitation puts the verse 30 % down the feed (it settles after a smooth scroll).
  const layout = await waitUntil(
    async () => {
      const m = await ctx.page.evaluate(measure, /** @type {[number, number]} */ ([AYAH_ID, SURAH]))
      return m.verse && Math.abs(m.verse.topPct - 30) <= 4 ? m : null
    },
    { timeout: 8000, message: 'the recitation verse 30 % from the top' },
  )
  ctx.log(JSON.stringify(layout))
  check(layout.verse?.playing === true, 'the verse is marked as the recitation verse')
  check(layout.column.width === 760, `the reading column is 760 px wide (${layout.column.width})`)
  check(
    Math.abs(layout.column.center - layout.canvas.center) <= 1,
    `the column is centred in the canvas (${layout.column.center} vs ${layout.canvas.center})`,
  )
  check(layout.card !== null, 'the Al-Baqarah card is on screen')
  if (layout.card) {
    check(layout.card.text.includes('Al-Baqarah'), `the card names the surah ("${layout.card.text}")`)
    check(layout.card.text.includes('286 ayahs'), `the card counts the ayahs ("${layout.card.text}")`)
    check(layout.card.text.includes(`p ${PAGE}`), `the card gives the page ("${layout.card.text}")`)
    check(layout.card.basmala, 'the card shows the basmala line')
  }
  await ctx.shot()
}

/**
 * Starts the recitation paused at 2:1: a paused play of Al-Baqarah rests on its basmala (ayah 0, as the real engine
 * does), so an ayah seek follows (the mock holds a seek sent while the play is still loading).
 * @param {import('../lib/types').ScenarioContext} ctx
 */
async function startPausedAt(ctx) {
  await ctx.qd.play({
    reciterId: 7,
    from: { surah: SURAH, ayah: 1 },
    to: null,
    stopAt: 'end_of_surah',
    layout: 'v2',
    ayahRepeat: 1,
    rangeRepeat: 1,
    gap: { type: 'none' },
    startPaused: true,
  })
  await ctx.qd.ipc('audioSeek', { type: 'ayah', data: { ayahId: AYAH_ID } })
  await waitUntil(async () => (await ctx.qd.state()).player.currentAyahId === AYAH_ID, {
    timeout: 5000,
    message: 'the paused recitation at 2:1',
  })
}

/**
 * Runs in the page: where the recitation verse, the card and the reading column are.
 * @param {[number, number]} args
 */
function measure([ayahId, surah]) {
  const scroller = document.querySelector('.qd-virtual-list')
  const canvas = document.querySelector('main#qd-main')
  const sheet = document.querySelector('.tv .sheet')
  const verse = document.getElementById(`tv-a${ayahId}`)
  const card = document.querySelector(`article.card[data-surah="${surah}"]`)
  const s = scroller?.getBoundingClientRect()
  const c = canvas?.getBoundingClientRect()
  const col = sheet?.getBoundingClientRect()
  const v = verse?.getBoundingClientRect()
  const cardBox = card?.getBoundingClientRect()
  return {
    canvas: { center: c ? Math.round(c.left + c.width / 2) : 0 },
    column: {
      width: col ? Math.round(col.width) : 0,
      center: col ? Math.round(col.left + col.width / 2) : 0,
    },
    verse:
      v && s
        ? {
            topPct: Math.round(((v.top - s.top) / s.height) * 100),
            playing: verse?.classList.contains('playing') ?? false,
          }
        : null,
    card:
      card && cardBox && s && cardBox.bottom > s.top && cardBox.top < s.bottom
        ? {
            text: card.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            basmala: card.querySelector('.basmala') !== null,
          }
        : null,
  }
}
