# Developing Quran for Desktop

The runbook for working on this repository: setup, everyday commands, environment variables, data, tests, visual QA,
preview builds, releases and the failures people actually hit. The design lives in [`ARCHITECTURE.md`](ARCHITECTURE.md)
(v1.2) read together with [`IMPLEMENTATION_NOTES.md`](IMPLEMENTATION_NOTES.md), which records what the build changed; the
product decisions are in [`BRIEF.md`](BRIEF.md).

The app is **Quran** (full name **Quran for Desktop**, identifier `com.quran.labs.desktop`, licence GPL-3.0-or-later, see
[`LICENSE`](../LICENSE) and [LEAD.md item 16](deviations/LEAD.md)); the repository, crates and binary keep the working
name `quran-desktop`.

## 1. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22 LTS (≥ 22.12) | `engines.node` in `package.json`. Newer majors work too. |
| pnpm | 10.24.0 | Pinned by `packageManager`. `corepack enable` gives you exactly this version. |
| Rust | 1.99.0 | Pinned by `rust-toolchain.toml` (with rustfmt and clippy); rustup installs it on first use. |
| git | any recent | `pnpm check:tooling` reads `.gitattributes` through it. `pnpm bindings:check` does not need it (LEAD 1). |

Platform prerequisites (the Tauri v2 set):

- **Windows 10/11:** Microsoft C++ Build Tools ("Desktop development with C++") and WebView2 (preinstalled on
  Windows 11). Microsoft Edge is used by the QA scripts and the vitest browser project, so no browser is ever downloaded.
  7-Zip (or `xz`, which Git Bash has) is needed only to measure or unpack NSIS installers (§10).
- **macOS 13.3+:** Xcode Command Line Tools.
- **Ubuntu 22.04+:** the same packages CI installs:

  ```sh
  sudo apt-get install -y build-essential pkg-config curl wget file patchelf libwebkit2gtk-4.1-dev \
    libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev libasound2-dev
  ```

### Windows: two rules that save an afternoon

1. **cargo on PATH.** rustup installs into `%USERPROFILE%\.cargo\bin`, which is on the PowerShell/cmd PATH but **not on
   the Git Bash PATH** (FACT_SHEET C9). Every pnpm script that calls cargo (`bindings`, `core:*`, `fixtures`, `assets`,
   `dev-packs`) fails with "cargo: command not found" until it is:

   ```sh
   # Git Bash (add to ~/.bashrc)
   export PATH="$USERPROFILE/.cargo/bin:$PATH"
   ```

   ```powershell
   # PowerShell, current session
   $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
   ```

   `pnpm check:tooling` reports this as a failure.

