// @ts-check
// Browser-mock session for web-shot: an in-process Vite dev server in `--mode mock` and the locally installed
// Edge/Chrome through playwright-core (no browser download).
//
// The server runs inside the driver process (`createServer`), so it can never outlive the run as an orphaned `vite`
// process on Windows. It binds 127.0.0.1:<port> with `strictPort`, disables HMR (other packages edit sources while a
// run is in progress; a hot update or full reload mid-scenario would corrupt it), does not forward the browser console
// (the driver captures it) and keeps its pre-bundled dependencies in `node_modules/.vite-qa/<port>`, so concurrent runs
// on different ports never re-optimise each other's dependency cache.
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { waitForBoot } from '../../../tests/e2e/lib/qd.mjs'
import { levelOf } from './console-log.mjs'
import { onShutdown } from './proc.mjs'

/** @typedef {import('./runner.mjs').Session} Session */
/** @typedef {import('./runner.mjs').Attempt} Attempt */
/** @typedef {import('playwright-core').Browser} Browser */
/** @typedef {import('playwright-core').Page} Page */
/** @typedef {import('./console-log.mjs').ConsoleLog} ConsoleLog */

/**
 * Starts `vite --mode mock` in this process on 127.0.0.1:`port`.
 * @param {{ root: string, port: number }} options
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function startMockServer({ root, port }) {
  const { createServer } = await import('vite')
  const server = await createServer({
    root,
    configFile: join(root, 'vite.config.ts'),
    mode: 'mock',
    cacheDir: join(root, 'node_modules', '.vite-qa', String(port)),
    clearScreen: false,
    logLevel: 'warn',
    // The browser console is captured by the driver; Vite's forwarding would wrap `console` and print it twice.
    server: { port, strictPort: true, host: '127.0.0.1', hmr: false, forwardConsole: false },
  })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await server.close()
  }
  try {
    await server.listen()
  } catch (e) {
    await close().catch(() => {})
    const busy = /already in use|EADDRINUSE/i.test(String(e))
    throw new Error(
      busy
        ? `port ${port} is in use (another dev server or QA run): pass --serve <free port>`
        : `the mock dev server did not start: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    )
  }
  onShutdown(close)
  return { url: `http://127.0.0.1:${port}/`, close }
}

/**
 * The browser channel, with the vitest browser project's defaults: `--channel`, else `QD_BROWSER_CHANNEL`, else the
 * installed Microsoft Edge (`msedge`) on Windows outside CI and Playwright's own chromium elsewhere. `bundled` means
 * Playwright's chromium (`pnpm exec playwright install chromium`).
 * @param {string | undefined} requested
 * @returns {string | undefined}  undefined for Playwright's chromium
 */
export function browserChannel(requested) {
  const channel = requested ?? process.env.QD_BROWSER_CHANNEL
  if (channel === 'bundled') return undefined
  return channel ?? (!process.env.CI && process.platform === 'win32' ? 'msedge' : undefined)
}

/**
 * Launches the browser (an installed one through its channel, or Playwright's chromium).
 * @param {{ channel: string | undefined, headed: boolean }} options
 * @returns {Promise<Browser>}
 */
export async function launchBrowser({ channel, headed }) {
  let browser
  try {
    browser = await chromium.launch({ channel, headless: !headed })
  } catch (e) {
    const reason = e instanceof Error ? (e.message.split(/\r?\n/)[0] ?? e.message) : String(e)
    const what = channel ? `the installed browser (channel "${channel}")` : "Playwright's chromium"
    throw new Error(`could not launch ${what}; try --channel chrome, msedge or bundled: ${reason}`, {
      cause: e,
    })
  }
  onShutdown(() => browser.close())
  return browser
}

/**
 * @param {Page} page
 * @param {ConsoleLog} log
 */
function captureConsole(page, log) {
  page.on('console', (m) => {
    const { url, lineNumber } = m.location()
    log.add(levelOf(m.type()), m.text(), url ? `${url}:${lineNumber + 1}` : null)
  })
  page.on('pageerror', (e) => log.add('pageerror', e.stack ?? e.message))
  page.on('crash', () => log.add('pageerror', 'the page crashed'))
}

/**
 * Loads the app once in a throw-away context, so Vite has transformed every module and settled its dependency
 * optimisation before the first scenario (a cold optimisation can force a full page reload).
 * @param {Browser} browser
 * @param {string} url
 * @param {number} timeout
 */
export async function warmUp(browser, url, timeout) {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'load', timeout })
    await page
      .waitForFunction(() => (document.getElementById('app')?.childElementCount ?? 0) > 0, null, { timeout })
      .catch(() => {})
    await page.waitForLoadState('networkidle', { timeout }).catch(() => {})
  } finally {
    await context.close()
  }
}

/**
 * @param {{ browser: Browser, url: string, bootTimeout: number, jobs: number }} options
 * @returns {Session}
 */
export function webSession({ browser, url, bootTimeout, jobs }) {
  return {
    mode: 'web',
    jobs,
    async open(sc, log) {
      const [width, height] = sc.meta.window
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: sc.meta.dpr,
        colorScheme: sc.meta.colorScheme,
        reducedMotion: sc.meta.reducedMotion ? 'reduce' : 'no-preference',
        locale: 'en-US',
        timezoneId: 'UTC',
      })
      context.setDefaultTimeout(30_000)
      const page = await context.newPage()
      captureConsole(page, log)
      const boot = async () => {
        await page.goto(url, { waitUntil: 'load', timeout: bootTimeout })
        return waitForBoot(page, { timeout: bootTimeout, hookTimeout: 5000, devHookFallback: true })
      }
      /** @type {Attempt} */
      const attempt = {
        page,
        boot: { fatal: null, hook: null },
        dataDir: null,
        process: null,
        start: async () => {
          attempt.boot = await boot()
        },
        // The mock keeps its state in this context's localStorage, so a reload is a relaunch (scenario S35). `close`:
        // the window's close first, which the mock answers as Rust does (`quit-requested`); the page saves what it
        // holds and calls `app_quit`, which the mock logs; then the reload.
        relaunch: async (options = {}) => {
          if (options.close) {
            const quitting = page.waitForEvent('console', {
              predicate: (m) => m.text().includes('[mock IPC] app_quit'),
              timeout: 10_000,
            })
            await page.evaluate(() =>
              /** @type {any} */ (window).__TAURI_INTERNALS__.invoke('plugin:window|close', {
                label: 'main',
              }),
            )
            await quitting
          }
          attempt.boot = await boot()
        },
        close: async () => {
          await context.close()
          return { problems: [], appLog: null }
        },
      }
      return attempt
    },
  }
}
