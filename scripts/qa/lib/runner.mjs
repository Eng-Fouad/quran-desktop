// @ts-check
// The scenario runner shared by web-shot (browser mock) and app-driver (real app over CDP).
//
// A session opens one "attempt" per scenario (a fresh browser context, or a fresh app process with its own data dir),
// boots the app, applies `meta`, runs the scenario with a `ctx`, and collects screenshots, console output, metrics and
// baseline comparisons into `<out>/<id>.json`. The report (`index.html`, `metrics.json`) is rebuilt at the end.
//
// Status per scenario:
//   passed   the scenario returned, every check held, no page or console error, at least one screenshot
//   failed   it threw, timed out, logged a page/console error, took a blank shot, the app panicked or crashed, or
//            (with --fail-on-diff) a screenshot differs from its baseline
//   pending  ctx.pending(reason), or the fatal screen shows the stub error of a command (the app cannot boot yet); a
//            failure with --strict
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ScenarioAssertionError, ScenarioPending } from '../../../tests/e2e/lib/assert.mjs'
import { createQdClient, HOOK_MISSING } from '../../../tests/e2e/lib/qd.mjs'
import { ConsoleLog } from './console-log.mjs'
import { blankness, compareBaseline } from './images.mjs'
import { RESULT_FORMAT, writeIndex, writeResult } from './report.mjs'
import { sleep } from './proc.mjs'

/** @typedef {import('../../../tests/e2e/lib/types').ResolvedMeta} ResolvedMeta */
/** @typedef {import('../../../tests/e2e/lib/types').ScenarioContext} ScenarioContext */
/** @typedef {import('../../../tests/e2e/lib/types').ScenarioFn} ScenarioFn */
/** @typedef {import('../../../tests/e2e/lib/types').ShotOptions} ShotOptions */
/** @typedef {import('../../../tests/e2e/lib/types').BootInfo} BootInfo */
/** @typedef {import('./report.mjs').ScenarioResult} ScenarioResult */
/** @typedef {import('playwright-core').Page} Page */

/**
 * @typedef {object} Planned  a scenario ready to run
 * @property {string} id
 * @property {string | null} file   null for the implicit single-shot scenario (`--name`, `--shot`)
 * @property {ScenarioFn} run
 * @property {ResolvedMeta} meta
 */

/**
 * @typedef {object} Attempt  one app (browser context or app process) for one scenario
 * @property {Page} page           replaced by `relaunch()`
 * @property {BootInfo} boot        set by `start()`, replaced by `relaunch()`
 * @property {string | null} dataDir
 * @property {{ pid: number, launchedAt: number } | null} process  the app process (app mode), replaced by `relaunch()`
 * @property {() => Promise<void>} start      boots the app (waits for mount, hooks, idle)
 * @property {(options?: { close?: boolean }) => Promise<void>} relaunch  `close`: the user closes the window (app mode)
 * @property {() => Promise<{ problems: string[], appLog: string | null }>} close
 */

/**
 * @typedef {object} Session
 * @property {'web' | 'app'} mode
 * @property {number} jobs  scenarios that may run at the same time
 * @property {(scenario: Planned, log: ConsoleLog, say: (...a: unknown[]) => void) => Promise<Attempt>} open
 *   creates the attempt (page available, console captured); the runner then calls `start()`
 */

/**
 * @typedef {object} RunOptions
 * @property {string} outDir
 * @property {string} baselineDir
 * @property {boolean} updateBaselines
 * @property {boolean} failOnDiff
 * @property {boolean} strict           pending counts as failure
 * @property {number} scenarioTimeout   ms, unless meta.timeout
 * @property {RegExp[]} allowConsole
 * @property {boolean} allowErrors      page/console errors are reported but do not fail
 * @property {boolean} verbose
 * @property {string} title             the report title
 */

const SHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/**
 * The stub error of a command (`AppError::Unsupported` with the stub prefix and the command name). Written with `\s+`
 * so a grep for stubs finds no false positive here.
 */
const WAVE0_STUB = /\bnot\s+implemented:/i

