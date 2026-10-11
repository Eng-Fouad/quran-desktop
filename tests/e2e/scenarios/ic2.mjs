// @ts-check
// IC2 (§12.6, §14.1; WP5e), the real app only: playback and font download end to end.
// 1. Recitation: Alafasy 1:1–1:7 streams from the CDN through the pack layer's shared HTTP client (the timings come
//    through `PackManager::surah_timings`) into the WAV sink (`QD_AUDIO_SINK=wav:…`, never the speakers). The sink's
//    tick log must cover every ayah in order, and every tick's `wordPos` must be the active word the stored timings give
//    for its `fileMs` (the last word that started), so word highlighting follows the recitation exactly.
// 2. Fonts: `mushaf_ensure_page_fonts` downloads the QCF v2 page fonts of pages 1–3 on demand (recorded as cached
//    pages of `mushaf.v2`), and page 1 renders in qcf_v2: one QCF rendition in its page font, every line fitted (§8.4).
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, equal, waitUntil } from '../lib/index.mjs'
import { assertPage, glyphScaleOf } from './_fonts.mjs'

/** The WAV sink's output (absolute, so it does not depend on the app's working directory); its log is `<wav>.log`. */
const WAV = fileURLToPath(new URL('../../../artifacts/ic2.wav', import.meta.url))
const LOG = `${WAV}.log`

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  mode: 'app',
  env: { QD_AUDIO_SINK: `wav:${WAV}` },
  timeout: 300_000,
  description:
    'IC2: 1:1–1:7 into the WAV sink with exact word ticks; QCF v2 pages 1–3 downloaded, page 1 in qcf_v2',
}

/** @typedef {{ seq: number, generation: number, status: string, surah: number, ayah: number, ayahId: number,
 *   fileMs: number, wordPos: number, inGap: boolean }} Tick */

/**
 * The active word at `ms` of one ayah: the last word whose start is at or before `ms` (0 before the first word), the
 * engine's rule (`Segment::word_at`).
 * @param {{ pos: number, startMs: number }[]} words
 * @param {number} ms
 */
