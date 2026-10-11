/**
 * `window.__QD_TEST__` (§12.6, D24): the hooks the QA harness (`scripts/qa/*`, `tests/e2e/**`) drives the app through.
 * Owner: WP13a.
 *
 * Installed only when `bootstrap.app.testMode` is set: debug builds started with `QD_TEST=1`, or the browser mock opened
 * with `?qdtest`. Release builds compile test mode out (D24), so `installQdTest()` is a no-op there. `App.svelte` (WP7c)
 * calls it once after mounting (requested in docs/deviations/WP13a.md; until then the browser-mock harness installs it
 * through the dev server). Calling it again, or without test mode, does nothing.
 *
 * What the hooks add on top of the stores:
 * - **IPC tracking.** Every function of the live `api` object is wrapped in place, so `waitIdle()` knows which commands
 *   are in flight. The wrappers forward arguments, `this` and results unchanged.
 * - **Metrics** (§8.18): layout shift, long tasks, the `qd:page` measures, the frame rate while audio plays (the word
 *   glide; frames are requested only then, and not while `sampleFrames(false)`) and CSP violations, from install or
 *   the last `resetMetrics()`; and the memory budgets' counts at the time of the call (PageCache pages, QCF FontFaces
 *   per style).
 * - **Navigation that verifies itself.** `goto()` resolves once the target is on screen and the app is idle, and rejects
 *   with what the reader shows instead.
 *
 * Every method is safe to call through CDP (`page.evaluate`): arguments and results are JSON values.
 */
import { tick } from 'svelte'
import type { OverlayKind, OverlayProps } from '$lib/contracts/overlays'
import { api, call, type Api } from '$lib/ipc'
import type { NavTarget, PlayRequest, Settings } from '$lib/ipc/bindings'
import { app, i18n, pages, player, quran, reader, settings, ui } from '$lib/stores'
import { shapeWarmer } from '$lib/mushaf/warmup'
import { watchPlaying } from './playing.svelte'
import type { CommandData, QdTest, QdTestBusy, QdTestMetrics, QdTestState, WaitIdleOptions } from './types'

export type * from './types'

/** Bumped when the hook surface changes incompatibly; scenarios can check `__QD_TEST__.version`. */
export const QD_TEST_VERSION = 1

/** The default `waitIdle` budget. Generous: a cold QCF font or a slow first query must not fail a scenario. */
export const WAIT_IDLE_TIMEOUT_MS = 10_000

declare global {
  interface Window {
    __QD_TEST__?: QdTest
  }
}

// --- IPC tracking ------------------------------------------------------------------------------------------------------

type AnyFn = (this: unknown, ...args: unknown[]) => unknown

/** The unwrapped `api` functions, restored by `uninstallQdTest()`. */
const originals = new Map<string, AnyFn>()
/** Commands in flight: call id → command name. */
const inflight = new Map<number, string>()
/** Incremented on every command call; `waitIdle` uses it to notice calls started during its settle frames. */
let ipcSeq = 0

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function trackIpc(): void {
  const target = api as unknown as Record<string, unknown>
  for (const name of Object.keys(target)) {
    const original = target[name]
    if (typeof original !== 'function') continue
    const fn = original as AnyFn
    originals.set(name, fn)
    target[name] = function tracked(this: unknown, ...args: unknown[]): unknown {
      const id = ++ipcSeq
      inflight.set(id, name)
      let result: unknown
      try {
        result = fn.apply(this, args)
      } catch (e) {
        inflight.delete(id)
        throw e
      }
      if (!isThenable(result)) {
        inflight.delete(id)
        return result
      }
      return Promise.resolve(result).finally(() => inflight.delete(id))
    }
  }
}

function untrackIpc(): void {
  const target = api as unknown as Record<string, unknown>
  for (const [name, fn] of originals) target[name] = fn
  originals.clear()
  inflight.clear()
}

// --- metrics -------------------------------------------------------------------------------------------------------------

/** `LayoutShift` (Layout Instability API), not in the DOM lib yet. */
interface LayoutShiftEntry extends PerformanceEntry {
  value: number
  hadRecentInput: boolean
}

const PAGE_MEASURE = 'qd:page'

const m = {
  since: 0,
  cls: 0,
  longTasks: 0,
  pageRenderMs: [] as number[],
  glideFrames: 0,
  glideMs: 0,
  glideMaxFrameMs: 0,
  cspViolations: 0,
}
const disposers: Array<() => void> = []

/**
 * The glide's frame sampler: on while audio plays, unless switched off (`sampleFrames(false)`). It requests a frame on
 * every vsync, which the app itself does not do while reciting (the player samples at word starts, the glide is a
 * compositor animation): the metrics suite measures playback CPU with it off.
 */
const sampler = { wanted: true, playing: false, sync: (): void => {} }