2. **Short paths (MAX_PATH).** SQLite's Windows VFS, `link.exe` and other native tools fail on paths near 260 characters
   (FACT_SHEET §9). Clone into a short directory and keep cargo's output short too:

   ```powershell
   $env:CARGO_TARGET_DIR = "C:\qdt\t"    # the tauri CLI honours it; the debug exe is then C:\qdt\t\debug\quran-desktop.exe
   ```

   Parallel worktrees (or agents) each use their own `CARGO_TARGET_DIR`: a separate lock, no rebuild ping-pong (LEAD 10).
   The app itself rewrites a deep data directory to its `\\?\` form, so a long `QD_DATA_DIR` is fine (WP6a).

## 2. First run

```sh
pnpm i --frozen-lockfile      # node modules (the lockfile is authoritative; see §6)
pnpm check:tooling            # every command named in the spec resolves (node, pnpm, cargo, git, scripts, crates)
pnpm assets                   # cargo xtask fetch-assets: KFGQPC Hafs V30 TTF → public/fonts/ (gitignored, D23; offline fallback LEAD 24)
pnpm dev:web                  # the UI in a browser against the IPC mock: http://localhost:1420
```

Plain `cargo build`/`cargo test` of `src-tauri` need neither `dist/` nor `core.db`: `generate_context!` embeds
`../dist` only in `custom-protocol` builds (`pnpm tauri build`, which runs `pnpm build` first), and `build.rs` writes
placeholders for the missing resources (below). The real app, from a fresh clone:

```sh
pnpm tauri build --debug --no-bundle    # builds dist/ and the debug exe
node scripts/qa/app-driver.mjs --shot startup
```

The browser mock works without any QF data: it falls back to the synthetic generator (a real surah, juz and page index
from Tanzil's metadata, placeholder words). For real pages, build the data below.

### Core data (core.db), fixtures and dev packs

`core.db` is generated and **never committed** (BRIEF §4):

```sh
pnpm core:qdc        # cargo xtask build-core --source qdc → src-tauri/resources/core.db (dev only; caches data/cache/)
pnpm core:verify     # cargo xtask verify-core: the 18 gates G1–G16, G5b, G11b (build-core also runs them)
pnpm fixtures        # cargo xtask export-fixtures → src/lib/ipc/mock/fixtures/ (gitignored) for the browser mock
pnpm dev-packs       # cargo xtask fetch-dev-packs → data/dev-packs/ (QCF fonts for the mock; served at /__packs/*)
```

- `--source qdc` reads Quran.Foundation APIs (1,812 page requests on a cold cache, about 90 s; a warm build takes a few
  seconds). Everything it produces (core.db, fixtures, `data/cache/`, `data/dev-packs/`) is QF-derived: keep it on your
  machine. Never commit, upload, attach or share it. Release builds use `--source qul` (`pnpm core:qul`, inputs placed by
  a person, see [`data/sources/README.md`](../data/sources/README.md)).
- Cached QDC responses older than 7 days are refetched (QF terms); `--offline` never touches the network and fails on a
  stale file instead. Two builds with the same `SOURCE_DATE_EPOCH` are byte-identical.
- While the repository is private, CI may publish `core.db` and `fixtures/` as 1-day artifacts (§13.3; the artifact
  names are defined in `.github/workflows/ci.yml`): `gh run download <run-id> -n <artifact> -D <dir>` into
  `src-tauri/resources/` and `src/lib/ipc/mock/fixtures/`.
- Without a core.db, `build.rs` writes a **0-byte placeholder** so the app still compiles. A debug build then shows
  "Core data missing (dev build)"; a release build refuses to start. `QD_REQUIRE_CORE=1` makes the build fail instead.
- `pnpm test:browser` and `pnpm shots:web` render fixture pages: run `pnpm fixtures` (after `pnpm core:qdc`) first.
  The QCF scenarios also want `pnpm dev-packs`.

## 3. Everyday commands

| Command | What it does |
|---|---|
| `pnpm dev:web` | Vite in `--mode mock`: the UI in a normal browser, IPC served by the mock (`__MOCK_IPC__ = true`, D29). |
| `pnpm app:dev` | The real app (`tauri dev`; starts `pnpm dev` on :1420). |
| `pnpm tauri build --debug --no-bundle` | Debug exe with the frontend embedded (what the QA driver runs). |
| `pnpm build` · `pnpm preview` | Production frontend build into `dist/` · serve it. A preview in a browser shows "Run Quran in Tauri". |
| `pnpm check` | `svelte-check` (app) + `tsc` (configs). |
| `pnpm lint` · `pnpm lint:css` | ESLint · logical-CSS and Quran-text lint (`scripts/check-logical-css.mjs`). |
| `pnpm format` · `pnpm format:check` | Prettier write · check. |
| `pnpm test` | Unit tests: vitest project `unit` (jsdom), files `src/**/*.test.ts` and `vite/*.test.ts`. |
| `pnpm test:browser` | Component tests: vitest project `browser`, files `src/**/*.browser.test.ts`. |
| `pnpm exec vitest run --project unit src/lib/ipc` | One project, filtered by path (the form used by acceptance lines). |
| `pnpm bindings` · `pnpm bindings:check` | Regenerate `src/lib/ipc/bindings.ts` · fail if it drifted from the Rust DTOs (git-free, LEAD 1). |
| `pnpm check:dist` | After `pnpm build`: no mock/fixtures/synthetic code in `dist/`, no `<style>` in `index.html`, no WOFF 1 font, no SQLite file, ≤ 6 MiB. |
| `pnpm check:tooling` | Every command named in the spec's acceptance lines resolves (`--strict`, `--xtask`, `--verbose`). |
| `pnpm check:artifacts <paths…>` · `pnpm check:ci` | The CI upload guard on any paths · the CI policy check (pinned actions, guarded uploads, caches, permissions). |
| `pnpm brand` · `pnpm brand:check` | Regenerate the icon set from `assets/brand/` · check that it regenerates without a diff. |
| `pnpm shots:web` · `pnpm shots:app` | Screenshot scenarios in the browser mock · in the real app (§7). |
| `pnpm shots:app --only metrics` | The §8.18 frame budgets, CLS, CSP and the §13.6 runtime rows in the real app (§10). |
| `node scripts/size-budget.mjs` | The §13.6 size and runtime budgets of whatever is built (§10). |
| `node scripts/check-bundles.mjs --core placeholder\|qul` | Unpacks the installers and checks what they contain (§10). |

### Cargo and xtask

Cargo aliases (`.cargo/config.toml`): `cargo xtask …`, `cargo lint` (workspace clippy, `-D warnings`), `cargo bindings`.
The workspace's default member is `src-tauri`, so always pass `-p <crate>` or `--workspace`. `cargo test` takes **one**
test-name filter; give several to libtest after `--`: `cargo test -p quran-core --lib -- content_db pack_db timings`.

| `cargo xtask …` | What it does |
|---|---|
| `build-core --source qdc\|qul [--out …] [--cache data/cache] [--offline] [--jobs 4]` | Build core.db, run every gate, rename on success. |
| `verify-core [--db …] [--report target/verify-core.json]` | The 18 gates on a built core.db; the report is JSON. |
| `export-fixtures [--only mushaf,search,content,packs] [--db …] [--content-db …] [--packs …]` | Browser-mock fixtures. |
| `fetch-assets [--force]` | The KFGQPC Hafs TTF, checked against `xtask/assets.lock` (downloaded; when that fails, the committed `xtask/assets/` copy); regenerates its licence text. |
| `fetch-dev-packs [--out data/dev-packs] [--force] [--all-pages]` | QCF fonts of the fixture pages (or all 604) and the decor fonts. |
| `licenses` | Regenerate `src/lib/about/thirdparty.json`; fails unless every shipped package carries its licence text (below). |
| `catalog-check [--online]` | Validate `src-tauri/resources/catalog.json` (with `--online`, HEAD every URL). |
| `bindings` | Same as `pnpm bindings`. |

**Licence texts.** `cargo xtask licenses` fails, writing nothing, unless every shipped package's texts contain the text of
each licence it is credited under. A package that ships none gets a reviewed stand-in under
`xtask/licenses/<cargo|npm>/<name>/` (its `source.toml` lists the reviewed versions; `xtask/licenses/README.md` has the
process), so a dependency bump that changes a package's files makes the command ask for a fresh review.

## 4. Environment variables

App variables exist in **debug builds only** (D24); release builds compile them out.

| Variable | Used by | Meaning |
|---|---|---|
| `QD_TEST=1` | app (debug) | Test mode: sets `AppInfo.testMode` and installs `window.__QD_TEST__` (the QA hooks). |
| `QD_DATA_DIR=<dir>` | app (debug) | Replaces the data root (`app_local_data_dir()`, below): user.db, content.db, backups, packs, and also the logs (`<dir>/logs`), the window state (`<dir>/window-state.json`) and the WebView2/WebKitGTK profile with its `localStorage` (`<dir>/webview`), so a QA run never touches the user's. |
| `QD_CORE_DB=<file>` | app (debug), `cargo test -- --ignored` | core.db path. Default `src-tauri/resources/core.db`. |
| `QD_FONT_TRANSPORT=url\|bytes` | app (debug) | Override how QCF fonts reach the webview (default `url`; `bytes` sends them through `font_bytes`). |
| `QD_AUDIO_SINK=null` / `wav:<path>` | app (debug), audio tests | Replace the audio device with a timer-driven null sink, or also write a WAV + marker/tick log. An unknown value means `null`, never the speakers (LEAD 9). |
| `QD_PACKS_DIR=<dir>` | vite dev-packs plugin | Directory served at `/__packs/*` in `--mode mock`. Default `data/dev-packs`. |
| `QD_REQUIRE_CORE=1` | `src-tauri/build.rs` | Fail the build when `resources/core.db` is missing (CI and release) instead of writing a placeholder. |
| `QD_ALLOW_DEV_CORE=1` | `src-tauri/scripts/check-release-core.mjs` | Every bundle runs this guard (`build.beforeBundleCommand`): it refuses a qdc core.db (QF-derived, never distributed). This lets one through for a private preview (§9), with a loud warning; never publish such a bundle. A 0-byte placeholder passes with a warning (CI's size check). |
| `SOURCE_DATE_EPOCH` | `cargo xtask build-core` | `meta.built_at`; the same inputs and epoch give a byte-identical core.db. |
| `QD_NET_TESTS=1` | `cargo test -p quran-packs --test live -- --ignored` (also `quranenc_real`) | Opt in to the live network tests. |
| `QD_QDC_TIMINGS_DIR=<dir>` | `cargo test -p quran-core --test timings_qdc -- --ignored` | Saved QDC `audio_files` responses to sanitise (skipped without it). |
| `QD_QURANENC_DIR=<dir>` · `QD_QURANENC_OUT=<dir>` | `cargo test -p quran-packs --test quranenc_real -- --ignored` | Real QuranEnc zips to build · keep the built pack DBs there. |
| `QD_DSP_LISTEN="a.mp3;b.mp3"` · `QD_DSP_LISTEN_OUT` | `cargo test -p quran-audio --release --test dsp_listen -- --ignored` | Render files at 5 speeds into `artifacts/dsp-listen/` for a person to audition (R4). |
| `QD_DECODE_STRESS_SEEDS=<n>` · `QD_ENGINE_STRESS_SEEDS=<n>` | `quran-audio` stress tests | Run more random seeds. |
| `QD_UPDATE_SNAPSHOTS=1` | `cargo test -p quran-types` | Accept a change of `tests/data/settings_default.json` (a contract change, §6). |
| `QD_KEEP_IC2_WAV=1` | `tests/e2e/scenarios/ic2.mjs` | Keep the 18 MB WAV the IC2 scenario records. |
| `QD_QA_DEBUG=1` | `scripts/qa/*` | Print the stack of a harness error. |
| `QD_BROWSERS=chromium,webkit` | vitest browser project | Browser instances. Default: `chromium,webkit` on CI, `chromium` locally. |
| `QD_BROWSER_CHANNEL=msedge` | vitest browser project, QA scripts, brand pipeline | Chromium channel. Default: `msedge` on Windows, Playwright's chromium elsewhere and on CI; `bundled` forces Playwright's. |
| `CARGO_TARGET_DIR` | cargo, tauri CLI, `app-driver.mjs` | Short target dir on Windows (§1). The QA driver looks for the exe there. |
| `TAURI_DEV_HOST` | vite | Dev-server host for mobile/remote devices (HMR on :1421). |

### Where the app keeps its data

The data root is `app_local_data_dir()`, named after the bundle identifier (ARCHITECTURE §2.8.3):

| OS | Data root | Logs | Window state |
|---|---|---|---|
| Windows | `%LOCALAPPDATA%\com.quran.labs.desktop` | `%LOCALAPPDATA%\com.quran.labs.desktop\logs` | `%APPDATA%\com.quran.labs.desktop\.window-state.json` |
| macOS | `~/Library/Application Support/com.quran.labs.desktop` | `~/Library/Logs/com.quran.labs.desktop` | `~/Library/Application Support/com.quran.labs.desktop/.window-state.json` |
| Linux | `~/.local/share/com.quran.labs.desktop` | `~/.local/share/com.quran.labs.desktop/logs` | `~/.config/com.quran.labs.desktop/.window-state.json` |

```
<data root>/
├─ user.db (+ -wal, -shm)     # the library, settings, history, memorisation; user.db.corrupt-<ms> after a recovery
├─ content.db (+ -wal, -shm)  # QF-derived content: timings, word by word, on-demand tafsir chapters, pack update findings
├─ backups/                   # user-YYYYMMDD-HHMMSSZ.qdb; a restore keeps the replaced library here too
├─ media-artwork.png          # the artwork the OS media session shows
├─ EBWebView/                 # (Windows) the WebView2 profile, localStorage included
└─ packs/                     # the quran:// root: mushaf/, decor/, translation/, tafsir/, audio/, .staging/
```

The log file is `quran-desktop.log` (2 MiB, 3 kept). A newer library than the app can read is never touched: the app
refuses to start with a "newer version" message, and updating the app opens it again.

Before the identity change (LEAD.md item 16) the root was `…/com.qurandesktop.app`. No release shipped, so nothing migrates
it: copy `user.db` (and `packs/`, to keep downloads) into the new root once, or delete the old directory. The QA driver
always uses a fresh temporary `QD_DATA_DIR`, so it never touches either.

## 5. Tests

- **Unit** (`*.test.ts`, jsdom): pure logic, stores, i18n, the IPC wrapper. `@testing-library/svelte` is available for
  small component checks; Svelte resolves to its browser build and components are cleaned up after each test.
- **Browser** (`*.browser.test.ts`): components in a real engine through `vitest-browser-svelte`'s `render()` and
  `page` from `vitest/browser`. Locally on Windows it launches the installed Edge (no download). On macOS/Linux, or to
  run WebKit locally, install Playwright's browsers once (this downloads them):
  `pnpm exec playwright install chromium webkit`, then `QD_BROWSERS=chromium,webkit pnpm test:browser`.
  Failure screenshots go to `artifacts/vitest-browser/`; the viewport defaults to 1280×800. Test files run in parallel
  and share the real mouse: a test about hover parks the pointer first.
- Both projects compile with `__MOCK_IPC__ = true`, and the aliases `$lib`, `$components`, `$styles` work everywhere.
- A filtered run with no matching test files fails ("No test files found") on purpose: an acceptance line that names a
  path must find tests there.
- **Fixtures.** `pnpm test` must pass on a fresh clone without the exported fixtures, because CI's test-web runs it
  that way. The mock then serves the synthetic Tanzil index, whose names differ from a real core.db's ("Al-Baqara", not
  "Al-Baqarah"). Read such data from the loaded index (`quran.surah(2)?.nameSimple`) instead of hard-coding it, or
  skip with `it.skipIf(!fixtures.available)`. A local run with fixtures cannot show this mistake, so check a fresh copy
  of the tracked files. `pnpm test:browser` and `pnpm shots:web` render fixture pages and need `pnpm fixtures` first,
  as in CI's test-core.
- **Rust:** `cargo test -p <crate>` (or `--workspace`); real-DB tests:
  `QD_CORE_DB=src-tauri/resources/core.db cargo test -p quran-core -- --ignored` (an absolute path is safest: test
  binaries run in their crate's directory). Tests that need real data print `SKIPPED` and pass without it. Engine tests
  run on the null sink and only in debug builds; nothing reaches the speakers (LEAD 9).
- **Tooling tests** (CI's `lint` job runs them):

  ```sh
  node --test scripts/*.test.mjs .github/actions/*/*.test.mjs src-tauri/scripts/*.test.mjs \
    tests/e2e/lib/*.test.mjs tests/e2e/metrics/*.test.mjs scripts/qa/lib/*.test.mjs
  pnpm exec tsc -p .github/actions/tsconfig.json
  pnpm exec tsc -p tests/e2e/lib/tsconfig.json   # type-checks every scenario and the metrics suite
  pnpm check:ci
  ```

  The NSIS LZMA estimate test is skipped without 7-Zip or `xz` on PATH.

## 6. Repository rules

- **The spec.** ARCHITECTURE.md v1.2 plus IMPLEMENTATION_NOTES.md is authoritative; where they disagree, the notes win.
  The lead edits both; a contributor records a deviation in `docs/deviations/` and the lead folds it in.
- **Contract changes** (quran-types DTOs, command signatures, events, the frozen frontend contract files) are additive,
  regenerate `bindings.ts` (`pnpm bindings`), add the browser-mock handler, and append an entry to
  [`contract-changes.md`](contract-changes.md).
- **Dependencies are frozen.** `package.json` and the `[workspace.dependencies]` table change only with the lead's
  agreement, pinned exactly and recorded in `docs/deviations/LEAD.md`.
- **Lockfiles are generated.** On a conflict take main's `pnpm-lock.yaml`/`Cargo.lock` and run
  `pnpm install --lockfile-only` / `cargo metadata`; never hand-merge.
- **Generated files** are never edited by hand: `src/lib/ipc/bindings.ts` (`pnpm bindings`) and
  `src/lib/about/thirdparty.json` (`cargo xtask licenses`). Both are excluded from Prettier and ESLint.
- **Never committed:** `core.db*`, `src/lib/ipc/mock/fixtures/`, `data/cache/`, `data/dev-packs/`, QUL inputs,
  `public/fonts/*.ttf`, `artifacts/`, `tests/e2e/baselines/`, any Mushaf screenshot. `.gitignore` covers all of them.
- **Line endings:** `.gitattributes` stores and checks out text as LF on every OS (`* text=auto eol=lf`), whatever
  `core.autocrlf` says. If a file was committed with CRLF: `git add --renormalize .`.
- **IPC boundary (ESLint):** outside `src/lib/ipc/**`, code imports `api`, `events`, `call`, `fontBytes` from `$lib/ipc`.
  Value imports from `bindings.ts`, `invoke` from `@tauri-apps/api/core`, and (outside tests) the mock or
  `@tauri-apps/api/mocks` are lint errors.
- **Raw HTML:** only `src/components/ui/SafeHtml.svelte` may disable `svelte/no-at-html-tags` (rule
  `qd/no-html-escape-hatch`). Everywhere else, render through `<SafeHtml>`.
- **Svelte:** project components compile in runes mode (`svelte.config.js`).
- **CSS:** logical properties only (a physical one needs a `/* physical-ok */` comment); no `:dir()` selectors (the
  production build rewrites them); `.quran-text` and Arabic text never get weight, style or letter-spacing changes. One-line
  ellipsis clips the inline axis only (`overflow-x: clip`), so Arabic dots survive (`src/styles/text-guards.test.ts`).
- **Never play audio** through the speakers in tests, examples or checks: `QD_AUDIO_SINK=null` or `wav:<path>` (LEAD 9).
- **Definition of done** (§14.4): your acceptance commands, plus `pnpm check`, `pnpm lint`, `pnpm format:check`,
  `pnpm lint:css` (frontend) or `cargo clippy -p <crate> --all-targets -- -D warnings` (Rust).

## 7. Visual QA

Two drivers run the same scenario modules (`tests/e2e/scenarios/S01–S38`, `smoke`, `ic2`; each declares `meta.mode`:
`web`, `app` or `both`). PNGs, a JSON result per scenario and an `index.html` report go to `artifacts/shots/{web,app}/`.

```sh
pnpm shots:web --serve 1520 --only S03,S21,S26   # browser mock: Vite in the driver process on 127.0.0.1:1520
pnpm shots:web --list                            # every web scenario with its description
pnpm tauri build --debug --no-bundle
pnpm shots:app --only smoke,S26                  # the real app (Windows, WebView2 over CDP)
```

- **Browser mock** (`scripts/qa/web-shot.mjs`): opens the installed Edge (`--channel chrome` for Chrome, `bundled` for
  Playwright's chromium). `--serve <port>` starts its own Vite server; the last `--serve` wins, so
  `pnpm shots:web --serve 1648` overrides the script's 1520. `--url` uses a running `pnpm dev:web` instead. `--jobs <n>`
  runs scenarios in parallel; `--name <shot>` without a scenario takes one screenshot.
- **Real app** (`scripts/qa/app-driver.mjs`): each scenario gets a fresh app process with `QD_TEST=1`, a fresh temporary
  `QD_DATA_DIR` (`--data-dir` shares one, `--keep-data` keeps them) and `QD_AUDIO_SINK=null`, attaches over CDP on 9333
  or the next free port (`--port` asks for one), replays the console from the start of the boot, and fails on a page or
  console error, a blank screenshot, or a `panicked` line in the app log. `--exe` names the binary (default
  `$CARGO_TARGET_DIR/debug/quran-desktop.exe`). `--shot <name>` without a scenario takes one screenshot of the window.
- **Checks:** `--strict` fails pending scenarios; `--update-baselines` stores passing shots in `tests/e2e/baselines/`
  (gitignored); `--fail-on-diff` fails on a difference (pixelmatch 0.1, more than 0.5 % of pixels);
  `--allow-console <regex>` accepts a known console error. Exit codes: 0 passed, 1 a scenario failed, 2 bad usage or
  nothing started.
- **One target dir, two kinds of exe.** `cargo build -p quran-desktop` (or `--workspace`) writes a
  `debug/quran-desktop.exe` that loads devUrl (`http://localhost:1420`); only `pnpm tauri build` embeds `dist/`. After a
  plain cargo build, rebuild with `pnpm tauri build --debug --no-bundle` before running the driver (it reports
  `chrome-error://` pages with this hint).
