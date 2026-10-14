// @ts-check
// Real-app session for app-driver (Windows / WebView2): launches the debug binary with WebView2 remote debugging,
// attaches playwright-core over CDP and boots one app process per scenario, with its own `QD_DATA_DIR`.
//
// Safety and isolation:
// - `QD_AUDIO_SINK=null` unless the environment or `meta.env` sets it: QA never plays audio through the speakers.
// - The app is single-instance (keyed by the bundle identifier, whatever the exe path) and every debug build shares one
//   WebView2 profile, so app runs of different packages cannot overlap. The driver holds a machine-wide lock for the
//   whole run and waits for any other `quran-desktop` process to exit before launching.
// - The CDP port is 9333 when free, else the next free port up to 9399 (or exactly `--port`).
// - Quitting asks the app to `app_quit`, then kills the process tree (`taskkill /T`) and waits for the WebView2 browser
//   to release the CDP port, so the next launch never attaches to a dying webview.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { waitForBoot } from '../../../tests/e2e/lib/qd.mjs'
import { levelOf } from './console-log.mjs'
import {
  FileLock,
  findFreePort,
  findProcesses,
  isPortFree,
  killTree,
  onExitSync,
  onShutdown,
  sleep,
} from './proc.mjs'

/** @typedef {import('./runner.mjs').Session} Session */
/** @typedef {import('./runner.mjs').Attempt} Attempt */
/** @typedef {import('./console-log.mjs').ConsoleLog} ConsoleLog */
/** @typedef {import('playwright-core').Browser} Browser */
/** @typedef {import('playwright-core').Page} Page */
/** @typedef {import('node:child_process').ChildProcess} ChildProcess */

/** The page whose URL starts with one of these is the app. */
export const APP_ORIGINS = ['http://tauri.localhost', 'http://localhost:1420']
export const DEFAULT_CDP_PORT = 9333
const APP_LOG_TAIL = 8000
const WATCHDOG = fileURLToPath(new URL('./watchdog.mjs', import.meta.url))

/**
 * The binary to run: `--exe`, else `$CARGO_TARGET_DIR/debug`, else `<repo>/target/debug`.
 * @param {string} root
 * @param {string | undefined} exe
 */
export function resolveExe(root, exe) {
  if (exe) return exe
  const targetDir = process.env.CARGO_TARGET_DIR ?? join(root, 'target')
  return join(targetDir, 'debug', process.platform === 'win32' ? 'quran-desktop.exe' : 'quran-desktop')
}

/**
 * Takes the machine-wide app lock and waits until no other Quran process runs.
 * @param {{ exe: string, timeoutMs: number, say: (msg: string) => void }} options
 * @returns {Promise<FileLock>}
 */
export async function acquireAppLock({ exe, timeoutMs, say }) {
  const lock = new FileLock('app')
  await lock.acquire(`app-driver ${process.cwd()} (${exe})`, timeoutMs, (owner) =>
    say(`waiting for another app-driver run (PID ${owner?.pid ?? '?'}: ${owner?.what ?? 'unknown'})…`),
  )
  onShutdown(() => lock.release())
  const image = basename(exe)
  const deadline = Date.now() + timeoutMs
  let nextNotice = 0
  for (;;) {
    const others = findProcesses(image)
    if (others.length === 0) return lock
    if (Date.now() >= deadline) {
      lock.release()
      throw new Error(
        `another ${image} is still running (PID ${others.join(', ')}); the app is single-instance, so close it first`,
      )
    }
    if (Date.now() >= nextNotice) {
      say(`waiting for the running ${image} (PID ${others.join(', ')}) to exit (single-instance app)…`)
      nextNotice = Date.now() + 30_000
    }
    await sleep(2000)
  }
}

/**
 * The CDP port: exactly `requested` (must be free), else 9333 or the next free one up to 9399.
 * @param {number | null} requested
 */
export async function pickCdpPort(requested) {
  if (requested !== null) {
    if (!(await isPortFree(requested)))
      throw new Error(`CDP port ${requested} is in use (another WebView2 or browser with remote debugging?)`)
    return requested
  }
  const port = await findFreePort(DEFAULT_CDP_PORT, DEFAULT_CDP_PORT + 66)
  if (port === null) throw new Error(`no free CDP port in ${DEFAULT_CDP_PORT}–${DEFAULT_CDP_PORT + 66}`)
  return port
}

/** @param {number} port */
const cdpUp = async (port) => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).ok
  } catch {
    return false
  }
}

/**
 * @typedef {object} AppInstance
 * @property {ChildProcess} child
 * @property {number} launchedAt  Date.now() just before the process was spawned (cold-start measurements)
 * @property {Browser} browser
 * @property {Page} page
 * @property {string[]} appLog
 * @property {Promise<number | null>} exited  resolves with the exit code
 * @property {boolean} quitting
 * @property {() => void} unregister  drops the exit-time kill and stops the watchdog (after the app has exited)
 */

/**
 * @param {Page} page
 * @param {ConsoleLog} log
 */