function resetMetricWindow(): void {
  m.since = performance.now()
  m.cls = 0
  m.longTasks = 0
  m.pageRenderMs = []
  m.glideFrames = 0
  m.glideMs = 0
  m.glideMaxFrameMs = 0
  m.cspViolations = 0
}

/** Observes one entry type (buffered, so entries from before the install count); `false` when unsupported. */
function observe(type: string, onEntry: (entry: PerformanceEntry) => void): boolean {
  if (typeof PerformanceObserver === 'undefined') return false
  if (!(PerformanceObserver.supportedEntryTypes ?? []).includes(type)) return false
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) onEntry(entry)
  })
  try {
    observer.observe({ type, buffered: true })
  } catch {
    return false
  }
  disposers.push(() => observer.disconnect())
  return true
}

const round = (value: number, places: number): number => {
  const f = 10 ** places
  return Math.round(value * f) / f
}

function startMetrics(): void {
  resetMetricWindow()
  observe('layout-shift', (entry) => {
    const shift = entry as LayoutShiftEntry
    if (!shift.hadRecentInput) m.cls += shift.value
  })
  observe('longtask', () => {
    m.longTasks += 1
  })
  observe('measure', (entry) => {
    if (entry.name === PAGE_MEASURE) m.pageRenderMs.push(round(entry.duration, 2))
  })

  const onCsp = (): void => {
    m.cspViolations += 1
  }
  document.addEventListener('securitypolicyviolation', onCsp)
  disposers.push(() => document.removeEventListener('securitypolicyviolation', onCsp))

  // Frame sampler for the glide: it runs only while audio plays (no frame is requested otherwise, so it never weighs
  // on idle or navigation measurements), and counts frames of a visible document.
  if (typeof requestAnimationFrame === 'function') {
    let last: number | null = null
    let handle = 0
    const sampleGlide = (now: number): void => {
      if (document.visibilityState === 'visible') {
        if (last !== null) {
          const dt = now - last
          m.glideFrames += 1
          m.glideMs += dt
          if (dt > m.glideMaxFrameMs) m.glideMaxFrameMs = dt
        }
        last = now
      } else {
        last = null
      }
      handle = requestAnimationFrame(sampleGlide)
    }
    const stop = (): void => {
      if (handle !== 0) cancelAnimationFrame(handle)
      handle = 0
      last = null
    }
    sampler.sync = () => {
      if (!sampler.playing || !sampler.wanted) stop()
      else if (handle === 0) handle = requestAnimationFrame(sampleGlide)
    }
    const unwatch = watchPlaying((playing) => {
      sampler.playing = playing
      sampler.sync()
    })
    disposers.push(() => {
      unwatch()
      stop()
      sampler.sync = () => {}
      sampler.playing = false
      sampler.wanted = true
    })
  }
}

/** The QCF page FontFaces in `document.fonts`, per style (§8.18: ≤ 24 per style). */
function qcfFontFaces(): Record<string, number> {
  const counts: Record<string, number> = {}
  if (typeof document === 'undefined' || !document.fonts) return counts
  for (const face of document.fonts) {
    const style = /^qcf-(v[124])-p\d+$/.exec(face.family.replace(/["']/g, ''))?.[1]
    if (style) counts[style] = (counts[style] ?? 0) + 1
  }
  return counts
}

function metrics(): QdTestMetrics {
  return {
    cls: round(m.cls, 4),
    longTasks: m.longTasks,
    pageRenderMs: [...m.pageRenderMs],
    glideFps: m.glideMs > 0 ? round((m.glideFrames * 1000) / m.glideMs, 1) : 0,
    glideMaxFrameMs: round(m.glideMaxFrameMs, 1),
    cspViolations: m.cspViolations,
    windowMs: Math.round(performance.now() - m.since),
    pageCacheSize: pages.size,
    qcfFontFaces: qcfFontFaces(),
  }
}

// --- idle ----------------------------------------------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The next animation frame, or 100 ms when frames are throttled (hidden window, jsdom). */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 100)
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        clearTimeout(timer)
        resolve()
      })
    }
  })
}

function describeAnimation(animation: Animation): string {
  if (typeof CSSTransition !== 'undefined' && animation instanceof CSSTransition)
    return `transition ${animation.transitionProperty}`
  if (typeof CSSAnimation !== 'undefined' && animation instanceof CSSAnimation)
    return `animation ${animation.animationName}`
  return animation.id ? `animation #${animation.id}` : 'animation'
}

function runningAnimations(): string[] {
  if (typeof document.getAnimations !== 'function') return []
  const running: string[] = []
  for (const animation of document.getAnimations()) {
    if (animation.playState !== 'running') continue
    const end = animation.effect?.getComputedTiming().endTime
    // Infinite (spinners, pulses) and scroll-driven animations never end, so they never block idleness.
    if (typeof end !== 'number' || !Number.isFinite(end)) continue
    running.push(describeAnimation(animation))
  }
  return running
}

