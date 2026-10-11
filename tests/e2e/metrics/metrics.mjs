// @ts-check
// metrics (WP13b; ARCHITECTURE §8.18, §12.6 "Metric assertions", §13.6 runtime rows, §6.4): the real app on Windows.
//
//   pnpm tauri build --debug --no-bundle && pnpm shots:app --only metrics
//
// One app process, in phases; every phase runs even when an earlier one misses its budget. The scenario fails at the
// end with every §8.18/§12.6 miss listed; the §13.6 runtime rows (1 and the memory and CPU of 6) are measured and
// written to the report, and `node scripts/size-budget.mjs` enforces them. Idle CPU is not measured here: test mode's
// own frame sampler and remote debugging would be most of it; `node scripts/qa/idle-cpu.mjs` measures it without them
// and adds its row to the same report.
//   1. cold start to first paint, from just before the spawn (§13.6 ≤ 800 ms)
//   2. a 20-page navigation in qcf_v2 on a fresh data dir: four page turns, five jumps to pages whose fonts are not
//      downloaded yet (cold QCF loads, the D13 cross-fade), back to page 1 and a playback start. CLS = 0, no long task
//      > 50 ms, p95 `qd:page` < 16 ms (§8.18, §12.6)
//   3. QCF FontFaces ≤ 24 per style and PageCache ≤ 48 pages (§8.18), from the QA hook's counts
//   4. page turn (key → new page painted, prefetched) p95 < 50 ms, the 260 ms animation excluded (§8.18)
//   5. flip: a held key turns at 1 page per 70 ms with no frame > 32 ms (§8.11, §8.18)
//   6. playback on the null sink (never the speakers, LEAD 9): glide ≥ 58 fps with no frame > 32 ms (§8.18), the
//      memory of a spread with playback (§13.6 ≤ 350 MB, webview included) and the playback CPU at 1.0× and 1.5×
//      (§13.6 ≤ 3 % / ≤ 6 % of one core). Memory and CPU count the app and every WebView2 process it started: the word
//      glide, the scrubber and the compositor run there, the audio engine in the app. The app's own share, the
//      breakdown by process and what drives the frames (requestAnimationFrame callbacks, running animations) are
//      notes and diagnostics. The glide's frame pacing is sampled in its own window before each CPU window: the QA
//      hook's sampler requests a frame on every vsync, which the app itself does not do while reciting (the player
//      samples at word starts, the glide is a compositor animation), so the CPU windows run with it off
//      (`qd.sampleFrames(false)`) and measure the app, not the instrumentation
//   7. qcf_v4 with tajweed: `#qd-v4-palettes` is applied (§6.4), and over the whole run no `securitypolicyviolation`
//      fired (§6.4: the CSP must not block the palette <style>, inline styles or the quran: fonts)
// It writes artifacts/shots/app/metrics-report.json, which `node scripts/size-budget.mjs` reads for the §13.6 runtime
// rows. The app is the debug build (QD_TEST needs it, D24): its numbers bound the release build's from above.
import os from 'node:os'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUDGETS, METRICS_REPORT_FORMAT, MIB, RUNTIME_ROWS } from '../../../scripts/size-budget.mjs'
import { check, ScenarioAssertionError, waitUntil } from '../lib/index.mjs'
import { paletteState } from '../scenarios/_fonts.mjs'
import { coldStart, flip, frameWork, mean, p95, startRecorder, turnLatency } from './_probes.mjs'
import { describeRoles, sampleCpu, sampleMemory } from './_process.mjs'

/** §8.18 (and §12.6's metric assertions). */
export const FRAME_BUDGETS = Object.freeze({
  cls: 0,
  longTasks: 0,
  pageRenderP95Ms: 16,
  turnP95Ms: 50,
  flipStepMs: 70,
  frameMs: 32,
  glideFps: 58,
  fontFacesPerStyle: 24,
  pageCache: 48,
  cspViolations: 0,
  coldFontLoads: 5,
})

/**
 * CPU windows (ms): long enough that the ±0.3 s of each process query stays within ±1.5 %, and that the audio engine's
 * bursts of decoding average out.
 */
