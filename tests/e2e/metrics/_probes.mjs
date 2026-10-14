// @ts-check
// In-page probes for the frame metrics: page-turn latency, flip pacing and frame times. Each probe is installed with
// page.evaluate, the key is pressed from Node (a trusted CDP key event), and the result is read back. Not a scenario
// (the registry skips files starting with `_`).

/** @typedef {import('playwright-core').Page} Page */

/**
 * The 95th percentile (nearest rank) of `values`; NaN when empty.
 * @param {readonly number[]} values
 */
export function p95(values) {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] ?? Number.NaN
}

/** @param {readonly number[]} values */
export const mean = (values) =>
  values.length ? values.reduce((s, v) => s + v, 0) / values.length : Number.NaN

/**
 * Key → new page painted (a page turn): presses `key` and measures from the keydown's timestamp to the first animation
 * frame in which `section.mp[data-page=<target>]` is in the DOM and on screen. The turn animation itself (260 ms) is
 * not part of the budget.
 * @param {Page} page @param {string} key @param {number} target
 * @returns {Promise<number>} ms
 */
export async function turnLatency(page, key, target) {
  await page.evaluate((pageNo) => {
    const w = /** @type {any} */ (window)
    w.__qdTurn = new Promise((resolve, reject) => {
      /** @type {number | null} */
      let keyAt = null
      addEventListener(
        'keydown',
        (e) => {
          keyAt = e.timeStamp
        },
        { capture: true, once: true },
      )
      const deadline = performance.now() + 5000
      const frame = (/** @type {number} */ now) => {
        const section = document.querySelector(`section.mp[data-page="${pageNo}"]`)
        const box = section?.getBoundingClientRect()
        if (keyAt !== null && box && box.width > 0 && box.right > 0 && box.left < innerWidth) {
          resolve(now - keyAt)
          return
        }
        if (now > deadline) reject(new Error(`page ${pageNo} was not painted within 5 s of the key`))
        else requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
  }, target)
  await page.keyboard.press(key)
  return page.evaluate(() => /** @type {any} */ (window).__qdTurn)
}

/**
 * Flipping: holds `key` for `holdMs` with auto-repeat every `repeatMs` (a typematic rate) and records every animation
 * frame and every change of the leading visible page.
 * @param {Page} page @param {string} key @param {{ holdMs: number, repeatMs: number }} timing
 * @returns {Promise<{ frames: number[], changes: number[], pages: number[], windowMs: number }>}
 *   frame durations (ms), the times of the page changes (ms from the first key), the pages seen
 */
export async function flip(page, key, { holdMs, repeatMs }) {
  await page.evaluate(() => {
    const w = /** @type {any} */ (window)
    /** The lowest page on screen, or null in a frame that shows none (a page being swapped). */
    const lead = () => {
      const shown = [...document.querySelectorAll('section.mp')]
        .filter((s) => {
          const r = s.getBoundingClientRect()
          return r.width > 0 && r.right > 0 && r.left < innerWidth
        })
        .map((s) => Number(/** @type {HTMLElement} */ (s).dataset.page))
      return shown.length ? Math.min(...shown) : null
    }
    const state = {
      frames: /** @type {number[]} */ ([]),
      changes: /** @type {number[]} */ ([]),
      pages: [lead()],
      start: 0,
      stop: false,
      last: 0,
    }
    w.__qdFlip = state
    addEventListener(
      'keydown',
      (e) => {
        state.start = e.timeStamp
      },
      { capture: true, once: true },
    )
    const frame = (/** @type {number} */ now) => {
      if (state.stop) return
      if (state.start > 0) {
        if (state.last > 0) state.frames.push(now - state.last)
        state.last = now
        const p = lead()
        if (p !== null && p !== state.pages.at(-1)) {
          state.pages.push(p)
          state.changes.push(now - state.start)
        }
      }
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
  const started = Date.now()
  await page.keyboard.down(key)
  while (Date.now() - started < holdMs) {
    await new Promise((resolve) => setTimeout(resolve, repeatMs))
    await page.keyboard.down(key) // already down: a repeat (KeyboardEvent.repeat = true)
  }
  await page.keyboard.up(key)
  const windowMs = Date.now() - started
  return page.evaluate((ms) => {
    const state = /** @type {any} */ (window).__qdFlip
    state.stop = true
    return { frames: state.frames, changes: state.changes, pages: state.pages, windowMs: ms }
  }, windowMs)
}

/**
 * @typedef {{ action: string, value: number, input: boolean, at: number,
 *   sources: { node: string, from: number[], to: number[] }[] }} ShiftRecord
 * @typedef {{ action: string, ms: number, at: number }} LongTaskRecord
 */

/**
 * Records every layout shift (with the nodes that moved, before and after) and every long task from now on, each
 * labelled with the scripted action that preceded it, so a CLS or long-task miss says what caused it.
 * @param {Page} page
 * @returns {Promise<{ mark(action: string): Promise<void>,
 *   stop(): Promise<{ shifts: ShiftRecord[], longTasks: LongTaskRecord[] }> }>}
 */
export async function startRecorder(page) {
  await page.evaluate(() => {
    /** @param {unknown} node */
    const describe = (node) => {
      if (!(node instanceof Element)) return node instanceof Node ? node.nodeName.toLowerCase() : 'unknown'
      const classes = [...node.classList].slice(0, 3).join('.')
      return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${classes ? `.${classes}` : ''}`
    }
    /** @param {DOMRectReadOnly} r */
    const rect = (r) => [r.x, r.y, r.width, r.height].map(Math.round)
    const rec = {
      action: 'start',
      /** @type {ShiftRecord[]} */ shifts: [],
      /** @type {LongTaskRecord[]} */ longTasks: [],
      stop: () => {},
    }
    const shifts = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const e = /** @type {any} */ (entry)
        rec.shifts.push({
          action: rec.action,
          value: e.value,
          input: e.hadRecentInput,
          at: Math.round(e.startTime),
          sources: (e.sources ?? []).slice(0, 4).map((/** @type {any} */ s) => ({
            node: describe(s.node),
            from: rect(s.previousRect),
            to: rect(s.currentRect),
          })),
        })
      }
    })
    const tasks = new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        rec.longTasks.push({ action: rec.action, ms: Math.round(e.duration), at: Math.round(e.startTime) })
    })
    shifts.observe({ type: 'layout-shift' })
    tasks.observe({ type: 'longtask' })
    rec.stop = () => {
      shifts.disconnect()
      tasks.disconnect()
    }
    ;/** @type {any} */ (window).__qdRecorder = rec
  })
  return {
    mark: (action) =>
      page.evaluate((a) => {
        ;/** @type {any} */ (window).__qdRecorder.action = a
      }, action),
    stop: () =>
      page.evaluate(() => {
        const rec = /** @type {any} */ (window).__qdRecorder
        rec.stop()
        return { shifts: rec.shifts, longTasks: rec.longTasks }
      }),
  }
}

/**
 * @typedef {{ rafPerSecond: { source: string, perSecond: number }[], animations: string[], windowMs: number }}
 *   FrameWork
 */

/**
 * What makes the webview draw frames right now (the playback CPU diagnostics): the `requestAnimationFrame` callbacks
 * per second, by source (the start of each callback's code; the QA hook's own glide sampler is named as such), and the
 * running CSS and Web animations. Wraps `requestAnimationFrame` for `ms`, then restores it.
 * @param {Page} page @param {number} ms
 * @returns {Promise<FrameWork>}
 */
export async function frameWork(page, ms) {
  return page.evaluate(async (windowMs) => {
    const original = window.requestAnimationFrame
    /** @type {Map<string, number>} */
    const counts = new Map()
    /** @param {FrameRequestCallback} cb */
    const label = (cb) => {
      const code = String(cb)
      if (code.includes('glideMaxFrameMs')) return 'the QA hook’s glide sampler (test mode only)'
      return code.replace(/\s+/g, ' ').slice(0, 72)
    }
    window.requestAnimationFrame = (cb) => {
      const source = label(cb)
      counts.set(source, (counts.get(source) ?? 0) + 1)
      return original.call(window, cb)
    }
    const started = performance.now()
    try {
      await new Promise((resolve) => setTimeout(resolve, windowMs))
    } finally {
      window.requestAnimationFrame = original
    }
    const elapsed = performance.now() - started
    /** @param {unknown} node */
    const describe = (node) => {
      if (!(node instanceof Element)) return 'a pseudo-element or none'
      const classes = [...node.classList].slice(0, 3).join('.')
      return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${classes ? `.${classes}` : ''}`
    }
    const animations = document
      .getAnimations()
      .filter((a) => a.playState === 'running')
      .map((a) => {
        const name =
          a instanceof CSSAnimation
            ? `animation ${a.animationName}`
            : a instanceof CSSTransition
              ? `transition ${a.transitionProperty}`
              : `Web animation${a.id ? ` ${a.id}` : ''}`
        return `${name} on ${describe(a.effect instanceof KeyframeEffect ? a.effect.target : null)}`
      })
    return {
      rafPerSecond: [...counts]
        .map(([source, n]) => ({ source, perSecond: Math.round((n * 1000) / elapsed) }))
        .sort((x, y) => y.perSecond - x.perSecond),
      animations,
      windowMs: Math.round(elapsed),
    }
  }, ms)
}

/**
 * Cold start to first paint: from just before the process was spawned to the webview's first contentful paint (the app
 * mounts behind a hidden window and shows it after that paint). Split into the native part (spawn → the webview starts
 * loading the page: Rust setup, databases, WebView2 environment) and the web part (page load → paint).
 * @param {Page} page @param {number} launchedAt Date.now() at spawn
 * @returns {Promise<{ ms: number | null, paint: string, nativeMs: number, webMs: number | null }>}
 */
export async function coldStart(page, launchedAt) {
  const { origin, fcp, fp } = await page.evaluate(() => ({
    origin: performance.timeOrigin,
    fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
    fp: performance.getEntriesByName('first-paint')[0]?.startTime ?? null,
  }))
  const paint = fcp ?? fp
  return {
    ms: paint === null ? null : origin + paint - launchedAt,
    paint: fcp !== null ? 'first-contentful-paint' : 'first-paint',
    nativeMs: origin - launchedAt,
    webMs: paint,
  }
}