function busy(): QdTestBusy {
  return {
    ipc: [...inflight.values()],
    fontsLoading: typeof document.fonts !== 'undefined' && document.fonts.status === 'loading',
    animations: runningAnimations(),
    turning: reader.turning || reader.flipping || document.documentElement.dataset.turn !== undefined,
    shaping: shapeWarmer.pending > 0,
    prefetch: reader.prefetchPending || pages.prefetchPending,
  }
}

function isIdle(b: QdTestBusy): boolean {
  return (
    b.ipc.length === 0 &&
    !b.fontsLoading &&
    b.animations.length === 0 &&
    !b.turning &&
    !b.shaping &&
    !b.prefetch
  )
}

function describeBusy(b: QdTestBusy): string {
  const parts: string[] = []
  if (b.ipc.length) parts.push(`commands in flight: ${b.ipc.join(', ')}`)
  if (b.fontsLoading) parts.push('fonts loading')
  if (b.animations.length) parts.push(`running: ${b.animations.join(', ')}`)
  if (b.turning) parts.push('page turn in progress')
  if (b.shaping) parts.push('shaping warm-up queued')
  if (b.prefetch) parts.push('prefetch scheduled')
  return parts.join('; ') || 'nothing (it never stayed idle for the settle frames)'
}

async function waitIdle(options: WaitIdleOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? WAIT_IDLE_TIMEOUT_MS
  const settleFrames = Math.max(1, options.settleFrames ?? 2)
  const deadline = performance.now() + timeoutMs
  for (;;) {
    await tick()
    if (isIdle(busy())) {
      const seq = ipcSeq
      for (let i = 0; i < settleFrames; i++) await nextFrame()
      await tick()
      if (seq === ipcSeq && isIdle(busy())) return
    } else if (typeof document.fonts !== 'undefined' && document.fonts.status === 'loading') {
      await Promise.race([document.fonts.ready, sleep(50)])
    } else {
      await nextFrame()
    }
    if (performance.now() > deadline)
      throw new Error(`waitIdle: still busy after ${timeoutMs} ms (${describeBusy(busy())})`)
  }
}

// --- navigation, settings, audio, overlays -----------------------------------------------------------------------------

