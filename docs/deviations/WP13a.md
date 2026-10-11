# WP13a deviations (QA harness)

Owned: `scripts/qa/**`, `tests/e2e/lib/**`, `tests/e2e/scenarios/smoke.mjs`, `src/lib/testing/**` (`qdtest.ts`, plus the new
`types.ts` and the unit test). WP13a owns no i18n dictionary, so it adds no en/ar strings.

## What exists

| File | Role |
|---|---|
| `scripts/qa/web-shot.mjs` | Browser-mock CLI (`pnpm shots:web`). |
| `scripts/qa/app-driver.mjs` | Real-app CLI (`pnpm shots:app`). |
| `scripts/qa/lib/runner.mjs` | The shared scenario runner: ctx, shots, status, console failures, metrics, baselines, summary, exit code. |
| `scripts/qa/lib/web.mjs` | In-process Vite mock server, browser launch, per-scenario browser context. |
| `scripts/qa/lib/app.mjs` | App launch over CDP, console replay, quit and relaunch, machine-wide lock, CDP port choice. |
| `scripts/qa/lib/watchdog.mjs` | Detached helper that kills the app when the driver is killed outright. |
| `scripts/qa/lib/{cli,plan,proc,console-log,images,report}.mjs` | Arguments, what to run, processes and ports, console capture, blank check and pixelmatch baselines, JSON and HTML report. |
| `tests/e2e/lib/{registry,qd,assert,index}.mjs` | Scenario registry and `meta` validation; `ctx.qd` and `waitForBoot`; assertions; the barrel for scenario authors. |
| `tests/e2e/lib/types.d.ts` | `ScenarioMeta`, `ScenarioContext`, `QdClient`, `ShotOptions` for `// @ts-check` scenarios. |
| `tests/e2e/lib/tsconfig.json`, `vendor.d.ts` | Type-check of the whole harness: `pnpm exec tsc -p tests/e2e/lib/tsconfig.json`. |
| `tests/e2e/lib/registry.test.mjs`, `scripts/qa/lib/harness.test.mjs` | Harness unit tests: `node --test tests/e2e/lib/*.test.mjs scripts/qa/lib/*.test.mjs`. |
| `src/lib/testing/qdtest.ts`, `types.ts`, `qdtest.test.ts` | `window.__QD_TEST__` and its contract, with unit tests (vitest `unit`). |

## Deviations from ARCHITECTURE.md

1. **Scenario context (§12.6) is a superset of the scaffold's `{ page, shot(name), wait(ms), log }`.** It adds `id`, `mode`,
   `meta`, `qd` (the hooks through `page.evaluate`), `boot`, `outDir`, `dataDir`, `relaunch()`, `pending(reason)` and
   `allowConsole(pattern)`. `ctx.page` is a getter because `relaunch()` replaces the page. Screenshot rules:
   - `shot()` writes `<id>.png`. `shot('dock')` writes `<id>-dock.png`, so the files of different scenarios never collide.
   - `shot(name, { selector })` captures one element.
   - Every shot first waits for `__QD_TEST__.waitIdle()` and `document.fonts.ready`. A shot taken while the app was still
     busy becomes a warning.
   - A blank image (every pixel the same colour) fails the scenario. `allowBlank` opts out.
   - A scenario that takes no shot gets `<id>.png` at the end.
   - A failed scenario also gets `<id>-failure.png`.
   - The previous outputs of a scenario (`<id>.png`, `<id>-*.png`, `<id>.json`, `diff/<id>…`) are removed before it runs,
     so a failed run never leaves an older passing image behind.
2. **`meta` beyond `window`, `ui`, `theme`, `mode`.** Added keys: `settings` (any Settings patch), `colorScheme`
   (default `light`), `reducedMotion`, `dpr`, `timeout`, `allowConsole`, `expectFatal`, `env` (app process environment)
   and `description`. Rules:
   - Validation is strict. An unknown key or a bad value fails the scenario with a message, so a typo cannot silently
     change a picture.
   - The default `mode` is `web`.
   - `ui`, `theme` and `settings` are applied with one `setSettings` call before the scenario runs.
