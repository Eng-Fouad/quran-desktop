// @ts-check
// S38 (§7.3, §8.7, §9.6, §13.6; integration gate 3): a recitation costs the webview no frames of its own.
// Al-Fatihah plays (the null sink in the real app, never the speakers) with the word highlight on, page 1 on screen:
// - the page requests no animation frame loop: the player samples the position at word starts and step boundaries
//   (`player.needPosition`), and the only per-frame callback left is the QA hook's own glide sampler (test mode);
// - the word pill is written once per word and glides as a Web Animation (glide.ts), which the compositor runs;
// - app only: closed to the tray while reciting (close-to-tray on), the window is hidden and the page draws no frame at
//   all (the WebView2 controller is made invisible, rust-app round 2, finding 2), while the recitation plays on.
import { frameWork } from '../metrics/_probes.mjs'
import { check, equal, waitUntil } from '../lib/index.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1440, 940],
  ui: 'en',
  theme: 'paper',
  mode: 'both',
  settings: {
    mushafStyle: 'hafs',
    pageMode: 'auto',
    readingMode: 'mushaf',
    wordHighlight: true,
    motion: 'full',
    closeToTray: true,
    closeToTrayAsked: true,
    showTrayIcon: true,
    hintsSeen: ['tray_background'],
  },
  timeout: 120_000,
  description: 'Reciting with the word glide requests no frame loop; hidden in the tray it draws nothing',
}

const WINDOW_MS = 2_000
/** The QA hook's glide sampler, as `frameWork` names it. */
const SAMPLER = /glide sampler/
/** Anything else may ask for a frame now and then (a fade, a toast), never every frame. */
const OTHER_RAF_PER_S = 8

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s38(ctx) {
  const { qd } = ctx
  await qd.goto({ type: 'page', data: { page: 1 } })
  await qd.waitIdle({ timeoutMs: 30_000 })
  await qd.play({
    reciterId: 7,
    from: { surah: 1, ayah: 1 },
    to: { surah: 1, ayah: 7 },
    stopAt: null,
    layout: 'v2',
    ayahRepeat: 1,
    rangeRepeat: 0,
    gap: { type: 'none' },
    startPaused: false,
  })
  await waitUntil(async () => (await qd.state()).player.isPlaying, {
    timeout: 60_000,
    message: 'the recitation did not start',
  })
  await waitUntil(
    () =>
      ctx.page
        .locator('.mp-hl .hl-word')
        .count()
        .then((n) => n === 1),
    {
      timeout: 20_000,
      message: 'no word pill',
    },
  )
  await ctx.wait(1_500)

  // Count the pill's style writes: one batch per word, never per frame. A word can last over a second (Alafasy's
  // al-Fatihah has fewer than one a second), so the count runs until two glides were seen (at most 15 s).
  await ctx.page.evaluate(() => {
    const probe = /** @type {any} */ (window)
    probe.__s38 = { writes: 0, glides: 0, since: performance.now() }
    // The pill is a new element after each gap (between ayahs): watch the highlight layers for it.
    const observer = new MutationObserver((records) => {
      const pills = records.filter(
        (r) => r.target instanceof HTMLElement && r.target.classList.contains('hl-word'),
      )
      probe.__s38.writes += pills.length
      const el = /** @type {HTMLElement | undefined} */ (pills[0]?.target)
      if (el?.getAnimations().some((a) => a.playState === 'running')) probe.__s38.glides += 1
    })
    for (const layer of document.querySelectorAll('.mp-hl'))
      observer.observe(layer, { subtree: true, attributes: true, attributeFilter: ['style'] })
    probe.__s38.stop = () => observer.disconnect()
  })
  const work = await frameWork(ctx.page, WINDOW_MS)
  await waitUntil(() => ctx.page.evaluate(() => /** @type {any} */ (window).__s38.glides >= 2), {
    timeout: 15_000,
    message: 'the word pill did not glide twice within 15 s',
  })
  const pill = await ctx.page.evaluate(() => {
    const probe = /** @type {any} */ (window).__s38
    probe.stop()
    return { writes: probe.writes, glides: probe.glides, ms: Math.round(performance.now() - probe.since) }
  })
  const others = work.rafPerSecond.filter((r) => !SAMPLER.test(r.source))
  const otherPerSecond = others.reduce((sum, r) => sum + r.perSecond, 0)
  ctx.log(
    `frames requested while reciting: ${work.rafPerSecond.map((r) => `${r.perSecond}/s ${r.source}`).join(' | ') || 'none'}; ` +
      `pill: ${pill.writes} style writes, ${pill.glides} glides in ${pill.ms} ms`,
  )
  check((await qd.state()).player.isPlaying, 'the recitation plays on through the window')
  check(
    otherPerSecond <= OTHER_RAF_PER_S,
    `no frame loop of the app's own while reciting (${otherPerSecond} rAF/s besides the QA sampler: ${others
      .map((r) => `${r.perSecond}/s ${r.source}`)
      .join(' | ')})`,
  )
  // A word change writes the box once (a record per property that changed, at most 4); a frame loop writes 120 a second.
  check(
    (pill.writes * 1000) / pill.ms <= 12,
    `the word pill is written once per word, not per frame (${pill.writes} writes in ${pill.ms} ms)`,
  )
  await ctx.shot()

  if (ctx.mode !== 'app') return

  // Closed to the tray while reciting: hidden, no frame drawn, the recitation playing on.
  await ctx.page.evaluate(() => {
    const probe = /** @type {any} */ (window)
    probe.__s38frames = 0
    const loop = () => {
      probe.__s38frames += 1
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  })
  await ctx.wait(500)
  const shown = await ctx.page.evaluate(() => /** @type {any} */ (window).__s38frames)
  check(shown > 10, `frames run while the window is shown (${shown} in 500 ms)`)
  await ctx.page.evaluate(() =>
    /** @type {any} */ (window).__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' }),
  )
  await ctx.wait(1_000)
  const before = await ctx.page.evaluate(() => /** @type {any} */ (window).__s38frames)
  await ctx.wait(WINDOW_MS)
  const after = await ctx.page.evaluate(() => /** @type {any} */ (window).__s38frames)
  const snapshot = /** @type {{ status: string }} */ (await qd.ipc('audioGetSnapshot'))
  ctx.log(`hidden in the tray: ${after - before} frames in ${WINDOW_MS} ms, the engine ${snapshot.status}`)
  equal(snapshot.status, 'playing', 'the recitation plays on in the tray')
  check(
    after - before <= 2,
    `no frame is drawn while hidden in the tray (${after - before} in ${WINDOW_MS} ms)`,
  )
}
