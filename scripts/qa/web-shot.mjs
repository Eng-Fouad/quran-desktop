// @ts-check
// Browser-mock QA (ARCHITECTURE §12.6; WP13a): runs e2e scenarios against the Svelte UI on the IPC mock
// (`vite --mode mock`, in this process) in the locally installed Microsoft Edge (or Chrome) through playwright-core.
// No browser is ever downloaded.
//
//   pnpm shots:web --serve 1648 --only S19,S20      registry scenarios → artifacts/shots/web/S19.png, S20.png, …
//   pnpm shots:web --serve 1648                     every web scenario of tests/e2e/scenarios
//   node scripts/qa/web-shot.mjs --serve 1648 --name shell            one screenshot of the shell → shell.png
//   node scripts/qa/web-shot.mjs --serve 1648 --scenario path/to/x.mjs
//   node scripts/qa/web-shot.mjs --url http://localhost:1420/ --only S07   against a running `pnpm dev:web`
//
// Run `node scripts/qa/web-shot.mjs --help` for every option. Exit codes: 0 all passed (pending allowed unless --strict),
// 1 a scenario failed, 2 bad usage or the server/browser did not start.
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RegistryError } from '../../tests/e2e/lib/registry.mjs'
import { intOption, parseCli, regexOptions, UsageError, viewportOption } from './lib/cli.mjs'
import { buildPlan } from './lib/plan.mjs'
import { runCleanups } from './lib/proc.mjs'
import { runScenarios } from './lib/runner.mjs'
import { browserChannel, launchBrowser, startMockServer, warmUp, webSession } from './lib/web.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const USAGE = `Usage: node scripts/qa/web-shot.mjs [options]     (pnpm shots:web = --serve 1520 --registry tests/e2e/scenarios)

What to run (default: one screenshot named --name):
  --registry <dir>        scenario registry (default with --only: tests/e2e/scenarios)
  --only <ids>            scenario ids, comma-separated or repeated (S19,S20); ids in sibling suites
                          (tests/e2e/<suite>/<id>.mjs) are found too
  --scenario <file>       one scenario module outside the registry
  --name <shot>           without a scenario: one screenshot <shot>.png (default "page")
  --settle <ms>           wait before that screenshot (default 800)   --full   full-page screenshot
  --list                  list the registry's scenarios and exit