3. **A third status, `pending`.** A scenario reports `pending` when it calls `ctx.pending(reason)`, or when the app
   shows its fatal screen with a wave-0 stub message (`not implemented: …`). The run exits 0 with pending scenarios
   (reported loudly), and `--strict` makes them fail. Any other fatal screen fails the scenario unless
   `meta.expectFatal`. Reason: in wave 1 the real app cannot boot (`app_bootstrap` is WP6a's stub), and the harness must
   be usable now without reporting a false pass.
4. **The browser-mock server runs inside the driver process** (Vite `createServer`), not as a spawned `vite --mode mock`.
   Reason: a killed driver can never leave an orphaned `vite` process behind on Windows. Server settings:
   - It binds `127.0.0.1:<port>` with `strictPort`.
   - HMR is off. Other packages edit sources during a run, and a hot update would otherwise change the page in the middle
     of a scenario.
   - Console forwarding is off, because the driver captures the console itself.
   - Pre-bundled dependencies go to `node_modules/.vite-qa/<port>`, so concurrent runs on different ports never
     re-optimise each other's cache.
   - One throw-away page load warms the server before the first scenario.
   - The URL is `http://127.0.0.1:<port>/?qdtest`, and each scenario gets a fresh browser context (en-US, UTC).
   - The browser channel follows the vitest browser project (WP0D): `--channel`, else `QD_BROWSER_CHANNEL`, else
     `msedge` on Windows outside CI, else Playwright's chromium. `bundled` forces Playwright's chromium.
5. **Hook fallback in the browser mock.** When the app does not install `window.__QD_TEST__` itself, the harness imports
   `/src/lib/testing/qdtest.ts` from the dev server and calls `installQdTest()`. The URLs match the app's, so the same
   store instances are used. The result records `boot.hook = 'harness'` and a warning. This only happens on a Vite dev
   server (`/@vite/client` loaded), never in the real app.
6. **App driver (§12.6 steps 1–5).**
   - **Fresh app per scenario.** Each scenario gets a fresh app process and a fresh temporary `QD_DATA_DIR`. With
     `--data-dir`, one shared dir is used instead. `ctx.relaunch()` restarts the app on the same data dir.
   - **Audio.** `QD_AUDIO_SINK=null` is the default (LEAD 9). The environment or `meta.env` can override it.
   - **CDP port.** The port is 9333 when free, else the next free port up to 9399. `--port` asks for an exact port. Busy
     ports used to be a documented failure.
   - **Viewport.** `meta.window` is emulated over CDP (`setViewportSize`, DPR 1), so PNGs have the exact size whatever
     the window. A plain `--shot` keeps the real window unless `--width/--height` are given.
   - **Run lock.** The app is single-instance by bundle identifier, and every debug build shares one WebView2 profile.
     The driver therefore takes a machine-wide lock (`%TEMP%/quran-desktop-qa/app.lock`; a stale lock is taken over).
     It then waits for any other `quran-desktop` process to exit. Concurrent `shots:app` runs of different packages queue
     instead of attaching to each other's webview.
   - **Quitting.** The driver calls `app_quit` through the IPC, then kills the process tree (`taskkill /T`), then waits
     until WebView2 releases the CDP port.
   - **Watchdog.** A detached `watchdog.mjs` kills the app if the driver itself is killed (`taskkill /F`, an
     orchestrator timeout). Verified: the app was gone within 3 s.
7. **Sibling suites.** An id given with `--only` that is not in the registry is looked up in `tests/e2e/<suite>/<id>.mjs`
   (any sibling directory except `lib` and `baselines`). So WP13b's acceptance `pnpm shots:app --only metrics` finds
   `tests/e2e/metrics/metrics.mjs` without editing `package.json`. A run without `--only` uses the registry only.
8. **`window.__QD_TEST__` beyond §12.6.**
   - **New members:** `version`, `closeOverlays()`, `busy()` (what `waitIdle` waits for), `resetMetrics()`, `state()`
     (a JSON snapshot: view, overlays, page, visible pages, style, qfs, dock, locale, resolved theme, settings, player,
     commands in flight) and `ipc(command, ...args)` (any typed command through `call()`).
   - **`openOverlay(kind, props?)`** takes optional props and uses QA defaults: the action target for `note-editor`, the
     current page's ayahs for `self-test`, localised `common.*` strings for `confirm`.
   - **`installQdTest()`** returns whether the hooks are installed. It is idempotent and a no-op without test mode. It
     dispatches `qd:test-ready` on `window`. `uninstallQdTest()` exists for unit tests.
   - **IPC tracking.** The functions of the live `api` object are wrapped in place to count commands in flight.
     Arguments and results pass through unchanged. `fontBytes` is covered by `document.fonts` instead.
   - **`goto`** calls the reader directly: `goToPage(p, { push: true, transition: false })`, `goToAyah(id, { select:
     false, flash: false, focus: false })`, `goToSurah`. A `search` target goes through `ui.navigate`. In Mushaf mode,
     `goto` rejects unless the target page is visible. `waitIdle` also treats `reader.turning`/`flipping` and
     `html[data-turn]` as busy.
   - **Metrics.** Added `glideMaxFrameMs` (§8.18: no frame > 32 ms) and `windowMs`. `glideFps` counts rAF frames while
     `player.isPlaying` in a visible document. `pageRenderMs` collects `performance.measure('qd:page')` entries, which
     WP8a/WP8b must emit.
9. **New file `src/lib/testing/types.ts`.** It holds the hook contract as types, importing only `bindings.ts` and
   `contracts/*`, so the Node-side `types.d.ts` and `tsc -p tests/e2e/lib/tsconfig.json` check scenarios against the
   same shapes. `qdtest.ts` re-exports it.
10. **Report.** Each scenario writes `<out>/<id>.json` (format `qd-qa-result/1`). `index.html` (light and dark, escaped)
    and `metrics.json` (`{ id: metrics }`) are rebuilt from every result file in the directory, with atomic writes. So
    concurrent runs of different packages in `artifacts/shots/web` add to one report. The browser mock writes metrics
    too.
11. **Baselines.** Baselines live in `tests/e2e/baselines/{web,app}/` (gitignored). They are written only by
    `--update-baselines`, and only from passing runs. A difference (pixelmatch threshold 0.1, more than 0.5 % of
    pixels, or a size change) writes `diff/<shot>.png` and is reported. It fails the run only with `--fail-on-diff`.
    §12.6 does not say whether a difference fails; package acceptance is "PNG exists, no errors".
12. **Failure rules.** Page errors, console errors (`error` and `assert`) and browser log errors (network, CSP) fail a
    scenario unless `meta.allowConsole`, `ctx.allowConsole` or `--allow-console <regex>` matches them. Warnings are only
    reported. `--allow-errors` reports errors without failing.
13. **CLI compatibility.** The scaffold options still work: `--name`, `--shot`, `--settle`, `--full`, `--url`,
    `--scenario`, `--width/--height`, `--dpr`, `--dark`, `--reduced-motion`, `--channel`, `--headed`, `--out`,
    `--data-dir`, `--keep-data`, `--exe`, `--verbose` and `--allow-errors`. Changes and additions:
    - `--timeout` is the launch and boot budget. The new `--scenario-timeout` is the scenario budget (default 120 s,
      `meta.timeout` wins).
    - A repeated option keeps its last value, so `pnpm shots:web --serve 1648` overrides the script's `--serve 1520`.
      pnpm's `--` is ignored.
    - New options: `--list`, `--jobs` (browser mock), `--strict`, `--update-baselines`, `--fail-on-diff`,
      `--baselines`, `--allow-console` and `--lock-timeout`.
    - Exit codes: 0 when everything passed (pending allowed unless `--strict`), 1 when a scenario failed, 2 for bad usage
      or a server, browser or app that did not start.
14. **Harness tests run on `node:test`**, because vitest's projects only include `src/**`:
    `node --test tests/e2e/lib/*.test.mjs scripts/qa/lib/*.test.mjs` (36 tests). The hook tests are vitest unit tests in
    `src/lib/testing/qdtest.test.ts` (18 tests, part of `pnpm test`).
15. **Acceptance port.** Following the orchestrator's port assignment, `pnpm shots:web` ran with `--serve 1648` (§14.3
    says 1520).

