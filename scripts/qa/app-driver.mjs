// @ts-check
// Real-app QA driver (Windows / WebView2, ARCHITECTURE §12.6; WP13a): launches the debug Quran binary with
// WebView2 remote debugging, attaches playwright-core over CDP and runs e2e scenarios through window.__QD_TEST__.
//
//   pnpm tauri build --debug --no-bundle
//   pnpm shots:app --only smoke                       → artifacts/shots/app/smoke.png (+ smoke.json, index.html)
//   node scripts/qa/app-driver.mjs --shot startup     → one screenshot of whatever the app shows
//   node scripts/qa/app-driver.mjs --scenario tests/e2e/scenarios/smoke.mjs --exe C:\qdt\WP6a\debug\quran-desktop.exe
//
// Every scenario gets a fresh app process with a fresh temporary QD_DATA_DIR (unless --data-dir), QD_TEST=1 and
// QD_AUDIO_SINK=null (never the speakers). The run fails when a scenario throws, the webview reports a page or console
// error, a screenshot is blank, or the app log contains "panicked". Run with --help for every option. Exit codes: 0 all
// passed (pending allowed unless --strict), 1 a scenario failed, 2 bad usage or the app could not be started.
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RegistryError } from '../../tests/e2e/lib/registry.mjs'
import { acquireAppLock, appSession, pickCdpPort, resolveExe } from './lib/app.mjs'
import { intOption, parseCli, regexOptions, UsageError, viewportOption } from './lib/cli.mjs'
import { buildPlan } from './lib/plan.mjs'
import { runCleanups } from './lib/proc.mjs'
import { runScenarios } from './lib/runner.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const USAGE = `Usage: node scripts/qa/app-driver.mjs [options]     (pnpm shots:app = --registry tests/e2e/scenarios)

