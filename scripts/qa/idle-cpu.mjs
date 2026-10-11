// @ts-check
// Idle CPU of the real app without the QA hooks (WP13b; ARCHITECTURE §13.6 "idle CPU ≈ 0 %"), Windows.
//
//   node scripts/qa/idle-cpu.mjs [--exe <debug exe>] [--seconds 20] [--settle 12] [--report <metrics-report.json>]
//
// The metrics scenario runs in test mode (QD_TEST=1), whose `window.__QD_TEST__` keeps sampling animation frames, and
// with WebView2 remote debugging: both cost CPU in an otherwise idle app. This driver starts the debug build as a user
// would see it (no QD_TEST, no remote debugging; a fresh QD_DATA_DIR and the null audio sink), lets it settle with its
// window visible, samples the CPU of the app and every process it started, and writes the `idle-cpu` row into the
// runtime report that `scripts/size-budget.mjs` reads (default artifacts/shots/app/metrics-report.json). It holds the
// QA app lock, like app-driver, and never touches another Quran process.
//
// Exit codes: 0 measured (within budget or not: size-budget judges), 1 the app could not be measured, 2 bad usage.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUDGETS, METRICS_REPORT_FORMAT } from '../size-budget.mjs'
import { describeRoles, sampleCpu } from '../../tests/e2e/metrics/_process.mjs'
import { acquireAppLock, resolveExe } from './lib/app.mjs'
import { intOption, parseCli, UsageError } from './lib/cli.mjs'
import { killTree, onExitSync, runCleanups, sleep } from './lib/proc.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const OPTIONS = /** @type {const} */ ({
  exe: { type: 'string' },
  seconds: { type: 'string' },
  settle: { type: 'string' },
  report: { type: 'string' },
  'lock-timeout': { type: 'string' },
  help: { type: 'boolean' },
})

const USAGE = `Usage: node scripts/qa/idle-cpu.mjs [--exe <exe>] [--seconds 20] [--settle 12] [--report <file>]
  --exe <path>        the debug binary (default $CARGO_TARGET_DIR/debug/quran-desktop.exe, else target/debug)
  --seconds <n>       the sampling window (default 20)
  --settle <n>        seconds between the launch and the window (default 12: boot, first paint, prefetch)
  --report <file>     the runtime report to update (default artifacts/shots/app/metrics-report.json)
  --lock-timeout <ms> wait this long for other app runs (default 600000)`

/**
 * Writes `row` as the `idle-cpu` row of the report, creating a minimal report when there is none.
 * @param {string} file @param {{ value: number, notes: string[] }} row
 */
export function writeIdleRow(file, row) {
  /** @type {any} */
  let report = {
    format: METRICS_REPORT_FORMAT,
    build: 'debug',
    measuredAt: new Date().toISOString(),
    rows: {},
  }
  if (existsSync(file)) {
    const old = JSON.parse(readFileSync(file, 'utf8'))
    if (old?.format === METRICS_REPORT_FORMAT) report = old
  }
  report.rows = { ...(report.rows ?? {}), 'idle-cpu': row }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`)
}

/** @returns {Promise<number>} */
async function main() {
  const args = parseCli(process.argv.slice(2), OPTIONS)
  if (args.help) {
    console.log(USAGE)
    return 0
  }
  if (process.platform !== 'win32') throw new UsageError('idle-cpu samples Windows processes (CIM) only')
  const seconds = intOption(args.seconds, 'seconds', 5, 600, 20)
  const settle = intOption(args.settle, 'settle', 3, 600, 12)
  const lockTimeout = intOption(args['lock-timeout'], 'lock-timeout', 0, 7_200_000, 600_000)
  const exe = resolve(resolveExe(ROOT, args.exe))
  if (!existsSync(exe))
    throw new UsageError(`binary not found: ${exe} (pnpm tauri build --debug --no-bundle)`)
  const report = resolve(args.report ?? join(ROOT, 'artifacts', 'shots', 'app', 'metrics-report.json'))
  const say = (/** @type {string} */ msg) => console.log(`[idle-cpu] ${msg}`)

  const lock = await acquireAppLock({ exe, timeoutMs: lockTimeout, say })
  const dataDir = mkdtempSync(join(tmpdir(), 'qd-idle-cpu-'))
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, QD_DATA_DIR: dataDir, QD_AUDIO_SINK: 'null' }
  delete env.QD_TEST
  delete env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
  const child = spawn(exe, [], { env, stdio: 'ignore', windowsHide: false })
  const unregister = onExitSync(() => killTree(child.pid))
  try {
    const pid = child.pid
    if (!pid) throw new Error(`could not start ${exe}`)
    say(`app PID ${pid}; settling for ${settle} s with its window visible…`)
    await sleep(settle * 1000)
    if (child.exitCode !== null)
      throw new Error(`the app exited with code ${child.exitCode} (another instance running?)`)
    const sample = await sampleCpu(pid, seconds * 1000, sleep)
    const budget = BUDGETS.find((b) => b.id === 'idle-cpu')
    say(
      `idle CPU ${sample.treePercent.toFixed(2)} % of one core (app ${sample.appPercent.toFixed(2)} %) over ` +
        `${(sample.windowMs / 1000).toFixed(1)} s; budget ${budget?.spec ?? '?'}`,
    )
    const pct = (/** @type {number} */ v) => `${v.toFixed(2)} %`
    writeIdleRow(report, {
      value: sample.treePercent,
      notes: [
        `app ${pct(sample.appPercent)} + WebView2 ${pct(sample.webviewPercent)}; by process: ${describeRoles(sample.byRole, pct)}`,
        `${seconds} s, window visible, no QA hooks or remote debugging`,
      ],
    })
    say(`wrote the idle-cpu row to ${report}`)
    return 0
  } finally {
    killTree(child.pid)
    unregister()
    lock.release()
    await sleep(2000)
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    async (code) => {
      await runCleanups()
      process.exit(code)
    },
    async (e) => {
      console.error(`idle-cpu: ${e instanceof Error ? e.message : String(e)}`)
      if (e instanceof UsageError) console.error(USAGE)
      await runCleanups()
      process.exit(e instanceof UsageError ? 2 : 1)
    },
  )
}
