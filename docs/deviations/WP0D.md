# WP0D deviations (tooling and repository hygiene)

## Deviations from ARCHITECTURE.md

1. **Vitest browser instances (§13.1, §12.5).** The spec says "instances chromium and webkit". On CI (`CI` set) both run
   with Playwright's browsers, as §13.3 installs them. Locally nothing is downloaded: the default is `chromium` only,
   launched through the installed Microsoft Edge (`channel: 'msedge'`) on Windows. Two new tooling variables pick other
   setups: `QD_BROWSERS` (comma list, e.g. `chromium,webkit`) and `QD_BROWSER_CHANNEL` (`msedge`, `chrome`, or `bundled`
   for Playwright's chromium). The browser project also sets a 1280×800 viewport and writes failure screenshots to
   `artifacts/vitest-browser/` (not `__screenshots__/` next to the test, which is gitignored as well).
2. **`devPacks()` loading (§13.1).** `vite.config.ts` cannot import `vite/dev-packs.ts` statically before WP8b creates it,
   so in `--mode mock` it imports the file at runtime through Vite's `runnerImport` (TS and extensionless imports work) only
   when it exists, and logs a `[qd]` warning (instead of failing the dev server) if it does not load. Contract for WP8b:
   export `devPacks(): PluginOption` (named; a default export is also accepted).
3. **No `passWithNoTests`.** The scaffold passed with no tests; now a filtered acceptance command such as
   `vitest run --project unit src/lib/ipc` fails when the package shipped no tests there. Consequence: `pnpm test` reports
   "No test files found" until WP0C lands its first unit test (§5.16 requires `src/lib/ipc/index.test.ts`).
4. **ESLint, beyond the §5.16 rule.** Outside `src/lib/ipc/**` the config also forbids importing the `core` namespace from
   `@tauri-apps/api` (another route to `invoke`), and, outside tests, `…/ipc/mock` and `@tauri-apps/api/mocks` (enforces
   D29). Tests keep the `invoke`/bindings rule. The "single SafeHtml exception" is a local rule,
   `qd/no-html-escape-hatch`: an `eslint-disable` directive naming `svelte/no-at-html-tags` is an error in every file except
   `src/components/ui/SafeHtml.svelte`. Lint globals are now per area (browser for `src/`, node for tooling, both for
   `scripts/qa/` and `tests/`) instead of browser+node everywhere.
5. **Prettier scope.** `.prettierignore` excludes `docs/` (ARCHITECTURE.md and BRIEF.md are not Prettier-clean and no
   package may edit them), `src-tauri/`, `crates/`, `xtask/` (JSON/golden files owned by the Rust packages or rewritten by
   the tauri CLI) and the generated `src/lib/about/thirdparty.json`. Prettier also honours `.gitignore`.
6. **`check-tooling.mjs` (§13.1).** The command list is parsed from ARCHITECTURE.md itself (every §14.3 "Acceptance" line,
   §14.4 and the §13.3 job table, 194 commands today) rather than hard-coded, so it follows the lead's revisions. Scripts are
   read from `package.json` (the same list `pnpm run` prints, without a subprocess). Beyond "resolves", it checks `-p <crate>`
   against `cargo metadata`, `vitest --project <name>` against the config, the files that `node …` and pnpm scripts run,
   node/pnpm/cargo versions, cargo on PATH, and `.gitattributes`. A missing file or crate owned by a **later-wave** package
   is reported as `pending` (owner and wave from §14.3), not a failure, so the wave-0 gate is meaningful; `--strict` turns
   pending into failures and `--xtask` also checks every `cargo xtask <cmd>` against `cargo xtask --help`. `rg` (named in
   §14.4) is a warning only.
7. **`check-dist.mjs` (§5.16, §6.4).** Besides the path regex, the 6 MB budget (read as 6 MiB) and the `<style>` check
   (HTML comments ignored), it fails on mock-only strings in bundle files (`qd-mock-v1:`, `mock://`, `/__packs/`,
   `src/lib/ipc/mock/`, an unreplaced `__MOCK_IPC__`), on mock/fixture/synthetic modules listed in source maps (debug
   builds), and on any SQLite file.
8. **`scripts/qa/**` adoption.** Beyond the env renames (`QD_TEST`, `QD_DATA_DIR`) and `artifacts/shots/{web,app}`:
   options are parsed strictly (unknown flags are errors); `--registry`/`--only` exit 2 with a message until WP13a
   implements the registry, so `pnpm shots:web|app` fail loudly instead of silently taking one screenshot; the app-driver
   finds the exe under `$CARGO_TARGET_DIR` (else `target/`), runs with a fresh temporary `QD_DATA_DIR` unless `--data-dir`
   is given (`--keep-data` keeps it), selects the page by origin (`http://tauri.localhost` / `http://localhost:1420`, §12.6
   step 3), waits for the app to exit, and fails on a page error (`--allow-errors` opts out) or a `panicked` line in the
   app output (WP0B's acceptance condition). Paths default to the repo root, not the current directory.
9. **`index.html`** gains `<link rel="icon" href="data:,">`: without it the browser mock requests `/favicon.ico`, and the
   404 is a console error that the QA scripts count (WP-Brand may replace it with the app icon).
10. **`svelte.config.js`** forces runes mode for project components (`compilerOptions.runes` as a function; node_modules
    keep inferring), matching §7.2.
11. **`package.json`**: `svelte` moved from devDependencies to dependencies (§13.1 lists it as runtime). Scripts and
    versions otherwise exactly §13.1; the scaffold's `data`/`data:verify` became `core:qdc`/`core:verify`.
12. **tsconfig**: `tsconfig.app.json` adds `resolveJsonModule` (for `thirdparty.json`) and the `@vitest/browser-playwright`
    types (provider-specific `vitest/browser` options in browser tests); `tsconfig.node.json` adds `strict` and includes
    `vite/**/*.ts` (WP8b's plugin is type-checked by `pnpm check`). `vite.config.ts` exports `alias`, which
    `vitest.config.ts` reuses.
13. **`.gitignore`**: anchored `/node_modules/`, `/dist/`, `/target/`; adds `__screenshots__/`, `*.tsbuildinfo`,
    `.eslintcache`, Vite config timestamp files; keeps the scaffold's `data/sources/tanzil/*`, `fixtures-out/`,
    `screenshots/`. `.gitattributes` also marks binary assets and sets CRLF for `*.cmd`/`*.bat`, and marks generated files
    `linguist-generated`.
14. **CI skeleton**: `lint`, `test-rust` (3 OSes) and `test-web` only; `test-core` and `build` are left to WP-CI with the
    licensing guards. The `pnpm lint:css` step is guarded by `hashFiles('scripts/check-logical-css.mjs')` until WP7a lands.
    Actions use major tags (`actions/checkout@v4`, `actions/setup-node@v4`, `pnpm/action-setup@v4`,
    `Swatinem/rust-cache@v2`); WP-CI pins SHAs. The toolchain comes from `rust-toolchain.toml` via `rustup toolchain install`.

## Requests

- **WP7a:** `pnpm lint:css` runs `node scripts/check-logical-css.mjs` (exit code non-zero on violations). Until that file
  exists, `pnpm lint:css` fails for every package (§14.4) and `check:tooling` lists it as pending.
- **WP8b:** `vite/dev-packs.ts` must export `devPacks(): PluginOption`; it is loaded only in `--mode mock` (deviation 2).
  `QD_PACKS_DIR` (default `data/dev-packs`) is read by the plugin.
- **WP13a (owner of `scripts/qa/**` from now on):** implement `--registry <dir>` + `--only a,b` in both scripts (the
  `shots:*` scripts already pass `--registry tests/e2e/scenarios`; the `meta.window` viewport), and console-error failure in
  web-shot (today only page errors fail; console errors and warnings are printed).
- **WP-CI:** take over `.github/**`; add `test-core`/`build`, `scripts/check-artifacts.mjs`, SHA pins, and the
  `cargo xtask licenses` drift check. `pnpm check:tooling` in the `lint` job needs cargo on PATH (the setup action does it).
- **Lead:** §14.4 names `rg`, which is not guaranteed to be installed (check-tooling warns). `pnpm test` fails with "No
  test files found" until WP0C's first test (deviation 3).