Where:
  --serve <port>          start the mock dev server on 127.0.0.1:<port> in this process (the last --serve wins,
                          so \`pnpm shots:web --serve 1648\` overrides the script's 1520)
  --url <url>             use an already running dev server instead (default http://localhost:1420/)
  --out <dir>             output directory (default artifacts/shots/web)
  --baselines <dir>       baseline directory (default tests/e2e/baselines/web)

Browser:
  --channel <name>        msedge, chrome, or bundled (Playwright's chromium); default $QD_BROWSER_CHANNEL,
                          else msedge on Windows outside CI   --headed
  --width/--height <px>   override every scenario's viewport (default meta.window; 1440×940 for --name)
  --dpr <n>               device pixel ratio override   --dark   --reduced-motion
  --jobs <n>              scenarios in parallel (default 1)

Checks:
  --allow-console <re>    accept console errors matching this regex (repeatable)
  --allow-errors          report page/console errors without failing
  --strict                pending scenarios fail the run
  --update-baselines      store passing screenshots as the new baselines
  --fail-on-diff          fail when a screenshot differs from its baseline (pixelmatch 0.1, > 0.5 % of pixels)
  --timeout <ms>          boot budget per page load (default 30000)
  --scenario-timeout <ms> scenario budget unless meta.timeout (default 120000)
  --verbose               print every console message and the full results
  --help`

const OPTIONS = /** @type {const} */ ({
  registry: { type: 'string' },
  only: { type: 'string', multiple: true },
  scenario: { type: 'string' },
  name: { type: 'string' },
  settle: { type: 'string' },
  full: { type: 'boolean' },
  list: { type: 'boolean' },
  serve: { type: 'string' },
  url: { type: 'string' },
  out: { type: 'string' },
  baselines: { type: 'string' },
  channel: { type: 'string' },
  headed: { type: 'boolean' },
  width: { type: 'string' },
  height: { type: 'string' },
  dpr: { type: 'string' },
  dark: { type: 'boolean' },
  'reduced-motion': { type: 'boolean' },
  jobs: { type: 'string' },
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
  const dpr = args.dpr === undefined ? null : Number(args.dpr)
  if (dpr !== null && !(dpr >= 0.5 && dpr <= 4)) throw new UsageError('--dpr must be a number in 0.5–4')
  const settle = intOption(args.settle, 'settle', 0, 600_000, 800)
  const bootTimeout = intOption(args.timeout, 'timeout', 1000, 600_000, 30_000)
  const scenarioTimeout = intOption(args['scenario-timeout'], 'scenario-timeout', 1000, 3_600_000, 120_000)
  const jobs = intOption(args.jobs, 'jobs', 1, 16, 1)
  const port = intOption(args.serve, 'serve', 1, 65535, null)
  if (port !== null && args.url) throw new UsageError('--serve and --url cannot be combined')
  const full = args.full === true

  const { planned, allIds, registry } = await buildPlan({
    mode: 'web',
    root: ROOT,
    registry: args.registry,
    only: args.only,
    scenario: args.scenario,
    implicit: {
      name: args.name ?? 'page',
      window: viewport ?? [1440, 940],
      run: async (ctx) => {
        await ctx.wait(settle)
        await ctx.shot(undefined, { fullPage: full })
      },
    },
    override: (meta) => ({
      ...meta,
      window: viewport ?? meta.window,
      dpr: dpr ?? meta.dpr,
      colorScheme: args.dark ? 'dark' : meta.colorScheme,
      reducedMotion: args['reduced-motion'] === true || meta.reducedMotion,
    }),
  })
  if (args.list) {
    for (const p of planned)
      console.log(
        `${p.id.padEnd(8)} ${p.meta.mode.padEnd(4)} ${p.meta.window.join('×').padEnd(10)} ${p.meta.description ?? ''}`,
      )
    if (registry) console.log(`(${planned.length} web scenarios in ${registry})`)
    return 0
  }

  let url = args.url ?? 'http://localhost:1420/'
  if (port !== null) {
    const server = await startMockServer({ root: ROOT, port })
    url = server.url
    console.log(`[qa] mock dev server: ${url}`)
  }
  // `?qdtest` sets AppInfo.testMode in the mock, which installs window.__QD_TEST__.
  const target = new URL(url)
  target.searchParams.set('qdtest', '')
  const browser = await launchBrowser({ channel: browserChannel(args.channel), headed: args.headed === true })
  if (port !== null) await warmUp(browser, target.href, bootTimeout)

  const outDir = resolve(args.out ?? join(ROOT, 'artifacts', 'shots', 'web'))
  return runScenarios(
    webSession({ browser, url: target.href, bootTimeout, jobs }),
    planned,
    {
      outDir,
      baselineDir: resolve(args.baselines ?? join(ROOT, 'tests', 'e2e', 'baselines', 'web')),
      updateBaselines: args['update-baselines'] === true,
      failOnDiff: args['fail-on-diff'] === true,
      strict: args.strict === true,
      scenarioTimeout,
      allowConsole: regexOptions(args['allow-console']),
      allowErrors: args['allow-errors'] === true,
      verbose: args.verbose === true,
      title: `Quran QA · browser mock · ${target.host}`,
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
    console.error(`web-shot: ${e instanceof Error ? e.message : String(e)}`)
    if (usage) console.error('Run with --help for the options.')
    else if (!(e instanceof RegistryError) && e instanceof Error && e.stack && process.env.QD_QA_DEBUG)
      console.error(e.stack)
    await runCleanups()
    process.exit(2)
  },
)