async function captureConsole(page, log) {
  // Our own CDP session, not page.on('console'): enabling Runtime and Log on a new session replays what the webview
  // logged before the attach (the boot), then streams the rest.
  /** @param {{ value?: unknown, unserializableValue?: string, description?: string, type: string }} o */
  const show = (o) =>
    o.value !== undefined
      ? typeof o.value === 'string'
        ? o.value
        : JSON.stringify(o.value)
      : (o.unserializableValue ?? o.description ?? o.type)
  const cdp = await page.context().newCDPSession(page)
  cdp.on('Runtime.consoleAPICalled', (e) => {
    const frame = e.stackTrace?.callFrames[0]
    log.add(
      levelOf(e.type),
      e.args.map(show).join(' '),
      frame?.url ? `${frame.url}:${frame.lineNumber + 1}` : null,
    )
  })
  cdp.on('Runtime.exceptionThrown', (e) => {
    const d = e.exceptionDetails
    log.add('pageerror', d.exception?.description ?? d.text, d.url ? `${d.url}:${d.lineNumber + 1}` : null)
  })
  cdp.on('Log.entryAdded', ({ entry }) => {
    log.add(levelOf(entry.level), entry.text, entry.url ? `${entry.source} ${entry.url}` : entry.source)
  })
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
}

/**
 * Launches the app and attaches to its webview.
 * @param {{ exe: string, env: NodeJS.ProcessEnv, port: number, timeout: number, log: ConsoleLog }} options
 * @returns {Promise<AppInstance>}
 */
async function launch({ exe, env, port, timeout, log }) {
  const started = Date.now()
  const child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false })
  const unregisterExit = onExitSync(() => killTree(child.pid))
  // Kills the app if this driver is killed outright (no exit handler runs then).
  const watchdog = child.pid
    ? spawn(process.execPath, [WATCHDOG, String(process.pid), String(child.pid)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
    : null
  watchdog?.unref()
  const unregister = () => {
    unregisterExit()
    watchdog?.kill()
  }
  /** @type {string[]} */
  const appLog = []
  child.stdout?.on('data', (d) => appLog.push(d.toString()))
  child.stderr?.on('data', (d) => appLog.push(d.toString()))
  /** @type {Error | null} */
  let spawnError = null
  child.once('error', (e) => (spawnError = e))
  /** @type {Promise<number | null>} */
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))

  const fail = (/** @type {string} */ message) => {
    killTree(child.pid)
    unregister()
    const tail = appLog.join('').slice(-APP_LOG_TAIL)
    return new Error(`${message}${tail ? `\n--- app stdout/stderr ---\n${tail}` : ''}`)
  }

  const deadline = started + timeout
  for (;;) {
    if (spawnError) throw fail(`could not start ${exe}: ${/** @type {Error} */ (spawnError).message}`)
    if (child.exitCode !== null) {
      const quick = Date.now() - started < 5000
      throw fail(
        child.exitCode === 0 && quick
          ? `the app exited at once (code 0): another Quran instance is probably running (the app is ` +
              `single-instance and hands over to it); close it and retry`
          : `the app exited early with code ${child.exitCode}`,
      )
    }
    if (await cdpUp(port)) break
    if (Date.now() >= deadline)
      throw fail(`the WebView2 CDP endpoint on :${port} did not come up within ${timeout} ms`)
    await sleep(200)
  }

  /** @type {Browser} */
  let browser
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout })
  } catch (e) {
    throw fail(`could not attach over CDP on :${port}: ${e instanceof Error ? e.message : String(e)}`)
  }
  /** @type {Page | undefined} */
  let page
  while (!page && Date.now() < deadline) {
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => APP_ORIGINS.some((o) => p.url().startsWith(o)))
    if (!page) await sleep(200)
  }
  if (!page) {
    const seen = browser
      .contexts()
      .flatMap((c) => c.pages())
      .map((p) => p.url())
    await browser.close().catch(() => {})
    // A plain `cargo build` into the same target dir replaces the tauri-built exe with one that loads devUrl.
    const hint = seen.some((u) => u.startsWith('chrome-error:'))
      ? '; the exe could not load its page: a plain `cargo build` of src-tauri loads devUrl http://localhost:1420, so ' +
        'rebuild it with `pnpm tauri build --debug --no-bundle` (or start `pnpm dev`)'
      : ''
    throw fail(`no app page on ${APP_ORIGINS.join(' or ')} (pages: ${seen.join(', ') || 'none'})${hint}`)
  }
  await captureConsole(page, log)
  await page.waitForLoadState('domcontentloaded', { timeout })
  return { child, launchedAt: started, browser, page, appLog, exited, quitting: false, unregister }
}

/**
 * Quits the app, then waits for the WebView2 browser to release the CDP port. `how`: `app_quit` (the harness's own
 * quit), or `close`: the user closes the window (what the title bar's × sends), and the app quits by itself
 * (`quit-requested`: the page saves what it holds, then calls `app_quit`). Returns a problem when a closed window did
 * not end the app within 10 s. A tree kill ends whatever is left either way.
 * @param {AppInstance} app
 * @param {number} port
 * @param {'app_quit' | 'close'} [how]
 * @returns {Promise<string | null>}
 */