function checkInt(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be an integer in ${min}..=${max}, got ${String(value)}`)
}

/** Verifies that `page` is on screen in Mushaf mode (the translation view has no pages). */
function expectPageVisible(what: string, page: number): void {
  if (settings.value.readingMode !== 'mushaf') return
  if (!reader.visiblePages.includes(page))
    throw new Error(
      `goto(${what}): expected page ${page} on screen, the reader shows page(s) ${reader.visiblePages.join(', ')}`,
    )
}

async function goto(target: NavTarget): Promise<void> {
  switch (target.type) {
    case 'view': {
      ui.setView(target.data.view)
      await waitIdle()
      if (ui.view !== target.data.view)
        throw new Error(`goto(view ${target.data.view}): the view is ${ui.view}`)
      return
    }
    case 'search': {
      ui.navigate(target)
      await waitIdle()
      return
    }
    case 'page': {
      const { page } = target.data
      checkInt('page', page, 1, 604)
      ui.setView('reader')
      reader.goToPage(page, { push: true, transition: false })
      await waitIdle()
      expectPageVisible(`page ${page}`, page)
      return
    }
    case 'ayah': {
      const { ayahId } = target.data
      checkInt('ayahId', ayahId, 1, 6236)
      ui.setView('reader')
      reader.goToAyah(ayahId, { select: false, flash: false, focus: false })
      await waitIdle()
      expectPageVisible(`ayah ${ayahId}`, quran.pageOfAyah(reader.layout, ayahId))
      return
    }
    case 'surah': {
      const { surah } = target.data
      checkInt('surah', surah, 1, 114)
      ui.setView('reader')
      reader.goToSurah(surah)
      await waitIdle()
      expectPageVisible(`surah ${surah}`, quran.pageOfAyah(reader.layout, quran.surahRange(surah).from))
      return
    }
  }
}

async function setSettings(patch: Partial<Settings>): Promise<void> {
  const ok = await settings.update(patch)
  if (!ok)
    throw new Error(`setSettings(${Object.keys(patch).join(', ')}): the settings store reverted the change`)
  await waitIdle()
}

/** QA defaults for `openOverlay(kind)` without props. */
const OVERLAY_DEFAULTS: { [K in OverlayKind]: () => OverlayProps[K] } = {
  palette: () => ({}),
  goto: () => ({}),
  shortcuts: () => ({}),
  onboarding: () => ({}),
  confirm: () => ({
    title: i18n.t('common.appName'),
    body: i18n.t('common.details'),
    confirmLabel: i18n.t('common.ok'),
  }),
  'note-editor': () => ({ fromAyahId: reader.actionTarget, toAyahId: reader.actionTarget }),
  'self-test': () => {
    const range = quran.pageRange(reader.layout, reader.page)
    return { fromAyahId: range.from, toAyahId: range.to }
  },
}

function openOverlay<K extends OverlayKind>(kind: K, props?: OverlayProps[K]): void {
  const defaults = OVERLAY_DEFAULTS[kind] as (() => OverlayProps[K]) | undefined
  if (!defaults) throw new Error(`openOverlay: unknown overlay kind "${String(kind)}"`)
  ui.open(kind, props ?? defaults())
}

function closeOverlays(): void {
  ui.closeContextMenu()
  for (let n = ui.overlays.length; n > 0 && ui.overlays.length > 0; n--) ui.close()
}

/** A plain JSON copy (store values may be frozen or reactive proxies). */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function state(): QdTestState {
  const snapshot = player.snapshot
  return plain({
    version: QD_TEST_VERSION,
    url: location.href,
    ready: app.ready,
    fatal: app.fatal,
    testMode: app.testMode,
    online: app.online,
    view: ui.view,
    overlays: ui.overlays.map((o) => o.kind),
    layerOpen: ui.layerOpen,
    zen: ui.zen,
    sidebarOpen: ui.sidebarOpen,
    sidePaneOpen: ui.sidePaneOpen,
    readingMode: settings.value.readingMode,
    page: reader.page,
    visiblePages: [...reader.visiblePages],
    spread: reader.spread,
    dock: reader.dock,
    qfs: reader.qfs,
    style: reader.style,
    layout: reader.layout,
    cursorAyahId: reader.cursorAyahId,
    selection: reader.selection,
    locale: i18n.locale,
    dir: i18n.dir,
    resolvedTheme: settings.resolvedTheme,
    settings: settings.value,
    player: {
      status: snapshot?.status ?? null,
      isPlaying: player.isPlaying,
      currentAyahId: player.currentAyahId,
      positionMs: player.positionMs,
    },
    ipcPending: [...inflight.values()],
  })
}

async function ipc<K extends keyof Api>(command: K, ...args: Parameters<Api[K]>): Promise<CommandData<K>> {
  const fn = (api as unknown as Record<string, unknown>)[command]
  if (typeof fn !== 'function') throw new Error(`ipc: unknown command "${String(command)}"`)
  const result = (fn as (...a: unknown[]) => ReturnType<Api[K]>)(...args)
  try {
    return await call(
      result as Promise<{ status: 'ok'; data: CommandData<K> } | { status: 'error'; error: string }>,
    )
  } catch (e) {
    // `IpcError.message` is "<kind>: <detail>"; rethrow a plain Error so CDP serialises the message.
    throw new Error(e instanceof Error ? e.message : String(e), { cause: e })
  }
}

const hooks: QdTest = Object.freeze({
  version: QD_TEST_VERSION,
  goto,
  setSettings,
  async play(request: PlayRequest): Promise<void> {
    await call(api.audioPlay(request))
  },
  async seek(ms: number): Promise<void> {
    checkInt('ms', ms, 0, 2 ** 31 - 1)
    await call(api.audioSeek({ type: 'file_ms', data: { ms } }))
  },
  async pause(): Promise<void> {
    await call(api.audioPause())
  },
  openOverlay,
  closeOverlays,
  waitIdle,
  busy,
  metrics,
  resetMetrics: resetMetricWindow,
  sampleFrames(on: boolean): void {
    if (typeof on !== 'boolean') throw new Error('sampleFrames(on): on must be a boolean')
    sampler.wanted = on
    sampler.sync()
  },
  state,
  ipc,
})

let installed = false

/**
 * Installs `window.__QD_TEST__` when the app runs in test mode and returns whether the hooks are installed. Idempotent;
 * dispatches `qd:test-ready` on `window` the first time.
 */
export function installQdTest(): boolean {
  if (installed) return true
  if (!app.testMode) return false
  installed = true
  trackIpc()
  startMetrics()
  Object.defineProperty(window, '__QD_TEST__', { value: hooks, configurable: true, enumerable: false })
  window.dispatchEvent(new CustomEvent('qd:test-ready', { detail: { version: QD_TEST_VERSION } }))
  console.info(`[qd] test mode: window.__QD_TEST__ v${QD_TEST_VERSION} installed`)
  return true
}

/** Removes the hooks, restores the `api` functions and stops the metric observers (unit tests). */
export function uninstallQdTest(): void {
  if (!installed) return
  installed = false
  untrackIpc()
  for (const dispose of disposers.splice(0)) dispose()
  delete window.__QD_TEST__
}