## Requests

- **WP7c (`App.svelte`):** call `installQdTest()` once after mounting, for example
  `onMount(() => { if (app.testMode) void import('$lib/testing/qdtest').then((m) => m.installQdTest()) })`. The dynamic
  import keeps the hooks out of the main chunk, and the call is a no-op without test mode.
  - Until this lands, the real app never exposes `window.__QD_TEST__`.
  - The browser mock gets the hooks from the harness fallback, and every result carries a warning.
  - Once `app_bootstrap` works (WP6a), smoke fails in the real app with "window.__QD_TEST__ is not installed" until this
    call exists.
- **WP7c (`FatalScreen.svelte`):** put `data-qd-fatal={app.fatalKind ?? 'internal'}` on the root element. The harness
  finds the fatal screen through it. The fallback today is the wave-0 markup (`main.fatal`,
  `[data-placeholder="FatalScreen"]`).
- **WP0D (`docs/DEVELOPING.md` §7 Visual QA and the failures table):** please document:
  - `pnpm shots:web --serve <your port> --only <ids>` (each package uses its own port);
  - the report at `artifacts/shots/<web|app>/index.html` with `<id>.json` and `metrics.json`;
  - `--strict`, `--update-baselines` and `--fail-on-diff`;
  - that the app driver picks a free CDP port (the ":9333 did not come up" row is obsolete), serialises app runs with a
    lock, and defaults to `QD_AUDIO_SINK=null`;
  - `node --test tests/e2e/lib/*.test.mjs scripts/qa/lib/*.test.mjs` and `pnpm exec tsc -p tests/e2e/lib/tsconfig.json`.