function activeWord(words, ms) {
  let pos = 0
  for (const w of [...words].sort((a, b) => a.startMs - b.startMs)) if (w.startMs <= ms) pos = w.pos
  return pos
}

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function ic2(ctx) {
  const { qd } = ctx
  const state = await qd.state()
  check(state.online, 'the app must be online for IC2 (it streams and downloads)')
  equal(state.settings.networkAllowed, true, 'settings.networkAllowed')

  // --- 1. Recitation into the WAV sink ------------------------------------------------------------------------------
  // The sink opened its files when the engine started; ticks are only written once something plays.
  check(existsSync(LOG), `the WAV sink's log ${LOG} exists (QD_AUDIO_SINK reached the engine)`)
  const logBefore = statSync(LOG).size
  await qd.play({
    reciterId: 7,
    from: { surah: 1, ayah: 1 },
    to: { surah: 1, ayah: 7 },
    stopAt: null,
    layout: 'v2',
    ayahRepeat: 1,
    rangeRepeat: 1,
    gap: { type: 'none' },
    startPaused: false,
  })
  await waitUntil(async () => (await qd.state()).player.status === 'playing', {
    timeout: 60_000,
    message: 'the recitation did not start playing',
  })
  ctx.log('playing 1:1–1:7 (Alafasy) into the WAV sink')
  await waitUntil(
    async () => {
      const p = (await qd.state()).player
      return p.status === 'idle' && !p.isPlaying
    },
    { timeout: 180_000, interval: 500, message: 'the recitation did not end' },
  )
  const snapshot = await qd.ipc('audioGetSnapshot')
  equal(snapshot.error, null, 'the playback error')

  const timings = await qd.ipc('audioGetTimings', 7, 1)
  equal(timings.ayahs.length, 7, 'al-Fatiha timings')
  check(timings.wordLevel, 'Alafasy has word-level timings')
  const byAyah = new Map(timings.ayahs.map((a) => [a.ayah, a]))

  const text = readFileSync(LOG, 'utf8').slice(logBefore)
  /** @type {Tick[]} */
  const ticks = text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === 'tick')
    .map((entry) => entry.tick)
  const playing = ticks.filter((t) => t.status === 'playing' && t.surah === 1 && t.ayah >= 1)
  check(playing.length > 100, `too few playing ticks in the log: ${playing.length}`)
  const ayahsHeard = [...new Set(playing.map((t) => t.ayah))]
  equal(ayahsHeard, [1, 2, 3, 4, 5, 6, 7], 'the ayahs of the ticks, in order')
  let mismatches = 0
  /** @type {string[]} */
  const examples = []
  /** @type {Map<number, Set<number>>} */
  const wordsHeard = new Map()
  let lastAyah = 0
  for (const t of playing) {
    check(t.ayah >= lastAyah, `tick ${t.seq}: ayah ${t.ayah} after ${lastAyah}`)
    lastAyah = t.ayah
    const ayah = byAyah.get(t.ayah)
    check(ayah, `no timings for 1:${t.ayah}`)
    const expected = activeWord(ayah.words, t.fileMs)
    if (t.wordPos !== expected) {
      mismatches++
      if (examples.length < 5)
        examples.push(`1:${t.ayah} @${t.fileMs} ms: wordPos ${t.wordPos}, expected ${expected}`)
    }
    if (t.wordPos > 0) {
      const set = wordsHeard.get(t.ayah) ?? new Set()
      set.add(t.wordPos)
      wordsHeard.set(t.ayah, set)
    }
  }
  equal(mismatches, 0, `ticks whose wordPos differs from the timings (${examples.join('; ')})`)
  for (const [ayah, words] of wordsHeard) {
    const total = byAyah.get(ayah)?.words.length ?? 0
    check(words.size >= Math.min(2, total), `1:${ayah}: only ${words.size} of ${total} words highlighted`)
  }
  const wavBytes = statSync(WAV).size
  ctx.log(
    `ticks: ${playing.length} playing, ayahs ${ayahsHeard.join(',')}, words per ayah ` +
      `${[...wordsHeard].map(([a, w]) => `${a}:${w.size}`).join(' ')}; WAV ${wavBytes} bytes`,
  )
  // 48 kHz stereo 32-bit float for ~45 s: well above 1 MB.
  check(wavBytes > 1_000_000, `the WAV holds ${wavBytes} bytes`)
  const reciters = await qd.ipc('audioListReciters')
  const afasy = reciters.find((r) => r.id === 7)
  check(afasy && afasy.cachedSurahs >= 1, 'the streamed surah is recorded as stream cache')

  // --- 2. QCF v2 page fonts ----------------------------------------------------------------------------------------
  const fonts = await qd.ipc('mushafEnsurePageFonts', 'qcf_v2', [1, 2, 3], 'interactive')
  equal(
    fonts.map((f) => [f.page, f.availability, f.family]),
    [
      [1, 'ready', 'qcf-v2-p1'],
      [2, 'ready', 'qcf-v2-p2'],
      [3, 'ready', 'qcf-v2-p3'],
    ],
    'the page fonts',
  )
  for (const f of fonts) {
    check(
      /\/mushaf\/v2\/p\d+\.woff2\?v=[0-9a-f]{8}$/.test(f.url ?? ''),
      `the content-hashed quran:// URL of p${f.page}: ${f.url}`,
    )
    check(f.rel === `mushaf/v2/p${f.page}.woff2`, `rel of p${f.page}: ${f.rel}`)
    check(f.bytes > 1_000, `p${f.page} is ${f.bytes} bytes`)
    check(ctx.dataDir, 'the app runs on a QA data dir')
    const file = join(ctx.dataDir, 'packs', 'mushaf', 'v2', `p${f.page}.woff2`)
    const head = readFileSync(file).subarray(0, 4).toString('latin1')
    equal(head, 'wOF2', `the signature of ${file}`)
  }
  const items = await qd.ipc('packsItems', 'mushaf.v2')
  equal(
    items.map((i) => [i.item, i.pinned]),
    [
      [1, false],
      [2, false],
      [3, false],
    ],
    'pages fetched on demand are cached, not pinned',
  )

  await qd.setSettings({ mushafStyle: 'qcf_v2' })
  await qd.goto({ type: 'page', data: { page: 1 } })
  await qd.waitIdle({ timeoutMs: 30_000 })
  const after = await qd.state()
  equal(after.style, 'qcf_v2', 'the Mushaf style')
  check(after.visiblePages.includes(1), `page 1 on screen (${after.visiblePages.join(', ')})`)
  await assertPage(ctx, 1, {
    style: 'qcf_v2',
    kind: 'qcf',
    availability: 'ready',
    glyphScale: glyphScaleOf('qcf_v2'),
  })
  const faces = await ctx.page.evaluate(() =>
    [...document.fonts].filter((f) => f.family.replace(/["']/g, '') === 'qcf-v2-p1').map((f) => f.status),
  )
  check(faces.includes('loaded'), `the qcf-v2-p1 FontFace is loaded (${faces.join(', ') || 'none'})`)
  await ctx.shot()
  // Keep artifacts/ small: the WAV is evidence only while the run is inspected.
  if (process.env.QD_KEEP_IC2_WAV !== '1') rmSync(WAV, { force: true })
}