async function quit(app, port, how = 'app_quit') {
  app.quitting = true
  /** @type {string | null} */
  let problem = null
  if (app.child.exitCode === null) {
    await Promise.race([
      app.page
        .evaluate(async (cmd) => {
          const internals = /** @type {any} */ (window).__TAURI_INTERNALS__
          try {
            await (cmd === 'close'
              ? internals?.invoke('plugin:window|close', { label: 'main' })
              : internals?.invoke('app_quit'))
          } catch {
            /* still a stub, or the window closed under us */
          }
        }, how)
        .catch(() => {}),
      sleep(3000),
    ])
    const code = await Promise.race([
      app.exited,
      sleep(how === 'close' ? 10_000 : 5000).then(() => 'timeout'),
    ])
    if (how === 'close' && code !== 0)
      problem = `closing the window did not quit the app (${code === 'timeout' ? 'still running after 10 s' : `exit code ${code}`})`
  }
  if (app.child.exitCode === null) {
    killTree(app.child.pid)
    await Promise.race([app.exited, sleep(5000)])
  }
  await app.browser.close().catch(() => {})
  app.unregister()
  const deadline = Date.now() + 15_000
  while ((await cdpUp(port)) && Date.now() < deadline) await sleep(250)
  return problem
}

/**
 * @param {{ exe: string, port: number, bootTimeout: number, dataDir: string | null, keepData: boolean,
 *   emulate: 'meta' | 'none' | [number, number] }} options
 *   `emulate`: the viewport (CDP device-metrics emulation): `meta.window`, a fixed size, or the real window.
 * @returns {Session}
 */
export function appSession({ exe, port, bootTimeout, dataDir: sharedDataDir, keepData, emulate }) {
  return {
    mode: 'app',
    jobs: 1,
    async open(sc, log, say) {
      const dataDir = sharedDataDir ?? mkdtempSync(join(tmpdir(), `qd-qa-${sc.id}-`))
      /** @type {NodeJS.ProcessEnv} */
      const env = {
        QD_AUDIO_SINK: 'null',
        ...process.env,
        ...sc.meta.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
        QD_TEST: '1',
        QD_DATA_DIR: dataDir,
      }
      /** @type {string[]} */
      const problems = []
      /** @type {string[]} */
      const logs = []

      /** @returns {Promise<AppInstance>} */
      const start = async () => {
        const app = await launch({ exe, env, port, timeout: bootTimeout, log })
        void app.exited.then((code) => {
          if (!app.quitting) problems.push(`the app exited unexpectedly with code ${code}`)
        })
        try {
          const size = emulate === 'meta' ? sc.meta.window : emulate === 'none' ? null : emulate
          if (size) await app.page.setViewportSize({ width: size[0], height: size[1] })
          await app.page.emulateMedia({
            colorScheme: sc.meta.colorScheme,
            reducedMotion: sc.meta.reducedMotion ? 'reduce' : 'no-preference',
          })
        } catch (e) {
          await quit(app, port)
          throw e
        }
        return app
      }

      /** @type {AppInstance} */
      let app
      try {
        app = await start()
      } catch (e) {
        if (!sharedDataDir && !keepData) rmSync(dataDir, { recursive: true, force: true })
        throw e
      }
      say(`app PID ${app.child.pid}, CDP :${port}, data ${dataDir}`)
      const bootApp = () =>
        waitForBoot(app.page, { timeout: bootTimeout, hookTimeout: 10_000, devHookFallback: false })

      /** @type {Attempt} */
      const attempt = {
        page: app.page,
        boot: { fatal: null, hook: null },
        dataDir,
        get process() {
          return app.child.pid ? { pid: app.child.pid, launchedAt: app.launchedAt } : null
        },
        start: async () => {
          attempt.boot = await bootApp()
        },
        relaunch: async (options = {}) => {
          const problem = await quit(app, port, options.close ? 'close' : 'app_quit')
          if (problem) problems.push(problem)
          logs.push(app.appLog.join(''))
          say(`relaunching with the same data dir${options.close ? ' (the window was closed)' : ''}…`)
          app = await start()
          attempt.page = app.page
          attempt.boot = await bootApp()
        },
        close: async () => {
          await quit(app, port)
          logs.push(app.appLog.join(''))
          const all = logs.join('\n--- relaunch ---\n')
          if (/panicked/.test(all)) problems.push('the app log contains "panicked"')
          if (!sharedDataDir && !keepData) {
            // Windows may refuse the profile for a few seconds after the app and its WebView2 processes exited (EPERM
            // on the directory itself, longer after a window hidden in the tray): try again for up to 15 s.
            for (let tries = 1; ; tries++) {
              try {
                rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
                break
              } catch (e) {
                if (tries < 30) {
                  await sleep(500)
                  continue
                }
                say(`could not remove ${dataDir}: ${e instanceof Error ? e.message : String(e)}`)
                break
              }
            }
          } else if (existsSync(dataDir)) say(`data dir kept: ${dataDir}`)
          return { problems, appLog: all.slice(-APP_LOG_TAIL) || null }
        },
      }
      return attempt
    },
  }
}