- **One app at a time.** The app is single-instance by bundle identifier: a second launch of any build with
  `com.quran.labs.desktop`, whatever the exe's name or data dir, focuses the first window and exits. The driver therefore
  takes a machine-wide lock (`%TEMP%/quran-desktop-qa/app.lock`) and waits for every running process with the exe's image
  name; an ad-hoc script that launches the app must take the same lock (`acquireAppLock` in `scripts/qa/lib/app.mjs`).
  An installed build with another identifier (a side-by-side preview, §9) does not conflict but has the same image name
  `quran-desktop.exe`: run a renamed copy of the debug exe (`--exe …\quran-desktop-qa.exe`) instead of closing it.
- **Writing a scenario:** `export const meta = { … }` and `export default async (ctx) => …`; `ctx` has `page`,
  `shot(name, { selector })`, `qd` (the `window.__QD_TEST__` hooks: `goto`, `openOverlay`, `setSettings`, `waitIdle`,
  `state()`, `ipc()`, `metrics()`), `relaunch()` (`{ close: true }` quits as a user does, through the window's close and
  the page's own `app_quit`) and `pending(reason)`. Types are in
  `tests/e2e/lib/types.d.ts`; `pnpm exec tsc -p tests/e2e/lib/tsconfig.json` checks every scenario. The registry skips
  files that start with `_` (shared helpers).
- Mushaf screenshots and baselines stay local (`artifacts/`, `tests/e2e/baselines/` are gitignored).

## 8. Screenshots of the app

The repository holds no screenshots: Mushaf images are never committed (§12.6), and pages drawn from a development
(qdc) core.db show QF-derived data. To see the app, generate the pictures on your machine with the scenarios and keep
them there: `pnpm core:qdc && pnpm fixtures && pnpm dev-packs`, then
`pnpm shots:web --only S03,S04,S09,S21,S26` (or `pnpm shots:app` in the real app). `pnpm shots:web --list` lists which
scenario shows what.

## 9. Preview builds (private)

A preview is an installer you build for yourself or a few testers before a release exists. With the development core.db
it contains QF-derived data, so it is **never published, uploaded, attached to an issue or shared publicly** (QF terms;
LEAD 16 also requires the quran organisation's approval before any public release under this identity).

```powershell
pnpm core:qdc                                   # or place a qul core.db once the permission exists
$env:QD_ALLOW_DEV_CORE = "1"                    # lets the bundle guard accept the qdc core.db, with a warning
pnpm tauri build --bundles nsis                 # → $CARGO_TARGET_DIR\release\bundle\nsis\Quran_<version>_x64-setup.exe
Remove-Item Env:QD_ALLOW_DEV_CORE
```

- The installer is unsigned: SmartScreen asks "More info › Run anyway". It installs per user and carries WebView2's
  bootstrapper. macOS and Linux previews build the same way (`--bundles dmg`, `deb`, `appimage`) on those systems.
- **Side by side with another build:** a `--config` file can give the preview its own product name and identifier
  (`{ "productName": "Quran Preview", "identifier": "com.quran.labs.desktop.preview" }`; keep the file outside the
  repository or under `artifacts/`). It then has its own data directory and its own single-instance lock. The Windows
  AUMID (`APP_ID` in `src-tauri/src/lib.rs`) stays the release one, so the media flyout and the taskbar may attribute the
  preview to "Quran". `scripts/check-bundles.mjs` is for release installers and refuses another identifier by design.
- A preview never goes through `release.yml`; release builds use the qul core.db (§10).

## 10. Releases, budgets and metrics

The release pipeline is `.github/workflows/release.yml` (§13.4): a `v*` tag builds, for x64 and arm64, the NSIS
installers and portable zips (Windows), one universal dmg and `.app` zip (macOS), and the debs and AppImages (Linux)
from a core.db built from the QUL exports, signs what is configured, checks them and uploads them to a draft release
with `SHA256SUMS`. A person publishes the draft after [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md); publishing starts
`.github/workflows/store.yml`, which submits the release's files to the stores switched on (Microsoft Store, Snap
Store, App Store Connect). Decisions on budgets, signing and stores: [`deviations/WP13b.md`](deviations/WP13b.md).

- **Portable builds** (`node scripts/make-portable.mjs --arch x64|arm64 [--target <triple>] [--universal]`): after a
  release build, writes `bundle/portable/Quran_<version>_<arch>_portable.zip` (Windows) or
  `Quran_<version>_<universal | aarch64 | x64>.app.zip` (macOS) next to the installers; `check-bundles.mjs` checks it as
  the `portable` kind.

- **Size budgets** (`node scripts/size-budget.mjs`): every §13.6 row it can measure, MB read as MiB. It finds the newest
  installer of each kind under `$CARGO_TARGET_DIR/**/release/bundle`, the install footprint, `dist/` and the runtime
  report of the metrics scenario. `--require nsis,installed` makes rows mandatory; `--report-only` never fails. A
  `dist/` with source maps is a debug build's (`pnpm tauri build --debug`) and is left unmeasured, with a note:
  `pnpm build` makes the production bundle the row budgets.
- **Installer contents** (`node scripts/check-bundles.mjs`): unpacks each installer (7-Zip for NSIS, `hdiutil` on
  macOS, Node for a deb, `--appimage-extract` on Linux) and checks identity, resources, the core.db
  (`--core placeholder` in CI, `qul` for a release), deb `Depends`, the desktop entry, icons and the macOS signature.
  7-Zip also rebuilds the NSIS uninstaller (`uninstall.exe`, an NSIS executable itself); it is unpacked in turn and
  may carry only NSIS plugins (`$PLUGINSDIR`).
  `--arch x64|arm64` (default: this machine's) checks every binary's architecture, `portable` zips are a kind of their
  own, `--signed` requires the Authenticode or Developer ID signature, and `--webview offlineInstaller` checks the
  Microsoft Store installer.
- **Measuring an installer locally** never bundles a qdc core.db. Build around the placeholder, as CI does:

  ```sh
  node .github/actions/size-check/size-check.mjs aside      # prints where the real core.db went
  export RUSTFLAGS="$(node .github/actions/size-check/size-check.mjs rustflags)"  # the release builds' flags
  pnpm tauri build --bundles nsis                           # build.rs writes the 0-byte placeholder
  node scripts/check-bundles.mjs --core placeholder
  node scripts/size-budget.mjs --placeholder-core <the printed path>
  node .github/actions/size-check/size-check.mjs restore
  ```

  The LZMA estimate for NSIS needs 7-Zip or `xz` (Git Bash has `xz`).
- **Metrics** (`pnpm shots:app --only metrics`, Windows): one app process runs the §12.6 metric assertions (CLS over
  20 pages with cold QCF fonts and a playback start, long tasks, `qd:page` p95, page turn and flip timing, the word
  glide, FontFaces, `#qd-v4-palettes`, CSP violations) and measures the §13.6 runtime rows (cold start, memory and
  CPU during playback). It fails on a §8.18 miss and lists every miss with its cause (the layout-shift sources, the
  long tasks per action). Memory and CPU count the app and every WebView2 process it started, as Task Manager groups
  them. The CPU windows run with the QA hook's frame sampler off (`__QD_TEST__.sampleFrames(false)`; it requests a
  frame on every vsync, which the app itself does not do while reciting), and the glide's frame pacing is sampled in its
  own window before each. Each row's notes give the app's own share, the share of each process, and what drives the
  frames during playback. The runtime rows go to `artifacts/shots/app/metrics-report.json` (format
  `qd-metrics-report/2`), which `size-budget.mjs` enforces. Idle CPU needs the app without test mode and remote
  debugging: `node scripts/qa/idle-cpu.mjs` measures that and adds its row to the same report. Run both on a quiet machine
  with the window visible: other builds or a covered window distort frame times and CPU. They measure the debug build
  (test mode exists only there, D24), an upper bound for release. The rows still open are in IMPLEMENTATION_NOTES §16.
- **Version**: `node scripts/check-version.mjs v<version>` checks that the tag matches `package.json`,
  `tauri.conf.json` and the Cargo workspace (release.yml runs it).

## 11. Common failures

| Symptom | Cause and fix |
|---|---|
| Quran text in a fallback font; console warns "Failed to decode downloaded font … KFGQPC-Hafs-V30.ttf" (Vite answers the missing file with `index.html`) and "qd-hafs did not load"; `vite build` notes that `/fonts/KFGQPC-Hafs-V30.ttf` didn't resolve | `public/fonts/` is filled by `pnpm assets` (a download, or the committed pinned copy when fonts.qurancomplex.gov.sa is unreachable; LEAD 24): run it. |
| A Rust build of `src-tauri` fails because the `frontendDist` path `../dist` does not exist | Only a `custom-protocol` build reads `dist/`, and `pnpm tauri build` runs `pnpm build` first. If you invoke cargo with `--features custom-protocol` yourself, run `pnpm build` once. |
| App shows "Core data missing (dev build)"; `core.db` is 0 bytes | The build.rs placeholder. Run `pnpm core:qdc` (or download the CI artifact while private). |
| `cargo: command not found` in pnpm scripts (Git Bash) | `%USERPROFILE%\.cargo\bin` is not on PATH (§1). |
| `error: unexpected argument '…' found` from `cargo test` | cargo takes one test-name filter; put several after `--` (§3). |
| Linker errors, `SQLITE_CANTOPEN`, "path too long" on Windows | MAX_PATH: use a short clone path and `CARGO_TARGET_DIR=C:\qdt\…` (§1). |
| `app-driver: CDP endpoint … did not come up` | The exe is wrong (`--exe`, `CARGO_TARGET_DIR`), or the launch forwarded to a running Quran with the same identifier (single instance, §7): close it or let the driver's lock wait for it. With `--port`, another WebView2 may hold that port. |
| The driver reports `chrome-error://` pages | A plain `cargo build` replaced the tauri-built exe with one that loads devUrl: run `pnpm tauri build --debug --no-bundle`. |
| `Port 1420 is already in use` | Another `pnpm dev`/`dev:web` is running (`strictPort`). Stop it; `shots:web` uses its own `--serve` port. |
| `browserType.launch: Executable doesn't exist … ms-playwright` | A Playwright-managed browser was requested (webkit, or chromium off Windows). Install it (`pnpm exec playwright install webkit`) or keep `QD_BROWSERS=chromium` with an installed channel. |
| `No test files found` | The filter matched nothing: there are no tests at that path. |
| `pnpm bindings:check` fails | `bindings.ts` differs from what the Rust DTOs generate: run `pnpm bindings` and commit it with the DTO change (and a `contract-changes.md` entry). |
| `pnpm format:check` flags files you didn't touch | CRLF from an editor or `core.autocrlf`: `pnpm format`, then `git add --renormalize .`. |
| `pnpm i --frozen-lockfile` fails | `package.json` and `pnpm-lock.yaml` disagree; dependencies change only through the lead (§6). |
| `pnpm check:dist` fails after `pnpm tauri build --debug` | That `dist/` is a debug build (source maps, unminified): run `pnpm build` before the check. |
| `/__packs/*` returns 404 in the mock | `data/dev-packs/` is empty: run `pnpm dev-packs`. Vite prints a `[qd]` warning when the plugin fails to load. |
| `cargo xtask licenses` fails after a dependency bump | A shipped package's files lack a licence text, or a reviewed stand-in lists other versions: follow `xtask/licenses/README.md`. |
| The bundle step stops with "QF-derived (meta.source = 'qdc')" | The guard refuses a qdc core.db in an installer. Release: build with `pnpm core:qul`. Private preview: `QD_ALLOW_DEV_CORE=1` (§9). |
| The app refuses to start: the library "was saved by a newer version" | A newer build wrote user.db or content.db. Nothing was changed; run a build at least that new, or point `QD_DATA_DIR` elsewhere. |