- **WP-CI:** run the two harness checks above in the lint/test job, and use `QD_BROWSER_CHANNEL=bundled` (or the CI
  default) after `playwright install chromium` for any `shots:web` step.
- **WP6a (IC1):**
  - **Command:** `pnpm tauri build --debug --no-bundle && node scripts/qa/app-driver.mjs --scenario
    tests/e2e/scenarios/smoke.mjs --exe C:\qdt\WP6a\debug\quran-desktop.exe --strict`. Smoke is `pending` while
    `app_bootstrap` is the wave-0 stub, and `--strict` turns that into a failure.
  - **What smoke asserts:**
    - the app is ready, not on the fatal screen, and in the reader;
    - page 1 is on screen in `hafs`, and `section.mp[data-page="1"]` has `.w` words;
    - `goto(page 262)` renders page 262;
    - the overlay stack opens and closes;
    - `setSettings({ theme: 'sepia' })` sets `html[data-theme="sepia"]` and `settings_get` returns it;
    - after a relaunch on the same data dir (`app_quit`, then a kill), the theme is still `sepia` (user.db).
- **WP5e (IC2):** set `meta.env = { QD_AUDIO_SINK: 'wav:artifacts/ic2.wav' }`. The path is relative to the driver's cwd
  (the repo root under pnpm). Use `ctx.qd.play()`, `seek()` and `pause()` with `PlayRequest` DTOs.
- **WP13b:** put the metrics scenario at `tests/e2e/metrics/metrics.mjs` with `meta.mode: 'app'`. Call
  `ctx.qd.resetMetrics()` before the scripted navigation and `ctx.qd.metrics()` after it. The driver also records the
  final metrics in `artifacts/shots/app/metrics.json`.
- **WP8a/WP8b:** emit `performance.measure('qd:page', …)` per rendered page (§8.1, §8.18). `pageRenderMs` reads it.
- **Every scenario owner:**
  - Put `// @ts-check` at the top, with `/** @type {import('../lib/types').ScenarioMeta} */` on `meta` and
    `/** @param {import('../lib/types').ScenarioContext} ctx */` on the default export.
  - Import helpers from `../lib/index.mjs` (`check`, `equal`, `includes`, `waitUntil`, and the `mushaf` §8.3 selectors).
  - Drive the app through `ctx.qd` rather than clicking, except to test the interaction itself.
  - Run `pnpm shots:web --serve <your port> --only <id>`.
  - Helper modules in `tests/e2e/scenarios/` must start with `_`.
- **Lead:** fold 1–14 into §12.6 and §14.3 (WP13a deliverables), and the `src/lib/testing/types.ts` file into §7.1.
