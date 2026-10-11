// @ts-check
// The Node side of `window.__QD_TEST__` (§12.6; WP13a): `createQdClient` (ctx.qd) and `waitForBoot`, shared by the
// browser-mock and real-app runners.
import { ScenarioAssertionError } from './assert.mjs'

/** @typedef {import('playwright-core').Page} Page */
/** @typedef {import('./types').BootInfo} BootInfo */
/** @typedef {import('./types').QdClient} QdClient */

export const HOOK_MISSING =
  'window.__QD_TEST__ is not installed. It needs test mode (real app: a debug build started with QD_TEST=1, which ' +
  'app-driver sets; browser mock: the ?qdtest URL flag, which web-shot sets), a successful bootstrap, and ' +
  'App.svelte calling installQdTest() (WP7c).'

/** Where the fatal screen is: `data-qd-fatal` (requested from WP7c), else the wave-0 FatalScreen markup. */
const FATAL_SELECTOR = '[data-qd-fatal], main.fatal, [data-placeholder="FatalScreen"]'
/** The vite dev-server URL of the hook module (browser mock only). */
const HOOK_MODULE = '/src/lib/testing/qdtest.ts'

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Calls `window.__QD_TEST__[method](...args)` in the page. Errors thrown in the page come back as their message, so a
 * failed `goto` reads "__QD_TEST__.goto: goto(page 262): expected page 262 on screen, …".
 * @param {Page} page
 * @param {string} method
 * @param {unknown[]} args
 * @returns {Promise<any>}
 */
async function callHook(page, method, args) {
  const result = await page.evaluate(async ([m, a]) => {
    const qd = /** @type {Record<string, (...x: unknown[]) => unknown> | undefined} */ (
      /** @type {any} */ (window).__QD_TEST__
    )
    if (!qd) return { missing: true }
    const fn = qd[/** @type {string} */ (m)]
    if (typeof fn !== 'function') return { ok: false, error: `no such hook (version ${String(qd.version)})` }
    try {
      return { ok: true, value: await fn(.../** @type {unknown[]} */ (a)) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }, /** @type {[string, unknown[]]} */ ([method, args]))
  if ('missing' in result) throw new ScenarioAssertionError(`__QD_TEST__.${method}: ${HOOK_MISSING}`)
  if (!result.ok) throw new ScenarioAssertionError(`__QD_TEST__.${method}: ${result.error}`)
  return result.value
}

/**
 * `ctx.qd`. `getPage` is read on every call, so the client follows `ctx.relaunch()`.
 * @param {() => Page} getPage
 * @returns {QdClient}
 */
export function createQdClient(getPage) {
  /** @param {string} method @param {unknown[]} args */
  const run = (method, ...args) => callHook(getPage(), method, args)
  return {
    available: () => getPage().evaluate(() => !!(/** @type {any} */ (window).__QD_TEST__)),
    goto: (target) => run('goto', target),
    setSettings: (patch) => run('setSettings', patch),
    play: (request) => run('play', request),
    seek: (ms) => run('seek', ms),
    pause: () => run('pause'),
    openOverlay: (kind, props) =>
      props === undefined ? run('openOverlay', kind) : run('openOverlay', kind, props),
    closeOverlays: () => run('closeOverlays'),
    waitIdle: (options) => (options === undefined ? run('waitIdle') : run('waitIdle', options)),
    busy: () => run('busy'),
    metrics: () => run('metrics'),
    resetMetrics: () => run('resetMetrics'),
    sampleFrames: (on) => run('sampleFrames', on),
    state: () => run('state'),
    ipc: (command, ...args) => run('ipc', command, ...args),
  }
}

/**
 * @param {Page} page
 * @returns {Promise<{ hook: boolean, vite: boolean, imported: boolean, fatal: BootInfo['fatal'] }>}
 */
function probe(page) {
  return page.evaluate(([fatalSelector, hookModule]) => {
    const el = document.querySelector(fatalSelector)
    const paths = performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname)
    return {
      hook: !!(/** @type {any} */ (window).__QD_TEST__),
      // Served by a Vite dev server, where every module is its own request.
      vite: paths.includes('/@vite/client'),
      // Whether the app imports the hook module (dev server only).
      imported: paths.includes(hookModule),
      fatal: el
        ? {
            kind: el.getAttribute('data-qd-fatal'),
            text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
          }
        : null,
    }
  }, /** @type {[string, string]} */ ([FATAL_SELECTOR, HOOK_MODULE]))
}

/**
 * Waits until the app has mounted and settled: `#app` has content, then either the fatal screen is up or
 * `window.__QD_TEST__` exists (then `waitIdle()`), then `document.fonts.ready`.
 *
 * `devHookFallback` (browser mock only): when the app does not install the hooks itself, import the hook module from
 * the Vite dev server and install it. It resolves to the same module instances as the app (same URLs), so the hooks
 * drive the live stores; the result says `hook: 'harness'` so the report shows the missing wiring.
 * @param {Page} page
 * @param {{ timeout: number, hookTimeout: number, devHookFallback: boolean, idleTimeout?: number }} options
 * @returns {Promise<BootInfo>}
 */
export async function waitForBoot(page, options) {
  try {
    await page.waitForFunction(
      () => {
        const root = document.getElementById('app')
        return root !== null && root.childElementCount > 0
      },
      null,
      { timeout: options.timeout, polling: 50 },
    )
  } catch {
    const html = await page
      .evaluate(() => document.body?.innerHTML.slice(0, 300) ?? '')
      .catch(() => '(page unavailable)')
    throw new ScenarioAssertionError(
      `the app did not mount within ${options.timeout} ms (#app stayed empty; body: ${JSON.stringify(html)})`,
    )
  }

  const deadline = Date.now() + options.hookTimeout
  let p = await probe(page)
  /** @type {BootInfo['hook']} */
  let hook = p.hook ? 'app' : null
  // The browser mock without app wiring: a short grace period for an asynchronous install, then the fallback.
  const fallback = options.devHookFallback && p.vite
  const graceUntil = Date.now() + 300
  while (!p.hook && !p.fatal) {
    const now = Date.now()
    if (fallback && !p.imported && now >= graceUntil) break
    if (now >= deadline) break
    await sleep(50)
    p = await probe(page)
    if (p.hook) hook = 'app'
  }
  if (!p.hook && !p.fatal && fallback) {
    const installed = await page.evaluate(async (url) => {
      try {
        const mod = await import(/* @vite-ignore */ url)
        return /** @type {boolean} */ (mod.installQdTest())
      } catch {
        return false
      }
    }, HOOK_MODULE)
    if (installed) hook = 'harness'
    p = await probe(page)
  }

  if (!p.fatal && p.hook) {
    try {
      await callHook(page, 'waitIdle', options.idleTimeout ? [{ timeoutMs: options.idleTimeout }] : [])
    } catch (e) {
      throw new ScenarioAssertionError(
        `the app did not settle after boot: ${e instanceof Error ? e.message : e}`,
      )
    }
  }
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  return { fatal: p.fatal, hook: p.hook ? hook : null }
}