/** The file name (without `.png`) of `ctx.shot(name)`. @param {string} id @param {string | undefined} name */
export function shotBase(id, name) {
  if (name === undefined || name === '' || name === id) return id
  const base = name.startsWith(`${id}-`) ? name : `${id}-${name}`
  if (!SHOT_NAME.test(base) || base.includes('..'))
    throw new ScenarioAssertionError(`invalid screenshot name "${name}" (letters, digits, '.', '_', '-')`)
  return base
}

/**
 * Removes the previous run's outputs of a scenario (`<id>.png`, `<id>-*.png`, `<id>.json`, `diff/<id>…`), so a failed run
 * never leaves an older passing image behind. Files of other scenarios whose id starts with `<id>-` are kept.
 * @param {string} outDir
 * @param {string} id
 * @param {readonly string[]} otherIds
 */
export function removeStaleOutputs(outDir, id, otherIds) {
  const others = otherIds.filter((o) => o !== id && o.startsWith(`${id}-`))
  const owned = (/** @type {string} */ f) => {
    const stem = f.replace(/\.(png|json)$/, '')
    if (stem !== id && !stem.startsWith(`${id}-`)) return false
    return !others.some((o) => stem === o || stem.startsWith(`${o}-`))
  }
  for (const dir of [outDir, join(outDir, 'diff')]) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if ((f.endsWith('.png') || (dir === outDir && f === `${id}.json`)) && owned(f))
        rmSync(join(dir, f), { force: true })
    }
  }
}

/** @param {unknown} e */
const messageOf = (e) => (e instanceof Error ? e.message : String(e))

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, message) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ScenarioAssertionError(message)), ms)
  })
  return /** @type {Promise<T>} */ (Promise.race([promise, timeout]).finally(() => clearTimeout(timer)))
}

/**
 * Runs one scenario and writes its result file.
 * @param {Session} session
 * @param {Planned} sc
 * @param {RunOptions} o
 * @param {readonly string[]} allIds
 * @returns {Promise<ScenarioResult>}
 */