const CPU_WINDOW_MS = 20_000
/** What drives the frames is sampled for this long after the 1.0× CPU window (outside it: the probe costs a little). */
const FRAME_WORK_MS = 2000
/** The glide's frame pacing is sampled for this long before each CPU window. */
const GLIDE_WINDOW_MS = 6000
/** Pages whose QCF v2 fonts a fresh data dir does not have: jumps there are cold font loads. */
const COLD_PAGES = [100, 200, 300, 400, 500]
const NEXT = 'ArrowLeft' // book semantics in both UI languages (§11.3)

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'app',
  settings: { mushafStyle: 'qcf_v2', networkAllowed: true },
  env: { QD_AUDIO_SINK: 'null' },
  timeout: 900_000,
  description:
    '§8.18 frame budgets, CLS, CSP, V4 palettes and the §13.6 runtime rows (cold start, memory, CPU)',
}

/**
 * @typedef {{ id: string, what: string, value: number | null, budget: string, ok: boolean, notes?: string[] }} Row
 */

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function metrics(ctx) {
  const { qd, page } = ctx
  const app = ctx.process
  check(app, 'the metrics need the real app (app-driver), not the browser mock')
  const wait = (/** @type {number} */ ms) => ctx.wait(ms)
  /** @type {Row[]} */
  const rows = []
  /** @type {string[]} */
  const misses = []
  /**
   * @param {string} id @param {string} what @param {number | null} value @param {boolean} ok @param {string} budget
   * @param {string[]} [notes]
   */
  const record = (id, what, value, ok, budget, notes) => {
    rows.push({ id, what, value, budget, ok, ...(notes ? { notes } : {}) })
    const shown = value === null ? 'not measured' : Number.isInteger(value) ? String(value) : value.toFixed(2)
    // The §13.6 runtime rows are enforced by scripts/size-budget.mjs from the report; this scenario gates §8.18.
    const runtime = /** @type {readonly string[]} */ (RUNTIME_ROWS).includes(id)
    const tag = ok ? 'ok  ' : runtime ? 'OVER' : 'MISS'
    ctx.log(
      `${tag} ${what}: ${shown} (budget ${budget}${runtime ? ', size-budget' : ''})${notes ? ` · ${notes.join('; ')}` : ''}`,
    )
    if (!ok && !runtime) misses.push(`${what}: ${shown}, budget ${budget}`)
  }
  const budget = (/** @type {string} */ id) => {
    const b = BUDGETS.find((x) => x.id === id)
    check(b, `no §13.6 budget ${id}`)
    return b
  }
  /** CSP violations are summed over every metrics window (resetMetrics starts a new one). */
  let csp = 0
  const resetMetrics = async () => {
    csp += (await qd.metrics()).cspViolations
    await qd.resetMetrics()
  }
  /** The glide's frame pacing over its own window, sampled by the QA hook (a frame requested on every vsync). */
  const glideWindow = async () => {
    await resetMetrics()
    await wait(GLIDE_WINDOW_MS)
    return qd.metrics()
  }
  /** Playback CPU of the app's tree, with the QA hook's frame sampler off (the app requests no frame of its own). */
  const cpuWindow = async () => {
    await qd.sampleFrames(false)
    try {
      return await sampleCpu(/** @type {{ pid: number }} */ (app).pid, CPU_WINDOW_MS, wait)
    } finally {
      await qd.sampleFrames(true)
    }
  }
  const blur = () =>
    page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })
  const visible = async () => (await qd.state()).visiblePages
  /**
   * `goto` waits for the app to be idle for at most 10 s; a cold QCF font on a slow network can take longer. The page
   * is on screen by then, so wait for the downloads to finish here (up to a minute) and check the page.
   * @param {number} pageNo
   */
  const gotoPage = async (pageNo) => {
    try {
      await qd.goto({ type: 'page', data: { page: pageNo } })
    } catch (error) {
      if (!(error instanceof Error) || !/waitIdle: still busy/.test(error.message)) throw error
      ctx.log(`goto ${pageNo}: still downloading after 10 s, waiting up to 60 s`)
    }
    await qd.waitIdle({ timeoutMs: 60_000 })
    const shown = await visible()
    check(shown.includes(pageNo), `goto ${pageNo}: the reader shows ${shown.join(', ')}`)
  }

  // --- 1. Cold start ----------------------------------------------------------------------------------------------
  const start = await coldStart(page, app.launchedAt)
  const coldBudget = budget('cold-start')
  record(
    'cold-start',
    'cold start to first paint',
    start.ms === null ? null : Math.round(start.ms),
    start.ms !== null && start.ms <= coldBudget.max,
    coldBudget.spec,
    [
      `process spawn → ${start.paint}: native ${Math.round(start.nativeMs)} ms (Rust setup, WebView2) + web ` +
        `${start.webMs === null ? '?' : Math.round(start.webMs)} ms (page load → paint); debug build, CDP enabled`,
    ],
  )

  // --- 2. Navigation session ----------------------------------------------------------------------------------------
  await gotoPage(1)
  await qd.waitIdle({ timeoutMs: 60_000 })
  const cachedBefore = (await qd.ipc('packsItems', 'mushaf.v2')).length
  await blur()
  await resetMetrics()
  const recorder = await startRecorder(page)
  /** @type {number[]} */
  const shownPages = [...(await visible())]
  for (let i = 1; i <= 4; i++) {
    await recorder.mark(`turn ${i}`)
    await page.keyboard.press(NEXT)
    await qd.waitIdle({ timeoutMs: 60_000 })
    shownPages.push(...(await visible()))
  }
  for (const p of [...COLD_PAGES, 1]) {
    await recorder.mark(`goto ${p}`)
    await gotoPage(p)
    await qd.waitIdle({ timeoutMs: 60_000 })
    shownPages.push(...(await visible()))
  }
  await recorder.mark('playback start')
  await qd.play(playRequest({ rangeRepeat: 1 }))
  await waitUntil(async () => (await qd.state()).player.isPlaying, {
    timeout: 60_000,
    message: 'playback did not start',
  })
  await wait(3000)
  await recorder.mark('pause')
  await qd.pause()
  await qd.waitIdle({ timeoutMs: 30_000 })
  const session = await qd.metrics()
  const sessionLog = await recorder.stop()
  /** Where the layout shifts came from: per action, the shift and the nodes that moved (input-driven ones excluded). */
  const shiftCauses = sessionLog.shifts
    .filter((s) => !s.input)
    .map(
      (s) =>
        `${s.action}: ${s.value.toFixed(4)} ${s.sources.map((x) => `${x.node} ${x.from.join(',')}→${x.to.join(',')}`).join(' | ')}`,
    )
  const taskCauses = sessionLog.longTasks.map((t) => `${t.action}: ${t.ms} ms`)
  const coldLoads = (await qd.ipc('packsItems', 'mushaf.v2')).length - cachedBefore
  const distinct = new Set(shownPages).size
  ctx.log(`session: ${distinct} distinct pages shown, ${coldLoads} QCF v2 page fonts downloaded`)
  check(distinct >= 20, `the session showed ${distinct} distinct pages, not 20`)
  record(
    'cold-font-loads',
    'cold QCF font loads in the session',
    coldLoads,
    coldLoads >= FRAME_BUDGETS.coldFontLoads,
    `≥ ${FRAME_BUDGETS.coldFontLoads}`,
  )
  record(
    'cls',
    'cumulative layout shift (20 pages, cold fonts, playback start)',
    session.cls,
    session.cls <= FRAME_BUDGETS.cls,
    '0',
    shiftCauses.slice(0, 8),
  )
  record(
    'long-tasks',
    'long tasks > 50 ms during navigation',
    session.longTasks,
    session.longTasks <= FRAME_BUDGETS.longTasks,
    'none',
    taskCauses.length ? [taskCauses.join(', ')] : undefined,
  )
  const renderP95 = p95(session.pageRenderMs)
  record(
    'page-render-p95',
    'qd:page render p95 (ms)',
    round(renderP95),
    renderP95 < FRAME_BUDGETS.pageRenderP95Ms,
    `< ${FRAME_BUDGETS.pageRenderP95Ms} ms`,
    [`${session.pageRenderMs.length} renders, max ${round(Math.max(...session.pageRenderMs))} ms`],
  )

  // --- 3. FontFaces per style and the PageCache ------------------------------------------------------------------
  const counts = await qd.metrics()
  const faces = counts.qcfFontFaces
  const maxFaces = Math.max(0, ...Object.values(faces))
  record(
    'font-faces',
    'QCF FontFaces per style',
    maxFaces,
    maxFaces <= FRAME_BUDGETS.fontFacesPerStyle,
    `≤ ${FRAME_BUDGETS.fontFacesPerStyle}`,
    [JSON.stringify(faces)],
  )
  record(
    'page-cache',
    'PageCache pages',
    counts.pageCacheSize,
    counts.pageCacheSize <= FRAME_BUDGETS.pageCache,
    `≤ ${FRAME_BUDGETS.pageCache}`,
  )

  // --- 4. Page turns (prefetched) -----------------------------------------------------------------------------------
  await gotoPage(50)
  await qd.waitIdle({ timeoutMs: 60_000 })
  await blur()
  /** @type {number[]} */
  const turns = []
  for (let i = 0; i < 12; i++) {
    await wait(800) // the neighbours' data and fonts are prefetched after a turn settles
    await qd.waitIdle({ timeoutMs: 60_000 })
    const target = Math.max(...(await visible())) + 1
    turns.push(await turnLatency(page, NEXT, target))
    await qd.waitIdle({ timeoutMs: 60_000 })
  }
  const turnP95 = p95(turns)
  record(
    'turn-p95',
    'page turn key → painted p95 (ms)',
    round(turnP95),
    turnP95 < FRAME_BUDGETS.turnP95Ms,
    `< ${FRAME_BUDGETS.turnP95Ms} ms`,
    [`${turns.length} turns: ${turns.map((t) => Math.round(t)).join(', ')} ms`],
  )

  // --- 5. Flip ------------------------------------------------------------------------------------------------------
  await wait(800)
  await qd.waitIdle({ timeoutMs: 60_000 })
  await blur()
  const flipRun = await flip(page, NEXT, { holdMs: 2100, repeatMs: 33 })
  await qd.waitIdle({ timeoutMs: 60_000 })
  const steps = flipRun.changes.length
  // The first change is the animated turn of the first keydown; the flip proper paces the following ones.
  const intervals = flipRun.changes.slice(1).map((t, i) => t - (flipRun.changes[i] ?? t))
  const stepMs = mean(intervals.slice(1))
  const flipFrame = Math.max(0, ...flipRun.frames)
  const slowFrames = flipRun.frames.filter((f) => f > FRAME_BUDGETS.frameMs).map(Math.round)
  record(
    'flip-step',
    'flip: mean time per page (ms)',
    round(stepMs),
    steps >= 10 && stepMs <= FRAME_BUDGETS.flipStepMs * 1.1,
    `1 page / ${FRAME_BUDGETS.flipStepMs} ms (+10 % timer slack)`,
    [`${steps} page changes in ${flipRun.windowMs} ms, pages ${flipRun.pages[0]} → ${flipRun.pages.at(-1)}`],
  )
  record(
    'flip-frame',
    'flip: longest frame (ms)',
    round(flipFrame),
    flipFrame <= FRAME_BUDGETS.frameMs,
    `≤ ${FRAME_BUDGETS.frameMs} ms`,
    [
      `${flipRun.frames.length} frames, mean ${round(mean(flipRun.frames))} ms, ${slowFrames.length} over ${FRAME_BUDGETS.frameMs} ms: ${slowFrames.join(', ') || 'none'}`,
    ],
  )

  // --- 6. Playback: glide, memory, CPU ------------------------------------------------------------------------------
  await gotoPage(1)
  await qd.waitIdle({ timeoutMs: 60_000 })
  await qd.play(playRequest({ rangeRepeat: 4 }))
  await waitUntil(async () => (await qd.state()).player.isPlaying, {
    timeout: 60_000,
    message: 'playback did not start',
  })
  await wait(6000) // al-Fatiha's file is streamed into the cache in the first seconds
  const glide = await glideWindow()
  const cpu1x = await cpuWindow()
  const mem = sampleMemory(app.pid)
  check((await qd.state()).player.isPlaying, 'playback stopped during the 1.0× window')
  // What drives the frames without the QA sampler: the app's own requestAnimationFrame callbacks and animations.
  await qd.sampleFrames(false)
  const work1x = await frameWork(page, FRAME_WORK_MS)
  await qd.sampleFrames(true)
  record(
    'glide-fps',
    'word glide frame rate (fps)',
    glide.glideFps,
    glide.glideFps >= FRAME_BUDGETS.glideFps,
    `≥ ${FRAME_BUDGETS.glideFps}`,
  )
  record(
    'glide-frame',
    'word glide longest frame (ms)',
    glide.glideMaxFrameMs,
    glide.glideMaxFrameMs <= FRAME_BUDGETS.frameMs,
    `≤ ${FRAME_BUDGETS.frameMs} ms`,
  )
  // Memory as Task Manager counts it: the private working sets of the app's processes (summing the working sets would
  // count the WebView2 DLLs shared by its processes once per process).
  const rssBudget = budget('rss')
  record(
    'rss',
    'memory with a spread + playback (MiB, webview included)',
    round(mem.privateWorkingSet / MIB),
    mem.privateWorkingSet <= rssBudget.max,
    rssBudget.spec,
    [
      `private working sets of ${mem.processes} processes (app ${round(mem.app / MIB)} MiB); working sets summed ${round(mem.workingSet / MIB)} MiB`,
      `by process: ${describeRoles(mem.byRole, (v) => `${Math.round(v / MIB)} MiB`)}`,
    ],
  )
  // Playback CPU (§13.6 "of one core"): the app and its WebView2 processes, like the memory and idle rows. The app's
  // own share (the audio engine) is a note: the per-frame glide and scrubber cost the renderer and GPU processes.
  const cpu1xBudget = budget('playback-cpu-1x')
  record(
    'playback-cpu-1x',
    'playback CPU at 1.0× (app + webview)',
    round(cpu1x.treePercent),
    cpu1x.treePercent <= cpu1xBudget.max,
    cpu1xBudget.spec,
    [
      ...cpuNotes(cpu1x, glide.glideFps),
      `frames the app drives (QA sampler off): ${
        work1x.rafPerSecond.map((r) => `${r.perSecond}/s ${r.source}`).join(' | ') ||
        'no requestAnimationFrame'
      }; running animations: ${work1x.animations.join(', ') || 'none'}`,
    ],
  )
  await qd.ipc('audioSetSpeed', 150)
  await wait(2000)
  const glide15x = await glideWindow()
  const cpu15x = await cpuWindow()
  check((await qd.state()).player.isPlaying, 'playback stopped during the 1.5× window')
  const cpu15xBudget = budget('playback-cpu-1.5x')
  record(
    'playback-cpu-1.5x',
    'playback CPU at 1.5× (app + webview)',
    round(cpu15x.treePercent),
    cpu15x.treePercent <= cpu15xBudget.max,
    cpu15xBudget.spec,
    cpuNotes(cpu15x, glide15x.glideFps),
  )
  await qd.pause()
  await qd.ipc('audioSetSpeed', 100)
  await qd.waitIdle({ timeoutMs: 30_000 })

  // --- 7. V4 palettes and the CSP -----------------------------------------------------------------------------------
  await resetMetrics()
  await qd.setSettings({ mushafStyle: 'qcf_v4', tajweedColors: true })
  await gotoPage(50)
  await qd.waitIdle({ timeoutMs: 60_000 })
  const state = await qd.state()
  const palette = await paletteState(ctx)
  const fontPalette = await page
    .locator('section.mp[data-page="50"] .mp-glyphs[data-rendition="qcf"] .lw')
    .first()
    .evaluate((el) => getComputedStyle(el).fontPalette)
    .catch(() => null)
  const applied =
    state.style === 'qcf_v4' &&
    palette.rule.startsWith('@font-palette-values --qd-v4') &&
    palette.rule.includes('"qcf-v4-p50"') &&
    fontPalette === '--qd-v4'
  record('v4-palettes', '#qd-v4-palettes applied on page 50', applied ? 1 : 0, applied, 'applied', [
    `style ${state.style}, COLR probe ${palette.supported}, font-palette ${fontPalette}`,
  ])
  await ctx.shot()
  csp += (await qd.metrics()).cspViolations
  record(
    'csp',
    'securitypolicyviolation events over the run',
    csp,
    csp <= FRAME_BUDGETS.cspViolations,
    'none',
  )

  // --- Report ---------------------------------------------------------------------------------------------------------
  /** @type {Record<string, { value: number, notes?: string[] }>} */
  const runtime = {}
  const byId = new Map(rows.map((r) => [r.id, r]))
  const runtimeValue = {
    'cold-start': start.ms,
    rss: mem.privateWorkingSet,
    'playback-cpu-1x': cpu1x.treePercent,
    'playback-cpu-1.5x': cpu15x.treePercent,
  }
  for (const [id, value] of Object.entries(runtimeValue))
    if (value !== null)
      runtime[id] = { value, ...(byId.get(id)?.notes ? { notes: byId.get(id)?.notes } : {}) }
  const report = {
    format: METRICS_REPORT_FORMAT,
    build: 'debug',
    measuredAt: new Date().toISOString(),
    machine: {
      os: `${os.type()} ${os.release()}`,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cores: os.cpus().length,
    },
    rows: runtime,
    checks: rows,
    diagnostics: {
      session: sessionLog,
      turnsMs: turns,
      flip: flipRun,
      playback: { memory: mem, cpu1x, cpu15x, frameWork1x: work1x },
    },
  }
  const file = join(ctx.outDir, 'metrics-report.json')
  // Keep the idle-cpu row that scripts/qa/idle-cpu.mjs may have written into an earlier report.
  if (existsSync(file)) {
    const old = JSON.parse(readFileSync(file, 'utf8'))
    const idleRow = old?.format === METRICS_REPORT_FORMAT ? old.rows?.['idle-cpu'] : undefined
    if (idleRow) report.rows['idle-cpu'] = idleRow
  }
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`)
  ctx.log(`report: ${file}`)
  if (misses.length) throw new ScenarioAssertionError(`over budget:\n${misses.join('\n')}`)
}

/** @param {number} n */
function round(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : n
}

/** @param {number} percent */
const pct = (percent) => `${percent.toFixed(2)} %`

/**
 * The notes of a playback CPU row: the app's share and the WebView2 processes', by process, and the window.
 * @param {import('./_process.mjs').CpuSample} sample @param {number} glideFps the word glide's frame rate meanwhile
 */
function cpuNotes(sample, glideFps) {
  return [
    `app ${pct(sample.appPercent)} (audio engine, IPC) + WebView2 ${pct(sample.webviewPercent)}; by process: ${describeRoles(sample.byRole, pct)}`,
    `${(sample.windowMs / 1000).toFixed(1)} s window, word glide at ${glideFps} fps`,
  ]
}

/**
 * Al-Fatiha by Mishary Alafasy (reciter 7), 1:1–1:7.
 * @param {{ rangeRepeat: number }} options
 * @returns {import('../../../src/lib/ipc/bindings').PlayRequest}
 */
function playRequest({ rangeRepeat }) {
  return {
    reciterId: 7,
    from: { surah: 1, ayah: 1 },
    to: { surah: 1, ayah: 7 },
    stopAt: null,
    layout: 'v2',
    ayahRepeat: 1,
    rangeRepeat,
    gap: { type: 'none' },
    startPaused: false,
  }
}