What to run (default: one screenshot named --shot):
  --registry <dir>        scenario registry (default with --only: tests/e2e/scenarios)
  --only <ids>            scenario ids, comma-separated or repeated; ids in sibling suites
                          (tests/e2e/<suite>/<id>.mjs, e.g. WP13b's metrics) are found too
  --scenario <file>       one scenario module outside the registry
  --shot <name>           without a scenario: one screenshot <name>.png of the real window (default "startup")
  --settle <ms>           wait before that screenshot (default 1500)
  --list                  list the registry's app scenarios and exit

App:
  --exe <path>            binary (default $CARGO_TARGET_DIR/debug/quran-desktop.exe, else target/debug)
  --data-dir <dir>        QD_DATA_DIR shared by every scenario (default: a fresh temp dir per scenario)
  --keep-data             keep the temp data dirs
  --port <n>              CDP port (default 9333, or the next free one)
  --lock-timeout <ms>     wait this long for other app runs to finish (default 600000)
  --width/--height <px>   viewport override (default meta.window, emulated over CDP; --shot: the real window)
  --out <dir>             output directory (default artifacts/shots/app)
  --baselines <dir>       baseline directory (default tests/e2e/baselines/app)

Checks:
  --allow-console <re>    accept console errors matching this regex (repeatable)
  --allow-errors          report page/console errors without failing
  --strict                pending scenarios fail the run
  --update-baselines      store passing screenshots as the new baselines
  --fail-on-diff          fail when a screenshot differs from its baseline (pixelmatch 0.1, > 0.5 % of pixels)
  --timeout <ms>          launch and boot budget (default 30000)
  --scenario-timeout <ms> scenario budget unless meta.timeout (default 120000)
  --verbose               print every console message and the app log
  --help`

const OPTIONS = /** @type {const} */ ({
  registry: { type: 'string' },
  only: { type: 'string', multiple: true },
  scenario: { type: 'string' },
  shot: { type: 'string' },
  settle: { type: 'string' },
  list: { type: 'boolean' },
  exe: { type: 'string' },
  'data-dir': { type: 'string' },
  'keep-data': { type: 'boolean' },
  port: { type: 'string' },
  'lock-timeout': { type: 'string' },
  width: { type: 'string' },
  height: { type: 'string' },
  out: { type: 'string' },
  baselines: { type: 'string' },
  'allow-console': { type: 'string', multiple: true },
  'allow-errors': { type: 'boolean' },
  strict: { type: 'boolean' },
  'update-baselines': { type: 'boolean' },
  'fail-on-diff': { type: 'boolean' },
  timeout: { type: 'string' },
  'scenario-timeout': { type: 'string' },
  verbose: { type: 'boolean' },
  help: { type: 'boolean' },
})

/** @returns {Promise<number>} the exit code */
async function main() {
  const args = parseCli(process.argv.slice(2), OPTIONS)
  if (args.help) {
    console.log(USAGE)
    return 0
  }
  const viewport = viewportOption(args.width, args.height)
  const settle = intOption(args.settle, 'settle', 0, 600_000, 1500)
  const bootTimeout = intOption(args.timeout, 'timeout', 1000, 600_000, 30_000)
  const scenarioTimeout = intOption(args['scenario-timeout'], 'scenario-timeout', 1000, 3_600_000, 120_000)
  const lockTimeout = intOption(args['lock-timeout'], 'lock-timeout', 0, 7_200_000, 600_000)
  const requestedPort = intOption(args.port, 'port', 1024, 65535, null)

  const implicit = args.registry === undefined && args.only === undefined && args.scenario === undefined
  const { planned, allIds, registry } = await buildPlan({
    mode: 'app',
    root: ROOT,
    registry: args.registry,
    only: args.only,
    scenario: args.scenario,
    implicit: {
      name: args.shot ?? 'startup',
      window: viewport ?? [1600, 1000],
      run: async (ctx) => {
        await ctx.wait(settle)
        await ctx.shot()
      },
    },
    override: (meta) => ({ ...meta, window: viewport ?? meta.window }),
  })
  if (args.list) {
    for (const p of planned)
      console.log(
        `${p.id.padEnd(8)} ${p.meta.mode.padEnd(4)} ${p.meta.window.join('×').padEnd(10)} ${p.meta.description ?? ''}`,
      )
    if (registry) console.log(`(${planned.length} app scenarios in ${registry})`)
    return 0
  }

  const exe = resolve(resolveExe(ROOT, args.exe))
  if (!existsSync(exe))
    throw new UsageError(
      `binary not found: ${exe}\nBuild it with \`pnpm tauri build --debug --no-bundle\` (or pass --exe).`,
    )
  const say = (/** @type {string} */ msg) => console.log(`[qa] ${msg}`)
  await acquireAppLock({ exe, timeoutMs: lockTimeout, say })
  const port = await pickCdpPort(requestedPort)
  say(`app: ${exe} · CDP :${port}`)

  const dataDir = args['data-dir'] ? resolve(args['data-dir']) : null
  return runScenarios(
    appSession({
      exe,
      port,
      bootTimeout,
      dataDir,
      keepData: args['keep-data'] === true,
      // A plain --shot captures the real window unless a size is given; scenarios get meta.window.
      emulate: viewport ?? (implicit ? 'none' : 'meta'),
    }),
    planned,
    {
      outDir: resolve(args.out ?? join(ROOT, 'artifacts', 'shots', 'app')),
      baselineDir: resolve(args.baselines ?? join(ROOT, 'tests', 'e2e', 'baselines', 'app')),
      updateBaselines: args['update-baselines'] === true,
      failOnDiff: args['fail-on-diff'] === true,
      strict: args.strict === true,
      scenarioTimeout,
      allowConsole: regexOptions(args['allow-console']),
      allowErrors: args['allow-errors'] === true,
      verbose: args.verbose === true,
      title: 'Quran QA · real app',
    },
    allIds,
  )
}

process.on('unhandledRejection', (e) => {
  console.error('[qa] unhandled rejection:', e instanceof Error ? (e.stack ?? e.message) : e)
})

main().then(
  async (code) => {
    await runCleanups()
    process.exit(code)
  },
  async (e) => {
    const usage = e instanceof UsageError
    console.error(`app-driver: ${e instanceof Error ? e.message : String(e)}`)
    if (usage) console.error('Run with --help for the options.')
    else if (!(e instanceof RegistryError) && e instanceof Error && e.stack && process.env.QD_QA_DEBUG)
      console.error(e.stack)
    await runCleanups()
    process.exit(2)
  },
)