async function runOne(session, sc, o, allIds) {
  const startedAt = new Date()
  const say = (/** @type {unknown[]} */ ...a) => console.log(`[${sc.id}]`, ...a)
  const log = new ConsoleLog({ allow: [...sc.meta.allowConsole, ...o.allowConsole] })
  /** @type {string[]} */
  const shots = []
  /** @type {string[]} */
  const errors = []
  /** @type {string[]} */
  const warnings = []
  /** @type {ScenarioResult['status']} */
  let status = 'passed'
  /** @type {string | null} */
  let pendingReason = null
  /** @type {ScenarioResult['metrics']} */
  let metrics = null
  /** @type {string | null} */
  let appLog = null
  /** @type {Attempt | null} */
  let attempt = null

  removeStaleOutputs(o.outDir, sc.id, allIds)
  const current = () => {
    if (!attempt) throw new ScenarioAssertionError('the app is not running')
    return attempt
  }
  const qd = createQdClient(() => current().page)

  /** @param {string} [name] @param {ShotOptions} [options] */
  const shot = async (name, options = {}) => {
    const base = shotBase(sc.id, name)
    const fileName = `${base}.png`
    const file = join(o.outDir, fileName)
    const { selector, idle, allowBlank, ...screenshotOptions } = options
    const page = current().page
    if (idle !== false && current().boot.hook) {
      try {
        await qd.waitIdle()
      } catch (e) {
        warnings.push(`${fileName}: taken while the app was busy (${messageOf(e)})`)
      }
    }
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    const png = selector
      ? await page.locator(selector).screenshot({ ...screenshotOptions, path: file })
      : await page.screenshot({ ...screenshotOptions, path: file })
    if (shots.includes(fileName)) warnings.push(`${fileName} was written twice; the last one is kept`)
    else shots.push(fileName)
    if (!allowBlank) {
      const { blank, color } = blankness(png)
      if (blank) throw new ScenarioAssertionError(`${fileName} is blank (every pixel is ${color})`)
    }
    say(`screenshot: ${file}`)
    return file
  }

  /** @type {ScenarioContext} */
  const ctx = {
    id: sc.id,
    mode: session.mode,
    meta: sc.meta,
    outDir: o.outDir,
    get page() {
      return current().page
    },
    get boot() {
      return current().boot
    },
    get dataDir() {
      return current().dataDir
    },
    get process() {
      return current().process
    },
    qd,
    shot,
    wait: sleep,
    log: say,
    relaunch: async (options) => {
      await current().relaunch(options)
      const { fatal } = current().boot
      if (fatal && !sc.meta.expectFatal)
        throw new ScenarioAssertionError(`after relaunch the app showed its fatal screen: ${fatal.text}`)
    },
    pending: (reason) => {
      throw new ScenarioPending(reason)
    },
    allowConsole: (pattern) => log.allow(typeof pattern === 'string' ? new RegExp(pattern) : pattern),
  }

  const timeout = sc.meta.timeout ?? o.scenarioTimeout
  try {
    attempt = await session.open(sc, log, say)
    await attempt.start()
    const { fatal, hook } = attempt.boot
    if (hook === 'harness')
      warnings.push(
        'window.__QD_TEST__ was installed by the harness: App.svelte does not call installQdTest() yet',
      )
    if (fatal && !sc.meta.expectFatal) {
      await shot(undefined, { idle: false, allowBlank: true })
      if (WAVE0_STUB.test(fatal.text))
        throw new ScenarioPending(`the app cannot boot yet, its bootstrap is a stub: "${fatal.text}"`)
      throw new ScenarioAssertionError(`the app showed its fatal screen: "${fatal.text}"`)
    }
    /** @type {Record<string, unknown>} */
    const patch = { ...(sc.meta.settings ?? {}) }
    if (sc.meta.ui) patch.uiLanguage = sc.meta.ui
    if (sc.meta.theme) patch.theme = sc.meta.theme
    if (Object.keys(patch).length) {
      if (!attempt.boot.hook)
        throw new ScenarioAssertionError(
          `meta asks for settings (${Object.keys(patch).join(', ')}): ${HOOK_MISSING}`,
        )
      await qd.setSettings(patch)
    }
    await withTimeout(
      Promise.resolve(sc.run(ctx)),
      timeout,
      `the scenario did not finish within ${timeout} ms`,
    )
    if (shots.length === 0) await shot()
  } catch (e) {
    if (e instanceof ScenarioPending) {
      status = 'pending'
      pendingReason = e.message
    } else {
      status = 'failed'
      errors.push(messageOf(e))
      if (attempt && !shots.includes(`${sc.id}-failure.png`)) {
        try {
          await withTimeout(
            shot('failure', { idle: false, allowBlank: true }),
            10_000,
            'failure screenshot timed out',
          )
        } catch {
          /* the page is gone; the error above says why */
        }
      }
    }
  } finally {
    if (attempt?.boot.hook) {
      try {
        metrics = await withTimeout(qd.metrics(), 5000, 'metrics timed out')
      } catch {
        /* the page is gone */
      }
    }
    if (attempt) {
      try {
        const closed = await attempt.close()
        errors.push(...closed.problems)
        appLog = closed.appLog
      } catch (e) {
        errors.push(`closing the app failed: ${messageOf(e)}`)
      }
    }
  }

  const failures = log.failures
  if (failures.length && !o.allowErrors)
    errors.push(
      ...failures.map(
        (f) => `${f.level === 'pageerror' ? 'page error' : 'console error'}: ${f.text.split('\n')[0]}`,
      ),
    )
  else if (failures.length) warnings.push(`${failures.length} page/console error(s) ignored (--allow-errors)`)
  warnings.push(...log.warnings.map((w) => `console warning: ${w.text.split('\n')[0]}`))
  if (errors.length) status = 'failed'

  // Baselines are compared for every run, and replaced (--update-baselines) only by a run that passed.
  /** @type {import('./images.mjs').BaselineResult[]} */
  const baselines = []
  for (const s of shots) {
    if (s === `${sc.id}-failure.png`) continue
    try {
      const b = compareBaseline(join(o.outDir, s), o.baselineDir, join(o.outDir, 'diff'), {
        update: o.updateBaselines && status === 'passed',
      })
      baselines.push(b)
      if ((b.status === 'changed' || b.status === 'size') && o.failOnDiff)
        errors.push(
          `${s} differs from its baseline (${b.status === 'size' ? 'size changed' : `${((b.diffRatio ?? 1) * 100).toFixed(2)} % of pixels`})`,
        )
    } catch (e) {
      warnings.push(`${s}: baseline comparison failed: ${messageOf(e)}`)
    }
  }

  if (errors.length) status = 'failed'
  /** @type {ScenarioResult} */
  const result = {
    format: RESULT_FORMAT,
    id: sc.id,
    file: sc.file,
    mode: session.mode,
    status,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    meta: {
      window: sc.meta.window,
      ui: sc.meta.ui,
      theme: sc.meta.theme,
      mode: sc.meta.mode,
      description: sc.meta.description,
    },
    boot: attempt?.boot ?? null,
    shots,
    errors,
    warnings,
    console: log.lines(o.verbose),
    metrics,
    baselines,
    pendingReason,
    appLog: status === 'failed' || o.verbose ? appLog : null,
  }
  writeResult(o.outDir, result)
  return result
}

/**
 * Runs every planned scenario (up to `session.jobs` at a time), prints a summary and rebuilds the report. Returns the
 * process exit code: 0 when every scenario passed (pending allowed unless `strict`), else 1.
 * @param {Session} session
 * @param {Planned[]} planned
 * @param {RunOptions} o
 * @param {readonly string[]} allIds  every id in the registry (protects their files from stale-output cleanup)
 */
export async function runScenarios(session, planned, o, allIds) {
  mkdirSync(o.outDir, { recursive: true })
  /** @type {ScenarioResult[]} */
  const results = []
  let next = 0
  const worker = async () => {
    while (next < planned.length) {
      const sc = /** @type {Planned} */ (planned[next++])
      const result = await runOne(session, sc, o, allIds)
      results.push(result)
      printResult(result, o.verbose)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(session.jobs, planned.length)) }, worker))

  try {
    writeIndex(o.outDir, o.title)
  } catch (e) {
    console.error(`[qa] could not write the report: ${messageOf(e)}`)
  }
  const order = new Map(planned.map((p, i) => [p.id, i]))
  results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  const width = Math.max(...results.map((r) => r.id.length), 4)
  console.log(`\n${o.title}`)
  for (const r of results) {
    const extra = r.status === 'pending' ? `  (${r.pendingReason})` : r.errors[0] ? `  ${r.errors[0]}` : ''
    console.log(
      `  ${r.id.padEnd(width)}  ${r.status.padEnd(7)}  ${(r.durationMs / 1000).toFixed(1).padStart(5)} s  ` +
        `${r.shots.length} shot${r.shots.length === 1 ? '' : 's'}${extra.length > 160 ? `${extra.slice(0, 157)}…` : extra}`,
    )
  }
  const failed = results.filter((r) => r.status === 'failed').length
  const pending = results.filter((r) => r.status === 'pending').length
  console.log(
    `  ${results.length - failed - pending} passed, ${failed} failed, ${pending} pending` +
      `${pending && o.strict ? ' (--strict: pending fails the run)' : ''} · report: ${join(o.outDir, 'index.html')}`,
  )
  return failed > 0 || (o.strict && pending > 0) ? 1 : 0
}

/** @param {ScenarioResult} r @param {boolean} verbose */
function printResult(r, verbose) {
  const tag = `[${r.id}]`
  if (r.console.length && (verbose || r.status !== 'passed' || r.warnings.length))
    console.log(`${tag} --- console ---\n${r.console.map((l) => `${tag} ${l}`).join('\n')}`)
  for (const w of r.warnings) console.log(`${tag} warning: ${w}`)
  for (const e of r.errors) console.error(`${tag} error: ${e}`)
  if (r.appLog && (verbose || r.status === 'failed'))
    console.log(`${tag} --- app stdout/stderr (tail) ---\n${r.appLog}`)
  console.log(
    `${tag} ${r.status.toUpperCase()} in ${(r.durationMs / 1000).toFixed(1)} s (${basename(r.file ?? r.id)})`,
  )
}
